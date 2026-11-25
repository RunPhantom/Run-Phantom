import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearAll, closeDb, getDbPath, getDrizzleDb } from "../src/db";
import { searchRuns, _runSearchInternal } from "../src/run-search";
import { RUN_OUTCOMES, RUN_STATUSES, RUN_STATUS_FILTER_VALUES, deriveRunStatus, runOutcome, runStatusFilterMembers, type RunStatus } from "../src/run-status";
import { computeOverview } from "../src/stats/overview";
import { clearRunFactsCache } from "../src/stats/run-facts";
import { countRuns, listRuns } from "../src/stats/runs-list";

const MINUTE = 60_000;
let directory: string;
let oldDb: string | undefined;

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), "rp-status-agreement-"));
  oldDb = process.env.RUNPHANTOM_DB_PATH;
  closeDb();
  process.env.RUNPHANTOM_DB_PATH = path.join(directory, "agreement.db");
  getDrizzleDb();
});
beforeEach(() => { clearAll(); clearRunFactsCache(); });
afterEach(async () => {
  const until = Date.now() + 10_000;
  while (_runSearchInternal.activeWorkers() && Date.now() < until) await Bun.sleep(5);
});
afterAll(() => {
  closeDb();
  if (oldDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = oldDb;
  rmSync(directory, { recursive: true, force: true });
});

const db = () => getDrizzleDb().$client;

function run(id: string, lastUpdatedAgo: number, metadata: string | null = null) {
  const now = Date.now();
  db().query("INSERT INTO runs(id,name,started_at,last_updated_at,metadata) VALUES(?,?,?,?,?)").run(id, id, now - 3 * 60 * MINUTE, now - lastUpdatedAgo, metadata);
}
function span(runId: string, id: string, type: string, status: string, parent: string | null = null, attributes: string | null = null) {
  const start = Date.now() - 3 * 60 * MINUTE;
  db().query("INSERT INTO spans(run_id,id,parent_span_id,name,span_type,status,start_time_ms,end_time_ms,duration_ms,attributes) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(runId, id, parent, id, type, status, start, start + 1000, 1000, attributes);
}

/** One run per RunStatus, built the way each status arises, plus a failed replay placeholder. */
function seedEveryStatus(): Record<string, RunStatus> {
  run("live", 0); span("live", "root", "AGENT_ROOT", "UNSET"); span("live", "llm", "LLM_GENERATION", "OK", "root");
  run("quiet", 2 * MINUTE); span("quiet", "root", "AGENT_ROOT", "UNSET"); span("quiet", "llm", "LLM_GENERATION", "OK", "root");
  run("complete", 60 * MINUTE); span("complete", "root", "AGENT_ROOT", "OK"); span("complete", "llm", "LLM_GENERATION", "OK", "root");
  run("with-errors", 60 * MINUTE); span("with-errors", "root", "AGENT_ROOT", "OK"); span("with-errors", "tool", "TOOL_CALL", "ERROR", "root");
  run("failed", 60 * MINUTE); span("failed", "root", "AGENT_ROOT", "ERROR"); span("failed", "tool", "TOOL_CALL", "ERROR", "root");
  run("replay-failed", 60 * MINUTE, JSON.stringify({ replay: { error: { code: "provider_error", message: "boom" } } }));
  run("replay-cancelled", 60 * MINUTE, JSON.stringify({ replay: { error: { code: "replay_cancelled" } } }));
  run("interrupted", 120 * MINUTE); span("interrupted", "orphan", "LLM_GENERATION", "OK", "missing-parent");
  run("no-spans", 120 * MINUTE);
  return {
    live: "live", quiet: "quiet", complete: "complete", "with-errors": "completed_with_errors", failed: "failed",
    "replay-failed": "failed", "replay-cancelled": "cancelled", interrupted: "interrupted", "no-spans": "unknown",
  };
}

const sorted = (ids: Iterable<string>) => [...ids].sort();

describe("one run status model", () => {
  test("every path agrees with deriveRunStatus for every RunStatus and every filter value", async () => {
    const expected = seedEveryStatus();
    expect(sorted(new Set(Object.values(expected)))).toEqual(sorted(RUN_STATUSES));
    const store = db(), dbPath = getDbPath();

    const rows = listRuns(store, dbPath, { envelope: "1" }).runs;
    expect(Object.fromEntries(rows.map(row => [row.id, row.run_status]))).toEqual(expected);
    for (const row of rows) {
      expect(deriveRunStatus(row).status).toBe(row.run_status);
      expect(row.status).toBe(runOutcome(row.run_status));
    }

    const searched = (await searchRuns({ limit: 50 })).runs;
    expect(Object.fromEntries(searched.map(row => [row.id, row.status]))).toEqual(expected);
    for (const row of searched) expect(deriveRunStatus(row).status).toBe(row.status as RunStatus);
    const errorCounts = Object.fromEntries(rows.map(row => [row.id, row.error_count]));
    expect(Object.fromEntries(searched.map(row => [row.id, row.error_count]))).toEqual(errorCounts);
    expect(errorCounts).toMatchObject({ failed: 1, "with-errors": 1, complete: 0 });

    for (const value of RUN_STATUS_FILTER_VALUES) {
      const members = runStatusFilterMembers(value);
      const want = sorted(Object.keys(expected).filter(id => members.includes(expected[id])));
      expect({ value, ids: sorted(listRuns(store, dbPath, { status: value }).runs.map(row => row.id)) }).toEqual({ value, ids: want });
      expect({ value, ids: sorted((await searchRuns({ status: value, limit: 50 })).runs.map(row => row.id)) }).toEqual({ value, ids: want });
      expect({ value, count: countRuns(store, dbPath, [{ status: value }])[0] }).toEqual({ value, count: want.length });
    }

    const overview = computeOverview(store, dbPath, { window: "24h" });
    const byOutcome = (outcome: string) => Object.values(expected).filter(status => runOutcome(status) === outcome).length;
    const kpiKey = { running: "running", completed: "completed", completed_with_errors: "completedWithErrors", failed: "failed", interrupted: "interrupted", cancelled: "cancelled", unknown: "unknown" } as const;
    for (const outcome of RUN_OUTCOMES) expect({ outcome, value: overview.kpis[kpiKey[outcome]].value }).toEqual({ outcome, value: byOutcome(outcome) });
    expect(overview.kpis.failureRate.value).toBe(2 / 4);
    expect(overview.kpis.errorRate.value).toBe(3 / 4);
    expect(sorted(overview.liveRuns.map(item => item.runId))).toEqual(["live", "quiet"]);
    expect(sorted(overview.recentFailures.map(item => item.runId))).toEqual(["failed", "replay-failed", "with-errors"]);
    expect(overview.timeseries.reduce((sum, bucket) => sum + bucket.finished, 0)).toBe(4);
  });

  test("a partial hook capture: the run list says unknown, search classifies it by span evidence", async () => {
    const session = JSON.stringify({ captureContract: "runphantom.codex-hook.observation/v1", source: "codex_hook", entityKind: "session", coverage: "partial", producerVerified: false, runtimeVerified: false, reportedPhase: "unknown" });
    run("hook", 120 * MINUTE); span("hook", "root", "AGENT_ROOT", "UNSET", null, session);
    const store = db(), dbPath = getDbPath();
    const [row] = listRuns(store, dbPath, { envelope: "1" }).runs;
    expect([row.run_status, row.capture_completion, deriveRunStatus(row).label]).toEqual(["unknown", "unavailable", "Completion unavailable"]);
    expect(countRuns(store, dbPath, [{ status: "unknown" }, { status: "interrupted" }])).toEqual([1, 0]);
    // Documented gap (run-status-sql.ts): SQL cannot run the hook-capture validation, so search sees an open root gone quiet.
    expect((await searchRuns({ limit: 5 })).runs.map(item => [item.id, item.status])).toEqual([["hook", "interrupted"]]);
  });

  test("a run that stops sending spans leaves running for interrupted everywhere", async () => {
    run("stalled", 2 * MINUTE); span("stalled", "root", "AGENT_ROOT", "UNSET");
    const store = db(), dbPath = getDbPath();
    expect(listRuns(store, dbPath, { status: "running" }).runs.map(row => row.id)).toEqual(["stalled"]);
    expect(computeOverview(store, dbPath, {}).kpis.running.value).toBe(1);
    store.query("UPDATE runs SET last_updated_at=? WHERE id='stalled'").run(Date.now() - 11 * MINUTE);
    expect(listRuns(store, dbPath, { status: "running" }).runs).toEqual([]);
    expect(listRuns(store, dbPath, { status: "interrupted" }).runs.map(row => row.id)).toEqual(["stalled"]);
    expect((await searchRuns({ status: "interrupted" })).runs.map(row => row.id)).toEqual(["stalled"]);
    const overview = computeOverview(store, dbPath, {});
    expect([overview.kpis.running.value, overview.kpis.interrupted.value, overview.liveRuns.length]).toEqual([0, 1, 0]);
  });
});
