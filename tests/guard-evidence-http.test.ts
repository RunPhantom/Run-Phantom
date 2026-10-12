import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { deriveCapturedGuardEvidence } from "../src/guard-evidence";
import { normalizeStoredSpan } from "../src/spans/normalize";
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
function record(name: string, data: unknown) {
  if (process.env.F36_EVIDENCE_PATH) writeFileSync(path.join(process.env.F36_EVIDENCE_PATH, name), JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
}
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
    guard_decisions: guardSecrets.npm, secret_extra: guardSecrets.hf,
    normalized: { kind: "other", guardEvidence: { explanation: guardSecrets.password } } });
  expect((await post(`/api/saved-runs/cache/${guardTraceId}`, spoofed, "PUT")).status).toBe(200);
  const cached = await read(`/api/saved-runs/cache/${guardTraceId}`); noSecrets(cached); expect(cached.spans[0].guardEvidence).toEqual(expected);
  expect(cached.spans[0].normalized).toEqual({ kind: "other" });
  const db = new Database(dbPath); const stored = db.query("SELECT data FROM saved_run_cache WHERE id=?").get(guardTraceId) as any; noSecrets(stored);
  const unsafe = structuredClone(spoofed), receipt = JSON.parse(unsafe.spans[0].otlp_evidence);
  unsafe.guardEvidence = { decisions: [{ explanation: guardSecrets.npm }] };
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

test("legacy invalid source carriers retain export refusal without changing the private cache or canonical payloads", async () => {
  expect((await post("/v1/traces", guardRequest())).status).toBe(200);
  const original = await read(`/api/runs/detail/${guardTraceId}`), source = original.spans[0], receipt = source.otlp_evidence as string;
  const variants = [receipt.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    receipt.replace('"schemaVersion":1', '"schemaVersion":1,"schema\\u0056ersion":1'),
    receipt.replace('"doubleValue":0', '"doubleValue":9007199254740993'),
    { invalid: true }, " ".repeat(262145), "{invalid"];
  expect((await fetch(`${url}/api/clear`, { method: "POST" })).status).toBe(200);
  for (const [index, raw] of variants.entries()) {
    const cached = structuredClone(original); cached.spans[0].otlp_evidence = raw;
    const data = JSON.stringify(cached), db = new Database(dbPath);
    db.query("INSERT OR REPLACE INTO saved_run_cache(id,data) VALUES (?,?)").run(guardTraceId, data); db.close();
    const actual = await read(`/api/saved-runs/cache/${guardTraceId}`), fallback = await read(`/api/runs/detail/${guardTraceId}`);
    expect(actual.spans[0]).toMatchObject({ input_payload: source.input_payload, output_payload: source.output_payload, status: source.status,
      otlp_evidence: null, guardEvidence: { execution: "unknown", decisions: [] } });
    expect(fallback.spans[0]).toEqual(actual.spans[0]);
    const exported = await fetch(`${url}/api/runs/${guardTraceId}/export`), exportBody = await exported.json();
    const check = new Database(dbPath, { readonly: true }), after = (check.query("SELECT data FROM saved_run_cache WHERE id=?").get(guardTraceId) as any).data; check.close();
    record(`guard-cache-invalid-${index}.json`, { raw, cache: actual, detail: fallback, exportStatus: exported.status, exportBody, privateBefore: data, privateAfter: after });
    expect(exported.status).toBe(413); noSecrets(exportBody); expect(after).toBe(data);
  }
  const portable = { format: "runphantom-trace/v2", run: original.run, spans: [{ ...source, otlp_evidence: variants[0] }], liveEvents: [], annotations: [] };
  expect((await post("/api/import-run", portable)).status).toBe(400);
});

test("non-object legacy attributes normalize safely while real LLM/tool sources and business bodies retain their values", async () => {
  expect((await post("/v1/traces", guardRequest())).status).toBe(200);
  const original = await read(`/api/runs/detail/${guardTraceId}`), source = original.spans[0];
  expect((await fetch(`${url}/api/clear`, { method: "POST" })).status).toBe(200);
  for (const attributes of ["null", "[]", "42", '"plain text"', "{"]) {
    const row = { ...source, attributes, otlp_evidence: null, normalized: { guardEvidence: { explanation: guardSecrets.npm } } }, body = { run: original.run, spans: [row] };
    expect((await post(`/api/saved-runs/cache/${guardTraceId}`, body, "PUT")).status).toBe(200);
    const cache = await read(`/api/saved-runs/cache/${guardTraceId}`); noSecrets(cache);
    expect(cache.spans[0]).toMatchObject({ attributes, input_payload: source.input_payload, output_payload: source.output_payload, status: source.status,
      normalized: { kind: "other" }, guardEvidence: { decisions: [] } });
    const data = JSON.stringify(body), db = new Database(dbPath); db.query("UPDATE saved_run_cache SET data=? WHERE id=?").run(data, guardTraceId); db.close();
    const actual = await read(`/api/saved-runs/cache/${guardTraceId}`), fallback = await read(`/api/runs/detail/${guardTraceId}`);
    expect(actual.spans[0]).toEqual(cache.spans[0]); expect(fallback.spans[0]).toEqual(cache.spans[0]);
    const exported = await read(`/api/runs/${guardTraceId}/export`);
    record(`guard-cache-attributes-${Buffer.from(attributes).toString("hex")}.json`, { request: body, cache, legacyCache: actual, detail: fallback, exported });
    expect(exported.spans[0]).toMatchObject({ attributes, input_payload: source.input_payload, output_payload: source.output_payload, status: source.status, otlp_evidence: null });
    expect(exported.spans[0].normalized).toBeUndefined(); expect(exported.spans[0].guardEvidence).toBeUndefined();
  }
  for (const row of [{ ...source, span_type: "LLM_GENERATION", attributes: JSON.stringify({ "ai.prompt": "Original real prompt", "ai.response.model": "source-model" }) },
    { ...source, span_type: "TOOL_CALL", attributes: JSON.stringify({ "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "source-tool",
      "gen_ai.tool.call.arguments": '{"count":0}', "gen_ai.tool.call.result": '{"isError":false}', "otel.status.code": 1 }) }]) {
    expect((await post(`/api/saved-runs/cache/${guardTraceId}`, { run: original.run, spans: [{ ...row, normalized: { guardEvidence: guardSecrets.password } }] }, "PUT")).status).toBe(200);
    const actual = (await read(`/api/saved-runs/cache/${guardTraceId}`)).spans[0]; noSecrets(actual);
    expect(actual.normalized).toEqual(normalizeStoredSpan(row).normalized);
    expect(actual.normalized.kind).toBe(row.span_type === "LLM_GENERATION" ? "llm" : "tool");
    expect(actual).toMatchObject({ input_payload: source.input_payload, output_payload: source.output_payload, status: source.status, id: source.id });
  }
  const business = { ...source, otlp_evidence: null, input_payload: JSON.stringify({ guardEvidence: { explanation: guardSecrets.password }, code: "npm_literal_small" }),
    output_payload: JSON.stringify({ guard_decisions: { action: "allow" }, password: guardSecrets.password }) };
  expect((await post(`/api/saved-runs/cache/${guardTraceId}`, { run: original.run, spans: [business] }, "PUT")).status).toBe(200);
  expect((await read(`/api/saved-runs/cache/${guardTraceId}`)).spans[0]).toMatchObject({ input_payload: business.input_payload, output_payload: business.output_payload,
    status: business.status, guardEvidence: { decisions: [] } });
});
