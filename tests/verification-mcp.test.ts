import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { runMcpServer, type McpServerHandle } from "../src/mcp/index";

interface RequestRecord { method: string; path: string; body: unknown }
let client: Client;
let mcp: McpServerHandle;
let http: ReturnType<typeof Bun.serve>;
let requests: RequestRecord[];
let responseStatus = 200;
let responseBody: unknown = { ok: true };

async function expectMcpError(call: Promise<unknown>, code: number, message?: string) {
  try {
    await call;
    throw new Error("Expected an MCP error");
  } catch (error) {
    expect(error).toMatchObject({ code });
    if (message) expect(error).toMatchObject({ message: expect.stringContaining(message) });
  }
}

beforeEach(async () => {
  requests = [];
  responseStatus = 200;
  responseBody = { ok: true };
  http = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    requests.push({ method: request.method, path: url.pathname + url.search, body: request.method === "POST" ? await request.json() : undefined });
    return Response.json(responseBody, { status: responseStatus });
  } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  mcp = await runMcpServer({ url: `http://127.0.0.1:${http.port}`, transport: serverTransport });
  client = new Client({ name: "verification-contract-test", version: "1.0.0" });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client?.close();
  await mcp?.close();
  await http?.stop(true);
});

test("verification MCP tools compose with trace tools and advertise the complete command/predicate contract", async () => {
  const result = await client.listTools();
  const names = result.tools.map(tool => tool.name);
  expect(names).toContain("query_traces");
  expect(names).toContain("replay_run");
  expect(names).toContain("app_session");
  expect(names).toContain("app_observe");
  expect(names).toContain("app_act");
  expect(names).toContain("app_assert");
  expect(names).toContain("app_flow");
  expect(new Set(names).size).toBe(names.length);
  const schema = result.tools.find(tool => tool.name === "app_assert")!.inputSchema;
  const definitions = schema.$defs as { predicate: { oneOf: Array<{ properties: Record<string, unknown> }> } };
  const kinds = definitions.predicate.oneOf.map(variant => variant.properties.kind);
  expect(kinds).toEqual([{ const: "network" }, { const: "console" }, { const: "signal" }, { const: "state" }, { const: "element" }, { enum: ["allOf", "anyOf"] }]);
  await client.callTool({ name: "query_traces", arguments: { sql: "SELECT id FROM runs" } });
  expect(requests[0]).toEqual({ method: "POST", path: "/api/traces/query", body: { sql: "SELECT id FROM runs" } });
});

test("session MCP calls preserve origin, existing-run linkage and encoded identifiers", async () => {
  responseBody = { id: "session-1", token: "ephemeral-test-token", origin: "http://localhost:3000", runId: "run-1", sdkUrl: "http://127.0.0.1:5947/verification/sdk.js" };
  const created = await client.callTool({ name: "app_session", arguments: { action: "create", origin: "http://localhost:3000", runId: "run-1" } });
  expect(JSON.parse((created.content as Array<{ text: string }>)[0].text)).toEqual(responseBody);
  expect(requests[0]).toEqual({ method: "POST", path: "/api/verification/sessions", body: { origin: "http://localhost:3000", runId: "run-1" } });
  await client.callTool({ name: "app_session", arguments: { action: "list" } });
  expect(requests[1].path).toBe("/api/verification/sessions");
  await client.callTool({ name: "app_session", arguments: { action: "disconnect", sessionId: "session/with?parts" } });
  expect(requests[2]).toEqual({ method: "DELETE", path: "/api/verification/sessions/session%2Fwith%3Fparts", body: undefined });
});

test("observation and app actions carry exact cursors and all supported commands", async () => {
  await client.callTool({ name: "app_observe", arguments: { sessionId: "session", since: 1700 } });
  expect(requests[0].path).toBe("/api/verification/sessions/session/events?since=1700");
  const commands = [
    { type: "snapshot" },
    { type: "snapshot", selector: "#result" },
    { type: "click", selector: "#checkout" },
    { type: "fill", selector: "#name", value: "Live only" },
    { type: "state", store: "cart" },
  ];
  for (const command of commands) {
    await client.callTool({ name: "app_act", arguments: { sessionId: "session", command } });
    expect(requests.at(-1)).toEqual({ method: "POST", path: "/api/verification/sessions/session/command", body: command });
  }
});

