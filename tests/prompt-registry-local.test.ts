import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { request as httpRequest, type Server } from "node:http";
import { closeDb, getDrizzleDb, upsertRun } from "../src/db";
import { createServer } from "../src/server";
import { PromptRegistry } from "../src/prompts/registry";
import type { PromptRevision } from "../src/prompts/protocol";
import { EVIDENCE_IMPORT_CONTENT_TYPE, EVIDENCE_READER_IDENTITY } from "../src/evaluations/evidence-import";
import { evidenceDigest } from "../src/evaluations/evidence-validation";

let server: Server, directory: string, prior: string | undefined, base: string;
beforeEach(async () => {
  closeDb(); directory = mkdtempSync(path.join(tmpdir(), "prompt-local-actual-")); prior = process.env.RUNPHANTOM_DB_PATH; process.env.RUNPHANTOM_DB_PATH = path.join(directory, "actual.db");
  expect(getDrizzleDb().$client.query("SELECT * FROM prompt_scope_controls").all()).toEqual([]);
  await start(); expect(getDrizzleDb().$client.query("SELECT p.scope_key,p.generation FROM prompt_scope_controls p JOIN evaluation_evidence_scopes e ON e.scope_key=p.scope_key").all()).toEqual([{ scope_key: "local:local", generation: 1 }]);
});
afterEach(async () => { await stop(); if (prior === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = prior; rmSync(directory, { recursive: true, force: true }); });
async function start() { ({ server } = await createServer(0)); server.listen(0, "127.0.0.1"); await once(server, "listening"); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; }
async function stop() { await new Promise<void>(resolve => server.close(() => resolve())); closeDb(); }
const draft = (template = "Original {{value}}") => ({ operationKey: randomUUID(), name: "Actual local", template });
async function call<T = unknown>(route: string, method = "GET", body?: unknown) {
  const response = await fetch(base + route, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); return { status: response.status, value: JSON.parse(text) as T, text };
}
test("actual registered local prompt API keeps local guards, bounded parser, immutable pins and replay across daemon reopen", async () => {
  const api = "/api/prompts", input = draft(), first = await call<PromptRevision>(api, "POST", input);
  expect(first.status).toBe(201); expect((await call(api, "POST", input)).value).toEqual(first.value);
  expect((await call(`${api}/${first.value.id}/revisions`, "POST", { ...draft("Changed"), expectedRevision: 1 })).status).toBe(201);
  expect((await call(`${api}/${first.value.id}/revisions/1/compile`, "POST", { variables: { value: "$& {{next}} <img>" } })).value).toMatchObject({ compiled: "Original $& {{next}} <img>", revision: 1 });
  expect((await call(`${api}/${first.value.id}/revisions/1/export`)).value).toMatchObject({ prompt: first.value });
  expect((await fetch(base + api, { method: "POST", headers: { Origin: "https://foreign.invalid", "Content-Type": "application/json" }, body: JSON.stringify(draft()) })).status).toBe(403);
  expect((await fetch(base + api, { headers: { Host: "foreign.invalid" } })).status).toBe(403);
  for (const [body, expected] of [["{\"name\":\"one\",\"name\":\"two\"}", 400], [JSON.stringify({ oversized: "x".repeat(65536) }), 413]] as const) expect((await fetch(base + api, { method: "POST", headers: { "Content-Type": "application/json" }, body })).status).toBe(expected);
  expect((await fetch(base + api, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status).toBe(400);
  const refused = await call(api, "POST", draft("password=synthetic-private-value")); expect(refused.status).toBe(400); expect(refused.text).not.toContain("synthetic-private-value");
  await stop(); await start();
  expect((await call(`${api}/${first.value.id}/revisions/1`)).value).toEqual(first.value);
  expect((await call(api, "POST", input)).value).toEqual(first.value);
  expect(getDrizzleDb().$client.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
test("actual local prompt-only clear preserves completed report discovery and exact detail after reopen and refuses the held pre-clear save", async () => {
  upsertRun({ id: "retained-report-run", started_at: 1, last_updated_at: 1 });
  const bytes = Buffer.from('<testsuite tests="1"><testcase name="Retained report"/></testsuite>'), attachment = { kind: "run", id: "retained-report-run" };
  const metadata = Buffer.from(JSON.stringify({ version: 1, request: { ...EVIDENCE_READER_IDENTITY, operationKey: "local-prompt-clear-report", attachment, target: null, inventory: null, retention: "raw_and_normalized", sources: [{ sourceId: "retained", shardId: "unit", kind: "junit", dialect: "junit-xml/v1", artifactSha256: evidenceDigest(bytes), byteLength: bytes.byteLength }] } }));
  const length = Buffer.alloc(4); length.writeUInt32BE(metadata.byteLength);
  const imported = await fetch(base + "/api/evaluations/evidence/imports", { method: "POST", headers: { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE }, body: Buffer.concat([length, metadata, bytes]) }); expect(imported.status).toBe(202);
  let job = (await imported.json() as { job: { id: string; status: string; setId: string } }).job;
  const deadline = Date.now() + 5000;
  while (["queued", "running"].includes(job.status) && Date.now() < deadline) { await Bun.sleep(10); job = (await call<{ job: typeof job }>(`/api/evaluations/evidence/imports/${job.id}`)).value.job; }
  expect(job.status).toBe("completed");
  const discovery = "/api/evaluations/evidence/sets?" + new URLSearchParams({ attachment: JSON.stringify(attachment) }).toString(), detail = `/api/evaluations/evidence/sets/${job.setId}?revision=1`;
  const before = await call<{ items: unknown[] }>(discovery), original = await call(detail); expect(before.value.items).toHaveLength(1); expect(original.status).toBe(200);
  expect((await call("/api/prompts", "POST", draft())).status).toBe(201);
  const spy = spyOn(PromptRegistry.prototype, "capture"), observed = spy.mock.calls.length;
  const body = Buffer.from(JSON.stringify(draft("queued-private-canary"))), half = Math.floor(body.byteLength / 2);
  let pending!: ReturnType<typeof httpRequest>;
  const result = new Promise<{ status: number; text: string }>((resolve, reject) => {
    pending = httpRequest(base + "/api/prompts", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": body.byteLength } }, response => { let text = ""; response.on("data", part => { text += part; }); response.on("end", () => resolve({ status: response.statusCode!, text })); }); pending.on("error", reject); pending.write(body.subarray(0, half));
  });
  try {
    const capturedDeadline = Date.now() + 3000; while (spy.mock.calls.length <= observed && Date.now() < capturedDeadline) await Bun.sleep(5); expect(spy.mock.calls.length).toBeGreaterThan(observed);
    const capabilities = (await call<{ generation: number }>("/api/prompts/capabilities")).value, shared = getDrizzleDb().$client.query("SELECT generation FROM evaluation_evidence_scopes").all();
    const cleared = await call<{ generation: number }>("/api/prompts/clear", "POST", { expectedGeneration: capabilities.generation, operationKey: randomUUID() }); expect(cleared.status).toBe(200); expect(cleared.value.generation).toBe(capabilities.generation + 1);
    pending.end(body.subarray(half)); const refused = await result; expect(refused.status).toBe(409); expect(refused.text).not.toContain("queued-private-canary");
    expect(getDrizzleDb().$client.query("SELECT generation FROM evaluation_evidence_scopes").all()).toEqual(shared);
    expect(getDrizzleDb().$client.query("SELECT * FROM prompt_heads").all()).toEqual([]); expect(getDrizzleDb().$client.query("SELECT * FROM prompt_revisions").all()).toEqual([]);
    expect((await call(discovery)).value).toEqual(before.value); expect((await call(detail)).value).toEqual(original.value);
    spy.mockRestore(); await stop(); await start();
    expect((await call(discovery)).value).toEqual(before.value); expect((await call(detail)).value).toEqual(original.value);
    expect((await call<{ generation: number }>("/api/prompts/capabilities")).value.generation).toBe(cleared.value.generation);
  } finally { spy.mockRestore(); pending.destroy(); }
}, 20000);
