import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Tracer,
  parseTraceparent,
  computeCost,
  ragMetrics,
  accounting,
  priceFor,
  mergedLabText,
  latencyStats,
  toOtlp,
  recentAlerts,
  debugAuth,
  __resetForTests,
  __recordForTests,
  type SpanAttrs,
} from "../server/latency-trace";

// A minimal fake req/res pair sufficient for exercising the middleware paths
// that don't require a real HTTP server.
function fakeReqRes(headers: Record<string, string> = {}) {
  const req: any = { method: "GET", originalUrl: "/x", headers };
  let statusCode = 200;
  let body: unknown = null;
  const res: any = {
    status(code: number) { statusCode = code; return res; },
    json(b: unknown) { body = b; },
    setHeader() {},
    end(b?: string) { if (b) body = JSON.parse(b); },
  };
  return { req, res, get statusCode() { return statusCode; }, get body() { return body; } };
}

beforeEach(() => __resetForTests());

// --------------------------------------------------------------------------
// Tracer core
// --------------------------------------------------------------------------

describe("Tracer", () => {
  it("times a span and records duration close to actual elapsed time", async () => {
    const t = new Tracer("test");
    await t.span("wait", "tool", () => new Promise((r) => setTimeout(r, 30)));
    expect(t.spans).toHaveLength(1);
    expect(t.spans[0].name).toBe("wait");
    expect(t.spans[0].cat).toBe("tool");
    expect(t.spans[0].dur).toBeGreaterThanOrEqual(25);
    expect(t.spans[0].ok).toBe(true);
  });

  it("marks a span failed and rethrows on error, without losing the timing", async () => {
    const t = new Tracer("test");
    await expect(
      t.span("boom", "tool", () => { throw new Error("nope"); })
    ).rejects.toThrow("nope");
    expect(t.spans).toHaveLength(1);
    expect(t.spans[0].ok).toBe(false);
  });

  it("detects overlapping spans and exports them with the parallel prefix", async () => {
    const t = new Tracer("test");
    await Promise.all([
      t.span("a", "tool", () => new Promise((r) => setTimeout(r, 20))),
      t.span("b", "tool", () => new Promise((r) => setTimeout(r, 15))),
    ]);
    const lines = t.toLabText().split("\n");
    // whichever finished first is listed first (sorted by start); the other overlaps it
    expect(lines.some((l) => l.startsWith("| "))).toBe(true);
  });

  it("does not mark strictly sequential spans as parallel", async () => {
    const t = new Tracer("test");
    await t.span("a", "tool", () => new Promise((r) => setTimeout(r, 10)));
    await t.span("b", "tool", () => new Promise((r) => setTimeout(r, 10)));
    const lines = t.toLabText().split("\n");
    expect(lines.every((l) => !l.startsWith("| "))).toBe(true);
  });

  it("captures TTFT via event() relative to span start", async () => {
    const t = new Tracer("test");
    const end = t.startSpan("stream", "llm");
    await new Promise((r) => setTimeout(r, 10));
    t.event("first_token");
    await new Promise((r) => setTimeout(r, 10));
    end();
    expect(t.ttftMs).not.toBeNull();
    expect(t.ttftMs!).toBeGreaterThanOrEqual(8);
    expect(t.ttftMs!).toBeLessThan(t.totalMs);
  });

  it("returns null TTFT when no first_token event was recorded", () => {
    const t = new Tracer("test");
    expect(t.ttftMs).toBeNull();
  });

  it("attaches attrs passed directly to span()", async () => {
    const t = new Tracer("test");
    const attrs: SpanAttrs = { model: "claude-haiku-4", input_tokens: 100, output_tokens: 20 };
    await t.span("llm call", "llm", () => "ok", attrs);
    expect(t.spans[0].attrs).toEqual(attrs);
  });

  it("adopts an incoming traceId and marks itself a child", () => {
    const parent = new Tracer("root");
    const child = new Tracer("sub", { traceId: parent.traceId, parentSpanId: "abc123", agentName: "research" });
    expect(child.traceId).toBe(parent.traceId);
    expect(child.isChild).toBe(true);
    expect(child.agentName).toBe("research");
  });

  it("generates fresh, distinct traceIds for unrelated tracers", () => {
    const a = new Tracer("a");
    const b = new Tracer("b");
    expect(a.traceId).not.toBe(b.traceId);
    expect(a.isChild).toBe(false);
  });

  it("headersFor() produces a well-formed W3C traceparent", () => {
    const t = new Tracer("root");
    const headers = t.headersFor("research");
    expect(headers["x-trace-agent"]).toBe("research");
    expect(parseTraceparent(headers.traceparent)).toEqual({
      traceId: t.traceId,
      spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
  });
});

// --------------------------------------------------------------------------
// traceparent parsing
// --------------------------------------------------------------------------

describe("parseTraceparent", () => {
  it("parses a valid W3C traceparent header", () => {
    const header = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;
    expect(parseTraceparent(header)).toEqual({ traceId: "a".repeat(32), spanId: "b".repeat(16) });
  });

  it("rejects malformed headers", () => {
    expect(parseTraceparent("not-a-traceparent")).toBeNull();
    expect(parseTraceparent("00-short-b-01")).toBeNull();
    expect(parseTraceparent(undefined)).toBeNull();
    expect(parseTraceparent(123 as unknown as string)).toBeNull();
  });

  it("is case-insensitive on hex digits", () => {
    const header = `00-${"A".repeat(32)}-${"B".repeat(16)}-01`;
    const parsed = parseTraceparent(header);
    expect(parsed?.traceId).toBe("a".repeat(32));
    expect(parsed?.spanId).toBe("b".repeat(16));
  });
});

// --------------------------------------------------------------------------
// Cost accounting
// --------------------------------------------------------------------------

describe("computeCost / priceFor", () => {
  it("computes cost from known model pricing", () => {
    // claude-haiku-4: [0.8, 4] $/1M tokens
    const cost = computeCost({ model: "claude-haiku-4", input_tokens: 1000, output_tokens: 500 });
    expect(cost).toBeCloseTo((1000 * 0.8 + 500 * 4) / 1_000_000, 10);
  });

  it("fuzzy-matches model names by substring", () => {
    expect(priceFor("anthropic/claude-sonnet-4-20250514")).toEqual([3, 15]);
    expect(priceFor("groq/qwen-2.5-32b-instruct")).toEqual([0.2, 0.2]);
  });

  it("returns 0 for unknown models", () => {
    expect(computeCost({ model: "some-future-model", input_tokens: 1000, output_tokens: 1000 })).toBe(0);
    expect(priceFor("totally-unknown")).toBeNull();
  });

  it("respects an explicit cost_usd override even if a model is present", () => {
    expect(computeCost({ model: "claude-opus-4", input_tokens: 999999, cost_usd: 0.001 })).toBe(0.001);
  });

  it("returns 0 for undefined attrs", () => {
    expect(computeCost(undefined)).toBe(0);
  });
});

// --------------------------------------------------------------------------
// RAG metrics
// --------------------------------------------------------------------------

describe("ragMetrics", () => {
  it("computes precision@k, recall@k, and MRR correctly", () => {
    const m = ragMetrics({
      retrieved_ids: ["a", "b", "c", "x", "y"],
      relevant_ids: ["a", "c", "z"],
      k: 5,
    });
    expect(m).not.toBeNull();
    expect(m!.precision_at_k).toBeCloseTo(2 / 5); // a, c hit out of 5
    expect(m!.recall_at_k).toBeCloseTo(2 / 3);     // a, c out of {a,c,z}
    expect(m!.mrr).toBe(1);                        // "a" hits at rank 1
  });

  it("computes MRR correctly when the first hit is not rank 1", () => {
    const m = ragMetrics({ retrieved_ids: ["x", "y", "a"], relevant_ids: ["a"], k: 5 });
    expect(m!.mrr).toBeCloseTo(1 / 3);
  });

  it("defaults k to 5 when omitted", () => {
    const m = ragMetrics({ retrieved_ids: ["a", "b", "c", "d", "e", "f"], relevant_ids: ["f"] });
    // "f" is 6th, outside default k=5 window for precision, but MRR looks at the full list
    expect(m!.precision_at_k).toBe(0);
    expect(m!.mrr).toBeCloseTo(1 / 6);
  });

  it("returns 0s (not NaN) when relevant_ids is empty", () => {
    const m = ragMetrics({ retrieved_ids: ["a", "b"], relevant_ids: [], k: 5 });
    expect(m!.recall_at_k).toBe(0);
    expect(Number.isNaN(m!.precision_at_k)).toBe(false);
  });

  it("returns null when retrieval attrs are absent", () => {
    expect(ragMetrics(undefined)).toBeNull();
    expect(ragMetrics({ model: "x" })).toBeNull();
  });
});

// --------------------------------------------------------------------------
// accounting() rollups
// --------------------------------------------------------------------------

describe("accounting", () => {
  it("sums tokens and cost across spans, grouped by model", () => {
    const spans = [
      { name: "a", cat: "llm" as const, start: 0, dur: 10, ok: true, attrs: { model: "claude-haiku-4", input_tokens: 1000, output_tokens: 100 } },
      { name: "b", cat: "llm" as const, start: 10, dur: 10, ok: true, attrs: { model: "claude-haiku-4", input_tokens: 500, output_tokens: 50 } },
      { name: "c", cat: "llm" as const, start: 20, dur: 10, ok: true, attrs: { model: "claude-sonnet-4", input_tokens: 2000, output_tokens: 300 } },
      { name: "d", cat: "tool" as const, start: 30, dur: 5, ok: true }, // no attrs — ignored
    ];
    const acc = accounting(spans);
    expect(acc.input_tokens).toBe(3500);
    expect(acc.output_tokens).toBe(450);
    expect(acc.by_model["claude-haiku-4"].calls).toBe(2);
    expect(acc.by_model["claude-sonnet-4"].calls).toBe(1);
    expect(acc.cost_usd).toBeGreaterThan(0);
  });

  it("averages RAG metrics across multiple retrieval spans", () => {
    const spans = [
      { name: "r1", cat: "retr" as const, start: 0, dur: 10, ok: true, attrs: { retrieved_ids: ["a"], relevant_ids: ["a"], k: 5 } },
      { name: "r2", cat: "retr" as const, start: 10, dur: 10, ok: true, attrs: { retrieved_ids: ["x"], relevant_ids: ["a"], k: 5 } },
    ];
    const acc = accounting(spans);
    expect(acc.rag).not.toBeNull();
    expect(acc.rag!.samples).toBe(2);
    expect(acc.rag!.recall_at_k).toBeCloseTo(0.5); // one hit, one miss
  });

  it("returns null rag and zero cost when no spans carry attrs", () => {
    const spans = [{ name: "a", cat: "tool" as const, start: 0, dur: 10, ok: true }];
    const acc = accounting(spans);
    expect(acc.rag).toBeNull();
    expect(acc.cost_usd).toBe(0);
    expect(acc.total_tokens).toBe(0);
  });
});

// --------------------------------------------------------------------------
// Trace merging (fork/join reconstruction)
// --------------------------------------------------------------------------

describe("mergedLabText", () => {
  it("returns null when no group is registered", () => {
    expect(mergedLabText("nonexistent")).toBeNull();
  });

  it("returns a flat single-agent trace unchanged when only one agent participated", () => {
    __recordForTests({
      traceId: "t1", agentName: "solo", epochStart: 1000, totalMs: 100, ttftMs: null, child: false,
      spans: [
        { name: "plan", cat: "orch", start: 0, dur: 20, ok: true },
        { name: "final", cat: "llm", start: 20, dur: 80, ok: true },
      ],
    });
    const text = mergedLabText("t1")!;
    expect(text).not.toContain("@"); // no swim-lane headers for a single agent
    expect(text.split("\n")).toHaveLength(2);
  });

  it("splits the root's lane at the fork point and marks overlapping children parallel", () => {
    const traceId = "t2";
    // root: "plan" before the fork, "write" after — starts at epoch 1000
    __recordForTests({
      traceId, agentName: "orchestrator", epochStart: 1000, totalMs: 210, ttftMs: null, child: false,
      spans: [
        { name: "plan", cat: "orch", start: 0, dur: 50, ok: true },     // 1000-1050
        { name: "write", cat: "llm", start: 150, dur: 60, ok: true },   // 1150-1210 (post-join)
      ],
    });
    // two children start together right after the plan (epoch 1050), overlapping each other
    __recordForTests({
      traceId, agentName: "research", epochStart: 1050, totalMs: 100, ttftMs: null, child: true,
      spans: [{ name: "search", cat: "tool", start: 0, dur: 100, ok: true }],
    });
    __recordForTests({
      traceId, agentName: "compliance", epochStart: 1050, totalMs: 40, ttftMs: null, child: true,
      spans: [{ name: "policy check", cat: "tool", start: 0, dur: 40, ok: true }],
    });

    const text = mergedLabText(traceId)!;
    const lines = text.split("\n");

    // structure: @orchestrator (plan) → children (parallel) → @orchestrator·join (write)
    expect(lines[0]).toBe("@orchestrator");
    expect(lines[1]).toContain("plan");
    expect(lines.some((l) => l === "@research (parallel)")).toBe(true);
    expect(lines.some((l) => l === "@compliance (parallel)")).toBe(true);
    expect(lines.some((l) => l === "@orchestrator·join")).toBe(true);
    expect(lines[lines.length - 1]).toContain("write");
  });

  it("does not mark a lone child as parallel when it doesn't overlap another child", () => {
    const traceId = "t3";
    __recordForTests({
      traceId, agentName: "orchestrator", epochStart: 1000, totalMs: 100, ttftMs: null, child: false,
      spans: [{ name: "plan", cat: "orch", start: 0, dur: 20, ok: true }],
    });
    __recordForTests({
      traceId, agentName: "single-worker", epochStart: 1020, totalMs: 80, ttftMs: null, child: true,
      spans: [{ name: "work", cat: "tool", start: 0, dur: 80, ok: true }],
    });
    const text = mergedLabText(traceId)!;
    expect(text).toContain("@single-worker");
    expect(text).not.toContain("@single-worker (parallel)");
  });
});

// --------------------------------------------------------------------------
// OTLP export shape
// --------------------------------------------------------------------------

describe("toOtlp", () => {
  it("returns null for an unregistered traceId", () => {
    expect(toOtlp("nope")).toBeNull();
  });

  it("converts a registered trace into a well-formed OTLP payload with cost and RAG attributes", () => {
    __recordForTests({
      traceId: "otlp-1", agentName: "triage", epochStart: Date.now(), totalMs: 200, ttftMs: null, child: false,
      spans: [
        { name: "llm call", cat: "llm", start: 0, dur: 100, ok: true, attrs: { model: "claude-haiku-4", input_tokens: 1000, output_tokens: 100 } },
        { name: "search", cat: "retr", start: 100, dur: 50, ok: true, attrs: { retrieved_ids: ["a"], relevant_ids: ["a"], k: 5 } },
        { name: "failed call", cat: "tool", start: 150, dur: 50, ok: false },
      ],
    });
    const payload = toOtlp("otlp-1")!;
    const spans = payload.resourceSpans[0].scopeSpans[0].spans;
    expect(spans).toHaveLength(3);

    const llmSpan = spans.find((s: any) => s.name === "llm call")!;
    const keys = llmSpan.attributes.map((a: any) => a.key);
    expect(keys).toContain("llm.model");
    expect(keys).toContain("llm.cost.usd");
    expect(llmSpan.status.code).toBe(1); // OK

    const ragSpan = spans.find((s: any) => s.name === "search")!;
    expect(ragSpan.attributes.map((a: any) => a.key)).toContain("rag.recall_at_k");

    const failedSpan = spans.find((s: any) => s.name === "failed call")!;
    expect(failedSpan.status.code).toBe(2); // ERROR

    expect(payload.resourceSpans[0].resource.attributes[0].value.stringValue).toBe("triage");
  });
});

// --------------------------------------------------------------------------
// SLO alert history
// --------------------------------------------------------------------------

describe("recentAlerts", () => {
  it("starts empty after a reset", () => {
    expect(recentAlerts()).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// latencyStats on an empty registry
// --------------------------------------------------------------------------

describe("latencyStats", () => {
  it("handles an empty registry without throwing", () => {
    const stats = latencyStats();
    expect(stats.sample_size).toBe(0);
    expect(stats.p50_ms).toBe(0);
    expect(stats.last_trace_id).toBeNull();
    expect(stats.rag).toBeNull();
  });

  it("computes percentiles and cost rollups across registered traces", () => {
    for (const totalMs of [100, 200, 300, 400, 5000]) {
      __recordForTests({
        traceId: `trace-${totalMs}`, agentName: "agent", epochStart: Date.now(), totalMs, ttftMs: totalMs / 4, child: false,
        spans: [{ name: "llm", cat: "llm", start: 0, dur: totalMs, ok: true, attrs: { model: "claude-haiku-4", input_tokens: 100, output_tokens: 10 } }],
      });
    }
    const stats = latencyStats();
    expect(stats.sample_size).toBe(5);
    expect(stats.p50_ms).toBe(300);
    expect(stats.p99_ms).toBe(5000);
    expect(stats.total_tokens).toBe(5 * 110);
    expect(stats.cost_per_request_p50_usd).toBeGreaterThan(0);
    expect(stats.last_trace_id).toBe("trace-5000");
  });
});

// --------------------------------------------------------------------------
// debugAuth middleware
// --------------------------------------------------------------------------

describe("debugAuth", () => {
  it("allows all requests through when no token or allowlist is configured", () => {
    const mw = debugAuth();
    const { req, res, statusCode } = fakeReqRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  it("rejects requests with no Authorization header when a token is required", () => {
    const mw = debugAuth({ token: "secret" });
    const { req, res } = fakeReqRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
  });

  it("rejects an incorrect bearer token", () => {
    const mw = debugAuth({ token: "secret" });
    const { req, res } = fakeReqRes({ authorization: "Bearer wrong" });
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
  });

  it("accepts the correct bearer token", () => {
    const mw = debugAuth({ token: "secret" });
    const { req, res } = fakeReqRes({ authorization: "Bearer secret" });
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  it("allows a request from an allowlisted IP without a token", () => {
    const mw = debugAuth({ allowIps: ["10.0.0.5"] });
    const { req, res } = fakeReqRes({ "x-forwarded-for": "10.0.0.5" });
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  it("rejects an IP not on the allowlist", () => {
    const mw = debugAuth({ allowIps: ["10.0.0.5"] });
    const { req, res } = fakeReqRes({ "x-forwarded-for": "10.0.0.9" });
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
  });
});
