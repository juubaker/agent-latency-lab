"""
latency_trace.py — span instrumentation for Python agents & scripts
-------------------------------------------------------------------
Python counterpart to the Node middleware. Times each stage of a workflow
and emits traces in the Agent Latency Lab's paste format ("name, cat, dur"
lines with `|` for parallel spans) or Lab-compatible JSON.

    from latency_trace import Tracer

    t = Tracer()
    with t.span("fetch_url", "tool"):
        response = requests.get(url)
    with t.span("parse_html", "orch"):
        text = BeautifulSoup(response.text, "html.parser").get_text()
    with t.span("llm_summary", "llm"):
        summary = call_llm(text)

    print(t.to_lab_text())      # paste straight into the Lab
    print(t.to_json())          # or the Lab's JSON form

Parallel work is detected automatically — spans opened from worker threads
(ThreadPoolExecutor, asyncio.to_thread) record real start offsets, and
overlapping spans get the `|` prefix on export:

    with ThreadPoolExecutor() as pool:
        a = pool.submit(lambda: run_with(t, "pgvector policy_chunks", "retr", search_policies))
        b = pool.submit(lambda: run_with(t, "pgvector resolved_tickets", "retr", search_tickets))

Categories: llm | retr | tool | orch. Omit `cat` and it's inferred from the
span name (same heuristics as the Lab). Use `t.event("first_token")` inside a
streaming LLM call to capture TTFT.

Zero dependencies. Thread-safe. Python 3.8+.
"""

from __future__ import annotations

import json
import re
import threading
import time
from contextlib import contextmanager
from typing import Any, Callable, Dict, List, Optional

CATEGORIES = ("llm", "retr", "tool", "orch")

# USD per 1M tokens: (input, output). Update as prices change.
PRICING = {
    "claude-opus-4": (15, 75),
    "claude-sonnet-4": (3, 15),
    "claude-haiku-4": (0.8, 4),
    "claude-3-5-haiku": (0.8, 4),
    "qwen": (0.2, 0.2),
    "qwen-2.5-32b": (0.2, 0.2),
    "llama-3.3-70b": (0.59, 0.79),
    "llama-3.1-8b": (0.05, 0.08),
}


def price_for(model):
    if not model:
        return None
    m = model.lower()
    if m in PRICING:
        return PRICING[m]
    for key, price in PRICING.items():
        if key in m:
            return price
    return None


def compute_cost(attrs):
    if not attrs:
        return 0.0
    if isinstance(attrs.get("cost_usd"), (int, float)):
        return float(attrs["cost_usd"])
    price = price_for(attrs.get("model"))
    if not price:
        return 0.0
    in_tok = attrs.get("input_tokens", 0) or 0
    out_tok = attrs.get("output_tokens", 0) or 0
    return (in_tok * price[0] + out_tok * price[1]) / 1_000_000


def rag_metrics(attrs):
    """Deterministic precision@k / recall@k / MRR from retrieved + relevant ids."""
    if not attrs or "retrieved_ids" not in attrs or "relevant_ids" not in attrs:
        return None
    k = attrs.get("k", 5)
    retrieved = list(attrs["retrieved_ids"])
    relevant = set(attrs["relevant_ids"])
    top_k = retrieved[:k]
    hits = sum(1 for i in top_k if i in relevant)
    precision = hits / len(top_k) if top_k else 0.0
    recall = hits / len(relevant) if relevant else 0.0
    mrr = 0.0
    for idx, doc_id in enumerate(retrieved):
        if doc_id in relevant:
            mrr = 1.0 / (idx + 1)
            break
    return {"k": k, "precision_at_k": precision, "recall_at_k": recall, "mrr": mrr}


def accounting(spans):
    """Aggregate token/cost/RAG rollups across spans."""
    in_tok = out_tok = 0
    cost = 0.0
    by_model = {}
    rag = []
    for s in spans:
        a = s.get("attrs")
        if not a:
            continue
        if a.get("input_tokens") or a.get("output_tokens") or a.get("model"):
            it = a.get("input_tokens", 0) or 0
            ot = a.get("output_tokens", 0) or 0
            c = compute_cost(a)
            in_tok += it
            out_tok += ot
            cost += c
            key = a.get("model", "unknown")
            m = by_model.setdefault(key, {"in": 0, "out": 0, "cost": 0.0, "calls": 0})
            m["in"] += it
            m["out"] += ot
            m["cost"] += c
            m["calls"] += 1
        rm = rag_metrics(a)
        if rm:
            rag.append(rm)
    result = {
        "input_tokens": in_tok,
        "output_tokens": out_tok,
        "total_tokens": in_tok + out_tok,
        "cost_usd": round(cost, 6),
        "by_model": by_model,
        "rag": None,
    }
    if rag:
        n = len(rag)
        result["rag"] = {
            "k": rag[0]["k"],
            "precision_at_k": sum(r["precision_at_k"] for r in rag) / n,
            "recall_at_k": sum(r["recall_at_k"] for r in rag) / n,
            "mrr": sum(r["mrr"] for r in rag) / n,
            "samples": n,
        }
    return result

