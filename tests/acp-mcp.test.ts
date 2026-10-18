import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AcpVerificationGrants, AcpMcpError, BoundedAcpMcpTransport, acpMcpInvoker, registerAcpMcpTools } from "../src/acp-mcp";
import type { VerificationService } from "../src/verification/service";
import type { VerificationSession } from "../src/verification/bridge";

// Mechanism controls deliberately use a fake service. Genuine browser/SQLite grading has a separate journey.
function controls() {
  let current = true;
  let now = 1_000;
  let calls = 0;
  const session = { id: "fixed", runId: "selected", generation: 1, generationCursor: 4, cursor: 8, ws: { readyState: 1 } } as VerificationSession;
  const sessions = new Map([[session.id, session]]);
  const service = { bridge: { sessions, observe: () => { calls++; return { controlled: true }; } }, assert: async () => { calls++; return { controlled: true }; } } as unknown as VerificationService;
  const grants = new AcpVerificationGrants(service, () => now);
  const issue = () => grants.issue(session, "selected", () => current);
  return { session, sessions, service, grants, issue, calls: () => calls, setCurrent: (value: boolean) => { current = value; }, advance: (value: number) => { now += value; } };
}
const observe = JSON.stringify({ name: "app_observe", arguments: {} });

test("closed optional MCP schema exposes only its fixed-target verification tools", async () => {
  const [left, right] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: "scoped-mechanism", version: "1" }, { capabilities: { tools: {} } });
  const admitted: string[] = [];
  registerAcpMcpTools(server, async raw => { admitted.push(raw); return { controlled: true }; });
  await server.connect(right);
  const client = new Client({ name: "mechanism-test", version: "1" });
  try {
    await client.connect(left);
    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name)).toEqual(["app_observe", "app_assert"]);
    for (const tool of listed.tools) expect(tool.inputSchema.properties).not.toHaveProperty("sessionId");
    await client.callTool({ name: "app_observe", arguments: { since: 4 } });
    expect(JSON.parse(admitted[0]!)).toEqual({ name: "app_observe", arguments: { since: 4 } });
  } finally { await client.close(); await server.close(); }
});

test("fixed application object, document, run, focus and TTL cannot revive a grant", async () => {
  for (const alter of [
    (c: ReturnType<typeof controls>) => c.setCurrent(false),
    (c: ReturnType<typeof controls>) => { c.session.generation++; },
    (c: ReturnType<typeof controls>) => { c.session.runId = "other"; },
    (c: ReturnType<typeof controls>) => { c.session.ws = null; },
    (c: ReturnType<typeof controls>) => { c.sessions.set("fixed", { ...c.session }); },
    (c: ReturnType<typeof controls>) => c.advance(45_000),
  ]) {
    const c = controls(); const token = c.issue(); alter(c);
    await assert.rejects(c.grants.invoke(token, observe), { reason: "unavailable" });
    expect(c.calls()).toBe(0); await c.grants.close();
  }
});

test("duplicate keys, unsafe numbers, target injection and unsupported tools never reach the service", async () => {
  const c = controls(); const token = c.issue();
  const invalid = [
    JSON.stringify({ name: "app_assert", arguments: { predicate: { kind: "signal", name: token } } }),
    '{"name":"app_observe","name":"app_assert","arguments":{}}',
    '{"name":"app_observe","arguments":{"since":9007199254740993}}',
    '{"name":"app_observe","arguments":{"sinc\\u0065":4,"since":5}}',
    JSON.stringify({ name: "app_observe", arguments: { sessionId: "caller" } }),
    JSON.stringify({ name: "app_observe", arguments: { since: 3 } }),
    JSON.stringify({ name: "app_observe", arguments: { since: 9 } }),
    JSON.stringify({ name: "app_observe", arguments: { since: 4.5 } }),
    JSON.stringify({ name: "app_observe", arguments: {}, url: "http://example.test" }),
    JSON.stringify({ name: "app_act", arguments: { command: { type: "click", selector: "#secret" } } }),
    JSON.stringify({ name: "app_assert", arguments: { predicate: { kind: "console", level: "error", absent: true }, name: "bad\0name" } }),
    JSON.stringify({ name: "app_assert", arguments: { predicate: { kind: "eval", code: "bad" } } }),
  ];
  try { for (const raw of invalid) await assert.rejects(c.grants.invoke(token, raw), AcpMcpError); expect(c.calls()).toBe(0); }
  finally { await c.grants.close(); }
});

test("finite grant, input, output and call admission have no hidden queue", async () => {
  const c = controls(); const token = c.issue();
  for (let index = 0; index < 8; index++) await c.grants.invoke(token, observe);
  await assert.rejects(c.grants.invoke(token, observe), { reason: "limit" });
  expect(c.calls()).toBe(8);
  for (let index = 1; index < 8; index++) c.issue();
  expect(c.issue).toThrow(AcpMcpError);
  await c.grants.close();
  const input = controls(); const inputToken = input.issue();
  await assert.rejects(input.grants.invoke(inputToken, " ".repeat(16_385)), { reason: "limit" });
  expect(input.calls()).toBe(0); await input.grants.close();
  const output = controls(); output.service.bridge.observe = () => ({ oversized: "x".repeat(65_536) }) as never;
  const outputToken = output.issue(); await assert.rejects(output.grants.invoke(outputToken, observe), { reason: "limit" });
  await output.grants.close();
});

