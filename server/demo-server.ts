/**
 * demo-server.ts — mock NexusAgent orchestration + Benefits triage agent
 * ----------------------------------------------------------------------
 * Exercises the latency-trace middleware end to end, including W3C
 * traceparent propagation across real HTTP hops between agents.
 *
 *   npm run server
 *
 *   # single-agent request (Benefits Triage)
 *   curl -X POST http://localhost:3001/api/triage \
 *        -H 'Content-Type: application/json' \
 *        -d '{"message":"How do I change my HSA contribution?"}'
 *
 *   # multi-agent request (NexusAgent: orchestrator → research ∥ compliance → writer)
 *   curl -X POST http://localhost:3001/api/orchestrate \
 *        -H 'Content-Type: application/json' \
 *        -d '{"request":"Summarize Q2 vendor risk for the audit committee"}'
 *
 *   curl http://localhost:3001/debug/latency
 *
 * The orchestrator calls its sub-agents over HTTP with
 * `req.trace.headersFor("research")` etc. — the sub-agent middleware adopts
 * the incoming traceId, and when the root request finishes the server prints
 * ONE merged block with @swim-lanes, paste-ready for the Lab's multi-agent
 * mode. (Here the sub-agents are routes in the same process, so they stitch
 * via the shared registry; a sub-agent in a separate process would add
 * `reportTo: "<orchestrator>/debug/trace-report"` to its middleware options.)
 *
 * Swap the sleep() calls for real classifiers, pgvector queries, policy
 * engines, and Anthropic calls — the span wrappers stay the same.
 */

import express from "express";
import {
  latencyTrace,
  latencyStatsHandler,
  mergedTraceHandler,
  traceReportHandler,
  alertsHandler,
  otlpHandler,
  exportOtlp,
  debugAuth,
} from "./latency-trace.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// realistic jitter + occasional long tail, like a real external dependency
const jittery = (base: number) =>
  sleep(base * (0.85 + Math.random() * 0.3) * (Math.random() < 0.08 ? 2.5 : 1));

const PORT = Number(process.env.PORT) || 3001;
const SELF = `http://localhost:${PORT}`;

const app = express();
app.use(express.json());
app.use(latencyTrace({
  agent: "orchestrator",
  ignore: (p) => p.startsWith("/health") || p.startsWith("/debug"),
  // SLO watcher — thresholds tightened below the playbook defaults so the
  // demo trips alerts after a handful of requests. In production you'd pass
  // `slo: true` for DEFAULT_SLOS, or your own targets.
  slo: { e2e_p95: 5000, ttft_p50: 1000, span_tool_p95: 1500 },
  alerts: {
    windowSize: 30,
    minRequests: 5,
    cooldownMs: 15_000,
    webhookUrl: process.env.SLO_WEBHOOK_URL, // e.g. a Slack relay
  },
}));

app.get("/health", (_req, res) => res.send("ok"));

// Gate every /debug route. Set DEBUG_TOKEN to require
// `Authorization: Bearer <token>`; unset it and requests are allowed through
// with a one-time console warning (fine for local dev, not for anything
// reachable from outside your machine).
app.use("/debug", debugAuth({ token: process.env.DEBUG_TOKEN }));
app.get("/debug/latency", latencyStatsHandler);
app.get("/debug/latency/trace", mergedTraceHandler);
app.get("/debug/alerts", alertsHandler);
app.get("/debug/otlp", otlpHandler);
// collector endpoint for sub-agents running in other processes
app.post("/debug/trace-report", traceReportHandler);

// Optionally forward every finished trace to a real OTLP/HTTP collector
// (Jaeger 1.35+, Grafana Tempo, or the OTel Collector). Set OTLP_ENDPOINT,
// e.g. http://localhost:4318/v1/traces
const OTLP_ENDPOINT = process.env.OTLP_ENDPOINT;

// ---------------------------------------------------------------------------
// Sub-agents (routes here for demo simplicity — could be separate services;
// the traceparent propagation works identically either way)
// ---------------------------------------------------------------------------

app.post("/agents/research", async (req, res) => {
  const t = req.trace!; // lane name arrives via x-trace-agent from the caller
  await t.span("enterprise search api", "tool", () => jittery(1350));
  const findings = await t.span("synthesize findings (qwen)", "llm", async () => {
    await jittery(980);
    return ["vendor A concentration risk", "two expired SOC 2 reports"];
  }, { model: "qwen-2.5-32b", input_tokens: 2100, output_tokens: 240 });
  res.json({ findings });
});