_LLM_RE = re.compile(r"llm|plan|model|claude|gpt|haiku|sonnet|opus|groq|qwen|llama|reason|reflect|summar|classif|generat|synthes|assess", re.I)
_RETR_RE = re.compile(r"vector|embed|pgvector|retriev|rag|rerank|chunk|semantic", re.I)
_TOOL_RE = re.compile(r"api|tool|db|sql|postgres|query|http|fetch|calc|lookup|drizzle|redis|search|registry|audit|policy", re.I)


def infer_cat(name: str) -> str:
    if _LLM_RE.search(name):
        return "llm"
    if _RETR_RE.search(name):
        return "retr"
    if _TOOL_RE.search(name):
        return "tool"
    return "orch"


class Tracer:
    """Per-request/per-run tracer. Create one per unit of work — don't share
    a module-level instance across requests (that's the bug ad-hoc tracers
    with a global `trace = []` list tend to have)."""

    def __init__(self, label: str = "run"):
        self.label = label
        self._t0 = time.perf_counter()
        self._epoch_ms = time.time() * 1000.0
        self._lock = threading.Lock()
        self.spans: List[Dict[str, Any]] = []
        self.events: List[Dict[str, Any]] = []

    # ------------------------------------------------------------------ spans

    @contextmanager
    def span(self, name: str, cat: Optional[str] = None, attrs: Optional[Dict[str, Any]] = None, **metadata: Any):
        """Time a stage:  with t.span("benefits api", "tool"): ...

        Pass `attrs` for token/cost/RAG accounting, e.g.
            with t.span("final llm", "llm",
                        attrs={"model": "claude-sonnet-4",
                               "input_tokens": 4200, "output_tokens": 380}):
        or for retrieval quality:
            with t.span("pgvector search", "retr",
                        attrs={"retrieved_ids": [...], "relevant_ids": [...], "k": 5}):
        """
        category = cat if cat in CATEGORIES else infer_cat(name)
        start = (time.perf_counter() - self._t0) * 1000.0
        ok = True
        try:
            yield self
        except Exception:
            ok = False
            raise
        finally:
            dur = (time.perf_counter() - self._t0) * 1000.0 - start
            entry = {"name": name, "cat": category, "start": start, "dur": dur, "ok": ok}
            if attrs:
                entry["attrs"] = attrs
            if metadata:
                entry["metadata"] = metadata
            with self._lock:
                self.spans.append(entry)

    def run(self, name: str, fn: Callable[[], Any], cat: Optional[str] = None) -> Any:
        """Functional form — handy inside executor.submit lambdas."""
        with self.span(name, cat):
            return fn()

    def event(self, name: str) -> None:
        """Point-in-time marker; event('first_token') captures TTFT."""
        with self._lock:
            self.events.append({"name": name, "at": (time.perf_counter() - self._t0) * 1000.0})

    # ------------------------------------------------------------------ stats

    @property
    def total_ms(self) -> float:
        with self._lock:
            return max((s["start"] + s["dur"] for s in self.spans), default=0.0)

    @property
    def ttft_ms(self) -> Optional[float]:
        for e in self.events:
            if e["name"] == "first_token":
                return e["at"]
        return None

    def accounting(self) -> Dict[str, Any]:
        """Token/cost/RAG rollup for this run."""
        with self._lock:
            spans = list(self.spans)
        return accounting(spans)

    def to_otlp(self, service_name: Optional[str] = None) -> Dict[str, Any]:
        """OTLP ExportTraceServiceRequest (JSON) — POST to an OTLP/HTTP
        collector at /v1/traces to land in Jaeger, Tempo, or any OTel backend."""
        import os
        trace_id = os.urandom(16).hex()
        with self._lock:
            spans = list(self.spans)
        otlp_spans = []
        for s in spans:
            start_ns = str(int((self._epoch_ms + s["start"]) * 1e6))
            end_ns = str(int((self._epoch_ms + s["start"] + s["dur"]) * 1e6))
            attributes = [{"key": "agent.category", "value": {"stringValue": s["cat"]}}]
            a = s.get("attrs")
            if a:
                if a.get("model"):
                    attributes.append({"key": "llm.model", "value": {"stringValue": a["model"]}})
                if a.get("input_tokens") is not None:
                    attributes.append({"key": "llm.tokens.input", "value": {"intValue": a["input_tokens"]}})
                if a.get("output_tokens") is not None:
                    attributes.append({"key": "llm.tokens.output", "value": {"intValue": a["output_tokens"]}})
                cost = compute_cost(a)
                if cost:
                    attributes.append({"key": "llm.cost.usd", "value": {"doubleValue": cost}})
                rm = rag_metrics(a)
                if rm:
                    attributes.append({"key": "rag.precision_at_k", "value": {"doubleValue": rm["precision_at_k"]}})
                    attributes.append({"key": "rag.recall_at_k", "value": {"doubleValue": rm["recall_at_k"]}})
                    attributes.append({"key": "rag.mrr", "value": {"doubleValue": rm["mrr"]}})
            otlp_spans.append({
                "traceId": trace_id, "spanId": os.urandom(8).hex(),
                "name": s["name"], "kind": 1,
                "startTimeUnixNano": start_ns, "endTimeUnixNano": end_ns,
                "attributes": attributes,
                "status": {"code": 1 if s["ok"] else 2},
            })
        return {"resourceSpans": [{
            "resource": {"attributes": [{"key": "service.name", "value": {"stringValue": service_name or self.label}}]},
            "scopeSpans": [{"scope": {"name": "agent-latency-lab", "version": "1.0.0"}, "spans": otlp_spans}],
        }]}

    def export_otlp(self, endpoint: str, service_name: Optional[str] = None) -> bool:
        """POST this trace to an OTLP/HTTP collector, e.g.
        'http://localhost:4318/v1/traces'. Needs `requests` (or urllib fallback)."""
        payload = self.to_otlp(service_name)
        data = json.dumps(payload).encode()
        try:
            import urllib.request
            req = urllib.request.Request(endpoint, data=data, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=5) as r:
                return 200 <= r.status < 300
        except Exception:
            return False

    # ----------------------------------------------------------------- export

    def to_lab_text(self) -> str:
        """Paste-ready block for the Lab; overlapping spans get `|`."""
        with self._lock:
            spans = sorted(self.spans, key=lambda s: s["start"])
        lines: List[str] = []
        prev_end = float("-inf")
        for s in spans:
            parallel = s["start"] < prev_end - 1  # 1 ms epsilon
            failed = "" if s["ok"] else " (failed)"
            lines.append(f"{'| ' if parallel else ''}{s['name']}{failed}, {s['cat']}, {round(s['dur'])}")
            prev_end = max(prev_end, s["start"] + s["dur"])
        return "\n".join(lines)

    def to_json(self, indent: Optional[int] = 2) -> str:
        """Lab-compatible flat JSON (also fine for logs/pipelines)."""
        with self._lock:
            spans = sorted(self.spans, key=lambda s: s["start"])
        prev_end = float("-inf")
        out = []
        for s in spans:
            entry = {
                "name": s["name"], "cat": s["cat"],
                "dur": round(s["dur"], 2),
                "parallel": s["start"] < prev_end - 1,
                "ok": s["ok"],
            }
            a = s.get("attrs")
            if a:
                entry["attrs"] = a
                cost = compute_cost(a)
                if cost:
                    entry["cost_usd"] = round(cost, 6)
                rm = rag_metrics(a)
                if rm:
                    entry["rag"] = rm
            out.append(entry)
            prev_end = max(prev_end, s["start"] + s["dur"])
        return json.dumps(out, indent=indent)


