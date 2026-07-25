/**
 * latency-trace.ts — distributed span instrumentation for multi-agent systems
 * ----------------------------------------------------------------------------
 * Zero-dependency tracer + Express middleware. Times each stage of an agent
 * request and emits traces in the Agent Latency Lab's paste format — including
 * multi-agent `@lane` swim-lanes stitched across services via W3C
 * `traceparent` context propagation.
 *
 * Single agent:
 *
 *   app.use(latencyTrace({ agent: "triage" }));
 *   await req.trace!.span("pgvector policy_chunks", "retr", () => ...);
 *
 * Multi-agent (NexusAgent-style orchestrator → sub-agents):
 *
 *   // orchestrator: propagate context on every sub-agent call
 *   await fetch(researchUrl, { headers: req.trace!.headersFor("research"), ... });
 *
 *   // sub-agent service: same middleware; it adopts the incoming traceId
 *   app.use(latencyTrace({ agent: "sub-agent", reportTo: ORCHESTRATOR_URL + "/debug/trace-report" }));
 *
 *   // orchestrator: receive remote lanes
 *   app.post("/debug/trace-report", express.json(), traceReportHandler);
 *
 * When the root request finishes, the orchestrator logs one merged block:
 *
 *   [latency] trace 4f2a… — 5 agents, 5131ms end-to-end
 *   @orchestrator
 *   intent classification (qwen), llm, 421
 *   @research (parallel)
 *   enterprise search api, tool, 1349
 *   ...
 *
 * …which pastes directly into the Lab's multi-agent mode. Sub-agents running
 * in the *same process* (separate routes) merge automatically with no
 * reportTo needed — the shared in-memory registry stitches them by traceId.
 *
 * Clock note: lanes are aligned by each process's Date.now() at request
 * start. Same-host agents align to <1ms; cross-host lanes inherit whatever
 * clock skew exists between machines (NTP-synced hosts are typically fine).
 */

import { performance } from "node:perf_hooks";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SpanCategory = "llm" | "retr" | "tool" | "orch";

/** Optional attributes attached to a span for token/cost/RAG accounting. */
export interface SpanAttrs {
  // LLM spans
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;        // computed from model pricing if omitted
  // retrieval spans — pass the retrieved doc ids and the known-relevant ids
  // and precision@k / recall@k / MRR are computed for you
  retrieved_ids?: string[];
  relevant_ids?: string[];
  k?: number;               // cutoff for precision@k / recall@k (default 5)
}

export interface Span {
  name: string;
  cat: SpanCategory;
  /** ms offset from the start of this agent's request */
  start: number;
  /** ms duration */
  dur: number;
  ok: boolean;
  attrs?: SpanAttrs;
}

export interface TraceEvent {
  name: string;
  at: number;
}

/** Uniform shape for local tracers and traces reported by remote agents. */
export interface TraceRecord {
  traceId: string;
  agentName: string;
  /** Date.now() at request start — used to align lanes across services */
  epochStart: number;
  totalMs: number;
  ttftMs: number | null;
  /** true when this trace had an upstream parent (i.e. it's a sub-agent) */
  child: boolean;
  spans: Span[];
}

// Make req.trace visible to TypeScript when @types/express is installed.
declare global {
  namespace Express {
    interface Request {
      trace?: Tracer;
    }
  }
}

// Minimal structural types so this compiles with or without @types/express.
interface Req {
  trace?: Tracer;
  method?: string;
  path?: string;
  originalUrl?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}
interface Res {
  on(event: string, cb: () => void): void;
  json?: (body: unknown) => void;
  setHeader?: (k: string, v: string) => void;
  end?: (body?: string) => void;
  status?: (code: number) => Res;
  statusCode?: number;
}
type Next = () => void;

// ---------------------------------------------------------------------------
// W3C traceparent helpers
// ---------------------------------------------------------------------------

const newTraceId = () => randomBytes(16).toString("hex");
const newSpanId = () => randomBytes(8).toString("hex");

/** Parse `00-{trace-id}-{parent-span-id}-{flags}`. */
export function parseTraceparent(header: unknown): { traceId: string; spanId: string } | null {
  if (typeof header !== "string") return null;
  const m = header.trim().match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i);
  return m ? { traceId: m[1].toLowerCase(), spanId: m[2].toLowerCase() } : null;
}

// ---------------------------------------------------------------------------
// Pricing + token/cost/RAG accounting
// ---------------------------------------------------------------------------

/** USD per 1M tokens: [input, output]. Update as prices change. */
export const PRICING: Record<string, [number, number]> = {
  // Anthropic
  "claude-opus-4": [15, 75],
  "claude-sonnet-4": [3, 15],
  "claude-haiku-4": [0.8, 4],
  "claude-3-5-haiku": [0.8, 4],
  // Groq (OSS models — cheap, matches NexusAgent qwen/llama)
  "qwen": [0.2, 0.2],
  "qwen-2.5-32b": [0.2, 0.2],
  "llama-3.3-70b": [0.59, 0.79],
  "llama-3.1-8b": [0.05, 0.08],
};

