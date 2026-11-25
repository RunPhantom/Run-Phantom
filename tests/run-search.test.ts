import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { closeDb, clearAll, getDrizzleDb } from "../src/db";
import { searchRuns, RUN_SEARCH_LIMITS, _runSearchInternal } from "../src/run-search";
import { deriveRunStatus } from "../src/run-status";
import { createServer } from "../src/server";
import { runMcpServer } from "../src/mcp/index";

let directory: string;
let oldDb: string | undefined;
const pause = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
async function drained() {
  const until = Date.now() + 10_000;
  while (_runSearchInternal.activeWorkers() && Date.now() < until) await pause();
  expect(_runSearchInternal.activeWorkers()).toBe(0);
}
beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), "rp-search-"));
  oldDb = process.env.RUNPHANTOM_DB_PATH;
  closeDb();
  process.env.RUNPHANTOM_DB_PATH = path.join(directory, "search.db");
  getDrizzleDb();
});
beforeEach(() => clearAll());
afterEach(drained);
afterAll(() => {
  closeDb();
  if (oldDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = oldDb;
  rmSync(directory, { recursive: true, force: true });
});

function run(id: string, started = 100, name = id, metadata: string | null = null) {
  getDrizzleDb().$client.query("INSERT INTO runs(id,name,started_at,last_updated_at,metadata) VALUES(?,?,?,?,?)").run(id, name, started, started, metadata);
}
function span(runId: string, options: { id?: string; parent?: string; name?: string; status?: string; input?: string; output?: string; model?: string; provider?: string } = {}) {
  getDrizzleDb().$client.query(`INSERT INTO spans(run_id,id,parent_span_id,name,status,input_payload,output_payload,model,provider,start_time_ms) VALUES(?,?,?,?,?,?,?,?,?,1)`)
    .run(runId, options.id ?? "root", options.parent ?? null, options.name ?? "agent", options.status ?? "OK", options.input ?? null, options.output ?? null, options.model ?? null, options.provider ?? null);
}

describe("full-store run search", () => {
  test("finds an old payload beyond 5000 newer runs and omits raw evidence from summaries", async () => {
    const db = getDrizzleDb().$client;
    db.transaction(() => {
      run("old-match", 1, "Historical failure", '{"private":"do not serialize"}');
      span("old-match", { output: "The archive has the elusive needle" });
      for (let i = 0; i < 5100; i++) run(`new-${i}`, i + 2);
    })();
    const result = await searchRuns({ q: "elusive needle" });
    expect(result.runs.map(r => r.id)).toEqual(["old-match"]);
    expect(result).toMatchObject({ hasMore: false, nextCursor: null });
    expect(result.runs[0]).toMatchObject({ metadata: null, status: "complete", span_count: 1, matched_span_count: 1 });
    expect(result.runs[0].match).toEqual({ field: "output", span_id: "root", span_name: "agent", snippet: { state: "available", text: "The archive has the elusive needle", highlights: [{ start: 20, end: 34 }], truncated: false } });
    expect(JSON.stringify(result)).not.toContain("do not serialize");
    expect((await searchRuns()).runs).toHaveLength(50);
    expect((await searchRuns({ limit: 100 })).runs).toHaveLength(100);
    console.log(`Search benchmark: 5,101 runs, historical payload match ${result.elapsedMs}ms`);
  });

  test("matches all metadata fields and span names, inputs and outputs literally", async () => {
    for (const [id, literal] of [["percent", "100%_done"], ["quote", "' OR 1=1 --"], ["unicode", "こんにちは🌈"], ["slash", "a\\b"]]) {
      run(id);
      span(id, { output: literal });
      expect((await searchRuns({ q: literal })).runs.map(r => r.id)).toEqual([id]);
    }
    run("plain"); span("plain", { output: "100XXdone" });
    expect((await searchRuns({ q: "%" })).runs.map(r => r.id)).toEqual(["percent"]);
    run("metadata", 100, "name", '{"tag":"METADATA-SECRET"}');
    expect((await searchRuns({ q: "metadata-secret" })).runs.map(r => r.id)).toEqual(["metadata"]);
    run("inputs"); span("inputs", { name: "lookup-calendar", input: "birthday-input" });
    for (const q of ["LOOKUP-CALENDAR", "birthday-input"]) expect((await searchRuns({ q })).runs.map(r => r.id)).toEqual(["inputs"]);
    const db = getDrizzleDb().$client;
    db.query("UPDATE runs SET event_id='event-needle', display_name='display-needle', event_name='type-needle', user_id='user-needle', convo_id='conversation-needle' WHERE id='inputs'").run();
    for (const q of ["event-needle", "display-needle", "type-needle", "user-needle", "conversation-needle"]) expect((await searchRuns({ q })).runs.map(r => r.id)).toEqual(["inputs"]);
  });

  test("failure words find errored spans and rank failed runs first with the error as the snippet", async () => {
    const db = getDrizzleDb().$client;
    run("green", 300, "research_agent"); span("green", { output: "No error budget concerns in this report." });
    run("red", 100, "code_review_agent"); span("red"); span("red", { id: "tool", parent: "root", name: "run_tests", status: "ERROR", output: "FAIL auth/middleware.test.ts\nExpected status 401, got 200." });
    run("quiet", 200, "triage_agent"); span("quiet", { output: "All tickets triaged." });
    for (const q of ["error", "Failed", "exception"]) {
      const result = await searchRuns({ q });
      expect(result.runs.map(r => r.id)).toEqual(q === "error" ? ["red", "green"] : ["red"]);
      expect(result.runs[0]).toMatchObject({ status: "completed_with_errors", error_count: 1, matched_span_count: 1 });
      expect(result.runs[0].match).toMatchObject({ field: "failed_span", span_id: "tool", span_name: "run_tests", snippet: { state: "available", text: "FAIL auth/middleware.test.ts Expected status 401, got 200.", highlights: [] } });
    }
    expect((await searchRuns({ q: "error" })).runs[1].match).toMatchObject({ field: "output", snippet: { highlights: [{ start: 3, end: 8 }] } });
    db.query("UPDATE spans SET attributes=? WHERE run_id='red' AND id='tool'").run(JSON.stringify({ "exception.message": "ConnectionResetError: upstream closed the socket" }));
    const reported = await searchRuns({ q: "connectionreset" });
    expect(reported.runs.map(r => r.id)).toEqual(["red"]);
    expect(reported.runs[0].match).toMatchObject({ field: "error", span_id: "tool", snippet: { text: "ConnectionResetError: upstream closed the socket", highlights: [{ start: 0, end: 15 }] } });
    db.query("UPDATE spans SET status='OK' WHERE run_id='red'").run();
    expect((await searchRuns({ q: "connectionreset" })).runs).toEqual([]);
    expect((await searchRuns({ q: "exception" })).runs).toEqual([]);
  });

  test("tool names, models, providers and agent names match and outrank payload-only hits", async () => {
    run("payload-only", 500, "summarizer"); span("payload-only", { input: "please call the lookup_weather tool" });
    run("tool-run", 100, "planner"); span("tool-run"); span("tool-run", { id: "t1", parent: "root", name: "lookup_weather" });
    run("model-run", 50, "writer"); span("model-run", { model: "gpt-5-nano", provider: "openai" });
    run("agent-run", 25, "weather_agent");
    expect((await searchRuns({ q: "lookup_weather" })).runs.map(r => [r.id, r.match?.field])).toEqual([["tool-run", "span_name"], ["payload-only", "input"]]);
    expect((await searchRuns({ q: "GPT-5-NANO" })).runs.map(r => [r.id, r.match?.field])).toEqual([["model-run", "model"]]);
    expect((await searchRuns({ q: "openai" })).runs.map(r => [r.id, r.match?.field])).toEqual([["model-run", "provider"]]);
    const agent = await searchRuns({ q: "weather_agent" });
    expect(agent.runs.map(r => r.id)).toEqual(["agent-run"]);
    expect(agent.runs[0]).toMatchObject({ matched_span_count: 0, match: { field: "run", span_id: null, snippet: { text: "weather_agent", highlights: [{ start: 0, end: 13 }] } } });
    getDrizzleDb().$client.query("UPDATE runs SET metadata=? WHERE id='agent-run'").run('{"private":"metadata-only-term"}');
    expect((await searchRuns({ q: "metadata-only-term" })).runs[0].match).toEqual({ field: "metadata", span_id: null, span_name: null, snippet: { state: "unavailable", text: "", highlights: [], truncated: false } });
  });

  test("snippets are bounded, scrub credentials near the match and carry exact highlight ranges", async () => {
    const prefix = "a".repeat(5000), suffix = " tail".repeat(2000);
    run("long"); span("long", { output: `${prefix} token sent: Bearer sk-live-abcdefghijklmnop\nthen the Needle-Term appears ${suffix}` });
    const [row] = (await searchRuns({ q: "needle-term" })).runs;
    const snippet = row.match!.snippet;
    expect(snippet.truncated).toBe(true);
    expect(snippet.text.startsWith("\u2026")).toBe(true);
    expect(snippet.text.endsWith("\u2026")).toBe(true);
    expect(snippet.text.length).toBeLessThanOrEqual(242);
    expect(snippet.text).not.toContain("sk-live-abcdefghijklmnop");
    expect(snippet.highlights).toHaveLength(1);
    const [range] = snippet.highlights;
    expect(snippet.text.slice(range.start, range.end)).toBe("Needle-Term");
    expect(Buffer.byteLength(JSON.stringify(row.match))).toBeLessThanOrEqual(1536);
    run("json"); span("json", { input: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(3000) + " find the json-needle here " + "y".repeat(3000) }] }) });
    expect((await searchRuns({ q: "json-needle" })).runs[0].match).toMatchObject({ field: "input", snippet: { state: "available", truncated: true } });
  });

  test("ranked keyset pages keep score order without duplicates and reject unranked cursors", async () => {
    for (let i = 0; i < 6; i++) { run(`ok-${i}`, 100 + i); span(`ok-${i}`, { output: "shared-term" }); }
    for (let i = 0; i < 3; i++) { run(`bad-${i}`, i); span(`bad-${i}`, { status: "ERROR", output: "shared-term" }); }
    const ids: string[] = []; let cursor: string | undefined;
    do {
      const page = await searchRuns({ q: "shared-term", limit: 2, cursor });
      ids.push(...page.runs.map(r => r.id)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual(["ok-5", "ok-4", "ok-3", "ok-2", "ok-1", "ok-0", "bad-2", "bad-1", "bad-0"]);
    const failures: string[] = []; cursor = undefined;
    do {
      const page = await searchRuns({ q: "failed", limit: 2, cursor });
      failures.push(...page.runs.map(r => r.id)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(failures).toEqual(["bad-2", "bad-1", "bad-0"]);
    const unranked = (await searchRuns({ limit: 1 })).nextCursor;
    expect(await searchRuns({ q: "shared-term", cursor: unranked }).catch(error => error)).toMatchObject({ status: 400 });
    const ranked = (await searchRuns({ q: "shared-term", limit: 1 })).nextCursor;
    expect(await searchRuns({ cursor: ranked }).catch(error => error)).toMatchObject({ status: 400 });
    expect((await searchRuns({ limit: 1 })).runs[0]).toMatchObject({ match: null, matched_span_count: null });
  });

  test("status and exact model/provider filters apply across history with same-span semantics", async () => {
    run("completed"); span("completed", { model: "model-a", provider: "provider-a" });
    run("failed"); span("failed", { status: "ERROR", model: "model-b", provider: "provider-b" });
    run("running"); span("running", { status: "UNSET" });
    getDrizzleDb().$client.query("UPDATE runs SET last_updated_at=? WHERE id='running'").run(Date.now());
    run("child-failure"); span("child-failure"); span("child-failure", { id: "child", parent: "root", status: "ERROR" });
    expect((await searchRuns({ status: "completed" })).runs.map(r => r.id)).toEqual(["completed"]);
    expect((await searchRuns({ status: "completed_with_errors" })).runs.map(r => r.id)).toEqual(["child-failure"]);
    expect((await searchRuns({ status: "failed" })).runs.map(r => r.id)).toEqual(["failed"]);
    expect((await searchRuns({ status: "running" })).runs.map(r => r.id)).toEqual(["running"]);
    expect((await searchRuns({ model: "model-a", provider: "provider-a", status: "completed" })).runs.map(r => r.id)).toEqual(["completed"]);
    expect((await searchRuns({ model: "model" })).runs).toEqual([]);
    span("completed", { id: "another-model", model: "model-b", provider: "provider-b" });
    expect((await searchRuns({ model: "model-a", provider: "provider-b" })).runs).toEqual([]);
  });

  test("status uses the shared run status: one tool error under an OK agent root is completed, not failed", async () => {
    const db = getDrizzleDb().$client;
    const typed = (runId: string, id: string, type: string, status: string, parent: string | null = null) =>
      db.query("INSERT INTO spans(run_id,id,parent_span_id,name,span_type,status,start_time_ms) VALUES(?,?,?,?,?,?,1)").run(runId, id, parent, id, type, status);
    run("tool-error", 400); typed("tool-error", "root", "AGENT_ROOT", "OK"); typed("tool-error", "tool", "TOOL_CALL", "ERROR", "root");
    run("root-error", 300); typed("root-error", "root", "AGENT_ROOT", "ERROR"); typed("root-error", "tool", "TOOL_CALL", "OK", "root");
    run("stalled", 200); typed("stalled", "tool", "TOOL_CALL", "OK", "root");
    run("replay-failed", 100, "replay", JSON.stringify({ replay: { error: { code: "provider_error", message: "secret detail" } } }));
    const all = new Map((await searchRuns({})).runs.map(row => [row.id, row]));
    expect(all.get("tool-error")).toMatchObject({ status: "completed_with_errors", root_failed: 0, error_count: 1, tool_error_count: 1 });
    expect(all.get("root-error")).toMatchObject({ status: "failed", root_failed: 1 });
    expect(all.get("stalled")).toMatchObject({ status: "interrupted" });
    expect(all.get("replay-failed")).toMatchObject({ status: "failed", replay_outcome: "failed", metadata: null });
    expect(JSON.stringify([...all.values()])).not.toContain("secret detail");
    for (const row of all.values()) expect(deriveRunStatus(row).status).toBe(row.status);
    const ids = async (status: string) => (await searchRuns({ status })).runs.map(r => r.id);
    expect(await ids("failed")).toEqual(["root-error", "replay-failed"]);
    expect(await ids("completed")).toEqual([]);
    expect(await ids("completed_with_errors")).toEqual(["tool-error"]);
    expect(await ids("interrupted")).toEqual(["stalled"]);
    expect(await ids("running")).toEqual([]);
    const typedFilter = (value: string, op = "eq") => searchRuns({ filter: { version: 1, all: [{ field: "status", op, value }] } }).then(result => result.runs.map(r => r.id));
    expect(await typedFilter("failed")).toEqual(["root-error", "replay-failed"]);
    expect(await typedFilter("completed", "ne")).toEqual(["tool-error", "root-error", "stalled", "replay-failed"]);
  });

  test("keyset pages preserve timestamp ties without duplication and report exhaustion", async () => {
    for (const id of ["a", "c", "b", "d", "e"]) run(id, id === "e" ? 101 : 100);
    const first = await searchRuns({ limit: 2 });
    expect(first.runs.map(r => r.id)).toEqual(["e", "d"]);
    expect(first.hasMore).toBe(true);
    const second = await searchRuns({ limit: 2, cursor: first.nextCursor });
    expect(second.runs.map(r => r.id)).toEqual(["c", "b"]);
    const third = await searchRuns({ limit: 2, cursor: second.nextCursor });
    expect(third.runs.map(r => r.id)).toEqual(["a"]);
    expect(third).toMatchObject({ hasMore: false, nextCursor: null });
    const last = Buffer.from(JSON.stringify({ v: 1, startedAt: 100, id: "a" })).toString("base64url");
    expect(await searchRuns({ cursor: last })).toMatchObject({ runs: [], hasMore: false, nextCursor: null });
  });

  test("rejects invalid scalar parameters, query lengths and malformed cursors", async () => {
    const malformed = Buffer.from(JSON.stringify({ v: 1, startedAt: "100", id: "run" })).toString("base64url");
    for (const params of [{ q: "x".repeat(257) }, { q: ["a", "b"] }, { q: "\0" }, { model: 5 }, { provider: "x".repeat(257) }, { status: "OK" }, { limit: 0 }, { limit: 101 }, { limit: "" }, { limit: 1.2 }, { limit: [] }, { cursor: "invalid" }, { cursor: malformed }, { cursor: "%_'" }]) {
      expect(await searchRuns(params).catch(error => error)).toMatchObject({ status: 400 });
    }
    expect(_runSearchInternal.activeWorkers()).toBe(0);
  });

  test("fractional timestamp ties and bounded Unicode identities round-trip through emitted cursors", async () => {
    const ids = ["fraction-a", "fraction-b", "fraction-c"];
    for (const id of ids) run(id, 1.5);
    const first = await searchRuns({ limit: 1 });
    expect(first.runs[0]).toMatchObject({ id: "fraction-c", started_at: 1.5 });
    const second = await searchRuns({ limit: 1, cursor: first.nextCursor });
    expect(second.runs[0].id).toBe("fraction-b");
    expect((await searchRuns({ limit: 1, cursor: second.nextCursor })).runs[0].id).toBe("fraction-a");
    const unicodeId = "界".repeat(990);
    run(unicodeId, 2.5);
    const unicodePage = await searchRuns({ limit: 1 });
    expect(unicodePage.runs[0].id).toBe(unicodeId);
    expect(unicodePage.nextCursor!.length).toBeLessThanOrEqual(4096);
    expect((await searchRuns({ limit: 1, cursor: unicodePage.nextCursor })).runs[0].id).toBe("fraction-c");
    run("界".repeat(1024), 3.5);
    expect(await searchRuns({ limit: 1 }).catch(error => error)).toMatchObject({ message: expect.stringContaining("cursor byte limit") });
  });

  test("bounds UTF-8 summaries in the worker while preserving byte-limited pagination", async () => {
    for (let i = 0; i < 12; i++) run(`unicode-${i}`, i, "🌈".repeat(150));
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await searchRuns({ limit: 100, cursor }, { maxBytes: 2500 });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2500);
      expect(result.runs.length).toBeGreaterThan(0);
      ids.push(...result.runs.map(r => r.id));
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(ids).size).toBe(12);
    expect(ids.length).toBe(12);
    getDrizzleDb().$client.query("UPDATE runs SET name=?").run("🌈".repeat(600));
    expect(await searchRuns({}, { maxBytes: 1024 }).catch(error => error)).toMatchObject({ message: expect.stringContaining("byte limit") });
  });

  test("cancelled callers keep admission occupied until workers acknowledge completion", async () => {
    run("run");
    for (let wave = 0; wave < 3; wave++) {
      const controllers = [new AbortController(), new AbortController()];
      const pending = controllers.map(controller => searchRuns({}, { signal: controller.signal }).catch(error => error));
      controllers.forEach(controller => controller.abort());
      expect(_runSearchInternal.activeWorkers()).toBe(RUN_SEARCH_LIMITS.workers);
      const rejected = Array.from({ length: 20 }, () => searchRuns().catch(error => error));
      for (const error of await Promise.all(rejected)) expect(error).toMatchObject({ code: "search_busy", status: 503 });
      for (const error of await Promise.all(pending)) expect(error).toMatchObject({ code: "cancelled" });
      await drained();
    }
    const controller = new AbortController(); controller.abort();
    expect(await searchRuns({}, { signal: controller.signal }).catch(error => error)).toMatchObject({ code: "cancelled" });
    expect((await searchRuns()).runs).toHaveLength(1);
  });

  test("repeated deadlines recover capacity and failures do not leak workers", async () => {
    for (let wave = 0; wave < 3; wave++) {
      const pending = Array.from({ length: 2 }, () => searchRuns({}, { timeoutMs: 1 }).catch(error => error));
      for (const result of await Promise.all(pending)) expect(result).toMatchObject({ code: "timeout", status: 504 });
      expect(_runSearchInternal.activeWorkers()).toBeLessThanOrEqual(RUN_SEARCH_LIMITS.workers);
      const retries = Array.from({ length: 20 }, () => searchRuns({}, { timeoutMs: 1 }).catch(error => error));
      expect(_runSearchInternal.activeWorkers()).toBeLessThanOrEqual(RUN_SEARCH_LIMITS.workers);
      expect((await Promise.all(retries)).filter(result => result.code === "search_busy").length).toBeGreaterThanOrEqual(18);
      await drained();
    }
    expect(await searchRuns({}, { dbPath: path.join(directory, "missing", "missing.db") }).catch(error => error)).toBeInstanceOf(Error);
    await drained();
    expect(await searchRuns()).toMatchObject({ runs: [], hasMore: false });
  });

  test("HTTP and MCP expose search with validation and the daemon remains responsive during scans", async () => {
    run("api-run", 100, "API fixture"); span("api-run", { output: "api-search-needle", model: "exact-model", provider: "exact-provider" });
    const { server } = await createServer(0);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = await runMcpServer({ url: origin, transport: serverTransport });
    const client = new Client({ name: "search-test", version: "1" });
    await client.connect(clientTransport);
    try {
      const api = await fetch(`${origin}/api/runs/search?q=api-search-needle&status=completed`);
      expect(api.status).toBe(200);
      expect((await api.json()).runs[0].id).toBe("api-run");
      expect((await fetch(`${origin}/api/runs/search?limit=101`)).status).toBe(400);
      expect((await fetch(`${origin}/api/runs/search?q=a&q=b`)).status).toBe(400);
      const tools = await client.listTools();
      expect(tools.tools.some(tool => tool.name === "search_runs")).toBe(true);
      const response = await client.callTool({ name: "search_runs", arguments: { q: "api-search-needle", model: "exact-model", provider: "exact-provider" } });
      expect(JSON.parse((response.content as { text: string }[])[0].text).runs[0].id).toBe("api-run");
      expect(await client.callTool({ name: "search_runs", arguments: { limit: 101 } }).catch(error => error)).toMatchObject({ code: ErrorCode.InvalidParams });
      expect(await client.callTool({ name: "search_runs", arguments: { q: {} } }).catch(error => error)).toMatchObject({ code: ErrorCode.InvalidParams });
      const sql = await client.callTool({ name: "query_traces", arguments: { sql: "SELECT id FROM runs" } });
      expect(JSON.parse((sql.content as { text: string }[])[0].text).rows[0].id).toBe("api-run");
      expect(Array.isArray(await (await fetch(`${origin}/api/runs`)).json())).toBe(true);
      const db = getDrizzleDb().$client;
      db.transaction(() => {
        const payload = "x".repeat(64 * 1024);
        for (let i = 0; i < 1500; i++) { run(`heavy-${i}`, i); span(`heavy-${i}`, { output: payload }); }
      })();
      const start = performance.now();
      const scan = fetch(`${origin}/api/runs/search?q=absent-from-large-store`);
      await pause(25);
      const healthStart = performance.now();
      expect((await fetch(`${origin}/health`)).status).toBe(200);
      const healthMs = performance.now() - healthStart;
      expect(healthMs).toBeLessThan(1000);
      const result = await scan;
      expect(result.status).toBe(200);
      expect((await result.json()).runs).toEqual([]);
      console.log(`Search benchmark: 1,500 x 64KiB payload scan ${(performance.now() - start).toFixed(0)}ms; concurrent health ${healthMs.toFixed(0)}ms`);
    } finally {
      await client.close(); await mcp.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 20_000);

  test("compiled minified execution searches without loose worker source files", async () => {
    run("compiled-run"); span("compiled-run", { output: "compiled-needle" });
    const entry = path.join(directory, "entry.ts");
    const binary = path.join(directory, "search-compiled");
    writeFileSync(entry, `import { searchRuns } from ${JSON.stringify(path.resolve("src/run-search.ts"))};\nconsole.log(JSON.stringify(await searchRuns({q:"compiled-needle"}, {dbPath: process.argv[2]})));\n`);
    const build = Bun.spawn([process.execPath, "build", "--compile", "--minify", entry, "--outfile", binary], { stdout: "pipe", stderr: "pipe" });
    const buildError = await new Response(build.stderr).text();
    expect(await build.exited, buildError).toBe(0);
    const child = Bun.spawn([binary, process.env.RUNPHANTOM_DB_PATH!], { cwd: directory, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    expect(await child.exited, error).toBe(0);
    expect(JSON.parse(output).runs[0].id).toBe("compiled-run");
  }, 30_000);

  test("typed predicates combine legacy filters on one actual span and reject malformed ASTs before work", async () => {
    run("split"); span("split", { model: "model-a", provider: "provider-a" });
    span("split", { id: "slow", model: "model-b", provider: "provider-b" });
    run("exact"); span("exact", { model: "model-a", provider: "provider-a", output: "private typed output" });
    const db = getDrizzleDb().$client;
    db.query("UPDATE spans SET duration_ms=10,attributes=? WHERE run_id='split' AND id='root'").run('{"gen_ai.usage.cost_usd":0,"tags":["target"]}');
    db.query("UPDATE spans SET duration_ms=3000,attributes=? WHERE (run_id='split' AND id='slow') OR run_id='exact'").run('{"gen_ai.usage.cost_usd":0,"tags":["target"]}');
    const filter = { version: 1, all: [
      { field: "duration_ms", op: "gt", value: 2000 }, { field: "captured_cost_usd", op: "eq", value: 0 },
      { field: "tag", op: "eq", value: "target" },
    ] };
    const result = await searchRuns({ model: "model-a", provider: "provider-a", filter });
    expect(result.runs.map(row => row.id)).toEqual(["exact"]);
    expect(JSON.stringify(result)).not.toContain("private typed output");
    for (const invalidFilter of [{ version: 9, all: [] }, { version: 1, all: [{ field: "sql", op: "eq", value: "1=1" }] }, '["x"]']) {
      expect(await searchRuns({ filter: invalidFilter }).catch(error => error)).toMatchObject({ status: 400, code: "invalid_search" });
    }
    expect(_runSearchInternal.activeWorkers()).toBe(0);
  });

  test("typed keyset cursors bind canonical meaning and the current store", async () => {
    for (const id of ["a", "b", "c"]) { run(id); span(id, { model: "model-a", provider: "provider-a" }); }
    const clauses = [{ field: "model", op: "eq", value: "model-a" }, { field: "provider", op: "eq", value: "provider-a" }];
    const filter = { version: 1, all: clauses };
    const first = await searchRuns({ filter, limit: 1 });
    expect(first.runs[0].id).toBe("c");
    expect(JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString()).v).toBe(2);
    const second = await searchRuns({ filter: { version: 1, all: [...clauses].reverse() }, cursor: first.nextCursor, limit: 1 });
    expect(second.runs[0].id).toBe("b");
    for (const query of [{ filter: { version: 1, all: [{ field: "model", op: "eq", value: "other" }] } }, { filter, q: "changed" }, {}]) {
      expect(await searchRuns({ ...query, cursor: first.nextCursor }).catch(error => error)).toMatchObject({ status: 400 });
    }
    expect(await searchRuns({ filter, cursor: first.nextCursor }, { dbPath: path.join(directory, "other-store.db") }).catch(error => error)).toMatchObject({ status: 400 });
    expect(_runSearchInternal.activeWorkers()).toBe(0);
  });

  test("typed HTTP and MCP filters select captured values and refuse unknown predicates", async () => {
    run("api-typed"); span("api-typed", { model: "literal%_model" });
    run("api-other"); span("api-other", { model: "other" });
    const filter = { version: 1, all: [{ field: "model", op: "eq", value: "literal%_model" }] };
    const { server } = await createServer(0);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = await runMcpServer({ url: origin, transport: serverTransport });
    const client = new Client({ name: "typed-search-test", version: "1" }); await client.connect(clientTransport);
    try {
      const response = await fetch(`${origin}/api/runs/search?${new URLSearchParams({ filter: JSON.stringify(filter) })}`);
      expect(response.status).toBe(200); expect((await response.json()).runs.map((row: { id: string }) => row.id)).toEqual(["api-typed"]);
      const malformed = JSON.stringify({ version: 1, all: [{ field: "model", op: "regex", value: ".*" }] });
      expect((await fetch(`${origin}/api/runs/search?${new URLSearchParams({ filter: malformed })}`)).status).toBe(400);
      const result = await client.callTool({ name: "search_runs", arguments: { filter } });
      expect(JSON.parse((result.content as { text: string }[])[0].text).runs.map((row: { id: string }) => row.id)).toEqual(["api-typed"]);
      expect(await client.callTool({ name: "search_runs", arguments: { filter: { version: 1, all: [{ field: "payload", op: "eq", value: "x" }] } } }).catch(error => error)).toMatchObject({ code: ErrorCode.InvalidParams });
    } finally { await client.close(); await mcp.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
