import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { Database } from "bun:sqlite";
import { parseOtlpRequest } from "../src/parse";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureTrace, captureAttributes, captureInput, captureOutput, filterSecret } from "./fixtures/capture-visibility";
import { encodeFidelityRequest } from "./fixtures/otlp-evidence";
import { classificationCases } from "./fixtures/capture-classification-cases";

const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "rp-capture-http-"));
const owned: ChildProcess[] = [], closed = new Map<ChildProcess, Promise<unknown>>();
const logs: string[] = [];
let base: string, daemon: ChildProcess;
const source = captureTrace(1661), binary = captureTrace(1662);
function proof(name: string, value: unknown) {
  if (process.env.F16_EVIDENCE_PATH) { mkdirSync(process.env.F16_EVIDENCE_PATH, { recursive: true }); writeFileSync(path.join(process.env.F16_EVIDENCE_PATH, name), JSON.stringify(value, null, 2) + "\n"); }
}
async function start() {
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RUNPHANTOM_") && !["OPENAI_API_KEY", "ANTHROPIC_API_KEY"].includes(key)));
  const executable = process.env.F16_ARTIFACT_EXECUTABLE;
  daemon = spawn(executable ?? "bun", executable ? ["serve"] : ["src/index.ts", "serve"], {
    cwd: executable ? path.dirname(executable) : path.resolve(import.meta.dir, ".."), stdio: ["ignore", "pipe", "pipe"], env: { ...env,
      HOME: directory, USERPROFILE: directory, RUNPHANTOM_DB_PATH: path.join(directory, "capture.db"), RUNPHANTOM_SECRET_STORE_PATH: path.join(directory, "secrets.json"),
      RUNPHANTOM_PORT: String(port), RUNPHANTOM_BIND_HOST: "127.0.0.1", RUNPHANTOM_CLAUDE_CLI_CHAT: "0", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" } });
  daemon.stdout?.on("data", data => logs.push(String(data))); daemon.stderr?.on("data", data => logs.push(String(data)));
  owned.push(daemon); closed.set(daemon, once(daemon, "close")); base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error("Owned capture daemon exited before health");
    try { const health = await fetch(base + "/health"); if (health.ok && (await health.json()).pid === daemon.pid) return; } catch { /* Await owned health. */ }
    await Bun.sleep(25);
  }
  throw new Error("Owned capture daemon failed to become healthy");
}
async function stop(proc: ChildProcess) {
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
  const timer = setTimeout(() => proc.kill("SIGKILL"), 2500);
  try { await closed.get(proc); } finally { clearTimeout(timer); }
}
beforeAll(start, 15000);
afterAll(async () => {
  await Promise.all(owned.map(stop)); rmSync(directory, { recursive: true, force: true });
  proof("http-cleanup.json", { pids: owned.map(p => ({ pid: p.pid, reaped: p.exitCode !== null || p.signalCode !== null, exit: p.exitCode, signal: p.signalCode })), profileRemoved: !existsSync(directory), secretInLogs: logs.join("").includes(filterSecret) });
});
async function json(route: string) { const response = await fetch(base + route); expect(response.status).toBe(200); return response.json(); }
async function post(route: string, data: unknown) { return fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }); }
const persistedSpanColumns = ["id", "run_id", "parent_span_id", "name", "span_type", "status", "input_payload", "output_payload",
  "start_time_ms", "end_time_ms", "duration_ms", "model", "provider", "input_tokens", "output_tokens", "attributes", "otlp_evidence"] as const;