/** Fuzzy match a model name to the pricing table (substring, case-insensitive). */
export function priceFor(model?: string): [number, number] | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (PRICING[m]) return PRICING[m];
  for (const key of Object.keys(PRICING)) if (m.includes(key)) return PRICING[key];
  return null;
}

export function computeCost(attrs?: SpanAttrs): number {
  if (!attrs) return 0;
  if (typeof attrs.cost_usd === "number") return attrs.cost_usd;
  const price = priceFor(attrs.model);
  if (!price) return 0;
  const inTok = attrs.input_tokens ?? 0, outTok = attrs.output_tokens ?? 0;
  return (inTok * price[0] + outTok * price[1]) / 1_000_000;
}

export interface RagMetrics {
  k: number;
  precision_at_k: number;
  recall_at_k: number;
  mrr: number;             // reciprocal rank of the first relevant hit
}

/** Deterministic retrieval-quality metrics from retrieved + relevant id sets. */
export function ragMetrics(attrs?: SpanAttrs): RagMetrics | null {
  if (!attrs?.retrieved_ids || !attrs.relevant_ids) return null;
  const k = attrs.k ?? 5;
  const topK = attrs.retrieved_ids.slice(0, k);
  const relevant = new Set(attrs.relevant_ids);
  const hits = topK.filter((id) => relevant.has(id)).length;
  const precision = topK.length ? hits / topK.length : 0;
  const recall = relevant.size ? hits / relevant.size : 0;
  let mrr = 0;
  for (let i = 0; i < attrs.retrieved_ids.length; i++) {
    if (relevant.has(attrs.retrieved_ids[i])) { mrr = 1 / (i + 1); break; }
  }
  return { k, precision_at_k: precision, recall_at_k: recall, mrr };
}

