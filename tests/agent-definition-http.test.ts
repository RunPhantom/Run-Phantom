import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { agentDefinition, definitionTrace, definitionInput, definitionOutput, definitionKey } from "./fixtures/agent-definitions";
import type { DatasetRevision, Experiment } from "../src/evaluations/protocol";
import { duplicateDefinitionReceipt } from "./fixtures/agent-definition-receipts";

const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "rp-definition-http-"));
const owned: ChildProcess[] = [], closed = new Map<ChildProcess, Promise<unknown>>();
let base: string, daemon: ChildProcess;
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function proof(name: string, value: unknown) {
  if (process.env.F17_EVIDENCE_PATH) writeFileSync(path.join(process.env.F17_EVIDENCE_PATH, name), JSON.stringify(value, null, 2) + "\n");
}
async function launch(profile: string) {
  mkdirSync(profile, { recursive: true });
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RUNPHANTOM_") && !["OPENAI_API_KEY", "ANTHROPIC_API_KEY"].includes(key)));
  const proc = spawn("bun", ["src/index.ts", "serve"], { cwd: path.resolve(import.meta.dir, ".."), stdio: "ignore", env: { ...inherited,
    HOME: profile, USERPROFILE: profile, RUNPHANTOM_DB_PATH: path.join(profile, "capture.db"), RUNPHANTOM_SECRET_STORE_PATH: path.join(profile, "secrets.json"),
    RUNPHANTOM_PORT: String(port), RUNPHANTOM_BIND_HOST: "127.0.0.1", RUNPHANTOM_CLAUDE_CLI_CHAT: "0", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" } });
  owned.push(proc); closed.set(proc, once(proc, "close")); const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error("Owned definition daemon exited before health");
    try { const health = await fetch(`${url}/health`); if (health.ok && (await health.json()).pid === proc.pid) return { proc, url }; } catch { /* Wait for owned listener. */ }
    await Bun.sleep(25);
  }
  throw new Error("Owned definition daemon failed to become healthy");
}
async function start() { const launched = await launch(directory); daemon = launched.proc; base = launched.url; }
async function stop(proc: ChildProcess) {
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
  const deadline = setTimeout(() => proc.kill("SIGKILL"), 2500);
  try { await closed.get(proc); } finally { clearTimeout(deadline); }
}
beforeAll(start, 10_000);
afterAll(async () => {
  await Promise.all(owned.map(stop));
  rmSync(directory, { recursive: true, force: true });
  proof("http-owned-cleanup.json", { source: "Bun source daemon, no providers", pids: owned.map(proc => ({ pid: proc.pid, exitCode: proc.exitCode, signal: proc.signalCode, reaped: proc.exitCode !== null || proc.signalCode !== null })), removedProfile: !existsSync(directory) });
});
async function request(route: string, value?: unknown, method = value === undefined ? "GET" : "POST") {
  return fetch(base + route, { method, headers: { "Content-Type": "application/json" }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
}
async function json(route: string) { const response = await request(route); expect(response.status).toBe(200); return response.json(); }
async function ingest(capture: ReturnType<typeof definitionTrace>) { expect((await request("/v1/traces", capture.body)).status).toBe(200); }

test("actual HTTP definition projection withholds private flat/typed capture without changing business evidence", async () => {
  const capture = definitionTrace(17); await ingest(capture);
  const exported = await json(`/api/runs/${capture.id}/export`), detail = await json(`/api/runs/detail/${capture.id}`), span = await json(`/api/spans/${capture.spanId}?run_id=${capture.id}`);
  const typed = JSON.parse(exported.spans[0].otlp_evidence), flat = JSON.parse(exported.spans[0].attributes);
  const receipts = [exported, detail, span].map(value => ({ sha256: sha(value), privatePrompt: JSON.stringify(value).includes("Private captured instructions"), privateTools: JSON.stringify(value).includes("Private lookup description") }));
  proof("http-public-definition-boundary.json", { source: "actual OTLP/HTTP", runId: capture.id, receipts, inputOutputEqual: exported.spans[0].input_payload === definitionInput && exported.spans[0].output_payload === definitionOutput });
  expect(exported.spans[0].input_payload).toBe(definitionInput); expect(exported.spans[0].output_payload).toBe(definitionOutput);
  expect(detail.spans[0].input_payload).toBe(definitionInput); expect(detail.spans[0].output_payload).toBe(definitionOutput);
  expect(span.input_preview).toBe(definitionInput); expect(span.output_preview).toBe(definitionOutput);
  expect(receipts.every(receipt => !receipt.privatePrompt && !receipt.privateTools)).toBe(true);
  expect(flat[definitionKey]).toBe("[REDACTED]"); expect(flat["ordinary.span"]).toBe("span unchanged");
  expect(typed.attributes.find((entry: any) => entry.key === definitionKey).value).toEqual({ stringValue: "[REDACTED]" });
  expect(typed.capture.redactedValues).toBe(1); expect(typed.resource.attributes[0].value).toEqual({ stringValue: "resource unchanged" });
  expect(typed.scope.attributes[0].value).toEqual({ stringValue: "scope unchanged" }); expect(typed.events[0].attributes[0].value).toEqual({ stringValue: "event unchanged" }); expect(typed.links[0].attributes[0].value).toEqual({ stringValue: "link unchanged" });
  const originalDb = new Database(path.join(directory, "capture.db"), { readonly: true });
  try {
    const stored = originalDb.query("SELECT attributes,otlp_evidence FROM spans WHERE run_id=?").get(capture.id) as { attributes: string; otlp_evidence: string };
    expect(stored.attributes).toContain("Private captured instructions"); expect(stored.otlp_evidence).toContain("Private lookup description");
  } finally { originalDb.close(); }
  const compare = await json(`/api/runs/compare?baseline=${capture.id}&candidate=${capture.id}`); expect(compare.agentDefinitions.baseline.records[0].complete).toBe(true);
  const transferred = structuredClone(exported); transferred.run.id = "imported-public-definition"; for (const row of transferred.spans) row.run_id = transferred.run.id;
  expect((await request("/api/import-run", transferred)).status).toBe(200);
  const copy = await json(`/api/runs/compare?baseline=${capture.id}&candidate=${transferred.run.id}`);
  expect(copy.agentDefinitions.candidate.records[0].complete).toBe(false); expect(copy.agentDefinitions.candidate.records[0].sha256).toBeNull();
  expect(copy.agentDefinitions.candidate.records[0].reasons).toContain("capture_redacted");
});

test.each(["detail", "span", "export", "search"])("actual nested typed definition is private through public %s while original business values stay exact", async route => {
  const capture = definitionTrace(91), marker = "F17 private nested definition synthetic prompt 7c4d";
  const business = JSON.stringify({ [definitionKey]: "Ordinary typed string remains exact" });
  const source = capture.body.resourceSpans[0].scopeSpans[0].spans[0];
  source.attributes.push({ key: "ordinary.envelope", value: { arrayValue: { values: [
    { stringValue: business }, { kvlistValue: { values: [
      { key: "ordinary.message", value: { stringValue: "Business metadata unchanged" } },
      { key: definitionKey, value: { stringValue: JSON.stringify(agentDefinition(marker)) } },
    ] } },
  ] } } } as any);
  await ingest(capture);
  const exported = await json(`/api/runs/${capture.id}/export`), typed = JSON.parse(exported.spans[0].otlp_evidence);
  const flat = JSON.parse(exported.spans[0].attributes), envelope = typed.attributes.find((a: any) => a.key === "ordinary.envelope").value.arrayValue.values;
  const value = route === "detail" ? await json(`/api/runs/detail/${capture.id}`)
    : route === "span" ? await json(`/api/spans/${capture.spanId}?run_id=${capture.id}`)
      : route === "export" ? exported : await json(`/api/runs/${capture.id}/search?scope=span_attributes&pattern=${encodeURIComponent(marker)}`);
  const observed = { source: "actual OTLP JSON ingress and public HTTP", route, containsPrivate: JSON.stringify(value).includes(marker), typedNestedWithheld: envelope[1].kvlistValue.values[1].value.stringValue === "[REDACTED]", inputOutputEqual: exported.spans[0].input_payload === definitionInput && exported.spans[0].output_payload === definitionOutput };
  proof(`http-nested-${route}.json`, observed);
  expect(observed.typedNestedWithheld).toBe(true); expect(observed.inputOutputEqual).toBe(true);
  expect(observed.containsPrivate).toBe(false);
  expect(JSON.parse(flat["ordinary.envelope"])).toEqual([business, { "ordinary.message": "Business metadata unchanged", [definitionKey]: "[REDACTED]" }]);
  expect(envelope[0]).toEqual({ stringValue: business });
  const privateRead = await request("/api/traces/query", { sql: `SELECT attributes,otlp_evidence FROM spans WHERE run_id='${capture.id}'` });
  expect(privateRead.status).toBe(200); expect(JSON.stringify(await privateRead.json())).toContain(marker);
  const comparison = await json(`/api/runs/compare?baseline=${capture.id}&candidate=${capture.id}`);
  expect(comparison.counts).toMatchObject({ unchanged: 1, changed: 0 });
  expect(comparison.agentDefinitions.baseline.records[0].complete).toBe(true);
  if (route === "export") {
    const raw = await request("/api/traces/query", { sql: `SELECT rowid AS identity,id,attributes,otlp_evidence FROM spans WHERE run_id='${capture.id}'` });
    expect(raw.status).toBe(200); const original = (await raw.json()).rows[0];
    const privateFile = structuredClone(exported); privateFile.spans[0].attributes = original.attributes; privateFile.spans[0].otlp_evidence = original.otlp_evidence;
    expect((await request("/api/import-run", privateFile)).status).toBe(200);
    const reimported = await request("/api/traces/query", { sql: `SELECT rowid AS identity,attributes,otlp_evidence FROM spans WHERE run_id='${capture.id}'` });
    expect(reimported.status).toBe(200); expect((await reimported.json()).rows[0]).toEqual({ identity: original.identity, attributes: original.attributes, otlp_evidence: original.otlp_evidence });
    expect((await json(`/api/runs/compare?baseline=${capture.id}&candidate=${capture.id}`)).agentDefinitions).toEqual(comparison.agentDefinitions);
    const destination = await launch(path.join(directory, "nested-public-destination"));
    try {
      const imported = await fetch(destination.url + "/api/import-run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(exported) }); expect(imported.status).toBe(200);
      const response = await fetch(`${destination.url}/api/runs/detail/${capture.id}`); expect(response.status).toBe(200); const observed = await response.json();
      expect(JSON.stringify(observed)).not.toContain(marker); expect(observed.spans[0].output_payload).toBe(definitionOutput);
      expect(JSON.parse(JSON.parse(observed.spans[0].attributes)["ordinary.envelope"])).toEqual([business, { "ordinary.message": "Business metadata unchanged", [definitionKey]: "[REDACTED]" }]);
      const importedComparison = await fetch(`${destination.url}/api/runs/compare?baseline=${capture.id}&candidate=${capture.id}`); expect(importedComparison.status).toBe(200);
      expect((await importedComparison.json()).agentDefinitions.baseline.records[0]).toMatchObject({ complete: false, sha256: null });
      proof("http-nested-private-and-public-import.json", { privateRowIdentityPreserved: true, privateDefinitionHashesUnchanged: true, publicFreshProfileWithholdsNested: true, publicReimportComplete: false, originalOutputEqual: true, sourcePid: daemon.pid, destinationPid: destination.proc.pid });
    } finally { await stop(destination.proc); }
  }
});

test("actual SDK-reported attribute loss withholds an uncertain flattened carrier without changing output", async () => {
  const capture = definitionTrace(96), marker = "Private nested lossy capture";
  const span = capture.body.resourceSpans[0].scopeSpans[0].spans[0]; span.droppedAttributesCount = 1;
  span.attributes.push({ key: "ordinary.envelope", value: { kvlistValue: { values: [{ key: definitionKey, value: { stringValue: marker } }] } } } as any);
  await ingest(capture); const exported = await json(`/api/runs/${capture.id}/export`);
  expect(JSON.parse(exported.spans[0].attributes)["ordinary.envelope"]).toBe("[UNAVAILABLE]"); expect(JSON.stringify(exported)).not.toContain(marker);
  expect(exported.spans[0].output_payload).toBe(definitionOutput);
  expect((await json(`/api/runs/${capture.id}/search?scope=span_attributes&pattern=${encodeURIComponent(marker)}`)).matches).toEqual([]);
  const ordinary = await json(`/api/runs/${capture.id}/search?scope=span_attributes&pattern=${encodeURIComponent("span unchanged")}`); expect(ordinary.matches).toHaveLength(1);
  expect((await json(`/api/runs/compare?baseline=${capture.id}&candidate=${capture.id}`)).agentDefinitions.baseline.records[0].complete).toBe(false);
});

test("actual accepted OTLP population over the selected search row cap returns explicit HTTP 413", async () => {
  const capture = definitionTrace(97), original = capture.body.resourceSpans[0].scopeSpans[0].spans[0];
  capture.body.resourceSpans[0].scopeSpans[0].spans = Array.from({ length: 2001 }, (_, n) => ({ ...original, spanId: (n + 1).toString(16).padStart(16, "0"),
    attributes: [{ key: "runphantom.input", value: { stringValue: definitionInput } }], events: [], links: [] }));
  await ingest(capture);
  const searched = await request(`/api/runs/${capture.id}/search?scope=span_input&pattern=${encodeURIComponent(definitionInput)}`);
  expect(searched.status).toBe(413); expect(await searched.json()).toEqual({ error: "Selected spans exceed search evidence limits (2,000 rows and 16 MiB acquired text)." });
  proof("http-search-row-refusal.json", { actualAcceptedOtlpSpans: 2001, selectedScope: "span_input", status: searched.status, partialResultPublished: false });
});

test("actual corrected root and process reopen update live definition but cannot rewrite frozen JSON/JUnit identity", async () => {
  const baseline = definitionTrace(18), candidate = definitionTrace(19, agentDefinition("Changed captured instructions", .123456790)); await ingest(baseline); await ingest(candidate);
  const comparison = await json(`/api/runs/compare?baseline=${baseline.id}&candidate=${candidate.id}`);
  const firstHash = comparison.agentDefinitions.candidate.records[0].sha256;
  expect(firstHash).toMatch(/^[a-f0-9]{64}$/); expect(firstHash).not.toBe(comparison.agentDefinitions.baseline.records[0].sha256);
  expect(comparison.counts).toMatchObject({ paired: 1, changed: 0, unchanged: 1 });
  const created = await request("/api/evaluations/datasets", { name: "Captured definition fixture" }); expect(created.status).toBe(201); const initial = await created.json() as DatasetRevision;
  const updated = await request(`/api/evaluations/datasets/${initial.datasetId}`, { expectedVersion: 1, cases: [{ name: "Unchanged captured output", sourceRunId: baseline.id, rules: [{ kind: "output", operation: "equals", value: definitionOutput }] }] }, "PUT"); expect(updated.status).toBe(201); const revision = await updated.json() as DatasetRevision;
  const started = await request("/api/evaluations/experiments", { datasetId: revision.datasetId, version: revision.version, name: "Frozen captured definition", assignments: [{ caseId: revision.cases[0].id, runId: candidate.id }] }); expect(started.status).toBe(202); const initialJob = await started.json() as Experiment;
  let frozen: Experiment | undefined;
  for (let attempt = 0; attempt < 200; attempt++) { const current = await json(`/api/evaluations/experiments/${initialJob.id}`) as Experiment; if (current.status === "completed") { frozen = current; break; } await Bun.sleep(25); }
  expect(frozen?.verdict).toBe("pass"); expect(frozen?.results[0].snapshot.agentDefinitions?.records[0].sha256).toBe(firstHash);
  const reportBefore = await json(`/api/evaluations/experiments/${initialJob.id}/report`), junitBefore = await (await request(`/api/evaluations/experiments/${initialJob.id}/report?format=junit`)).text();
  expect(junitBefore).toContain(firstHash); expect(JSON.stringify(reportBefore)).not.toContain("Changed captured instructions");
  const corrected = definitionTrace(19, agentDefinition("Late authoritative correction", .123456791)); await ingest(corrected);
  const live = await json(`/api/runs/compare?baseline=${baseline.id}&candidate=${candidate.id}`);
  expect(live.agentDefinitions.candidate.records[0].sha256).not.toBe(firstHash); expect(live.counts).toEqual(comparison.counts); expect((await json(`/api/runs/detail/${candidate.id}`)).spans).toHaveLength(1);
  const pidBefore = daemon.pid; await stop(daemon); await start(); expect(daemon.pid).not.toBe(pidBefore);
  expect(await json(`/api/evaluations/experiments/${initialJob.id}/report`)).toEqual(reportBefore); expect(await (await request(`/api/evaluations/experiments/${initialJob.id}/report?format=junit`)).text()).toBe(junitBefore);
  const reopened = await json(`/api/runs/detail/${candidate.id}`); expect(reopened.spans[0].input_payload).toBe(definitionInput); expect(reopened.spans[0].output_payload).toBe(definitionOutput);
  proof("http-live-vs-frozen.json", { source: "actual OTLP/dataset/code evaluator/reopen", runId: candidate.id, oldHash: firstHash, liveHash: live.agentDefinitions.candidate.records[0].sha256, frozenReportDigest: sha(reportBefore), sourcePids: [pidBefore, daemon.pid], outputUnchanged: true, spans: reopened.spans.length });
}, 15_000);

test("actual known-secret capture cannot expose raw credentials or mint prompt/version hashes through public APIs", async () => {
  const secret = `sk-proj-${"x".repeat(48)}`, capture = definitionTrace(20, agentDefinition(`Captured credential ${secret}`)); await ingest(capture);
  const compare = await json(`/api/runs/compare?baseline=${capture.id}&candidate=${capture.id}`), record = compare.agentDefinitions.baseline.records[0];
  expect(record.complete).toBe(false); expect(record.sha256).toBeNull(); expect(record.components.prompt.sha256).toBeNull(); expect(record.reasons).toContain("capture_redacted");
  for (const route of [`/api/runs/${capture.id}/export`, `/api/runs/detail/${capture.id}`, `/api/spans/${capture.spanId}?run_id=${capture.id}`]) {
    const response = await json(route); expect(JSON.stringify(response)).not.toContain(secret);
  }
});

test("default attribute search withholds definition text while explicit guarded local SQL retains private diagnostic access", async () => {
  const capture = definitionTrace(21); await ingest(capture);
  const search = await json(`/api/runs/${capture.id}/search?scope=span_attributes&pattern=${encodeURIComponent("Private captured instructions")}`);
  proof("http-search-boundary.json", { source: "actual OTLP/HTTP", matches: search.matches.length, containsPrivate: JSON.stringify(search).includes("Private captured instructions") });
  expect(search.matches).toEqual([]);
  const ordinary = await json(`/api/runs/${capture.id}/search?scope=span_attributes&pattern=${encodeURIComponent("span unchanged")}`);
  expect(ordinary.matches).toHaveLength(1); expect(ordinary.matches[0].snippet).toContain("span unchanged");
  expect(JSON.stringify(ordinary)).not.toContain("Private lookup description");
  const sql = { sql: `SELECT attributes FROM spans WHERE run_id='${capture.id}'` };
  const raw = await request("/api/traces/query", sql); expect(raw.status).toBe(200); expect((await raw.json()).rows[0].attributes).toContain("Private captured instructions");
  for (const headers of [{ Origin: "https://untrusted.example" }, { Host: "untrusted.example" }]) {
    const refused = await fetch(base + "/api/traces/query", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(sql) });
    expect(refused.status).toBe(403); expect(await refused.json()).toEqual({ error: "forbidden" });
  }
});

test("saved-cache detail and export withhold only the new definition while retaining existing large attributes exactly", async () => {
  const capture = definitionTrace(22), originalText = "x".repeat(3000);
  capture.body.resourceSpans[0].scopeSpans[0].spans[0].attributes.push({ key: "ordinary.long", value: { stringValue: originalText } }); await ingest(capture);
  const detail = await json(`/api/runs/detail/${capture.id}`), raw = await request("/api/traces/query", { sql: `SELECT attributes,otlp_evidence FROM spans WHERE run_id='${capture.id}'` }); expect(raw.status).toBe(200);
  const privateRow = (await raw.json()).rows[0];
  const cached = { ...detail, spans: [{ ...detail.spans[0], attributes: privateRow.attributes, otlp_evidence: privateRow.otlp_evidence }] };
  expect((await request(`/api/saved-runs/cache/${capture.id}`, cached, "PUT")).status).toBe(200); expect((await request("/api/clear", {})).status).toBe(200);
  const reopened = await json(`/api/runs/detail/${capture.id}`), exported = await json(`/api/runs/${capture.id}/export`);
  proof("http-cache-projection.json", { source: "actual OTLP/private diagnostic/cache/clear/detail/export", detailLength: JSON.parse(reopened.spans[0].attributes)["ordinary.long"].length, expectedLength: originalText.length, inputEqual: reopened.spans[0].input_payload === definitionInput, outputEqual: reopened.spans[0].output_payload === definitionOutput, leakedDefinition: JSON.stringify(reopened).includes("Private lookup description"), publicFileDigest: sha(exported) });
  expect(JSON.parse(reopened.spans[0].attributes)["ordinary.long"]).toBe(originalText); expect(JSON.parse(exported.spans[0].attributes)["ordinary.long"]).toBe(originalText);
  expect(reopened.spans[0].input_payload).toBe(definitionInput); expect(reopened.spans[0].output_payload).toBe(definitionOutput);
  expect(JSON.stringify(reopened)).not.toContain("Private lookup description"); expect(JSON.stringify(exported)).not.toContain("Private captured instructions");
  expect(exported.exportSource).toBe("saved-cache");
});

test("reimporting identical private captured evidence remains idempotent despite its public withheld projection", async () => {
  const capture = definitionTrace(23); await ingest(capture); await ingest(definitionTrace(24));
  const portable = await json(`/api/runs/${capture.id}/export`);
  const original = await request("/api/traces/query", { sql: `SELECT rowid AS identity,attributes,otlp_evidence FROM spans WHERE run_id='${capture.id}'` }); expect(original.status).toBe(200); const row = (await original.json()).rows[0];
  portable.spans[0].attributes = row.attributes; portable.spans[0].otlp_evidence = row.otlp_evidence;
  expect((await request("/api/import-run", portable)).status).toBe(200);
  const after = await request("/api/traces/query", { sql: `SELECT rowid AS identity FROM spans WHERE run_id='${capture.id}'` }); expect(after.status).toBe(200); const identity = (await after.json()).rows[0].identity;
  proof("http-private-import-idempotence.json", { source: "actual OTLP/guarded diagnostic/reimport", originalRowIdentity: row.identity, afterRowIdentity: identity, idempotent: identity === row.identity });
  expect(identity).toBe(row.identity); expect((await json(`/api/runs/detail/${capture.id}`)).spans[0].output_payload).toBe(definitionOutput);
});

test("public withheld definition transfer into a fresh independent profile cannot recreate private configuration identity", async () => {
  const capture = definitionTrace(25); await ingest(capture);
  const original = await json(`/api/runs/compare?baseline=${capture.id}&candidate=${capture.id}`);
  expect(original.agentDefinitions.baseline.records[0].complete).toBe(true);
  const portable = await json(`/api/runs/${capture.id}/export`);
  const destination = await launch(path.join(directory, "fresh-destination"));
  try {
    const imported = await fetch(destination.url + "/api/import-run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(portable) }); expect(imported.status).toBe(200);
    const compared = await fetch(`${destination.url}/api/runs/compare?baseline=${capture.id}&candidate=${capture.id}`); expect(compared.status).toBe(200);
    const projected = (await compared.json()).agentDefinitions.baseline.records[0];
    expect(projected.complete).toBe(false); expect(projected.sha256).toBeNull(); expect(projected.components.prompt.sha256).toBeNull(); expect(projected.reasons).toContain("capture_redacted");
    const detail = await fetch(`${destination.url}/api/runs/detail/${capture.id}`); expect(detail.status).toBe(200); const observed = await detail.json();
    expect(observed.spans[0].input_payload).toBe(definitionInput); expect(observed.spans[0].output_payload).toBe(definitionOutput);
    expect(JSON.stringify(observed)).not.toContain("Private captured instructions"); expect(JSON.stringify(observed)).not.toContain("Private lookup description");
    const stored = await fetch(destination.url + "/api/traces/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql: `SELECT attributes,otlp_evidence FROM spans WHERE run_id='${capture.id}'` }) }); expect(stored.status).toBe(200);
    const importedPrivate = (await stored.json()).rows[0]; expect(JSON.parse(importedPrivate.attributes)[definitionKey]).toBe("[REDACTED]"); expect(JSON.parse(importedPrivate.otlp_evidence).capture.redactedValues).toBe(1);
    expect(JSON.stringify(importedPrivate)).not.toContain("Private captured instructions");
    proof("http-fresh-profile-portability.json", { source: "actual source OTLP/export plus independent empty-profile daemon/import/detail/compare", sourcePid: daemon.pid, destinationPid: destination.proc.pid, distinctPid: daemon.pid !== destination.proc.pid, publicFileDigest: sha(portable), importedStoredDigest: sha(importedPrivate), originalComplete: true, importedComplete: projected.complete, importedHash: projected.sha256, inputOutputEqual: true });
  } finally { await stop(destination.proc); }
});


test("actual escaped portable composite is unavailable across all public routes and preserves private row bytes", async () => {
  const capture = definitionTrace(99), marker = "F17 escaped portable private instruction";
  const span = capture.body.resourceSpans[0].scopeSpans[0].spans[0]; span.attributes = span.attributes.filter(entry => entry.key !== definitionKey);
  span.attributes.push({ key: "ordinary.envelope", value: { kvlistValue: { values: [
    { key: "business", value: { stringValue: "Safe unchanged carrier sibling" } }, { key: definitionKey, value: { stringValue: marker } },
  ] } } } as any);
  await ingest(capture); const portable = await json(`/api/runs/${capture.id}/export`);
  const raw = await request("/api/traces/query", { sql: `SELECT attributes,otlp_evidence FROM spans WHERE run_id='${capture.id}'` }); expect(raw.status).toBe(200);
  const source = (await raw.json()).rows[0], attributes = JSON.parse(source.attributes);
  attributes["ordinary.envelope"] = attributes["ordinary.envelope"].replace(definitionKey, "\\u0072\\u0075nphantom.agent.definition");
  expect(JSON.parse(attributes["ordinary.envelope"])[definitionKey]).toBe(marker);
  portable.run.id = "f17-escaped-portable"; for (const row of portable.spans) { row.run_id = portable.run.id; row.attributes = JSON.stringify(attributes); row.otlp_evidence = source.otlp_evidence; }
  expect((await request("/api/import-run", portable)).status).toBe(200);
  const sql = `SELECT rowid AS identity,attributes,otlp_evidence FROM spans WHERE run_id='${portable.run.id}'`;
  const before = await request("/api/traces/query", { sql }); expect(before.status).toBe(200); const original = (await before.json()).rows[0];
  const observed = [];
  for (const route of [`/api/runs/detail/${portable.run.id}`, `/api/spans/${capture.spanId}?run_id=${portable.run.id}`, `/api/runs/${portable.run.id}/export`, `/api/runs/${portable.run.id}/search?scope=span_attributes&pattern=${encodeURIComponent(marker)}`]) {
    const response = await request(route), body = await response.json(); observed.push({ route, status: response.status, containsPrivate: JSON.stringify(body).includes(marker) });
    if (Array.isArray(body.spans)) { expect(JSON.parse(body.spans[0].attributes)["ordinary.envelope"]).toBe("[UNAVAILABLE]"); expect(body.spans[0].input_payload).toBe(definitionInput); expect(body.spans[0].output_payload).toBe(definitionOutput); }
  }
  proof("http-escaped-portable-boundary.json", { source: "Actual JSON OTLP, admitted v2 portable import, public HTTP and privileged private SQL", observed });
  expect(observed.every(value => value.status === 200 && !value.containsPrivate)).toBe(true);
  expect((await json(`/api/runs/${portable.run.id}/search?scope=span_attributes&pattern=${encodeURIComponent("span unchanged")}`)).matches).toHaveLength(1);
  expect((await request("/api/import-run", portable)).status).toBe(200);
  const after = await request("/api/traces/query", { sql }); expect(after.status).toBe(200); expect((await after.json()).rows[0]).toEqual(original);
  expect(original.attributes).toContain(marker); expect(original.otlp_evidence).toBe(source.otlp_evidence);
});

test.each(["span", "resource", "scope", "event", "link", "capture", "value"] as const)("actual admitted %s lexical receipt ambiguity refuses public detail/export and preserves private row identity", async source => {
  const index = ["span", "resource", "scope", "event", "link", "capture", "value"].indexOf(source);
  const capture = definitionTrace(9920 + index), marker = `F17 private ambiguous ${source} receipt instruction`;
  const span = capture.body.resourceSpans[0].scopeSpans[0].spans[0]; span.attributes = span.attributes.filter(entry => entry.key !== definitionKey);
  await ingest(capture); const portable = await json(`/api/runs/${capture.id}/export`);
  portable.run.id = `f17-duplicate-receipt-${source}`;
  for (const row of portable.spans) {
    row.run_id = portable.run.id;
    row.otlp_evidence = duplicateDefinitionReceipt(row.otlp_evidence, source, index % 2 === 0, index % 3 !== 0, marker);
  }
  expect((await request("/api/import-run", portable)).status).toBe(200);
  const sql = `SELECT rowid AS identity,attributes,otlp_evidence,input_payload,output_payload FROM spans WHERE run_id='${portable.run.id}'`;
  const privateBefore = await request("/api/traces/query", { sql }); expect(privateBefore.status).toBe(200);
  const retained = (await privateBefore.json()).rows[0];
  expect(retained.otlp_evidence).toBe(portable.spans[0].otlp_evidence); expect(retained.attributes).toBe(portable.spans[0].attributes);
  expect(retained.input_payload).toBe(definitionInput); expect(retained.output_payload).toBe(definitionOutput);
  const observations = [];
  for (const route of [`/api/runs/detail/${portable.run.id}`, `/api/runs/${portable.run.id}/export`]) {
    const response = await request(route), text = await response.text();
    observations.push({ route, status: response.status, containsPrivate: text.includes(marker), body: text });
    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: route.endsWith("/export") ? "Could not export trace" : "request failed" });
    expect(text).not.toContain(marker);
  }
  const meta = await json(`/api/spans/${capture.spanId}?run_id=${portable.run.id}`);
  expect(meta.input_preview).toBe(definitionInput); expect(meta.output_preview).toBe(definitionOutput);
  expect(JSON.stringify(meta)).not.toContain(marker);
  const search = await json(`/api/runs/${portable.run.id}/search?scope=span_attributes&pattern=${encodeURIComponent(marker)}`);
  expect(search.matches).toEqual([]); expect(JSON.stringify(search)).not.toContain(marker);
  const compare = await json(`/api/runs/compare?baseline=${portable.run.id}&candidate=${portable.run.id}`);
  expect(compare.agentDefinitions).toBeUndefined();
  const privateAfter = await request("/api/traces/query", { sql }); expect(privateAfter.status).toBe(200);
  expect((await privateAfter.json()).rows[0]).toEqual(retained);
  const healthy = await json(`/api/runs/${capture.id}/export`);
  const healthyPrivate = await request("/api/traces/query", { sql: `SELECT otlp_evidence FROM spans WHERE run_id='${capture.id}'` });
  expect(healthyPrivate.status).toBe(200);
  expect(healthy.spans[0].otlp_evidence).toBe((await healthyPrivate.json()).rows[0].otlp_evidence);
  expect(healthy.spans[0].input_payload).toBe(definitionInput); expect(healthy.spans[0].output_payload).toBe(definitionOutput);
  proof(`http-duplicate-receipt-${source}.json`, { source: "Actual source OTLP, v2 import, public HTTP and privileged private SQL", pid: daemon.pid,
    admittedImportStatus: 200, observations, privateRowExact: true, inputOutputExact: true, healthyControlStatus: 200 });
});
