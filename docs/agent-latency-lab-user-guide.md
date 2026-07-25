# Agent Latency Lab — User Guide

A practical guide to analyzing, optimizing, and monitoring the latency, cost, and retrieval quality of LLM agent workflows.

---

## What this tool is for

If you're building an AI agent — single-step or multi-agent — and you want to know:

- *Where is the time actually going?*
- *What would parallelizing tool calls, routing to a smaller model, or caching actually save me?*
- *What is this costing per request?*
- *Is my retrieval any good?*
- *Will I know when it breaks in production, and why?*

...this tool answers those from a trace, either one you paste in or one your instrumented app produces automatically.

It is **not** an eval harness (it doesn't grade whether an answer is *correct*) and it is **not** a production observability platform (it doesn't replace Prometheus/Grafana at scale). It's a focused pre-production lab, plus the instrumentation library that feeds real infrastructure once you're ready for it.

---

## 1. Getting started

```bash
npm install
npm run dev        # UI → http://localhost:5173
npm run server      # demo agents → http://localhost:3001   (optional)
```

Or in VS Code: open `agent-latency-lab.code-workspace`, then **Terminal → Run Task → "Dev: Both (UI + server)"**.

You don't need the server running to use the Lab — the **Simulated workload** mode works standalone. Run the server if you want to try the **live alert feed** or see real instrumented traces.

---

## 2. The two modes

### Simulated workload

A built-in, seeded Monte Carlo model of a single-agent RAG request (planner → retrieval → parallel tool calls → final LLM). Use this to learn what each optimization lever actually does before you've instrumented anything of your own.

Two sliders control the workload shape:
- **Reasoning iterations** — how many think/act loops the agent runs before answering.
- **Cache hit rate** — how often retrieval/tool calls hit a cache instead of paying full latency.

### Paste your trace

Paste real span timings from your own agent (see §5 for how to produce them) or load one of the built-in examples:

- **Triage single-agent** — a linear RAG workflow.
- **NexusAgent multi-agent** — an orchestrator forking into parallel sub-agents.
- **Cost + RAG (JSON)** — a trace enriched with token/cost/retrieval-quality data, to see the cost panel populated.

The Lab synthesizes a 240-request distribution around your single trace (±jitter, a 6% long-tail multiplier on external calls) so percentile analysis is possible from one sample. This is stated in the UI — it's honest synthetic variance around a real trace, not 240 real requests.

---

## 3. Reading the trace format

**Single agent**, one span per line:

```
name, [category,] duration
```

```
triage classifier (haiku), llm, 620
pgvector policy_chunks, retr, 95
| pgvector resolved_tickets, retr, 110
benefits eligibility api, tool, 1450
claude final response, llm, 2400
```

- `category` is one of `llm`, `retr` (retrieval), `tool` (API/DB/tool call), or `orch` (orchestration/routing). If you omit it, the Lab infers it from the span name.
- A leading `|` means "this span runs in parallel with the previous one" (i.e., it started before the previous one finished).
- Durations accept `95`, `95ms`, or `1.4s`.
- `#` or `//` lines are comments.

**Multi-agent**, add `@agent` headers to start a swim-lane:

```
@orchestrator
intent classification, llm, 420
@research (parallel)
enterprise search api, tool, 1350
@compliance (parallel)
policy engine evaluation, tool, 240
@writer
final response, llm, 2200
```

Consecutive `(parallel)` lanes fork together after the previous sequential lane, and the next unmarked lane joins after all of them finish — this is fork/join semantics, not "everything after this point is parallel."

**JSON** also works — either a flat array of span objects, or `{ agents: [{ name, parallel, spans: [...] }] }`. Field names are forgiving: `name`/`span`/`step`/`label`, `dur`/`duration`/`duration_ms`/`ms` are all accepted, so ad-hoc tracer output usually pastes in with zero changes.

---

## 4. Reading the visualizations

**Trace waterfall.** One bar per span, positioned by real start time and width by duration. Multi-agent traces render as swim-lanes with a background band showing each agent's wall-clock window; the slowest lane in each fork group is marked **critical** — that's the one worth optimizing. A non-critical lane can get 2x slower with zero effect on end-to-end time, because the join waits for the critical lane regardless.

**Latency distribution (histogram).** 240 synthetic requests bucketed by total latency, with a dashed line at the P95 SLO target (7s by default). The red mass to the right of that line is exactly what an average would hide — this is the practical argument for tracking P95/P99, not mean latency.

**Metric cards.** P50/P95/P99/TTFT against the standard targets (3s/7s/15s/1s), plus cost-per-request and Recall@k when your trace includes that data (see §6).

