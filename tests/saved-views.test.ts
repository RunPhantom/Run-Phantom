import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearAll, closeDb, getDbPath, getDrizzleDb } from "../src/db";
import { createServer } from "../src/server";
import { clearRunFactsCache } from "../src/stats/run-facts";
import { RUN_LIST_SORTS, countRuns, listRuns } from "../src/stats/runs-list";
import { RUN_OUTCOMES } from "../src/run-status";
import {
  RUNS_TABLE_COLUMNS,
  RUNS_VIEW_SORTS,
  RUNS_VIEW_STATUSES,
  RUNS_VIEW_WINDOWS,
  filtersEqual,
  filtersFromSearchParams,
  filtersToSearchParams,
  hasActiveFilters,
  parseRunsTableColumns,
  parseRunsViewFilters,
  parseSavedViewCreate,
  parseSavedViewUpdate,
  runsListQuery,
  savedViewPath,
} from "../src/saved-views-protocol";
import { createSavedView, deleteSavedView, listSavedViews, savedViewsPath, savedViewsWithCounts, updateSavedView } from "../src/saved-views";
import { seedMetricsFixture } from "./fixtures/metrics-seed";

let directory: string;
let oldDb: string | undefined;

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), "rp-saved-views-"));
  oldDb = process.env.RUNPHANTOM_DB_PATH;
  closeDb();
  process.env.RUNPHANTOM_DB_PATH = path.join(directory, "runs.db");
  getDrizzleDb();
});
beforeEach(() => {
  clearAll();
  clearRunFactsCache();
  seedMetricsFixture(getDrizzleDb().$client);
  rmSync(path.join(directory, "saved-views.json"), { force: true });
});
afterAll(() => {
  closeDb();
  if (oldDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = oldDb;
  rmSync(directory, { recursive: true, force: true });
});

describe("runs view filters", () => {
  test("mirror the GET /api/runs statuses and sorts", () => {
    expect([...RUNS_VIEW_STATUSES]).toEqual([...RUN_OUTCOMES]);
    expect([...RUNS_VIEW_SORTS]).toEqual([...RUN_LIST_SORTS]);
  });

  test("round-trip through canonical URL parameters", () => {
    const filters = parseRunsViewFilters({ status: ["failed", "running"], agent: "triage_agent", model: "gpt-5-nano", window: "24h", q: "invoice", sort: "cost", order: "asc" });
    expect(filters.status).toEqual(["running", "failed"]);
    const params = filtersToSearchParams(filters);
    expect(params.toString()).toBe("status=running%2Cfailed&agent=triage_agent&model=gpt-5-nano&window=24h&q=invoice&sort=cost&order=asc");
    expect(filtersFromSearchParams(params)).toEqual(filters);
    expect(filtersEqual(filtersFromSearchParams(new URLSearchParams("q=invoice&status=failed,running&window=24h&agent=triage_agent&model=gpt-5-nano&order=asc&sort=cost")), filters)).toBe(true);
  });

  test("drop defaults and the all-statuses selection so equal lists give equal URLs", () => {
    expect(parseRunsViewFilters({ status: [...RUNS_VIEW_STATUSES], sort: "last_updated_at", order: "desc", q: "  " })).toEqual({});
    expect(hasActiveFilters({ sort: "cost" })).toBe(false);
    expect(hasActiveFilters({ q: "x" })).toBe(true);
  });

  test("drop invalid URL values instead of failing the page", () => {
    const filters = filtersFromSearchParams(new URLSearchParams("status=done,failed&window=2y&since=abc&sort=name&order=up&q=hi"));
    expect(filters).toEqual({ status: ["failed"], q: "hi" });
    expect(filtersFromSearchParams(new URLSearchParams("since=200&until=100"))).toEqual({});
    expect(filtersFromSearchParams(new URLSearchParams("window=7d&since=100"))).toEqual({ window: "7d" });
  });

  test("reject bad stored values with a plain-English message", () => {
    expect(() => parseRunsViewFilters({ status: ["done"] })).toThrow("status must be one of");
    expect(() => parseRunsViewFilters({ sort: "name" })).toThrow("sort must be one of");
    expect(() => parseRunsViewFilters({ q: "x".repeat(257) })).toThrow("at most 256");
    expect(() => parseRunsViewFilters({ since: 200, until: 100 })).toThrow("until must be later than since");
    expect(() => parseRunsViewFilters({ extra: 1 })).toThrow("unknown field: extra");
  });

  test("resolve a relative window against the request time", () => {
    const now = 10_000_000_000;
    expect(runsListQuery({ window: "1h", status: ["failed"] }, now)).toEqual({ status: "failed", since: String(now - RUNS_VIEW_WINDOWS["1h"]), sort: "last_updated_at", order: "desc" });
    expect(runsListQuery({ since: 5, until: 9 }, now)).toEqual({ since: "5", until: "9", sort: "last_updated_at", order: "desc" });
  });

  test("columns keep their order, drop duplicates and always include the run column", () => {
    expect(parseRunsTableColumns(["cost", "status", "cost"])).toEqual(["run", "cost", "status"]);
    expect(parseRunsTableColumns(null)).toBeNull();
    expect(() => parseRunsTableColumns(["colour"])).toThrow("column must be one of");
    expect(RUNS_TABLE_COLUMNS).toContain("steps");
  });

  test("saved view input requires a short name", () => {
    expect(() => parseSavedViewCreate({ filters: {} })).toThrow("name is required");
    expect(() => parseSavedViewCreate({ name: "x".repeat(81) })).toThrow("at most 80");
    expect(parseSavedViewCreate({ name: " Failures ", filters: { status: ["failed"] } })).toEqual({ name: "Failures", filters: { status: ["failed"] }, columns: null });
    expect(() => parseSavedViewUpdate({})).toThrow("no fields");
    expect(parseSavedViewUpdate({ name: "Renamed" })).toEqual({ name: "Renamed" });
    expect(savedViewPath({ id: "abc", filters: { status: ["failed"] } })).toBe("/runs?status=failed&view=abc");
  });
});

describe("saved views store", () => {
  test("creates, renames, updates and deletes views in a file beside the database", () => {
    const dbPath = getDbPath();
    const file = savedViewsPath(dbPath)!;
    expect(path.basename(file)).toBe("saved-views.json");
    expect(path.dirname(file)).toBe(path.dirname(path.resolve(dbPath)));
    const view = createSavedView(dbPath, { name: "Failures", filters: { status: ["failed"] }, columns: null }, 1000);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(listSavedViews(dbPath)).toEqual([view]);
    const renamed = updateSavedView(dbPath, view.id, { name: "Broken runs", columns: ["run", "cost"] }, 2000);
    expect(renamed).toMatchObject({ id: view.id, name: "Broken runs", columns: ["run", "cost"], createdAt: 1000, updatedAt: 2000 });
    expect(listSavedViews(dbPath)).toEqual([renamed]);
    deleteSavedView(dbPath, view.id);
    expect(listSavedViews(dbPath)).toEqual([]);
    expect(readdirSync(directory).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  test("rejects duplicate names, missing views and more than 50 views", () => {
    const dbPath = getDbPath();
    const first = createSavedView(dbPath, { name: "Failures", filters: {}, columns: null });
    expect(() => createSavedView(dbPath, { name: "failures", filters: {}, columns: null })).toThrow('A view named "failures" already exists');
    const second = createSavedView(dbPath, { name: "Slow", filters: { sort: "duration" }, columns: null });
    expect(() => updateSavedView(dbPath, second.id, { name: "FAILURES" })).toThrow("already exists");
    expect(() => updateSavedView(dbPath, "missing", { name: "x" })).toThrow("Saved view not found");
    expect(() => deleteSavedView(dbPath, "missing")).toThrow("Saved view not found");
    for (let index = 2; index < 50; index++) createSavedView(dbPath, { name: `View ${index}`, filters: {}, columns: null });
    expect(() => createSavedView(dbPath, { name: "One too many", filters: {}, columns: null })).toThrow("up to 50 saved views");
    expect(listSavedViews(dbPath)[0]).toEqual(first);
  });

  test("survives Clear all runs", () => {
    const view = createSavedView(getDbPath(), { name: "Kept", filters: {}, columns: null });
    clearAll();
    expect(listSavedViews(getDbPath())).toEqual([view]);
  });

  test("moves an unreadable file aside rather than overwriting it", () => {
    const file = savedViewsPath(getDbPath())!;
    writeFileSync(file, "{not json");
    expect(listSavedViews(getDbPath())).toEqual([]);
    const aside = readdirSync(directory).find(name => name.startsWith("saved-views.json.unreadable-"));
    expect(aside).toBeTruthy();
    expect(readFileSync(path.join(directory, aside!), "utf8")).toBe("{not json");
    rmSync(path.join(directory, aside!));
  });

  test("keeps a copy of entries it cannot read before a write drops them", () => {
    const dbPath = getDbPath();
    const file = savedViewsPath(dbPath)!;
    const valid = { id: "keep1", name: "Kept", filters: {}, columns: null, createdAt: 1, updatedAt: 1 };
    const original = JSON.stringify({ version: 1, views: [valid, { id: "bad", name: "Future", filters: { colour: "red" }, createdAt: 1, updatedAt: 1 }] });
    writeFileSync(file, original);
    expect(listSavedViews(dbPath)).toEqual([valid]);
    expect(readdirSync(directory).filter(name => name.includes(".invalid-entries-"))).toEqual([]);
    createSavedView(dbPath, { name: "New", filters: {}, columns: null });
    const aside = readdirSync(directory).filter(name => name.startsWith("saved-views.json.invalid-entries-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(path.join(directory, aside[0]!), "utf8")).toBe(original);
    expect(listSavedViews(dbPath).map(view => view.name)).toEqual(["Kept", "New"]);
    rmSync(path.join(directory, aside[0]!));
  });

  test("refuses to overwrite a file from a newer version", () => {
    const dbPath = getDbPath();
    const file = savedViewsPath(dbPath)!;
    const original = JSON.stringify({ version: 2, views: [{ id: "next1", name: "Next", filters: {}, columns: null, createdAt: 1, updatedAt: 1 }] });
    writeFileSync(file, original);
    expect(listSavedViews(dbPath).map(view => view.name)).toEqual(["Next"]);
    expect(() => createSavedView(dbPath, { name: "New", filters: {}, columns: null })).toThrow("newer version");
    expect(() => deleteSavedView(dbPath, "next1")).toThrow("newer version");
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  test("counts match the run list totals for the same filters", () => {
    const db = getDrizzleDb().$client;
    const dbPath = getDbPath();
    const queries = [{}, { status: "failed" }, { status: "completed,completed_with_errors" }, { agent: "triage_agent" }, { q: "zzz-no-match" }];
    expect(countRuns(db, dbPath, queries)).toEqual(queries.map(query => listRuns(db, dbPath, { ...query, limit: "1" }).total));
    const starts = listRuns(db, dbPath, { sort: "started_at", order: "asc" }).runs.map(run => run.started_at);
    const middle = starts[Math.floor(starts.length / 2)]!;
    const bounded = [{ since: String(middle) }, { since: String(starts[0]), until: String(middle) }, { since: String(middle), status: "failed" }];
    const expected = bounded.map(query => listRuns(db, dbPath, { ...query, limit: "1" }).total);
    expect(expected[0]).toBeGreaterThan(0);
    expect(expected[1]).toBeGreaterThan(0);
    expect(countRuns(db, dbPath, bounded)).toEqual(expected);
    expect(countRuns(db, dbPath, bounded.slice(1, 2))).toEqual([expected[1]]);
    const views = [
      createSavedView(dbPath, { name: "All", filters: {}, columns: null }),
      createSavedView(dbPath, { name: "Failed", filters: { status: ["failed"] }, columns: null }),
    ];
    const counted = savedViewsWithCounts(views, list => countRuns(db, dbPath, list));
    expect(counted.map(view => view.count)).toEqual([listRuns(db, dbPath, {}).total, listRuns(db, dbPath, { status: "failed" }).total]);
    expect(savedViewsWithCounts(views, () => { throw new Error("boom"); }).map(view => view.count)).toEqual([null, null]);
  });
});

describe("/api/saved-views over HTTP", () => {
  test("lists views with live counts and supports create, rename and delete", async () => {
    const { server } = await createServer(0);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const send = (method: string, route: string, body?: unknown) => fetch(`${origin}${route}`, {
      method, headers: { "content-type": "application/json", origin }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    try {
      expect(await (await fetch(`${origin}/api/saved-views`)).json()).toEqual({ views: [] });
      const created = await send("POST", "/api/saved-views", { name: "Failed runs", filters: { status: ["failed"] }, columns: ["run", "status", "cost"] });
      expect(created.status).toBe(201);
      const { view } = await created.json();
      expect(view).toMatchObject({ name: "Failed runs", filters: { status: ["failed"] }, columns: ["run", "status", "cost"] });
      const failedTotal = listRuns(getDrizzleDb().$client, getDbPath(), { status: "failed" }).total;
      const listed = await (await fetch(`${origin}/api/saved-views`)).json();
      expect(listed.views).toEqual([{ ...view, count: failedTotal }]);
      expect((await send("POST", "/api/saved-views", { name: "failed runs" })).status).toBe(409);
      const bad = await send("POST", "/api/saved-views", { name: "Bad", filters: { sort: "name" } });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toContain("sort must be one of");
      const renamed = await send("PATCH", `/api/saved-views/${view.id}`, { name: "Root failures" });
      expect(renamed.status).toBe(200);
      expect((await renamed.json()).view.name).toBe("Root failures");
      expect((await send("PATCH", "/api/saved-views/nope", { name: "x" })).status).toBe(404);
      expect((await send("DELETE", `/api/saved-views/${view.id}`)).status).toBe(200);
      expect((await send("DELETE", `/api/saved-views/${view.id}`)).status).toBe(404);
      expect(await (await fetch(`${origin}/api/saved-views`)).json()).toEqual({ views: [] });
    } finally {
      server.close();
    }
  });
});
