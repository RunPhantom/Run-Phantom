import { expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { closeDb, getDrizzleDb, upsertRun } from "../src/db";
import { EvaluationMcpFixture, cleanupError, type FixtureControls } from "./helpers/evaluation-mcp-fixture";

// This guard is independent of the subject cleanup, including during RED controls.
async function releaseControl(fixture: EvaluationMcpFixture, previous: string | undefined) {
  if (fixture.client?.transport) await fixture.client.close();
  if (fixture.mcp?.mcp.transport) await fixture.mcp.close();
  if (fixture.server?.listening) await new Promise<void>((resolve, reject) => fixture.server!.close(error => error ? reject(error) : resolve()));
  if (fixture.report?.stages.find(item => item.stage === "db-close")?.succeeded !== true) closeDb();
  if (previous === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = previous;
  if (fixture.directory && existsSync(fixture.directory)) {
    rmSync(fixture.directory, { recursive: true, force: true });
    return true;
  }
  return false;
}

function controls(overrides: FixtureControls = {}) {
  let removals = 0;
  return { options: { ...overrides, removeDirectory(directory: string) { removals++; rmSync(directory, { recursive: true, force: true }); } }, count: () => removals };
}

function callbackFailure(sentinel: Error): NonNullable<FixtureControls["closeHttp"]> {
  return (server, callback) => server.close(error => callback(error ?? sentinel));
}

test("owned MCP fixture closes real HTTP, MCP and SQLite before its single removal", async () => {
  const previous = process.env.RUNPHANTOM_DB_PATH;
  const removal = controls(); const fixture = new EvaluationMcpFixture(removal.options);
  try {
    await fixture.setup();
    const native = getDrizzleDb().$client;
    upsertRun({ id: "owned-fixture-run", name: "synthetic", started_at: 1, last_updated_at: 2 });
    const result = await fixture.client!.callTool({ name: "get_run_outline", arguments: { run_id: "owned-fixture-run" } });
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text).run.id).toBe("owned-fixture-run");
    const response = await fetch(`${fixture.url}/api/runs`);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject([{ id: "owned-fixture-run" }]);
    const report = await fixture.cleanup();
    expect(report.failures).toEqual([]);
    expect(report.stages.find(item => item.stage === "http-close")?.succeeded).toBe(true);
    expect(fixture.server!.listening).toBe(false);
    expect(() => native.query("SELECT 1").get()).toThrow();
    expect(process.env.RUNPHANTOM_DB_PATH).toBe(previous);
    expect(existsSync(fixture.directory!)).toBe(false); expect(removal.count()).toBe(1);
  } finally { await releaseControl(fixture, previous); }
});

