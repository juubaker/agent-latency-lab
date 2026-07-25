import { useEffect, useMemo, useState } from "react";

// ---------------------------------------------------------------- design tokens
const T = {
  bg: "#10141F",
  panel: "#181E2E",
  panelSoft: "#1C2336",
  line: "#28314B",
  text: "#E8ECF6",
  muted: "#8A94AD",
  faint: "#5C6683",
  llm: "#F2A65A",
  retr: "#4FC1B0",
  tool: "#7C93F2",
  orch: "#9AA4C0",
  cache: "#58B97E",
  bad: "#E5646E",
  good: "#58B97E",
};
const CAT_COLOR = { llm: T.llm, retr: T.retr, tool: T.tool, orch: T.orch, cache: T.cache };
const CAT_LABEL = { llm: "LLM", retr: "Retrieval", tool: "Tool / API", orch: "Orchestration", cache: "Cache hit" };

// ---------------------------------------------------------------- rng + stats
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(ms >= 10000 ? 1 : 2) + " s" : Math.round(ms) + " ms");

// ---------------------------------------------------------------- trace parsing (custom mode)
function inferCat(name) {
  const n = name.toLowerCase();
  if (/(llm|plan|model|claude|gpt|haiku|sonnet|opus|groq|qwen|llama|reason|reflect|summar|classif|generat|synthes|assess)/.test(n)) return "llm";
  if (/(vector|embed|pgvector|retriev|rag|rerank|chunk|semantic)/.test(n)) return "retr";
  if (/(api|tool|db|sql|postgres|query|http|fetch|calc|lookup|drizzle|redis|search|registry|audit|policy)/.test(n)) return "tool";
  return "orch";
}
const parseDur = (tok) => {
  const m = String(tok).trim().match(/^([\d.]+)\s*(ms|s)?$/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return (m[2] || "ms").toLowerCase() === "s" ? v * 1000 : v;
};
const CATS = ["llm", "retr", "tool", "orch"];

// USD per 1M tokens: [input, output]
const PRICING = {
  "claude-opus-4": [15, 75], "claude-sonnet-4": [3, 15], "claude-haiku-4": [0.8, 4],
  "claude-3-5-haiku": [0.8, 4], "qwen": [0.2, 0.2], "qwen-2.5-32b": [0.2, 0.2],
  "llama-3.3-70b": [0.59, 0.79], "llama-3.1-8b": [0.05, 0.08],
};
function priceFor(model) {
  if (!model) return null;
  const m = model.toLowerCase();
  if (PRICING[m]) return PRICING[m];
  for (const k of Object.keys(PRICING)) if (m.includes(k)) return PRICING[k];
  return null;
}
function costOf(attrs) {
  if (!attrs) return 0;
  if (typeof attrs.cost_usd === "number") return attrs.cost_usd;
  const p = priceFor(attrs.model);
  if (!p) return 0;
  return ((attrs.input_tokens || 0) * p[0] + (attrs.output_tokens || 0) * p[1]) / 1e6;
}
function ragOf(attrs) {
  if (!attrs || !attrs.retrieved_ids || !attrs.relevant_ids) return null;
  const k = attrs.k || 5;
  const topK = attrs.retrieved_ids.slice(0, k);
  const rel = new Set(attrs.relevant_ids);
  const hits = topK.filter((id) => rel.has(id)).length;
  let mrr = 0;
  for (let i = 0; i < attrs.retrieved_ids.length; i++) if (rel.has(attrs.retrieved_ids[i])) { mrr = 1 / (i + 1); break; }
  return { k, precision: topK.length ? hits / topK.length : 0, recall: rel.size ? hits / rel.size : 0, mrr };
}
// roll up cost/tokens/rag across a representative trace's spans
function accountOf(spans) {
  let inTok = 0, outTok = 0, cost = 0;
  const byModel = {};
  const rag = [];
  spans.forEach((s) => {
    const a = s.attrs;
    if (!a) return;
    if (a.input_tokens || a.output_tokens || a.model) {
      const it = a.input_tokens || 0, ot = a.output_tokens || 0, c = costOf(a);
      inTok += it; outTok += ot; cost += c;
      const key = a.model || "unknown";
      byModel[key] = byModel[key] || { in: 0, out: 0, cost: 0, calls: 0 };
      byModel[key].in += it; byModel[key].out += ot; byModel[key].cost += c; byModel[key].calls++;
    }
    const rm = ragOf(a);
    if (rm) rag.push(rm);
  });
  const avg = (f) => (rag.length ? rag.reduce((x, m) => x + f(m), 0) / rag.length : 0);
  return {
    inTok, outTok, tokens: inTok + outTok, cost, byModel,
    rag: rag.length ? { k: rag[0].k, precision: avg((m) => m.precision), recall: avg((m) => m.recall), mrr: avg((m) => m.mrr), samples: rag.length } : null,
  };
}

// Returns { agents:[{name, par, spans:[{name,cat,dur,par}]}], spanCount, errors }
function parseTrace(text) {
  const errors = [];
  const trimmed = text.trim();
  const empty = { agents: [], spanCount: 0, errors: [] };
  if (!trimmed) return empty;

  const finalize = (agents) => {
    const withSpans = agents.filter((a) => a.spans.length > 0);
    return { agents: withSpans, spanCount: withSpans.reduce((n, a) => n + a.spans.length, 0), errors };
  };

  // ---- JSON forms
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      let obj = JSON.parse(trimmed);
      if (obj && obj.agents) obj = obj.agents;
      const arr = Array.isArray(obj) ? obj : [obj];
      // agent-object form: [{name/agent, parallel, spans:[...]}]
      if (arr.length && arr[0] && Array.isArray(arr[0].spans)) {
        const agents = arr.map((a, ai) => ({
          name: a.name || a.agent || `agent ${ai + 1}`,
          par: !!(a.parallel || a.par),
          spans: a.spans.map((o, i) => jsonSpan(o, `${a.name || "agent"} span ${i + 1}`, errors)).filter(Boolean),
        }));
        return finalize(agents);
      }
      // flat span form: group consecutive spans by optional `agent` field
      const agents = [];
      arr.forEach((o, i) => {
        const s = jsonSpan(o, `item ${i + 1}`, errors);
        if (!s) return;
        // ad-hoc tracers often append a self-computed total — skip it,
        // otherwise the timeline double-counts
        if (/^(total|end[_ ]?to[_ ]?end|e2e)$/i.test(s.name.trim())) return;
        const agentName = o.agent || "";
        const last = agents[agents.length - 1];
        if (!last || last.name !== agentName) agents.push({ name: agentName, par: !!(o.agent_parallel), spans: [s] });
        else last.spans.push(s);
      });
      return finalize(agents);
    } catch (e) {
      return { agents: [], spanCount: 0, errors: ["JSON parse failed: " + e.message] };
    }
  }

  // ---- line form
  // @name [(parallel)]  starts a swim-lane; spans inside run sequentially
  // span:  [| or +] name [, cat] , dur   — or —   name dur
  const agents = [{ name: "", par: false, spans: [] }];
  trimmed.split(/\n/).forEach((raw, i) => {
    let line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) return;

    if (line.startsWith("@")) {
      const m = line.match(/^@\s*(.+?)\s*(\((?:parallel|par)\))?\s*$/i);
      if (!m) { errors.push(`line ${i + 1}: bad agent header "${raw.trim().slice(0, 40)}"`); return; }
      agents.push({ name: m[1], par: !!m[2], spans: [] });
      return;
    }

    let par = false;
    if (line.startsWith("|") || line.startsWith("+")) { par = true; line = line.slice(1).trim(); }
    let name, cat, dur;
    if (line.includes(",")) {
      const parts = line.split(",").map((p) => p.trim());
      dur = parseDur(parts[parts.length - 1]);
      if (parts.length >= 3 && CATS.includes(parts[parts.length - 2].toLowerCase())) {
        cat = parts[parts.length - 2].toLowerCase();
        name = parts.slice(0, -2).join(", ");
      } else {
        name = parts.slice(0, -1).join(", ");
      }
    } else {
      const m = line.match(/^(.*?)[\s:]+([\d.]+\s*(?:ms|s)?)$/i);
      if (m) { name = m[1].trim(); dur = parseDur(m[2]); }
    }
    if (!name || dur === null || dur === undefined) {
      errors.push(`line ${i + 1}: couldn't parse "${raw.trim().slice(0, 40)}"`);
      return;
    }
    agents[agents.length - 1].spans.push({ name, cat: cat || inferCat(name), dur, par });
  });
  return finalize(agents);
}

