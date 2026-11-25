import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearAll, closeDb, getDbPath, getDrizzleDb } from "../src/db";
import { createServer } from "../src/server";
import { LIST_PRICE_REVISIONS } from "../src/pricing/list-prices";
import { computeOverview } from "../src/stats/overview";
import { clearRunFactsCache } from "../src/stats/run-facts";
import { FIXTURE_NOW, seedMetricsFixture } from "./fixtures/metrics-seed";

const HOUR = 3_600_000;
let directory: string;
let oldDb: string | undefined;

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), "rp-overview-"));
  oldDb = process.env.RUNPHANTOM_DB_PATH;
  closeDb();
  process.env.RUNPHANTOM_DB_PATH = path.join(directory, "overview.db");
  getDrizzleDb();
});
beforeEach(() => { clearAll(); clearRunFactsCache(); });
afterAll(() => {
  closeDb();
  if (oldDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = oldDb;
  rmSync(directory, { recursive: true, force: true });
});

const overview = (query: Record<string, string> = {}, now = FIXTURE_NOW) => computeOverview(getDrizzleDb().$client, getDbPath(), query, now);

describe("GET /api/overview computation", () => {
  test("KPIs and previous-window values match the hand-counted fixture", () => {
    seedMetricsFixture(getDrizzleDb().$client);
    const result = overview();
    expect(result.window).toEqual({ selection: "24h", from: FIXTURE_NOW - 24 * HOUR, to: FIXTURE_NOW, previousFrom: FIXTURE_NOW - 48 * HOUR, previousTo: FIXTURE_NOW - 24 * HOUR, bucketMs: HOUR, tzOffsetMinutes: 0, field: "startedAt" });
    expect(result.pricing).toEqual({ estimateMode: "list-prices", rateCount: LIST_PRICE_REVISIONS.length, revision: "runphantom-list-prices/2026-11-25", asOf: "2026-11-25" });
    expect(result.kpis).toEqual({
      runs: { value: 5, previous: 2 },
      running: { value: 1, previous: 0 },
      completed: { value: 2, previous: 1 },
      completedWithErrors: { value: 1, previous: 0 },
      failed: { value: 1, previous: 1 },
      interrupted: { value: 0, previous: 0 },
      cancelled: { value: 0, previous: 0 },
      unknown: { value: 0, previous: 0 },
      failureRate: { value: 0.25, previous: 0.5 },
      errorRate: { value: 0.5, previous: 0.5 },
      durationP50Ms: { value: 10_000, previous: 4_000, knownRuns: 4 },
      durationP95Ms: { value: 30_000, previous: 6_000, knownRuns: 4 },
      inputTokens: { value: 1650, previous: 10, knownCalls: 5, unknownCalls: 0 },
      outputTokens: { value: 210, previous: 5, knownCalls: 4, unknownCalls: 1 },
      costUsd: { value: 0.01655, previous: 0.001, knownCalls: 4, unknownCalls: 1, reportedCalls: 3, estimatedCalls: 1, previousUnknownCalls: 0 },
      activeAgents: { value: 2, previous: 2 },
    });
  });

  test("agent and model tables, failing tools, failures and live runs", () => {
    seedMetricsFixture(getDrizzleDb().$client);
    const result = overview();
    expect(result.byAgent).toEqual([
      { agent: "alpha", runs: 3, failed: 0, completedWithErrors: 1, failureRate: 0, inputTokens: 1400, outputTokens: 170, tokenUnknownCalls: 0, costUsd: 0.01255, costKnownCalls: 3, costUnknownCalls: 0, durationP50Ms: 10_000, durationP95Ms: 20_000 },
      { agent: "beta", runs: 2, failed: 1, completedWithErrors: 0, failureRate: 1, inputTokens: 250, outputTokens: 40, tokenUnknownCalls: 1, costUsd: 0.004, costKnownCalls: 1, costUnknownCalls: 1, durationP50Ms: 30_000, durationP95Ms: 30_000 },
    ]);
    expect(result.byModel).toEqual([
      { model: "gpt-4o-mini", provider: "openai", runs: 4, failed: 1, completedWithErrors: 0, failureRate: 1 / 3, inputTokens: 1350, outputTokens: 160, tokenUnknownCalls: 1, costUsd: 0.016, costKnownCalls: 3, costUnknownCalls: 1, calls: 4, callP50Ms: 1_000, callP95Ms: 4_000, durationP50Ms: 10_000, durationP95Ms: 30_000 },
      { model: "claude-haiku-4-5", provider: "anthropic", runs: 1, failed: 0, completedWithErrors: 1, failureRate: 0, inputTokens: 300, outputTokens: 50, tokenUnknownCalls: 0, costUsd: 0.00055, costKnownCalls: 1, costUnknownCalls: 0, calls: 1, callP50Ms: 1_500, callP95Ms: 1_500, durationP50Ms: 20_000, durationP95Ms: 20_000 },
    ]);
    expect(result.topFailingTools).toEqual([
      { tool: "run_tests", failures: 2, calls: 2, failedRuns: 2, lastError: { message: "Expected status 401, got 200.", runId: "r-tool-err", spanId: "tests", at: FIXTURE_NOW - 2 * HOUR + 2_000 } },
    ]);
    expect(result.recentFailures).toEqual([
      { runId: "r-tool-err", name: "alpha", agent: "alpha", status: "completed_with_errors", startedAt: FIXTURE_NOW - 2 * HOUR, errorCount: 1, error: { spanId: "tests", step: "run_tests", message: "Expected status 401, got 200." } },
      { runId: "r-failed", name: "beta", agent: "beta", status: "failed", startedAt: FIXTURE_NOW - 3 * HOUR, errorCount: 2, error: { spanId: "tests", step: "run_tests", message: "FAIL suite auth" } },
    ]);
    expect(result.liveRuns).toEqual([
      { runId: "r-running", name: "beta", agent: "beta", startedAt: FIXTURE_NOW - 5 * 60_000, lastUpdatedAt: FIXTURE_NOW - 60_000, spanCount: 2, model: "gpt-4o-mini" },
    ]);
    expect(result.truncated).toEqual({ byAgent: false, byModel: false });
  });

  test("hourly buckets cover the window and carry each run in its start hour", () => {
    seedMetricsFixture(getDrizzleDb().$client);
    const { timeseries } = overview();
    expect(timeseries).toHaveLength(25);
    expect(timeseries[0].start).toBe(Date.UTC(2027, 0, 14, 12));
    expect(timeseries[24].start).toBe(Date.UTC(2027, 0, 15, 12));
    expect(timeseries.reduce((sum, bucket) => sum + bucket.runs, 0)).toBe(5);
    const at = (hour: number) => timeseries.find(bucket => bucket.start === Date.UTC(2027, 0, 15, hour))!;
    expect(timeseries.map(bucket => bucket.partial)).toEqual([true, ...Array(23).fill(false), true]);
    expect(at(11)).toEqual({ start: Date.UTC(2027, 0, 15, 11), end: Date.UTC(2027, 0, 15, 12), partial: false, runs: 1, finished: 1, failed: 0, completedWithErrors: 0, inputTokens: 100, outputTokens: 20, tokenUnknownCalls: 0, costUsd: 0.002, costUnknownCalls: 0, durationP95Ms: 10_000 });
    expect(at(9)).toMatchObject({ runs: 1, failed: 1, inputTokens: 200, costUsd: 0.004, durationP95Ms: 30_000 });
    expect(at(10)).toMatchObject({ runs: 1, completedWithErrors: 1, costUsd: 0.00055, costUnknownCalls: 0 });
    expect(at(12)).toMatchObject({ runs: 1, inputTokens: 50, outputTokens: 0, tokenUnknownCalls: 1, durationP95Ms: null, costUsd: null, costUnknownCalls: 1 });
    expect(at(3)).toMatchObject({ runs: 0, costUsd: 0, costUnknownCalls: 0, durationP95Ms: null });
  });

  test("bucket sizes per window and local-day alignment", () => {
    seedMetricsFixture(getDrizzleDb().$client);
    expect(overview({ window: "1h" }).timeseries.map(bucket => [bucket.end - bucket.start, bucket.partial])).toEqual(Array(12).fill([300_000, false]));
    const unaligned = overview({ window: "1h" }, FIXTURE_NOW + 60_000).timeseries;
    expect(unaligned).toHaveLength(13);
    expect(unaligned.map(bucket => bucket.partial)).toEqual([true, ...Array(11).fill(false), true]);
    expect([unaligned[0].start, unaligned[12].end]).toEqual([FIXTURE_NOW - HOUR, FIXTURE_NOW + 5 * 60_000]);
    expect(overview({ window: "7d" }).window.bucketMs).toBe(6 * HOUR);
    const month = overview({ window: "30d", tz_offset_minutes: "330" });
    expect(month.timeseries).toHaveLength(31);
    expect(month.timeseries[0].start).toBe(Date.UTC(2026, 11, 16) - 330 * 60_000);
    expect(month.kpis.runs).toEqual({ value: 8, previous: 0 });
  });

  test("models rank by calls, the measure the Home panel shows", () => {
    seedMetricsFixture(getDrizzleDb().$client);
    const client = getDrizzleDb().$client;
    const at = FIXTURE_NOW - HOUR;
    client.query("INSERT INTO runs(id,name,event_name,started_at,last_updated_at) VALUES('chatty','gamma','gamma',?,?)").run(at, at + 60_000);
    const insert = client.prepare(`INSERT INTO spans(run_id,id,parent_span_id,name,span_type,status,start_time_ms,end_time_ms,duration_ms,model,provider) VALUES('chatty',?,?,?,?,?,?,?,?,?,?)`);
    insert.run("root", null, "gamma", "AGENT_ROOT", "OK", at, at + 60_000, 60_000, null, null);
    for (let index = 0; index < 6; index++) insert.run(`llm-${index}`, "root", "chat", "LLM_GENERATION", "OK", at + index * 100, at + index * 100 + 50, 50, "claude-haiku-4-5", "anthropic");
    expect(overview().byModel.map(row => [row.model, row.calls, row.runs])).toEqual([["claude-haiku-4-5", 7, 2], ["gpt-4o-mini", 4, 4]]);
  });

  test("failing tools count every failure in a run, beyond the stored error sample", () => {
    const client = getDrizzleDb().$client;
    const at = FIXTURE_NOW - HOUR;
    client.query("INSERT INTO runs(id,name,event_name,started_at,last_updated_at) VALUES('many','omega','omega',?,?)").run(at, at + 60_000);
    const insert = client.prepare(`INSERT INTO spans(run_id,id,parent_span_id,name,span_type,status,start_time_ms,end_time_ms,duration_ms,attributes) VALUES('many',?,?,?,?,?,?,?,?,?)`);
    insert.run("root", null, "omega", "AGENT_ROOT", "OK", at, at + 60_000, 60_000, null);
    for (let index = 0; index < 30; index++) insert.run(`fetch-${index}`, "root", "fetch_url", "TOOL_CALL", "ERROR", at + 100 + index * 10, at + 105 + index * 10, 5, JSON.stringify({ "error.message": `Attempt ${index} returned 503.` }));
    const result = overview();
    expect(result.topFailingTools).toEqual([
      { tool: "fetch_url", failures: 30, calls: 30, failedRuns: 1, lastError: { message: "Attempt 29 returned 503.", runId: "many", spanId: "fetch-29", at: at + 390 } },
    ]);
    expect(result.recentFailures[0]).toMatchObject({ runId: "many", errorCount: 30, error: { spanId: "fetch-0", message: "Attempt 0 returned 503." } });
  });

  test("agent and model filters narrow every section", () => {
    seedMetricsFixture(getDrizzleDb().$client);
    const alpha = overview({ agent: "alpha" });
    expect(alpha.filters).toEqual({ agent: "alpha", model: null });
    expect(alpha.kpis.runs).toEqual({ value: 3, previous: 1 });
    expect(alpha.byAgent.map(row => row.agent)).toEqual(["alpha"]);
    expect(alpha.liveRuns).toEqual([]);
    const haiku = overview({ model: "claude-haiku-4-5" });
    expect(haiku.kpis.runs.value).toBe(1);
    expect(haiku.kpis.inputTokens).toMatchObject({ value: 300, knownCalls: 1 });
    expect(haiku.byModel.map(row => row.model)).toEqual(["claude-haiku-4-5"]);
    expect(haiku.topFailingTools[0]).toMatchObject({ tool: "run_tests", failures: 1 });
  });

  test("unreported calls are estimated from the bundled list prices, dated ids included", () => {
    seedMetricsFixture(getDrizzleDb().$client);
    const client = getDrizzleDb().$client;
    const at = FIXTURE_NOW - 6 * HOUR;
    client.query("INSERT INTO runs(id,name,event_name,started_at,last_updated_at) VALUES('priced','delta','delta',?,?)").run(at, at + 4_000);
    const insert = client.prepare(`INSERT INTO spans(run_id,id,parent_span_id,name,span_type,status,start_time_ms,end_time_ms,duration_ms,model,provider,input_tokens,output_tokens,attributes)
      VALUES('priced',?,?,?,?,'OK',?,?,?,?,?,?,?,?)`);
    insert.run("root", null, "delta", "AGENT_ROOT", at, at + 4_000, 4_000, null, null, null, null, null);
    // claude-haiku-4-5-20251001 at $1 / $5 per million: 2,000 × 1 + 400 × 5 = $0.004.
    insert.run("haiku", "root", "chat", "LLM_GENERATION", at + 100, at + 1_100, 1_000, "claude-haiku-4-5-20251001", "anthropic", 2_000, 400, null);
    // The response model is not priced, so the requested gpt-4.1-mini prices it ($0.40 / $1.60): 1,000 × 0.4 + 500 × 1.6 = $0.0012.
    insert.run("mini", "root", "chat", "LLM_GENERATION", at + 1_200, at + 2_000, 800, "gpt-4.1-mini-custom", "openai", 1_000, 500, JSON.stringify({ "gen_ai.request.model": "gpt-4.1-mini", "gen_ai.response.model": "gpt-4.1-mini-custom" }));
    // An invalid reported cost is never replaced by an estimate.
    insert.run("invalid", "root", "chat", "LLM_GENERATION", at + 2_100, at + 2_600, 500, "gpt-4o-mini", "openai", 10, 10, JSON.stringify({ "gen_ai.usage.cost_usd": "free" }));
    const result = overview();
    expect(result.kpis.costUsd).toEqual({ value: 0.02175, previous: 0.001, knownCalls: 6, unknownCalls: 2, reportedCalls: 3, estimatedCalls: 3, previousUnknownCalls: 0 });
    expect(result.byAgent.find(row => row.agent === "delta")).toMatchObject({ costUsd: 0.0052, costKnownCalls: 2, costUnknownCalls: 1 });
    expect(result.byModel.find(row => row.model === "claude-haiku-4-5-20251001")).toMatchObject({ costUsd: 0.004, costKnownCalls: 1, costUnknownCalls: 0 });
    expect(result.byModel.find(row => row.model === "gpt-4.1-mini-custom")).toMatchObject({ costUsd: 0.0012, costKnownCalls: 1 });
    expect(result.timeseries.find(bucket => bucket.start === Date.UTC(2027, 0, 15, 6))).toMatchObject({ runs: 1, costUsd: 0.0052, costUnknownCalls: 1 });
    expect(overview({ model: "claude-haiku-4-5-20251001" }).kpis.costUsd).toMatchObject({ value: 0.004, knownCalls: 1, unknownCalls: 0, estimatedCalls: 1 });
  });

  test("an empty store answers with zeros and unknowns, never invented values", () => {
    const result = overview();
    expect(result.kpis.runs).toEqual({ value: 0, previous: 0 });
    expect(result.kpis.failureRate).toEqual({ value: null, previous: null });
    expect(result.kpis.durationP95Ms).toEqual({ value: null, previous: null, knownRuns: 0 });
    expect(result.kpis.costUsd.value).toBeNull();
    expect(result.kpis.inputTokens.value).toBeNull();
    expect(result.byAgent).toEqual([]);
    expect(result.timeseries.every(bucket => bucket.runs === 0 && bucket.durationP95Ms === null)).toBe(true);
  });
});

describe("GET /api/overview over HTTP", () => {
  test("serves the overview and rejects invalid parameters", async () => {
    seedMetricsFixture(getDrizzleDb().$client, Date.now());
    const { server } = await createServer(0);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const response = await fetch(`${origin}/api/overview?window=24h`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body).toMatchObject({ version: "runphantom-overview/1", kpis: { runs: { value: 5, previous: 2 } } });
      for (const bad of ["window=2h", "window=24h&window=7d", "tz_offset_minutes=900", "tz_offset_minutes=1.5", "tz_offset_minutes=0x10", "tz_offset_minutes=1e2", "tz_offset_minutes=+60", "tz_offset_minutes=%2060"]) {
        const rejected = await fetch(`${origin}/api/overview?${bad}`);
        expect(rejected.status).toBe(400);
        expect(typeof (await rejected.json()).error).toBe("string");
      }
    } finally {
      server.close();
    }
  });
});