def run_with(t: Tracer, name: str, cat: Optional[str], fn: Callable[[], Any]) -> Any:
    """Module-level helper for executor.submit(...) call sites."""
    return t.run(name, fn, cat)


# ---------------------------------------------------------------------------
# Demo — a URL-summarizer workflow, upgraded from the global-list pattern:
# per-run tracer, categories, parallel fetches, TTFT, Lab-format output.
# (Simulated I/O so it runs anywhere; swap sleeps for requests/BeautifulSoup.)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    from concurrent.futures import ThreadPoolExecutor

    def process_url(url: str) -> str:
        t = Tracer(label=f"summarize {url}")

        # parallel fetch of page + robots.txt — overlap detected automatically
        with ThreadPoolExecutor() as pool:
            page = pool.submit(run_with, t, "fetch_url", "tool", lambda: time.sleep(0.31) or "<html>…</html>")
            pool.submit(run_with, t, "fetch robots.txt", "tool", lambda: time.sleep(0.12))
            html = page.result()

        with t.span("parse_html", "orch", characters=1234):
            time.sleep(0.018)
            text = "example domain " * 80

        with t.span("llm_summary", "llm"):
            time.sleep(0.4)          # time to first token…
            t.event("first_token")
            time.sleep(0.9)          # …rest of generation
            summary = text[:500]

        print(f"# {t.label} — {round(t.total_ms)}ms total · TTFT {round(t.ttft_ms or 0)}ms")
        print(t.to_lab_text())
        return summary

    process_url("https://example.com")