/** Aggregate token/cost/RAG rollups across a set of spans. */
export function accounting(spans: Span[]) {
  let inTok = 0, outTok = 0, cost = 0;
  const byModel: Record<string, { in: number; out: number; cost: number; calls: number }> = {};
  const rag: RagMetrics[] = [];
  for (const s of spans) {
    const a = s.attrs;
    if (!a) continue;
    if (a.input_tokens || a.output_tokens || a.model) {
      const it = a.input_tokens ?? 0, ot = a.output_tokens ?? 0, c = computeCost(a);
      inTok += it; outTok += ot; cost += c;
      const key = a.model ?? "unknown";
      byModel[key] = byModel[key] ?? { in: 0, out: 0, cost: 0, calls: 0 };
      byModel[key].in += it; byModel[key].out += ot; byModel[key].cost += c; byModel[key].calls += 1;
    }
    const rm = ragMetrics(a);
    if (rm) rag.push(rm);
  }
  const avg = (f: (m: RagMetrics) => number) => (rag.length ? rag.reduce((x, m) => x + f(m), 0) / rag.length : 0);
  return {
    input_tokens: inTok,
    output_tokens: outTok,
    total_tokens: inTok + outTok,
    cost_usd: cost,
    by_model: byModel,
    rag: rag.length
      ? { k: rag[0].k, precision_at_k: avg((m) => m.precision_at_k), recall_at_k: avg((m) => m.recall_at_k), mrr: avg((m) => m.mrr), samples: rag.length }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------

export interface TracerContext {
  traceId?: string;
  parentSpanId?: string;
  agentName?: string;
}

export class Tracer {
  readonly spans: Span[] = [];
  readonly events: TraceEvent[] = [];
  readonly startedAt = performance.now();
  readonly epochStart = Date.now();
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly agentName: string;
  private closedAt: number | null = null;
  label: string;

  constructor(label = "request", ctx: TracerContext = {}) {
    this.label = label;
    this.traceId = ctx.traceId ?? newTraceId();
    this.spanId = newSpanId();
    this.parentSpanId = ctx.parentSpanId ?? null;
    this.agentName = ctx.agentName ?? "agent";
  }

  /** true when this request was invoked by an upstream agent */
  get isChild(): boolean {
    return this.parentSpanId !== null;
  }

  /** Wrap any async (or sync) stage in a timed span. Rethrows errors.
   *  Pass `attrs` for token/cost/RAG accounting, or return them from `fn`
   *  via `trace.setAttrs()` inside the callback once the LLM response is known. */
  async span<T>(name: string, cat: SpanCategory, fn: () => T | Promise<T>, attrs?: SpanAttrs): Promise<T> {
    const start = performance.now() - this.startedAt;
    this._pending = {};
    try {
      const result = await fn();
      this.spans.push({ name, cat, start, dur: performance.now() - this.startedAt - start, ok: true, attrs: this.mergeAttrs(attrs) });
      return result;
    } catch (err) {
      this.spans.push({ name, cat, start, dur: performance.now() - this.startedAt - start, ok: false, attrs: this.mergeAttrs(attrs) });
      throw err;
    } finally {
      this._pending = null;
    }
  }

  private _pending: SpanAttrs | null = null;
  /** Inside a span callback, attach attrs discovered mid-flight (e.g. token
   *  counts from the LLM response): `trace.setAttrs({ model, input_tokens, output_tokens })`. */
  setAttrs(attrs: SpanAttrs): void {
    if (this._pending) Object.assign(this._pending, attrs);
  }
  private mergeAttrs(attrs?: SpanAttrs): SpanAttrs | undefined {
    const merged = { ...(this._pending ?? {}), ...(attrs ?? {}) };
    return Object.keys(merged).length ? merged : undefined;
  }

  /** Manual span control for stages that don't fit a callback (e.g. streams).
   *  Call the returned function to end the span; pass `false` to mark it failed. */
  startSpan(name: string, cat: SpanCategory): (ok?: boolean, attrs?: SpanAttrs) => void {
    const start = performance.now() - this.startedAt;
    let done = false;
    return (ok = true, attrs?: SpanAttrs) => {
      if (done) return;
      done = true;
      this.spans.push({ name, cat, start, dur: performance.now() - this.startedAt - start, ok, attrs });
    };
  }

  /** Point-in-time marker. `trace.event('first_token')` captures TTFT. */
  event(name: string): void {
    this.events.push({ name, at: performance.now() - this.startedAt });
  }

  /**
   * Outbound propagation headers for a sub-agent call:
   *
   *   fetch(url, { headers: { ...trace.headersFor("research"), "Content-Type": "application/json" } })
   *
   * The sub-agent's middleware adopts this traceId, names its lane after
   * `childAgentName`, and its trace stitches into the merged view.
   */
  headersFor(childAgentName?: string): Record<string, string> {
    const h: Record<string, string> = { traceparent: `00-${this.traceId}-${newSpanId()}-01` };
    if (childAgentName) h["x-trace-agent"] = childAgentName;
    return h;
  }

  close(): void {
    if (this.closedAt === null) this.closedAt = performance.now();
  }

  get totalMs(): number {
    return (this.closedAt ?? performance.now()) - this.startedAt;
  }

  get ttftMs(): number | null {
    const e = this.events.find((ev) => ev.name === "first_token");
    return e ? e.at : null;
  }

  toRecord(): TraceRecord {
    return {
      traceId: this.traceId,
      agentName: this.agentName,
      epochStart: this.epochStart,
      totalMs: this.totalMs,
      ttftMs: this.ttftMs,
      child: this.isChild,
      spans: [...this.spans],
    };
  }

  toLabText(): string {
    return spansToLabLines(this.spans).join("\n");
  }

  toJSON() {
    const r = this.toRecord();
    return {
      trace_id: r.traceId,
      agent: r.agentName,
      epoch_start_ms: r.epochStart,
      total_ms: Math.round(r.totalMs),
      ttft_ms: r.ttftMs === null ? null : Math.round(r.ttftMs),
      child: r.child,
      accounting: accounting(r.spans),
      spans: r.spans.map((s) => ({
        name: s.name, cat: s.cat, start_ms: Math.round(s.start), dur: Math.round(s.dur), ok: s.ok,
        ...(s.attrs ? { attrs: s.attrs, cost_usd: computeCost(s.attrs), rag: ragMetrics(s.attrs) } : {}),
      })),
      events: this.events.map((e) => ({ name: e.name, at_ms: Math.round(e.at) })),
    };
  }
}

/** Lab-format span lines; overlapping spans get the `|` parallel prefix. */
function spansToLabLines(spans: Span[]): string[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const lines: string[] = [];
  let prevEnd = -Infinity;
  for (const s of sorted) {
    const parallel = s.start < prevEnd - 1; // 1 ms epsilon
    lines.push(`${parallel ? "| " : ""}${s.name}${s.ok ? "" : " (failed)"}, ${s.cat}, ${Math.round(s.dur)}`);
    prevEnd = Math.max(prevEnd, s.start + s.dur);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Registry: recent traces + traceId → participating agents
// ---------------------------------------------------------------------------

const RING_SIZE = 200;
const recentRoots: TraceRecord[] = [];
const byTraceId = new Map<string, TraceRecord[]>();
const traceIdOrder: string[] = [];

/** Test-only: clear all in-memory state (registry, alert history, cooldowns).
 *  Not meant for production use — the ring buffer is expected to persist
 *  for the life of the process. */
export function __resetForTests(): void {
  recentRoots.length = 0;
  byTraceId.clear();
  traceIdOrder.length = 0;
  alertHistory.length = 0;
  lastFired.clear();
}

/** Test-only: register a TraceRecord directly, bypassing the middleware.
 *  Lets tests exercise mergedLabText/latencyStats/toOtlp without a live
 *  HTTP request cycle. */
export function __recordForTests(rec: TraceRecord): void {
  record(rec);
}

function record(rec: TraceRecord): void {
  if (!rec.child) {
    recentRoots.push(rec);
    if (recentRoots.length > RING_SIZE) recentRoots.shift();
  }
  let group = byTraceId.get(rec.traceId);
  if (!group) {
    group = [];
    byTraceId.set(rec.traceId, group);
    traceIdOrder.push(rec.traceId);
    if (traceIdOrder.length > RING_SIZE) {
      const evicted = traceIdOrder.shift()!;
      byTraceId.delete(evicted);
    }
  }
  group.push(rec);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/**
 * Merge every agent that participated in a traceId into one multi-agent
 * Lab-format block. Lanes are ordered by wall-clock start; a lane whose
 * window overlaps the previous lane's window is marked `(parallel)`.
 */
export function mergedLabText(traceId: string): string | null {
  const group = byTraceId.get(traceId);
  if (!group || group.length === 0) return null;
  if (group.length === 1) return spansToLabLines(group[0].spans).join("\n");

  const roots = group.filter((r) => !r.child);
  const children = group.filter((r) => r.child).sort((a, b) => a.epochStart - b.epochStart);

  // Structured case — one root that forked sub-agents: split the root's lane
  // at the fork so the Lab's fork/join layout reproduces the real timeline
  // (plan → parallel children → join → write) instead of running the children
  // parallel to the root's post-join spans.
  if (roots.length === 1 && children.length > 0) {
    const root = roots[0];
    const forkAt = Math.min(...children.map((c) => c.epochStart)) - root.epochStart;
    const before = root.spans.filter((s) => s.start < forkAt - 1);
    const after = root.spans.filter((s) => s.start >= forkAt - 1);

    const lines: string[] = [];
    if (before.length) {
      lines.push(`@${root.agentName}`);
      lines.push(...spansToLabLines(before));
    }
    // Group children into runs of overlapping windows. The Lab's fork/join
    // convention marks EVERY lane in a fork group (parallel), so a run of
    // two or more overlapping children gets the marker on all of them.
    type Run = { members: TraceRecord[]; end: number };
    const runs: Run[] = [];
    children.forEach((c) => {
      const start = c.epochStart - root.epochStart;
      const end = start + c.totalMs;
      const last = runs[runs.length - 1];
      if (last && start < last.end - 1) { last.members.push(c); last.end = Math.max(last.end, end); }
      else runs.push({ members: [c], end });
    });
    runs.forEach((run) => {
      run.members.forEach((c) => {
        lines.push(`@${c.agentName}${run.members.length > 1 ? " (parallel)" : ""}`);
        lines.push(...spansToLabLines(c.spans));
      });
    });
    if (after.length) {
      lines.push(`@${root.agentName}·join`);
      lines.push(...spansToLabLines(after));
    }
    return lines.join("\n");
  }

  // Fallback — no clear root (or several): order lanes by wall-clock start
  // and mark overlapping windows (parallel).
  const sorted = [...group].sort((a, b) => a.epochStart - b.epochStart);
  const base = sorted[0].epochStart;
  const lines: string[] = [];
  let prevWindowEnd = -Infinity;
  for (const rec of sorted) {
    const start = rec.epochStart - base;
    const end = start + rec.totalMs;
    const parallel = start < prevWindowEnd - 1;
    lines.push(`@${rec.agentName}${parallel ? " (parallel)" : ""}`);
    lines.push(...spansToLabLines(rec.spans));
    prevWindowEnd = Math.max(prevWindowEnd, end);
  }
  return lines.join("\n");
}

export function latencyStats() {
  const totals = recentRoots.map((t) => t.totalMs);
  const ttfts = recentRoots.map((t) => t.ttftMs).filter((v): v is number => v !== null);
  const last = recentRoots[recentRoots.length - 1];
  const lastGroup = last ? byTraceId.get(last.traceId) ?? [] : [];

  // token/cost/RAG rollups. Per-request cost uses ALL spans in each trace's
  // group (root + child agents), so multi-agent cost is attributed correctly.
  const perRequestCost: number[] = [];
  let totalCost = 0, totalTokens = 0;
  const ragAgg: RagMetrics[] = [];
  for (const root of recentRoots) {
    const group = byTraceId.get(root.traceId) ?? [root];
    const allSpans = group.flatMap((r) => r.spans);
    const acc = accounting(allSpans);
    perRequestCost.push(acc.cost_usd);
    totalCost += acc.cost_usd;
    totalTokens += acc.total_tokens;
    if (acc.rag) ragAgg.push({ k: acc.rag.k, precision_at_k: acc.rag.precision_at_k, recall_at_k: acc.rag.recall_at_k, mrr: acc.rag.mrr });
  }
  const lastAcc = last ? accounting(lastGroup.flatMap((r) => r.spans)) : null;
  const avgRag = (f: (m: RagMetrics) => number) => (ragAgg.length ? ragAgg.reduce((x, m) => x + f(m), 0) / ragAgg.length : 0);

  return {
    sample_size: totals.length,
    p50_ms: Math.round(percentile(totals, 50)),
    p95_ms: Math.round(percentile(totals, 95)),
    p99_ms: Math.round(percentile(totals, 99)),
    ttft_p50_ms: ttfts.length ? Math.round(percentile(ttfts, 50)) : null,
    cost_per_request_p50_usd: perRequestCost.length ? percentile(perRequestCost, 50) : 0,
    cost_per_request_p95_usd: perRequestCost.length ? percentile(perRequestCost, 95) : 0,
    total_cost_usd: totalCost,
    total_tokens: totalTokens,
    rag: ragAgg.length ? { k: ragAgg[0].k, precision_at_k: avgRag((m) => m.precision_at_k), recall_at_k: avgRag((m) => m.recall_at_k), mrr: avgRag((m) => m.mrr), samples: ragAgg.length } : null,
    last_trace_id: last ? last.traceId : null,
    last_trace_agents: lastGroup.map((r) => r.agentName),
    last_trace_accounting: lastAcc,
    last_trace_lab_format: last ? mergedLabText(last.traceId) : null,
  };
}

// ---------------------------------------------------------------------------
// OpenTelemetry / OTLP export (spans → Jaeger, Tempo, any OTLP backend)
// ---------------------------------------------------------------------------

const HEX = "0123456789abcdef";
const randHex = (n: number) => Array.from({ length: n }, () => HEX[(Math.random() * 16) | 0]).join("");

/** SpanKind + status per the OTLP spec (INTERNAL / OK). */
function toOtlpSpan(traceId: string, s: Span, epochStartMs: number) {
  const startNano = String(Math.round((epochStartMs + s.start) * 1e6));
  const endNano = String(Math.round((epochStartMs + s.start + s.dur) * 1e6));
  const attributes: Array<{ key: string; value: Record<string, unknown> }> = [
    { key: "agent.category", value: { stringValue: s.cat } },
  ];
  const a = s.attrs;
  if (a) {
    if (a.model) attributes.push({ key: "llm.model", value: { stringValue: a.model } });
    if (a.input_tokens != null) attributes.push({ key: "llm.tokens.input", value: { intValue: a.input_tokens } });
    if (a.output_tokens != null) attributes.push({ key: "llm.tokens.output", value: { intValue: a.output_tokens } });
    const cost = computeCost(a);
    if (cost) attributes.push({ key: "llm.cost.usd", value: { doubleValue: cost } });
    const rm = ragMetrics(a);
    if (rm) {
      attributes.push({ key: "rag.precision_at_k", value: { doubleValue: rm.precision_at_k } });
      attributes.push({ key: "rag.recall_at_k", value: { doubleValue: rm.recall_at_k } });
      attributes.push({ key: "rag.mrr", value: { doubleValue: rm.mrr } });
    }
  }
  return {
    traceId,
    spanId: randHex(16),
    name: s.name,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: startNano,
    endTimeUnixNano: endNano,
    attributes,
    status: { code: s.ok ? 1 : 2 }, // OK / ERROR
  };
}

/** Build an OTLP ExportTraceServiceRequest for one trace group (all agents). */
export function toOtlp(traceId: string) {
  const group = byTraceId.get(traceId);
  if (!group || group.length === 0) return null;
  const scopeSpans = group.map((rec) => ({
    scope: { name: "agent-latency-lab", version: "1.0.0" },
    spans: rec.spans.map((s) => toOtlpSpan(traceId, s, rec.epochStart)),
  }));
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: group[0].agentName || "agent" } }] },
      scopeSpans,
    }],
  };
}