test("revocation fences before awaiting actual admitted work and joins it before release", async () => {
  const c = controls(); let finish!: (value: never) => void;
  c.service.assert = (() => new Promise(resolve => { finish = resolve; })) as VerificationService["assert"];
  const token = c.issue(); const raw = JSON.stringify({ name: "app_assert", arguments: { predicate: { kind: "console", level: "error", absent: true } } });
  const pending = c.grants.invoke(token, raw); await Promise.resolve();
  await assert.rejects(c.grants.invoke(token, observe), { reason: "busy" });
  let joined = false; const revoke = c.grants.revoke(token).then(() => { joined = true; });
  await Promise.resolve(); expect(joined).toBe(false);
  await assert.rejects(c.grants.invoke(token, observe), { reason: "unavailable" });
  finish({ controlled: true } as never); await assert.rejects(pending, { reason: "unavailable" }); await revoke; expect(joined).toBe(true);
  const next = c.issue(); expect(await c.grants.invoke(next, observe)).toEqual({ controlled: true });
  await c.grants.close(); expect(c.issue).toThrow(AcpMcpError);
});

test("global two-call admission rejects a third grant without a queue", async () => {
  const c = controls(); const finishes: Array<(value: never) => void> = [];
  c.service.assert = (() => new Promise(resolve => finishes.push(resolve))) as VerificationService["assert"];
  const raw = JSON.stringify({ name: "app_assert", arguments: { predicate: { kind: "console", level: "error", absent: true } } });
  const tokens = [c.issue(), c.issue(), c.issue()];
  const first = c.grants.invoke(tokens[0]!, raw), second = c.grants.invoke(tokens[1]!, raw); await Promise.resolve();
  await assert.rejects(c.grants.invoke(tokens[2]!, raw), { reason: "busy" });
  finishes.forEach(finish => finish({ controlled: true } as never)); await Promise.all([first, second]); await c.grants.close();
});

async function frameControl(chunks: Buffer[], expectClosed: boolean) {
  const input = new PassThrough(); const output = new PassThrough(); const frames: string[] = [];
  output.on("data", raw => frames.push(String(raw)));
  const transport = new BoundedAcpMcpTransport(input, output);
  let closed = false; const received: unknown[] = [];
  transport.onclose = () => { closed = true; }; transport.onmessage = message => received.push(message);
  transport.onerror = () => {};
  await transport.start();
  for (const chunk of chunks) input.write(chunk);
  input.end(); await new Promise(resolve => setTimeout(resolve, 5));
  if (expectClosed) expect(closed).toBe(true);
  await transport.close(); return { received, frames };
}

test("owned stdio closes on EOF and accepts an exact split UTF8 MCP frame", async () => {
  const raw = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"label":"✓"}}\n');
  const split = raw.indexOf(Buffer.from("✓")) + 1;
  const result = await frameControl([raw.subarray(0, split), raw.subarray(split)], true);
  expect(result.received).toHaveLength(1);
});

test("owned stdio refuses duplicate, invalid UTF8, excessive or truncated frames before SDK admission", async () => {
  for (const frame of [
    Buffer.from('{"jsonrpc":"2.0","id":1,"id":2,"method":"tools/list"}\n'),
    Buffer.from('{"jsonrpc":"2.0","id":9007199254740993,"method":"tools/list"}\n'),
    Buffer.from([0xc3, 0x28, 0x0a]),
    Buffer.from("x".repeat(16_385)),
    Buffer.from('{"jsonrpc":"2.0","id":1'),
  ]) { const result = await frameControl([frame], true); expect(result.received).toHaveLength(0); }
});

test("owned output is bounded and closing releases a blocked write", async () => {
  const input = new PassThrough(); const output = new Writable({ write() {} });
  const transport = new BoundedAcpMcpTransport(input, output); await transport.start();
  const pending = transport.send({ jsonrpc: "2.0", id: 1, result: {} });
  await transport.close(); await assert.rejects(pending, AcpMcpError);
  const other = new BoundedAcpMcpTransport(new PassThrough(), new PassThrough());
  await assert.rejects(other.send({ jsonrpc: "2.0", id: 1, result: { huge: "x".repeat(262_144) } }), { reason: "limit" });
  await other.close();
});

test("HTTP invoker accepts only an exact loopback origin and never follows redirects", async () => {
  const token = "a".repeat(64);
  for (const origin of ["https://127.0.0.1:1234", "http://localhost:1234", "http://example.test:1234", "http://127.0.0.1:1234/path", "http://127.0.0.1:1234/?secret=yes", "http://user@127.0.0.1:1234"]) expect(() => acpMcpInvoker(origin, token)).toThrow(AcpMcpError);
  let redirected = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { if (new URL(request.url).pathname === "/forbidden") redirected++; return new Response(null, { status: 302, headers: { Location: "/forbidden" } }); } });
  try { await assert.rejects(acpMcpInvoker(`http://127.0.0.1:${server.port}`, token)(observe), { reason: "unavailable" }); expect(redirected).toBe(0); }
  finally { await server.stop(true); }
});
