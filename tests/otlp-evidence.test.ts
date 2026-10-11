import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { OTLP_EVIDENCE_LIMITS } from "../src/spans/otlp-evidence";
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
  expect(evidence.status).toEqual({ code: 1, message: "Local capture completed" });
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

test("actual ingress persists receiver loss and redaction separately from unavailable exporter counts", async () => {
  const sent = fidelityRequest() as any, span = sent.resourceSpans[0].scopeSpans[0].spans[0];
  const credential = `sk-proj-${"x".repeat(48)}`;
  delete span.droppedEventsCount;
  span.events = Array.from({ length: 130 }, (_, index) => ({ name: `bounded-event-${index}`, timeUnixNano: "1770000000000000002", attributes: [] }));
  span.events[0].attributes = [
    { key: "api_key", value: { stringValue: credential } }, { key: "__proto__", value: { stringValue: "ignored" } },
    { key: "long-value", value: { stringValue: "x".repeat(4097) } }, { key: "url", value: { stringValue: `https://example.test/?token=${credential}&order=A-42` } },
    ...Array.from({ length: 126 }, (_, index) => ({ key: `marker-${index}`, value: { boolValue: false } })),
  ];
  span.links = Array.from({ length: 131 }, () => ({ traceId: span.traceId, spanId: span.spanId, attributes: [] }));
  span.links[0].flags = -1;
  const sourceDigest = sha(sent);
  expect((await post(source, "/v1/traces", sent)).status).toBe(200);
  const trace = await exported(), evidence = JSON.parse(trace.spans[0].otlp_evidence);
  expect(sha(sent)).toBe(sourceDigest); expect(trace.spans[0].output_payload).toBe(fidelityOutput);
  expect(evidence.events).toHaveLength(128); expect(evidence.links).toHaveLength(128);
  expect(evidence.events[0].attributes).toHaveLength(127);
  expect(evidence.events[0].attributes).toContainEqual({ key: "api_key", value: { stringValue: "[REDACTED]" } });
  expect(evidence.events[0].attributes).toContainEqual({ key: "long-value", value: { stringValue: "[TRUNCATED]" } });
  expect(evidence.droppedEventsCount).toBeNull(); expect(evidence.droppedLinksCount).toBe(4); expect(evidence.links[0].flags).toBeNull();
  expect(evidence.capture).toMatchObject({ sourceCountPolicy: "absent-is-unknown", droppedEvents: 2, droppedLinks: 3,
    droppedAttributes: 3, truncatedValues: 1, invalidValues: 2, redactedValues: 2 });
  expect(trace.spans[0].otlp_evidence).not.toContain(credential);
  expect(Buffer.byteLength(trace.spans[0].otlp_evidence)).toBeLessThanOrEqual(OTLP_EVIDENCE_LIMITS.bytes);
  expect((await post(destination, "/api/import-run", trace)).status).toBe(200);
  expect(await exported(destination)).toEqual(trace);
  record("bounded-capture-roundtrip.json", { trace, originalOutput: fidelityOutput, sourceDigestUnchanged: sha(sent) === sourceDigest });
});

