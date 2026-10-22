import { afterEach, beforeEach, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createServer } from "../src/server";
import { closeDb, getDrizzleDb, upsertRun } from "../src/db";
import { EVIDENCE_IMPORT_CONTENT_TYPE, EVIDENCE_READER_IDENTITY } from "../src/evaluations/evidence-import";
import { evidenceDigest } from "../src/evaluations/evidence-validation";
import type { EvidenceJob } from "../src/evaluations/evidence-protocol";
import { FindingStore } from "../src/evaluations/finding-store";
import { EvidenceStore, heldNormalizedEvidenceBytes } from "../src/evaluations/evidence-store";
import { createLocalEvidenceOwner } from "../src/evaluations/evidence-inventory";
import { EvidenceError } from "../src/evaluations/evidence-protocol";

let server: Server, directory: string, previous: string | undefined, base: string;
async function start() { ({ server } = await createServer(0)); server.listen(0, "127.0.0.1"); await once(server, "listening"); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; }
beforeEach(async () => { directory = mkdtempSync(join(tmpdir(), "runphantom-finding-api-")); previous = process.env.RUNPHANTOM_DB_PATH; closeDb(); process.env.RUNPHANTOM_DB_PATH = join(directory, "actual.db"); await start(); upsertRun({ id: "finding-run", started_at: 1, last_updated_at: 1 }); });
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); closeDb(); if (previous === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = previous; rmSync(directory, { recursive: true, force: true }); });
function producer(count = 1) { return { format: "runphantom-findings/v1", repositoryId: "fixture-repository", sourceSnapshot: "original-snapshot", checker: { id: "fixture-checker", version: "1.0.0", rulesSha256: "a".repeat(64), configurationSha256: "b".repeat(64) }, declaredScope: ["src/a.ts"], reportedExecution: { status: "completed", files: [{ path: "src/a.ts", status: "completed" }] }, findings: Array.from({ length: count }, (_, index) => ({ id: `occurrence-${index}`, path: "src/a.ts", ruleId: "R1", message: "unexpected retry(2)", severity: "error", startLine: 10 + index, endLine: 10 + index })) }; }
async function json(route: string, method = "GET", body?: unknown) { const response = await fetch(base + route, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, value: await response.json(), response }; }
async function terminal(id: string): Promise<EvidenceJob> { const deadline = performance.now() + 5_000; while (performance.now() < deadline) { const result = await json(`/api/evaluations/evidence/imports/${id}`); const job = result.value.job as EvidenceJob; if (!["queued", "running"].includes(job.status)) return job; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error("Actual finding worker did not terminate"); }
async function upload(raw: unknown, operationKey = crypto.randomUUID()) {
  const bytes = Buffer.from(typeof raw === "string" ? raw : JSON.stringify(raw)), request = { ...EVIDENCE_READER_IDENTITY, operationKey, attachment: { kind: "run", id: "finding-run" }, target: null, inventory: null, retention: "raw_and_normalized", sources: [{ sourceId: "findings", kind: "finding", dialect: "runphantom-findings-json/v1", shardId: null, artifactSha256: evidenceDigest(bytes), byteLength: bytes.length }] };
  const metadata = Buffer.from(JSON.stringify({ version: 1, request })), prefix = Buffer.alloc(4); prefix.writeUInt32BE(metadata.length);
  const response = await fetch(`${base}/api/evaluations/evidence/imports`, { method: "POST", headers: { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE }, body: Buffer.concat([prefix, metadata, bytes]) }); expect(response.status).toBe(202);
  const job = await terminal((await response.json()).job.id); expect(job.status).toBe("completed"); return { setId: job.setId!, revision: 1, sourceId: "findings" };
}
const path = "/api/evaluations/findings";
test("actual imported finding rows produce immutable conditional multiset JSON, never test execution or pass", async () => {
  const capability = await json(path + "/capabilities"); expect(capability.status).toBe(200); expect(capability.value).toMatchObject({ enabled: true, actor: "local_operator", authentication: "not_authenticated" });
  const baseline = await upload(producer()), candidate = await upload(producer(2));
  const captured = await json(`/api/evaluations/evidence/sets/${baseline.setId}?revision=1`);
  expect(captured.value.sources[0].normalized).toMatchObject({ leaves: [], leafCounts: { executed: null, passed: null }, reportOutcome: "unknown", findingBatch: { authentication: "not_authenticated" } });
  expect((await json(`/api/evaluations/evidence/sets/${baseline.setId}/export?revision=1&format=junit`)).status).toBe(409);
  const created = await json(path + "/comparisons", "POST", { baseline, candidate, operationKey: "one-comparison" }); expect(created.status).toBe(201);
  expect(created.value.comparison.difference.counts).toEqual({ retained: 1, introduced: 1, removed: 0, unresolved: 0 });
  expect(created.value.page.items).toHaveLength(2); expect(created.value.comparison.timing).toMatchObject({ cpuMs: null, peakRssBytes: null });
  for (const value of Object.values(created.value.comparison.timing).filter(value => typeof value === "number")) expect(value).toBeGreaterThanOrEqual(0);
  const id = created.value.comparison.id, exported = await json(path + `/comparisons/${id}/export`); expect(exported.status).toBe(200); expect(exported.value.baseline.findings).toHaveLength(1); expect(exported.value.candidate.findings).toHaveLength(2);
  expect((await json(path + "/comparisons", "POST", { baseline, candidate, operationKey: "one-comparison" })).value).toEqual(created.value);
  expect((await json(path + "/comparisons", "POST", { baseline: candidate, candidate: baseline, operationKey: "one-comparison" })).status).toBe(409);
  expect((await json(path + `/comparisons/${id}?limit=101`)).status).toBe(400);
  const history = await json(path + `/comparisons?${new URLSearchParams({ attachment: JSON.stringify({ kind: "run", id: "finding-run" }) })}`); expect(history.value.items[0].id).toBe(id); expect(JSON.stringify(history.value)).not.toContain("unexpected retry");
  await new Promise<void>(resolve => server.close(() => resolve())); closeDb(); await start();
  expect((await json(path + `/comparisons/${id}/export`)).value).toEqual(exported.value);
  const reparse = await json(`/api/evaluations/evidence/sets/${baseline.setId}/reparse`, "POST", { expectedRevision: 1, operationKey: "new-interpretation" }); expect(reparse.status).toBe(202); expect((await terminal(reparse.value.job.id)).status).toBe("completed");
  expect((await json(path + `/comparisons/${id}/export`)).value).toEqual(exported.value);
  const database = getDrizzleDb().$client; expect(() => database.query("UPDATE evaluation_finding_comparisons SET data='{}' WHERE id=?").run(id)).toThrow("immutable");
  expect((await json(`/api/evaluations/evidence/sets/${candidate.setId}/retention/raw?revision=1`, "DELETE", {})).status).toBe(200);
  expect((await json(path + `/comparisons/${id}/export`)).value).toEqual(exported.value);
  expect((await json(`/api/evaluations/evidence/sets/${candidate.setId}/retention/normalized?revision=1`, "DELETE", {})).status).toBe(200);
  expect((await json(path + `/comparisons/${id}`)).status).toBe(404); expect((await json(path + `/comparisons/${id}/export`)).status).toBe(404);
});
test("operator mappings bind actual immutable inputs; producer or caller actor cannot mint review", async () => {
  const raw = producer(), moved = producer(); moved.sourceSnapshot = "candidate-snapshot"; moved.declaredScope[0] = "src/renamed.ts"; moved.reportedExecution.files[0].path = "src/renamed.ts"; moved.findings[0].path = "src/renamed.ts"; moved.checker.version = "2.0.0";
  const baseline = await upload(raw), candidate = await upload(moved);
  const compare = { baseline, candidate, operationKey: "before-review" };
  expect((await json(path + "/comparisons", "POST", compare)).value.comparison.difference.counts.retained).toBeNull();
  const review = { baseline, candidate, paths: [{ baseline: "src/a.ts", candidate: "src/renamed.ts" }], reason: "Local operator reviewed the exact checker and rename pair" };
  expect((await json(path + "/mappings", "POST", { ...review, actor: "authenticated-admin", reviewed: true })).status).toBe(400);
  const mapping = await json(path + "/mappings", "POST", review); expect(mapping.status).toBe(201); expect(mapping.value.actor).toBe("local_operator");
  const created = await json(path + "/comparisons", "POST", { ...compare, operationKey: "after-review", mappingId: mapping.value.id }); expect(created.value.comparison.difference.counts.retained).toBe(1);
  const other = await upload(moved); expect((await json(path + "/comparisons", "POST", { ...compare, candidate: other, operationKey: "wrong-pair", mappingId: mapping.value.id })).status).toBe(409);
  const database = getDrizzleDb().$client; expect(() => database.query("UPDATE evaluation_finding_mappings SET data='{}' WHERE id=?").run(mapping.value.id)).toThrow("immutable");
  const owner = createLocalEvidenceOwner(database); expect(() => new FindingStore({ ...owner, scope: { kind: "project", id: "foreign" } }).get(created.value.comparison.id)).toThrow("unavailable for this scope");
});
test("real invalid/duplicate report and partial/not-run capture keep unavailable counts and byte retention", async () => {
  const baseline = await upload(producer()), partial = producer(); partial.reportedExecution.status = "partial"; partial.reportedExecution.files[0].status = "partial";
  const candidate = await upload(partial), malformed = await upload('{"format":"runphantom-findings/v1","format":"runphantom-findings/v1"}');
  const result = await json(path + "/comparisons", "POST", { baseline, candidate, operationKey: "partial" }); expect(result.value.comparison.difference).toMatchObject({ interpretation: "unavailable", counts: { retained: null, introduced: null, removed: null } });
  const unavailable = await json(path + "/comparisons", "POST", { baseline, candidate: malformed, operationKey: "unparsed" }); expect(unavailable.status).toBe(201); expect(unavailable.value.comparison.difference).toMatchObject({ observed: { baseline: 1, candidate: null }, counts: { retained: null, unresolved: null } });
  const raw = await fetch(`${base}/api/evaluations/evidence/sets/${malformed.setId}/raw/findings?revision=1`); expect(await raw.text()).toBe('{"format":"runphantom-findings/v1","format":"runphantom-findings/v1"}');
  const duplicate = await fetch(base + path + "/comparisons", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"operationKey":"first","operationKey":"second"}' }); expect(duplicate.status).toBe(400);
});
test("shared quota includes finding records and refuses authority before reading retained sources", async () => {
  const baseline = await upload(producer()), candidate = await upload(producer(2)), database = getDrizzleDb().$client, owner = createLocalEvidenceOwner(database);
  const before = heldNormalizedEvidenceBytes(database, "local:local"), tinyStore = new EvidenceStore(database, owner.scope, { authorize: (capability, _scope, attachment) => owner.authorize(capability, attachment), maxNormalizedBytes: before + 1 });
  expect(() => new FindingStore({ ...owner, store: tinyStore }).compare({ baseline, candidate, operationKey: "over-quota" })).toThrow("storage is full");
  expect((database.query("SELECT count(*) AS n FROM evaluation_finding_comparisons").get() as { n: number }).n).toBe(0);
  const comparison = new FindingStore(owner).compare({ baseline, candidate, operationKey: "quota-positive" }); expect(heldNormalizedEvidenceBytes(database, "local:local")).toBeGreaterThan(before);
  const guard = new FindingStore({ ...owner, authorize: () => { throw new Error("current role revoked"); } }); expect(() => guard.get(comparison.comparison.id)).toThrow("current role revoked");
  const current = heldNormalizedEvidenceBytes(database, "local:local"), importStore = new EvidenceStore(database, owner.scope, { authorize: (capability, _scope, attachment) => owner.authorize(capability, attachment), maxNormalizedBytes: current + 4 * 1024 * 1024 - 1 });
  const bytes = Buffer.from("<testsuite><testcase name='existing report'/></testsuite>"); expect(() => importStore.admit({ ...EVIDENCE_READER_IDENTITY, operationKey: "shared-quota-import", target: null, attachment: { kind: "run", id: "finding-run" }, inventory: null, retention: "normalized_only", sources: [{ sourceId: "old-report", kind: "junit", dialect: "junit-xml/v1", shardId: null, artifactSha256: evidenceDigest(bytes), byteLength: bytes.length }] })).toThrow("quota is full");
  owner.store.purgeScope(); expect((database.query("SELECT count(*) AS n FROM evaluation_finding_comparisons").get() as { n: number }).n).toBe(0);
  expect(() => new FindingStore(owner).get(comparison.comparison.id)).toThrow("not found");
});
test("historical retained deletion withholds old comparisons while fresh authorized reports recover", async () => {
  const baseline = await upload(producer()), candidate = await upload(producer(2));
  const old = await json(path + "/comparisons", "POST", { baseline, candidate, operationKey: "old-before-retention" });
  expect((await json(`/api/evaluations/evidence/sets/${candidate.setId}/retention/normalized?revision=1`, "DELETE", {})).status).toBe(200);
  expect((await json(path + `/comparisons/${old.value.comparison.id}`)).status).toBe(404);
  const roster = await json(path + `/batches?${new URLSearchParams({ attachment: JSON.stringify({ kind: "run", id: "finding-run" }) })}`);
  expect(roster.status).toBe(200); expect(roster.value.items.some((item: { reference: { setId: string } }) => item.reference.setId === candidate.setId)).toBe(false);
  const history = await json(path + `/comparisons?${new URLSearchParams({ attachment: JSON.stringify({ kind: "run", id: "finding-run" }) })}`);
  expect(history.status).toBe(200); expect(history.value.items).toEqual([]);
  const fresh = await upload(producer(3)), next = await json(path + "/comparisons", "POST", { baseline, candidate: fresh, operationKey: "fresh-after-retention" });
  expect(next.status).toBe(201); expect(next.value.comparison.difference.counts).toMatchObject({ retained: 1, introduced: 2 });
  expect((await json(path + `/comparisons/${old.value.comparison.id}/export`)).status).toBe(404);
});
test("retained-source omission never swallows another input's current 403 or integrity refusal", async () => {
  const baseline = await upload(producer()), candidate = await upload(producer(2));
  const created = await json(path + "/comparisons", "POST", { baseline, candidate, operationKey: "before-refusal" });
  const attachment = { kind: "run" as const, id: "finding-run" }, query = new URLSearchParams({ attachment: JSON.stringify(attachment) });
  expect((await json(path + `/comparisons/${created.value.comparison.id}/authority?${query}`)).value).toEqual({ id: created.value.comparison.id, current: true });
  upsertRun({ id: "different-run", started_at: 1, last_updated_at: 1 });
  expect((await json(path + `/comparisons/${created.value.comparison.id}/authority?${new URLSearchParams({ attachment: JSON.stringify({ kind: "run", id: "different-run" }) })}`)).status).toBe(409);
  expect((await json(`/api/evaluations/evidence/sets/${baseline.setId}/retention/normalized?revision=1`, "DELETE", {})).status).toBe(200);
  expect((await json(path + `/comparisons/${created.value.comparison.id}/authority?${query}`)).status).toBe(404);
  const database = getDrizzleDb().$client, owner = createLocalEvidenceOwner(database);
  const denied = new FindingStore({ ...owner, authorize: () => { throw new EvidenceError("Current compare role refused", 403); } });
  try { denied.list(attachment); throw Error("Expected current refusal"); } catch (error) { expect(error).toBeInstanceOf(EvidenceError); expect((error as EvidenceError).status).toBe(403); }
  const interpretation = owner.store.getSet(candidate.setId, 1).revision.sources[0].interpretationId;
  // Deliberate private-store corruption: the immutable UPDATE guard remains enabled.
  database.query("DELETE FROM evaluation_evidence_payloads WHERE interpretation_id=?").run(interpretation);
  database.query("INSERT INTO evaluation_evidence_payloads(scope_key,interpretation_id,data) VALUES('local:local',?,'{}')").run(interpretation);
  expect((await json(path + `/comparisons?${query}`)).status).toBe(409);
  expect((await json(path + `/batches?${query}`)).status).toBe(409);
  expect((await json(path + `/comparisons/${created.value.comparison.id}/authority?${query}`)).status).toBe(409);
});
test("runtime stage samples include refused attempts with an explicit bounded, resettable denominator", async () => {
  const baseline = await upload(producer()), candidate = await upload(producer(150));
  const created = await json(path + "/comparisons", "POST", { baseline, candidate, operationKey: "measured-real-comparison" });
  expect(created.status).toBe(201); expect(created.value.page.total).toBe(150);
  const metrics = await json(path + "/metrics"); expect(metrics.status).toBe(200);
  expect(metrics.value).toMatchObject({ durability: "process_only_resets_on_restart_or_scope_generation", admittedAttempts: 1, denominator: "all_attempts_admitted_by_current_compare_authority", retainedWindow: 1, evictedSamples: 0, cpuMs: null, peakRssBytes: null });
  expect(metrics.value.attempts[0].id).toBe(created.response.headers.get("X-Run-Phantom-Finding-Attempt"));
  for (const duration of Object.values(metrics.value.attempts[0].stages)) expect(typeof duration === "number" && Number.isFinite(duration) && duration >= 0).toBe(true);
  expect((await json(path + `/comparisons/${created.value.comparison.id}?offset=100&limit=100`)).value.page).toMatchObject({ offset: 100, total: 150 });
  const database = getDrizzleDb().$client, owner = createLocalEvidenceOwner(database), store = new FindingStore(owner);
  store.compare({ baseline, candidate, operationKey: "runtime-positive" });
  for (let index = 0; index < 101; index++) expect(() => store.compare({ operationKey: `secret-name-${index}`, baseline: { ...baseline, setId: "missing-set" }, candidate })).toThrow();
  const window = store.metrics() as { epoch: string; admittedAttempts: number; evictedSamples: number; attempts: unknown[]; outcomes: { conditional: number; input_unavailable: number } };
  expect(window).toMatchObject({ admittedAttempts: 102, retainedWindow: 100, evictedSamples: 2, outcomes: { conditional: 1, input_unavailable: 101 } });
  expect(JSON.stringify(window)).not.toContain("secret-name"); expect(JSON.stringify(window)).not.toContain("missing-set");
  expect((database.query("SELECT count(*) AS n FROM evaluation_finding_comparisons").get() as { n: number }).n).toBe(2);
  const reopened = new FindingStore(owner).metrics(); expect(reopened).toMatchObject({ admittedAttempts: 0, retainedWindow: 0, evictedSamples: 0 });
  owner.store.purgeScope(); expect(store.metrics()).toMatchObject({ admittedAttempts: 0, retainedWindow: 0, evictedSamples: 0 });
  const denied = new FindingStore({ ...owner, authorize: () => { throw new EvidenceError("Current compare role refused", 403); } }); expect(() => denied.metrics()).toThrow("Current compare role refused");
});

test("all nine bilateral coverage states and complete empty reports survive actual worker, persisted API and export", async () => {
  const references = new Map<string, Awaited<ReturnType<typeof upload>>>();
  for (const status of ["completed", "partial", "not_run"] as const) {
    const report = producer(status === "not_run" ? 0 : 1); report.reportedExecution.status = status; report.reportedExecution.files[0].status = status;
    references.set(status, await upload(report));
  }
  for (const [left, baseline] of references) for (const [right, candidate] of references) {
    const result = await json(path + "/comparisons", "POST", { baseline, candidate, operationKey: `coverage-${left}-${right}` }); expect(result.status).toBe(201);
    const difference = result.value.comparison.difference;
    expect(difference.observed).toEqual({ baseline: left === "not_run" ? 0 : 1, candidate: right === "not_run" ? 0 : 1 });
    if (left === "completed" && right === "completed") expect(difference.counts).toEqual({ retained: 1, introduced: 0, removed: 0, unresolved: 0 });
    else expect(difference).toMatchObject({ interpretation: "unavailable", counts: { retained: null, introduced: null, removed: null } });
    const exported = await json(path + `/comparisons/${result.value.comparison.id}/export`); expect(exported.status).toBe(200); expect(exported.value.comparison.difference.counts).toEqual(difference.counts);
  }
  const empty = await upload(producer(0)), complete = references.get("completed")!;
  const legitimate = await json(path + "/comparisons", "POST", { baseline: complete, candidate: empty, operationKey: "explicit-empty" });
  expect(legitimate.value.comparison.difference.counts).toEqual({ retained: 0, introduced: 0, removed: 1, unresolved: 0 });
  const missing = await json(path + "/comparisons", "POST", { baseline: complete, candidate: { ...empty, setId: "missing-input" }, operationKey: "missing-candidate" }); expect(missing.status).toBe(404);
  expect((await json(path + "/comparisons", "POST", { baseline: complete, candidate: empty, operationKey: "client-map", compatible: true })).status).toBe(400);
});

test("real compared file groups preserve severity and moved locations without consuming equal text from another path", async () => {
  const left = producer(2), right = producer(2);
  for (const report of [left, right]) { report.declaredScope.push("other/a.ts"); report.reportedExecution.files.push({ path: "other/a.ts", status: "completed" }); }
  left.findings[0].severity = "warning"; right.findings[0].startLine = 40; right.findings[0].endLine = 40; right.findings[1].path = "other/a.ts";
  const baseline = await upload(left), candidate = await upload(right), result = await json(path + "/comparisons", "POST", { baseline, candidate, operationKey: "actual-groups" }); expect(result.status).toBe(201);
  expect(result.value.comparison.difference.counts).toEqual({ retained: 1, introduced: 1, removed: 1, unresolved: 0 });
  const retained = result.value.page.items.find((item: { classification: string }) => item.classification === "retained"); expect(retained).toMatchObject({ baselineId: "occurrence-1", candidateId: "occurrence-0", severityChanged: false, locationChanged: true, candidate: { startLine: 40 } });
  const escalated = producer(); escalated.findings[0].severity = "warning"; const warning = await upload(escalated);
  const severity = await json(path + "/comparisons", "POST", { baseline: warning, candidate, operationKey: "severity-incompatible-scope" }); expect(severity.value.comparison.difference.counts.retained).toBeNull();
  const error = await upload(producer()), change = await json(path + "/comparisons", "POST", { baseline: warning, candidate: error, operationKey: "actual-severity" }); expect(change.value.page.items[0]).toMatchObject({ classification: "retained", severityChanged: true });
});

test("comparison and immutable review table counts enforce the approved thousand-record limits", async () => {
  const baseline = await upload(producer()), candidate = await upload(producer()), database = getDrizzleDb().$client, store = new FindingStore(createLocalEvidenceOwner(database));
  database.transaction(() => {
    for (let index = 0; index < 1_000; index++) store.reviewMapping({ baseline, candidate, paths: [], reason: "Exact same checker and snapshots reviewed locally" });
  }).immediate();
  expect(() => store.reviewMapping({ baseline, candidate, paths: [], reason: "One record beyond capacity" })).toThrow("storage is full");
  database.transaction(() => {
    for (let index = 0; index < 1_000; index++) store.compare({ baseline, candidate, operationKey: `bounded-comparison-${index}` });
  }).immediate();
  expect(() => store.compare({ baseline, candidate, operationKey: "one-beyond-comparison-capacity" })).toThrow("storage is full");
  for (const table of ["evaluation_finding_comparisons", "evaluation_finding_mappings"]) expect((database.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(1_000);
  expect((await json(path + "/comparisons", "POST", { baseline, candidate, operationKey: "control-limit", padding: "x".repeat(65_536) })).status).toBe(413);
});