function jsonSpan(o, label, errors) {
  const name = o.name || o.span || o.step || o.label || label;
  const dur = Number(o.dur ?? o.duration ?? o.duration_ms ?? o.ms);
  if (!isFinite(dur)) { errors.push(`${label}: missing duration`); return null; }
  const cat = CATS.includes(o.cat || o.category) ? (o.cat || o.category) : inferCat(name);
  const span = { name, cat, dur, par: !!(o.parallel || o.par) };
  if (o.attrs && typeof o.attrs === "object") span.attrs = o.attrs;
  return span;
}

// ---------------------------------------------------------------- examples
const TRIAGE_EXAMPLE = `# Benefits Support Triage Agent — single agent, one request
# format: name, [category,] duration   ·   prefix | = parallel with previous span
gateway routing, orch, 45
triage classifier (haiku), llm, 620
pgvector policy_chunks, retr, 95
| pgvector resolved_tickets, retr, 110
ticket history query (postgres), tool, 40
benefits eligibility api, tool, 1450
claude final response, llm, 2400`;

const NEXUS_EXAMPLE = `# NexusAgent — orchestrated multi-agent request
# @name starts a swim-lane · mark lanes (parallel) to fork them together,
# or leave them sequential and flip "Parallelize sub-agents" to see the win
@orchestrator
intent classification (qwen), llm, 420
tool registry lookup, tool, 35
@research
enterprise search api, tool, 1350
synthesize findings (qwen), llm, 980
@compliance
policy engine evaluation, tool, 240
risk assessment (qwen), llm, 760
@writer
final response (qwen), llm, 2200
audit log write, tool, 25`;

// JSON form carries token/cost/RAG attrs → unlocks the cost & retrieval panel
const ACCOUNTING_EXAMPLE = JSON.stringify([
  { name: "triage classifier", cat: "llm", dur: 620, attrs: { model: "claude-haiku-4", input_tokens: 1100, output_tokens: 140 } },
  { name: "pgvector policy_chunks", cat: "retr", dur: 95, attrs: { retrieved_ids: ["p1", "p2", "p3", "p7", "p9"], relevant_ids: ["p1", "p3", "p12"], k: 5 } },
  { name: "pgvector resolved_tickets", cat: "retr", dur: 110, parallel: true, attrs: { retrieved_ids: ["t8", "t2", "t5"], relevant_ids: ["t2", "t5"], k: 5 } },
  { name: "benefits eligibility api", cat: "tool", dur: 1450 },
  { name: "claude final response", cat: "llm", dur: 2400, attrs: { model: "claude-sonnet-4", input_tokens: 5200, output_tokens: 430 } },
], null, 2);

// ---------------------------------------------------------------- simulated workload
const TOOLS = [
  { name: "Benefits API", base: 1800 },
  { name: "Payroll API", base: 1500 },
  { name: "Tax calculator", base: 400 },
];

function simulatedOnce(cfg, rnd) {
  const jitter = (v) => v * (0.9 + rnd() * 0.25);
  const tail = (v) => (rnd() < 0.06 ? v * (2 + rnd() * 1.6) : v);
  const net = cfg.colocate ? 25 : 70;

  const spans = [];
  let t = 0;
  const push = (name, cat, dur, start = t) => { spans.push({ name, cat, start, dur }); return start + dur; };

  t = push("Gateway routing", "orch", jitter(100));
  t = push(cfg.modelRouting ? "Planner (small model)" : "Planner LLM", "llm", jitter(cfg.modelRouting ? 260 : 950));

  const retrHit = rnd() < cfg.cacheHit;
  t = retrHit
    ? push("Vector search · cached", "cache", jitter(12) + net * 0.2)
    : push("Embed + vector search", "retr", jitter(210) + net);

  const toolDurs = TOOLS.map((tl) => {
    const hit = rnd() < cfg.cacheHit;
    return { name: hit ? tl.name + " · cached" : tl.name, cat: hit ? "cache" : "tool", dur: hit ? jitter(10) + net * 0.2 : tail(jitter(tl.base)) + net };
  });
  if (cfg.parallelTools) {
    const start = t; let maxEnd = t;
    toolDurs.forEach((d) => { maxEnd = Math.max(maxEnd, push(d.name, d.cat, d.dur, start)); });
    t = maxEnd;
  } else {
    toolDurs.forEach((d) => { t = push(d.name, d.cat, d.dur); });
  }

  const loops = Math.max(0, (cfg.capIterations ? Math.min(cfg.iterations, 3) : cfg.iterations) - 1);
  for (let i = 0; i < loops; i++) t = push(`Reflection ${i + 1}`, "llm", jitter(650));

  t = push(cfg.trimContext ? "Final LLM (trimmed context)" : "Final LLM (full history)", "llm", jitter(cfg.trimContext ? 1550 : 2200));

  const total = t;
  const ttft = cfg.streaming ? spans[0].dur + jitter(400) : total;
  return { spans, total, ttft, lanes: null };
}

