import { expect, test } from "bun:test";
import http from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { VerificationBridge } from "../src/verification/bridge";
import { parseBrowserMessage } from "../src/verification/validation";
import { tree } from "./fixtures/semantic-tree";

const coverage = { network: true, console: true, dom: true, state: true, signal: true, route: true };
const hello = (version: number, capabilities: string[]) => ({ type: "hello", version, capabilities, token: "local-test-credential", coverage });

test("composed v6 explicitly negotiates performance with the closed optional tree capability", () => {
  for (const capabilities of [["performance-evidence"], ["semantic-tree", "performance-evidence"],
    ["causal-readings", "semantic-refs", "control-source", "semantic-tree", "performance-evidence"]]) {
    expect(parseBrowserMessage(hello(6, capabilities))).toEqual(hello(6, capabilities));
  }
  expect(parseBrowserMessage(hello(5, ["semantic-tree"]))).toEqual(hello(5, ["semantic-tree"]));
});

test("composed hello rejects unknown, duplicate, missing and cross-version capability claims", () => {
  for (const value of [hello(6, []), hello(6, ["semantic-tree"]), hello(6, ["performance-evidence", "unknown"]),
    hello(6, ["performance-evidence", "performance-evidence"]), hello(5, ["semantic-tree", "performance-evidence"]),
    hello(4, ["control-source", "semantic-tree"]), hello(4, ["control-source", "performance-evidence"]),
    hello(3, ["performance-evidence"]), hello(7, ["performance-evidence"])]) expect(() => parseBrowserMessage(value)).toThrow();
});

async function paired(version: number, capabilities: string[]) {
  const bridge = new VerificationBridge({ broadcast() {}, commandTimeoutMs: 300 });
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => bridge.handleUpgrade(request, socket, head));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const session = bridge.create("http://localhost:4813", undefined);
  const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/verification/ws?sessionId=${session.id}`, { headers: { Origin: session.origin } });
  await once(socket, "open");
  const ready = once(socket, "message");
  socket.send(JSON.stringify({ ...hello(version, capabilities), token: session.token }));
  expect(JSON.parse((await ready)[0].toString())).toEqual({ type: "ready" });
  return { bridge, session: bridge.get(session.id), socket,
    async close() { socket.terminate(); bridge.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test("v6 without tree and v5 without performance refuse unadvertised commands before dispatch", async () => {
  for (const choice of [{ version: 6, capabilities: ["performance-evidence"], command: { type: "semantic-tree" } as const },
    { version: 5, capabilities: ["semantic-tree"], command: { type: "performance", phase: "begin" } as const }]) {
    const f = await paired(choice.version, choice.capabilities); let dispatched = 0;
    f.socket.on("message", () => { dispatched++; });
    try {
      const result = await f.bridge.command(f.session, choice.command);
      expect(result.ok).toBe(false); expect(result.unavailable).toBe(true); expect(dispatched).toBe(0);
      expect(f.session.pending).toBeNull();
    } finally { await f.close(); }
  }
});

test("v6 union retains typed-tree response ownership and invalidates malformed owned replies", async () => {
  for (const malformed of [false, true]) {
    const f = await paired(6, ["semantic-tree", "performance-evidence"]);
    f.socket.on("message", raw => {
      const message = JSON.parse(raw.toString()) as { type: string; id: string };
      if (message.type === "command") f.socket.send(JSON.stringify({ type: "result", id: message.id, ok: true, result: malformed ? { forged: true } : tree(["Union tree"]) }));
    });
    try {
      const result = await f.bridge.command(f.session, { type: "semantic-tree" });
      expect(result.ok).toBe(!malformed); expect(f.session.pending).toBeNull();
      if (malformed) { expect(result.error).toContain("invalid verification message"); expect(f.session.capabilities).toEqual([]); }
      else { expect(result.result).toEqual(tree(["Union tree"])); expect(f.session.capabilities).toEqual(["semantic-tree", "performance-evidence"]); }
    } finally { await f.close(); }
  }
});
