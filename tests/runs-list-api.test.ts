import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearAll, closeDb, getDbPath, getDrizzleDb, getRuns } from "../src/db";
import { createServer } from "../src/server";
import { clearRunFactsCache } from "../src/stats/run-facts";
import { listRuns } from "../src/stats/runs-list";
import { FIXTURE_NOW, seedMetricsFixture } from "./fixtures/metrics-seed";

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
beforeEach(() => { clearAll(); clearRunFactsCache(); seedMetricsFixture(getDrizzleDb().$client); });
afterAll(() => {
  closeDb();
  if (oldDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = oldDb;
  rmSync(directory, { recursive: true, force: true });
});

const list = (query: Record<string, string | string[]> = {}) => listRuns(getDrizzleDb().$client, getDbPath(), query);
const ids = (query: Record<string, string | string[]> = {}) => list(query).runs.map(run => run.id);

describe("GET /api/runs rows", () => {
  test("keeps every legacy field and value, in the legacy order", () => {
    const legacy = getRuns(5000);
    const rows = list().runs;
    expect(rows.map(row => row.id)).toEqual(legacy.map(row => row.id));
    for (const [index, row] of rows.entries()) {
      for (const [key, value] of Object.entries(legacy[index])) expect({ key, value: row[key as keyof typeof row] }).toEqual({ key, value });
    }
  });

  test("keeps the legacy model rule when span models disagree, and adds primary_model", () => {
    const client = getDrizzleDb().$client;
    client.query("INSERT INTO runs(id,name,event_name,started_at,last_updated_at) VALUES('r-models','delta','delta',?,?)").run(FIXTURE_NOW - 6 * HOUR, FIXTURE_NOW - 6 * HOUR + 3_000);
    const insert = client.prepare(`INSERT INTO spans(run_id,id,parent_span_id,name,span_type,status,start_time_ms,end_time_ms,duration_ms,model,provider,attributes) VALUES('r-models',?,?,?,?,'OK',?,?,?,?,?,?)`);
    const at = FIXTURE_NOW - 6 * HOUR;
    insert.run("late-llm", "root", "chat", "LLM_GENERATION", at + 2_000, at + 2_500, 500, "gpt-4.1-mini", "openai", JSON.stringify({ "gen_ai.response.model": "gpt-4.1-mini-2025-04-14", "gen_ai.usage.input_tokens": 3, "gen_ai.usage.output_tokens": 1 }));
    insert.run("root", null, "delta", "AGENT_ROOT", at, at + 3_000, 3_000, "root-configured-model", null, null);
    insert.run("outer", "root", "chat", "LLM_GENERATION", at + 100, at + 1_000, 900, null, null, JSON.stringify({ "gen_ai.response.model": "gpt-4o-mini", "gen_ai.usage.input_tokens": 5, "gen_ai.usage.output_tokens": 2 }));
    insert.run("inner", "outer", "chat", "LLM_GENERATION", at + 50, at + 900, 850, "gpt-5-nano", "openai", null);
    const legacy = getRuns(5000).find(row => row.id === "r-models")!;
    const row = list().runs.find(item => item.id === "r-models")!;
    expect(legacy.model).toBe("gpt-4.1-mini");
    for (const [key, value] of Object.entries(legacy)) expect({ key, value: row[key as keyof typeof row] }).toEqual({ key, value });
    expect(row).toMatchObject({ primary_model: "gpt-4o-mini", models: ["gpt-4o-mini", "gpt-4.1-mini-2025-04-14"] });
    expect(ids({ model: "root-configured-model" })).toEqual([]);
  });

  test("adds duration, tokens, cost, errors, tools, model and input preview", () => {
    const byId = new Map(list().runs.map(row => [row.id, row]));
    expect(byId.get("r-ok")).toMatchObject({
      status: "completed", agent: "alpha", duration_ms: 10_000, input_tokens: 100, output_tokens: 20, est_cost_usd: 0.002, cost_source: "reported",
      error_count: 0, tool_count: 1, model: "gpt-4o-mini", primary_model: "gpt-4o-mini", provider: "openai", models: ["gpt-4o-mini"], input_preview: "Summarise the March invoices for ACME and flag anything overdue.",
      llm_calls: 1, known_input_tokens: 100, known_output_tokens: 20, token_unknown_calls: 0, known_cost_usd: 0.002, known_cost_source: "reported", cost_unknown_calls: 0,
    });
    expect(byId.get("r-tool-err")).toMatchObject({ status: "completed_with_errors", duration_ms: 20_000, input_tokens: 300, output_tokens: 50, est_cost_usd: 0.00055, cost_source: "estimated", error_count: 1, tool_count: 2, input_preview: "Review PR 842" });
    expect(byId.get("r-failed")).toMatchObject({ status: "failed", duration_ms: 30_000, error_count: 2, est_cost_usd: 0.004, input_preview: null });
    expect(byId.get("r-running")).toMatchObject({ status: "running", finished: 0, duration_ms: null, input_tokens: 50, output_tokens: null, est_cost_usd: null, cost_source: "unknown",
      llm_calls: 1, known_input_tokens: 50, known_output_tokens: null, token_unknown_calls: 1, known_cost_usd: null, cost_unknown_calls: 1 });
    expect(byId.get("r-tool-err")).toMatchObject({ llm_calls: 1, known_cost_usd: 0.00055, cost_unknown_calls: 0 });
    expect(byId.get("r-nested")).toMatchObject({ input_tokens: 1000, output_tokens: 100, est_cost_usd: 0.01, cost_source: "reported", display_name: "Nested calls" });
    expect(byId.get("old")).toMatchObject({ status: "completed", input_tokens: null, est_cost_usd: null, cost_source: "unknown", model: null, primary_model: null, models: [], llm_calls: 0, known_input_tokens: null, token_unknown_calls: 0 });
  });

  test("estimates unreported calls from the bundled list prices and keeps mixed runs truthful", () => {
    const client = getDrizzleDb().$client;
    const at = FIXTURE_NOW - 6 * HOUR;
    client.query("INSERT INTO runs(id,name,event_name,started_at,last_updated_at) VALUES('mixed','mixed','mixed',?,?)").run(at, at + 5_000);
    const insert = client.prepare(`INSERT INTO spans(run_id,id,parent_span_id,name,span_type,status,start_time_ms,end_time_ms,duration_ms,model,provider,input_tokens,output_tokens,attributes)
      VALUES('mixed',?,?,?,?,'OK',?,?,?,?,?,?,?,?)`);
    insert.run("root", null, "mixed", "AGENT_ROOT", at, at + 5_000, 5_000, null, null, null, null, null);
    insert.run("reported", "root", "chat", "LLM_GENERATION", at + 100, at + 900, 800, "gpt-4o-mini", "openai", 10, 5, JSON.stringify({ "gen_ai.usage.cost_usd": 0.003 }));
    // gpt-5-nano-2025-08-07 resolves to gpt-5-nano ($0.05 / $0.40 per million): 4,000 × 0.05 + 1,000 × 0.40 = $0.0006.
    insert.run("dated", "root", "chat", "LLM_GENERATION", at + 1_000, at + 1_900, 900, "gpt-5-nano-2025-08-07", "openai", 4_000, 1_000, null);
    expect(list({ q: "mixed" }).runs[0]).toMatchObject({ est_cost_usd: 0.0036, cost_source: "estimated", known_cost_usd: 0.0036, known_cost_source: "mixed", cost_unknown_calls: 0, llm_calls: 2 });
    insert.run("unpriced", "root", "chat", "LLM_GENERATION", at + 2_000, at + 2_500, 500, "in-house-model", "openai", 10, 10, null);
    expect(list({ q: "mixed" }).runs[0]).toMatchObject({ est_cost_usd: null, cost_source: "unknown", known_cost_usd: 0.0036, cost_unknown_calls: 1, llm_calls: 3 });
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

  test("returns exactly the requested run ids, with the other filters still applied", () => {
    expect(ids({ ids: ["r-ok", "p-failed", "missing-run"], sort: "started_at" })).toEqual(["r-ok", "p-failed"]);
    expect(ids({ ids: "r-ok" })).toEqual(["r-ok"]);
    expect(ids({ ids: ["r-ok", "r-ok"] })).toEqual(["r-ok"]);
    expect(ids({ ids: ["r-ok", "p-failed"], status: "failed" })).toEqual(["p-failed"]);
    expect(list({ ids: ["r-ok", "p-failed"] }).total).toBe(2);
    expect(ids({ ids: "" })).toEqual([]);
    expect(list({ ids: [""] }).total).toBe(0);
    expect(ids({ ids: "r-ok,p-failed" })).toEqual([]);
    expect(() => list({ ids: Array.from({ length: 101 }, (_, index) => `run-${index}`) })).toThrow(/at most 100 ids/);
    expect(() => list({ ids: ["r-ok", "x".repeat(1025)] })).toThrow(/at most 1024 characters/);
    expect(() => list({ ids: Array.from({ length: 40 }, (_, index) => `${index}`.padEnd(1000, "x")) })).toThrow(/at most 32768 bytes/);
    const first = list({ ids: ["r-ok", "p-failed", "r-failed"], sort: "started_at", limit: "1" });
    expect(() => list({ ids: "r-ok", sort: "started_at", limit: "1", cursor: first.nextCursor! })).toThrow(/cursor is invalid/);
  });

  test("finds run ids that hold commas or run to the 1024-character import limit", () => {
    const client = getDrizzleDb().$client;
    const comma = "trace,with,commas";
    const long = `long-${"y".repeat(1019)}`;
    for (const id of [comma, long]) client.query("INSERT INTO runs(id,name,event_name,started_at,last_updated_at) VALUES(?,?,?,?,?)").run(id, "odd id", "odd id", FIXTURE_NOW - HOUR, FIXTURE_NOW - HOUR);
    expect(long).toHaveLength(1024);
    expect(ids({ ids: [comma, long, "r-ok"], sort: "started_at" }).sort()).toEqual([comma, long, "r-ok"].sort());
  });

  test("ranks a partly priced run by its known cost, so it is not pushed below fully priced cheaper runs", () => {
    const client = getDrizzleDb().$client;
    const at = FIXTURE_NOW - 3 * HOUR;
    const insertRun = client.prepare("INSERT INTO runs(id,name,event_name,started_at,last_updated_at) VALUES(?,?,?,?,?)");
    const insertSpan = client.prepare(`INSERT INTO spans(run_id,id,parent_span_id,name,span_type,status,start_time_ms,end_time_ms,duration_ms,model,provider,input_tokens,output_tokens,attributes)
      VALUES(?,?,NULL,'chat','LLM_GENERATION','OK',?,?,100,?,?,10,10,?)`);
    for (let index = 0; index < 30; index++) {
      insertRun.run(`filler-${index}`, "filler", "filler", at + index, at + index + 100);
      insertSpan.run(`filler-${index}`, "call", at + index, at + index + 100, "gpt-4o-mini", "openai", JSON.stringify({ "gen_ai.usage.cost_usd": 0.001 }));
    }
    insertRun.run("partly-priced", "probe", "probe", at, at + 300);
    insertSpan.run("partly-priced", "reported", at, at + 100, "gpt-5-nano", "openai", JSON.stringify({ "gen_ai.usage.cost_usd": 0.5 }));
    insertSpan.run("partly-priced", "unpriced", at + 100, at + 200, "mystery-model-x", "openai", null);
    const top = list({ sort: "cost", limit: "8" }).runs;
    expect(top[0]).toMatchObject({ id: "partly-priced", est_cost_usd: null, known_cost_usd: 0.5, known_cost_source: "reported", cost_unknown_calls: 1 });
  });

  test("sorts by metric with unknown values last in either direction", () => {
    expect(ids({ sort: "cost" })).toEqual(["r-nested", "r-failed", "r-ok", "p-ok", "r-tool-err", "r-running", "p-failed", "old"]);
    expect(ids({ sort: "cost", order: "asc" })).toEqual(["r-tool-err", "p-ok", "r-ok", "r-failed", "r-nested", "old", "p-failed", "r-running"]);
    expect(ids({ sort: "duration" })).toEqual(["r-failed", "r-tool-err", "r-ok", "p-failed", "r-nested", "p-ok", "old", "r-running"]);
    expect(ids({ sort: "tokens" })).toEqual(["r-nested", "r-tool-err", "r-failed", "r-ok", "p-ok", "r-running", "p-failed", "old"]);
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
      const long = `long-${"z".repeat(1019)}`;
      const insert = getDrizzleDb().$client.prepare("INSERT INTO runs(id,name,event_name,started_at,last_updated_at) VALUES(?,'odd','odd',?,?)");
      for (const id of ["a,b", long]) insert.run(id, FIXTURE_NOW, FIXTURE_NOW);
      const byIds = new URLSearchParams([["envelope", "1"], ["ids", "a,b"], ["ids", long], ["ids", "r-ok"]]);
      const found = await (await fetch(`${origin}/api/runs?${byIds}`)).json();
      expect(found.runs.map((run: { id: string }) => run.id).sort()).toEqual(["a,b", long, "r-ok"].sort());
      expect((await (await fetch(`${origin}/api/runs?envelope=1&ids=`)).json()).total).toBe(0);
    } finally {
      server.close();
    }
  });
});
