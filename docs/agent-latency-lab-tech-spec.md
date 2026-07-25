# Agent Latency Lab — Technical Specification

**Version:** 1.1 (adds debug-route auth, automated unit + integration test suites)
**Author:** John Baker
**Status:** Active development / portfolio reference implementation

---

## 1. Purpose

Agent Latency Lab is a two-part system for analyzing and improving the latency, cost, and retrieval quality of LLM agent workflows:

1. **Instrumentation libraries** (`latency-trace.ts` for Node/Express, `latency_trace.py` for Python) that wrap agent stages in timed spans, propagate trace context across distributed multi-agent calls, compute per-request cost and RAG quality, export to OpenTelemetry, and watch rolling SLOs with diagnosis-enriched alerts.
2. **An analysis UI** (React/Vite) that visualizes any trace — simulated or pasted from a real instrumented run — as a swim-lane waterfall with fork/join critical-path detection, Monte Carlo percentile distributions, SLO budget scoring, cost/RAG panels, and a live alert feed.

The system is deliberately scoped as a **pre-production analysis tool plus a lightweight instrumentation layer**, not a replacement for a production observability stack. Where real infrastructure (Prometheus, Alertmanager, Jaeger, Grafana) is the correct answer, the tool exports to standards (OTLP) those systems consume rather than reimplementing them.

---

## 2. System Overview

```
Instrumented Agent (Node or Python)
        │  span() / startSpan() / event()
        ▼
Tracer  →  in-memory span list, per-run
        │  toRecord() / toJSON() / toLabText()
        ▼
Express Middleware (Node only)
        │  records to ring-buffer registry, keyed by traceId
        ├── SLO Watcher        → console / webhook / onAlert callback
        ├── Trace Merger       → fork/join-aware multi-agent stitching
        ├── Accounting Engine  → tokens, cost, RAG metrics
        └── OTLP Exporter      → POST to any OTLP/HTTP collector
        ▼
HTTP endpoints (/debug/*)
        │  polled or fetched
        ▼
Agent Latency Lab UI
        │  parses pasted traces or runs simulated workload
        ▼
Waterfall · Histogram · Budget table · Cost/RAG panel · Alert feed
```

See `agent-latency-lab-architecture.mermaid` for the full component diagram.

---

## 3. Components

### 3.1 Tracer (`server/latency-trace.ts`, `python/latency_trace.py`)

**Responsibility:** time discrete stages of a single agent run and export them in a common format.

| Concept | Node | Python |
|---|---|---|
| Create a tracer | `new Tracer(label, ctx)` | `Tracer(label)` |
| Timed stage | `await t.span(name, cat, fn, attrs?)` | `with t.span(name, cat, attrs=...):` |
| Manual span | `t.startSpan(name, cat)` → close fn | not provided (context manager covers it) |
| Point marker | `t.event("first_token")` | `t.event("first_token")` |
| Export (paste format) | `t.toLabText()` | `t.to_lab_text()` |
| Export (JSON) | `t.toJSON()` | `t.to_json()` |
| Thread/async safety | single JS event loop; `Promise.all` overlaps captured via wall-clock start/dur | `threading.Lock` around span list; safe under `ThreadPoolExecutor` |

**Span shape** (common to both, see §4):
```ts
{ name, cat: "llm"|"retr"|"tool"|"orch", start, dur, ok, attrs? }
```

Overlap detection (parallel-call inference) is purely arithmetic: on export, spans are sorted by `start`; any span starting before the running `max(start+dur)` of prior spans is prefixed `|` in the Lab-paste format. No explicit "parallel" flag is required from the caller — `Promise.all` / `ThreadPoolExecutor` usage falls out naturally from real timestamps.

### 3.2 Distributed Context Propagation

Implements the W3C `traceparent` header format (`00-{trace-id}-{parent-span-id}-{flags}`) for stitching multi-agent requests that cross process/service boundaries.

- **Outbound:** `tracer.headersFor(childAgentName?)` returns `{ traceparent, x-trace-agent }` to attach to an outbound `fetch`/HTTP call.
- **Inbound:** `latencyTrace()` middleware parses an incoming `traceparent` header; if present, the new `Tracer` adopts the same `traceId` and records `parentSpanId`, making it a *child* trace.
- **Same-process agents** (routes in one server) stitch automatically via the shared in-memory registry, keyed by `traceId`.
- **Cross-process agents** additionally need `reportTo` set to the orchestrator's `/debug/trace-report` endpoint; the child POSTs its finished trace there on completion (fire-and-forget).

