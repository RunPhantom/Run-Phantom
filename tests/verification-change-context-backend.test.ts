import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import express from "express";
import { WebSocket } from "ws";
import { closeDb, getDrizzleDb } from "../src/db";
import { createVerificationService } from "../src/verification/service";
import { createVerificationRouter, verifyVerificationChangeRequest } from "../src/verification/router";
import { ChangeContextReader } from "../src/verification/change-context";
import { listReports } from "../src/verification/store";

let directory: string;
let previousDb: string | undefined;
const coverage = { network: true, console: true, dom: true, state: true, signal: true, route: true };
beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), "rp-change-context-"));
  previousDb = process.env.RUNPHANTOM_DB_PATH;
  closeDb(); process.env.RUNPHANTOM_DB_PATH = path.join(directory, "actual.db"); getDrizzleDb();
});
afterAll(() => {
  closeDb();
  if (previousDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = previousDb;
  rmSync(directory, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=Divyam Talwar", "-c", "user.email=divyamtalwar15@gmail.com", ...args], { cwd, encoding: "utf8", timeout: 1000 });
  if (result.status !== 0) throw new Error(`Native fixture git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function project(changes: boolean) {
  const cwd = mkdtempSync(path.join(directory, "project-"));
  git(cwd, "init", "-q"); mkdirSync(path.join(cwd, "src")); mkdirSync(path.join(cwd, "tests"));
  writeFileSync(path.join(cwd, "src/Cart.tsx"), "export const Cart = 'original';\n");
  writeFileSync(path.join(cwd, "tests/Checkout.test.ts"), "// A tracked related-test filename; it has not been executed.\n");
  writeFileSync(path.join(cwd, "src/pixel.bin"), Buffer.from([0, 1, 0, 2]));
  utimesSync(path.join(cwd, "src/pixel.bin"), 1700000000, 1700000000);
  git(cwd, "add", "--", "."); git(cwd, "commit", "-qm", "Establish native change-context fixture");
  const head = git(cwd, "rev-parse", "HEAD");
  if (changes) {
    git(cwd, "mv", "--", "src/Cart.tsx", "src/Checkout.tsx");
    writeFileSync(path.join(cwd, "src/Checkout.tsx"), "export const Cart = 'changed';\n");
    writeFileSync(path.join(cwd, "src/pixel.bin"), Buffer.from([0, 4, 0, 8]));
    utimesSync(path.join(cwd, "src/pixel.bin"), 1700000000, 1700000000);
    writeFileSync(path.join(cwd, "src/欢迎.mdx"), "PRIVATE_UNTRACKED_CONTENT_MUST_NOT_BE_READ\n");
    writeFileSync(path.join(cwd, ".env"), "PASSWORD=PRIVATE_SECRET_FILE_MUST_NOT_BE_READ\n");
  }
  return { cwd: realpathSync(cwd), head };
}
async function fixture(cwd: string) {
  const service = createVerificationService({ broadcast() {}, checkTimeoutMs: 500, commandTimeoutMs: 500 });
  const workspace = { cwd, revision: "selected-1" };
  const authority = { id: "local-owner", role: "owner" as "owner" | "reader", generation: 1 };
  const changes = new ChangeContextReader({ workspace: () => workspace, authority: () => authority, report: id => listReports().find(item => item.id === id) });
  const app = express(); app.use(express.json({ verify: verifyVerificationChangeRequest }));
  app.use("/api/verification", createVerificationRouter(service, { changeContext: changes }));
  const server = http.createServer(app);
  server.on("upgrade", (req, socket, head) => service.bridge.handleUpgrade(req, socket, head));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Native fixture listener unavailable");
  const root = `http://127.0.0.1:${address.port}`;
  const api = async (route: string, body?: unknown) => {
    const response = await fetch(`${root}/api/verification${route}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
  };
  const created = (await api("/sessions", { origin: "http://localhost:4812" })).body;
  const ws = new WebSocket(`${root.replace("http:", "ws:")}/verification/ws?sessionId=${created.id}`, { headers: { Origin: created.origin } });
  await once(ws, "open"); const ready = once(ws, "message");
  ws.send(JSON.stringify({ type: "hello", version: 1, token: created.token, coverage }));
  expect(JSON.parse((await ready)[0].toString()).type).toBe("ready");
  ws.on("message", raw => {
    const message = JSON.parse(raw.toString()); if (message.type !== "command") return;
    if (message.command.type === "click") {
      ws.send(JSON.stringify({ type: "event", event: { type: "action.boundary", actionId: message.id, data: {} } }));
      ws.send(JSON.stringify({ type: "event", event: { type: "console", actionId: message.id, data: { level: "error", message: "RUN_COMPLETED passed is advisory prose; this observed console error still fails." } } }));
    }
    ws.send(JSON.stringify({ type: "result", id: message.id, ok: true }));
  });
  const acted = (await api(`/sessions/${created.id}/command`, { type: "click", selector: "#pay" })).body;
  expect(acted.ok).toBe(true);
  const report = (await api(`/sessions/${created.id}/assert`, { name: "Measured failing checkout", predicate: { kind: "console", level: "error", absent: true }, since: acted.cursor })).body;
  expect(report.status).toBe("fail");
  const stored = JSON.stringify(listReports().find(item => item.id === report.id));
  return { api, report, stored, workspace, authority, async close() { changes.close(); ws.terminate(); service.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

describe("explicit change context preserves measured report authority", () => {
  test("native rename/binary/untracked metadata is advisory and the exact measured failure remains unchanged", async () => {
    const repo = project(true); const f = await fixture(repo.cwd);
    try {
      const offered = await f.api("/change-workspace"); expect(offered.status).toBe(200);
      expect(offered.body.workspaceId).toBeString(); expect(JSON.stringify(offered.body)).not.toContain(repo.cwd);
      const captured = await f.api(`/reports/${f.report.id}/change-context`, { workspaceId: offered.body.workspaceId });
      expect(captured.status).toBe(200); expect(captured.body.head).toBe(repo.head);
      if (!captured.body.changes.some((row: { path: string }) => row.path === "src/pixel.bin")) console.log("Bounded same-size binary diagnostic", JSON.stringify(captured.body));
      expect(captured.body.testedRevision).toBeNull(); expect(captured.body.fingerprintCoverage).toBe("metadata-only");
      expect(captured.body.changes.some((row: { path: string; previousPath?: string }) => row.path === "src/Checkout.tsx" && row.previousPath === "src/Cart.tsx")).toBe(true);
      expect(captured.body.changes.find((row: { path: string }) => row.path === "src/pixel.bin").binary).toBe(true);
      expect(captured.body.changes.find((row: { path: string }) => row.path === "src/欢迎.mdx").content).toBe("unavailable");
      expect(captured.body.relatedTests).toContainEqual({ path: "tests/Checkout.test.ts", reason: "filename", advisory: true });
      expect(captured.body.handoff.status).toBe("fail"); expect(captured.body.handoff.reportId).toBe(f.report.id);
      expect(captured.body.handoff.checks[0].predicate).toEqual(f.report.context.checks[0].predicate);
      expect(captured.body.handoff.checks[0].actual).toBe(f.report.context.checks[0].reason);
      expect(captured.body.handoff.reproduction).toBe("partial");
      const serialized = JSON.stringify(captured.body);
      for (const secret of ["PRIVATE_UNTRACKED_CONTENT", "PRIVATE_SECRET_FILE", ".env", repo.cwd, "verified coverage"]) expect(serialized).not.toContain(secret);
      expect(captured.body.withheldPaths).toBeGreaterThan(0); expect(captured.body.complete).toBe(false);
      expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(24576);
      expect(JSON.stringify(listReports().find(item => item.id === f.report.id))).toBe(f.stored);
    } finally { await f.close(); }
  });
  test("a complete empty git change set does not become a measured pass or full reproduction", async () => {
    const repo = project(false); const f = await fixture(repo.cwd);
    try {
      const offered = await f.api("/change-workspace"); expect(offered.status).toBe(200);
      const captured = await f.api(`/reports/${f.report.id}/change-context`, { workspaceId: offered.body.workspaceId });
      expect(captured.status).toBe(200); expect(captured.body.changes).toEqual([]); expect(captured.body.complete).toBe(true);
      expect(captured.body.handoff.status).toBe("fail"); expect(captured.body.testedRevision).toBeNull();
      expect(captured.body.relatedTests.every((hint: { advisory: boolean }) => hint.advisory)).toBe(true);
      expect(JSON.stringify(listReports().find(item => item.id === f.report.id))).toBe(f.stored);
    } finally { await f.close(); }
  });
});