test("partial real acquisition retains the setup Error and releases its owned server and DB", async () => {
  const outerDb = process.env.RUNPHANTOM_DB_PATH;
  process.env.RUNPHANTOM_DB_PATH = "synthetic-prior-mcp.db";
  const previous = process.env.RUNPHANTOM_DB_PATH; const primary = new Error("owned MCP setup sentinel");
  const removal = controls({ afterHttpReady() { upsertRun({ id: "partial", started_at: 1, last_updated_at: 2 }); throw primary; } });
  const fixture = new EvaluationMcpFixture(removal.options);
  try {
    let caught: unknown;
    try { await fixture.setup(); } catch (error) { caught = error; }
    expect(caught).toBe(primary);
    expect(fixture.server!.listening).toBe(false);
    expect(process.env.RUNPHANTOM_DB_PATH).toBe(previous);
    expect(fixture.client).toBeUndefined(); expect(fixture.mcp).toBeUndefined();
    expect(fixture.report?.stages.find(item => item.stage === "client-close")?.attempted).toBe(false);
    expect(existsSync(fixture.directory!)).toBe(false); expect(removal.count()).toBe(1);
  } finally {
    await releaseControl(fixture, previous);
    if (outerDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = outerDb;
  }
});

test("an actual HTTP close followed by callback Error remains failed without skipping later cleanup", async () => {
  const previous = process.env.RUNPHANTOM_DB_PATH; const sentinel = new Error("owned MCP HTTP-close sentinel");
  const removal = controls({ closeHttp: callbackFailure(sentinel) }); const fixture = new EvaluationMcpFixture(removal.options);
  try {
    await fixture.setup();
    const report = await fixture.cleanup();
    expect(report.failures).toEqual([{ stage: "http-close", error: sentinel }]);
    expect(fixture.server!.listening).toBe(false);
    expect(report.stages.find(item => item.stage === "http-close")?.succeeded).toBe(false);
    expect(report.stages.find(item => item.stage === "db-close")?.succeeded).toBe(true);
    expect(process.env.RUNPHANTOM_DB_PATH).toBe(previous); expect(existsSync(fixture.directory!)).toBe(false);
    expect(removal.count()).toBe(1);
    const aggregate = cleanupError(report); expect(aggregate.errors[0]).toBe(sentinel);
  } finally { await releaseControl(fixture, previous); }
});

test("a real client close rejection and HTTP callback Error both survive later cleanup", async () => {
  const previous = process.env.RUNPHANTOM_DB_PATH; const first = new Error("owned MCP client-close sentinel"); const second = new Error("owned MCP second-close sentinel");
  const removal = controls({ async closeClient(client) { await client.close(); throw first; }, closeHttp: callbackFailure(second) });
  const fixture = new EvaluationMcpFixture(removal.options);
  try {
    await fixture.setup();
    const report = await fixture.cleanup();
    expect(report.failures.map(item => item.error)).toEqual([first, second]);
    expect(report.stages.find(item => item.stage === "mcp-close")?.succeeded).toBe(true);
    expect(fixture.server!.listening).toBe(false); expect(process.env.RUNPHANTOM_DB_PATH).toBe(previous);
    expect(existsSync(fixture.directory!)).toBe(false); expect(removal.count()).toBe(1);
    expect(await fixture.cleanup()).toBe(report); expect(removal.count()).toBe(1);
  } finally { await releaseControl(fixture, previous); }
});

test("setup primary and real-close cleanup sentinel retain both original identities", async () => {
  const previous = process.env.RUNPHANTOM_DB_PATH; const primary = new Error("owned MCP primary setup sentinel"); const cleanup = new Error("owned MCP setup-cleanup sentinel");
  const removal = controls({ afterHttpReady() { throw primary; }, closeHttp: callbackFailure(cleanup) });
  const fixture = new EvaluationMcpFixture(removal.options);
  try {
    let caught: unknown; try { await fixture.setup(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError; expect(aggregate.errors).toEqual([primary, cleanup]); expect(aggregate.cause).toBe(primary);
    expect(fixture.server!.listening).toBe(false); expect(process.env.RUNPHANTOM_DB_PATH).toBe(previous);
    expect(existsSync(fixture.directory!)).toBe(false); expect(removal.count()).toBe(1);
  } finally { await releaseControl(fixture, previous); }
});

// This is an injected removal failure, not a native Windows EBUSY reproduction.
test("one removal failure retains its Error and bounded diagnostics even when Error projection throws", async () => {
  const previous = process.env.RUNPHANTOM_DB_PATH;
  const sentinel = new Error("owned MCP synthetic removal sentinel");
  const projection = new Error("owned MCP diagnostic projection sentinel");
  Object.defineProperty(sentinel, "code", { get() { throw projection; } });
  Object.assign(sentinel, { syscall: "rm" });
  let attempts = 0;
  const fixture = new EvaluationMcpFixture({ removeDirectory() { attempts++; throw sentinel; } });
  let guardRemoved = false;
  try {
    await fixture.setup();
    Object.assign(sentinel, { path: fixture.directory });
    for (let index = 0; index < 20; index++) writeFileSync(`${fixture.directory}/private-payload-name-${index}`, "SYNTHETIC_PAYLOAD_NOT_FOR_DIAGNOSTICS");
    const report = await fixture.cleanup();
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].stage).toBe("directory-remove");
    expect(report.failures[0].error).toBe(sentinel);
    expect(report.failures.some(item => item.error === projection)).toBe(false);
    expect(attempts).toBe(1); expect(await fixture.cleanup()).toBe(report); expect(attempts).toBe(1);
    for (const name of ["client-close", "mcp-close", "http-close", "db-close", "env-restore"]) {
      expect(report.stages.find(item => item.stage === name)?.succeeded).toBe(true);
    }
    expect(fixture.server!.listening).toBe(false); expect(existsSync(fixture.directory!)).toBe(true);
    const diagnostic = report.removalDiagnostics!;
    expect(diagnostic.error).toEqual({ path: "<fixture>", code: undefined, syscall: "rm", issues: ["code"] });
    for (const snapshot of [diagnostic.before, diagnostic.after]) {
      expect(snapshot.exists).toBe(true); expect(snapshot.truncated).toBe(true); expect(snapshot.members.length).toBeLessThanOrEqual(16);
      for (const member of snapshot.members) expect(member.label).toMatch(/^(evaluations\.db(?:-(?:wal|shm|journal))?|member-\d+)$/);
    }
    const attached = JSON.stringify(cleanupError(report));
    for (const excluded of [fixture.directory!, previous, "private-payload-name-", "SYNTHETIC_PAYLOAD_NOT_FOR_DIAGNOSTICS", sentinel.message, projection.message]) {
      if (excluded) expect(attached).not.toContain(excluded);
    }
  } finally {
    // Separate control ownership removes the retained directory only after all
    // real closes; the subject cleanup is never retried.
    guardRemoved = await releaseControl(fixture, previous);
  }
  expect(guardRemoved).toBe(true); expect(attempts).toBe(1);
});