// ---------------------------------------------------------------- custom trace: fork/join layout + what-ifs
function customOnce(agents, cfg, rnd) {
  const jitter = (v) => v * (0.9 + rnd() * 0.25);
  const tail = (v) => (rnd() < 0.06 ? v * (2 + rnd() * 1.6) : v);
  const netSave = cfg.colocate ? 45 : 0;

  // targets for LLM what-ifs: first LLM span of the FIRST agent (planner),
  // last LLM span of the LAST agent (final answer)
  const firstAgentLlm = agents[0]?.spans.findIndex((s) => s.cat === "llm") ?? -1;
  const lastAgent = agents.length - 1;
  const lastAgentLlm = agents[lastAgent] ? agents[lastAgent].spans.map((s) => s.cat).lastIndexOf("llm") : -1;
  const anyOtherLlm = agents.reduce((n, a) => n + a.spans.filter((s) => s.cat === "llm").length, 0) > 1;

  const spans = [];
  const lanes = [];
  let globalEnd = 0, forkPoint = 0, prevPar = false;

  agents.forEach((agent, ai) => {
    const forcedAgentPar = cfg.parallelAgents && agents.length >= 3 && ai > 0 && ai < agents.length - 1;
    const par = agent.par || forcedAgentPar;
    let agentStart;
    if (par) {
      if (!prevPar) forkPoint = globalEnd; // fork after the last sequential lane
      agentStart = forkPoint;
    } else {
      agentStart = globalEnd; // join: wait for everything so far
    }
    prevPar = par;

    let t = agentStart, prevStart = agentStart;
    agent.spans.forEach((s, i) => {
      let dur = s.dur, name = s.name, cat = s.cat;

      if (cat === "llm") {
        if (cfg.modelRouting && ai === 0 && i === firstAgentLlm && anyOtherLlm) { dur *= 0.28; name += " · routed small"; }
        if (cfg.trimContext && ai === lastAgent && i === lastAgentLlm) { dur *= 0.7; name += " · trimmed ctx"; }
        dur = jitter(dur);
      } else if (cat === "retr" || cat === "tool") {
        if (rnd() < cfg.cacheHit) { name += " · cached"; cat = "cache"; dur = jitter(10); }
        else dur = Math.max(5, tail(jitter(dur)) - netSave);
      } else {
        dur = jitter(dur);
      }

      const forcedPar = cfg.parallelTools && i > 0 &&
        (s.cat === "tool" || s.cat === "retr") && (agent.spans[i - 1].cat === "tool" || agent.spans[i - 1].cat === "retr");
      const start = (s.par || forcedPar) ? prevStart : t;
      spans.push({ name, cat, start, dur, origCat: s.cat, agent: agent.name, agentIdx: ai, attrs: s.attrs });
      prevStart = start;
      t = Math.max(t, start + dur);
    });

    lanes.push({ name: agent.name, par, start: agentStart, end: t });
    globalEnd = Math.max(globalEnd, t);
  });

  // critical-path flags: within each fork group, the slowest lane is critical.
  // A group is either one sequential lane or one consecutive run of parallel lanes.
  let gi = 0;
  lanes.forEach((l, i) => {
    if (i > 0 && (!l.par || !lanes[i - 1].par)) gi++;
    l.group = gi;
  });
  for (let g = 0; g <= gi; g++) {
    const group = lanes.filter((l) => l.group === g);
    const maxEnd = Math.max(...group.map((l) => l.end));
    group.forEach((l) => { l.critical = Math.abs(l.end - maxEnd) < 1; });
  }

  const total = globalEnd;
  const ttft = cfg.streaming ? (spans[0] ? spans[0].dur : 0) + jitter(400) : total;
  return { spans, total, ttft, lanes: lanes.length > 1 ? lanes : null };
}

function runSim(onceFn, cfg) {
  const rnd = mulberry32(1337);
  const runs = [];
  for (let i = 0; i < 240; i++) runs.push(onceFn(cfg, rnd));
  const totals = runs.map((r) => r.total);
  const ttfts = runs.map((r) => r.ttft);
  const p50 = pct(totals, 50);
  const rep = runs.reduce((a, b) => (Math.abs(b.total - p50) < Math.abs(a.total - p50) ? b : a));
  const catTotals = {};
  runs.forEach((r) => r.spans.forEach((s) => {
    const c = s.origCat || s.cat;
    catTotals[c] = (catTotals[c] || 0) + s.dur / runs.length;
  }));
  return { totals, rep, catTotals, p50, p95: pct(totals, 95), p99: pct(totals, 99), ttftP50: pct(ttfts, 50) };
}

// stage actuals from a representative single-agent trace
function stageBreakdown(rep) {
  const spans = rep.spans;
  const isRetr = (s) => s.cat === "retr" || (s.cat === "cache" && /vector|embed|pgvector|retriev|rag/i.test(s.name));
  const isTool = (s) => s.cat === "tool" || (s.cat === "cache" && !isRetr(s));
  const wall = (list) => (list.length ? Math.max(...list.map((s) => s.start + s.dur)) - Math.min(...list.map((s) => s.start)) : 0);
  const llms = spans.filter((s) => s.cat === "llm");
  return {
    routing: spans.filter((s) => s.cat === "orch").reduce((a, s) => a + s.dur, 0),
    planner: llms.length > 1 ? llms[0].dur : 0,
    retrieval: wall(spans.filter(isRetr)),
    tools: wall(spans.filter(isTool)),
    final: llms.reduce((a, s) => a + s.dur, 0) - (llms.length > 1 ? llms[0].dur : 0),
  };
}

// ---------------------------------------------------------------- UI atoms
function Toggle({ label, hint, on, set }) {
  return (
    <button onClick={() => set(!on)} style={{
      display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left",
      background: on ? T.panelSoft : "transparent", border: `1px solid ${on ? T.line : "transparent"}`,
      borderRadius: 10, padding: "10px 12px", cursor: "pointer", color: T.text,
    }}>
      <span style={{ width: 34, height: 20, borderRadius: 999, flexShrink: 0, position: "relative", background: on ? T.llm : T.line, transition: "background .2s" }}>
        <span style={{ position: "absolute", top: 3, left: on ? 17 : 3, width: 14, height: 14, borderRadius: 999, background: T.bg, transition: "left .2s" }} />
      </span>
      <span>
        <span style={{ fontSize: 13.5, fontWeight: 600, display: "block" }}>{label}</span>
        <span style={{ fontSize: 11.5, color: T.muted, display: "block", lineHeight: 1.35 }}>{hint}</span>
      </span>
    </button>
  );
}

