import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import express from "express";
import { WebSocket } from "ws";
import { createVerificationService } from "../src/verification/service";
import { createVerificationRouter } from "../src/verification/router";
import { clearAll, closeDb, getDrizzleDb, upsertRun, insertSpan, getRunById, getRunWithSpans, getSpanPayloadColumn } from "../src/db";
import { saveReport, listReports } from "../src/verification/store";
import { verification_snapshots } from "../src/db/schema";
import { tree } from "./fixtures/semantic-tree";
import type { AppCommand } from "../src/verification/protocol";
import type { PortableSnapshots, SavedSemanticSnapshot } from "../src/verification/snapshot-contract";
import { snapshotDigests } from "../src/verification/snapshot-diff";

const coverage = { network: true, console: true, dom: true, state: true, signal: true, route: true };
const origin = "http://localhost:4312";
let directory: string; let oldDb: string | undefined;
beforeAll(() => { directory = mkdtempSync(path.join(tmpdir(), "rp-semantic-snapshots-")); oldDb = process.env.RUNPHANTOM_DB_PATH; closeDb(); process.env.RUNPHANTOM_DB_PATH = path.join(directory, "snapshots.db"); getDrizzleDb(); });
beforeEach(() => clearAll());
afterAll(() => { closeDb(); if (oldDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = oldDb; rmSync(directory, { recursive: true, force: true }); });

/** Controlled wire peer qualifies the daemon boundary; real DOM capture is covered in Chromium. */
async function fixture() {
  const service = createVerificationService({ broadcast() {}, commandTimeoutMs: 500 });
  const app = express(); app.use(express.json({ limit: "128kb" })); app.use("/api/verification", createVerificationRouter(service));
  const server = http.createServer(app); server.on("upgrade", (req, socket, head) => service.bridge.handleUpgrade(req, socket, head)); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`; const sockets: WebSocket[] = [];
  const api = async <T = unknown>(route: string, body?: unknown, method = body === undefined ? "GET" : "POST") => { const response = await fetch(`${url}/api/verification${route}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() as T }; };
  const pair = async (version = 5, existing?: { id: string; token: string }, runId?: string) => {
    const created = existing ?? (await api<{ id: string; token: string }>("/sessions", { origin, ...(runId ? { runId } : {}) })).body;
    const ws = new WebSocket(`${url.replace("http:", "ws:")}/verification/ws?sessionId=${created.id}`, { headers: { Origin: origin } }); ws.on("error", () => {}); sockets.push(ws); await once(ws, "open");
    const ready = once(ws, "message"); ws.send(JSON.stringify({ type: "hello", version, token: created.token, coverage, ...(version === 5 ? { capabilities: ["semantic-tree", "semantic-refs"] } : {}) }));
    expect(JSON.parse((await ready)[0].toString())).toEqual({ type: "ready" }); return { created, ws };
  };
  return { service, api, pair, async close() { for (const ws of sockets) ws.terminate(); service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
function respond(ws: WebSocket, value: (command: AppCommand) => unknown = () => tree(["A", "A", "B"]), truncated = false) {
  ws.on("message", raw => {
    const message = JSON.parse(raw.toString()) as { type: string; id: string; command: AppCommand };
    if (message.type !== "command") return;
    if (["click", "fill", "ref-click", "ref-fill"].includes(message.command.type)) ws.send(JSON.stringify({ type: "event", event: { type: "action.boundary", data: {}, actionId: message.id } }));
    ws.send(JSON.stringify({ type: "result", id: message.id, ok: true, result: value(message.command), ...(truncated ? { truncated: true } : {}) }));
  });
}
const rows = () => getDrizzleDb().select().from(verification_snapshots).all();

test("owned HTTP capture persists exact represented tree while existing output and frozen verdict remain unchanged", async () => {
  const f = await fixture();
  try {
    upsertRun({ id: "snapshot-output-control", name: "Original result", started_at: 1, last_updated_at: 2 }); insertSpan({ id: "snapshot-output-span", run_id: "snapshot-output-control", name: "Original span", start_time_ms: 1, end_time_ms: 2, duration_ms: 1, output_payload: '"Original output Café 東京"' });
    expect(getSpanPayloadColumn("snapshot-output-span", "output", "snapshot-output-control")).toBe('"Original output Café 東京"');
    saveReport({ id: "snapshot-frozen-report", name: "Original failure", sessionId: "old-session", runId: "snapshot-output-control", flowId: null, status: "fail", reason: "Expected original output", evidence: [], createdAt: 1 });
    const output = JSON.stringify([getRunById("snapshot-output-control"), getRunWithSpans("snapshot-output-control"), listReports()]);
    const { ws, created } = await f.pair(5, undefined, "snapshot-output-control"); respond(ws);
    const capture = await f.api<SavedSemanticSnapshot>(`/sessions/${created.id}/snapshots`, { name: "Before checkout" });
    expect(capture.status).toBe(201); expect(capture.body.tree).toEqual(tree(["A", "A", "B"])); expect(capture.body).toMatchObject({ runId: "snapshot-output-control", sessionId: created.id, source: "paired-sdk", connectionGeneration: 1, ...snapshotDigests(capture.body.tree) });
    const exported = await f.api<PortableSnapshots>("/snapshots/export", { ids: [capture.body.id] }); expect(exported.status).toBe(200); expect(JSON.stringify(exported.body)).not.toMatch(/sessionId|connectionGeneration|rpref_|token/);
    await f.api(`/sessions/${created.id}`, undefined, "DELETE"); closeDb();
    expect((await f.api<SavedSemanticSnapshot>(`/snapshots/${capture.body.id}`)).body).toEqual(capture.body);
    expect(JSON.stringify([getRunById("snapshot-output-control"), getRunWithSpans("snapshot-output-control"), listReports()])).toBe(output);
    expect(getSpanPayloadColumn("snapshot-output-span", "output", "snapshot-output-control")).toBe('"Original output Café 東京"');
  } finally { await f.close(); }
});

test("known ordinary fill values scrub observed text without corrupting node/document/source metadata", async () => {
  for (const secret of ["node", "document", "sdk-reported", "button"]) {
    const f = await fixture();
    try {
      const { ws, created } = await f.pair(); respond(ws, command => command.type === "semantic-tree" ? tree([secret]) : {});
      expect((await f.api(`/sessions/${created.id}/command`, { type: "fill", selector: "#entry", value: secret })).status).toBe(200);
      const capture = await f.api<SavedSemanticSnapshot>(`/sessions/${created.id}/snapshots`, { name: "Private observation" }); expect(capture.status).toBe(201);
      expect(capture.body.tree.nodes[0]).toMatchObject({ kind: "semantic", parent: { kind: "root" }, name: "[REDACTED]", partial: true }); expect(capture.body.tree.source).toBe("sdk-reported"); expect(capture.body.tree.regions[0].kind).toBe("document");
      expect((await f.api("/snapshots/export", { ids: [capture.body.id] })).status).toBe(200);
    } finally { await f.close(); }
  }
});

test("replaced socket cannot commit a late capture and a legacy runtime does not receive an unsupported command", async () => {
  const f = await fixture();
  try {
    const legacy = await f.pair(1); let commands = 0; legacy.ws.on("message", () => commands++);
    expect((await f.api(`/sessions/${legacy.created.id}/snapshots`, { name: "Unsupported" })).status).toBe(409); expect(commands).toBe(0); expect(rows()).toHaveLength(0);
    const first = await f.pair(); const received = once(first.ws, "message"); const pending = f.api(`/sessions/${first.created.id}/snapshots`, { name: "Stale" });
    const oldCommand = JSON.parse((await received)[0].toString()) as { id: string };
    // The existing bridge refuses simultaneous sockets. A real reconnect follows
    // close, and a copied old pending ID still cannot become a new owned reply.
    const closed = once(first.ws, "close"); first.ws.terminate(); await closed;
    expect((await pending).status).toBe(409); expect(rows()).toHaveLength(0);
    const replacement = await f.pair(5, first.created); const refused = once(replacement.ws, "close");
    replacement.ws.send(JSON.stringify({ type: "result", id: oldCommand.id, ok: true, result: tree(["late"]) })); await refused; expect(rows()).toHaveLength(0);
    const current = await f.pair(5, first.created); respond(current.ws);
    const fresh = await f.api<SavedSemanticSnapshot>(`/sessions/${first.created.id}/snapshots`, { name: "Current" }); expect(fresh.status).toBe(201); expect(fresh.body.connectionGeneration).toBeGreaterThan(1);
  } finally { await f.close(); }
});

test("malformed live graph resolves its owned refusal, disconnects and creates zero records", async () => {
  const f = await fixture();
  try { const { ws, created } = await f.pair(); respond(ws, () => ({ ...tree(["bad"]), nodes: [{ ...tree(["bad"]).nodes[0], parent: { kind: "node", index: 0 } }] }));
    const response = await f.api(`/sessions/${created.id}/snapshots`, { name: "Malformed" }); expect(response.status).toBe(409); expect(rows()).toHaveLength(0); expect(f.service.bridge.get(created.id).ws).toBeNull();
  } finally { await f.close(); }
});

test("page-declared transport loss cannot be persisted as complete capture coverage", async () => {
  const f = await fixture();
  try {
    const { ws, created } = await f.pair(); respond(ws, () => tree(["Retained observation"]), true);
    const captured = await f.api<SavedSemanticSnapshot>(`/sessions/${created.id}/snapshots`, { name: "Wire loss" }); expect(captured.status).toBe(201);
    expect(captured.body.tree.nodes).toEqual(tree(["Retained observation"]).nodes); expect(captured.body.tree.availability).toBe("partial"); expect(captured.body.tree.coverage.complete).toBe(false); expect(captured.body.tree.coverage.reasons).toContain("transport-budget-limit");
    expect(captured.body.contentDigest).toBe(snapshotDigests(tree(["Retained observation"])).contentDigest); expect(captured.body.coverageDigest).not.toBe(snapshotDigests(tree(["Retained observation"])).coverageDigest);
  } finally { await f.close(); }
});

test("two actual capture clients cannot share the same pending observation turn", async () => {
  const f = await fixture();
  try {
    const { ws, created } = await f.pair(); const commandReady = once(ws, "message"); const first = f.api<SavedSemanticSnapshot>(`/sessions/${created.id}/snapshots`, { name: "Owned first capture" });
    const command = JSON.parse((await commandReady)[0].toString()) as { id: string };
    const second = await f.api(`/sessions/${created.id}/snapshots`, { name: "Competing capture" }); expect(second.status).toBe(409); expect(rows()).toHaveLength(0);
    ws.send(JSON.stringify({ type: "result", id: command.id, ok: true, result: tree(["First turn"]) })); const captured = await first; expect(captured.status).toBe(201); expect(captured.body.name).toBe("Owned first capture"); expect(rows()).toHaveLength(1);
    respond(ws, () => tree(["Next turn"])); expect((await f.api(`/sessions/${created.id}/snapshots`, { name: "Owned next capture" })).status).toBe(201); expect(rows()).toHaveLength(2);
  } finally { await f.close(); }
});

test("strict two-entry transfer refuses an invalid second entry atomically and repeated valid imports have fresh local identity", async () => {
  const f = await fixture();
  try {
    const { ws, created } = await f.pair(); respond(ws); const captured = await f.api<SavedSemanticSnapshot>(`/sessions/${created.id}/snapshots`, { name: "Transfer control" });
    const artifact = (await f.api<PortableSnapshots>("/snapshots/export", { ids: [captured.body.id] })).body;
    const before = rows().length;
    for (const malformed of [{ ...artifact.entries[0], contentDigest: "f".repeat(64) }, { ...artifact.entries[0], sessionId: "borrowed" }, { ...artifact.entries[0], tree: { ...artifact.entries[0].tree, nodes: [{ ...artifact.entries[0].tree.nodes[0], name: `sk-proj-${"A".repeat(32)}` }] } }]) {
      expect((await f.api("/snapshots/import", { artifact: { ...artifact, entries: [artifact.entries[0], malformed] } })).status).toBe(400); expect(rows()).toHaveLength(before);
    }
    const first = await f.api<SavedSemanticSnapshot[]>("/snapshots/import", { artifact }); const second = await f.api<SavedSemanticSnapshot[]>("/snapshots/import", { artifact }); expect(first.status).toBe(201); expect(second.status).toBe(201);
    expect(first.body[0].id).not.toBe(second.body[0].id); expect(first.body[0]).toMatchObject({ source: "imported-evidence", sessionId: null, connectionGeneration: null, runId: null, contentDigest: captured.body.contentDigest, coverageDigest: captured.body.coverageDigest, tree: captured.body.tree });
    expect(f.service.bridge.sessions.size).toBe(1); expect((await f.api(`/sessions/${created.id}/command`, { type: "ref-click", ref: first.body[0].contentDigest })).status).toBe(400);
    expect((await f.api("/flows", { name: "Invalid authority", origin, steps: [{ command: { type: "semantic-tree" }, predicate: { kind: "signal", name: "done" } }] })).status).toBe(400);
  } finally { await f.close(); }
});

test("capacity refusal preserves every chosen baseline and two-entry imports cannot partly consume the last slot", async () => {
  const f = await fixture();
  try {
    const entry = { name: "Capacity control", origin, capturedAt: 1, tree: tree(["A"]), ...snapshotDigests(tree(["A"])) }; const artifact: PortableSnapshots = { format: "runphantom-semantic-snapshots/v1", entries: [entry, entry] };
    for (let i = 0; i < 50; i++) expect((await f.api("/snapshots/import", { artifact })).status).toBe(201);
    const baseline = rows(); expect(baseline).toHaveLength(100);
    const { ws, created } = await f.pair(); respond(ws); expect((await f.api(`/sessions/${created.id}/snapshots`, { name: "Capacity capture" })).status).toBe(409); expect(rows()).toEqual(baseline);
    expect((await f.api("/snapshots/import", { artifact })).status).toBe(409); expect(rows()).toEqual(baseline);
    await f.api(`/snapshots/${baseline[0].id}`, undefined, "DELETE"); const ninetyNine = rows();
    expect((await f.api("/snapshots/import", { artifact })).status).toBe(409); expect(rows()).toEqual(ninetyNine);
    expect((await f.api("/snapshots/import", { artifact: { ...artifact, entries: [entry] } })).status).toBe(201); expect(rows()).toHaveLength(100);
  } finally { await f.close(); }
});

test("stored corruption is unavailable on read/export and origin mismatch refuses comparison without new reports", async () => {
  const f = await fixture();
  try {
    const entry = { name: "Origin control", origin, capturedAt: 1, tree: tree(["A"]), ...snapshotDigests(tree(["A"])) };
    const before = await f.api<SavedSemanticSnapshot[]>("/snapshots/import", { artifact: { format: "runphantom-semantic-snapshots/v1", entries: [entry] } });
    const after = await f.api<SavedSemanticSnapshot[]>("/snapshots/import", { artifact: { format: "runphantom-semantic-snapshots/v1", entries: [{ ...entry, origin: "http://localhost:4313" }] } });
    expect((await f.api("/snapshot-diff", { beforeId: before.body[0].id, afterId: after.body[0].id })).status).toBe(409); expect(listReports()).toEqual([]);
    getDrizzleDb().insert(verification_snapshots).values({ ...rows()[0], id: "corrupt-snapshot", source: "imported-evidence", session_id: null, payload: '{"unsupported":true}' }).run(); closeDb();
    expect((await f.api("/snapshots/corrupt-snapshot")).status).toBe(409); expect((await f.api("/snapshots/export", { ids: [before.body[0].id, "corrupt-snapshot"] })).status).toBe(409);
    expect((await f.api(`/snapshots/${before.body[0].id}`)).status).toBe(200);
    expect((await f.api("/snapshots/corrupt-snapshot", undefined, "DELETE")).status).toBe(200); expect((await f.api("/snapshots")).status).toBe(200);
  } finally { await f.close(); }
});

async function sourceDaemon(dbPath: string) {
  const reservation = http.createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening"); const port = (reservation.address() as { port: number }).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const sourceRoot = path.resolve(import.meta.dir, "..");
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RUNPHANTOM_") && key !== "ANTHROPIC_API_KEY" && key !== "OPENAI_API_KEY"));
  const child = spawn(process.execPath, ["--no-env-file", path.join(sourceRoot, "src/index.ts"), "serve"], { cwd: directory, env: { ...inherited, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", RUNPHANTOM_OPENAI_API_KEY: "", RUNPHANTOM_CLAUDE_CLI_CHAT: "0", RUNPHANTOM_DB_PATH: dbPath, RUNPHANTOM_PORT: String(port), RUNPHANTOM_BIND_HOST: "127.0.0.1", RUNPHANTOM_SECRET_STORE_PATH: path.join(directory, "isolated-secrets.json"), RUNPHANTOM_ALLOWED_HOSTS: "", RUNPHANTOM_ALLOWED_SOURCE_IPS: "", RUNPHANTOM_ALLOWED_ORIGINS: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = ""; child.stdout.on("data", data => { logs = (logs + data).slice(-8192); }); child.stderr.on("data", data => { logs = (logs + data).slice(-8192); });
  const url = `http://127.0.0.1:${port}`;
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); const timer = setTimeout(() => child.kill("SIGKILL"), 2000); child.kill("SIGTERM"); await exited; clearTimeout(timer);
    }
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    console.info(JSON.stringify({ qualification: "F25-source-reaped", pid: child.pid, executable: process.execPath, cwd: directory, exitCode: child.exitCode, signalCode: child.signalCode, providerSpendUsd: 0 }));
  };
  try {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Isolated source daemon stopped before health: ${logs}`);
      try { if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })).ok) {
        const api = async <T = unknown>(route: string, body?: unknown, headers: Record<string, string> = {}) => { const response = await fetch(`${url}/api/verification${route}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() as T }; };
        return { url, api, close, pid: child.pid, executable: process.execPath, cwd: directory, logs: () => logs };
      } } catch { /* Startup health is the only bounded retry; assertions never retry. */ }
      await new Promise<void>(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Isolated source daemon health timed out: ${logs}`);
  } catch (error) { await close(); throw error; }
}

test("actual isolated source HTTP capture survives daemon restart and independent import/reopen without creating authority", async () => {
  const firstDb = path.join(directory, "source-a.db"); const independentDb = path.join(directory, "source-b.db");
  let first = await sourceDaemon(firstDb);
  let saved: SavedSemanticSnapshot; let artifact: PortableSnapshots;
  try {
    const paired = await first.api<{ id: string; token: string }>("/sessions", { origin }); expect(paired.status).toBe(201);
    const ws = new WebSocket(`${first.url.replace("http:", "ws:")}/verification/ws?sessionId=${paired.body.id}`, { headers: { Origin: origin } }); ws.on("error", () => {}); await once(ws, "open"); const ready = once(ws, "message"); ws.send(JSON.stringify({ type: "hello", version: 5, token: paired.body.token, coverage, capabilities: ["semantic-tree"] })); expect(JSON.parse((await ready)[0].toString())).toEqual({ type: "ready" }); respond(ws, () => tree(["Café 東京", "A", "A"]));
    try {
      const captured = await first.api<SavedSemanticSnapshot>(`/sessions/${paired.body.id}/snapshots`, { name: "Independent source control" }); expect(captured.status).toBe(201); saved = captured.body;
      const transfer = await first.api<PortableSnapshots>("/snapshots/export", { ids: [saved.id] }); expect(transfer.status).toBe(200); artifact = transfer.body;
      expect((await first.api("/snapshots/import", { artifact }, { Origin: "https://foreign.example" })).status).toBe(403);
      expect((await first.api("/snapshots/export", { ids: [saved.id] }, { Host: "foreign.example" })).status).toBe(403);
      console.info(JSON.stringify({ qualification: "F25-source-http", pid: first.pid, executable: first.executable, cwd: first.cwd, capturedDigest: saved.contentDigest, providerSpendUsd: 0 }));
    } finally { ws.terminate(); }
  } finally { await first.close(); }
  first = await sourceDaemon(firstDb);
  try { expect((await first.api<SavedSemanticSnapshot>(`/snapshots/${saved!.id}`)).body).toEqual(saved!); expect((await first.api<PortableSnapshots>("/snapshots/export", { ids: [saved!.id] })).body).toEqual(artifact!); } finally { await first.close(); }
  let independent = await sourceDaemon(independentDb); let imported: SavedSemanticSnapshot;
  try {
    expect((await independent.api("/sessions")).body).toEqual([]);
    const response = await independent.api<SavedSemanticSnapshot[]>("/snapshots/import", { artifact: artifact! }); expect(response.status).toBe(201); imported = response.body[0];
    expect(imported).toMatchObject({ tree: saved!.tree, contentDigest: saved!.contentDigest, coverageDigest: saved!.coverageDigest, source: "imported-evidence", sessionId: null, connectionGeneration: null, runId: null }); expect(imported.id).not.toBe(saved!.id); expect((await independent.api("/sessions")).body).toEqual([]);
    expect((await independent.api("/reports")).body).toEqual([]);
  } finally { await independent.close(); }
  independent = await sourceDaemon(independentDb);
  try { expect((await independent.api<SavedSemanticSnapshot>(`/snapshots/${imported!.id}`)).body).toEqual(imported!); expect((await independent.api<PortableSnapshots>("/snapshots/export", { ids: [imported!.id] })).body).toEqual(artifact!); } finally { await independent.close(); }
}, 30_000);
