import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVIDENCE_STORAGE_SQL, EvidenceStore } from "../src/evaluations/evidence-store";
import type { EvidenceOwner } from "../src/evaluations/evidence-inventory";
import { EvidenceError } from "../src/evaluations/evidence-protocol";
import { evidenceDigest, deriveEvidenceCounts } from "../src/evaluations/evidence-validation";
import { CompletionStore } from "../src/claims/store";
import { COMPLETION_STORAGE_SQL } from "../src/claims/storage";
import { observeCompletion } from "../src/claims/report";

let db: Database, owner: EvidenceOwner, setId: string, directory: string, filename: string;
const scope = { kind: "local", id: "local" } as const, attachment = { kind: "run", id: "observer-run" } as const;
function open() {
  db = new Database(filename); db.exec("PRAGMA foreign_keys=ON");
  owner = { scope, database: db, authorize() { return { actorId: "local-owner" }; }, resolveAnchor(anchor) { if (anchor.kind === "dataset_revision" || anchor.kind !== attachment.kind || anchor.id !== attachment.id) throw new EvidenceError("Attachment unavailable", 404); return { anchor, createdAt: 1 }; }, store: new EvidenceStore(db, scope, { authorize() { return { actorId: "local-owner" }; } }) };
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "completion-history-")); filename = join(directory, "actual.db"); open(); db.exec(EVIDENCE_STORAGE_SQL); db.exec(COMPLETION_STORAGE_SQL); db.exec("INSERT INTO evaluation_evidence_scopes VALUES('local:local',1,1)");
  const raw = new TextEncoder().encode("Original report bytes; never copied into observer"), sourceId = "unit", leaves = [{ id: "leaf", name: "Observed test", status: "passed" as const, file: null, durationMs: 0, detail: null }];
  const request = { operationKey: "import-one", target: null, attachment, sources: [{ sourceId, kind: "junit" as const, dialect: "junit-xml/v1", shardId: null, artifactSha256: evidenceDigest(raw), byteLength: raw.length }], inventory: null, parserVersion: "strict-1", policyVersion: "redaction-1", configurationSha256: evidenceDigest("fixture"), retention: "normalized_only" as const };
  const admission = owner.store.admit(request); owner.store.start(admission.job.id, admission.publicationToken);
  setId = owner.store.publish(admission.job.id, admission.publicationToken, [{ sourceId, raw, normalized: { version: 1, sourceId, parseState: "parsed", interpretationComplete: true, reportOutcome: "reports_pass", leafCounts: deriveEvidenceCounts(leaves), observedExecutedLowerBound: "1", producerCounts: { tests: "1" }, producerSummaries: [], countsConsistent: true, assertedIdentity: { runnerId: null, commit: null, sourceSha256: null }, attestation: null, reasonCodes: [], leaves } }])!.id;
});
afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
function draft(operationKey = "observe-one", summary = "Original α summary: all tests pass.\nNot all tests pass.") { return { enabled: true as const, attachment, setId, revision: 1, operationKey, summary, assertions: [{ text: "All tests pass.", reference: { setId, revision: 1, sourceId: "unit" } }] }; }
test("immutable exact summary/version/spans/references survive reopen and later detector creates a separate record", () => {
  const store = new CompletionStore(owner), saved = store.create(draft()); expect(saved.request.summary).toBe(draft().summary); expect(saved.report.source.sha256).toBe(evidenceDigest(draft().summary));
  expect(store.create(draft())).toEqual(saved); expect(() => store.create({ ...draft(), summary: "changed retry" })).toThrow("operation");
  expect(() => db.exec("UPDATE evaluation_completion_payloads SET data='{}'")).toThrow("immutable");
  db.close(); open(); expect(new CompletionStore(owner).get(saved.id, attachment)).toEqual(saved);
  const next = new CompletionStore(owner, { detector: { version: "completion-spans/v2", observe(value, view) { const report = observeCompletion(value, view); if (report.state !== "enabled") throw Error("disabled fixture"); return { ...report, detectorVersion: "completion-spans/v2", observations: report.observations.map(item => ({ ...item, explanation: "New detector fixture explanation" })) }; } } }).create(draft("observe-two"));
  expect(next.id).not.toBe(saved.id); expect(next.report.detectorVersion).toBe("completion-spans/v2"); expect(new CompletionStore(owner).get(saved.id, attachment)).toEqual(saved);
  expect(new CompletionStore(owner).list(attachment, 0).total).toBe(2);
});
test("disable leaves historical exact reports and retained source deletion removes observer copies", () => {
  const store = new CompletionStore(owner), saved = store.create(draft()); expect(store.create({ enabled: false }).state).toBe("disabled"); expect(store.get(saved.id, attachment)).toEqual(saved);
  owner.store.removePayloads(setId, 1, "normalized_removed"); expect(() => store.get(saved.id, attachment)).toThrow("removed");
  expect(db.query("SELECT data FROM evaluation_completion_payloads").all()).toEqual([]); expect(store.list(attachment, 0).items[0].payloadAvailable).toBe(false);
  owner.store.purgeScope(); expect(db.query("SELECT id FROM evaluation_completion_reports").all()).toEqual([]); expect(store.list(attachment, 0).items).toEqual([]);
});
test("full UTF8 source, payload byte and scope quota admission refuse before partial publication", () => {
  const store = new CompletionStore(owner, { maxReports: 1 }); store.create(draft());
  expect(() => store.create(draft("observe-two"))).toThrow("quota");
  expect(() => new CompletionStore(owner).create(draft("oversize", "α".repeat(8193)))).toThrow("16 KiB");
  expect(db.query("SELECT count(*) AS n FROM evaluation_completion_reports").get()).toEqual({ n: 1 });
  const full = new CompletionStore(owner, { maxBytes: 1 }); expect(() => full.create(draft("quota-byte"))).toThrow("quota");
});
test("history and saved-read current attachment authority is enforced before lookup, revoked writes roll back", () => {
  const store = new CompletionStore(owner), saved = store.create(draft()); let checks = 0;
  const revoked = { ...owner, authorize() { if (++checks >= 2) throw new EvidenceError("Current authority revoked", 403); return { actorId: "local-owner" }; } };
  expect(() => new CompletionStore(revoked).get(saved.id, attachment)).toThrow("revoked"); checks = 0; expect(() => new CompletionStore(revoked).list(attachment, 0)).toThrow("revoked");
  checks = 0; expect(() => new CompletionStore(revoked).create(draft("after-revoked"))).toThrow("revoked");
  expect(db.query("SELECT count(*) AS n FROM evaluation_completion_reports").get()).toEqual({ n: 1 });
});