**Known limitation:** lane alignment uses each process's `Date.now()` at request start. Same-host agents align to sub-millisecond precision; cross-host alignment inherits whatever NTP clock skew exists between machines. This is stated explicitly rather than hidden — production-grade clock sync (or logical/vector clocks) would be required to remove the assumption entirely.

### 3.3 Trace Merger

`mergedLabText(traceId)` reconstructs one multi-agent timeline from N independent `TraceRecord`s sharing a `traceId`:

1. Identify the root trace (no parent) vs. child traces (sub-agents).
2. If exactly one root exists: split the root's spans at the fork point (the earliest child's start time) into a "before" segment (planning) and an "after" segment (join/writer), so the reconstructed timeline is *plan → parallel children → join → write*, not a flat overlap of everything.
3. Group children into overlapping-window "runs"; every lane in a run is marked `(parallel)`.
4. Fallback (no single root): order all lanes by wall-clock start and mark overlapping windows parallel.

This logic was specifically built to avoid the naive-merge bug where post-join writer spans would appear to run parallel to sub-agents, understating true end-to-end latency. Verified in testing: real end-to-end 6.9s vs. Lab-reconstructed 7.0s (within jitter tolerance) for a 4-agent NexusAgent-style request.

### 3.4 Accounting Engine

Computes three categories of metric directly from span `attrs`, with no separate ingestion pipeline:

- **Token accounting:** sums `input_tokens` / `output_tokens` per span, grouped by `model`.
- **Cost:** `cost_usd` if explicitly supplied, else `(input_tokens × price_in + output_tokens × price_out) / 1_000_000` using a built-in pricing table (`PRICING`) with fuzzy substring matching on model name. Seeded with Anthropic (Opus/Sonnet/Haiku 4) and Groq (Qwen, Llama 3.x) rates.
- **RAG quality:** given `retrieved_ids`, `relevant_ids`, and cutoff `k` on a retrieval span, computes **precision@k**, **recall@k**, and **MRR** (reciprocal rank of the first relevant hit) — all deterministic, no LLM-as-judge call in the inline path.

Rollups are exposed per-trace (`accounting(spans)` / `t.accounting()`) and across the rolling window (`latencyStats()` → `cost_per_request_p50/p95`, `total_tokens`, `rag`).

**Explicit scope decision:** RAG evaluation stops at retrieval metrics. Faithfulness / answer-relevance (LLM-as-judge) is not computed inline, because it would add latency, cost, and non-determinism to the telemetry path itself. That class of eval belongs in offline evaluation on sampled traffic — noted in the README, not silently omitted.

### 3.5 SLO Watcher

Evaluates a rolling window of recent root traces (default: last 50, minimum 20 before evaluating) against configurable thresholds after every finished request:

| Rule | Default target |
|---|---|
| `e2e_p50` / `e2e_p95` / `e2e_p99` | 3s / 7s / 15s |
| `ttft_p50` | 1s |
| `span_retr_p95` | 200ms |
| `span_tool_p95` | 500ms |

On breach, `diagnose()` isolates the breaching requests, computes the dominant span category by cumulative duration, names the single worst-offending span, and attaches a category-specific fix recommendation (`FIXES` table). The alert includes the worst trace in Lab-paste format (merged across agents if applicable).

**Delivery:** console log (default), `onAlert` programmatic callback, and/or `webhookUrl` (fire-and-forget POST — any hook failure never affects the request path). Per-rule cooldown (default 60s) prevents alert storms from a sustained bad period.

**Explicit scope decision:** this watcher is per-process, in-memory, fixed-threshold. It does not aggregate across instances, does not do anomaly/baseline detection, and does not compute SLO error-budget burn rate. In a multi-instance production deployment, this responsibility belongs to Prometheus recording rules + Alertmanager; the watcher is positioned as the lightweight single-service layer that hands off cleanly to that stack, not a replacement for it.

### 3.6 OTLP Exporter

Converts internal spans to an OTLP `ExportTraceServiceRequest` JSON payload:

