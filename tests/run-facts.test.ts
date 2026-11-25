import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearAll, closeDb, getDbPath, getDrizzleDb } from "../src/db";
import { aggregateCostAnalytics, type AnalyticsSpan } from "../src/pricing/analytics";
import { registerServerCostRates, serverCostRates } from "../src/stats/cost-rates";
import { clearRunFactsCache, clip, firstSentence, loadRunRows, RUN_FACT_LIMITS, selectRunAggregates } from "../src/stats/run-facts";
import { deriveRunStatus } from "../src/stats/run-status";
import { nominalRate, seedMetricsRuns } from "./fixtures/metrics-seed";

let directory: string;
let oldDb: string | undefined;

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), "rp-run-facts-"));
  oldDb = process.env.RUNPHANTOM_DB_PATH;
  closeDb();
  process.env.RUNPHANTOM_DB_PATH = path.join(directory, "facts.db");
  getDrizzleDb();
});
beforeEach(() => { clearAll(); clearRunFactsCache(); registerServerCostRates(null); });
afterAll(() => {
  registerServerCostRates(null);
  closeDb();
  if (oldDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = oldDb;
  rmSync(directory, { recursive: true, force: true });
});

const db = () => getDrizzleDb().$client;
const rows = () => loadRunRows(db(), getDbPath(), selectRunAggregates(db(), "1 = 1", []), serverCostRates());
const facts = (id: string) => rows().find(row => row.id === id)!.facts;
function span(runId: string, id: string, options: { parent?: string; type?: string; status?: string; attributes?: string | null; model?: string; input?: number; output?: number; payload?: string } = {}) {
  db().query(`INSERT INTO spans(run_id,id,parent_span_id,name,span_type,status,start_time_ms,end_time_ms,duration_ms,model,provider,input_tokens,output_tokens,attributes,input_payload)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId, id, options.parent ?? null, id, options.type ?? "LLM_GENERATION", options.status ?? "OK", 10, 20, 10,
    options.model ?? null, options.model ? "openai" : null, options.input ?? null, options.output ?? null, options.attributes ?? null, options.payload ?? null);
}
const run = (id: string) => db().query("INSERT INTO runs(id,name,started_at,last_updated_at) VALUES(?,?,1,1)").run(id, id);

describe("deriveRunStatus", () => {
  test("separates failed runs from runs that finished with step errors", () => {
    expect(deriveRunStatus({ rootCount: 0, endedRootCount: 0, rootErrorCount: 0, errorCount: 0 })).toBe("running");
    expect(deriveRunStatus({ rootCount: 1, endedRootCount: 0, rootErrorCount: 0, errorCount: 1 })).toBe("running");
    expect(deriveRunStatus({ rootCount: 1, endedRootCount: 1, rootErrorCount: 0, errorCount: 0 })).toBe("completed");
    expect(deriveRunStatus({ rootCount: 1, endedRootCount: 1, rootErrorCount: 0, errorCount: 2 })).toBe("completed_with_errors");
    expect(deriveRunStatus({ rootCount: 1, endedRootCount: 1, rootErrorCount: 1, errorCount: 1 })).toBe("failed");
    expect(deriveRunStatus({ rootCount: 2, endedRootCount: 1, rootErrorCount: 1, errorCount: 1 })).toBe("failed");
  });
});

describe("run cost and tokens agree with the Cost page aggregation", () => {
  function projection(): AnalyticsSpan[] {
    return (db().query("SELECT run_id, id, parent_span_id, span_type, model, provider, input_tokens, output_tokens, attributes FROM spans").all() as Array<Record<string, unknown>>)
      .map(row => ({ projectId: row.run_id as string, runId: row.run_id as string, id: row.id as string, parentSpanId: row.parent_span_id as string | null, kind: row.span_type as string | null,
        startedAt: 0, model: row.model as string | null, provider: row.provider as string | null, inputTokens: row.input_tokens as number | null, outputTokens: row.output_tokens as number | null,
        attributes: row.attributes as string | null }));
  }
  function seedEdgeCases() {
    run("edge-orphan"); span("edge-orphan", "root", { type: "AGENT_ROOT" }); span("edge-orphan", "llm", { parent: "missing", model: "gpt-4o-mini-2024-07-18", input: 5, output: 6 });
    run("edge-dupe"); span("edge-dupe", "root", { type: "AGENT_ROOT" }); span("edge-dupe", "llm", { parent: "root", model: "gpt-4o-mini-2024-07-18", input: 5, output: 6, attributes: '{"gen_ai.usage.input_tokens":5,"gen_ai.usage.input_tokens":7}' });
    run("edge-nested"); span("edge-nested", "root", { type: "AGENT_ROOT" }); span("edge-nested", "outer", { parent: "root", model: "gemini-2.5-flash", input: 40, output: 4 });
    span("edge-nested", "inner", { parent: "outer", model: "gemini-2.5-flash", input: 30, output: 3 });
    run("edge-columns"); span("edge-columns", "root", { type: "AGENT_ROOT" }); span("edge-columns", "llm", { parent: "root", model: "gemini-2.5-flash", input: 11, output: 12 });
  }

  for (const mode of ["no price table", "nominal price table"] as const) test(`per-run totals match aggregateCostAnalytics with ${mode}`, () => {
    seedMetricsRuns(db(), { runs: 300, now: 2_000_000_000_000, seed: 11 });
    seedEdgeCases();
    if (mode === "nominal price table") registerServerCostRates(() => ({ estimateMode: "nominal-input-output", rates: [nominalRate("gemini-2.5-flash", 0.3, 2.5), nominalRate("gpt-4o-mini-2024-07-18", 0.15, 0.6)] }));
    const rates = serverCostRates();
    const reference = aggregateCostAnalytics(projection(), { from: 0, to: 1, bucket: "day", estimateMode: rates.estimateMode, rates: rates.rates });
    const byRun = new Map(reference.byProject.map(group => [group.identity!, group]));
    let compared = 0;
    for (const row of rows()) {
      const expected = byRun.get(row.id);
      const generations = row.facts.generations;
      if (!expected) { expect(generations).toEqual([]); continue; }
      const sum = (values: Array<number | null>) => values.filter((value): value is number => value !== null).reduce((total, value) => total + value, 0);
      expect(generations.length).toBe(expected.tokens.input.eligibleCount);
      expect(generations.filter(item => item.inputTokens !== null).length).toBe(expected.tokens.input.knownCount);
      expect(sum(generations.map(item => item.inputTokens))).toBe(expected.tokens.input.knownSum ?? 0);
      expect(sum(generations.map(item => item.outputTokens))).toBe(expected.tokens.output.knownSum ?? 0);
      const reported = generations.filter(item => item.costSource === "reported");
      expect(reported.length).toBe(expected.reportedUsd.knownCount);
      expect(sum(reported.map(item => item.costUsd))).toBeCloseTo(expected.reportedUsd.knownSum ?? 0, 12);
      if (!reported.length) {
        const estimated = generations.filter(item => item.costSource === "estimated");
        expect(estimated.length).toBe(expected.estimatedUsd.knownCount);
        expect(sum(estimated.map(item => item.costUsd))).toBeCloseTo(expected.estimatedUsd.knownSum ?? 0, 12);
      }
      compared++;
    }
    expect(compared).toBe(304);
    expect(reference.population.nestedExcluded).toBe(1);
    expect(facts("edge-orphan")).toMatchObject({ inputTokens: null, costUsd: null, costSource: "unknown" });
    expect(facts("edge-dupe")).toMatchObject({ inputTokens: null, outputTokens: null, costSource: "unknown" });
    expect(facts("edge-nested")).toMatchObject({ inputTokens: 40, outputTokens: 4 });
    if (mode === "nominal price table") expect(facts("edge-columns")).toMatchObject({ costUsd: 11 * 0.3 / 1e6 + 12 * 2.5 / 1e6, costSource: "estimated" });
  });
});

describe("run facts cache", () => {
  test("recomputes when a run's spans or the price table change", () => {
    run("cached"); span("cached", "root", { type: "AGENT_ROOT" });
    span("cached", "llm", { parent: "root", attributes: JSON.stringify({ "gen_ai.response.model": "gemini-2.5-flash", "gen_ai.usage.input_tokens": 10, "gen_ai.usage.output_tokens": 2, "gen_ai.usage.cost_usd": 0.5 }) });
    expect(facts("cached")).toMatchObject({ costUsd: 0.5, costSource: "reported", status: "completed" });
    db().query("UPDATE spans SET attributes = ? WHERE run_id = 'cached' AND id = 'llm'").run(JSON.stringify({ "gen_ai.response.model": "gemini-2.5-flash", "gen_ai.usage.input_tokens": 10, "gen_ai.usage.output_tokens": 2, "gen_ai.usage.cost_usd": 0.25 }));
    expect(facts("cached").costUsd).toBe(0.25);
    db().query("UPDATE spans SET status = 'ERROR' WHERE run_id = 'cached' AND id = 'llm'").run();
    expect(facts("cached")).toMatchObject({ status: "completed_with_errors", errorCount: 1 });
    db().query("UPDATE spans SET attributes = ? WHERE run_id = 'cached' AND id = 'llm'").run(JSON.stringify({ "gen_ai.response.model": "gemini-2.5-flash", "gen_ai.usage.input_tokens": 10, "gen_ai.usage.output_tokens": 2 }));
    expect(facts("cached")).toMatchObject({ costUsd: null, costSource: "unknown" });
    registerServerCostRates(() => ({ estimateMode: "nominal-input-output", rates: [nominalRate("gemini-2.5-flash", 1, 10)] }));
    expect(facts("cached").costSource).toBe("estimated");
    expect(facts("cached").costUsd).toBeCloseTo(0.00003, 15);
  });

  test("recomputes when a span is re-typed, renamed, re-modelled or moved without changing its sizes", () => {
    run("shape"); span("shape", "root", { type: "AGENT_ROOT" });
    span("shape", "step", { parent: "root", type: "TOOL_CALL", model: "gpt-4o-mini", input: 7, output: 3 });
    expect(facts("shape")).toMatchObject({ llmCalls: 0, primaryModel: "gpt-4o-mini", toolCalls: { step: 1 } });
    db().query("UPDATE spans SET span_type = 'LLM_GENERATION' WHERE run_id = 'shape' AND id = 'step'").run();
    expect(facts("shape")).toMatchObject({ llmCalls: 1, inputTokens: 7, outputTokens: 3, toolCalls: {} });
    db().query("UPDATE spans SET model = 'gpt-4o-maxi' WHERE run_id = 'shape' AND id = 'step'").run();
    expect(facts("shape").primaryModel).toBe("gpt-4o-maxi");
    db().query("UPDATE spans SET name = 'stop', span_type = 'TOOL_CALL' WHERE run_id = 'shape' AND id = 'step'").run();
    expect(facts("shape").toolCalls).toEqual({ stop: 1 });
    db().query("UPDATE spans SET status = 'ERROR', start_time_ms = 15 WHERE run_id = 'shape' AND id = 'step'").run();
    expect(facts("shape").errors[0]).toMatchObject({ spanId: "step", startMs: 15 });
    db().query("UPDATE spans SET start_time_ms = 16 WHERE run_id = 'shape' AND id = 'step'").run();
    expect(facts("shape").errors[0].startMs).toBe(16);
  });
});

describe("previews and error sentences", () => {
  test("the preview is the first user message, capped at 140 characters on a word boundary", () => {
    const long = `Please reconcile ${"the quarterly ledger entries ".repeat(10)}today`;
    run("preview"); span("preview", "root", { type: "AGENT_ROOT", payload: "root text" });
    span("preview", "llm", { parent: "root", attributes: JSON.stringify({ "gen_ai.response.model": "gpt-4o-mini", "gen_ai.input.messages": JSON.stringify([{ role: "system", content: "Be exact." }, { role: "user", content: long }, { role: "user", content: "second" }]) }) });
    const preview = facts("preview").inputPreview!;
    expect(preview.length).toBeLessThanOrEqual(RUN_FACT_LIMITS.previewChars);
    expect(preview.startsWith("Please reconcile the quarterly ledger entries")).toBe(true);
    expect(preview.endsWith("…")).toBe(true);
    expect(long.startsWith(`${preview.slice(0, -1)} `)).toBe(true);
    run("root-only"); span("root-only", "root", { type: "AGENT_ROOT", payload: JSON.stringify({ prompt: "  Find\nflights  to Lisbon " }) });
    expect(facts("root-only").inputPreview).toBe("Find flights to Lisbon");
  });

  test("error messages keep the first sentence of the first line", () => {
    expect(firstSentence("Expected status 401, got 200. Then more")).toBe("Expected status 401, got 200.");
    expect(firstSentence("\n  FAIL auth/middleware.test.ts > rejects\nnext")).toBe("FAIL auth/middleware.test.ts > rejects");
    expect(firstSentence("   ")).toBeNull();
    expect(clip("a".repeat(300), 10)).toBe(`${"a".repeat(9)}…`);
    run("errors"); span("errors", "root", { type: "AGENT_ROOT" });
    span("errors", "tool", { parent: "root", type: "TOOL_CALL", status: "ERROR", attributes: JSON.stringify({ "ai.toolCall.result": "Timed out after 30s! Retrying" }) });
    expect(facts("errors").errors).toEqual([{ spanId: "tool", name: "tool", spanType: "TOOL_CALL", startMs: 10, message: "Timed out after 30s!" }]);
    expect(facts("errors").toolCalls).toEqual({ tool: 1 });
  });
});
