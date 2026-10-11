import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import express from "express";
import { WebSocket } from "ws";
import { closeDb, getDrizzleDb } from "../src/db";
import { createVerificationService } from "../src/verification/service";
import { createVerificationRouter } from "../src/verification/router";
import { listReports } from "../src/verification/store";
import { boundReportContext } from "../src/verification/report-context";
import { parseBrowserMessage, parseCommand, parseFlowSteps, parsePredicate } from "../src/verification/validation";
import { VERIFICATION_LIMITS as L, type AppCommand, type Predicate, type RelativeTarget, type VerificationReportContext } from "../src/verification/protocol";

const coverage = { network: true, console: true, dom: true, state: true, signal: true, route: true };
const origin = "http://localhost:4312";
const target: RelativeTarget = { kind: "state", store: "cart", path: "count" };
const relative = (relation: "changed" | "increased" | "decreased" | "becomes", equals?: unknown): Predicate =>
  relation === "becomes" ? { kind: "relative", target, relation, equals } : { kind: "relative", target, relation };
const command: AppCommand = { type: "causal-click", selector: "#increment", targets: [target] };
let directory: string;
let oldDb: string | undefined;
beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), "rp-causal-"));
  oldDb = process.env.RUNPHANTOM_DB_PATH;
  closeDb();
  process.env.RUNPHANTOM_DB_PATH = path.join(directory, "verification.db");
  getDrizzleDb();
});
afterAll(() => {
  closeDb();
  if (oldDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = oldDb;
  rmSync(directory, { recursive: true, force: true });
});

async function fixture(version: 1 | 2 = 2, capable = true) {
  const service = createVerificationService({ broadcast() {}, checkTimeoutMs: 800, commandTimeoutMs: 500 });
  const app = express();
  app.use(express.json());
  app.use("/api/verification", createVerificationRouter(service));
  const server = http.createServer(app);
  server.on("upgrade", (req, socket, head) => service.bridge.handleUpgrade(req, socket, head));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function api(route: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(`${url}/api/verification${route}`, { method, headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  }
  const { body: created } = await api("/sessions", { origin });
  const ws = new WebSocket(`${url.replace("http:", "ws:")}/verification/ws?sessionId=${created.id}`, { headers: { Origin: origin } });
  await once(ws, "open");
  const ready = once(ws, "message");
  ws.send(JSON.stringify({ type: "hello", version, token: created.token, coverage,
    ...(version === 2 ? { capabilities: capable ? ["causal-readings"] : [] } : {}) }));
  expect(JSON.parse((await ready)[0].toString())).toEqual({ type: "ready" });
  const route = `/sessions/${created.id}`;
  return { api, service, ws, created, route, url, async close() {
    ws.terminate(); service.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

function event(ws: WebSocket, type: string, data: unknown, actionId?: string) {
  ws.send(JSON.stringify({ type: "event", event: { type, data, ...(actionId ? { actionId } : {}) } }));
}
function respond(ws: WebSocket, before: unknown, after: unknown, available = true,
  alter?: (id: string, targets: RelativeTarget[]) => void) {
  ws.on("message", raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== "command") return;
    if (msg.command.type === "causal-click") {
      if (alter) { alter(msg.id, msg.command.targets); return; }
      for (const entry of msg.command.targets) event(ws, "action.reading", { phase: "before", target: entry, available, ...(available ? { value: before } : {}) }, msg.id);
      event(ws, "action.boundary", {}, msg.id);
      for (const entry of msg.command.targets) event(ws, "action.reading", { phase: "after", target: entry, available, ...(available ? { value: after } : {}) }, msg.id);
    } else if (msg.command.type === "click") {
      event(ws, "action.boundary", {}, msg.id);
      event(ws, "state", { store: "cart", value: { count: after } }, msg.id);
    }
    ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true,
      result: msg.command.type === "state" ? { store: "cart", value: { count: after } } : {} }));
  });
}

describe("owned causal verification dispatch", () => {
  test("legacy hello remains closed while the new capability requires explicit negotiation", () => {
    expect(parseBrowserMessage({ type: "hello", version: 1, token: "test", coverage }).type).toBe("hello");
    expect(parseBrowserMessage({ type: "hello", version: 2, token: "test", coverage, capabilities: ["causal-readings"] })).toMatchObject({ version: 2 });
    for (const invalid of [
      { version: 1, capabilities: ["causal-readings"] }, { version: 2 }, { version: 2, capabilities: ["trusted-browser"] },
      { version: 2, capabilities: ["causal-readings", "causal-readings"] }, { version: 4, capabilities: [] },
    ]) expect(() => parseBrowserMessage({ type: "hello", token: "test", coverage, ...invalid })).toThrow();
    expect(() => parseBrowserMessage({ type: "event", event: { type: "action.result", actionId: "a", data: {} } })).toThrow();
  });

  test("relative wire schemas refuse caller proof, unsafe scopes and mismatched saved targets", () => {
    expect(parsePredicate(relative("increased"))).toEqual(relative("increased"));
    expect(parseCommand(command)).toEqual(command);
    for (const invalid of [
      { ...relative("changed"), causal: true }, { ...relative("changed"), actionId: "a" },
      { ...relative("changed"), equals: 1 }, { kind: "relative", target, relation: "becomes" },
      { kind: "relative", target: { ...target, generation: 1 }, relation: "changed" },
      { kind: "relative", target: { ...target, path: "__proto__.count" }, relation: "changed" },
      { kind: "relative", target: { ...target, path: "password" }, relation: "changed" },
      { kind: "relative", target: { kind: "element", selector: "[pass\\77 ord]" }, relation: "changed" },
      { kind: "relative", target: { kind: "element", selector: "#result" }, relation: "becomes", equals: "1" },
      { kind: "relative", target: { kind: "element", selector: "#result" }, relation: "becomes", equals: -1 },
    ]) expect(() => parsePredicate(invalid)).toThrow();
    expect(() => parseCommand({ ...command, targets: [target, target] })).toThrow();
    expect(() => parseBrowserMessage({ type: "event", event: { type: "action.reading", actionId: "a",
      data: { phase: "before", target, available: false, value: 0 } } })).toThrow();
    expect(() => parseFlowSteps([{ predicate: relative("changed") }])).toThrow();
    expect(() => parseFlowSteps([{ command: { ...command, targets: [{ ...target, path: "other" }] }, predicate: relative("changed") }])).toThrow();
    const unique = Array.from({ length: 20 }, (_, at) => ({ kind: "relative", relation: "changed", target: { ...target, path: `v${at}` } }));
    expect(() => parsePredicate({ kind: "allOf", predicates: [{ kind: "allOf", predicates: unique }, relative("changed")] })).toThrow();
  });

  test("HTTP actions bind ordered scoped readings and saved legacy clicks opt into capture", async () => {
    const f = await fixture();
    try {
      respond(f.ws, 1, 2);
      const action = await f.api(`${f.route}/command`, command);
      expect(action.body).toMatchObject({ ok: true, result: { acknowledged: true } });
      const report = await f.api(`${f.route}/assert`, { predicate: relative("increased"), since: action.body.cursor });
      expect(report.body.status).toBe("pass");
      expect(report.body.context.checks[0].causal).toMatchObject({ source: "sdk-reported", attribution: "captured",
        readings: [{ target, before: { value: 1, availability: "complete" }, after: { value: 2, availability: "complete" } }] });
      const captured = f.service.bridge.get(f.created.id).lastCausalResult!;
      const pair = [...captured.pairs.values()][0];
      expect(pair.before.cursor).toBeLessThan(captured.actionCursor);
      expect(pair.after.cursor).toBeGreaterThan(captured.actionCursor);
      expect(pair.after.scope.sessionId).toBe(f.created.id);
      expect(pair.after.scope.generation).toBe(captured.generation);
      const flow = await f.api("/flows", { name: "Increment", origin, steps: [{ command: { type: "click", selector: "#increment" }, predicate: relative("increased") }] });
      expect(flow.status).toBe(201);
      const replay = await f.api(`/flows/${flow.body.id}/run`, { sessionId: f.created.id });
      expect(replay.body.status).toBe("pass");
      expect(replay.body.context.checks[0].predicate).toEqual(relative("increased"));
    } finally { await f.close(); }
  });

  test("already-true expectations stay inconclusive and current-condition checks still pass", async () => {
    const f = await fixture();
    try {
      respond(f.ws, 2, 2);
      const action = await f.api(`${f.route}/command`, command);
      const already = await f.api(`${f.route}/assert`, { predicate: relative("becomes", 2), since: action.body.cursor });
      expect(already.body.status).toBe("inconclusive");
      expect(already.body.reason).toContain("already held");
      const unchanged = await f.api(`${f.route}/assert`, { predicate: relative("changed"), since: action.body.cursor });
      expect(unchanged.body.status).toBe("fail");
      const current = await f.api(`${f.route}/assert`, { predicate: { kind: "state", store: "cart", path: "count", equals: 2 }, since: action.body.cursor });
      expect(current.body.status).toBe("pass");
    } finally { await f.close(); }
  });

  test("ordinary action-tagged observations and later background changes cannot replace the captured result", async () => {
    const f = await fixture();
    try {
      respond(f.ws, 0, 0);
      const plain = await f.api(`${f.route}/command`, { type: "click", selector: "#increment" });
      const missing = await f.api(`${f.route}/assert`, { predicate: relative("changed"), since: plain.body.cursor });
      expect(missing.body.status).toBe("inconclusive");
      const causal = await f.api(`${f.route}/command`, command);
      event(f.ws, "state", { store: "cart", value: { count: 1 } });
      const background = await f.api(`${f.route}/assert`, { predicate: relative("becomes", 1), since: causal.body.cursor });
      expect(background.body.status).toBe("fail");
      expect(background.body.context.checks[0].causal.readings[0].after.value).toBe(0);
      const forged = await f.api(`${f.route}/assert`, { predicate: relative("changed"), since: causal.body.cursor, proof: { causal: true } });
      expect(forged.status).toBe(400);
    } finally { await f.close(); }
  });

  test.each([1, 2] as const)("protocol v%i without the capability refuses before action execution", async version => {
    const f = await fixture(version, false);
    try {
      let dispatched = 0;
      f.ws.on("message", raw => { if (JSON.parse(raw.toString()).type === "command") dispatched++; });
      const action = await f.api(`${f.route}/command`, command);
      expect(action.body.ok).toBe(false);
      expect(action.body.error).toContain("no action was executed");
      expect(dispatched).toBe(0);
      const flow = await f.api("/flows", { name: "Unavailable capture", origin, steps: [{ command: { type: "click", selector: "#increment" }, predicate: relative("changed") }] });
      const replay = await f.api(`/flows/${flow.body.id}/run`, { sessionId: f.created.id });
      expect(replay.body.status).toBe("inconclusive");
      expect(replay.body.context.checks[0].causal.attribution).toBe("unavailable");
      expect(dispatched).toBe(0);
      respond(f.ws, 0, 1);
      expect((await f.api(`${f.route}/command`, { type: "click", selector: "#increment" })).body.ok).toBe(true);
    } finally { await f.close(); }
  });

  test("missing or privacy-redacted source readings remain inspectable and inconclusive", async () => {
    for (const variant of [{ available: false, before: 0 }, { available: true, before: "Bearer private-causal-credential" }]) {
      const f = await fixture();
      try {
        respond(f.ws, variant.before, 1, variant.available);
        const action = await f.api(`${f.route}/command`, command);
        expect(action.body.ok).toBe(true);
        const report = await f.api(`${f.route}/assert`, { predicate: relative("increased"), since: action.body.cursor });
        expect(report.body.status).toBe("inconclusive");
        expect(report.body.context.checks[0].causal.attribution).toBe("unavailable");
        expect(JSON.stringify(report.body)).not.toContain("private-causal-credential");
      } finally { await f.close(); }
    }
  });

  test("wrong identity, target, phase ordering, duplicate and incomplete turns invalidate rather than hang", async () => {
    const alterations = [
      (ws: WebSocket, _id: string) => event(ws, "action.reading", { phase: "before", target, available: true, value: 0 }, "wrong_action"),
      (ws: WebSocket, id: string) => event(ws, "action.reading", { phase: "before", target: { ...target, path: "other" }, available: true, value: 0 }, id),
      (ws: WebSocket, id: string) => event(ws, "action.reading", { phase: "after", target, available: true, value: 1 }, id),
      (ws: WebSocket, id: string) => event(ws, "action.boundary", {}, id),
      (ws: WebSocket, id: string) => { for (let at = 0; at < 2; at++) event(ws, "action.reading", { phase: "before", target, available: true, value: 0 }, id); },
      (ws: WebSocket, id: string) => { event(ws, "action.reading", { phase: "before", target, available: true, value: 0 }, id); event(ws, "action.boundary", {}, id); ws.send(JSON.stringify({ type: "result", id, ok: true })); },
    ];
    for (const alter of alterations) {
      const f = await fixture();
      try {
        respond(f.ws, 0, 1, true, id => alter(f.ws, id));
        const action = await f.api(`${f.route}/command`, command);
        expect(action.status).toBe(200);
        expect(action.body.ok).toBe(false);
        expect(f.service.bridge.get(f.created.id).lastCausalResult).toBeUndefined();
      } finally { await f.close(); }
    }
  });

  test("lost observers and a different interval cannot borrow a healthy owned result", async () => {
    const f = await fixture();
    try {
      respond(f.ws, 0, 1);
      const action = await f.api(`${f.route}/command`, command);
      const wider = await f.api(`${f.route}/assert`, { predicate: relative("increased"), since: action.body.cursor - 1 });
      expect(wider.body.status).toBe("inconclusive");
      expect(wider.body.context.checks[0].causal.attribution).toBe("unavailable");
      event(f.ws, "observer.error", { observer: "state", message: "Store observer stopped" });
      const lost = await f.api(`${f.route}/assert`, { predicate: relative("increased"), since: action.body.cursor });
      expect(lost.body.status).toBe("inconclusive");
    } finally { await f.close(); }
  });

  test("report readings survive deletion and restart as inspectable data without a new live proof", async () => {
    const f = await fixture();
    try {
      respond(f.ws, 0, 1);
      const flow = await f.api("/flows", { name: "Retained transition", origin, steps: [{ command: { type: "click", selector: "#increment" }, predicate: relative("changed") }] });
      const replay = await f.api(`/flows/${flow.body.id}/run`, { sessionId: f.created.id });
      expect(replay.body.status).toBe("pass");
      await f.api(`/flows/${flow.body.id}`, undefined, "DELETE");
      await f.api(f.route, undefined, "DELETE");
      closeDb();
      expect(listReports().find(entry => entry.id === replay.body.id)?.context).toEqual(replay.body.context);
      expect(JSON.stringify(getDrizzleDb().$client.query("SELECT context, evidence FROM verification_reports").all())).not.toContain(f.created.token);
      expect(f.service.bridge.sessions.size).toBe(0);
    } finally { await f.close(); }
  });

  test("large before/after context obeys its UTF-8 budget while retaining every executed status", () => {
    const checks: VerificationReportContext["checks"] = Array.from({ length: 20 }, (_, at) => ({ step: at + 1,
      predicate: relative("changed"), status: "inconclusive", reason: "Partial capture", since: 1, through: 4,
      generation: 1, coverage, complete: true, dropped: 0, settled: true,
      causal: { source: "sdk-reported", attribution: "captured", actionId: "test_action", readings: [
        { target, before: { cursor: 2, availability: "complete", value: "界".repeat(4096) }, after: { cursor: 3, availability: "complete", value: "界".repeat(4096) } },
      ] } }));
    const result = boundReportContext({ origin, quietMs: 300, redacted: false, truncated: false, checks });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(L.MAX_CONTEXT_BYTES);
    expect(result.truncated).toBe(true);
    expect(result.checks).toHaveLength(20);
    expect(result.checks.every(check => check.status === "inconclusive" && check.since === 1 && check.through === 4)).toBe(true);
    expect(result.checks.some(check => check.causal?.attribution === "unavailable")).toBe(true);
    expect(checks[0].causal?.readings[0].before?.value).toBe("界".repeat(4096));
  });
});
