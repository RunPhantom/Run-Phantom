import { beforeAll, afterAll, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { once } from "node:events";
import express from "express";
import { WebSocket } from "ws";
import { Database } from "bun:sqlite";
import { createVerificationService } from "../src/verification/service";
import { createVerificationRouter } from "../src/verification/router";
import { closeDb, getDrizzleDb } from "../src/db";
const coverage = { network: true, console: true, state: true, signal: true, dom: true, route: true };
let dir: string, previous: string | undefined;
beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), "rp-business-")); previous = process.env.RUNPHANTOM_DB_PATH; closeDb(); process.env.RUNPHANTOM_DB_PATH = path.join(dir, "business.db"); getDrizzleDb(); });
afterAll(() => { closeDb(); if (previous === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = previous; rmSync(dir, { recursive: true, force: true }); });
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
const predicate = { kind: "business-response", urlContains: "/order", operationId: "order-21", operationPath: "operationId", path: "result", equals: "paid", phase: "response" };
async function fixture(enabled = true) {
  const service = createVerificationService({ broadcast() {}, checkTimeoutMs: 550, commandTimeoutMs: 400 });
  const app = express(); app.use(express.json()); app.use("/api/verification", createVerificationRouter(service));
  const server = http.createServer(app); server.on("upgrade", (req, socket, head) => service.bridge.handleUpgrade(req, socket, head)); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const api = async (route: string, body?: unknown) => { const response = await fetch(`${url}/api/verification${route}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, body: await response.json() as any }; };
  const created = (await api("/sessions", { origin: "http://localhost:4321" })).body;
  const ws = new WebSocket(`${url.replace("http:", "ws:")}/verification/ws?sessionId=${created.id}`, { headers: { Origin: created.origin } });
  await once(ws, "open"); const ready = once(ws, "message"); ws.send(JSON.stringify({ type: "hello", version: enabled ? 4 : 1, token: created.token, coverage, ...(enabled ? { capabilities: ["business-response-evidence"] } : {}) })); await ready;
  ws.on("message", raw => { const m = JSON.parse(raw.toString()); if (m.type !== "command") return; if (m.command.type === "click") ws.send(JSON.stringify({ type: "event", event: { type: "action.boundary", actionId: m.id, data: {} } })); ws.send(JSON.stringify({ type: "result", id: m.id, ok: true, result: m.command.type === "snapshot" ? { selector: "", count: 1 } : {} })); });
  const send = (type: string, data: unknown, actionId?: string) => ws.send(JSON.stringify({ type: "event", event: { type, data, ...(actionId ? { actionId } : {}) } }));
  const source = (id: string, actionId?: string, body: unknown = { operationId: "order-21", result: "paid" }) => {
    send("network.start", { requestId: id, url: "http://localhost:4321/order", method: "POST", initiator: "fetch" }, actionId);
    send("network", { requestId: id, url: "http://localhost:4321/order", method: "POST", initiator: "fetch", status: 200, ok: true, durationMs: 1 }, actionId);
    send("network.body", { requestId: id, source: "sdk-reported", state: "pending", format: "json", bytes: 0, chunks: 0 }, actionId);
    send("network.body", { requestId: id, source: "sdk-reported", state: "complete", format: "json", bytes: 60, chunks: 1, body }, actionId);
  };
  return { api, source, send, service, created, ws, cursor: service.bridge.get(created.id).cursor, async close() { ws.terminate(); service.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test("actual HTTP and SQLite retain a bounded source contract and redact decoded keys before public evidence", async () => {
  const f = await fixture();
  try {
    f.source("n1"); await pause();
    const healthy = await f.api(`/sessions/${f.created.id}/assert`, { predicate, since: f.cursor });
    expect(healthy.status).toBe(200); expect(healthy.body.status, JSON.stringify(healthy.body)).toBe("pass");
    expect(healthy.body.context.checks[0].predicate).toEqual(predicate);
    f.source("n2", undefined, { operationId: "order-21", result: "paid", password: "private-body-synthetic", nested: { apiKey: "private-key-synthetic" } }); await pause();
    const unknown = await f.api(`/sessions/${f.created.id}/assert`, { predicate, since: healthy.body.context.checks[0].through });
    expect(unknown.body.status).toBe("inconclusive");
    const observed = await f.api(`/sessions/${f.created.id}/events`); const text = JSON.stringify(observed.body);
    expect(text).not.toContain("private-body-synthetic"); expect(text).not.toContain("private-key-synthetic"); expect(text).toContain("[REDACTED]");
    const reports = await f.api("/reports"); expect(reports.body.find((r: any) => r.id === healthy.body.id)).toEqual(healthy.body);
    const db = new Database(process.env.RUNPHANTOM_DB_PATH!, { readonly: true });
    try { const row = db.query("SELECT evidence, context FROM verification_reports WHERE id = ?").get(unknown.body.id); expect(JSON.stringify(row)).not.toContain("private-body-synthetic"); expect(JSON.stringify(row)).not.toContain("private-key-synthetic"); } finally { db.close(); }
  } finally { await f.close(); }
});

test("unnegotiated, missing, repeated and reversed body lifecycle discloses loss instead of passing", async () => {
  for (const mode of ["legacy", "missing", "duplicate", "reverse"]) {
    const f = await fixture(mode !== "legacy");
    try {
      if (mode === "legacy" || mode === "duplicate") f.source("n1");
      if (mode === "reverse") {
        f.send("network.start", { requestId: "n1", url: "http://localhost:4321/order", method: "POST", initiator: "fetch" });
        f.send("network.body", { requestId: "n1", source: "sdk-reported", state: "pending", format: "json", bytes: 0, chunks: 0 });
      } else if (mode !== "legacy") f.send("network.body", { requestId: "n1", source: "sdk-reported", state: "complete", format: "json", bytes: 30, chunks: 1, body: { operationId: "order-21", result: "paid" } });
      await pause();
      const result = await f.api(`/sessions/${f.created.id}/assert`, { predicate, since: f.cursor }); expect(result.status).toBe(200); expect(result.body.status).toBe("inconclusive");
      const observed = await f.api(`/sessions/${f.created.id}/events`); expect(observed.body.complete).toBe(false); expect(observed.body.events.some((event: any) => event.type === "capture.loss")).toBe(true);
    } finally { await f.close(); }
  }
});

test("delayed response preserves start action identity across the next action", async () => {
  const f = await fixture();
  try {
    await f.api(`/sessions/${f.created.id}/command`, { type: "click", selector: "#first" }); const old = f.service.bridge.get(f.created.id).currentActionId;
    f.send("network.start", { requestId: "n1", url: "http://localhost:4321/order", method: "POST", initiator: "fetch" }, old); await pause();
    const next = await f.api(`/sessions/${f.created.id}/command`, { type: "click", selector: "#second" });
    f.send("network", { requestId: "n1", url: "http://localhost:4321/order", method: "POST", initiator: "fetch", status: 200, ok: true, durationMs: 1 });
    f.send("network.body", { requestId: "n1", source: "sdk-reported", state: "pending", format: "json", bytes: 0, chunks: 0 });
    f.send("network.body", { requestId: "n1", source: "sdk-reported", state: "complete", format: "json", bytes: 50, chunks: 1, body: { operationId: "order-21", result: "paid" } }); await pause();
    const response = await f.api(`/sessions/${f.created.id}/assert`, { predicate, since: next.body.cursor }); expect(response.body.status).toBe("inconclusive");
    const observed = await f.api(`/sessions/${f.created.id}/events`); expect(observed.body.events.filter((event: any) => event.type === "network.body").every((event: any) => event.actionId === old)).toBe(true);
  } finally { await f.close(); }
});