**Agent breakdown** (multi-agent) or **latency budget** (single-agent) table. Shows wall-clock time per stage against a target budget, flags anything running over.

**Cost & retrieval quality panel.** Appears automatically when your pasted trace has token/cost or retrieval-id attributes — see §6.

---

## 5. Instrumenting your own agent

### Node / Express

```ts
import { latencyTrace } from "./latency-trace";

app.use(latencyTrace({ agent: "triage" }));

app.post("/api/triage", async (req, res) => {
  const t = req.trace!;

  const category = await t.span("triage classifier", "llm", () =>
    classify(req.body.message)
  );

  const [policy, tickets] = await Promise.all([
    t.span("pgvector policy_chunks", "retr", () => searchPolicies(req.body.message)),
    t.span("pgvector resolved_tickets", "retr", () => searchTickets(req.body.message)),
  ]);

  res.json({ category });
});
```

Every finished request logs a block to your terminal that pastes directly into the Lab. Parallel calls (like the `Promise.all` above) are detected automatically from real timestamps — no manual flagging needed.

For a streaming LLM call, capture time-to-first-token:

```ts
const end = t.startSpan("claude final response", "llm");
stream.on("text", () => { if (!t.events.some(e => e.name === "first_token")) t.event("first_token"); });
await stream.finalMessage();
end();
```

### Python

```python
from latency_trace import Tracer

t = Tracer()
with t.span("fetch_url", "tool"):
    response = requests.get(url)
with t.span("llm_summary", "llm"):
    summary = call_llm(text)

print(t.to_lab_text())   # paste into the Lab
```

Spans opened inside `ThreadPoolExecutor` workers are overlap-detected the same way as Node's `Promise.all` — no special handling required.

### Multi-agent / distributed tracing

An orchestrator calling sub-agents over HTTP propagates context on the outbound call:

```ts
fetch(researchUrl, { headers: { ...t.headersFor("research"), "Content-Type": "application/json" } });
```

The sub-agent's own `latencyTrace()` middleware adopts the incoming trace automatically. Sub-agents in a **separate process** additionally need `reportTo` pointed at the orchestrator's collector:

```ts
app.use(latencyTrace({ agent: "research", reportTo: "https://orchestrator.internal/debug/trace-report" }));
```

When the root request finishes, the orchestrator logs one merged block with `@agent` swim-lanes — paste that straight into the Lab's multi-agent mode.

---

## 6. Tracking cost and retrieval quality

Attach `attrs` to a span to unlock the cost and RAG panels:

```ts
// LLM span — tokens + model name → cost is computed automatically
await t.span("final response", "llm", () => callClaude(prompt),
  { model: "claude-sonnet-4", input_tokens: 5200, output_tokens: 430 });

// retrieval span — what you retrieved + what was actually relevant → quality metrics
await t.span("pgvector policy_chunks", "retr", () => search(query),
  { retrieved_ids: hits.map(h => h.id), relevant_ids: goldSetForThisQuery, k: 5 });
```

Pricing is built in for Anthropic (Opus/Sonnet/Haiku 4) and Groq (Qwen, Llama 3.x) with fuzzy model-name matching; pass `cost_usd` directly if you'd rather compute it yourself.

`relevant_ids` is the one field you have to supply — it's your ground truth for "what should have been retrieved for this query." Without it, precision/recall/MRR can't be computed; with it, they're fully deterministic (no LLM call, no added latency).

---

## 7. Watching for problems (SLO alerts)

Enable the watcher in your middleware:

```ts
app.use(latencyTrace({
  agent: "orchestrator",
  slo: true,   // or customize: { e2e_p95: 5000, ttft_p50: 1000 }
  alerts: { webhookUrl: process.env.SLO_WEBHOOK_URL },
}));
app.get("/debug/alerts", alertsHandler);
```

When a rolling percentile breaches its threshold, you get a console alert (and webhook, if configured) that names the breached rule, diagnoses which span category is dominating the breach, names the single worst-offending span, and attaches a fix recommendation plus the worst trace in paste-ready format.

If you're running the Lab UI against a live server, the **live alert feed** in the sidebar polls `/debug/alerts` every 5 seconds and shows a **"Load worst trace → analyze"** button — one click takes you from *alert fired* to *root cause loaded in the analyzer*.

**Note:** this watcher is per-process. If you run multiple instances, alerting should live in Prometheus + Alertmanager instead — this is the lightweight single-service layer, not a replacement for that stack.

---

## 8. Exporting to real observability infrastructure