test("assertions expose all predicates, composites and immutable report results", async () => {
  const predicate = { kind: "allOf", predicates: [
    { kind: "network", urlContains: "/api/checkout", method: "post", status: 200 },
    { kind: "console", level: "error", absent: true },
    { kind: "signal", name: "checkout.complete" },
    { kind: "state", store: "cart", path: "items.length", equals: 0 },
    { kind: "anyOf", predicates: [{ kind: "element", selector: "#complete", state: "present" }, { kind: "element", selector: "#spinner", state: "absent" }] },
  ] };
  responseBody = { id: "report", sessionId: "session", runId: "run", flowId: null, name: "Checkout", status: "inconclusive", reason: "Disconnected", evidence: [], createdAt: 1700,
    context: { origin: "http://localhost:3000", checks: [{ step: 1, predicate, status: "inconclusive", reason: "Disconnected", since: 1600, through: 1700, generation: 2, coverage: { network: false, console: false, dom: false, state: false, signal: false, route: false }, complete: false, dropped: 2, settled: false }], quietMs: 300, redacted: false, truncated: false } };
  const report = await client.callTool({ name: "app_assert", arguments: { sessionId: "session", predicate, since: 1600, name: "Checkout" } });
  expect(JSON.parse((report.content as Array<{ text: string }>)[0].text)).toEqual(responseBody);
  const posted = requests[0].body as { predicate: { predicates: Array<Record<string, unknown>> }; since: number; name: string };
  expect(posted.predicate.predicates[0].method).toBe("POST");
  expect(posted.predicate.predicates.slice(1)).toEqual(predicate.predicates.slice(1));
  expect(posted.since).toBe(1600);
  expect(posted.name).toBe("Checkout");
});

test("flow list/save/replay/delete route through the shared control API", async () => {
  await client.callTool({ name: "app_flow", arguments: { action: "list" } });
  const steps = [{ command: { type: "click", selector: "#checkout" }, predicate: { kind: "network", urlContains: "/api/checkout", status: 200 } }];
  await client.callTool({ name: "app_flow", arguments: { action: "save", name: "Checkout", origin: "http://localhost:3000", steps } });
  await client.callTool({ name: "app_flow", arguments: { action: "run", flowId: "flow/1", sessionId: "session" } });
  await client.callTool({ name: "app_flow", arguments: { action: "delete", flowId: "flow/1" } });
  expect(requests).toEqual([
    { method: "GET", path: "/api/verification/flows", body: undefined },
    { method: "POST", path: "/api/verification/flows", body: { name: "Checkout", origin: "http://localhost:3000", steps } },
    { method: "POST", path: "/api/verification/flows/flow%2F1/run", body: { sessionId: "session" } },
    { method: "DELETE", path: "/api/verification/flows/flow%2F1", body: undefined },
  ]);
});

test("MCP rejects malformed arguments and all saved fill actions before HTTP", async () => {
  const cases = [
    { name: "app_session", arguments: { action: "list", unexpected: true } },
    { name: "app_session", arguments: { action: "create", origin: 2 } },
    { name: "app_session", arguments: { action: "create", origin: "http://localhost:3000", runId: 5 } },
    { name: "app_session", arguments: { action: "forget" } },
    { name: "app_observe", arguments: { sessionId: "session", since: -1 } },
    { name: "app_observe", arguments: { sessionId: "session", since: 1.5 } },
    { name: "app_observe", arguments: { sessionId: "session", since: "1" } },
    { name: "app_act", arguments: { sessionId: "session", command: { type: "eval", code: "alert(1)" } } },
    { name: "app_assert", arguments: { sessionId: "session", predicate: { kind: "network", urlContains: "/api", status: 0 } } },
    { name: "app_assert", arguments: { sessionId: "session", predicate: { kind: "allOf", predicates: [] } } },
    { name: "app_flow", arguments: { action: "save", name: "Bad", origin: "http://localhost:3000", steps: [{ command: { type: "fill", selector: "#name", value: "Non-secret is also forbidden" }, predicate: { kind: "element", selector: "#done", state: "present" } }] } },
    { name: "app_flow", arguments: { action: "save", name: "Bad", origin: "http://localhost:3000", steps: [{ predicate: { kind: "state", store: "auth", path: "password", equals: "example" } }] } },
    { name: "app_flow", arguments: { action: "run", flowId: "flow" } },
  ];
  for (const args of cases) await expectMcpError(client.callTool(args), ErrorCode.InvalidParams);
  expect(requests).toHaveLength(0);
});

