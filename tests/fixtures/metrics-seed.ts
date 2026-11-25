import type { Database } from "bun:sqlite";

export interface MetricsSeedOptions {
  runs: number;
  now: number;
  spanMs?: number;
  seed?: number;
}

const MODELS = [
  { model: "gpt-4o-mini-2024-07-18", provider: "openai" },
  { model: "claude-haiku-4-5-20251001", provider: "anthropic" },
  { model: "gemini-2.5-flash", provider: "google" },
] as const;
const AGENTS = ["triage_agent", "code_review_agent", "research_agent", "billing_agent", "support_bot"];
const TOOLS = ["web_search", "fetch_url", "run_tests", "lookup_account", "create_ticket"];

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic, realistically sized store for latency tests: ~8 spans and ~2 KB of model attributes per run. */
export function seedMetricsRuns(db: Database, options: MetricsSeedOptions): void {
  const random = prng(options.seed ?? 7);
  const spanMs = options.spanMs ?? 30 * 86_400_000;
  const insertRun = db.prepare("INSERT INTO runs(id,name,event_name,started_at,last_updated_at,metadata) VALUES(?,?,?,?,?,NULL)");
  const insertSpan = db.prepare(`INSERT INTO spans(run_id,id,parent_span_id,name,span_type,status,input_payload,output_payload,start_time_ms,end_time_ms,duration_ms,model,provider,input_tokens,output_tokens,attributes)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const filler = "Context about the customer account, recent tickets and product limits. ".repeat(10);
  db.transaction(() => {
    for (let index = 0; index < options.runs; index++) {
      const id = `seed-${String(index).padStart(6, "0")}`;
      const agent = AGENTS[index % AGENTS.length];
      const started = Math.floor(options.now - random() * spanMs);
      const running = random() < 0.02;
      const rootFailed = !running && random() < 0.03;
      const llmCount = 1 + Math.floor(random() * 3);
      const toolCount = Math.floor(random() * 4);
      let cursor = started + 10;
      const children: Array<() => void> = [];
      for (let call = 0; call < llmCount; call++) {
        const choice = MODELS[(index + call) % MODELS.length];
        const duration = 200 + Math.floor(random() * 3000);
        const input = 200 + Math.floor(random() * 2000);
        const output = 20 + Math.floor(random() * 400);
        const start = cursor;
        cursor += duration + 5;
        const messages = [{ role: "system", content: `You are ${agent}.` }, { role: "user", content: `Request ${index}: please help with order ${index * 7}. ${filler}` }];
        const attributes = JSON.stringify({
          "gen_ai.request.model": choice.model, "gen_ai.response.model": choice.model, "gen_ai.provider.name": choice.provider,
          "gen_ai.usage.input_tokens": input, "gen_ai.usage.output_tokens": output,
          ...(index % 10 === 0 ? { "gen_ai.usage.cost_usd": 0.001 } : {}),
          "gen_ai.input.messages": JSON.stringify(messages),
        });
        children.push(() => insertSpan.run(id, `llm-${call}`, "root", "chat", "LLM_GENERATION", "OK", JSON.stringify({ messages }), "Done.", start, start + duration, duration, choice.model, choice.provider, input, output, attributes));
      }
      for (let tool = 0; tool < toolCount; tool++) {
        const name = TOOLS[(index + tool) % TOOLS.length];
        const failed = random() < 0.08;
        const duration = 20 + Math.floor(random() * 800);
        const start = cursor;
        cursor += duration + 5;
        const attributes = JSON.stringify({ "ai.toolCall.name": name, "ai.toolCall.args": "{}", ...(failed ? { "error.message": `${name} failed. Upstream returned 502.` } : {}) });
        children.push(() => insertSpan.run(id, `tool-${tool}`, "root", name, "TOOL_CALL", failed ? "ERROR" : "OK", "{}", failed ? null : "ok", start, start + duration, duration, null, null, null, null, attributes));
      }
      const end = cursor + 5;
      insertRun.run(id, agent, agent, started, end);
      insertSpan.run(id, "root", null, agent, "AGENT_ROOT", running ? "UNSET" : rootFailed ? "ERROR" : "OK", `Request ${index}`, running ? null : "Finished", started, end, end - started, null, null, null, null, JSON.stringify({ "runphantom.event.name": agent }));
      for (const child of children) child();
    }
  })();
}

export const FIXTURE_NOW = Date.UTC(2027, 0, 15, 12, 30);
const HOUR = 3_600_000;

interface FixtureSpan {
  id: string; parent?: string; name: string; type: string; status?: string; start: number; end: number;
  model?: string; provider?: string; inputTokens?: number; outputTokens?: number;
  attributes?: Record<string, unknown>; input?: string; output?: string;
}

function llmAttributes(model: string, provider: string, input: number | undefined, output: number | undefined, extra: Record<string, unknown> = {}) {
  return {
    "gen_ai.response.model": model, "gen_ai.provider.name": provider,
    ...(input === undefined ? {} : { "gen_ai.usage.input_tokens": input }),
    ...(output === undefined ? {} : { "gen_ai.usage.output_tokens": output }),
    ...extra,
  };
}

/**
 * Hand-built store with known answers for the overview and run-list tests.
 * Times are offsets from FIXTURE_NOW; see tests/overview-api.test.ts for the expected numbers.
 */
export function seedMetricsFixture(db: Database, now = FIXTURE_NOW): void {
  const runs: Array<{ id: string; agent: string; started: number; updated?: number; display?: string; spans: FixtureSpan[] }> = [
    { id: "r-ok", agent: "alpha", started: now - 1 * HOUR, spans: [
      { id: "root", name: "alpha", type: "AGENT_ROOT", status: "OK", start: 0, end: 10_000, input: "Summarise the March invoices" },
      { id: "llm", parent: "root", name: "chat", type: "LLM_GENERATION", status: "OK", start: 100, end: 1_100, model: "gpt-4o-mini", provider: "openai", inputTokens: 100, outputTokens: 20,
        attributes: llmAttributes("gpt-4o-mini", "openai", 100, 20, { "gen_ai.usage.cost_usd": 0.002 }),
        input: JSON.stringify({ messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Summarise the March invoices for ACME   and flag anything overdue." }] }) },
      { id: "tool", parent: "root", name: "search", type: "TOOL_CALL", status: "OK", start: 1_200, end: 1_500, attributes: { "ai.toolCall.name": "search" } },
    ] },
    { id: "r-tool-err", agent: "alpha", started: now - 2 * HOUR, spans: [
      { id: "root", name: "alpha", type: "AGENT_ROOT", status: "OK", start: 0, end: 20_000, input: "Review PR 842" },
      { id: "llm", parent: "root", name: "chat", type: "LLM_GENERATION", status: "OK", start: 100, end: 1_600, model: "claude-haiku-4-5", provider: "anthropic", inputTokens: 300, outputTokens: 50,
        attributes: llmAttributes("claude-haiku-4-5", "anthropic", 300, 50) },
      { id: "tests", parent: "root", name: "run_tests", type: "TOOL_CALL", status: "ERROR", start: 2_000, end: 2_700,
        attributes: { "ai.toolCall.name": "run_tests", "error.message": "Expected status 401, got 200. The session refresh kept the old expiry." } },
      { id: "search", parent: "root", name: "search", type: "TOOL_CALL", status: "OK", start: 3_000, end: 3_100 },
    ] },
    { id: "r-failed", agent: "beta", started: now - 3 * HOUR, spans: [
      { id: "root", name: "beta", type: "AGENT_ROOT", status: "ERROR", start: 0, end: 30_000, attributes: { "otel.status.message": "Agent crashed. Stack follows" } },
      { id: "llm", parent: "root", name: "chat", type: "LLM_GENERATION", status: "OK", start: 100, end: 2_100, model: "gpt-4o-mini", provider: "openai", inputTokens: 200, outputTokens: 40,
        attributes: llmAttributes("gpt-4o-mini", "openai", 200, 40, { "gen_ai.usage.cost_usd": 0.004 }) },
      { id: "tests", parent: "root", name: "run_tests", type: "TOOL_CALL", status: "ERROR", start: 2_500, end: 2_900, output: "FAIL suite auth\nsecond line" },
    ] },
    { id: "r-running", agent: "beta", started: now - 5 * 60_000, updated: now - 60_000, spans: [
      { id: "root", name: "beta", type: "AGENT_ROOT", status: "UNSET", start: 0, end: 0 },
      { id: "llm", parent: "root", name: "chat", type: "LLM_GENERATION", status: "OK", start: 100, end: 600, model: "gpt-4o-mini", provider: "openai", inputTokens: 50,
        attributes: llmAttributes("gpt-4o-mini", "openai", 50, undefined) },
    ] },
    { id: "r-nested", agent: "alpha", started: now - 4 * HOUR, display: "Nested calls", spans: [
      { id: "root", name: "alpha", type: "AGENT_ROOT", status: "OK", start: 0, end: 5_000 },
      { id: "outer", parent: "root", name: "chat", type: "LLM_GENERATION", status: "OK", start: 100, end: 4_100, model: "gpt-4o-mini", provider: "openai", inputTokens: 1000, outputTokens: 100,
        attributes: llmAttributes("gpt-4o-mini", "openai", 1000, 100, { "gen_ai.usage.cost_usd": 0.01 }) },
      { id: "inner", parent: "outer", name: "chat", type: "LLM_GENERATION", status: "OK", start: 200, end: 4_000, model: "gpt-4o-mini", provider: "openai", inputTokens: 999, outputTokens: 99,
        attributes: llmAttributes("gpt-4o-mini", "openai", 999, 99, { "gen_ai.usage.cost_usd": 5 }) },
    ] },
    { id: "p-ok", agent: "alpha", started: now - 30 * HOUR, spans: [
      { id: "root", name: "alpha", type: "AGENT_ROOT", status: "OK", start: 0, end: 4_000 },
      { id: "llm", parent: "root", name: "chat", type: "LLM_GENERATION", status: "OK", start: 100, end: 900, model: "gpt-4o-mini", provider: "openai", inputTokens: 10, outputTokens: 5,
        attributes: llmAttributes("gpt-4o-mini", "openai", 10, 5, { "gen_ai.usage.cost_usd": 0.001 }) },
    ] },
    { id: "p-failed", agent: "gamma", started: now - 40 * HOUR, spans: [
      { id: "root", name: "gamma", type: "AGENT_ROOT", status: "ERROR", start: 0, end: 6_000 },
    ] },
    { id: "old", agent: "alpha", started: now - 100 * HOUR, spans: [
      { id: "root", name: "alpha", type: "AGENT_ROOT", status: "OK", start: 0, end: 1_000 },
    ] },
  ];
  const insertRun = db.prepare("INSERT INTO runs(id,name,event_name,display_name,started_at,last_updated_at) VALUES(?,?,?,?,?,?)");
  const insertSpan = db.prepare(`INSERT INTO spans(run_id,id,parent_span_id,name,span_type,status,input_payload,output_payload,start_time_ms,end_time_ms,duration_ms,model,provider,input_tokens,output_tokens,attributes)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  db.transaction(() => {
    for (const run of runs) {
      const lastEnd = Math.max(...run.spans.map(span => span.end));
      insertRun.run(run.id, run.agent, run.agent, run.display ?? null, run.started, run.updated ?? run.started + lastEnd);
      for (const span of run.spans) insertSpan.run(run.id, span.id, span.parent ?? null, span.name, span.type, span.status ?? "OK", span.input ?? null, span.output ?? null,
        run.started + span.start, run.started + span.end, span.end - span.start, span.model ?? null, span.provider ?? null, span.inputTokens ?? null, span.outputTokens ?? null,
        span.attributes ? JSON.stringify(span.attributes) : null);
    }
  })();
}

/** A nominal input/output price for `model`, shaped like one parsed OpenRouter catalogue entry. */
export function nominalRate(model: string, input: number, output: number) {
  const categories = Object.fromEntries(["input", "output", "cache_read", "cache_write", "cache_write_5m", "cache_write_1h", "reasoning", "audio_input", "audio_output"]
    .map(category => [category, { kind: "not_applicable" }]));
  return {
    version: "runphantom-pricing/1", provider: "openrouter-catalogue", model: `test/${model}`, tier: "nominal-input-output", revision: "test-1", currency: "USD", unit: "usd_per_million_tokens",
    source: { kind: "catalogue", name: "Test catalogue", reference: "https://openrouter.ai/api/v1/models", observedAt: "2027-01-01T00:00:00Z" },
    aliases: [{ provider: "openrouter-catalogue", model, tier: "nominal-input-output" }],
    bands: [{ maxContextTokens: null, categories: { ...categories, input: { kind: "priced", usdPerMillionTokens: input }, output: { kind: "priced", usdPerMillionTokens: output } } }],
  };
}