- Each span becomes an OTLP span with `kind: SPAN_KIND_INTERNAL`, nanosecond start/end timestamps (derived from `epochStart + span.start`), and attributes: `agent.category`, plus (when present) `llm.model`, `llm.tokens.input/output`, `llm.cost.usd`, `rag.precision_at_k`, `rag.recall_at_k`, `rag.mrr`.
- `toOtlp(traceId)` builds the payload for inspection; `exportOtlp(traceId, endpoint)` POSTs it to any OTLP/HTTP collector (`.../v1/traces`) — verified against Jaeger-compatible and a mock collector in testing.
- `GET /debug/otlp?id=` serves the same payload for manual `curl`-and-forward workflows.

This is the intentional design answer to "does this support Jaeger / Grafana / OpenTelemetry": rather than reimplementing a trace visualizer or a metrics dashboard, the tool emits the open standard those systems already ingest.

### 3.7 Debug-Route Authentication

`/debug/*` exposes request bodies, span names, and (with accounting attrs) token/cost data — an acceptable default in local dev, not once a service is reachable from outside the developer's machine. `debugAuth(opts)` is a deliberately minimal gate, not a full auth framework, mounted ahead of the debug routes:

```ts
app.use("/debug", debugAuth({ token: process.env.DEBUG_TOKEN }));
// or: debugAuth({ allowIps: ["10.0.0.5"] })
```

- **Bearer token** — `Authorization: Bearer <token>`, compared with a constant-time-ish loop (`timingSafeEqual`) to avoid trivial timing side-channels on the token itself.
- **IP allowlist** — exact match against `x-forwarded-for` (first hop) or the connecting socket's remote address.
- **Default-open with a loud warning:** if neither `token` nor `allowIps` is configured, every request is allowed through, but a one-time `console.warn` fires naming exactly what to set and why. This is "insecure by default, but impossible to miss" rather than silently open — a deliberate choice given the tool's primary use is local development, where forcing auth configuration before `npm run dev` works would be poor ergonomics for the common case, while shipping silently open would be a real liability for the uncommon (but real) case of a forgotten deployment.

The design explicitly does not attempt session management, OAuth, or role-based access — the correct answer for a real deployment is to put these routes behind whatever the service already uses (API gateway, internal network boundary, mTLS), and `debugAuth` exists to prevent the "forgot to lock it down" default from being open, not to be a complete access-control system.

### 3.8 Express Middleware & Endpoints

`latencyTrace(opts)` is the primary integration point; `debugAuth(opts)` is mounted separately, ahead of the debug routes:

```ts
app.use(latencyTrace({
  agent: "orchestrator",
  ignore: (path) => path.startsWith("/health"),
  slo: true,                                  // or custom SloThresholds
  alerts: { webhookUrl, onAlert, windowSize, minRequests, cooldownMs },
  reportTo: "https://orchestrator/debug/trace-report",  // sub-agents only
}));
app.use("/debug", debugAuth({ token: process.env.DEBUG_TOKEN }));
```

| Route | Handler | Purpose |
|---|---|---|
| `GET /debug/latency` | `latencyStatsHandler` | Rolling P50/P95/P99, TTFT, cost, tokens, RAG, last trace |
| `GET /debug/latency/trace?id=` | `mergedTraceHandler` | Merged Lab-paste text for one traceId |
| `GET /debug/alerts` | `alertsHandler` | Recent SLO alerts, newest first |
| `GET /debug/otlp?id=` | `otlpHandler` | OTLP JSON for one trace (or the last) |
| `POST /debug/trace-report` | `traceReportHandler` | Ingest endpoint for out-of-process sub-agents |

All five routes above sit behind `debugAuth` in the reference integration (`server/demo-server.ts`); only `GET /health` is deliberately left ungated.

### 3.9 Agent Latency Lab UI (`src/AgentLatencyLab.jsx`)

React + Vite single-page app, no backend dependency for its simulated mode (backend optional for live paste/alerts).

**Modes:**
- *Simulated workload* — a built-in Monte Carlo model of a single-agent RAG workflow (planner → retrieval → parallel tool calls → final LLM), 240 seeded runs per configuration, used to demonstrate optimization levers without a live instrumented app.
- *Paste your trace* — accepts the tracers' line format (`name, cat, dur` with `|`/`@agent` markers) or JSON, including multi-agent `@agent (parallel)` swim-lanes. Synthesizes a 240-run distribution around the single pasted trace (±jitter, 6% long-tail multiplier on external calls) to make percentile analysis possible from one sample.

