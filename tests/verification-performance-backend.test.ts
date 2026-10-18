import { afterAll, beforeAll, expect, test } from "bun:test";
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
import { boundReportContext, revalidatePerformanceContext } from "../src/verification/report-context";
import { PERFORMANCE_METRICS, PERFORMANCE_OBSERVERS, type PerformanceSnapshot } from "../src/verification/performance";
import type { VerificationReportContext } from "../src/verification/protocol";

const coverage = { network: true, console: true, dom: true, state: true, signal: true, route: true };
function snapshot(phase: "begin" | "capture" = "capture"): PerformanceSnapshot {
  return { version: 1, source: "sdk-native-observers", phase, documentId: "a".repeat(32), windowId: "b".repeat(32), clock: { timeOriginMs: 1, installedAtMs: 1, sinceMs: 2, capturedAtMs: 3 }, metadata: "none",
    coverage: Object.fromEntries(PERFORMANCE_OBSERVERS.map(name => [name, { state: "observing", observed: 0, invalid: 0, omitted: 0, nativeDropped: 0, overflow: false }])) as PerformanceSnapshot["coverage"],
    metrics: { ...Object.fromEntries(PERFORMANCE_METRICS.map(name => [name, null])), resourceCount: 0, resourceTransferBytes: 0, clsMaxSessionScore: 0.100000001 } as PerformanceSnapshot["metrics"],
    diagnostics: { resources: [], frames: [], resourceOmitted: 0, frameOmitted: 0, scriptOmitted: 0, metadataOmitted: 0 }, lifetimeWork: 1, lifetimeExhausted: false };
}
let directory: string, previous: string | undefined;
beforeAll(() => { directory = mkdtempSync(path.join(tmpdir(), "rp-performance-backend-")); previous = process.env.RUNPHANTOM_DB_PATH; closeDb(); process.env.RUNPHANTOM_DB_PATH = path.join(directory, "evidence.db"); getDrizzleDb(); });
afterAll(() => { closeDb(); if (previous === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = previous; rmSync(directory, { recursive: true, force: true }); });
async function fixture(enabled = true, respond: (phase: "begin" | "capture") => unknown = snapshot) {
  const service = createVerificationService({ broadcast() {}, commandTimeoutMs: 300, checkTimeoutMs: 350 });
  const app = express(); app.use(express.json()); app.use("/api/verification", createVerificationRouter(service));
  const server = http.createServer(app); server.on("upgrade", (req, socket, head) => service.bridge.handleUpgrade(req, socket, head)); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const api = async (route: string, body?: unknown) => { const r = await fetch(`${url}/api/verification${route}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, body: await r.json() as any }; };
  const created = (await api("/sessions", { origin: "http://localhost:4813" })).body;
  const ws = new WebSocket(`${url.replace("http:", "ws:")}/verification/ws?sessionId=${created.id}`, { headers: { Origin: created.origin } }); await once(ws, "open");
  const ready = once(ws, "message"); ws.send(JSON.stringify({ type: "hello", version: enabled ? 6 : 3, token: created.token, coverage, capabilities: enabled ? ["performance-evidence"] : [] })); expect(JSON.parse((await ready)[0].toString())).toEqual({ type: "ready" });
  ws.on("message", raw => { const msg = JSON.parse(raw.toString()); if (msg.type === "command") ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: msg.command.type === "performance" ? respond(msg.command.phase) : {} })); });
  return { api, created, route: `/sessions/${created.id}`, service, async close() { ws.terminate(); service.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const predicate = { kind: "performance", metric: "clsMaxSessionScore", op: "lte", value: 0.1 };
test("actual HTTP→paired result→SQL→reopen preserves unrounded lab evidence and fail", async () => {
  const f = await fixture(); try {
    expect((await f.api(`${f.route}/command`, { type: "performance", phase: "begin" })).body.ok).toBe(true);
    const report = (await f.api(`${f.route}/assert`, { predicate })).body;
    expect(report.status).toBe("fail"); expect(report.context.checks[0].performance.snapshot.metrics.clsMaxSessionScore).toBe(0.100000001);
    expect(report.reason).toContain("selected lab window only"); expect(JSON.stringify(report)).not.toContain(f.created.token);
    const before = JSON.stringify(listReports().find(item => item.id === report.id)); closeDb(); getDrizzleDb(); expect(JSON.stringify(listReports().find(item => item.id === report.id))).toBe(before);
    expect((await f.api(`${f.route}/assert`, { predicate: { kind: "performance", metric: "resourceCount", op: "lte", value: 0 } })).body.status).toBe("pass");
  } finally { await f.close(); }
});
test("opt-out and unknown native loss cannot fall back to ordinary verification", async () => {
  for (const enabled of [false, true]) {
    const f = await fixture(enabled, phase => { const value = snapshot(phase); value.coverage["layout-shift"].nativeDropped = null; return value; });
    try { const begin = (await f.api(`${f.route}/command`, { type: "performance", phase: "begin" })).body; expect(begin.ok).toBe(enabled);
      const report = (await f.api(`${f.route}/assert`, { predicate })).body; expect(report.status).toBe("inconclusive");
    } finally { await f.close(); }
  }
});
test("unmatched document/window/clock, wrong phase and malformed response refuse the owned promise", async () => {
  for (const change of [{ documentId: "c".repeat(32) }, { windowId: "c".repeat(32) }, { phase: "begin" }, { clock: { timeOriginMs: 2, installedAtMs: 1, sinceMs: 2, capturedAtMs: 3 } }, { metrics: { ...snapshot().metrics, resourceCount: 0.5 } }]) {
    const f = await fixture(true, phase => phase === "begin" ? snapshot(phase) : { ...snapshot(phase), ...change });
    try { expect((await f.api(`${f.route}/command`, { type: "performance", phase: "begin" })).body.ok).toBe(true);
      const response = (await f.api(`${f.route}/command`, { type: "performance", phase: "capture" })).body; expect(response.ok).toBe(false);
      expect(f.service.bridge.get(f.created.id).lastPerformance).toBeUndefined(); expect(f.service.bridge.get(f.created.id).performanceWindow).toBeUndefined();
    } finally { await f.close(); }
  }
});
test("whole 64KiB context keeps twenty exact outcomes and reasons before optional snapshots", () => {
  const value = snapshot(); value.metadata = "redacted-origin-path";
  value.diagnostics.resources = Array.from({ length: 8 }, () => ({ startMs: 2, durationMs: 1, transferBytes: 1, url: { origin: "https://safe.invalid", path: "/" + "界".repeat(230) } }));
  const context: VerificationReportContext = { origin: "http://localhost:4813", quietMs: 300, redacted: false, truncated: false,
    checks: Array.from({ length: 20 }, (_, i) => ({ step: i + 1, predicate, status: "fail", reason: `Actual evaluated reason ${i}`, since: 1, through: 3, generation: 1, coverage, complete: true, dropped: 0, settled: false, performance: { generation: 1, cursor: 2, snapshot: value } })) };
  const bounded = boundReportContext(context); expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(64 * 1024); expect(bounded.checks.length).toBe(20);
  for (let i = 0; i < 20; i++) { expect(bounded.checks[i]!.status).toBe("fail"); expect(bounded.checks[i]!.reason).toBe(`Actual evaluated reason ${i}`); }
  expect(bounded.checks.some(check => check.performanceOmitted === "context-limit")).toBe(true);
  const malformed = structuredClone(context); malformed.checks[0]!.performance!.snapshot.metrics.resourceCount = Infinity;
  const reopened = revalidatePerformanceContext(malformed); expect(reopened.checks[0]!.performance).toBeUndefined(); expect(reopened.checks[0]!.performanceOmitted).toBe("invalid-stored-evidence");
});