/** POST a trace to an OTLP/HTTP collector (Jaeger/Tempo/OTel Collector).
 *  endpoint e.g. "http://localhost:4318/v1/traces". Fire-and-forget. */
export async function exportOtlp(traceId: string, endpoint: string): Promise<boolean> {
  const payload = toOtlp(traceId);
  if (!payload) return false;
  try {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** GET /debug/otlp?id={traceId} — the OTLP JSON for a trace (inspect or curl → collector). */
export function otlpHandler(req: Req, res: Res) {
  const url = req.originalUrl ?? "";
  const id = /[?&]id=([0-9a-f]{32})/i.exec(url)?.[1]?.toLowerCase();
  const payload = id ? toOtlp(id) : (last() ? toOtlp(last()!.traceId) : null);
  sendJson(res, payload ?? { error: "no trace" }, payload ? 200 : 404);
}
function last(): TraceRecord | undefined { return recentRoots[recentRoots.length - 1]; }

// ---------------------------------------------------------------------------
// SLO watcher — evaluates rolling percentiles on every finished root trace,
// fires diagnosis-enriched alerts on breach (console / callback / webhook)
// ---------------------------------------------------------------------------

export interface SloThresholds {
  /** end-to-end percentiles, ms */
  e2e_p50?: number;
  e2e_p95?: number;
  e2e_p99?: number;
  /** median time-to-first-token, ms (requires trace.event("first_token")) */
  ttft_p50?: number;
  /** P95 of individual span durations by category, ms */
  span_llm_p95?: number;
  span_retr_p95?: number;
  span_tool_p95?: number;
}

/** The production targets from the latency playbook. */
export const DEFAULT_SLOS: SloThresholds = {
  e2e_p50: 3000,
  e2e_p95: 7000,
  e2e_p99: 15000,
  ttft_p50: 1000,
  span_retr_p95: 200,
  span_tool_p95: 500,
};

export interface AlertOptions {
  /** POST each alert as JSON to this URL (Slack/Teams relay, PagerDuty, …). */
  webhookUrl?: string;
  /** Programmatic hook — called with every alert. */
  onAlert?: (alert: SloAlert) => void;
  /** Minimum ms between alerts for the same rule. Default 60_000. */
  cooldownMs?: number;
  /** Rolling window of recent root traces to evaluate. Default 50. */
  windowSize?: number;
  /** Don't evaluate until this many traces are in the window. Default 20. */
  minRequests?: number;
  /** Also log alerts to stderr. Default true. */
  log?: boolean;
}

export interface SloAlert {
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
  at: string; // ISO timestamp
}

const FIXES: Record<SpanCategory, string> = {
  tool: "Parallelize independent calls, cache stable responses, and co-locate services — external APIs are frequently the bottleneck, not the LLM.",
  llm: "Route simpler steps to a smaller model, trim the context window, cap reasoning iterations, and stream tokens to cut perceived latency.",
  retr: "Add embedding + vector-result caches, use approximate nearest-neighbor indexes, and batch embedding requests; target <300 ms end-to-end RAG.",
  orch: "Collapse agent hops, reduce serialization round trips, and keep gateway, agents, and data in the same region.",
};

const ALERT_HISTORY_SIZE = 50;
const alertHistory: SloAlert[] = [];
const lastFired = new Map<string, number>();

export function recentAlerts(): SloAlert[] {
  return [...alertHistory].reverse(); // newest first
}

/** Diagnose a set of breaching traces: dominant span category + worst offender. */
function diagnose(traces: TraceRecord[]) {
  const catMs: Record<string, number> = {};
  const spanMs: Record<string, number> = {};
  traces.forEach((t) => t.spans.forEach((s) => {
    catMs[s.cat] = (catMs[s.cat] || 0) + s.dur;
    spanMs[s.name] = (spanMs[s.name] || 0) + s.dur;
  }));
  const totalMs = Object.values(catMs).reduce((a, b) => a + b, 0) || 1;
  const [cat, ms] = Object.entries(catMs).sort((a, b) => b[1] - a[1])[0] ?? ["tool", 0];
  const topSpan = Object.entries(spanMs).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
  const worst = traces.reduce((a, b) => (b.totalMs > a.totalMs ? b : a), traces[0]);
  return {
    cat: cat as SpanCategory,
    sharePct: Math.round((ms / totalMs) * 100),
    topSpan,
    worst,
  };
}

function fire(alert: SloAlert, opts: AlertOptions) {
  alertHistory.push(alert);
  if (alertHistory.length > ALERT_HISTORY_SIZE) alertHistory.shift();
  if (opts.log ?? true) {
    console.warn(
      `\n[SLO ALERT] ${alert.rule} breached: ${Math.round(alert.observed_ms)}ms (target ${alert.threshold_ms}ms) over last ${alert.window_size} requests\n` +
      `  dominant: ${alert.dominant_category} (${alert.dominant_share_pct}%) · top span: ${alert.top_span}\n` +
      `  fix: ${alert.recommendation}\n` +
      `  worst trace ${alert.trace_id.slice(0, 8)}…${alert.worst_trace_lab_format ? "\n" + alert.worst_trace_lab_format : ""}\n`
    );
  }
  try { opts.onAlert?.(alert); } catch { /* never let a hook break the request path */ }
  if (opts.webhookUrl) {
    fetch(opts.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(alert),
    }).catch(() => { /* fire-and-forget */ });
  }
}

function evaluateSlos(slo: SloThresholds, opts: AlertOptions) {
  const windowSize = opts.windowSize ?? 50;
  const minRequests = opts.minRequests ?? 20;
  const cooldownMs = opts.cooldownMs ?? 60_000;
  const window = recentRoots.slice(-windowSize);
  if (window.length < minRequests) return;

  const now = Date.now();
  const ready = (rule: string) => now - (lastFired.get(rule) ?? 0) >= cooldownMs;
  const emit = (rule: string, threshold: number, observed: number, traces: TraceRecord[], forcedCat?: SpanCategory, forcedTopSpan?: string) => {
    if (observed <= threshold || !ready(rule) || traces.length === 0) return;
    lastFired.set(rule, now);
    const d = diagnose(traces);
    const cat = forcedCat ?? d.cat;
    fire({
      rule,
      threshold_ms: threshold,
      observed_ms: Math.round(observed),
      window_size: window.length,
      dominant_category: cat,
      dominant_share_pct: forcedCat ? 100 : d.sharePct,
      top_span: forcedTopSpan ?? d.topSpan,
      recommendation: FIXES[cat],
      trace_id: d.worst.traceId,
      worst_trace_lab_format: mergedLabText(d.worst.traceId),
      at: new Date(now).toISOString(),
    }, opts);
  };

  // end-to-end percentile rules — diagnose only the traces past the threshold
  const totals = window.map((t) => t.totalMs);
  const e2eRules: Array<[string, number | undefined, number]> = [
    ["e2e_p50", slo.e2e_p50, percentile(totals, 50)],
    ["e2e_p95", slo.e2e_p95, percentile(totals, 95)],
    ["e2e_p99", slo.e2e_p99, percentile(totals, 99)],
  ];
  for (const [rule, threshold, observed] of e2eRules) {
    if (threshold === undefined) continue;
    emit(rule, threshold, observed, window.filter((t) => t.totalMs > threshold));
  }

  // TTFT rule
  if (slo.ttft_p50 !== undefined) {
    const withTtft = window.filter((t) => t.ttftMs !== null);
    if (withTtft.length >= Math.min(minRequests, window.length)) {
      const observed = percentile(withTtft.map((t) => t.ttftMs as number), 50);
      emit("ttft_p50", slo.ttft_p50, observed, withTtft.filter((t) => (t.ttftMs as number) > slo.ttft_p50!));
    }
  }

  // per-category span P95 rules
  const catRules: Array<[string, SpanCategory, number | undefined]> = [
    ["span_llm_p95", "llm", slo.span_llm_p95],
    ["span_retr_p95", "retr", slo.span_retr_p95],
    ["span_tool_p95", "tool", slo.span_tool_p95],
  ];
  for (const [rule, cat, threshold] of catRules) {
    if (threshold === undefined) continue;
    const durs: number[] = [];
    let topSpan = "unknown", topDur = -1;
    const offenders: TraceRecord[] = [];
    window.forEach((t) => {
      let hit = false;
      t.spans.forEach((s) => {
        if (s.cat !== cat) return;
        durs.push(s.dur);
        if (s.dur > topDur) { topDur = s.dur; topSpan = s.name; }
        if (s.dur > threshold) hit = true;
      });
      if (hit) offenders.push(t);
    });
    if (durs.length === 0) continue;
    emit(rule, threshold, percentile(durs, 95), offenders, cat, topSpan);
  }
}

/** GET /debug/alerts — recent SLO alerts, newest first. */
export function alertsHandler(_req: Req, res: Res) {
  sendJson(res, { alerts: recentAlerts() });
}

// ---------------------------------------------------------------------------
// Debug-route auth — the /debug/* routes expose request bodies, span names,
// and (with accounting attrs) token/cost data. Unauthenticated in local dev
// is fine; reachable-from-outside is not. This is deliberately minimal
// (bearer token or IP allowlist) rather than a full auth framework, because
// the correct answer for a real deployment is to put these routes behind
// whatever the service already uses (API gateway, internal network, mTLS) —
// this just stops the "forgot to lock it down" default from being open.
// ---------------------------------------------------------------------------

export interface DebugAuthOptions {
  /** Shared-secret bearer token. Requests need `Authorization: Bearer <token>`. */
  token?: string;
  /** Allow these source IPs regardless of token (e.g. "127.0.0.1", "::1"). */
  allowIps?: string[];
  /** Called once per rejected request; defaults to a 401 JSON body. */
  onDenied?: (req: Req, res: Res) => void;
}

function clientIp(req: Req): string {
  const xff = req.headers?.["x-forwarded-for"];
  const first = Array.isArray(xff) ? xff[0] : xff;
  if (first) return first.split(",")[0].trim();
  // Node's http.IncomingMessage exposes socket.remoteAddress; not on our
  // minimal Req type, so read it defensively.
  const anyReq = req as unknown as { socket?: { remoteAddress?: string }; ip?: string };
  return anyReq.ip ?? anyReq.socket?.remoteAddress ?? "";
}

let warnedOpenOnce = false;

/**
 * Gate the /debug/* routes. Mount BEFORE the debug route handlers:
 *
 *   app.use("/debug", debugAuth({ token: process.env.DEBUG_TOKEN }));
 *   app.get("/debug/latency", latencyStatsHandler);
 *
 * With no options, every request is allowed through but a one-time warning
 * is logged — matching "insecure by default, but loudly" rather than
 * silently open. Always set a token (or allowIps) outside local dev.
 */
export function debugAuth(opts: DebugAuthOptions = {}) {
  const hasToken = !!opts.token;
  const hasAllowlist = !!opts.allowIps?.length;
  if (!hasToken && !hasAllowlist && !warnedOpenOnce) {
    warnedOpenOnce = true;
    console.warn(
      "[latency-trace] /debug routes are unauthenticated (no `token` or `allowIps` set on debugAuth()). " +
      "Fine for local dev; set DEBUG_TOKEN before deploying anywhere reachable."
    );
  }

  return (req: Req, res: Res, next: Next) => {
    if (!hasToken && !hasAllowlist) return next(); // open + already warned

    if (hasAllowlist && opts.allowIps!.includes(clientIp(req))) return next();

    if (hasToken) {
      const auth = req.headers?.authorization;
      const header = Array.isArray(auth) ? auth[0] : auth;
      const presented = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
      // constant-time-ish comparison to avoid trivial timing leaks on the token
      if (presented && timingSafeEqual(presented, opts.token!)) return next();
    }

    if (opts.onDenied) return opts.onDenied(req, res);
    sendJson(res, { error: "unauthorized" }, 401);
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------

export interface LatencyTraceOptions {
  /** Lane name for this service's traces. Default: "agent".
   *  An incoming `x-trace-agent` header (set by the caller via headersFor)
   *  overrides it, letting the orchestrator name its sub-agents. */
  agent?: string;
  /** Log finished root traces to stdout. Default: true outside production. */
  log?: boolean;
  /** Also log child (sub-agent) traces individually. Default: false. */
  logChildren?: boolean;
  /** Skip tracing for matching paths (health checks, static assets). */
  ignore?: (path: string) => boolean;
  /** For sub-agents running in a SEPARATE process: URL of the orchestrator's
   *  trace-report endpoint. Child traces are POSTed there on finish so the
   *  root can produce the merged view. Same-process agents don't need this. */
  reportTo?: string;
  /** SLO thresholds to watch. Pass `true` for DEFAULT_SLOS (the playbook
   *  targets) or an object to customize. Omit to disable the watcher. */
  slo?: true | SloThresholds;
  /** Alert delivery + windowing for the SLO watcher. */
  alerts?: AlertOptions;
}

export function latencyTrace(opts: LatencyTraceOptions = {}) {
  const log = opts.log ?? process.env.NODE_ENV !== "production";
  const sloThresholds = opts.slo === true ? DEFAULT_SLOS : opts.slo;
  return (req: Req, res: Res, next: Next) => {
    const path = req.originalUrl ?? req.path ?? "";
    if (opts.ignore && opts.ignore(path)) return next();

    const header = (k: string) => {
      const v = req.headers?.[k];
      return Array.isArray(v) ? v[0] : v;
    };
    const incoming = parseTraceparent(header("traceparent"));
    const agentName = header("x-trace-agent") || opts.agent || "agent";

    const trace = new Tracer(`${req.method ?? "GET"} ${path}`, {
      traceId: incoming?.traceId,
      parentSpanId: incoming?.spanId,
      agentName,
    });
    req.trace = trace;

    res.on("finish", () => {
      trace.close();
      if (trace.spans.length === 0) return;
      record(trace.toRecord());

      // SLO watcher — root traces only (children are fragments of a root)
      if (sloThresholds && !trace.isChild) {
        evaluateSlos(sloThresholds, opts.alerts ?? {});
      }

      // remote sub-agent → report back to the orchestrator's collector
      if (trace.isChild && opts.reportTo) {
        fetch(opts.reportTo, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(trace.toJSON()),
        }).catch(() => { /* fire-and-forget; never fail the request path */ });
      }

      if (!log) return;
      if (trace.isChild) {
        if (opts.logChildren) {
          console.log(`[latency] (child ${trace.agentName}) ${trace.label} — ${Math.round(trace.totalMs)}ms\n` + trace.toLabText() + "\n");
        }
        return;
      }
      const group = byTraceId.get(trace.traceId) ?? [];
      const ttft = trace.ttftMs !== null ? ` · TTFT ${Math.round(trace.ttftMs)}ms` : "";
      if (group.length > 1) {
        console.log(
          `\n[latency] trace ${trace.traceId.slice(0, 8)}… — ${group.length} agents, ${Math.round(trace.totalMs)}ms end-to-end${ttft}\n` +
          mergedLabText(trace.traceId) +
          "\n"
        );
      } else {
        console.log(`\n[latency] ${trace.label} — ${Math.round(trace.totalMs)}ms total${ttft}\n` + trace.toLabText() + "\n");
      }
    });

    next();
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** GET /debug/latency — rolling percentiles + last trace (merged if multi-agent). */
export function latencyStatsHandler(_req: Req, res: Res) {
  sendJson(res, latencyStats());
}

/** GET /debug/latency/trace?id={traceId} — merged Lab-format block for one trace. */
export function mergedTraceHandler(req: Req, res: Res) {
  const url = req.originalUrl ?? "";
  const id = /[?&]id=([0-9a-f]{32})/i.exec(url)?.[1]?.toLowerCase();
  const text = id ? mergedLabText(id) : null;
  sendJson(res, text ? { trace_id: id, lab_format: text } : { error: "trace not found" }, text ? 200 : 404);
}

/** POST /debug/trace-report — collector for sub-agents in other processes.
 *  Mount with a JSON body parser: app.post(path, express.json(), traceReportHandler) */
export function traceReportHandler(req: Req, res: Res) {
  const b = req.body as Record<string, unknown> | undefined;
  const spans = Array.isArray(b?.spans) ? (b!.spans as Record<string, unknown>[]) : null;
  if (!b || typeof b.trace_id !== "string" || !spans) {
    sendJson(res, { error: "expected Tracer JSON: { trace_id, agent, epoch_start_ms, total_ms, spans }" }, 400);
    return;
  }
  record({
    traceId: b.trace_id,
    agentName: typeof b.agent === "string" ? b.agent : "remote-agent",
    epochStart: Number(b.epoch_start_ms) || Date.now(),
    totalMs: Number(b.total_ms) || 0,
    ttftMs: typeof b.ttft_ms === "number" ? b.ttft_ms : null,
    child: true,
    spans: spans.map((s) => ({
      name: String(s.name ?? "span"),
      cat: (["llm", "retr", "tool", "orch"].includes(s.cat as string) ? s.cat : "tool") as SpanCategory,
      start: Number(s.start_ms) || 0,
      dur: Number(s.dur) || 0,
      ok: s.ok !== false,
      attrs: (s.attrs && typeof s.attrs === "object") ? (s.attrs as SpanAttrs) : undefined,
    })),
  });
  sendJson(res, { ok: true }, 202);
}

function sendJson(res: Res, body: unknown, code = 200) {
  if (res.status) res.status(code);
  else if (res.statusCode !== undefined) res.statusCode = code;
  if (res.json) res.json(body);
  else {
    res.setHeader?.("Content-Type", "application/json");
    res.end?.(JSON.stringify(body, null, 2));
  }
}
