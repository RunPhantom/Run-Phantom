import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { deriveCapturedGuardEvidence } from "../src/guard-evidence";
import { guardEvent, guardHarmless, guardOutput, guardRequest, guardSecrets, guardSpanId, guardTraceId } from "./fixtures/guard-evidence";
import { encodeFidelityRequest } from "./fixtures/otlp-evidence";

const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "rp-guard-http-")), dbPath = path.join(directory, "capture.db");
let daemon: ChildProcess, url: string;
async function start() {
  const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port; await new Promise<void>(resolve => socket.close(() => resolve()));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RUNPHANTOM_") && key !== "OPENAI_API_KEY" && key !== "ANTHROPIC_API_KEY"));
  daemon = spawn("bun", ["src/index.ts", "serve"], { cwd: path.resolve(import.meta.dir, ".."), stdio: "ignore", env: { ...inherited,
    HOME: directory, USERPROFILE: directory, RUNPHANTOM_PORT: String(port), RUNPHANTOM_BIND_HOST: "127.0.0.1", RUNPHANTOM_DB_PATH: dbPath,
    RUNPHANTOM_SECRET_STORE_PATH: path.join(directory, "secret-store.json"), RUNPHANTOM_CLAUDE_CLI_CHAT: "0", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" } });
  url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (daemon.exitCode !== null || daemon.signalCode !== null) throw Error("Owned guard daemon exited");
    try { const response = await fetch(`${url}/health`); if (response.ok && (await response.json()).pid === daemon.pid) return; } catch { /* startup */ }
    await Bun.sleep(25);
  }
  throw Error("Owned guard daemon did not become healthy");
}
async function stop() {
  if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) return;
  await new Promise<void>(resolve => { const timer = setTimeout(() => daemon.kill("SIGKILL"), 2500);
    daemon.once("exit", () => { clearTimeout(timer); resolve(); }); daemon.kill("SIGTERM"); });
}
const post = (route: string, body: unknown, method = "POST") => fetch(`${url}${route}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function read(route: string) { const response = await fetch(`${url}${route}`); expect(response.status).toBe(200); return response.json() as Promise<any>; }
function noSecrets(value: unknown) { const text = JSON.stringify(value); for (const secret of Object.values(guardSecrets)) expect(text).not.toContain(secret); }
function record(name: string, data: unknown) { if (process.env.F36_EVIDENCE_PATH) writeFileSync(path.join(process.env.F36_EVIDENCE_PATH, name), JSON.stringify(data, null, 2) + "\n"); }
beforeAll(start, 15_000);
beforeEach(async () => { expect((await fetch(`${url}/api/clear`, { method: "POST" })).status).toBe(200); await fetch(`${url}/api/saved-runs/cache/${guardTraceId}`, { method: "DELETE" }); });
afterAll(async () => { await stop(); rmSync(directory, { recursive: true, force: true }); });

for (const wire of ["json", "protobuf-gzip"]) test(`${wire} actual HTTP capture, persistence, reread, restart and export keep guard evidence private and advisory`, async () => {
  const body = guardRequest() as any, span = body.resourceSpans[0].scopeSpans[0].spans[0];
  span.events[3] = guardEvent("deny", { "guard.explanation": `${guardSecrets.npm} ${guardSecrets.hf} ${guardSecrets.pem} password=${guardSecrets.password} ${guardHarmless}` });
  const original = JSON.stringify(body);
  const ingest = wire === "json" ? await post("/v1/traces", body) : await fetch(`${url}/v1/traces`, { method: "POST",
    headers: { "Content-Type": "application/x-protobuf", "Content-Encoding": "gzip" }, body: gzipSync(encodeFidelityRequest(body)) });
  expect(ingest.status).toBe(200);
  const detail = await read(`/api/runs/detail/${guardTraceId}`), actual = detail.spans[0];
  noSecrets(detail); expect(actual).toMatchObject({ status: "OK", output_payload: guardOutput, guardEvidence: { advisory: true, execution: "unknown", state: "partial" } });
  expect(actual.guardEvidence.decisions.map((d: any) => d.action)).toEqual(["allow", "warn", "redact", "deny", "allow"]);
  expect(actual.guardEvidence.decisions[0]).toMatchObject({ score: 0, latencyMs: 0, error: false });
  expect(actual.guardEvidence.decisions[3].explanation).toContain(guardHarmless);
  const exported = await read(`/api/runs/${guardTraceId}/export`); noSecrets(exported);
  expect(deriveCapturedGuardEvidence(exported.spans[0].otlp_evidence)).toEqual(actual.guardEvidence); expect(exported.spans[0].output_payload).toBe(guardOutput);
  expect(exported.spans[0].guardEvidence).toBeUndefined();
  expect((await post(`/api/saved-runs/cache/${guardTraceId}`, detail, "PUT")).status).toBe(200);
  const cached = await read(`/api/saved-runs/cache/${guardTraceId}`); noSecrets(cached); expect(cached.spans[0].guardEvidence).toEqual(actual.guardEvidence);
  await stop();
  const db = new Database(dbPath, { readonly: true });
  const persisted = db.query("SELECT otlp_evidence, output_payload, status FROM spans WHERE id=?").get(guardSpanId) as any;
  const storedCache = db.query("SELECT data FROM saved_run_cache WHERE id=?").get(guardTraceId) as any;
  db.close(); noSecrets(persisted); noSecrets(storedCache); expect(persisted.output_payload).toBe(guardOutput); expect(persisted.status).toBe("OK");
  expect(persisted.otlp_evidence).toBe(actual.otlp_evidence);
  const firstPid = daemon.pid; await start(); expect(daemon.pid).not.toBe(firstPid);
  const reopened = await read(`/api/runs/detail/${guardTraceId}`); expect(reopened.spans[0].guardEvidence).toEqual(actual.guardEvidence);
  expect(await read(`/api/runs/${guardTraceId}/export`)).toEqual(exported); expect(JSON.stringify(body)).toBe(original);
  record(`guard-http-${wire}.json`, { source: "synthetic local captured telemetry; no provider execution", pids: [firstPid, daemon.pid], actual, persisted, exported, cached });
}, 15_000);

test("cache input and legacy cache rereads strip contradictory decisions and withhold a malformed or secret-bearing carrier", async () => {
  expect((await post("/v1/traces", guardRequest())).status).toBe(200);
  const detail = await read(`/api/runs/detail/${guardTraceId}`), expected = detail.spans[0].guardEvidence;
  const spoofed = structuredClone(detail);
  Object.assign(spoofed.spans[0], { guardEvidence: { advisory: false, execution: "verified", decisions: [{ action: "allow", explanation: guardSecrets.password }] },
    guard_decisions: guardSecrets.npm, secret_extra: guardSecrets.hf });
  expect((await post(`/api/saved-runs/cache/${guardTraceId}`, spoofed, "PUT")).status).toBe(200);
  const cached = await read(`/api/saved-runs/cache/${guardTraceId}`); noSecrets(cached); expect(cached.spans[0].guardEvidence).toEqual(expected);
  const db = new Database(dbPath); const stored = db.query("SELECT data FROM saved_run_cache WHERE id=?").get(guardTraceId) as any; noSecrets(stored);
  const unsafe = structuredClone(spoofed), receipt = JSON.parse(unsafe.spans[0].otlp_evidence);
  receipt.events[0].attributes[5].value.stringValue = `password=${guardSecrets.password}`;
  unsafe.spans[0].otlp_evidence = JSON.stringify(receipt);
  db.query("UPDATE saved_run_cache SET data=? WHERE id=?").run(JSON.stringify(unsafe), guardTraceId); db.close();
  const reread = await read(`/api/saved-runs/cache/${guardTraceId}`); noSecrets(reread);
  expect(reread.spans[0]).toMatchObject({ otlp_evidence: null, output_payload: guardOutput, status: "OK", guardEvidence: { state: "unknown", decisions: [], reasons: ["source_receipt_invalid"] } });
  expect((await fetch(`${url}/api/clear`, { method: "POST" })).status).toBe(200);
  const fallback = await read(`/api/runs/detail/${guardTraceId}`); noSecrets(fallback); expect(fallback.spans[0].guardEvidence).toEqual(reread.spans[0].guardEvidence);
  const rejected = await fetch(`${url}/api/runs/${guardTraceId}/export`); expect(rejected.status).toBe(413); noSecrets(await rejected.json());
  unsafe.spans[0].otlp_evidence = `{"invalid":"${guardSecrets.npm}"`;
  expect((await post(`/api/saved-runs/cache/${guardTraceId}`, unsafe, "PUT")).status).toBe(200);
  noSecrets(await read(`/api/saved-runs/cache/${guardTraceId}`));
  const check = new Database(dbPath, { readonly: true }); noSecrets(check.query("SELECT data FROM saved_run_cache WHERE id=?").get(guardTraceId)); check.close();
});

test("portable import ignores supplied derived guard authority and rejects a credential-bearing receipt atomically", async () => {
  expect((await post("/v1/traces", guardRequest())).status).toBe(200);
  const original = await read(`/api/runs/${guardTraceId}/export`), spoofed = structuredClone(original);
  spoofed.spans[0].guardEvidence = { decisions: [{ action: "deny", explanation: guardSecrets.password }] };
  expect((await post("/api/import-run", spoofed)).status).toBe(200);
  expect(await read(`/api/runs/${guardTraceId}/export`)).toEqual(original);
  const unsafe = structuredClone(original), receipt = JSON.parse(unsafe.spans[0].otlp_evidence);
  receipt.events[0].attributes[5].value.stringValue = guardSecrets.pem; unsafe.spans[0].otlp_evidence = JSON.stringify(receipt);
  expect((await post("/api/import-run", unsafe)).status).toBe(400);
  expect(await read(`/api/runs/${guardTraceId}/export`)).toEqual(original);
});
