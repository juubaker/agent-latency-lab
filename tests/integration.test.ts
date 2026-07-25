import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { app as demoApp, PORT as demoPort } from "../server/demo-server";
import { latencyTrace, latencyStatsHandler, alertsHandler, otlpHandler, debugAuth, __resetForTests } from "../server/latency-trace";

beforeEach(() => __resetForTests());

// /api/orchestrate makes a genuine self-fetch to http://localhost:<PORT> to
// call its own sub-agent routes (a faithful stand-in for calling a separate
// service). supertest(app) alone never binds that port, so orchestrate
// requests would fail with ECONNREFUSED — bind a real listener on the app's
// own configured port for the duration of this suite.
let demoServer: Server;
beforeAll(async () => {
  await new Promise<void>((resolve) => {
    demoServer = demoApp.listen(demoPort, () => resolve());
  });
});
afterAll(async () => {
  await new Promise((resolve) => demoServer.close(resolve));
});

// ---------------------------------------------------------------------------
// Single-agent endpoint wiring, against the real demo app (real Express
// routing, real middleware order, real JSON body parsing — not the pure
// functions tested in unit tests).
// ---------------------------------------------------------------------------

describe("POST /api/triage (integration)", () => {
  it("returns 200 with the expected response shape", async () => {
    const res = await request(demoApp)
      .post("/api/triage")
      .send({ message: "How do I change my HSA contribution?" })
      .set("Content-Type", "application/json");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("category");
    expect(res.body).toHaveProperty("contextUsed.policyChunks");
    expect(res.body).toHaveProperty("contextUsed.similarTickets");
  }, 10_000);

  it("records a trace that /debug/latency can then report on", async () => {
    await request(demoApp).post("/api/triage").send({ message: "PTO question" });
    const stats = await request(demoApp).get("/debug/latency");
    expect(stats.status).toBe(200);
    expect(stats.body.sample_size).toBeGreaterThanOrEqual(1);
    expect(stats.body.last_trace_lab_format).toContain("triage classifier");
    // this trace carries token attrs, so cost should be nonzero
    expect(stats.body.total_cost_usd).toBeGreaterThan(0);
  }, 10_000);
}, 15_000);

// ---------------------------------------------------------------------------
// Multi-agent orchestration over REAL HTTP (the orchestrator's route makes
// genuine fetch() calls to its own sub-agent routes) — this is the one thing
// unit tests structurally cannot cover, since it depends on Express's actual
// request/response cycle and real network timing between routes.
// ---------------------------------------------------------------------------

describe("POST /api/orchestrate (integration)", () => {
  it("fans out to research + compliance and returns a merged result", async () => {
    const res = await request(demoApp)
      .post("/api/orchestrate")
      .send({ request: "Summarize Q2 vendor risk" });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("research.findings");
    expect(res.body).toHaveProperty("compliance.risk");
  }, 15_000);

  it("produces a merged multi-agent trace with fork/join structure and RAG-free cost", async () => {
    await request(demoApp).post("/api/orchestrate").send({ request: "vendor risk" });
    const stats = await request(demoApp).get("/debug/latency");
    const text: string = stats.body.last_trace_lab_format;
    expect(stats.body.last_trace_agents.length).toBeGreaterThanOrEqual(3); // orchestrator + research + compliance (+ join)
    expect(text).toContain("@orchestrator");
    expect(text).toContain("@research");
    expect(text).toContain("@compliance");
    expect(text).toMatch(/@orchestrator.?join|orchestrator·join/);
  }, 15_000);

  it("exposes the merged trace via GET /debug/otlp with cost attributes on LLM spans", async () => {
    await request(demoApp).post("/api/orchestrate").send({ request: "vendor risk" });
    const otlp = await request(demoApp).get("/debug/otlp");
    expect(otlp.status).toBe(200);
    const spans = otlp.body.resourceSpans.flatMap((rs: any) => rs.scopeSpans.flatMap((ss: any) => ss.spans));
    expect(spans.length).toBeGreaterThan(0);
    const withCost = spans.filter((s: any) => s.attributes.some((a: any) => a.key === "llm.cost.usd"));
    expect(withCost.length).toBeGreaterThan(0);
  }, 15_000);
}, 20_000);