test("backend failures retain actionable MCP error codes and unknown tools stay unknown", async () => {
  for (const status of [400, 404, 409]) {
    responseStatus = status;
    responseBody = { error: "The session cannot perform this action" };
    await expectMcpError(client.callTool({ name: "app_act", arguments: { sessionId: "session", command: { type: "snapshot" } } }), ErrorCode.InvalidParams, "The session cannot perform this action");
  }
  responseStatus = 500;
  responseBody = { error: "Application verification failed" };
  await expectMcpError(client.callTool({ name: "app_flow", arguments: { action: "list" } }), ErrorCode.InternalError);
  await expectMcpError(client.callTool({ name: "app_unknown", arguments: {} }), ErrorCode.MethodNotFound);
  await http.stop(true);
  await expectMcpError(client.callTool({ name: "app_session", arguments: { action: "list" } }), ErrorCode.InternalError, "unreachable");
});

test("MCP calls reach the real daemon and persist run-linked inconclusive reports", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "runphantom-mcp-verification-"));
  const previousDb = process.env.RUNPHANTOM_DB_PATH;
  const { closeDb, upsertRun } = await import("../src/db");
  closeDb();
  process.env.RUNPHANTOM_DB_PATH = path.join(directory, "verification.db");
  let server: import("node:http").Server | undefined;
  try {
    const { createServer } = await import("../src/server");
    ({ server } = await createServer(0));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await client.close();
    await mcp.close();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    mcp = await runMcpServer({ url, transport: serverTransport });
    client = new Client({ name: "verification-real-daemon-test", version: "1.0.0" });
    await client.connect(clientTransport);
    async function call(name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: args });
      return JSON.parse((result.content as Array<{ text: string }>)[0].text) as any;
    }
    upsertRun({ id: "mcp-run", name: "MCP verification", started_at: Date.now(), last_updated_at: Date.now() });
    const created = await call("app_session", { action: "create", origin: "http://localhost:4312", runId: "mcp-run" });
    expect(typeof created.token).toBe("string");
    const listed = await call("app_session", { action: "list" });
    expect(listed[0].runId).toBe("mcp-run");
    expect(listed[0]).not.toHaveProperty("token");
    const observed = await call("app_observe", { sessionId: created.id });
    expect(observed.session.connected).toBe(false);
    const report = await call("app_assert", { sessionId: created.id, name: "Disconnected app", predicate: { kind: "console", level: "error", absent: true } });
    expect(report.status).toBe("inconclusive");
    expect(report.runId).toBe("mcp-run");
    expect(report.reason).toContain("disconnected");
    expect(report.context).toMatchObject({ origin: created.origin, quietMs: 300, redacted: false, truncated: false });
    expect(report.context.checks).toHaveLength(1);
    expect(report.context.checks[0]).toMatchObject({ step: 1, predicate: { kind: "console", level: "error", absent: true }, status: "inconclusive", complete: false, settled: false });
    const flow = await call("app_flow", { action: "save", name: "Console clean", origin: created.origin, steps: [{ predicate: { kind: "console", level: "error", absent: true } }] });
    expect((await call("app_flow", { action: "list" }))[0].id).toBe(flow.id);
    const replay = await call("app_flow", { action: "run", flowId: flow.id, sessionId: created.id });
    expect(replay.status).toBe("inconclusive");
    expect(replay.flowId).toBe(flow.id);
    await call("app_session", { action: "disconnect", sessionId: created.id });
    expect(await call("app_session", { action: "list" })).toEqual([]);
    await call("app_flow", { action: "delete", flowId: flow.id });
    closeDb();
    const persisted = await fetch(`${url}/api/verification/reports?runId=mcp-run`).then(response => response.json()) as Array<{ id: string; context: unknown }>;
    expect(persisted.map(item => item.id)).toContain(report.id);
    expect(persisted.map(item => item.id)).toContain(replay.id);
    expect(persisted.find(item => item.id === report.id)?.context).toEqual(report.context);
    await expectMcpError(client.callTool({ name: "app_assert", arguments: { sessionId: created.id, predicate: { kind: "signal", name: "done" } } }), ErrorCode.InvalidParams, "not found");
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    closeDb();
    if (previousDb === undefined) delete process.env.RUNPHANTOM_DB_PATH;
    else process.env.RUNPHANTOM_DB_PATH = previousDb;
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
