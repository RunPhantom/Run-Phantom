import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { WebSocket } from "ws";
import { closeDb, getDrizzleDb } from "../src/db";
import { createVerificationService } from "../src/verification/service";
import { createVerificationRouter } from "../src/verification/router";
import { getFlow, rebindFlow } from "../src/verification/store";
import { anchorForCandidate } from "../src/verification/flow-anchors";
import type { FlowRepairProposal } from "../src/verification/flow-repair";
const runtimeCoverage = { network: true, console: true, dom: true, state: true, signal: true, route: true };
const coverage = { scope: "visible-observable-dom", complete: true, visitedNodes: 3, openShadowRoots: 0, sameOriginFrames: 0, inaccessibleFrames: 0, closedShadowRoots: "unobservable", hiddenSubtrees: 0, privateSubtrees: 0, truncated: false, reasons: [], unread: [] };
const item = { ref: "rpref_" + "1".repeat(32), tag: "button", role: "button", name: "Pay 日本語", label: "", testId: "order-42", depth: 1, disabled: false, readonly: false };
const steps = [{ command: { type: "click", selector: "#original" }, predicate: { kind: "signal", name: "finished" } }];
let directory: string; let previousDb: string | undefined;
beforeAll(() => { directory = mkdtempSync(path.join(tmpdir(), "rp-flow-repair-")); previousDb = process.env.RUNPHANTOM_DB_PATH; closeDb(); process.env.RUNPHANTOM_DB_PATH = path.join(directory, "flows.db"); getDrizzleDb(); });
afterAll(() => { closeDb(); if (previousDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = previousDb; rmSync(directory, { recursive: true, force: true }); });
const stored = (id: string) => (getDrizzleDb().$client.query("SELECT steps FROM verification_flows WHERE id = ?").get(id) as { steps: string }).steps;
async function fixture() {
 const service = createVerificationService({ broadcast() {}, commandTimeoutMs: 500, checkTimeoutMs: 650 });
 const app = express(); app.use(express.json()); app.use("/api/verification", createVerificationRouter(service));
 const server = http.createServer(app); server.on("upgrade", (req, socket, head) => service.bridge.handleUpgrade(req, socket, head)); server.listen(0, "127.0.0.1"); await once(server, "listening");
 const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
 async function api(route: string, body?: unknown, method?: string) { const response = await fetch(`${url}/api/verification${route}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() as any }; }
 const created = (await api("/sessions", { origin: "http://localhost:4812" })).body;
 const ws = new WebSocket(`${url.replace("http:", "ws:")}/verification/ws?sessionId=${created.id}`, { headers: { Origin: created.origin } });
 await once(ws, "open"); const ready = once(ws, "message"); ws.send(JSON.stringify({ type: "hello", version: 3, token: created.token, coverage: runtimeCoverage, capabilities: ["semantic-refs"] })); expect(JSON.parse((await ready)[0].toString())).toEqual({ type: "ready" });
 let snapshot: any = { source: "sdk-reported", nameModel: "partial-aria", documentGeneration: "2".repeat(32), count: 1, countExact: true, elements: [item], coverage };
 const actions: string[] = [];
 ws.on("message", raw => { const msg = JSON.parse(raw.toString()); if (msg.type !== "command") return;
   if (["click", "ref-click", "fill", "ref-fill"].includes(msg.command.type)) { actions.push(msg.command.type); ws.send(JSON.stringify({ type: "event", event: { type: "action.boundary", data: {}, actionId: msg.id } })); ws.send(JSON.stringify({ type: "event", event: { type: "signal", data: { name: "finished" }, actionId: msg.id } })); }
   ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: msg.command.type === "semantic-snapshot" ? snapshot : msg.command.type === "snapshot" ? { count: 0, selector: msg.command.selector ?? "button" } : undefined }));
 });
 const flow = (await api("/flows", { name: "Repair", origin: created.origin, steps })).body;
 return { service, api, created, flow, actions, setSnapshot(value: unknown) { snapshot = value; }, snapshot() { return structuredClone(snapshot); }, async propose() { return api(`/flows/${flow.id}/repair-proposals`, { sessionId: created.id, step: 0 }); }, async close() { ws.terminate(); service.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
describe("explicit reviewed repair at real HTTP/socket/SQLite boundary", () => {
 test("legacy array read and canceled review keep original stored bytes exactly", async () => {
  const f = await fixture(); try {
   const raw = '[  ' + JSON.stringify(steps[0]) + '  ]'; getDrizzleDb().$client.query("UPDATE verification_flows SET steps = ? WHERE id = ?").run(raw, f.flow.id);
   expect(getFlow(f.flow.id).steps[0].command).toEqual(steps[0].command); expect(stored(f.flow.id)).toBe(raw);
   const proposal = await f.propose(); expect(proposal.status).toBe(201); expect(proposal.body.oldMatch.matches).toBe(0);
   expect(proposal.body.oldAnchor).toEqual({ kind: "css", selector: "#original" }); expect(JSON.stringify(proposal.body)).not.toContain("rpref_");
   await f.api(`/flows/${f.flow.id}/repair-proposals/${proposal.body.id}`, undefined, "DELETE");
   expect(stored(f.flow.id)).toBe(raw); expect(f.actions).toHaveLength(0);
  } finally { await f.close(); }
 });
 test("selected commit preserves CSS/predicate, saves no live ref and survives SQLite reopen", async () => {
  const f = await fixture(); try {
   const proposal: FlowRepairProposal = (await f.propose()).body; const before = stored(f.flow.id);
   const committed = await f.api(`/flows/${f.flow.id}/repair-proposals/${proposal.id}/commit`, { candidateId: proposal.candidates[0].id, revision: proposal.revision });
   expect(committed.status).toBe(200); expect(f.actions).toHaveLength(0); expect(stored(f.flow.id)).not.toBe(before); expect(stored(f.flow.id)).not.toContain("rpref_");
   expect(committed.body.steps[0].command).toEqual(steps[0].command); expect(committed.body.steps[0].predicate).toEqual(steps[0].predicate);
   const raw = stored(f.flow.id); closeDb(); getDrizzleDb(); expect(stored(f.flow.id)).toBe(raw); expect(getFlow(f.flow.id)).toEqual(committed.body);
   const run = await f.api(`/flows/${f.flow.id}/run`, { sessionId: f.created.id }); expect(run.body.status).toBe("pass"); expect(f.actions).toEqual(["ref-click"]);
  } finally { await f.close(); }
 });
 for (const mode of ["ambiguous", "partial", "reloaded", "recreated", "conflict", "malformed", "wrong-selection"]) test(`${mode} repair refuses writes and performs zero actions`, async () => {
  const f = await fixture(); try {
   const proposal: FlowRepairProposal = (await f.propose()).body;
   if (mode === "conflict") rebindFlow(f.flow.id, proposal.revision, 0, anchorForCandidate({ ...item, testId: "another" }));
   const before = stored(f.flow.id); const data = f.snapshot();
   if (mode === "ambiguous") { data.count = 2; data.elements.push({ ...item, ref: "rpref_" + "3".repeat(32) }); }
   if (mode === "partial") { data.coverage.complete = false; data.coverage.truncated = true; data.countExact = false; }
   if (mode === "reloaded") data.documentGeneration = "4".repeat(32);
   if (mode === "recreated") data.elements[0].ref = "rpref_" + "5".repeat(32);
   if (mode === "malformed") data.elements[0].depth = -1;
   f.setSnapshot(data);
   const committed = await f.api(`/flows/${f.flow.id}/repair-proposals/${proposal.id}/commit`, { candidateId: mode === "wrong-selection" ? randomUUID() : proposal.candidates[0].id, revision: proposal.revision });
   expect([400, 409]).toContain(committed.status); expect(stored(f.flow.id)).toBe(before); expect(f.actions).toHaveLength(0);
  } finally { await f.close(); }
 });
 test("ambiguous and incomplete replay sends discovery only and stays inconclusive", async () => {
  const f = await fixture(); try {
   rebindFlow(f.flow.id, f.flow.revision, 0, anchorForCandidate(item));
   for (const partial of [false, true]) { const data = f.snapshot(); if (partial) { data.coverage.complete = false; data.countExact = false; } else { data.count = 2; data.elements.push({ ...item, ref: "rpref_" + "6".repeat(32) }); } f.setSnapshot(data);
    const report = await f.api(`/flows/${f.flow.id}/run`, { sessionId: f.created.id }); expect(report.body.status).toBe("inconclusive"); expect(report.body.reason).toContain("no action dispatched"); expect(f.actions).toHaveLength(0);
   }
  } finally { await f.close(); }
 });
});