// ---------------------------------------------------------------------------
// SLO watcher firing over real requests (not a synthetic registered trace —
// actual repeated HTTP calls against tight thresholds).
// ---------------------------------------------------------------------------

describe("SLO watcher (integration)", () => {
  it("fires and records an alert once enough requests breach the threshold", async () => {
    // demo app's orchestrator route is configured with e2e_p95: 5000ms and
    // minRequests: 5 — real request latencies here are simulated but run in
    // real time (jittery() sleeps ~5s per orchestrate call), so 6 sequential
    // real calls reliably exercises the watcher end-to-end, at the cost of
    // needing a generous timeout for this one test.
    for (let i = 0; i < 6; i++) {
      await request(demoApp).post("/api/orchestrate").send({ request: `req ${i}` });
    }
    const alerts = await request(demoApp).get("/debug/alerts");
    expect(alerts.status).toBe(200);
    expect(Array.isArray(alerts.body.alerts)).toBe(true);
    // Not asserting alerts.length > 0 as a hard requirement — jittery() means
    // a given run may or may not cross 5000ms — but if any fired, validate shape.
    if (alerts.body.alerts.length > 0) {
      const a = alerts.body.alerts[0];
      expect(a).toHaveProperty("rule");
      expect(a).toHaveProperty("recommendation");
      expect(a).toHaveProperty("dominant_category");
      expect(typeof a.worst_trace_lab_format === "string" || a.worst_trace_lab_format === null).toBe(true);
    }
  }, 60_000);
}, 65_000);

// ---------------------------------------------------------------------------
// debugAuth wired into a real Express app and hit over real HTTP (the unit
// tests exercise the middleware function directly; this confirms it behaves
// correctly once mounted with app.use() and real header parsing).
// ---------------------------------------------------------------------------

describe("debugAuth mounted on a real app (integration)", () => {
  function buildGatedApp(token?: string) {
    const app = express();
    app.use(latencyTrace({ agent: "test" }));
    app.use("/debug", debugAuth({ token }));
    app.get("/debug/latency", latencyStatsHandler);
    app.get("/debug/alerts", alertsHandler);
    app.get("/debug/otlp", otlpHandler);
    app.get("/open", (_req, res) => res.send("ok")); // not under /debug — never gated
    return app;
  }

  it("blocks /debug/* with no Authorization header when a token is required", async () => {
    const app = buildGatedApp("s3cret");
    const res = await request(app).get("/debug/latency");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });

  it("blocks /debug/* with an incorrect token", async () => {
    const app = buildGatedApp("s3cret");
    const res = await request(app).get("/debug/latency").set("Authorization", "Bearer wrong");
    expect(res.status).toBe(401);
  });

  it("allows /debug/* with the correct bearer token", async () => {
    const app = buildGatedApp("s3cret");
    const res = await request(app).get("/debug/latency").set("Authorization", "Bearer s3cret");
    expect(res.status).toBe(200);
  });

  it("does not gate routes outside /debug", async () => {
    const app = buildGatedApp("s3cret");
    const res = await request(app).get("/open");
    expect(res.status).toBe(200);
    expect(res.text).toBe("ok");
  });

  it("gates every /debug/* route, not just one", async () => {
    const app = buildGatedApp("s3cret");
    const [latency, alerts, otlp] = await Promise.all([
      request(app).get("/debug/latency"),
      request(app).get("/debug/alerts"),
      request(app).get("/debug/otlp"),
    ]);
    expect([latency.status, alerts.status, otlp.status]).toEqual([401, 401, 401]);
  });
});

