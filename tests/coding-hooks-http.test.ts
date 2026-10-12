import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, request, type ClientRequest, type Server } from "node:http";
import { getDrizzleDb, closeDb, deleteRun } from "../src/db";
import { claimsForRegistration } from "../src/coding-hooks/catalog";
import { CodingHookStore, type HookAdmission } from "../src/coding-hooks/store";
import { CodingHookController, SERVICE_LIMITS } from "../src/coding-hooks/service";
import { HOOK_PROTOCOL } from "../src/coding-hooks/protocol";
import { normalizeClaudeHook } from "../src/coding-hooks/claude";
import { hookFixture } from "./fixtures/coding-hooks-claude";

// The actual source migration supplies schema; these store fixtures use a trusted test-only guard. Product startup uses the kernel lease.
let directory: string, prior: string | undefined, server: Server, controller: CodingHookController, store: CodingHookStore, port: number;
const token = "a".repeat(64), id = "a".repeat(32), identity = "b".repeat(64);
const admit = (token: string, identity: string) => store.admit(token, identity, claimsForRegistration(store.authenticate(token).binding));
const clients = new Set<ClientRequest>();
beforeEach(async () => {
  closeDb(); prior = process.env.RUNPHANTOM_DB_PATH; directory = mkdtempSync(path.join(tmpdir(), "runphantom-f11-http-")); process.env.RUNPHANTOM_DB_PATH = path.join(directory, "owner.sqlite");
  const db = getDrizzleDb().$client; store = new CodingHookStore(db, {}, () => true); store.beginOwner();
  const installed = store.prepareInstallation({ installationId: id, captureMode: "full", scope: "local", workspace: directory, registeredWorkspace: directory, transcriptRoot: path.join(directory, "projects"), projectDirectory: path.join(directory, "projects/project"), homeDirectory: directory, settingsPath: path.join(directory, ".claude/settings.local.json"), executable: process.execPath }, token, "c".repeat(64)); store.commitInstallation(id, installed.installationGeneration, token, "c".repeat(64), installed.ownerGeneration);
  controller = new CodingHookController(store); server = createServer((request, response) => { void controller.handle(request, response); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture listener"); port = address.port;
});
afterEach(async () => { await controller.close(); for (const client of clients) client.destroy(); clients.clear(); await new Promise<void>(resolve => server.close(() => resolve())); closeDb(); if (prior === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = prior; rmSync(directory, { recursive: true, force: true }); });
function open(endpoint = "admission", headers: Record<string, string> = {}) {
  const client = request({ hostname: "127.0.0.1", port, path: "/api/coding-hooks/claude/" + endpoint, method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token, ...headers } }); clients.add(client);
  const result = new Promise<{ status: number; body: string }>((resolve, reject) => { client.once("error", reject); client.once("response", response => { const body: Buffer[] = []; response.on("data", chunk => body.push(chunk)); response.once("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(body).toString() })); response.once("error", reject); }); });
  void result.catch(() => undefined); return { client, result };
}
const admissionBody = () => JSON.stringify({ version: HOOK_PROTOCOL, sourceSessionIdentity: identity, ...claimsForRegistration(store.authenticate(token).binding) });
const publicationBody = (admission: HookAdmission) => {
  const result = normalizeClaudeHook(hookFixture("PostToolUse", { tool_use_id: "tool_exact", tool_name: "Bash", tool_response: { ordinary: "exact HTTP result", password: "PRIVATE_HTTP_PASSWORD" } }), { sourceKey: admission.sourceKey, captureMode: "full" }, null);
  if (result.status !== "accepted") throw new Error("fixture batch");
  return JSON.stringify({ version: HOOK_PROTOCOL, ownerGeneration: admission.ownerGeneration, installationGeneration: admission.installationGeneration, sourceKey: admission.sourceKey, batch: result.value });
};
async function waitFor(predicate: () => boolean) { const deadline = performance.now() + 800; while (!predicate()) { if (performance.now() > deadline) throw new Error("fixture barrier deadline"); await new Promise<void>(resolve => setImmediate(resolve)); } }

test("actual authenticated HTTP admission and publication persist only bounded producer evidence", async () => {
  const admissionRequest = open(); admissionRequest.client.end(admissionBody()); const admitted = await admissionRequest.result; expect(admitted.status).toBe(200);
  const admission = JSON.parse(admitted.body) as HookAdmission, publication = open("publication"); publication.client.end(publicationBody(admission)); const result = await publication.result;
  expect(result.status).toBe(200); expect(result.body).toContain('"runtimeVerified":false'); expect(Buffer.byteLength(admitted.body)).toBeLessThanOrEqual(SERVICE_LIMITS.responseBytes);
  const rows = JSON.stringify(getDrizzleDb().$client.query("SELECT * FROM spans").all()); expect(rows).toContain("exact HTTP result"); expect(rows).not.toContain("PRIVATE_HTTP_PASSWORD");
  expect(rows).not.toContain(token); expect(controller.stats()).toEqual({ active: 0, queued: 0, closed: false });
});
test("host/origin/auth/content-type and body authority overrides fail before publication", async () => {
  for (const headers of [{ host: "evil.invalid" }, { origin: "http://evil.invalid" }, { origin: "null" }, { authorization: "Bearer forged" }, { "content-type": "application/json;charset=utf-8" }]) {
    const attempt = open("admission", headers); attempt.client.end(admissionBody()); expect((await attempt.result).status).toBeGreaterThanOrEqual(400);
  }
  const forged = open(); forged.client.end(JSON.stringify({ version: HOOK_PROTOCOL, sourceSessionIdentity: identity, ...claimsForRegistration(store.authenticate(token).binding), database: "/private/other.sqlite", captureMode: "full" })); expect((await forged.result).status).toBe(400);
  expect(getDrizzleDb().$client.query("SELECT id FROM runs").all()).toEqual([]);
});
test("real chunked oversize and stalled EOF release active reservations within finite lifetime", async () => {
  const oversized = open(); oversized.client.write(Buffer.alloc(262144 + 1, 32)); oversized.client.end(); expect((await oversized.result).status).toBe(413);
  const stalled = open(), started = performance.now(); stalled.client.write('{"version":'); expect((await stalled.result).status).toBe(408);
  expect(performance.now() - started).toBeLessThan(SERVICE_LIMITS.lifetimeMs); expect(controller.stats().active).toBe(0);
});
test("actual two active plus eight paused requests refuse excess and close drains every owned reservation", async () => {
  const held = Array.from({ length: 10 }, () => { const attempt = open(); attempt.client.write('{"version":'); return attempt; });
  await waitFor(() => controller.stats().active === 2 && controller.stats().queued === 8);
  const excess = open(); excess.client.end(admissionBody()); expect((await excess.result).status).toBe(429);
  await controller.close(); expect(controller.stats()).toEqual({ active: 0, queued: 0, closed: true });
  const results = await Promise.all(held.map(attempt => attempt.result)); expect(results.every(result => result.status === 503)).toBe(true);
});
test("owner rotation and actual anchor deletion during streaming body cannot publish or resurrect", async () => {
  const admission = admit(token, identity), raw = publicationBody(admission), delayed = open("publication"); delayed.client.write(raw.slice(0, -1));
  await waitFor(() => controller.stats().active === 1); store.rotateOwner(); delayed.client.end(raw.slice(-1)); expect((await delayed.result).status).toBe(409);
  const current = admit(token, identity), normalized = normalizeClaudeHook(hookFixture("Stop"), { sourceKey: current.sourceKey, captureMode: "full" }, null); if (normalized.status !== "accepted") throw new Error("fixture"); store.publish(token, current, normalized.value);
  const late = open("publication"), text = publicationBody(current); late.client.write(text.slice(0, -1)); await waitFor(() => controller.stats().active === 1);
  deleteRun(current.runId); late.client.end(text.slice(-1)); expect((await late.result).status).toBe(409); expect(getDrizzleDb().$client.query("SELECT id FROM runs WHERE id=?").get(current.runId)).toBeNull();
});