function assertStoredSource(bytes: string, request: { run: unknown; spans: Record<string, unknown>[]; liveEvents: unknown[] }, quarantineReceipt = false) {
  const stored = JSON.parse(bytes);
  expect(stored.run).toEqual(request.run); expect(stored.liveEvents).toEqual(request.liveEvents); expect(stored.subAgents).toEqual([]);
  expect(stored.spans).toHaveLength(request.spans.length);
  for (const [index, source] of request.spans.entries()) {
    const span = stored.spans[index];
    for (const column of persistedSpanColumns) expect(span[column]).toEqual(column === "otlp_evidence" && quarantineReceipt ? "[UNAVAILABLE]" : source[column]);
    expect(Object.keys(span).sort()).toEqual(persistedSpanColumns.filter(column => Object.hasOwn(source, column)).sort());
    for (const derived of ["normalized", "captureVisibility", "guardEvidence", "guard_decisions"]) expect(Object.hasOwn(span, derived)).toBe(false);
  }
  return stored;
}
test("actual captured hierarchy classification and canonical payloads agree across every public cache route", async () => {
  const cases = [];
  for (const [index, policy] of classificationCases.entries()) {
    const fixture = captureTrace(2100 + index), rs = fixture.body.resourceSpans[0] as any;
    rs.resource = { attributes: captureAttributes(policy.resource ?? {}) }; rs.scopeSpans[0].scope.attributes = captureAttributes(policy.scope ?? {});
    fixture.retrieval.attributes.push(...captureAttributes(policy.span ?? {}));
    expect((await post("/v1/traces", fixture.body)).status).toBe(200);
    const original = await json(`/api/runs/detail/${fixture.id}`); expect(original.spans[0].span_type, policy.name).toBe(policy.kind);
    const parsed = parseOtlpRequest(fixture.body)[0];
    for (const contradictory of [false, true]) {
      const id = (2200 + index * 2 + Number(contradictory)).toString(16).padStart(32, "0");
      const row = { ...original.spans[0], run_id: id, attributes: JSON.stringify(parsed.attributes), otlp_evidence: JSON.stringify(parsed.otlpEvidence),
        ...(contradictory ? { span_type: "RETRIEVAL", normalized: { kind: "retrieval", invented: true } } : {}) };
      const data = { run: { ...original.run, id }, spans: [row], liveEvents: [] }, bytes = JSON.stringify(data);
      expect((await fetch(`${base}/api/saved-runs/cache/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: bytes })).status).toBe(200);
      const database = new Database(path.join(directory, "capture.db"), { readonly: true });
      const stored = database.query("SELECT data FROM saved_run_cache WHERE id=?").get(id) as { data: string }; database.close();
      assertStoredSource(stored.data, data);
      for (const route of [`/api/runs/detail/${id}`, `/api/saved-runs/cache/${id}`, `/api/runs/${id}/export`]) {
        const response = await fetch(base + route); expect(response.status, route).toBe(200); const current = (await response.json()).spans[0];
        expect(JSON.stringify(current), route).not.toContain(filterSecret);
        for (const key of ["id", "run_id", "span_type", "status", "input_payload", "output_payload"] as const) expect(current[key]).toEqual(row[key]);
        // Portable source omits ordinary display DTOs; safe capture operations are rebuilt separately.
        if (!contradictory && route.endsWith("/export") && !["RETRIEVAL", "EMBEDDING"].includes(policy.kind)) expect(current.normalized, route).toBeUndefined();
        else if (!contradictory) expect(current.normalized, route).toEqual(original.spans[0].normalized);
        else if (policy.kind === "RETRIEVAL") expect(current.normalized.kind).toBe("retrieval");
        else { expect(current.normalized).toBeUndefined(); expect(current.captureVisibility?.retrieval).toBeUndefined(); }
      }
    }
    cases.push({ policy: policy.name, expectedKind: policy.kind, actualKind: original.spans[0].span_type, canonicalFieldsPreserved: true, contradictoryRetrievalWithheld: policy.kind !== "RETRIEVAL", privateSourceColumnsPreserved: true, derivedDtosPersisted: false });
  }
  proof("http-classification-policy.json", { ownedPid: daemon.pid, cases, publicRoutesPerCase: 6 });
}, 30000);
for (const [index, level] of ["resource", "scope"].entries()) {
  test(`actual ${level} TOOL source prevents contradictory cached retrieval using unchanged protected request`, async () => {
    const fixture = captureTrace(1910 + index), rs = fixture.body.resourceSpans[0] as any;
    if (level === "resource") rs.resource = { attributes: captureAttributes({ "openinference.span.kind": "TOOL" }) };
    else rs.scopeSpans[0].scope.attributes = captureAttributes({ "openinference.span.kind": "TOOL" });
    expect((await post("/v1/traces", fixture.body)).status).toBe(200);
    const original = await json(`/api/runs/detail/${fixture.id}`); expect(original.spans[0].span_type).toBe("TOOL_CALL");
    const bytes = readFileSync(new URL(`./fixtures/capture-classification-${level}-cache.json`, import.meta.url), "utf8"), data = JSON.parse(bytes), id = data.run.id;
    const parsed = parseOtlpRequest(fixture.body)[0]; expect(data.spans[0].attributes).toBe(JSON.stringify(parsed.attributes)); expect(data.spans[0].otlp_evidence).toBe(JSON.stringify(parsed.otlpEvidence));
    expect((await fetch(`${base}/api/saved-runs/cache/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: bytes })).status).toBe(200);
    const database = new Database(path.join(directory, "capture.db"), { readonly: true });
    const cache = database.query("SELECT data FROM saved_run_cache WHERE id=?").get(id) as { data: string };
    const source = database.query("SELECT span_type,attributes,otlp_evidence FROM spans WHERE run_id=? AND id=?").get(fixture.id, parsed.spanId) as { span_type: string; attributes: string; otlp_evidence: string }; database.close();
    assertStoredSource(cache.data, data); expect(source.span_type).toBe("TOOL_CALL"); expect(source.attributes).toBe(JSON.stringify(parsed.attributes)); expect(source.otlp_evidence).toBe(JSON.stringify(parsed.otlpEvidence));
    const responses = [];
    for (const route of [`/api/runs/detail/${id}`, `/api/saved-runs/cache/${id}`, `/api/runs/${id}/export`]) {
      const response = await fetch(base + route); expect(response.status).toBe(200); const current = (await response.json()).spans[0];
      expect(current.normalized).toBeUndefined(); expect(current.captureVisibility?.retrieval).toBeUndefined();
      for (const key of ["id", "run_id", "span_type", "status", "input_payload", "output_payload"] as const) expect(current[key]).toEqual(data.spans[0][key]);
      responses.push({ route, status: response.status, contradictoryCaptureWithheld: true, originalFieldsPreserved: true });
    }
    const canonical = await json(`/api/runs/detail/${fixture.id}`); expect(canonical.spans[0].normalized).toEqual(original.spans[0].normalized);
    proof(`http-classification-${level}.json`, { ownedPid: daemon.pid, actualIngestKind: source.span_type, unchangedProtectedRequest: true, privateSourceColumnsPreserved: true, derivedDtosPersisted: false, canonicalToolPreserved: true, responses });
  });
}
for (const spanType of [null, "INTERNAL"] as const) {
  test(`actual saved-cache ${spanType} strips untrusted capture and operation DTOs`, async () => {
    const fixture = captureTrace(1810); expect((await post("/v1/traces", fixture.body)).status).toBe(200);
    const original = await json(`/api/runs/detail/${fixture.id}`), id = (spanType === null ? 1811 : 1812).toString(16).padStart(32, "0");
    const row = { ...original.spans[0], run_id: id, span_type: spanType, attributes: "{}", otlp_evidence: null,
      input_payload: '{"db.filter":"literal authoritative body"}', output_payload: "Ordinary output remains literal",
      normalized: { kind: "retrieval", filter: filterSecret }, captureVisibility: { schemaVersion: 1, retrieval: { filter: filterSecret }, stream: { state: "completed" } } };
    const data = { run: { ...original.run, id }, spans: [row], liveEvents: [] };
    expect((await fetch(`${base}/api/saved-runs/cache/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })).status).toBe(200);
    const database = new Database(path.join(directory, "capture.db"), { readonly: true });
    const stored = database.query("SELECT data FROM saved_run_cache WHERE id=?").get(id) as { data: string }; database.close();
    assertStoredSource(stored.data, data); expect(stored.data).not.toContain(filterSecret);
    const responses = [];
    for (const route of [`/api/runs/detail/${id}`, `/api/saved-runs/cache/${id}`, `/api/runs/${id}/export`]) {
      const response = await fetch(base + route), text = await response.text(); expect(response.status).toBe(200); expect(text).not.toContain(filterSecret);
      const projected = JSON.parse(text).spans[0]; expect(projected.captureVisibility).toBeUndefined();
      expect(projected.normalized, route).toEqual(route.endsWith("/export") ? undefined : { kind: "other" });
      for (const key of ["id", "run_id", "span_type", "status", "input_payload", "output_payload"] as const) expect(projected[key]).toEqual(row[key]);
      responses.push({ route, status: response.status, credentialWithheld: !text.includes(filterSecret), sourceFieldsPreserved: true, staleDtosRemoved: true });
    }
    proof(`http-cache-dto-${spanType}.json`, { ownedPid: daemon.pid, spanType, privateSourceColumnsPreserved: true, derivedDtosPersisted: false, forgedCredentialPersisted: stored.data.includes(filterSecret), responses });
  });
}
test("actual saved cache rebuilds canonical operations and lifecycle from valid source rather than serialized DTOs", async () => {
  const fixture = captureTrace(1820), parsed = parseOtlpRequest(fixture.body);
  expect((await post("/v1/traces", fixture.body)).status).toBe(200);
  const original = await json(`/api/runs/detail/${fixture.id}`), id = "0000000000000000000000000000071d";
  const spans = original.spans.map((span: any, index: number) => ({ ...span, run_id: id,
    attributes: JSON.stringify(parsed[index].attributes), otlp_evidence: JSON.stringify(parsed[index].otlpEvidence),
    ...(index < 2 ? { normalized: { kind: index === 0 ? "embedding" : "retrieval", filter: filterSecret } } : {}),
    captureVisibility: { schemaVersion: 1, stream: { state: "completed", chunks: [{ text: filterSecret }] }, retrieval: { filter: filterSecret } } }));
  const data = { run: { ...original.run, id }, spans, liveEvents: [] };
  expect((await fetch(`${base}/api/saved-runs/cache/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })).status).toBe(200);
  const database = new Database(path.join(directory, "capture.db"), { readonly: true });
  const stored = database.query("SELECT data FROM saved_run_cache WHERE id=?").get(id) as { data: string }; database.close(); assertStoredSource(stored.data, data);
  expect(stored.data).toContain(filterSecret); // Valid private source metadata remains available for replay.
  for (const route of [`/api/runs/detail/${id}`, `/api/saved-runs/cache/${id}`, `/api/runs/${id}/export`]) {
    const response = await fetch(base + route); expect(response.status).toBe(200); const current = await response.json(); expect(JSON.stringify(current)).not.toContain(filterSecret);
    expect(current.spans[0].normalized).toMatchObject({ kind: "retrieval", collection: "manuals", resultCount: 0 });
    expect(current.spans[1].normalized).toMatchObject({ kind: "embedding", dimensions: 1536 });
    expect(current.spans[2].captureVisibility.stream).toMatchObject({ state: "completed", chunks: [{ text: "Hello " }, { text: "world" }] });
    expect(current.spans[3].captureVisibility.stream.state).toBe("cancelled");
    if (route.endsWith("/export")) expect(current.spans[2].normalized, route).toBeUndefined();
    else expect(current.spans[2].normalized, route).toEqual(original.spans[2].normalized);
    for (const [index, span] of current.spans.entries()) {
      for (const key of ["id", "run_id", "span_type", "status", "input_payload", "output_payload"] as const) expect(span[key], route).toEqual(spans[index][key]);
    }
    expect(current.spans[2].output_payload).toBe(captureOutput);
  }
  proof("http-cache-dto-source-positive.json", { ownedPid: daemon.pid, privateSourceColumnsPreserved: true, derivedDtosPersisted: false, canonicalOperationsRebuilt: true, streamSourceRosterUsed: true, cancellationPreserved: true, authoritativeLlmNormalizationPreserved: true });
});
for (const variant of ["valid", "escaped-invalid-receipt", "malformed-attributes"] as const) {
  test(`actual saved-cache ${variant} never publishes owned filter credentials`, async () => {
    const fixture = captureTrace(1710), parsed = parseOtlpRequest(fixture.body)[0];
    expect((await post("/v1/traces", fixture.body)).status).toBe(200);
    const original = await json(`/api/runs/detail/${fixture.id}`);
    const id = (1711 + ["valid", "escaped-invalid-receipt", "malformed-attributes"].indexOf(variant)).toString(16).padStart(32, "0");
    const row = { ...original.spans[0], id: parsed.spanId, run_id: id, name: parsed.name, span_type: parsed.spanType,
      input_payload: '{"db.filter":"ordinary authoritative business body"}', output_payload: "Ordinary output remains literal",
      attributes: JSON.stringify(parsed.attributes), otlp_evidence: JSON.stringify(parsed.otlpEvidence), normalized: parsed.normalized, captureVisibility: parsed.captureVisibility };
    if (variant === "escaped-invalid-receipt") {
      row.attributes = "{}";
      row.otlp_evidence = JSON.stringify({ ...parsed.otlpEvidence, schemaVersion: 2, attributes: parsed.otlpEvidence!.attributes.filter(item => item.key === "db.filter") }).replaceAll("db.filter", "db.\\u0066ilter");
    } else if (variant === "malformed-attributes") { row.otlp_evidence = null as any; row.attributes = row.attributes.slice(0, -1); }
    const data = { run: { ...original.run, id }, spans: [row], liveEvents: [] };
    expect((await fetch(`${base}/api/saved-runs/cache/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })).status).toBe(200);
    const database = new Database(path.join(directory, "capture.db"), { readonly: true });
    const stored = database.query("SELECT data FROM saved_run_cache WHERE id=?").get(id) as { data: string }; database.close();
    const quarantineReceipt = variant === "escaped-invalid-receipt";
    assertStoredSource(stored.data, data, quarantineReceipt);
    if (quarantineReceipt) expect(stored.data).not.toContain(filterSecret);
    else expect(stored.data).toContain(filterSecret);
    const responses = [];
    for (const route of [`/api/runs/detail/${id}`, `/api/saved-runs/cache/${id}`, `/api/runs/${id}/export`]) {
      const response = await fetch(base + route), text = await response.text();
      const refusedExport = quarantineReceipt && route.endsWith("/export");
      expect(response.status, route).toBe(refusedExport ? 413 : 200);
      expect(text).not.toContain(filterSecret);
      if (refusedExport) {
        expect(JSON.parse(text)).toEqual({ error: "spans[0].otlp_evidence is invalid or contains credentials" });
        expect(response.headers.get("content-disposition")).toBeNull();
      } else {
        const projected = JSON.parse(text).spans[0];
        for (const key of ["id", "run_id", "span_type", "status", "input_payload", "output_payload"] as const) expect(projected[key], route).toEqual(row[key]);
      }
      responses.push({ route, status: response.status, credentialWithheld: !text.includes(filterSecret) });
    }
    if (quarantineReceipt) {
      const imported = await post("/api/import-run", { ...JSON.parse(stored.data), format: "runphantom-trace/v2", annotations: [] });
      expect(imported.status).toBe(400);
      expect(await imported.json()).toEqual({ error: "import rejected: spans[0].otlp_evidence is invalid or contains credentials" });
    }
    const check = new Database(path.join(directory, "capture.db"), { readonly: true });
    const after = check.query("SELECT data FROM saved_run_cache WHERE id=?").get(id) as { data: string }; check.close();
    expect(after.data).toBe(stored.data);
    proof(`http-cache-privacy-${variant}.json`, { variant, ownedPid: daemon.pid, canonicalPayloadsPreserved: true, attributeBytesPreserved: true, sourceReceiptPreserved: !quarantineReceipt, derivedDtosPersisted: false, invalidReceiptQuarantined: quarantineReceipt, responses });
  });
}
async function verify(id: string) {
  const detail = await json(`/api/runs/detail/${id}`);
  expect(detail.spans).toHaveLength(4);
  expect(detail.spans[0].normalized).toMatchObject({ kind: "retrieval", collection: "manuals", topK: 3, resultCount: 0 });
  expect(detail.spans[1].normalized).toMatchObject({ kind: "embedding", dimensions: 1536 });
  const llm = detail.spans[2]; expect(llm.captureVisibility.stream).toMatchObject({ state: "completed", coverage: "complete", chunks: [{ text: "Hello " }, { text: "world" }] });
  expect(llm.captureVisibility.source).toMatchObject({ traceId: id, spanId: llm.id });
  expect(llm.captureVisibility.usage).toMatchObject({ cacheReadInputTokens: 0, reasoningOutputTokens: 2 });
  expect(llm.normalized.userMessage).toBe(captureInput); expect(llm.output_payload).toBe(captureOutput); expect(llm.input_tokens).toBe(7); expect(llm.output_tokens).toBe(3);
  expect(detail.spans[3].captureVisibility.stream).toMatchObject({ state: "cancelled", chunks: [{ text: "Partial evidence" }] });
  expect(JSON.stringify(detail)).not.toContain(filterSecret);
  const exported = await json(`/api/runs/${id}/export`); expect(JSON.stringify(exported)).not.toContain(filterSecret);
  const meta = await json(`/api/spans/${llm.id}?run_id=${id}`); expect(meta.captureVisibility.stream.state).toBe("completed");
  const query = await post("/api/traces/query", { sql: `SELECT id,span_type,attributes FROM spans WHERE run_id='${id}' ORDER BY start_time_ms` }); expect(query.status).toBe(200);
  const raw = await query.json(); expect(raw.rows).toHaveLength(4); expect(raw.rows[0].attributes).toContain(filterSecret);
  proof(`http-${id}.json`, { process: { pid: daemon.pid, artifact: Boolean(process.env.F16_ARTIFACT_EXECUTABLE) }, detail, exported, meta, sqlRowCount: raw.rows.length, rawFilterRetained: raw.rows[0].attributes.includes(filterSecret) });
  return { detail, exported };
}
test("actual OTLP JSON/protobuf, idempotent identity, public privacy and separate two-boot persistence", async () => {
  expect((await post("/v1/traces", source.body)).status).toBe(200);
  const response = await fetch(base + "/v1/traces", { method: "POST", headers: { "Content-Type": "application/x-protobuf" }, body: encodeFidelityRequest(binary.body as any) }); expect(response.status).toBe(200);
  expect((await post("/v1/traces", source.body)).status).toBe(200);
  const first = await verify(source.id); await verify(binary.id);
  const list = await json("/api/runs"); expect(JSON.stringify(list)).toContain(source.id);
  const firstPid = daemon.pid; await stop(daemon); await start(); expect(daemon.pid).not.toBe(firstPid);
  const second = await verify(source.id); expect(second.detail.spans).toEqual(first.detail.spans);
  expect((await post("/api/import-run", first.exported)).status).toBe(200);
  const portable = await json(`/api/runs/detail/${source.id}`); expect(portable.spans[2].captureVisibility.stream.state).toBe("completed");
  proof("http-two-boot.json", { firstPid, secondPid: daemon.pid, independentProcess: firstPid !== daemon.pid, equalPersistedViews: true, portableReinterpreted: true });
}, 30000);

test("actual error, metadata-only and missing-roster HTTP evidence never becomes complete", async () => {
  for (const [offset, state] of [[1, "error"], [2, "unknown"], [3, "incomplete"]] as const) {
    const capture = captureTrace(1670 + offset);
    if (state === "unknown") capture.llm.events = [];
    else if (state === "incomplete") capture.llm.events.pop();
    else capture.llm.events[capture.llm.events.length - 1].name = "runphantom.stream.error";
    expect((await post("/v1/traces", capture.body)).status).toBe(200);
    const detail = await json(`/api/runs/detail/${capture.id}`);
    expect(detail.spans[2].captureVisibility.stream.state).toBe(state);
    expect(detail.spans[2].output_payload).toBe(captureOutput);
    proof(`http-negative-${state}.json`, { id: capture.id, actual: detail.spans[2].captureVisibility.stream });
  }
}, 10000);

test("local-only application example exports finite retrieval and stream evidence", async () => {
  const child = spawn("bun", ["examples/capture-visibility/capture.ts", base], { cwd: path.resolve(import.meta.dir, ".."), stdio: ["ignore", "pipe", "pipe"] });
  let output = "", error = ""; child.stdout?.on("data", data => output += String(data)); child.stderr?.on("data", data => error += String(data));
  const [code] = await once(child, "close"); expect(code).toBe(0); expect(error).toBe("");
  const id = new URL(output.trim()).pathname.split("/").pop()!;
  const detail = await json(`/api/runs/detail/${id}`);
  expect(detail.spans[0].normalized).toMatchObject({ kind: "retrieval", resultCount: 0 });
  expect(detail.spans[2].captureVisibility.stream.state).toBe("completed");
  proof("http-local-example.json", { id, exported: true, kinds: detail.spans.map((span: any) => span.span_type), streamState: detail.spans[2].captureVisibility.stream.state });
}, 10000);