test.each(["JSON", "gzipped protobuf"])("actual %s diagnostic capture preserves absence and bounds secrets/oversized messages through reopen and import", async encoding => {
  const sent = fidelityRequest() as any, sourceSpan = sent.resourceSpans[0].scopeSpans[0].spans[0];
  const credential = `sk-proj-${"x".repeat(48)}`;
  const diagnostics = [undefined, { message: "Source diagnostic without code" }, { code: 0, message: "" },
    { code: 2, message: credential }, { code: 2, message: "diagnostic ".repeat(500) }];
  sent.resourceSpans[0].scopeSpans[0].spans = diagnostics.map((status, index) => ({ ...structuredClone(sourceSpan),
    spanId: `10203040506070${String(index + 80)}`, status }));
  const options = encoding === "JSON" ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sent) }
    : { method: "POST", headers: { "Content-Type": "application/x-protobuf", "Content-Encoding": "gzip" }, body: gzipSync(encodeFidelityRequest(sent)) };
  expect((await fetch(`${source}/v1/traces`, options)).status).toBe(200);
  const trace = await exported(); expect(trace.spans).toHaveLength(5);
  for (const [index, span] of trace.spans.entries()) {
    const evidence = JSON.parse(span.otlp_evidence), status = diagnostics[index];
    expect(span.output_payload).toBe(fidelityOutput); expect(span.status).toBe(index < 3 ? "OK" : "ERROR");
    expect(evidence.status).toEqual(index === 0 ? null : { code: status!.code ?? null,
      message: index === 3 ? "[REDACTED]" : index === 4 ? "[TRUNCATED]" : status!.message ?? null });
    expect(evidence.capture).toMatchObject({ redactedValues: index === 3 ? 1 : 0, truncatedValues: index === 4 ? 1 : 0 });
    expect(span.otlp_evidence).not.toContain(credential);
    if (index === 1 && encoding !== "JSON") expect(JSON.parse(span.attributes)["otel.status.code"]).toBe(0);
  }
  await stopStore(stores.get("source")!); source = await startStore("source"); expect(await exported()).toEqual(trace);
  expect((await post(destination, "/api/import-run", trace)).status).toBe(200); expect(await exported(destination)).toEqual(trace);
  record(`diagnostic-${encoding === "JSON" ? "json" : "protobuf"}.json`, { trace, exactAfterReopenAndIndependentImport: true, legacyCanonicalOutcomeAndOriginalOutputRetained: true,
    notice: "Only the bounded source envelope is sanitized. Existing legacy flat diagnostic attributes are intentionally preserved." });
});

const invalidEnvelopes: [string, (evidence: any) => void][] = [
  ["unknown envelope version", evidence => { evidence.schemaVersion = 2; }],
  ["missing status observation", evidence => { delete evidence.status; }],
  ["status code overflow", evidence => { evidence.status.code = 2147483648; }],
  ["credential-bearing diagnostic", evidence => { evidence.status.message = `sk-proj-${"x".repeat(48)}`; }],
  ["oversized diagnostic", evidence => { evidence.status.message = "x".repeat(4097); }],
  ["unknown field", evidence => { evidence.unreported = true; }],
  ["missing source count", evidence => { delete evidence.droppedEventsCount; }],
  ["lossy numeric nanoseconds", evidence => { evidence.events[0].timeUnixNano = 1770000000000000000; }],
  ["uint64 overflow", evidence => { evidence.startTimeUnixNano = "18446744073709551616"; }],
  ["int64 overflow", evidence => { evidence.events[0].attributes[0].value.intValue = "9223372036854775808"; }],
  ["invalid exporter count", evidence => { evidence.droppedLinksCount = -1; }],
  ["invented receiver count", evidence => { evidence.capture.droppedEvents = null; }],
  ["prototype key", evidence => { evidence.events[0].attributes[0].key = "__proto__"; }],
  ["multiple AnyValue variants", evidence => { evidence.events[0].attributes[0].value.boolValue = false; }],
  ["sensitive attribute without canonical redaction", evidence => { evidence.events[0].attributes.push({ key: "api_key", value: { stringValue: "do-not-persist" } }); }],
  ["credential-shaped text", evidence => { evidence.events[0].name = `sk-proj-${"x".repeat(48)}`; }],
  ["event cap", evidence => { evidence.events = Array.from({ length: 129 }, () => evidence.events[0]); }],
  ["link cap", evidence => { evidence.links = Array.from({ length: 129 }, () => evidence.links[0]); }],
  ["attribute cap", evidence => { evidence.attributes = Array.from({ length: 129 }, () => ({ key: "marker", value: { boolValue: false } })); }],
  ["AnyValue collection cap", evidence => { evidence.events[0].attributes[0].value = { arrayValue: { values: Array.from({ length: 129 }, () => ({ boolValue: false })) } }; }],
  ["nested depth cap", evidence => { let value: any = { boolValue: false }; for (let i = 0; i < 10; i++) value = { arrayValue: { values: [value] } }; evidence.events[0].attributes[0].value = value; }],
  ["total envelope byte cap", evidence => { evidence.events = Array.from({ length: 128 }, () => ({ ...evidence.events[0], name: "x".repeat(4096) })); }],
];