function Slider({ label, value, display, min, max, step, set }) {
  return (
    <div style={{ padding: "10px 12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", color: T.llm, fontSize: 12.5 }}>{display}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => set(Number(e.target.value))}
        style={{ width: "100%", accentColor: T.llm }} />
    </div>
  );
}

function Metric({ label, value, sub, ok }) {
  return (
    <div style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 12, padding: "14px 16px", flex: "1 1 130px", minWidth: 120 }}>
      <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: T.muted }}>{label}</div>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 22, fontWeight: 700, margin: "4px 0 2px", color: ok === false ? T.bad : T.text }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: ok === undefined ? T.muted : ok ? T.good : T.bad }}>{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- waterfall with swim-lanes
function Waterfall({ trace }) {
  const W = 860, ROW = 26, HEAD = 24, PAD_L = 200, PAD_R = 70;
  const multi = !!trace.lanes;

  // build render items: lane headers interleaved with span rows
  const items = [];
  let lastAgent = null;
  trace.spans.forEach((s) => {
    if (multi && s.agent !== lastAgent) {
      const lane = trace.lanes.find((l) => l.name === s.agent);
      items.push({ header: s.agent, lane });
      lastAgent = s.agent;
    }
    items.push({ span: s });
  });

  const H = items.reduce((h, it) => h + (it.header ? HEAD : ROW), 10) + 24;
  const scale = (W - PAD_L - PAD_R) / (trace.total || 1);
  const gridEvery = trace.total > 6000 ? 2000 : trace.total > 2500 ? 1000 : trace.total > 800 ? 500 : 100;
  const gridLines = [];
  for (let g = gridEvery; g < trace.total; g += gridEvery) gridLines.push(g);

  let y = 10;
  const rendered = items.map((it, idx) => {
    if (it.header) {
      const yy = y; y += HEAD;
      const l = it.lane;
      const bandX = PAD_L + (l ? l.start * scale : 0);
      const bandW = l ? Math.max(2, (l.end - l.start) * scale) : 0;
      return (
        <g key={"h" + idx}>
          <rect x={bandX} y={yy + 4} width={bandW} height={HEAD - 8} rx={4} fill={T.panelSoft} stroke={T.line} />
          <text x={12} y={yy + 16} fill={T.llm} fontSize="11" fontWeight="700" fontFamily="'Space Grotesk', sans-serif" letterSpacing="0.06em">
            @{it.header.toUpperCase()}
          </text>
          {l && (
            <text x={bandX + bandW - 6} y={yy + 16} fill={l.critical ? T.llm : T.faint} fontSize="9.5" textAnchor="end" fontFamily="'JetBrains Mono', monospace">
              {fmt(l.end - l.start)}{l.critical ? " · critical" : ""}{l.par ? " · ∥" : ""}
            </text>
          )}
        </g>
      );
    }
    const s = it.span;
    const yy = y; y += ROW;
    const x = PAD_L + s.start * scale;
    const w = Math.max(3, s.dur * scale);
    const label = s.name.length > 30 ? s.name.slice(0, 29) + "…" : s.name;
    return (
      <g key={"s" + idx}>
        <text x={PAD_L - 10} y={yy + 13} fill={T.muted} fontSize="11.5" textAnchor="end" fontFamily="'Space Grotesk', sans-serif">{label}</text>
        <rect x={x} y={yy} width={w} height={16} rx={4} fill={CAT_COLOR[s.cat]} opacity={0.85} style={{ transition: "all .5s ease" }} />
        <text x={x + w + 6} y={yy + 12.5} fill={T.faint} fontSize="10" fontFamily="'JetBrains Mono', monospace">{fmt(s.dur)}</text>
      </g>
    );
  });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      {gridLines.map((g) => (
        <g key={g}>
          <line x1={PAD_L + g * scale} x2={PAD_L + g * scale} y1={6} y2={H - 18} stroke={T.line} strokeDasharray="3 4" />
          <text x={PAD_L + g * scale} y={H - 4} fill={T.faint} fontSize="10" textAnchor="middle" fontFamily="'JetBrains Mono', monospace">{g >= 1000 ? g / 1000 + "s" : g + "ms"}</text>
        </g>
      ))}
      {rendered}
    </svg>
  );
}

// ---------------------------------------------------------------- histogram
function Histogram({ totals, sloMs }) {
  const W = 860, H = 150, PAD = 28;
  const max = Math.max(...totals), min = Math.min(...totals);
  const nB = 24, bw = (max - min) / nB || 1;
  const buckets = new Array(nB).fill(0);
  totals.forEach((v) => buckets[Math.min(nB - 1, Math.floor((v - min) / bw))]++);
  const bMax = Math.max(...buckets);
  const x = (v) => PAD + ((v - min) / (max - min || 1)) * (W - PAD * 2);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      {buckets.map((c, i) => {
        const bx = PAD + (i / nB) * (W - PAD * 2);
        const bh = (c / bMax) * (H - 44);
        const mid = min + (i + 0.5) * bw;
        return <rect key={i} x={bx + 1} y={H - 24 - bh} width={(W - PAD * 2) / nB - 2} height={bh} rx={3}
          fill={mid > sloMs ? T.bad : T.tool} opacity={0.85} />;
      })}
      {sloMs > min && sloMs < max && (
        <g>
          <line x1={x(sloMs)} x2={x(sloMs)} y1={8} y2={H - 24} stroke={T.llm} strokeWidth={1.5} strokeDasharray="5 4" />
          <text x={x(sloMs) + 5} y={16} fill={T.llm} fontSize="10.5" fontFamily="'JetBrains Mono', monospace">P95 SLO {fmt(sloMs)}</text>
        </g>
      )}
      <text x={PAD} y={H - 8} fill={T.faint} fontSize="10" fontFamily="'JetBrains Mono', monospace">{fmt(min)}</text>
      <text x={W - PAD} y={H - 8} fill={T.faint} fontSize="10" textAnchor="end" fontFamily="'JetBrains Mono', monospace">{fmt(max)}</text>
    </svg>
  );
}

// ---------------------------------------------------------------- budgets & advice
const BUDGET = [
  { stage: "Routing", key: "routing", ms: 100 },
  { stage: "Planner", key: "planner", ms: 600 },
  { stage: "Retrieval", key: "retrieval", ms: 150 },
  { stage: "Tool calls", key: "tools", ms: 800 },
  { stage: "Final LLM", key: "final", ms: 1500 },
];

