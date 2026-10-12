import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { VERIFICATION_LIMITS as L } from "../src/verification/protocol";
import { once } from "node:events";
import express from "express";
import { WebSocket } from "ws";
import { closeDb, getDrizzleDb } from "../src/db";
import { createVerificationService } from "../src/verification/service";
import { createVerificationRouter } from "../src/verification/router";
import { parseBrowserMessage } from "../src/verification/validation";
import { evaluatePredicate } from "../src/verification/predicates";
import { parseControlSourceObservation } from "../src/verification/build/source";
import type { VerificationReport } from "../src/verification/protocol";
import { listReports, saveReport } from "../src/verification/store";
const getReport = (id: string) => listReports().find(report => report.id === id);

const coverage = { network: true, console: true, dom: true, state: true, signal: true, route: true };
const observation = { source: "sdk-reported", framework: "react", status: "captured", mechanism: "dev-stamp", scope: "control", file: "src/Checkout.tsx", line: 12, column: 5 };
let directory: string; let previousDb: string | undefined;
beforeAll(() => { directory = mkdtempSync(path.join(tmpdir(), "rp-source-context-")); previousDb = process.env.RUNPHANTOM_DB_PATH; closeDb(); process.env.RUNPHANTOM_DB_PATH = path.join(directory, "context.db"); getDrizzleDb(); });
afterAll(() => { closeDb(); if (previousDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = previousDb; rmSync(directory, { recursive: true, force: true }); });

async function fixture(capabilities = ["control-source"]) {
  const service = createVerificationService({ broadcast() {}, commandTimeoutMs: 500, checkTimeoutMs: 650 });
  const app = express(); app.use(express.json()); app.use("/api/verification", createVerificationRouter(service));
  const server = http.createServer(app); server.on("upgrade", (req, socket, head) => service.bridge.handleUpgrade(req, socket, head)); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function api(route: string, body?: unknown) { const response = await fetch(`${url}/api/verification${route}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() as any }; }
  const created = (await api("/sessions", { origin: "http://localhost:4812" })).body;
  const ws = new WebSocket(`${url.replace("http:", "ws:")}/verification/ws?sessionId=${created.id}`, { headers: { Origin: created.origin } });
  await once(ws, "open"); const ready = Promise.race([once(ws, "message"), once(ws, "close").then(([code]) => { throw new Error(`SDK negotiation refused: ${code}`); })]);
  ws.send(JSON.stringify({ type: "hello", version: capabilities.includes("control-source") ? 4 : 3, token: created.token, coverage, capabilities }));
  try { expect(JSON.parse((await ready)[0].toString())).toEqual({ type: "ready" }); }
  catch (error) { ws.terminate(); service.close(); await new Promise<void>(resolve => server.close(() => resolve())); throw error; }
  const emit = (type: string, data: unknown, actionId?: string) => ws.send(JSON.stringify({ type: "event", event: { type, data, ...(actionId ? { actionId } : {}) } }));
  return { service, ws, api, created, emit, route: `/sessions/${created.id}`, async close() { ws.terminate(); service.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

describe("authenticated source context is correlated without verification authority", () => {
  test("v4 is explicit while legacy and closed source schemas remain fenced", () => {
    expect(parseBrowserMessage({ type: "hello", version: 4, token: "credential", coverage, capabilities: ["control-source", "semantic-refs", "causal-readings"] })).toMatchObject({ version: 4 });
    for (const capabilities of [[], ["semantic-refs"], ["control-source", "control-source"], ["trusted-source"]]) expect(() => parseBrowserMessage({ type: "hello", version: 4, token: "credential", coverage, capabilities })).toThrow();
    for (const event of [{ type: "action.source", data: { observation } }, { type: "action.source", actionId: "owned", data: { observation: { ...observation, file: "/private/A.tsx" } } }, { type: "action.source", actionId: "owned", data: { observation }, truncated: true }, { type: "action.source", actionId: "owned", data: { observation, trusted: true } }]) expect(() => parseBrowserMessage({ type: "event", event })).toThrow();
  });
  test("actual command→assert→file reopen retains only owned minimized context and fail verdict", async () => {
    const f = await fixture();
    try {
      f.ws.on("message", raw => { const msg = JSON.parse(raw.toString()); if (msg.type !== "command") return;
        if (msg.command.type === "click") { f.emit("action.source", { observation }, msg.id); f.emit("action.boundary", {}, msg.id); f.emit("console", { level: "error", message: "Actual failing interval" }, msg.id); }
        f.ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: { props: { password: "must-never-persist" }, controlSource: { trusted: true } } }));
      });
      const acted = (await f.api(`${f.route}/command`, { type: "click", selector: "#pay" })).body;
      expect(acted.ok).toBe(true); expect(acted.controlSource.observation).toEqual(observation); expect(acted.result).toEqual({ acknowledged: true });
      const report = (await f.api(`${f.route}/assert`, { predicate: { kind: "console", level: "error", absent: true }, since: acted.cursor })).body;
      expect(report.status).toBe("fail"); expect(report.context.checks[0].controlSource).toEqual(acted.controlSource); expect(JSON.stringify(report)).not.toContain("must-never-persist"); expect(JSON.stringify(report)).not.toContain(f.created.token);
      const before = JSON.stringify(getReport(report.id)); closeDb(); getDrizzleDb(); expect(JSON.stringify(getReport(report.id))).toBe(before);
      const wrongInterval = (await f.api(`${f.route}/assert`, { predicate: { kind: "console", level: "error", absent: true }, since: acted.cursor + 1 })).body;
      expect(wrongInterval.context.checks[0].controlSource).toBeUndefined();
    } finally { await f.close(); }
  });
  test("full-navigation flow keeps pre-dispatch old-generation source and remains inconclusive", async () => {
    const f = await fixture();
    try {
      const generation = f.service.bridge.get(f.created.id).generation;
      f.ws.on("message", raw => { const msg = JSON.parse(raw.toString()); if (msg.type !== "command") return; f.emit("action.source", { observation }, msg.id); f.emit("action.boundary", {}, msg.id); f.ws.close(); });
      const flow = (await f.api("/flows", { name: "Navigation", origin: f.created.origin, steps: [{ command: { type: "click", selector: "#navigate" }, predicate: { kind: "signal", name: "finished" } }] })).body;
      const report = (await f.api(`/flows/${flow.id}/run`, { sessionId: f.created.id })).body;
      expect(report.status).toBe("inconclusive"); expect(report.context.checks[0].complete).toBe(false); expect(report.context.checks[0].controlSource.observation).toEqual(observation);
      expect(report.context.checks[0].controlSource.generation).toBe(generation); expect(f.service.bridge.get(f.created.id).generation).toBeGreaterThan(generation);
      expect(f.service.bridge.get(f.created.id).lastControlSource).toBeUndefined();
    } finally { await f.close(); }
  });
  test("actual twenty-step source flow shares the stored UTF-8 budget and retains exact outcomes after file reopen", async () => {
    // Controlled local SDK executor: real authenticated socket/events, no provider or manufactured report.
    const f = await fixture(["control-source", "causal-readings"]);
    const target = { kind: "state", store: "payload", path: "value" };
    const predicate = { kind: "relative", target, relation: "changed" };
    const actions: Array<{ id: string; before: string; after: string }> = [];
    try {
      f.ws.on("message", raw => {
        const msg = JSON.parse(raw.toString()); if (msg.type !== "command") return;
        if (msg.command.type === "causal-click") {
          const before = String(actions.length % 2).repeat(1900); const after = String((actions.length + 1) % 2).repeat(1900);
          actions.push({ id: msg.id, before, after }); f.emit("action.source", { observation }, msg.id);
          f.emit("action.reading", { phase: "before", target, available: true, value: before }, msg.id);
          f.emit("action.boundary", {}, msg.id);
          f.emit("action.reading", { phase: "after", target, available: true, value: after }, msg.id);
        }
        f.ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true }));
      });
      const generation = f.service.bridge.get(f.created.id).generation;
      const flow = await f.api("/flows", { name: "Bounded source flow", origin: f.created.origin, steps: Array.from({ length: 20 }, () => ({ command: { type: "click", selector: "#pay" }, predicate })) });
      expect(flow.status).toBe(201);
      const executed = await f.api(`/flows/${flow.body.id}/run`, { sessionId: f.created.id }); expect(executed.status).toBe(200);
      const report = executed.body; expect(actions).toHaveLength(20); expect(report.status).toBe("pass"); expect(report.context.checks).toHaveLength(20);
      expect(Buffer.byteLength(JSON.stringify(report.context))).toBeLessThanOrEqual(L.MAX_CONTEXT_BYTES); expect(report.context.truncated).toBe(true);
      expect(report.context.checks.every((check: any) => check.controlSource === undefined && check.controlSourceOmitted === "context-limit")).toBe(true);
      for (let index = 0; index < 20; index++) {
        const check = report.context.checks[index]; expect(check).toMatchObject({ step: index + 1, predicate, status: "pass", generation, coverage, complete: true, dropped: 0, settled: true });
        expect(check.since).toBeLessThan(check.through); expect(check.causal.actionId).toBe(actions[index].id);
        const pair = check.causal.readings[0]; expect(pair.target).toEqual(target);
        for (const phase of ["before", "after"] as const) {
          const reading = pair[phase];
          if (reading.availability === "complete") expect(reading.value).toBe(actions[index][phase]);
          else { expect(reading.availability).toBe("partial"); expect(reading.value).toBe("[TRUNCATED]"); expect(check.causal.attribution).toBe("unavailable"); }
        }
      }
      const raw = (getDrizzleDb().$client.query("SELECT context FROM verification_reports WHERE id = ?").get(report.id) as { context: string }).context;
      expect(JSON.parse(raw)).toEqual(report.context); expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(L.MAX_CONTEXT_BYTES);
      const digest = createHash("sha256").update(raw).digest("hex");
      closeDb(); getDrizzleDb(); expect(getReport(report.id)).toEqual(report);
      expect((await f.api("/reports")).body.find((item: any) => item.id === report.id)).toEqual(report);
      const reopened = (getDrizzleDb().$client.query("SELECT context FROM verification_reports WHERE id = ?").get(report.id) as { context: string }).context;
      expect(reopened).toBe(raw); expect(createHash("sha256").update(reopened).digest("hex")).toBe(digest);
      console.info(JSON.stringify({ actualSdkExecutor: "controlled-local", executedSteps: actions.length, contextBytes: Buffer.byteLength(raw), omittedSources: 20, contextSha256: digest, fileReopenEqual: true }));
    } finally { await f.close(); }
  }, 30_000);
  test("the real save/reopen boundary budgets synthetic CJK display context without changing an evaluated verdict", () => {
    // Valid synthetic large context qualifies the actual store; it is not a browser-produced report.
    const source = { actionId: randomUUID(), commandCursor: 1, cursor: 2, generation: 1, capture: "before-dispatch" as const,
      observation: parseControlSourceObservation({ ...observation, file: "src/" + '"'.repeat(260) + ".tsx", line: 1, column: 1, component: '"'.repeat(128) }) };
    const predicate = { kind: "console", level: "error", absent: true } as const;
    const verdict = evaluatePredicate(predicate, { events: [], coverage, complete: true, settled: true }); expect(verdict.status).toBe("pass");
    const input: VerificationReport = { ...verdict, id: randomUUID(), sessionId: randomUUID(), runId: null, flowId: null, name: "Synthetic CJK context storage boundary", createdAt: Date.now(),
      context: { origin: "http://localhost:4812", quietMs: 300, redacted: false, truncated: false,
        checks: Array.from({ length: 20 }, (_, index) => ({ step: index + 1, predicate, status: "pass", reason: "汉".repeat(1000), since: 1, through: 5, generation: 1, coverage, complete: true, dropped: 0, settled: true, controlSource: source })) } };
    const before = JSON.stringify(input); const stored = saveReport(input);
    expect(stored.status).toBe(verdict.status); expect(stored.reason).toBe(verdict.reason); expect(stored.evidence).toEqual(verdict.evidence);
    expect(stored.context!.checks).toHaveLength(20); expect(stored.context!.truncated).toBe(true);
    expect(stored.context!.checks.every(check => check.status === "pass" && check.since === 1 && check.through === 5 && check.generation === 1 && check.complete && check.settled && check.dropped === 0 && check.controlSourceOmitted === "context-limit")).toBe(true);
    expect(stored.context!.checks.filter(check => check.reason === "[TRUNCATED]")).toHaveLength(1);
    const raw = (getDrizzleDb().$client.query("SELECT context FROM verification_reports WHERE id = ?").get(input.id) as { context: string }).context;
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(L.MAX_CONTEXT_BYTES); expect(JSON.parse(raw)).toEqual(stored.context); expect(JSON.stringify(input)).toBe(before);
    const digest = createHash("sha256").update(raw).digest("hex"); closeDb(); getDrizzleDb(); expect(getReport(stored.id)).toEqual(stored);
    const reopened = (getDrizzleDb().$client.query("SELECT context FROM verification_reports WHERE id = ?").get(input.id) as { context: string }).context;
    expect(reopened).toBe(raw); expect(createHash("sha256").update(reopened).digest("hex")).toBe(digest);
    const count = (getDrizzleDb().$client.query("SELECT COUNT(*) as n FROM verification_reports").get() as { n: number }).n;
    expect(() => saveReport({ ...input, id: randomUUID(), context: { ...input.context!, origin: "x".repeat(L.MAX_CONTEXT_BYTES) } })).toThrow("Saved verification context exceeds its required outcome budget");
    expect((getDrizzleDb().$client.query("SELECT COUNT(*) as n FROM verification_reports").get() as { n: number }).n).toBe(count);
    console.info(JSON.stringify({ fixture: "synthetic-valid-context-at-actual-store", executedVerdictPreserved: true, storedContextBytes: Buffer.byteLength(raw), contextSha256: digest, fileReopenEqual: true, impossibleFloorAtomicRefusal: true }));
  });
  test("session token and current fill secret cannot be retained as filenames", async () => {
    const f = await fixture();
    try {
      f.ws.on("message", raw => { const msg = JSON.parse(raw.toString()); if (msg.type !== "command") return; const file = msg.command.type === "fill" ? "src/fill-secret.tsx" : `src/${f.created.token}.tsx`; f.emit("action.source", { observation: { ...observation, file } }, msg.id); f.emit("action.boundary", {}, msg.id); f.ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true })); });
      for (const command of [{ type: "click", selector: "#pay" }, { type: "fill", selector: "#name", value: "fill-secret" }]) { const acted = (await f.api(`${f.route}/command`, command)).body; expect(acted.controlSource.observation).toEqual({ source: "sdk-reported", framework: "react", status: "unavailable", reason: "redacted" }); expect(JSON.stringify(acted)).not.toContain(f.created.token); expect(JSON.stringify(acted)).not.toContain("fill-secret"); }
    } finally { await f.close(); }
  });
  for (const mode of ["wrong-id", "duplicate", "late", "outside-turn", "unnegotiated", "malformed"]) test(`actual socket refuses ${mode} source without dispatch proof`, async () => {
    const f = await fixture(mode === "unnegotiated" ? ["semantic-refs"] : ["control-source"]);
    try {
      const closed = once(f.ws, "close");
      if (mode === "outside-turn") f.emit("action.source", { observation }, "unowned");
      else {
        f.ws.on("message", raw => { const msg = JSON.parse(raw.toString()); if (msg.type !== "command") return;
          if (mode === "late") f.emit("action.boundary", {}, msg.id);
          f.emit("action.source", { observation: mode === "malformed" ? { ...observation, line: -1 } : observation }, mode === "wrong-id" ? "foreign-action" : msg.id);
          if (mode === "duplicate") f.emit("action.source", { observation }, msg.id);
        });
        const acted = (await f.api(`${f.route}/command`, { type: "click", selector: "#pay" })).body; expect(acted.ok).toBe(false);
      }
      expect((await closed)[0]).toBe(1008); expect(f.service.bridge.get(f.created.id).ws).toBeNull(); expect(f.service.bridge.get(f.created.id).lastControlSource).toBeUndefined();
    } finally { await f.close(); }
  });
});