Every trace can be exported as OpenTelemetry (OTLP):

```ts
app.get("/debug/otlp", otlpHandler);
// or auto-forward every finished trace:
if (process.env.OTLP_ENDPOINT) exportOtlp(traceId, process.env.OTLP_ENDPOINT);
```

Point `OTLP_ENDPOINT` at Jaeger (1.35+), Grafana Tempo, or an OTel Collector, and your traces — including cost and RAG attributes on each span — land in the infrastructure your team already runs. This is the intended path to Jaeger visualization and Grafana dashboards: the Lab doesn't reimplement them, it feeds them.

---

## 9. Securing the debug routes before you deploy anywhere

The `/debug/*` routes are convenient in local dev and a real liability anywhere reachable from outside your machine — they expose request bodies, span names, and (once you're tracking cost/RAG) token and pricing data. Gate them before deploying:

```ts
app.use("/debug", debugAuth({ token: process.env.DEBUG_TOKEN }));
// or restrict by source IP instead of / in addition to a token:
app.use("/debug", debugAuth({ allowIps: ["10.0.0.5"] }));
```

Requests then need `Authorization: Bearer <token>` to reach any `/debug/*` route; everything else (your actual agent endpoints) is untouched. Leave both options unset and requests are still allowed through — but you'll get a one-time console warning telling you to fix that before deploying, rather than the routes staying silently open.

The demo server wires this to a `DEBUG_TOKEN` environment variable and reports its state in the startup banner, so you can see at a glance whether you're running gated or open.

## 10. Running the test suites

If you're extending the tracer or middleware, two Node suites and one Python suite exist to catch regressions:

```bash
npm run test:unit          # fast — pure logic (parser, cost math, RAG metrics, merge logic): ~0.1s
npm run test:integration   # slower — real HTTP against the demo app via supertest: ~60s
npm run test               # both together
python3 -m unittest discover python/tests -v   # Python tracer parity
```

Use `test:unit` in your normal edit loop — it's near-instant. Run `test:integration` before anything you'd call "done," since it drives real requests through the actual Express app (including the SLO watcher genuinely firing and a real cross-service `traceparent` handoff), which is the layer unit tests can't see. In VS Code, all three are available as tasks (**Run Task → "Test: Node unit (fast)"** / **"Test: Node integration (supertest, ~60s)"** / **"Test: Python (unittest)"**).

## 11. Using the what-if toggles

These appear once you're in "Paste your trace" mode or the simulated workload:

| Toggle | What it actually does |
|---|---|
| Parallelize sub-agents | Forks the middle agent lanes after the first, joins before the last — fixes the "five sequential agents" anti-pattern |
| Parallelize tool calls | Runs consecutive tool/retrieval spans concurrently instead of sequentially |
| Model routing | Shrinks the first agent's first LLM span (simulating a smaller/faster planning model) |
| Trim context | Shrinks the last agent's final LLM span (simulating a compressed prompt) |
| Cache hit rate | Probabilistically collapses retrieval/tool spans to near-zero latency |
| Co-locate services | Flat latency reduction on every external call (simulating same-region deployment) |
| Stream responses | Shifts the reported latency from total time to time-to-first-token |

Flip one, watch the waterfall/percentiles/cost respond immediately, then apply the change in your actual code and re-measure with a fresh paste — that loop (measure → hypothesize → apply → re-measure) is the point of the tool.

---

## 12. Troubleshooting

**"Paste a trace to analyze it" won't go away.** Check the span count/error indicator above the textarea — a parse error on even one line will show there. Common cause: a line with a category typo (only `llm`/`retr`/`tool`/`orch` are valid) or a duration that doesn't match `123`, `123ms`, or `1.2s`.

**The alert feed panel isn't showing.** It only appears when `/debug/alerts` is reachable — start `npm run server` (or point the Vite proxy at your own running instance) and reload.

**Multi-agent trace looks flat / not forked.** Sequential `@agent` lanes without `(parallel)` markers run one after another by design — that's the sequential-agents pattern the tool is built to expose. Either mark the lanes `(parallel)` in your paste, or use the "Parallelize sub-agents" toggle to see what forking would look like.

**Cost panel isn't appearing.** It only renders when at least one span in the trace has `attrs` with token/model or retrieval-id data — see §6.

**`/debug/*` requests return 401.** You (or the demo server's `DEBUG_TOKEN` env var) have `debugAuth` configured with a required token. Either unset `DEBUG_TOKEN` for local dev, or send `Authorization: Bearer <token>` — the demo server's startup banner tells you which state it's in.