test.each(invalidEnvelopes)("actual v2 HTTP import refuses %s before any existing or new trace mutation", async (label, mutate) => {
  expect((await post(source, "/v1/traces", fidelityRequest())).status).toBe(200);
  const original = await exported();
  expect((await post(destination, "/api/import-run", original)).status).toBe(200);
  expect((await post(destination, "/api/annotations", { run_id: fidelityTraceId, span_id: null, kind: "note", note: "Preserve local review", source: "user" })).status).toBe(201);
  const before = await exported(destination), invalid = structuredClone(original);
  const evidence = JSON.parse(invalid.spans[0].otlp_evidence); mutate(evidence);
  invalid.run.display_name = "Must not replace local metadata"; invalid.spans[0].output_payload = "Must not replace captured output";
  invalid.spans[0].otlp_evidence = JSON.stringify(evidence);
  const response = await post(destination, "/api/import-run", invalid);
  expect(response.status).toBe(400); expect((await response.json()).error).toContain("import rejected");
  expect(await exported(destination)).toEqual(before); expect(await exported()).toEqual(original);
  const newId = "rejected-new-evidence"; invalid.run.id = newId; invalid.spans[0].run_id = newId;
  expect((await post(destination, "/api/import-run", invalid)).status).toBe(400);
  expect((await fetch(`${destination}/api/runs/${newId}/export`)).status).toBe(404);
  expect(await exported(destination)).toEqual(before);
  record(`invalid-${label.replace(/[^a-z0-9]+/g, "-")}.json`, { label, rejectionStatus: 400, sourceDigest: sha(original), existingDigestBefore: sha(before), existingDigestAfter: sha(await exported(destination)), newRunStatus: 404 });
});

test.each(["missing column", "object instead of string", "extra encoded bytes", "v1 masquerade"])("actual import rejects %s without creating a destination trace", async label => {
  expect((await post(source, "/v1/traces", fidelityRequest())).status).toBe(200);
  const original = await exported(), invalid = structuredClone(original);
  if (label === "missing column") delete invalid.spans[0].otlp_evidence;
  else if (label === "object instead of string") invalid.spans[0].otlp_evidence = JSON.parse(invalid.spans[0].otlp_evidence);
  else if (label === "extra encoded bytes") invalid.spans[0].otlp_evidence += " ".repeat(OTLP_EVIDENCE_LIMITS.bytes);
  else invalid.format = "runphantom-trace/v1";
  expect((await post(destination, "/api/import-run", invalid)).status).toBe(400);
  expect((await fetch(`${destination}/api/runs/${fidelityTraceId}/export`)).status).toBe(404);
  expect(await exported()).toEqual(original);
});

test("a corrupted saved-cache envelope cannot become a portable download or imported evidence", async () => {
  expect((await post(source, "/v1/traces", fidelityRequest())).status).toBe(200);
  const original = await exported(), cached = structuredClone(original);
  const credential = `sk-proj-${"x".repeat(48)}`, evidence = JSON.parse(cached.spans[0].otlp_evidence);
  evidence.events[0].name = credential; cached.spans[0].otlp_evidence = JSON.stringify(evidence);
  expect((await fetch(`${source}/api/saved-runs/cache/${fidelityTraceId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cached) })).status).toBe(200);
  expect(await exported()).toEqual(original);
  expect((await fetch(`${source}/api/clear`, { method: "POST" })).status).toBe(200);
  const rejected = await fetch(`${source}/api/runs/${fidelityTraceId}/export`);
  expect(rejected.status).toBe(413); expect(await rejected.text()).not.toContain(credential);
  expect((await post(destination, "/api/import-run", cached)).status).toBe(400);
  expect((await fetch(`${destination}/api/runs/${fidelityTraceId}/export`)).status).toBe(404);
  record("corrupt-cache-refusal.json", { rawDigestBeforeClear: sha(original), cacheExportStatus: 413, importStatus: 400, newTraceStatus: 404 });
});
