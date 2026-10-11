import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { encodeFidelityRequest, fidelityOutput, fidelityRequest, fidelityTraceId } from "./fixtures/otlp-evidence";

const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "rp-otlp-evidence-"));
const processes: ChildProcess[] = [];
const stores = new Map<string, ChildProcess>();
let source: string, destination: string;

async function startStore(name: string): Promise<string> {
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("RUNPHANTOM_") && key !== "OPENAI_API_KEY" && key !== "ANTHROPIC_API_KEY"));
  const proc = spawn("bun", ["src/index.ts", "serve"], { cwd: path.resolve(import.meta.dir, ".."), stdio: "ignore",
    env: { ...inherited, HOME: directory, USERPROFILE: directory, RUNPHANTOM_PORT: String(port),
      RUNPHANTOM_BIND_HOST: "127.0.0.1", RUNPHANTOM_DB_PATH: path.join(directory, `${name}.db`),
      RUNPHANTOM_SECRET_STORE_PATH: path.join(directory, `${name}-secrets.json`), RUNPHANTOM_CLAUDE_CLI_CHAT: "0",
      OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" } });
  processes.push(proc);
  stores.set(name, proc);
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error("Owned fixture daemon exited before health");
    try { const response = await fetch(`${url}/health`); if (response.ok && (await response.json()).pid === proc.pid) return url; } catch { /* starting */ }
    await Bun.sleep(25);
  }
  throw new Error("Owned fixture daemon failed to start");
}

async function stopStore(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => proc.kill("SIGKILL"), 2500);
    proc.once("exit", () => { clearTimeout(timer); resolve(); }); proc.kill("SIGTERM");
  });
}

beforeAll(async () => { [source, destination] = await Promise.all([startStore("source"), startStore("destination")]); }, 15_000);
beforeEach(async () => { for (const url of [source, destination]) expect((await fetch(`${url}/api/clear`, { method: "POST" })).status).toBe(200); });
afterAll(async () => { await Promise.all(processes.map(stopStore)); rmSync(directory, { recursive: true, force: true }); });