const ADVICE = {
  tool: { title: "Tool calls dominate the trace", fix: "Parallelize independent calls with asyncio.gather, cache stable responses (benefits data, tax rates), and co-locate services. External APIs are frequently the biggest bottleneck — not the LLM." },
  llm: { title: "LLM inference dominates the trace", fix: "Route the planner to a smaller model, trim the context window (summary + last turns + retrievals instead of full history), cap reflection iterations, and stream tokens to cut perceived latency." },
  retr: { title: "Retrieval dominates the trace", fix: "Add an embedding + vector-result cache, use approximate nearest-neighbor indexes, precompute embeddings, and batch embedding requests. Target <300 ms end-to-end RAG." },
  orch: { title: "Orchestration overhead dominates", fix: "Collapse multi-agent hops into a single LLM + tools loop where possible, reduce serialization round trips, and keep the gateway, agent, and data in the same region." },
  seqAgents: { title: "Sequential agents dominate", fix: "Your lanes run one after another — the classic five-sequential-agents anti-pattern. Fork the independent middle agents after the planner and join before the writer: flip \"Parallelize sub-agents\", or mark lanes (parallel) where you control the orchestrator." },
};

// ---------------------------------------------------------------- live alert feed
// Polls /debug/alerts (served by the instrumentation middleware's SLO watcher,
// proxied by Vite in the workspace). Renders nothing when unreachable, so the
// Lab still works standalone.
function AlertFeed({ onLoadTrace }) {
  const [alerts, setAlerts] = useState(null);
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const r = await fetch("/debug/alerts");
        if (!r.ok) return;
        const d = await r.json();
        if (!stop && Array.isArray(d.alerts)) setAlerts(d.alerts);
      } catch { /* no server — stay hidden */ }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { stop = true; clearInterval(id); };
  }, []);

  if (!alerts || alerts.length === 0) return null;
  return (
    <div style={{ background: T.panel, border: `1px solid ${T.bad}66`, borderRadius: 14, padding: 18 }}>
      <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 15, fontWeight: 600, margin: "0 0 4px", color: T.bad }}>
        Live SLO alerts <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: T.faint, fontWeight: 400 }}>/debug/alerts · 5s poll</span>
      </h2>
      <p style={{ fontSize: 12, color: T.muted, margin: "0 0 12px", lineHeight: 1.45 }}>
        Breaches from the instrumented server, diagnosed at the source.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {alerts.slice(0, 4).map((a, i) => (
          <div key={a.at + a.rule + i} style={{ background: T.panelSoft, border: `1px solid ${T.line}`, borderRadius: 10, padding: "10px 12px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: T.bad, fontWeight: 700 }}>
                {a.rule} · {fmt(a.observed_ms)} <span style={{ color: T.faint, fontWeight: 400 }}>/ {fmt(a.threshold_ms)} target</span>
              </span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: T.faint }}>
                {new Date(a.at).toLocaleTimeString()}
              </span>
            </div>
            <div style={{ fontSize: 11.5, color: T.muted, margin: "5px 0", lineHeight: 1.45 }}>
              <span style={{ color: CAT_COLOR[a.dominant_category] || T.text }}>{CAT_LABEL[a.dominant_category] || a.dominant_category}</span>
              {" "}{a.dominant_share_pct}% of breach time · top span: <span style={{ color: T.text }}>{a.top_span}</span>
              <br />{a.recommendation}
            </div>
            {a.worst_trace_lab_format && (
              <button onClick={() => onLoadTrace(a.worst_trace_lab_format)} style={{
                background: "transparent", border: `1px solid ${T.line}`, color: T.llm, borderRadius: 7,
                padding: "4px 9px", fontSize: 11.5, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600,
              }}>
                Load worst trace → analyze
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- main app
export default function AgentLatencyLab() {
  const [mode, setMode] = useState("sim"); // "sim" | "custom"
  const [traceText, setTraceText] = useState("");

  // VS Code extension bridge: the host posts a trace (from an editor
  // selection or the clipboard) as a CustomEvent once the webview signals
  // readiness. No-ops entirely outside the extension — nothing here touches
  // fetch or any network path, so the standalone web app is unaffected.
  useEffect(() => {
    const onExternalTrace = (e) => {
      if (typeof e.detail === "string" && e.detail.trim()) {
        setTraceText(e.detail);
        setMode("custom");
      }
    };
    window.addEventListener("agent-latency-lab:load-trace", onExternalTrace);
    return () => window.removeEventListener("agent-latency-lab:load-trace", onExternalTrace);
  }, []);

  const [parallelTools, setParallel] = useState(false);
  const [parallelAgents, setParallelAgents] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [modelRouting, setRouting] = useState(false);
  const [trimContext, setTrim] = useState(false);
  const [colocate, setColocate] = useState(false);
  const [capIterations, setCap] = useState(false);
  const [cacheHit, setCache] = useState(0);
  const [iterations, setIters] = useState(3);

  const cfg = { parallelTools, parallelAgents, streaming, modelRouting, trimContext, colocate, capIterations, cacheHit: cacheHit / 100, iterations };
  const baseCfg = { parallelTools: false, parallelAgents: false, streaming: false, modelRouting: false, trimContext: false, colocate: false, capIterations: false, cacheHit: 0, iterations };

  const parsed = useMemo(() => parseTrace(traceText), [traceText]);
  const customReady = mode === "custom" && parsed.spanCount > 0;
  const multiAgent = customReady && parsed.agents.length > 1;

  const sim = useMemo(() => {
    if (customReady) return runSim((c, r) => customOnce(parsed.agents, c, r), cfg);
    return runSim(simulatedOnce, cfg);
  }, [mode, parsed, parallelTools, parallelAgents, streaming, modelRouting, trimContext, colocate, capIterations, cacheHit, iterations]);

  const baseline = useMemo(() => {
    if (customReady) return runSim((c, r) => customOnce(parsed.agents, c, r), baseCfg);
    return runSim(simulatedOnce, baseCfg);
  }, [mode, parsed, iterations]);

  const stageActual = useMemo(() => (multiAgent ? null : stageBreakdown(sim.rep)), [sim, multiAgent]);
  const account = useMemo(() => accountOf(sim.rep.spans), [sim]);
  const hasAccounting = account.tokens > 0 || account.cost > 0 || account.rag;

  const slo = [
    { v: sim.ttftP50, l: 1000 }, { v: sim.p50, l: 3000 }, { v: sim.p95, l: 7000 }, { v: sim.p99, l: 15000 },
  ];
  const sloPass = slo.filter((s) => s.v <= s.l).length;

  const cats = Object.entries(sim.catTotals).filter(([c]) => c !== "cache" && c !== "orch").sort((a, b) => b[1] - a[1]);
  const lanes = sim.rep.lanes;
  const seqBottleneck = multiAgent && lanes && parsed.agents.length >= 3 && !parallelAgents && !parsed.agents.some((a) => a.par);
  const advice = seqBottleneck ? ADVICE.seqAgents : (ADVICE[cats[0]?.[0]] || ADVICE.llm);
  const saved = baseline.p95 - sim.p95;

  const emptyCustom = mode === "custom" && !customReady;

  const panel = { background: T.panel, border: `1px solid ${T.line}`, borderRadius: 14, padding: 18 };
  const h2 = { fontFamily: "'Space Grotesk', sans-serif", fontSize: 15, fontWeight: 600, margin: "0 0 4px", letterSpacing: "0.01em" };
  const sub = { fontSize: 12, color: T.muted, margin: "0 0 14px", lineHeight: 1.45 };
  const th = (left) => ({ textAlign: left ? "left" : "right", padding: "6px 8px", borderBottom: `1px solid ${T.line}` });
  const td = (left, color) => ({ textAlign: left ? "left" : "right", padding: "8px", borderBottom: `1px solid ${T.line}`, color });
  const tabBtn = (active) => ({
    flex: 1, padding: "8px 10px", borderRadius: 9, cursor: "pointer", fontSize: 12.5, fontWeight: 600,
    fontFamily: "'Space Grotesk', sans-serif",
    background: active ? T.llm : "transparent", color: active ? T.bg : T.muted,
    border: `1px solid ${active ? T.llm : T.line}`,
  });
  const exampleBtn = {
    background: "transparent", border: `1px solid ${T.line}`, color: T.retr, borderRadius: 8,
    padding: "6px 10px", fontSize: 12, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600,
  };

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "'Space Grotesk', ui-sans-serif, system-ui, sans-serif", padding: "26px 22px 60px" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap');
        input[type=range]{height:4px;background:${T.line};border-radius:99px;-webkit-appearance:none;appearance:none;}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:15px;height:15px;border-radius:99px;background:${T.llm};cursor:pointer;}
        button:focus-visible, textarea:focus-visible{outline:2px solid ${T.llm};outline-offset:2px;}
        textarea::placeholder{color:${T.faint};}
        @media (max-width: 900px){ .lab-grid{grid-template-columns:1fr !important;} }
      `}</style>

      <div style={{ maxWidth: 1240, margin: "0 auto" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>Agent Latency Lab</h1>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, color: T.llm, border: `1px solid ${T.line}`, borderRadius: 999, padding: "3px 10px" }}>
            240-request Monte Carlo · seeded
          </span>
          <span title="No trace data is ever uploaded — everything on this page runs client-side, in your browser." style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, color: T.good,
            border: `1px solid ${T.good}55`, borderRadius: 999, padding: "3px 10px", cursor: "default",
          }}>
            <span style={{ fontSize: 10 }}>●</span> runs entirely in your browser
          </span>
        </div>
        <p style={{ color: T.muted, fontSize: 13.5, margin: "0 0 4px", maxWidth: 780, lineHeight: 1.5 }}>
          {mode === "sim"
            ? "A benefits-agent workflow (planner → retrieval → 3 APIs → final LLM), simulated end to end. Flip the optimizations and watch the waterfall, percentiles, and SLOs respond."
            : "Paste real span timings — single agent or multi-agent with @lane headers. The lab lays out fork/join swim-lanes, synthesizes a request distribution (±jitter, 6% long-tail on external calls), and applies the what-ifs to your actual spans."}
        </p>
        <p style={{ color: T.faint, fontSize: 11.5, margin: "0 0 22px", maxWidth: 780, lineHeight: 1.5 }}>
          Nothing you paste is ever sent to a server — parsing, simulation, and every visualization run locally in this tab. Refresh the page and it's gone.
          {" · "}
          <a href="https://github.com/juubaker" target="_blank" rel="noreferrer" style={{ color: T.faint }}>source on GitHub</a>
        </p>

        <div className="lab-grid" style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 18 }}>
          {/* ------------- controls */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={tabBtn(mode === "sim")} onClick={() => setMode("sim")}>Simulated workload</button>
              <button style={tabBtn(mode === "custom")} onClick={() => setMode("custom")}>Paste your trace</button>
            </div>

            {mode === "custom" && (
              <div style={panel}>
                <h2 style={h2}>Your trace</h2>
                <p style={sub}>
                  Spans: <span style={{ fontFamily: "'JetBrains Mono', monospace", color: T.text }}>name, [llm|retr|tool|orch,] duration</span> · prefix <span style={{ fontFamily: "'JetBrains Mono', monospace", color: T.text }}>|</span> = parallel with previous span.
                  Lanes: <span style={{ fontFamily: "'JetBrains Mono', monospace", color: T.text }}>@agent</span> starts a swim-lane; consecutive <span style={{ fontFamily: "'JetBrains Mono', monospace", color: T.text }}>@agent (parallel)</span> lanes fork together after the previous sequential lane. JSON works too.
                </p>
                <textarea
                  value={traceText}
                  onChange={(e) => setTraceText(e.target.value)}
                  rows={11}
                  spellCheck={false}
                  placeholder={"@orchestrator\nintent classification, llm, 420\n@research (parallel)\nenterprise search api, tool, 1350\n@compliance (parallel)\npolicy engine evaluation, tool, 240\n@writer\nfinal response, llm, 2200"}
                  style={{
                    width: "100%", boxSizing: "border-box", resize: "vertical",
                    background: T.bg, color: T.text, border: `1px solid ${T.line}`, borderRadius: 10,
                    padding: 10, fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, lineHeight: 1.6,
                  }}
                />
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8, alignItems: "center" }}>
                  <button onClick={() => setTraceText(NEXUS_EXAMPLE)} style={exampleBtn}>NexusAgent multi-agent</button>
                  <button onClick={() => setTraceText(ACCOUNTING_EXAMPLE)} style={exampleBtn}>Cost + RAG (JSON)</button>
                  <button onClick={() => setTraceText(TRIAGE_EXAMPLE)} style={exampleBtn}>Triage single-agent</button>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: parsed.errors.length ? T.bad : T.muted, marginLeft: "auto" }}>
                    {parsed.spanCount} span{parsed.spanCount === 1 ? "" : "s"}
                    {parsed.agents.length > 1 ? ` · ${parsed.agents.length} agents` : ""}
                    {parsed.errors.length ? ` · ${parsed.errors.length} error${parsed.errors.length > 1 ? "s" : ""}` : ""}
                  </span>
                </div>
                {parsed.errors.slice(0, 3).map((e, i) => (
                  <div key={i} style={{ fontSize: 11, color: T.bad, marginTop: 6, fontFamily: "'JetBrains Mono', monospace" }}>{e}</div>
                ))}
              </div>
            )}

            {mode === "sim" && (
              <div style={panel}>
                <h2 style={h2}>Workload</h2>
                <p style={sub}>Shape of the incoming agent loop.</p>
                <Slider label="Reasoning iterations" value={iterations} display={`${iterations} loop${iterations > 1 ? "s" : ""}`} min={1} max={5} step={1} set={setIters} />
                <Slider label="Cache hit rate" value={cacheHit} display={`${cacheHit}%`} min={0} max={95} step={5} set={setCache} />
              </div>
            )}

            <div style={{ ...panel, opacity: emptyCustom ? 0.45 : 1, pointerEvents: emptyCustom ? "none" : "auto" }}>
              <h2 style={h2}>{mode === "custom" ? "What-if optimizations" : "Optimizations"}</h2>
              <p style={sub}>{mode === "custom" ? "Applied directly to your pasted spans and lanes." : "The levers a principal engineer reaches for before swapping models."}</p>
              {mode === "custom" && (
                <Slider label="Cache hit rate" value={cacheHit} display={`${cacheHit}%`} min={0} max={95} step={5} set={setCache} />
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {multiAgent && (
                  <Toggle label="Parallelize sub-agents" hint="Fork middle lanes after the first; join before the last" on={parallelAgents} set={setParallelAgents} />
                )}
                <Toggle label="Parallelize tool calls" hint={mode === "custom" ? "Consecutive tool/retrieval spans within a lane start together" : "asyncio.gather — 3 APIs run as max(), not sum()"} on={parallelTools} set={setParallel} />
                <Toggle label="Model routing" hint={mode === "custom" ? "First lane's first LLM span → small model (~3.5× faster)" : "Small model plans, large model answers"} on={modelRouting} set={setRouting} />
                <Toggle label="Trim context" hint={mode === "custom" ? "Last lane's final LLM span −30% via compressed history" : "Summary + recent turns instead of full history"} on={trimContext} set={setTrim} />
                {mode === "sim" && <Toggle label="Cap iterations" hint="MAX_ITERATIONS = 3 stops overthinking" on={capIterations} set={setCap} />}
                <Toggle label="Co-locate services" hint="~45 ms shaved off every external call" on={colocate} set={setColocate} />
                <Toggle label="Stream responses" hint="Perceived latency ≈ TTFT, not completion" on={streaming} set={setStreaming} />
              </div>
            </div>

            {!emptyCustom && (
              <div style={{ ...panel, borderColor: T.llm + "55" }}>
                <h2 style={{ ...h2, color: T.llm }}>{advice.title}</h2>
                <p style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.55, margin: 0 }}>{advice.fix}</p>
              </div>
            )}

            <AlertFeed onLoadTrace={(text) => { setTraceText(text); setMode("custom"); }} />
          </div>

          {/* ------------- main column */}
          <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
            {emptyCustom ? (
              <div style={{ ...panel, padding: 40, textAlign: "center" }}>
                <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 8 }}>Paste a trace to analyze it</div>
                <p style={{ color: T.muted, fontSize: 13, lineHeight: 1.6, maxWidth: 500, margin: "0 auto" }}>
                  Grab span durations from your instrumented agent (the middleware prints them in this exact format, including @lanes for multi-agent requests) — or load the NexusAgent example to see fork/join swim-lanes in action.
                </p>
              </div>
            ) : (
              <>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <Metric label="P50" value={fmt(sim.p50)} sub={sim.p50 <= 3000 ? "SLO < 3 s · pass" : "SLO < 3 s · breach"} ok={sim.p50 <= 3000} />
                  <Metric label="P95" value={fmt(sim.p95)} sub={sim.p95 <= 7000 ? "SLO < 7 s · pass" : "SLO < 7 s · breach"} ok={sim.p95 <= 7000} />
                  <Metric label="P99" value={fmt(sim.p99)} sub={sim.p99 <= 15000 ? "SLO < 15 s · pass" : "SLO < 15 s · breach"} ok={sim.p99 <= 15000} />
                  <Metric label="TTFT" value={fmt(sim.ttftP50)} sub={streaming ? "streaming on" : "no streaming — TTFT = total"} ok={sim.ttftP50 <= 1000} />
                  <Metric label="vs baseline P95" value={(saved >= 0 ? "−" : "+") + fmt(Math.abs(saved))} sub={`${sloPass}/4 SLOs green`} ok={saved > 0 ? true : undefined} />
                  {hasAccounting && account.cost > 0 && (
                    <Metric label="Cost / request" value={"$" + account.cost.toFixed(account.cost < 0.01 ? 5 : 4)} sub={`${account.tokens.toLocaleString()} tokens`} />
                  )}
                  {hasAccounting && account.rag && (
                    <Metric label={`Recall@${account.rag.k}`} value={(account.rag.recall * 100).toFixed(0) + "%"} sub={`P@${account.rag.k} ${(account.rag.precision * 100).toFixed(0)}% · MRR ${account.rag.mrr.toFixed(2)}`} ok={account.rag.recall >= 0.7} />
                  )}
                </div>

                <div style={panel}>
                  <h2 style={h2}>{multiAgent ? "Trace waterfall — swim-lanes, representative (P50) request" : "Trace waterfall — representative (P50) request"}</h2>
                  <p style={sub}>{multiAgent
                    ? "One lane per agent. The band behind each lane shows its wall-clock window; ∥ marks forked lanes, and the slowest lane in each fork group is flagged critical — that's the one worth optimizing."
                    : mode === "custom"
                      ? "Your spans, with the current what-if transforms applied. Cached calls collapse to slivers; parallel spans share a start line."
                      : "Every stage is a span, Jaeger-style. Cached calls collapse to slivers; parallel tools stack on the same start line."}</p>
                  <Waterfall trace={sim.rep} />
                  <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 10 }}>
                    {Object.entries(CAT_LABEL).map(([c, l]) => (
                      <span key={c} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: T.muted }}>
                        <span style={{ width: 10, height: 10, borderRadius: 3, background: CAT_COLOR[c] }} /> {l}
                      </span>
                    ))}
                  </div>
                </div>

                <div style={panel}>
                  <h2 style={h2}>Latency distribution — why P95 beats the average</h2>
                  <p style={sub}>{mode === "custom" ? "240 synthetic requests generated around your trace: ±jitter on every span, 6% long-tail multiplier on external calls. Red mass past the SLO line is what an average hides." : "240 simulated requests with realistic long tails on external APIs. Red mass past the SLO line is the 10% of users an average would hide."}</p>
                  <Histogram totals={sim.totals} sloMs={7000} />
                </div>

                {hasAccounting && (
                  <div style={panel}>
                    <h2 style={h2}>{"Cost & retrieval quality"}</h2>
                    <p style={sub}>Token spend by model and deterministic RAG metrics from this request's spans — the two things that move production LLM bills and answer quality, tracked alongside latency.</p>
                    <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
                      {Object.keys(account.byModel).length > 0 && (
                        <div style={{ flex: "1 1 320px", minWidth: 280 }}>
                          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.07em", color: T.muted, marginBottom: 8 }}>Cost by model</div>
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                            <thead>
                              <tr style={{ color: T.muted, fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                                <th style={th(true)}>Model</th><th style={th()}>Calls</th><th style={th()}>In</th><th style={th()}>Out</th><th style={th()}>Cost</th>
                              </tr>
                            </thead>
                            <tbody style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                              {Object.entries(account.byModel).map(([m, v]) => (
                                <tr key={m}>
                                  <td style={{ ...td(true), fontFamily: "'Space Grotesk', sans-serif" }}>{m}</td>
                                  <td style={td()}>{v.calls}</td>
                                  <td style={td(false, T.muted)}>{v.in.toLocaleString()}</td>
                                  <td style={td(false, T.muted)}>{v.out.toLocaleString()}</td>
                                  <td style={td(false, T.llm)}>${v.cost.toFixed(v.cost < 0.01 ? 5 : 4)}</td>
                                </tr>
                              ))}
                              <tr>
                                <td style={{ ...td(true), fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, borderBottom: "none" }}>Total</td>
                                <td style={{ ...td(), borderBottom: "none" }} />
                                <td style={{ ...td(false, T.muted), borderBottom: "none" }}>{account.inTok.toLocaleString()}</td>
                                <td style={{ ...td(false, T.muted), borderBottom: "none" }}>{account.outTok.toLocaleString()}</td>
                                <td style={{ ...td(false, T.llm), borderBottom: "none", fontWeight: 700 }}>${account.cost.toFixed(account.cost < 0.01 ? 5 : 4)}</td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      )}
                      {account.rag && (
                        <div style={{ flex: "1 1 240px", minWidth: 220 }}>
                          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.07em", color: T.muted, marginBottom: 8 }}>Retrieval quality @{account.rag.k} · {account.rag.samples} span{account.rag.samples > 1 ? "s" : ""}</div>
                          {[
                            { label: "Precision@k", val: account.rag.precision, hint: "of retrieved, how many relevant" },
                            { label: "Recall@k", val: account.rag.recall, hint: "of relevant, how many retrieved" },
                            { label: "MRR", val: account.rag.mrr, hint: "rank of first relevant hit" },
                          ].map((r) => (
                            <div key={r.label} style={{ marginBottom: 11 }}>
                              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 3 }}>
                                <span style={{ fontWeight: 600 }}>{r.label}</span>
                                <span style={{ fontFamily: "'JetBrains Mono', monospace", color: r.val >= 0.7 ? T.good : r.val >= 0.4 ? T.llm : T.bad }}>{(r.val * 100).toFixed(0)}%</span>
                              </div>
                              <div style={{ height: 5, background: T.line, borderRadius: 99, overflow: "hidden" }}>
                                <div style={{ width: `${Math.min(100, r.val * 100)}%`, height: "100%", background: r.val >= 0.7 ? T.good : r.val >= 0.4 ? T.llm : T.bad, transition: "width .4s" }} />
                              </div>
                              <div style={{ fontSize: 10.5, color: T.faint, marginTop: 2 }}>{r.hint}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {multiAgent && lanes ? (
                  <div style={panel}>
                    <h2 style={h2}>Agent breakdown</h2>
                    <p style={sub}>Wall-clock per lane from the representative trace. Optimizing a non-critical lane buys nothing — the join still waits for the critical one.</p>
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                        <thead>
                          <tr style={{ color: T.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                            <th style={th(true)}>Agent</th>
                            <th style={th()}>Spans</th>
                            <th style={th()}>Starts at</th>
                            <th style={th()}>Wall time</th>
                            <th style={th()}>% of E2E</th>
                            <th style={th()}>Critical path</th>
                          </tr>
                        </thead>
                        <tbody style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12.5 }}>
                          {lanes.map((l) => {
                            const wall = l.end - l.start;
                            const nSpans = sim.rep.spans.filter((s) => s.agent === l.name).length;
                            return (
                              <tr key={l.name}>
                                <td style={{ ...td(true), fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600 }}>
                                  @{l.name}{l.par ? <span style={{ color: T.retr }}> ∥</span> : ""}
                                </td>
                                <td style={td()}>{nSpans}</td>
                                <td style={td(false, T.muted)}>{fmt(l.start)}</td>
                                <td style={td()}>{fmt(wall)}</td>
                                <td style={td(false, T.muted)}>{Math.round((wall / sim.rep.total) * 100)}%</td>
                                <td style={td()}>
                                  <span style={{ color: l.critical ? T.llm : T.faint, fontSize: 11.5 }}>{l.critical ? "✓ critical" : "slack"}</span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : (
                  <div style={panel}>
                    <h2 style={h2}>Latency budget</h2>
                    <p style={sub}>Define the budget before coding; every team then knows its limit. Actuals are wall-clock coverage per stage from the representative trace.</p>
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                        <thead>
                          <tr style={{ color: T.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                            {["Stage", "Budget", "Actual", "Δ", "Status"].map((h) => (
                              <th key={h} style={th(h === "Stage")}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12.5 }}>
                          {BUDGET.map((b) => {
                            const actual = (stageActual && stageActual[b.key]) || 0;
                            const over = actual > b.ms;
                            return (
                              <tr key={b.stage}>
                                <td style={{ ...td(true), fontFamily: "'Space Grotesk', sans-serif" }}>{b.stage}</td>
                                <td style={td(false, T.muted)}>{fmt(b.ms)}</td>
                                <td style={td()}>{fmt(actual)}</td>
                                <td style={td(false, over ? T.bad : T.good)}>{(over ? "+" : "−") + fmt(Math.abs(actual - b.ms))}</td>
                                <td style={td()}>
                                  <span style={{ color: over ? T.bad : T.good, fontSize: 11.5 }}>{over ? "over" : "within"}</span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
