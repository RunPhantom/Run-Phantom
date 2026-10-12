import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { request as httpRequest, type Server } from "node:http";
import { closeDb, getDrizzleDb, upsertRun } from "../src/db";
import { createServer } from "../src/server";
import { EVIDENCE_IMPORT_CONTENT_TYPE, EVIDENCE_READER_IDENTITY } from "../src/evaluations/evidence-import";
import { evidenceDigest } from "../src/evaluations/evidence-validation";
import type { EvidenceImportRequest, EvidenceJob, EvidenceSetView } from "../src/evaluations/evidence-protocol";
import { EVIDENCE_PREDICATE_TYPE, EVIDENCE_STATEMENT_TYPE } from "../src/evaluations/evidence-protocol";
import { createDataset, insertExperiment } from "../src/evaluations/store";
import { EVALUATION_VERSION, SNAPSHOT_VERSION, type Experiment } from "../src/evaluations/protocol";

let server: Server, directory: string, oldDb: string | undefined, base: string;
const raw = Buffer.from('<testsuite tests="2" failures="1"><testcase name="safe pass"/><testcase name="&lt;script&gt;inert&lt;/script&gt;"><failure>Authorization: Bearer synthetic-token-value</failure></testcase></testsuite>');
const expected = [{ shardId: "unit", kind: "junit", constraints: { runnerId: null, commit: null, sourceSha256: null } }];
beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "runphantom-evidence-api-")); oldDb = process.env.RUNPHANTOM_DB_PATH;
  closeDb(); process.env.RUNPHANTOM_DB_PATH = path.join(directory, "actual.db");
  await start(); upsertRun({ id: "actual-run", started_at: 1, last_updated_at: 1 });
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve())); closeDb();
  if (oldDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = oldDb;
  rmSync(directory, { recursive: true, force: true });
});
async function start() {
  ({ server } = await createServer(0)); server.listen(0, "127.0.0.1"); await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function draft(operationKey: string, bytes = raw): EvidenceImportRequest {
  return { ...EVIDENCE_READER_IDENTITY, operationKey, attachment: { kind: "run", id: "actual-run" }, target: null, inventory: null, retention: "raw_and_normalized",
    sources: [{ sourceId: "unit", kind: "junit", dialect: "junit-xml/v1", shardId: "unit", artifactSha256: evidenceDigest(bytes), byteLength: bytes.length }] };
}
function encode(request: EvidenceImportRequest, sources = [raw]) {
  const metadata = Buffer.from(JSON.stringify({ version: 1, request })), prefix = Buffer.alloc(4); prefix.writeUInt32BE(metadata.length);
  return Buffer.concat([prefix, metadata, ...sources]);
}
async function json(route: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}/api/evaluations/evidence${route}`, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, value: await response.json(), response };
}
async function upload(request: EvidenceImportRequest, sources = [raw]) {
  const response = await fetch(`${base}/api/evaluations/evidence/imports`, { method: "POST", headers: { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE }, body: encode(request, sources) });
  return { status: response.status, value: await response.json() as { job: EvidenceJob; reused: boolean } };
}
async function terminal(id: string): Promise<EvidenceJob> {
  const deadline = performance.now() + 4_000;
  while (performance.now() < deadline) {
    const result = await json(`/imports/${id}`); expect(result.status).toBe(200);
    const job = result.value.job as EvidenceJob;
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Actual evidence job did not finish");
}
describe("activated local evidence HTTP routes", () => {
  test("a prospective actual dataset roster stays frozen across smaller uploads, authorized edits and daemon restart", async () => {
    const dataset = createDataset("Frozen evidence roster"), anchor = { kind: "dataset_revision", id: dataset.datasetId, version: dataset.version };
    const inventory = await json("/inventories", "POST", { anchor, expectedRevision: 0, expected: [...expected, { ...expected[0], shardId: "integration" }] }); expect(inventory.status).toBe(201);
    const experiment: Experiment = { id: "unchanged-experiment", createdAt: inventory.value.createdAt + 1, evaluationVersion: EVALUATION_VERSION, snapshotVersion: SNAPSHOT_VERSION,
      datasetId: dataset.datasetId, datasetName: dataset.datasetName, datasetVersion: dataset.version, datasetHash: dataset.hash, name: "Frozen original",
      status: "completed", completedAt: inventory.value.createdAt + 1, verdict: "pass", results: [], summary: { total: 0, pass: 0, fail: 0, inconclusive: 0, passRate: 0 }, error: null };
    insertExperiment(experiment, "actual-original-token");
    const original = getDrizzleDb().$client.query("SELECT data FROM evaluation_experiments WHERE id=?").get(experiment.id);
    const pass = Buffer.from('<testsuite tests="1"><testcase name="observed pass"/></testsuite>');
    const request = draft("prospective-missing", pass); request.attachment = { kind: "experiment", id: experiment.id }; request.inventory = { id: inventory.value.id, revision: 1 };
    const missing = await terminal((await upload(request, [pass])).value.job.id);
    expect((await json(`/sets/${missing.setId}`)).value.revision).toMatchObject({ coverage: "incomplete", missing: ["integration"], inventory: { revision: 1, declaration: "prospective" } });
    request.operationKey = "prospective-complete"; request.sources.push({ ...request.sources[0], sourceId: "integration", shardId: "integration" });
    const complete = await terminal((await upload(request, [pass, pass])).value.job.id), prior = (await json(`/sets/${complete.setId}`)).value;
    expect(prior.revision).toMatchObject({ coverage: "complete", missing: [], inventory: { revision: 1 } });
    expect(prior.revision.sources.every((source: { reportOutcome: string; authentication: string }) => source.reportOutcome === "reports_pass" && source.authentication === "not_checked")).toBe(true);
    expect((await json("/inventories", "PUT", { anchor, expectedRevision: 1, expected })).status).toBe(201);
    expect((await json("/inventories", "PUT", { anchor, expectedRevision: 1, expected })).status).toBe(409);
    expect((await upload({ ...request, operationKey: "stale-inventory" }, [pass, pass])).status).toBe(409);
    expect((await upload(request, [pass, pass])).value.reused).toBe(true);
    await new Promise<void>(resolve => server.close(() => resolve())); closeDb(); await start();
    expect((await json(`/sets/${complete.setId}`)).value).toEqual(prior);
    expect(getDrizzleDb().$client.query("SELECT data FROM evaluation_experiments WHERE id=?").get(experiment.id)).toEqual(original);
  });
  test("actual run deletion invalidates an admitted live upload before deleting its anchor", async () => {
    const bytes = encode(draft("deleted-anchor")), headerEnd = 4 + bytes.readUInt32BE(0);
    const request = httpRequest(`${base}/api/evaluations/evidence/imports`, { method: "POST", headers: { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE } }, response => response.resume()); request.on("error", () => {});
    try {
      request.write(bytes.subarray(0, headerEnd + 1));
      const deadline = performance.now() + 1_000;
      while (!(getDrizzleDb().$client.query("SELECT id FROM evaluation_evidence_jobs WHERE operation_key='deleted-anchor' AND status='running'").get())) {
        if (performance.now() > deadline) throw new Error("Live deletion fixture admission deadline"); await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect((await fetch(`${base}/api/runs/actual-run`, { method: "DELETE" })).status).toBe(200);
      expect(getDrizzleDb().$client.query("SELECT status,failure_code,set_id,reserved_raw_bytes,reserved_normalized_bytes FROM evaluation_evidence_jobs WHERE operation_key='deleted-anchor'").get()).toEqual({ status: "failed", failure_code: "attachment_unavailable", set_id: null, reserved_raw_bytes: 0, reserved_normalized_bytes: 0 });
      expect(getDrizzleDb().$client.query("SELECT id FROM runs WHERE id='actual-run'").get()).toBeNull();
      expect((await upload(draft("missing-anchor"))).status).toBe(404);
      expect(getDrizzleDb().$client.query("SELECT count(*) AS n FROM evaluation_evidence_blobs").get()).toEqual({ n: 0 });
    } finally { request.destroy(); }
  });
  test("real worker output survives daemon reopen and exports retain failures without raw secrets", async () => {
    const inventory = await json("/inventories", "POST", { anchor: { kind: "run", id: "actual-run" }, expectedRevision: 0, expected });
    expect(inventory.status).toBe(201);
    const request = draft("end-user-upload"); request.inventory = { id: inventory.value.id, revision: 1 };
    const receipt = await upload(request); expect(receipt.status).toBe(202);
    const job = await terminal(receipt.value.job.id); expect(job.status).toBe("completed");
    const timing = (await json(`/imports/${job.id}`)).value.timings;
    expect(timing).toMatchObject({ availability: "measured_in_current_daemon", cpuMs: null, rssBytes: null });
    for (const key of ["acquisitionWallMs", "queueWallMs", "workerLifetimeWallMs", "publicationWallMs", "totalOperationWallMs"]) expect(timing[key]).toBeGreaterThanOrEqual(0);
    expect(timing).not.toHaveProperty("parseMs");
    const view = (await json(`/sets/${job.setId}`)).value as EvidenceSetView;
    expect(view.revision).toMatchObject({ coverage: "incomplete", missing: [], reasonCodes: ["retrospective_inventory"], attachment: { kind: "run", id: "actual-run" } });
    expect(view.revision.sources[0]).toMatchObject({ reportOutcome: "reports_fail", leafCounts: { executed: "2", passed: "1", failed: "1" }, authentication: "not_checked" });
    expect(JSON.stringify(view)).not.toContain("synthetic-token-value"); expect(view.sources[0].normalized!.leaves[1].name).toBe("<script>inert</script>");
    const exported = await json(`/sets/${job.setId}/export`); expect(exported.status).toBe(200);
    expect(JSON.stringify(exported.value)).not.toContain("Bearer"); expect(exported.value.sources[0].observation.leaves[1]).not.toHaveProperty("detail");
    const junit = await fetch(`${base}/api/evaluations/evidence/sets/${job.setId}/export?format=junit`);
    const xml = await junit.text(); expect(junit.status).toBe(200); expect(xml).toContain('failures="1"'); expect(xml).not.toContain("<script>"); expect(xml).not.toContain("synthetic-token-value");
    const downloaded = await fetch(`${base}/api/evaluations/evidence/sets/${job.setId}/raw/unit?revision=1`);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(raw);
    const before = evidenceDigest(JSON.stringify(view));
    await new Promise<void>(resolve => server.close(() => resolve())); closeDb(); await start();
    expect(evidenceDigest(JSON.stringify((await json(`/sets/${job.setId}`)).value))).toBe(before);
    expect((await json(`/imports?operationKey=end-user-upload`)).value.job.id).toBe(job.id);
    expect((await json(`/imports/${job.id}`)).value.timings).toEqual({ availability: "unavailable", acquisitionWallMs: null, queueWallMs: null, workerLifetimeWallMs: null,
      publicationWallMs: null, totalOperationWallMs: null, cpuMs: null, rssBytes: null });
  });
  test("two actual clients share one durable operation and changed raw bytes never reuse its identity", async () => {
    const input = draft("shared-key");
    const [first, second] = await Promise.all([upload(input), upload(input)]);
    expect(first.status).toBe(202); expect(second.status).toBe(202); expect(first.value.job.id).toBe(second.value.job.id);
    expect([first.value.reused, second.value.reused].sort()).toEqual([false, true]);
    expect((await terminal(first.value.job.id)).status).toBe("completed");
    const altered = Buffer.from(raw); altered[altered.length - 1] ^= 1;
    expect((await upload(input, [altered])).status).toBe(400);
    expect((await upload(draft("shared-key", altered), [altered])).status).toBe(409);
    expect(getDrizzleDb().$client.query("SELECT count(*) AS n FROM evaluation_evidence_jobs").get()).toEqual({ n: 1 });
  });
  test("missing trusted shard and malformed sibling remain incomplete or unknown", async () => {
    const inventory = await json("/inventories", "POST", { anchor: { kind: "run", id: "actual-run" }, expectedRevision: 0,
      expected: [...expected, { ...expected[0], shardId: "integration" }] });
    const request = draft("missing-and-malformed"), malformed = Buffer.from("<testsuite><testcase");
    request.inventory = { id: inventory.value.id, revision: 1 }; request.sources.push({ ...request.sources[0], sourceId: "malformed", shardId: "extra", artifactSha256: evidenceDigest(malformed), byteLength: malformed.length });
    const receipt = await upload(request, [raw, malformed]); const job = await terminal(receipt.value.job.id);
    const view = (await json(`/sets/${job.setId}`)).value as EvidenceSetView;
    expect(view.revision).toMatchObject({ coverage: "incomplete", missing: ["integration"], extra: ["malformed"] });
    expect(view.revision.sources[0].reportOutcome).toBe("reports_fail"); expect(view.revision.sources[1]).toMatchObject({ reportOutcome: "unknown", leafCounts: { executed: null } });
    expect((await fetch(`${base}/api/evaluations/evidence/sets/${job.setId}/export?format=junit`)).status).toBe(409);
  });
  test("separate raw and normalized retention and actual reparse preserve earlier revisions", async () => {
    const receipt = await upload(draft("retained")), job = await terminal(receipt.value.job.id), first = (await json(`/sets/${job.setId}?revision=1`)).value;
    const appended = await json(`/sets/${job.setId}/reparse`, "POST", { operationKey: "reparse-own", expectedRevision: 1 }); expect(appended.status).toBe(202);
    const next = await terminal(appended.value.job.id); expect(next.status).toBe("completed");
    expect((await json(`/sets/${job.setId}?revision=2`)).value.revision.revision).toBe(2);
    expect((await json(`/sets/${job.setId}?revision=1`)).value).toEqual(first);
    expect((await json(`/sets/${job.setId}/retention/raw?revision=1`, "DELETE", {})).value.removed).toBe(1);
    const after = (await json(`/sets/${job.setId}?revision=1`)).value;
    expect(after.revision).toEqual(first.revision); expect(after.sources[0]).toMatchObject({ rawAvailable: false, normalizedAvailable: true });
    expect((await json(`/sets/${job.setId}/reparse`, "POST", { operationKey: "wrong-prior", expectedRevision: 1 })).status).toBe(409);
    expect((await json(`/sets/${job.setId}/retention/normalized?revision=1`, "DELETE", {})).value.removed).toBe(1);
    expect((await json(`/sets/${job.setId}?revision=1`)).value.sources[0]).toMatchObject({ rawAvailable: false, normalizedAvailable: false, normalized: null });
    expect((await json(`/sets/${job.setId}?revision=2`)).value.sources[0].rawAvailable).toBe(true);
    const other = await terminal((await upload(draft("same-bytes-other-set"))).value.job.id); expect(other.setId).not.toBe(job.setId);
    expect((await json(`/sets/${job.setId}/retention/raw?revision=2`, "DELETE", {})).value.removed).toBe(1);
    await new Promise<void>(resolve => server.close(() => resolve())); closeDb(); await start();
    expect((await fetch(`${base}/api/evaluations/evidence/sets/${job.setId}/raw/unit?revision=2`)).status).toBe(404);
    expect((await json(`/sets/${job.setId}/reparse`, "POST", { operationKey: "cannot-borrow-digest", expectedRevision: 2 })).status).toBe(404);
    expect((await json(`/sets/${job.setId}?revision=2`)).value.revision.revision).toBe(2);
    expect((await json(`/sets/${other.setId}`)).value.sources[0].rawAvailable).toBe(true);
  });
  test("a fake signed digest assertion links only its exact report and never proves execution or authentication", async () => {
    const statement = { _type: EVIDENCE_STATEMENT_TYPE, predicateType: EVIDENCE_PREDICATE_TYPE,
      subject: [{ name: "unit.xml", digest: { sha256: evidenceDigest(raw), gitCommit: "a".repeat(40) } }], predicate: { result: "PASSED", passedTests: ["claimed only"] } };
    const attestation = Buffer.from(JSON.stringify({ payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(statement)).toString("base64"), signatures: [{ keyid: "fake", sig: "bm90LWE tc2lnbmF0dXJl" }] }));
    const request = draft("fake-signature"), sibling = Buffer.from('<testsuite tests="1"><testcase name="different sibling"/></testsuite>');
    request.sources.push({ sourceId: "attestation", kind: "attestation", dialect: "dsse-envelope/v1", shardId: null, artifactSha256: evidenceDigest(attestation), byteLength: attestation.length },
      { ...request.sources[0], sourceId: "sibling", shardId: "sibling", artifactSha256: evidenceDigest(sibling), byteLength: sibling.length });
    const receipt = await upload(request, [raw, attestation, sibling]), job = await terminal(receipt.value.job.id);
    const view = (await json(`/sets/${job.setId}`)).value as EvidenceSetView;
    expect(view.revision.sources[0]).toMatchObject({ reportIdentityAsserted: true, reportOutcome: "reports_fail", authentication: "not_checked" });
    expect(view.revision.sources[1]).toMatchObject({ reportOutcome: "unknown", leafCounts: { executed: null }, authentication: "not_checked", reportReferences: [{ linkedSourceId: "unit", resolution: "matched" }] });
    expect(view.revision.sources[2].reportIdentityAsserted).toBe(false);
    expect(view.sources[1].normalized!.attestation).toMatchObject({ signatureCount: "1", signaturesChecked: false, producerResult: "PASSED" });
  });
  test("exact binary endpoint preserves existing JSON and local-origin guards with strict small controls", async () => {
    const capabilities = await json("/capabilities"); expect(capabilities.status).toBe(200);
    expect(capabilities.value).toMatchObject({ transport: { version: 1, contentType: EVIDENCE_IMPORT_CONTENT_TYPE, maxHeaderBytes: 65_536 }, reader: EVIDENCE_READER_IDENTITY, limits: { MAX_ACTIVE: 2, MAX_QUEUED: 8 } });
    const binary = encode(draft("forbidden"));
    expect((await fetch(`${base}/api/evaluations/evidence/imports`, { method: "POST", headers: { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE, Origin: "https://foreign.example" }, body: binary })).status).toBe(403);
    expect((await fetch(`${base}/api/evaluations/datasets`, { method: "POST", headers: { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE }, body: binary })).status).toBe(400);
    expect((await fetch(`${base}/api/verification/sessions`, { method: "POST", headers: { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE }, body: binary })).status).toBe(400);
    expect((await fetch(`${base}/api/evaluations/evidence/inventories`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"expectedRevision":0,"expectedRevision":1}' })).status).toBe(400);
    expect((await fetch(`${base}/api/evaluations/evidence/inventories`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ oversized: "x".repeat(65_536) }) })).status).toBe(413);
    expect((await upload(draft("guard-positive"))).status).toBe(202);
  });
});
