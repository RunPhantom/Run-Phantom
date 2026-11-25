import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearAll, closeDb, getDbPath, getDrizzleDb } from "../src/db";
import { createServer } from "../src/server";
import { registerServerCostRates } from "../src/stats/cost-rates";
import { computeOverview } from "../src/stats/overview";
import { clearRunFactsCache } from "../src/stats/run-facts";
import { FIXTURE_NOW, nominalRate, seedMetricsFixture } from "./fixtures/metrics-seed";

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
beforeEach(() => { clearAll(); clearRunFactsCache(); registerServerCostRates(null); });
afterAll(() => {
  registerServerCostRates(null);
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
    expect(result.pricing).toEqual({ estimateMode: "captured", rateCount: 0 });
    expect(result.kpis).toEqual({
      runs: { value: 5, previous: 2 },
      running: { value: 1, previous: 0 },
      completed: { value: 2, previous: 1 },
      completedWithErrors: { value: 1, previous: 0 },
      failed: { value: 1, previous: 1 },
      failureRate: { value: 0.25, previous: 0.5 },
      errorRate: { value: 0.5, previous: 0.5 },
      durationP50Ms: { value: 10_000, previous: 4_000, knownRuns: 4 },
      durationP95Ms: { value: 30_000, previous: 6_000, knownRuns: 4 },
      inputTokens: { value: 1650, previous: 10, knownCalls: 5, unknownCalls: 0 },
      outputTokens: { value: 210, previous: 5, knownCalls: 4, unknownCalls: 1 },
      costUsd: { value: 0.016, previous: 0.001, knownCalls: 3, unknownCalls: 2, reportedCalls: 3, estimatedCalls: 0, previousUnknownCalls: 0 },
      activeAgents: { value: 2, previous: 2 },
    });
  });

  test("agent and model tables, failing tools, failures and live runs", () => {
    seedMetricsFixture(getDrizzleDb().$client);
    const result = overview();
    expect(result.byAgent).toEqual([
      { agent: "alpha", runs: 3, failed: 0, completedWithErrors: 1, failureRate: 0, inputTokens: 1400, outputTokens: 170, tokenUnknownCalls: 0, costUsd: 0.012, costKnownCalls: 2, costUnknownCalls: 1, durationP50Ms: 10_000, durationP95Ms: 20_000 },
      { agent: "beta", runs: 2, failed: 1, completedWithErrors: 0, failureRate: 1, inputTokens: 250, outputTokens: 40, tokenUnknownCalls: 1, costUsd: 0.004, costKnownCalls: 1, costUnknownCalls: 1, durationP50Ms: 30_000, durationP95Ms: 30_000 },
    ]);
    expect(result.byModel).toEqual([
      { model: "gpt-4o-mini", provider: "openai", runs: 4, failed: 1, completedWithErrors: 0, failureRate: 1 / 3, inputTokens: 1350, outputTokens: 160, tokenUnknownCalls: 1, costUsd: 0.016, costKnownCalls: 3, costUnknownCalls: 1, calls: 4, callP50Ms: 1_000, callP95Ms: 4_000 },
      { model: "claude-haiku-4-5", provider: "anthropic", runs: 1, failed: 0, completedWithErrors: 1, failureRate: 0, inputTokens: 300, outputTokens: 50, tokenUnknownCalls: 0, costUsd: null, costKnownCalls: 0, costUnknownCalls: 1, calls: 1, callP50Ms: 1_500, callP95Ms: 1_500 },
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
    expect(at(11)).toEqual({ start: Date.UTC(2027, 0, 15, 11), end: Date.UTC(2027, 0, 15, 12), runs: 1, failed: 0, completedWithErrors: 0, inputTokens: 100, outputTokens: 20, costUsd: 0.002, costUnknownCalls: 0, durationP95Ms: 10_000 });
    expect(at(9)).toMatchObject({ runs: 1, failed: 1, inputTokens: 200, costUsd: 0.004, durationP95Ms: 30_000 });
    expect(at(10)).toMatchObject({ runs: 1, completedWithErrors: 1, costUsd: null, costUnknownCalls: 1 });
    expect(at(12)).toMatchObject({ runs: 1, durationP95Ms: null, costUsd: null, costUnknownCalls: 1 });
    expect(at(3)).toMatchObject({ runs: 0, costUsd: 0, costUnknownCalls: 0, durationP95Ms: null });
  });

  test("bucket sizes per window and local-day alignment", () => {
    seedMetricsFixture(getDrizzleDb().$client);
    expect(overview({ window: "1h" }).timeseries.map(bucket => bucket.end - bucket.start)).toEqual(Array(12).fill(300_000));
    expect(overview({ window: "7d" }).window.bucketMs).toBe(6 * HOUR);
    const month = overview({ window: "30d", tz_offset_minutes: "330" });
    expect(month.timeseries).toHaveLength(31);
    expect(month.timeseries[0].start).toBe(Date.UTC(2026, 11, 16) - 330 * 60_000);
    expect(month.kpis.runs).toEqual({ value: 8, previous: 0 });
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

  test("a registered price table estimates unreported calls and labels them", () => {
    seedMetricsFixture(getDrizzleDb().$client);
    registerServerCostRates(() => ({ estimateMode: "nominal-input-output", rates: [nominalRate("claude-haiku-4-5", 1, 5)] }));
    const result = overview();
    expect(result.pricing).toEqual({ estimateMode: "nominal-input-output", rateCount: 1 });
    expect(result.kpis.costUsd).toMatchObject({ value: 0.01655, knownCalls: 4, unknownCalls: 1, reportedCalls: 3, estimatedCalls: 1 });
    expect(result.byModel.find(row => row.model === "claude-haiku-4-5")).toMatchObject({ costUsd: 0.00055, costKnownCalls: 1 });
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
      for (const bad of ["window=2h", "window=24h&window=7d", "tz_offset_minutes=900", "tz_offset_minutes=1.5"]) {
        const rejected = await fetch(`${origin}/api/overview?${bad}`);
        expect(rejected.status).toBe(400);
        expect(typeof (await rejected.json()).error).toBe("string");
      }
    } finally {
      server.close();
    }
  });
});