test("native retained byte quotas measure actual SQL payload bytes and reject metadata size mismatch without publication", () => {
  const store = new CompletionStore(owner), first = store.create(draft());
  const bytes = (db.query("SELECT sum(length(cast(data AS BLOB))) AS n FROM evaluation_completion_payloads").get() as { n: number }).n;
  expect(() => new CompletionStore(owner, { maxBytes: bytes }).create(draft("quota-native"))).toThrow("quota");
  const metadata = db.query("SELECT * FROM evaluation_completion_reports WHERE id=?").get(first.id) as Record<string, string | number>;
  db.query("INSERT INTO evaluation_completion_reports SELECT scope_key,scope_generation,'mismatch','bad-operation',request_digest,attachment_kind,attachment_id,set_id,set_revision,detector_version,summary_sha256,payload_digest,1,created_at FROM evaluation_completion_reports WHERE id=?").run(first.id);
  db.query("INSERT INTO evaluation_completion_payloads VALUES(?,?,?)").run("local:local", "mismatch", "α".repeat(400));
  expect(Buffer.byteLength("α".repeat(400))).toBe(800); expect(metadata.payload_bytes).toBe(bytes);
  expect(() => store.create(draft("after-mismatch"))).toThrow("size integrity");
  expect(db.query("SELECT count(*) AS n FROM evaluation_completion_reports").get()).toEqual({ n: 2 });
  expect(() => store.get(first.id, attachment)).toThrow("size integrity");
});