**Fork/join layout engine (`customOnce`):** lanes marked `(parallel)`, or forced parallel via the "Parallelize sub-agents" toggle, fork after the prior sequential lane and join before the next; critical-path detection flags the slowest lane in each fork group — the one actually worth optimizing.

**What-if toggles** map to real techniques and target specific spans: parallelize tool calls (asyncio.gather semantics), parallelize sub-agents (fork/join), model routing (shrinks the first agent's first LLM span), context trimming (shrinks the last agent's final LLM span), cache hit rate (probabilistically collapses retrieval/tool spans), co-location (flat ms reduction per external call), streaming (TTFT ≈ first span instead of total).

**Visualizations:** swim-lane waterfall (SVG, category-colored, critical-path highlighted), latency histogram (24-bucket, SLO line overlay), agent-breakdown table (multi-agent) or latency-budget table (single-agent), cost-by-model + RAG precision/recall/MRR panel, and a live alert feed (polls `/debug/alerts` every 5s, "load worst trace" one-click handoff into the analyzer).

---

## 4. Data Model

### 4.1 Span

```ts
interface Span {
  name: string;
  cat: "llm" | "retr" | "tool" | "orch";
  start: number;    // ms offset from request start
  dur: number;      // ms
  ok: boolean;
  attrs?: {
    model?: string;
    input_tokens?: number;
    output_tokens?: number;
    cost_usd?: number;             // overrides computed cost if present
    retrieved_ids?: string[];
    relevant_ids?: string[];
    k?: number;                    // default 5
  };
}
```

### 4.2 TraceRecord

```ts
interface TraceRecord {
  traceId: string;
  agentName: string;
  epochStart: number;   // Date.now() at request start
  totalMs: number;
  ttftMs: number | null;
  child: boolean;       // true if this trace had an upstream parent
  spans: Span[];
}
```

### 4.3 SLO Alert

```ts
interface SloAlert {
  rule: string;
  threshold_ms: number;
  observed_ms: number;
  window_size: number;
  dominant_category: SpanCategory;
  dominant_share_pct: number;
  top_span: string;
  recommendation: string;
  trace_id: string;
  worst_trace_lab_format: string | null;
  at: string;  // ISO timestamp
}
```

### 4.4 Trace paste format (line grammar)

```
[@agent[ (parallel)]]
[|] name[, cat][, duration[ms|s]]
```
- `@agent` starts a swim-lane; omit entirely for single-agent traces.
- `|` prefix marks a span (or, at the middleware/merge level, a whole lane) as overlapping the previous one.
- `cat` ∈ {llm, retr, tool, orch}; inferred from `name` via regex heuristics if omitted.
- `#` / `//` lines are comments.

JSON is also accepted: either a flat array of `{name, cat, dur, attrs?, parallel?, agent?}` objects, or `{agents: [{name, parallel, spans: [...]}]}`.

---

## 5. Technology Stack

| Layer | Choice | Rationale |
|---|---|---|
| UI framework | React 18 + Vite 5 | Fast dev server, small production bundle (~58KB gzipped) |
| UI language | JSX (plain, no TS) | Kept dependency-light; server enforces strict TS where correctness matters more |
| Server language | TypeScript (strict) | Type safety for the tracer/middleware surface that other code integrates against |
| Server framework | Express | Ubiquitous, matches the target integration (Benefits Triage Agent, NexusAgent) |
| Python tracer | Stdlib only (`threading`, `time`, `json`, `contextlib`) | Zero install friction; works in any Python 3.8+ environment |
| Diagrams | Hand-built SVG (waterfall, histogram) | Full control over critical-path highlighting and category coloring; no charting library dependency |
| Export standard | OpenTelemetry Protocol (OTLP/HTTP JSON) | Universally consumed by Jaeger, Tempo, and the OTel Collector — avoids reimplementing any backend |