app.post("/agents/compliance", async (req, res) => {
  const t = req.trace!;
  await t.span("policy engine evaluation", "tool", () => jittery(240));
  const risk = await t.span("risk assessment (qwen)", "llm", async () => {
    await jittery(760);
    return { level: "moderate", flags: 2 };
  }, { model: "qwen-2.5-32b", input_tokens: 1800, output_tokens: 190 });
  res.json({ risk });
});

// ---------------------------------------------------------------------------
// NexusAgent-style orchestrator: plan → fork sub-agents → join → write
// ---------------------------------------------------------------------------

app.post("/api/orchestrate", async (req, res) => {
  const t = req.trace!;

  // 1. plan
  const intent = await t.span("intent classification (qwen)", "llm", async () => {
    await jittery(420);
    return "vendor_risk_summary";
  }, { model: "qwen-2.5-32b", input_tokens: 850, output_tokens: 60 });
  await t.span("tool registry lookup", "tool", () => jittery(35));

  // 2. fork — each sub-agent gets propagation headers naming its lane
  const call = (agent: string) =>
    fetch(`${SELF}/agents/${agent}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...t.headersFor(agent) },
      body: JSON.stringify({ request: (req.body as { request?: string })?.request, intent }),
    }).then((r) => r.json());

  const [research, compliance] = await Promise.all([call("research"), call("compliance")]);

  // 3. join → write
  const endSpan = t.startSpan("final response (qwen)", "llm");
  await jittery(400); // time to first token
  t.event("first_token");
  await jittery(1800);
  endSpan(true, { model: "qwen-2.5-32b", input_tokens: 6400, output_tokens: 520 });
  await t.span("audit log write", "tool", () => jittery(25));

  res.json({ intent, research, compliance, response: "Q2 vendor risk summary: moderate exposure…" });
  if (OTLP_ENDPOINT) exportOtlp(t.traceId, OTLP_ENDPOINT).catch(() => {});
});

// ---------------------------------------------------------------------------
// Benefits Support Triage Agent — single-lane example (unchanged workflow)
// ---------------------------------------------------------------------------

app.post("/api/triage", async (req, res) => {
  const t = req.trace!;

  const category = await t.span("triage classifier (haiku)", "llm", async () => {
    await jittery(600);
    return "benefits_enrollment";
  }, { model: "claude-haiku-4", input_tokens: 1100, output_tokens: 140 });

  const [policyChunks, similarTickets] = await Promise.all([
    t.span("pgvector policy_chunks", "retr", async () => { await jittery(95); return ["chunk_1", "chunk_2"]; },
      { retrieved_ids: ["p1", "p2", "p3", "p7", "p9"], relevant_ids: ["p1", "p3", "p12"], k: 5 }),
    t.span("pgvector resolved_tickets", "retr", async () => { await jittery(110); return ["ticket_884"]; },
      { retrieved_ids: ["t8", "t2", "t5"], relevant_ids: ["t2", "t5"], k: 5 }),
  ]);

  await t.span("ticket history query (postgres)", "tool", () => jittery(40));
  await t.span("benefits eligibility api", "tool", () => jittery(1400));

  const endSpan = t.startSpan("claude final response", "llm");
  await jittery(400);
  t.event("first_token");
  await jittery(1900);
  endSpan(true, { model: "claude-sonnet-4", input_tokens: 5200, output_tokens: 430 });

  res.json({ category, contextUsed: { policyChunks, similarTickets }, response: "You can update your HSA contribution…" });
});

// Export `app` so it can be imported directly (e.g. by an integration test
// with supertest) without binding a real port. Only listen when this file
// is executed directly, i.e. `npm run server` / `tsx server/demo-server.ts`.
export { app, PORT };

const isMain = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isMain) {
  app.listen(PORT, () => {
    console.log(`NexusAgent demo on ${SELF}`);
    console.log(`  POST /api/orchestrate      — multi-agent request (merged @lane trace)`);
    console.log(`  POST /api/triage           — single-agent request`);
    console.log(`  GET  /debug/latency        — rolling P50/P95/P99 + last merged trace`);
    console.log(`  GET  /debug/latency/trace?id=<traceId>`);
    console.log(`  GET  /debug/alerts         — recent SLO alerts (diagnosis-enriched)`);
    console.log(`  GET  /debug/otlp?id=<id>   — OTLP JSON (curl → any OTLP/HTTP collector)`);
    console.log(`  POST /debug/trace-report   — collector for out-of-process sub-agents`);
    console.log(OTLP_ENDPOINT ? `  → auto-exporting traces to ${OTLP_ENDPOINT}` : `  (set OTLP_ENDPOINT to auto-export traces to Jaeger/Tempo)`);
    console.log(process.env.DEBUG_TOKEN ? `  → /debug routes require a bearer token` : `  ⚠ /debug routes are OPEN — set DEBUG_TOKEN before deploying anywhere reachable`);
  });
}