async function exported(url = source, runId = fidelityTraceId) {
  const response = await fetch(`${url}/api/runs/${runId}/export`);
  expect(response.status).toBe(200);
  return response.json() as Promise<any>;
}
const post = (url: string, route: string, data: unknown) => fetch(`${url}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function record(name: string, value: unknown) {
  if (process.env.F10_EVIDENCE_PATH) writeFileSync(path.join(process.env.F10_EVIDENCE_PATH, name), JSON.stringify(value, null, 2) + "\n");
}

test.each(["JSON", "gzipped protobuf"])("actual %s ingest, file-backed storage, fresh-process reopen and independent import preserve evidence", async (encoding) => {
  const sent = fidelityRequest();
  const options = encoding === "JSON" ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sent) }
    : { method: "POST", headers: { "Content-Type": "application/x-protobuf", "Content-Encoding": "gzip" }, body: gzipSync(encodeFidelityRequest(sent)) };
  const ingest = await fetch(`${source}/v1/traces`, options);
  expect(ingest.status).toBe(200);
  if (encoding !== "JSON") expect(ingest.headers.get("content-type")).toContain("application/x-protobuf");
  const trace = await exported();
  expect(trace.format).toBe("runphantom-trace/v2"); expect(trace.spans).toHaveLength(1);
  expect(trace.spans[0].output_payload).toBe(fidelityOutput);
  expect(typeof trace.spans[0].otlp_evidence).toBe("string");
  const evidence = JSON.parse(trace.spans[0].otlp_evidence);
  expect(evidence.startTimeUnixNano).toBe(sent.resourceSpans[0].scopeSpans[0].spans[0].startTimeUnixNano);
  expect(evidence.events.map((event: any) => event.name)).toEqual(["checkout.captured", "checkout.finished"]);
  expect(evidence.links[0]).toMatchObject({ traceId: "ffeeddccbbaa99887766554433221100", spanId: "ffeeddccbbaa9988", flags: 0 });
  expect(evidence.events[0].attributes[0].value).toEqual({ intValue: "9007199254740993" });
  expect(evidence.events[1].droppedAttributesCount).toBeNull(); expect(evidence.droppedAttributesCount).toBe(0);
  expect((await fetch(`${source}/v1/traces`, options)).status).toBe(200);
  expect(await exported()).toEqual(trace);
  const previousPid = stores.get("source")!.pid;
  await stopStore(stores.get("source")!);
  const storage = new Database(path.join(directory, "source.db"), { readonly: true });
  try { expect(storage.query("SELECT otlp_evidence, output_payload FROM spans WHERE run_id = ?").get(fidelityTraceId)).toEqual({ otlp_evidence: trace.spans[0].otlp_evidence, output_payload: fidelityOutput }); }
  finally { storage.close(); }
  source = await startStore("source"); expect(stores.get("source")!.pid).not.toBe(previousPid);
  expect(await exported()).toEqual(trace);
  expect((await post(destination, "/api/import-run", trace)).status).toBe(200);
  const copy = await exported(destination); expect(copy).toEqual(trace);
  expect((await post(destination, "/api/import-run", trace)).status).toBe(200); expect(await exported(destination)).toEqual(copy);
  expect(await exported()).toEqual(trace);
  record(`roundtrip-${encoding === "JSON" ? "json" : "protobuf"}.json`, { source: trace, sourceDigest: sha(trace), destinationDigest: sha(copy), freshProcess: true, sqlColumnMatches: true, originalOutput: fidelityOutput });
});

test("new v2 evidence coexists with mixed null manual spans and old v1/legacy imports", async () => {
  const legacy = { run: { id: "legacy-fidelity-control", name: "older captured run", started_at: 100, last_updated_at: 200 },
    spans: [{ id: "legacy-span", name: "older output", start_time_ms: 100, end_time_ms: 200, duration_ms: 100, output_payload: "Unchanged older output" }] };
  expect((await post(source, "/api/import-run", legacy)).status).toBe(200);
  const old = await exported(source, legacy.run.id);
  expect(old.format).toBe("runphantom-trace/v1"); expect(old.spans[0].otlp_evidence).toBeUndefined();
  expect(old.spans[0].output_payload).toBe("Unchanged older output");
  expect((await post(destination, "/api/import-run", old)).status).toBe(200); expect(await exported(destination, legacy.run.id)).toEqual(old);
  expect((await post(source, "/v1/traces", fidelityRequest())).status).toBe(200);
  const mixed = await exported(); mixed.spans.push({ ...old.spans[0], run_id: fidelityTraceId, otlp_evidence: null });
  expect((await post(destination, "/api/import-run", mixed)).status).toBe(200);
  const actual = await exported(destination);
  expect(actual.spans.find((span: any) => span.id === "legacy-span").otlp_evidence).toBeNull();
  expect(actual.spans.find((span: any) => span.id === mixed.spans[0].id).otlp_evidence).toBe(mixed.spans[0].otlp_evidence);
  expect(await exported(source, legacy.run.id)).toEqual(old);
  record("legacy-and-mixed.json", { old, mixed: actual, oldDigestUnchanged: sha(old) === sha(await exported(source, legacy.run.id)) });
});

test("saved-cache v2 export retains bounded provenance after raw clearing and fresh import", async () => {
  expect((await post(source, "/v1/traces", fidelityRequest())).status).toBe(200);
  const original = await exported();
  const detail = await fetch(`${source}/api/runs/detail/${fidelityTraceId}`);
  expect(detail.status).toBe(200);
  const captured = await detail.json();
  expect(captured.run.id).toBe(fidelityTraceId);
  expect(captured.spans[0].otlp_evidence).toBe(original.spans[0].otlp_evidence);
  const cached = await fetch(`${source}/api/saved-runs/cache/${fidelityTraceId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(captured) });
  expect(cached.status).toBe(200);
  expect((await fetch(`${source}/api/clear`, { method: "POST" })).status).toBe(200);
  const download = await exported();
  expect(download.format).toBe("runphantom-trace/v2"); expect(download.exportSource).toBe("saved-cache");
  expect(download.exportNotice).toContain("may be compacted");
  expect(download.spans[0].otlp_evidence).toBe(original.spans[0].otlp_evidence);
  expect(download.spans[0].output_payload).toBe(fidelityOutput);
  expect((await post(destination, "/api/import-run", download)).status).toBe(200);
  const restored = await exported(destination);
  expect(restored.spans[0].otlp_evidence).toBe(original.spans[0].otlp_evidence);
  expect(restored.spans[0].output_payload).toBe(fidelityOutput);
  record("saved-cache-roundtrip.json", { originalDigest: sha(original), cache: download, restored, compactedViewNoticePreserved: true });
});