**Explicit non-dependencies:** no OpenTelemetry SDK (the tool speaks OTLP's wire format directly rather than pulling in the full SDK), no LangSmith SDK (would only add value if the person actually uses LangSmith), no charting library (Recharts/Chart.js) for the two custom visualizations (hand-rolled SVG gives exact control over swim-lane/critical-path rendering).

---

## 6. Testing & Verification

The system has both an automated test suite (run on demand, not yet wired to CI) and a history of live manual verification performed while each feature was built. Both are described here rather than only the former, because the manual verification caught real defects the unit suite came later and now also covers.

### 6.1 Automated test suites

| Suite | Tool | Count | What it exercises |
|---|---|---|---|
| `tests/latency-trace.test.ts` | Vitest | 41 | Pure logic: tracer timing/overlap detection, `traceparent` parsing, cost math, RAG precision/recall/MRR, fork/join trace-merge reconstruction, OTLP payload shape, `debugAuth` called directly |
| `tests/integration.test.ts` | Vitest + supertest | 12 | Real Express wiring: `/api/triage` and `/api/orchestrate` over real HTTP against the actual demo app, the SLO watcher firing over six genuinely-timed requests, `debugAuth` mounted with `app.use()`, cross-process `traceparent` propagation with a real `reportTo` POST between two separate Express apps on separate ports |
| `python/tests/test_latency_trace.py` | unittest | 28 | Python tracer parity: timing, thread-safety under `ThreadPoolExecutor`, cost/RAG math, category inference, OTLP/JSON export shape |

```bash
npm run test               # all Node tests (unit + integration)
npm run test:unit          # fast — pure logic, ~0.1s
npm run test:integration   # slower — real HTTP + real timing, ~60s
python3 -m unittest discover python/tests -v
```

**Test-only exports.** `__resetForTests()` and `__recordForTests()` clear/seed the module-level in-memory registry directly, letting unit tests exercise `mergedLabText`, `latencyStats`, and `toOtlp` without a live HTTP request cycle. Both are explicitly named and documented as test-only, not part of the public integration surface.

**A real bug the integration suite caught during development:** `/api/orchestrate` performs a genuine self-`fetch()` to call its own sub-agent routes (a faithful stand-in for calling a separate service). The first integration-test run failed with `ECONNREFUSED`, because `supertest(app)` alone never binds the app to a real port — the orchestrator's self-fetch had nothing to connect to. Fixed by exporting the app's configured `PORT` and explicitly binding a real listener in the test suite's `beforeAll`. This is exactly the class of defect integration tests exist to catch and unit tests structurally cannot, since it's a property of the real request/response cycle, not the logic underneath it.

**A known, stated limitation of the cross-process propagation test:** within a single Vitest process, the "caller" and "remote" Express apps both import the same `latency-trace.ts` module instance and therefore share one in-memory registry — regardless of whether `reportTo` actually works. The test's own code comment states this plainly: it fully verifies the wire contract (`headersFor()` producing a valid `traceparent`, the remote parsing and adopting it, a real POST landing on `/debug/trace-report`, `traceReportHandler` ingesting it correctly, and the merge reflecting both agents), but it cannot prove OS-level process isolation the way two real `npm run server` instances on two real ports would. That distinction is called out rather than glossed over.

### 6.2 Manual live verification (performed while building)

- **Parser correctness:** line-format and JSON parsing verified against hand-constructed traces, including multi-agent `@agent` lanes, explicit `(parallel)` markers, and forced-parallel toggles; error paths (malformed lines, missing durations) confirmed to report line numbers.
- **Fork/join layout:** critical-path flagging verified against constructed fork groups (sequential vs. explicitly parallel vs. toggle-forced parallel), confirming the correct lane is flagged critical in each case.
- **Distributed tracing round-trip:** live orchestrator + two sub-agent HTTP calls (real `fetch`, real `traceparent` propagation) run end-to-end; merged trace output re-parsed through the Lab's layout engine and cross-checked against the real measured end-to-end latency (6.9s real vs. 7.0s reconstructed).
- **SLO watcher:** live-fired six requests against artificially tight thresholds; confirmed console alert, `onAlert` callback, and webhook delivery all received the identical diagnosis payload; confirmed cooldown suppressed duplicate firing.
- **Accounting engine:** cost math cross-verified by hand (e.g., 1200 input + 180 output tokens on Haiku pricing → $0.00168) and confirmed identical results from the Node tracer, Python tracer, and the Lab's independent JS reimplementation of the same formulas.
- **OTLP export:** live POST to a mock OTLP/HTTP collector; confirmed span count, `service.name` resource attribute, and presence of `llm.cost.usd` / `rag.*` attributes on the received payload.
- **Debug-route auth:** live-tested all four access states (no token, wrong token, correct token, ungated `/health`) over real HTTP with `curl`.
- **Build integrity:** `tsc --noEmit` (strict) on all server TypeScript; `esbuild` bundle check on the UI JSX as a JSX-correctness gate (this caught a real structural bug — a ternary branch accidentally orphaned during a panel insertion — that a plain visual review had missed).

---

## 7. Deployment Model

- **Development:** `npm run dev` (Vite, port 5173) + `npm run server` (Express demo agent, port 3001), wired via Vite's dev-server proxy for `/api` and `/debug`.
- **Library integration:** copy `server/latency-trace.ts` or `python/latency_trace.py` into a target project; both are single-file, dependency-free (beyond the host language runtime and, for Node, `express`/`node:crypto`/`node:perf_hooks` which are built-ins).
- **Production posture:** the SLO watcher and in-memory registry are single-process by design. Multi-instance deployments should treat this tool's OTLP export as the integration point into real infrastructure (Prometheus + Alertmanager for alerting/aggregation, Jaeger/Tempo for trace storage and search) rather than scaling the in-memory registry itself.

---

## 8. Known Limitations (by design, stated explicitly)

| Limitation | Reasoning |
|---|---|
| Clock alignment across hosts inherits NTP skew | No vector/logical clock implemented; acceptable for same-host or NTP-synced demo/dev use |
| SLO watcher is per-process, fixed-threshold | Multi-instance aggregation and anomaly detection are Prometheus/Alertmanager's job, not this tool's |
| RAG evaluation is retrieval-only (no faithfulness/LLM-as-judge) | Keeping the inline telemetry path deterministic, fast, and free of extra LLM calls |
| No LangSmith integration | Would be a portfolio gesture without genuine LangSmith usage; OTLP export already reaches real backends |
| No nested/child spans within an agent lane (flat list per lane) | Sufficient for the fork/join patterns this tool targets; deeper agent internals would need a tree, not a list |
| `debugAuth` is a minimal gate (bearer token / IP allowlist), not a full auth framework | Real deployments should sit these routes behind an existing API gateway, internal network, or mTLS; this only prevents the "forgot to lock it down" default from being open |
| Automated tests are not wired into CI | They run on demand (`npm run test`, `python3 -m unittest`); no GitHub Actions / pre-commit hook enforces them yet |
| Integration test suite cannot prove OS-level process isolation | The cross-process propagation test runs two Express apps in one Vitest process, sharing one module instance; it verifies the wire contract fully but not true multi-process memory isolation — stated explicitly in the test's own comment |

---

## 9. File Map

```
agent-latency-lab/
├── src/
│   ├── AgentLatencyLab.jsx     UI: parser, simulation engines, waterfall/histogram/
│   │                           cost-RAG panel/alert feed, all what-if logic
│   └── main.tsx                React entry point
├── server/
│   ├── latency-trace.ts        Tracer, traceparent propagation, SLO watcher,
│   │                           accounting engine, OTLP exporter, debugAuth,
│   │                           Express middleware, test-only registry hooks
│   └── demo-server.ts          Reference integration: NexusAgent-style orchestrator
│                                + 2 sub-agents + single-agent triage endpoint,
│                                debugAuth wired to DEBUG_TOKEN, exports `app`/`PORT`
├── python/
│   ├── latency_trace.py        Python tracer: same span/export format, cost/RAG,
│   │                           OTLP export, thread-safe
│   └── tests/
│       └── test_latency_trace.py   28 unittest cases — tracer parity
├── tests/
│   ├── latency-trace.test.ts   41 Vitest unit tests — pure logic
│   └── integration.test.ts     12 Vitest + supertest tests — real HTTP/Express wiring
├── vitest.config.ts             Test timeouts (unit fast, integration sets its own)
├── requests.http                Sample requests (REST Client extension)
├── .vscode/                     Tasks (dev, build, typecheck, test×3), debug configs,
│                                recommended extensions
└── agent-latency-lab.code-workspace
```
