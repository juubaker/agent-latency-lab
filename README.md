# Agent Latency Lab

An interactive analyzer for AI agent latency — trace waterfalls with
multi-agent swim-lanes, fork/join critical-path analysis, Monte Carlo
percentile distributions, SLO budget scoring, and what-if optimizations
(parallelize sub-agents, parallel tool calls, model routing, semantic caching,
context trimming, co-location, streaming). Tracks **token accounting, per-request cost, and RAG retrieval quality**
alongside latency. Ships with zero-dependency instrumentation for Node *and*
Python, W3C `traceparent` propagation so **distributed multi-agent requests
stitch into one trace**, and an **OTLP exporter** that lands spans (with cost
and RAG attributes) in Jaeger, Grafana Tempo, or any OpenTelemetry backend.

Built around the production-latency playbook: measure first, attack the
largest contributor, think in P95s and budgets — not averages.

## Download

Prebuilt desktop apps for macOS, Windows, and Linux — no install, no build
step, runs fully offline (simulated workload + paste-your-trace, zero
network dependency):

**[→ Latest release](https://github.com/YOUR_GITHUB_USERNAME/agent-latency-lab/releases/latest)**

| Platform | File |
|---|---|
| macOS | `Agent Latency Lab-*.dmg` (built on macOS only — see workflow) |
| Windows | `Agent Latency Lab Setup *.exe` (built & verified — Wine cross-build) |
| Linux | `Agent Latency Lab-*.AppImage` (built & verified — AppImage headless launch) |

These are unsigned builds (no Apple Developer ID / code-signing cert). Notes
on each platform:

- **Windows:** the distributable `.exe` was cross-built in our CI and
  locally verified via Wine + `wine32`; the produced PE32 NSIS installer
  launches under Wine and produces a working app. SmartScreen may still
  warn for unsigned builds — certificate or Trusted Signing removes that.
- **Linux:** the AppImage was built and verified by launching it headlessly
  to confirm the React UI mounts and the app's strict CSP blocks any
  outbound requests as expected.
- **macOS:** DMG creation and code-signing are macOS-native operations
  (requires `hdiutil`/`codesign` and an Apple signing identity) and cannot
  be reliably cross-built off macOS. For automated macOS artifacts, use the
  repository's GitHub Actions workflow which runs a `macos-latest` runner
  to produce the signed/unsinged DMG as appropriate: see
  `.github/workflows/release.yml` (Build & Release Desktop App).

Also available: a [VS Code extension](vscode-extension/) for analyzing
traces without leaving the editor.

## Quick start

```bash
npm install
npm run dev        # Lab UI        → http://localhost:5173
npm run server     # demo agent    → http://localhost:3001
npm run test       # 53 Node tests (41 unit + 12 integration)
```

Or in VS Code: open `agent-latency-lab.code-workspace`, then
**Terminal → Run Task → "Dev: Both (UI + server)"**.

## Multi-agent traces

Lanes use `@agent` headers; consecutive `(parallel)` lanes fork together
after the previous sequential lane and everything joins before the next one:

```
@orchestrator
intent classification (qwen), llm, 420
@research (parallel)
enterprise search api, tool, 1350
@compliance (parallel)
policy engine evaluation, tool, 240
@writer
final response (qwen), llm, 2200
```

The Lab renders one swim-lane per agent, flags the **critical path** in each
fork group (optimizing a slack lane buys nothing — the join still waits), and
the "Parallelize sub-agents" what-if forks the middle lanes to show the
sequential-agents anti-pattern fix.

On the middleware side, the orchestrator propagates context on every
sub-agent call:

```ts
fetch(researchUrl, { headers: { ...req.trace!.headersFor("research"), ... } });
```

The sub-agent's middleware adopts the incoming `traceparent`, names its lane
from `x-trace-agent`, and the finished request logs ONE merged block — with
the orchestrator's lane split at the fork so plan → parallel children → join
→ write reproduces the real timeline. Same-process agents stitch via the
shared registry automatically; out-of-process agents add
`reportTo: "<orchestrator>/debug/trace-report"` and POST their lanes back.
(Lanes align via each process's clock: same-host <1 ms, cross-host inherits
NTP skew.)

## Token accounting, cost & RAG quality

Attach attributes to spans and the tools compute cost and retrieval quality:

```ts
// LLM spans — tokens + model → cost (Anthropic & Groq pricing built in)
await t.span("final response", "llm", () => callClaude(prompt),
  { model: "claude-sonnet-4", input_tokens: 5200, output_tokens: 430 });

// retrieval spans — retrieved + known-relevant ids → precision@k, recall@k, MRR
await t.span("pgvector policy_chunks", "retr", () => search(q),
  { retrieved_ids: hits.map(h => h.id), relevant_ids: goldSet, k: 5 });
```

`/debug/latency` then reports `cost_per_request_p50/p95`, `total_tokens`,
cost broken down by model, and averaged RAG metrics. The Lab surfaces a
**cost-per-request** card, a **Recall@k** card, and a **Cost & retrieval
quality** panel (cost by model + precision/recall/MRR bars) — paste any trace
with attrs (try the "Cost + RAG (JSON)" example) to see them. Retrieval
metrics are deterministic and cheap; faithfulness/LLM-as-judge is deliberately
left to offline eval, not the inline telemetry path.

## OpenTelemetry / OTLP export

Every span exports as an OTLP span with `llm.model`, `llm.tokens.*`,
`llm.cost.usd`, and `rag.*` attributes:

```ts
app.get("/debug/otlp", otlpHandler);          // inspect or curl → collector
// or auto-forward every finished trace:
if (OTLP_ENDPOINT) exportOtlp(traceId, OTLP_ENDPOINT);   // .../v1/traces
```

Point `OTLP_ENDPOINT` at Jaeger (1.35+ native OTLP), Grafana Tempo, or the
OTel Collector and your traces — multi-agent lanes included — land in the
observability stack teams already run. That's the honest version of "Jaeger
exporter" and "Grafana dashboards": emit the open standard and let real
backends consume it, rather than reimplementing them. Python gets the same:
`tracer.export_otlp("http://localhost:4318/v1/traces")`.

## Tests

```bash
npm run test               # everything: 41 unit + 12 integration tests
npm run test:unit          # fast — pure logic, ~0.1s
npm run test:integration   # slower — real HTTP via supertest, ~60s
python3 -m unittest discover python/tests -v   # Python tracer parity (28 tests)
```

**Unit tests** (`tests/latency-trace.test.ts`) cover the pure logic that's
easy to get subtly wrong and hard to eyeball-verify: overlap detection (does
`Promise.all`/`ThreadPoolExecutor` usage actually get flagged parallel), the
fork/join trace-merge reconstruction (root lane split at the correct point,
only genuinely-overlapping children marked parallel), cost math against the
pricing table, RAG precision/recall/MRR on hand-computed cases, OTLP payload
shape, and the `debugAuth` middleware function called directly.

**Integration tests** (`tests/integration.test.ts`, via `supertest`) exercise
the real Express wiring instead of the pure functions underneath it: `POST
/api/triage` and `/api/orchestrate` against the actual demo app (including a
genuine self-`fetch()` to real sub-agent routes — a real bug surfaced here
during development, since supertest's in-memory app doesn't bind a real port
by default), the SLO watcher actually firing over six real orchestrated
requests, `debugAuth` mounted with `app.use()` and hit over real HTTP, and
cross-process `traceparent` propagation with a genuine `reportTo` POST back to
a collector endpoint on a separate Express app/port. That last test's own
comment is explicit about its one real limitation: within a single test
process, two apps still share one imported module instance (one in-memory
registry), so it fully verifies the wire contract (headers, parsing,
reporting, merging) but can't prove OS-level process isolation the way two
real `npm run server` instances would.

`__resetForTests` and `__recordForTests` are test-only exports for isolating
the in-memory registry between cases — not meant for production use.

## SLO watcher — notify, diagnose, recommend

The middleware watches rolling percentiles on every finished request and
fires **diagnosis-enriched alerts** on breach:

```ts
app.use(latencyTrace({
  agent: "orchestrator",
  slo: true,                                  // playbook targets (DEFAULT_SLOS)
  // slo: { e2e_p95: 5000, ttft_p50: 1000, span_tool_p95: 500 },  // or custom
  alerts: {
    webhookUrl: process.env.SLO_WEBHOOK_URL,  // Slack/Teams relay, PagerDuty…
    onAlert: (a) => myPager.notify(a),        // programmatic hook
    windowSize: 50, minRequests: 20, cooldownMs: 60_000,
  },
}));
app.get("/debug/alerts", alertsHandler);
```

Each alert names the breached rule and observed vs. target, diagnoses the
dominant span category across the breaching requests, names the top offending
span, attaches the recommended fix, and includes the worst trace in Lab paste
format:

```
[SLO ALERT] e2e_p95 breached: 8732ms (target 5000ms) over last 50 requests
  dominant: llm (98%) · top span: final response (qwen)
  fix: Route simpler steps to a smaller model, trim the context window, …
  worst trace b9c7bbc4…
  @orchestrator
  intent classification (qwen), llm, 448
  …
```

The Lab shows a **live alert feed** (polling `/debug/alerts` through the Vite
proxy) with a "Load worst trace → analyze" button — alert to root-cause to
what-if fix in two clicks. Cooldown prevents alert storms; a bad minute fires
once per rule, not two hundred times.

Scope honesty: this watcher is per-process and dies with it. In a
multi-instance deployment, alerting belongs to Prometheus recording rules +
Alertmanager (aggregation, dedup, routing, paging); this is the lightweight
single-service layer, and it hands off cleanly there. Fixed thresholds only —
no anomaly detection or SLO burn-rate alerting.

## The measure → analyze → optimize loop

1. **Instrument.** `server/latency-trace.ts` wraps each agent stage in a span:

   ```ts
   app.use(latencyTrace());

   const category = await req.trace!.span("triage classifier (haiku)", "llm",
     () => classifyTicket(msg));

   await Promise.all([                       // parallel spans are auto-detected
     req.trace!.span("pgvector policy_chunks", "retr", () => searchPolicies(msg)),
     req.trace!.span("pgvector resolved_tickets", "retr", () => searchTickets(msg)),
   ]);
   ```

   For streaming LLM calls, `trace.startSpan()` + `trace.event("first_token")`
   captures real TTFT. Every finished request logs a paste-ready block:

   ```
   [latency] POST /api/triage — 4732ms total · TTFT 1180ms
   triage classifier (haiku), llm, 612
   pgvector policy_chunks, retr, 94
   | pgvector resolved_tickets, retr, 108
   benefits eligibility api, tool, 1421
   claude final response, llm, 2388
   ```

2. **Analyze.** Paste that block into the Lab's **"Paste your trace"** tab.
   It synthesizes a 240-request distribution around your trace (±jitter, 6%
   long-tail on external calls) and scores it against SLOs: TTFT < 1 s,
   P50 < 3 s, P95 < 7 s, P99 < 15 s.

3. **Optimize.** Flip the what-if toggles — each maps to a real technique —
   and watch the waterfall, percentiles, and budget table respond. Then apply
   the winning change in code and re-measure. `GET /debug/latency` gives
   rolling P50/P95/P99 over the last 200 requests to confirm the improvement.

Try the demo loop right now: run both tasks, send a few requests from
`requests.http` (REST Client extension), copy the trace from the server
terminal, and paste it into the Lab.

## Project layout

```
├── src/
│   ├── AgentLatencyLab.jsx    the full Lab UI (simulated + custom-trace modes)
│   └── main.tsx               React entry
├── server/
│   ├── latency-trace.ts       tracer, traceparent propagation, merge + stats,
│   │                          debugAuth, SLO watcher, OTLP exporter
│   └── demo-server.ts         NexusAgent-style orchestrator + sub-agents + triage
├── python/
│   ├── latency_trace.py       Python tracer — Lab formats, cost/RAG, OTLP
│   └── tests/                 28 unittest cases (tracer parity)
├── tests/
│   ├── latency-trace.test.ts  41 Vitest unit tests (pure logic)
│   └── integration.test.ts    12 Vitest + supertest tests (real HTTP/Express)
├── vitest.config.ts
├── requests.http              sample requests (REST Client)
├── .vscode/                   tasks (dev/build/typecheck/test), debug configs
└── agent-latency-lab.code-workspace
```

## VS Code niceties

- **F5 → "Debug demo server"** — breakpoints inside your span callbacks.
- **Run Task → Typecheck** — strict-mode `tsc` across UI and server.
- **Run Task → "Test: Node unit (fast)"** — pure-logic tests, ~0.1s feedback loop.
- **Run Task → "Test: Node integration (supertest, ~60s)"** — real HTTP against the demo app.
- **Run Task → "Test: Python (unittest)"** — tracer parity.
- **requests.http** — fire triage requests without leaving the editor.

## Securing the /debug routes

`/debug/*` exposes request bodies, span names, and (with accounting attrs)
token/cost data — fine wide open in local dev, not once anything is reachable
from outside your machine:

```ts
app.use("/debug", debugAuth({ token: process.env.DEBUG_TOKEN }));
// or: debugAuth({ allowIps: ["10.0.0.5"] })
```

With no options, requests are allowed through but a one-time console warning
fires — insecure-by-default, but loud about it rather than silent. The demo
server wires this to `DEBUG_TOKEN` and reports its state in the startup banner.

## Notes

- The stats ring buffer is per-process memory (last 200 requests). For
  multi-instance deployments, that's where Prometheus histograms take over —
  tracing answers *why was this request slow*, metrics answer *how often*.
- To instrument a real agent, copy `server/latency-trace.ts` (Node) or
  `python/latency_trace.py` (Python) into your project; neither has runtime
  dependencies beyond the language itself.
- The Lab's JSON import also accepts ad-hoc tracer output: `step`/`label` are
  accepted as span-name fields, `duration_ms` as duration, and self-reported
  `total` rows are skipped to avoid double-counting.
