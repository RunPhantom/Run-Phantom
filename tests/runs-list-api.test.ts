import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearAll, closeDb, getDbPath, getDrizzleDb, getRuns } from "../src/db";
import { createServer } from "../src/server";
import { registerServerCostRates } from "../src/stats/cost-rates";
import { clearRunFactsCache } from "../src/stats/run-facts";
import { listRuns } from "../src/stats/runs-list";
import { FIXTURE_NOW, nominalRate, seedMetricsFixture } from "./fixtures/metrics-seed";

const HOUR = 3_600_000;
let directory: string;
let oldDb: string | undefined;

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), "rp-run-list-"));
  oldDb = process.env.RUNPHANTOM_DB_PATH;
  closeDb();
  process.env.RUNPHANTOM_DB_PATH = path.join(directory, "runs.db");
  getDrizzleDb();
});
beforeEach(() => { clearAll(); clearRunFactsCache(); registerServerCostRates(null); seedMetricsFixture(getDrizzleDb().$client); });
afterAll(() => {
  registerServerCostRates(null);
  closeDb();
  if (oldDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = oldDb;
  rmSync(directory, { recursive: true, force: true });
});

const list = (query: Record<string, string> = {}) => listRuns(getDrizzleDb().$client, getDbPath(), query);
const ids = (query: Record<string, string> = {}) => list(query).runs.map(run => run.id);

describe("GET /api/runs rows", () => {
  test("keeps every legacy field and value, in the legacy order", () => {
    const legacy = getRuns(5000);
    const rows = list().runs;
    expect(rows.map(row => row.id)).toEqual(legacy.map(row => row.id));
    for (const [index, row] of rows.entries()) {
      for (const [key, value] of Object.entries(legacy[index])) expect({ key, value: row[key as keyof typeof row] }).toEqual({ key, value });
    }
  });

  test("adds duration, tokens, cost, errors, tools, model and input preview", () => {
    const byId = new Map(list().runs.map(row => [row.id, row]));
    expect(byId.get("r-ok")).toMatchObject({
      status: "completed", agent: "alpha", duration_ms: 10_000, input_tokens: 100, output_tokens: 20, est_cost_usd: 0.002, cost_source: "reported",
      error_count: 0, tool_count: 1, model: "gpt-4o-mini", provider: "openai", models: ["gpt-4o-mini"], input_preview: "Summarise the March invoices for ACME and flag anything overdue.",
    });
    expect(byId.get("r-tool-err")).toMatchObject({ status: "completed_with_errors", duration_ms: 20_000, input_tokens: 300, output_tokens: 50, est_cost_usd: null, cost_source: "unknown", error_count: 1, tool_count: 2, input_preview: "Review PR 842" });
    expect(byId.get("r-failed")).toMatchObject({ status: "failed", duration_ms: 30_000, error_count: 2, est_cost_usd: 0.004, input_preview: null });
    expect(byId.get("r-running")).toMatchObject({ status: "running", finished: 0, duration_ms: null, input_tokens: 50, output_tokens: null, est_cost_usd: null, cost_source: "unknown" });
    expect(byId.get("r-nested")).toMatchObject({ input_tokens: 1000, output_tokens: 100, est_cost_usd: 0.01, cost_source: "reported", display_name: "Nested calls" });
    expect(byId.get("old")).toMatchObject({ status: "completed", input_tokens: null, est_cost_usd: null, cost_source: "unknown", model: null, models: [] });
  });

  test("estimates unreported calls from a registered price table", () => {
    registerServerCostRates(() => ({ estimateMode: "nominal-input-output", rates: [nominalRate("claude-haiku-4-5", 1, 5)] }));
    expect(list().runs.find(row => row.id === "r-tool-err")).toMatchObject({ est_cost_usd: 0.00055, cost_source: "estimated" });
  });
});

describe("GET /api/runs parameters", () => {
  test("filters by status, agent, model, text and start time", () => {
    expect(ids({ status: "failed" })).toEqual(["r-failed", "p-failed"]);
    expect(ids({ status: "completed_with_errors,running" })).toEqual(["r-running", "r-tool-err"]);
    expect(ids({ agent: "alpha", sort: "started_at" })).toEqual(["r-ok", "r-tool-err", "r-nested", "p-ok", "old"]);
    expect(ids({ model: "claude-haiku-4-5" })).toEqual(["r-tool-err"]);
    expect(ids({ q: "march INVOICES" })).toEqual(["r-ok"]);
    expect(ids({ q: "nested" })).toEqual(["r-nested"]);
    expect(ids({ since: String(FIXTURE_NOW - 2 * HOUR), sort: "started_at" })).toEqual(["r-running", "r-ok", "r-tool-err"]);
    expect(ids({ since: new Date(FIXTURE_NOW - 48 * HOUR).toISOString(), until: String(FIXTURE_NOW - 24 * HOUR), sort: "started_at" })).toEqual(["p-ok", "p-failed"]);
  });

  test("sorts by metric with unknown values last in either direction", () => {
    expect(ids({ sort: "cost" })).toEqual(["r-nested", "r-failed", "r-ok", "p-ok", "r-tool-err", "r-running", "p-failed", "old"]);
    expect(ids({ sort: "cost", order: "asc" })).toEqual(["p-ok", "r-ok", "r-failed", "r-nested", "old", "p-failed", "r-running", "r-tool-err"]);
    expect(ids({ sort: "duration" })).toEqual(["r-failed", "r-tool-err", "r-ok", "p-failed", "r-nested", "p-ok", "old", "r-running"]);
    expect(ids({ sort: "tokens" }).slice(0, 3)).toEqual(["r-nested", "r-tool-err", "r-failed"]);
    expect(ids({ sort: "errors" }).slice(0, 3)).toEqual(["r-failed", "r-tool-err", "p-failed"]);
  });

  test("cursor pages walk the sorted list exactly once", () => {
    const first = list({ sort: "cost", limit: "3" });
    expect(first.runs.map(run => run.id)).toEqual(["r-nested", "r-failed", "r-ok"]);
    expect(first).toMatchObject({ total: 8, hasMore: true });
    const second = list({ sort: "cost", limit: "3", cursor: first.nextCursor! });
    expect(second.runs.map(run => run.id)).toEqual(["p-ok", "r-tool-err", "r-running"]);
    const third = list({ sort: "cost", limit: "3", cursor: second.nextCursor! });
    expect(third.runs.map(run => run.id)).toEqual(["p-failed", "old"]);
    expect(third).toMatchObject({ hasMore: false, nextCursor: null });
    expect(() => list({ sort: "duration", limit: "3", cursor: first.nextCursor! })).toThrow(/cursor is invalid/);
  });

  test("rejects malformed parameters", () => {
    for (const query of [{ status: "done" }, { sort: "name" }, { order: "up" }, { since: "yesterday" }, { since: "200", until: "100" }, { cursor: "!!" }, { envelope: "yes" }, { q: "x".repeat(257) }]) {
      expect(() => list(query)).toThrow();
    }
  });
});

describe("GET /api/runs over HTTP", () => {
  test("returns a bare array by default and a page envelope on request", async () => {
    const { server } = await createServer(0);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const legacy = await fetch(`${origin}/api/runs?limit=2`);
      expect(legacy.status).toBe(200);
      expect(legacy.headers.get("x-total-count")).toBe("8");
      expect(legacy.headers.get("x-next-cursor")).toBeTruthy();
      const rows = await legacy.json();
      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toHaveLength(2);
      const page = await (await fetch(`${origin}/api/runs?envelope=1&sort=cost&limit=3&status=all`)).json();
      expect(page).toMatchObject({ total: 8, hasMore: true });
      expect(page.runs.map((run: { id: string }) => run.id)).toEqual(["r-nested", "r-failed", "r-ok"]);
      const next = await (await fetch(`${origin}/api/runs?envelope=1&sort=cost&limit=3&status=all&cursor=${page.nextCursor}`)).json();
      expect(next.runs[0].id).toBe("p-ok");
      const rejected = await fetch(`${origin}/api/runs?sort=nope`);
      expect(rejected.status).toBe(400);
      expect((await rejected.json()).error).toContain("sort must be one of");
      expect((await fetch(`${origin}/api/runs?limit=abc`)).status).toBe(200);
    } finally {
      server.close();
    }
  });
});