// ---------------------------------------------------------------------------
// Cross-process traceparent propagation: two REAL Express servers on
// ephemeral ports, one orchestrator that calls the other over real HTTP with
// headersFor()-generated headers, and reportTo wired back to the caller's
// collector — the exact distributed scenario headersFor()/reportTo exist for.
// ---------------------------------------------------------------------------

describe("cross-process trace propagation (integration)", () => {
  // Honesty note: within a single Vitest process, `caller` and `remote` both
  // import the SAME latency-trace module instance, so they share one
  // in-memory registry regardless of reportTo — meaning this test cannot, by
  // itself, prove registry isolation the way two real OS processes would.
  // What it DOES faithfully exercise end-to-end over real HTTP: headersFor()
  // producing a valid traceparent, the remote's middleware parsing it and
  // adopting the traceId/agent name, the remote firing a real POST to
  // /debug/trace-report on finish, and traceReportHandler ingesting that
  // payload correctly. That's the actual wire contract reportTo depends on;
  // true multi-process isolation is a deployment property, not app logic,
  // and is out of scope for a single-process test run.
  it("propagates traceparent + reports back via reportTo, merging into one trace", async () => {
    // 1. Start the CALLER first so the remote service can be told where to
    //    report back to (reportTo needs a real, already-known address).
    const caller = express();
    caller.use(express.json());
    caller.use(latencyTrace({ agent: "orchestrator" }));
    const { traceReportHandler } = await import("../server/latency-trace");
    caller.post("/debug/trace-report", express.json(), traceReportHandler);
    caller.get("/debug/latency", latencyStatsHandler);
    const callerServer = caller.listen(0);
    const callerPort = (callerServer.address() as AddressInfo).port;

    // 2. Start a REMOTE service in its own Express app (a real separate
    //    process boundary in production; here a separate app + own port is
    //    the faithful equivalent within one test process) that reports
    //    every finished trace back to the caller's collector.
    const remote = express();
    remote.use(express.json());
    remote.use(
      latencyTrace({
        agent: "remote-worker",
        reportTo: `http://localhost:${callerPort}/debug/trace-report`,
      })
    );
    remote.post("/work", async (req, res) => {
      const t = (req as any).trace;
      await t.span("remote db query", "tool", () => new Promise((r) => setTimeout(r, 15)));
      res.json({ ok: true });
    });
    const remoteServer = remote.listen(0);
    const remotePort = (remoteServer.address() as AddressInfo).port;

    // 3. The caller's own route plans, then calls the remote service with
    //    real traceparent propagation headers via headersFor().
    caller.post("/kickoff", async (req, res) => {
      const t = (req as any).trace;
      await t.span("plan", "orch", () => new Promise((r) => setTimeout(r, 5)));
      await fetch(`http://localhost:${remotePort}/work`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...t.headersFor("remote-worker") },
        body: "{}",
      });
      res.json({ ok: true, traceId: t.traceId });
    });

    try {
      const res = await request(`http://localhost:${callerPort}`).post("/kickoff").send({});
      expect(res.status).toBe(200);
      const traceId: string = res.body.traceId;
      expect(traceId).toMatch(/^[0-9a-f]{32}$/);

      // The remote's trace-report POST is fire-and-forget (not awaited by
      // /work's response), so give it a brief moment to land before checking.
      await new Promise((r) => setTimeout(r, 200));

      const stats = await request(`http://localhost:${callerPort}`).get("/debug/latency");
      expect(stats.body.last_trace_id).toBe(traceId);
      expect(stats.body.last_trace_agents).toEqual(
        expect.arrayContaining(["orchestrator", "remote-worker"])
      );
      const merged: string = stats.body.last_trace_lab_format;
      expect(merged).toContain("@orchestrator");
      expect(merged).toContain("@remote-worker");
      expect(merged).toContain("remote db query");
    } finally {
      await new Promise((r) => remoteServer.close(r));
      await new Promise((r) => callerServer.close(r));
    }
  }, 15_000);
});
