import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { EVIDENCE_STORAGE_SQL, EvidenceStore } from "../src/evaluations/evidence-store";
import { EVIDENCE_IMPORT_FAILURE_CODES, EVIDENCE_LIMITS, EvidenceError, type EvidenceImportFailureCode, type EvidenceImportRequest } from "../src/evaluations/evidence-protocol";
import { evidenceDigest } from "../src/evaluations/evidence-validation";

let db: Database, store: EvidenceStore;
const bytes = new TextEncoder().encode("failure boundary fixture");
function request(operationKey: string): EvidenceImportRequest {
  return { operationKey, attachment: { kind: "run", id: "run-1" }, target: null, inventory: null,
    sources: [{ sourceId: "unit", kind: "junit", dialect: "junit-xml/v1", shardId: "unit", artifactSha256: evidenceDigest(bytes), byteLength: bytes.byteLength }],
    parserVersion: "strict-1", policyVersion: "redaction-1", configurationSha256: evidenceDigest("fixture"), retention: "raw_and_normalized" };
}
function row(id: string) {
  return db.query("SELECT status,failure_code,job_token,reserved_raw_bytes,reserved_normalized_bytes FROM evaluation_evidence_jobs WHERE id=?").get(id) as {
    status: string; failure_code: string | null; job_token: string; reserved_raw_bytes: number; reserved_normalized_bytes: number;
  };
}
beforeEach(() => {
  db = new Database(":memory:"); db.exec("PRAGMA foreign_keys=ON"); db.exec(EVIDENCE_STORAGE_SQL);
  db.exec("CREATE TABLE current_session(actor_id TEXT PRIMARY KEY, can_import INTEGER NOT NULL); CREATE TABLE current_attachment(id TEXT PRIMARY KEY);");
  db.exec("INSERT INTO current_session VALUES('operator',1); INSERT INTO current_attachment VALUES('run-1'); INSERT INTO evaluation_evidence_scopes VALUES('local:local',1,1);");
  store = new EvidenceStore(db, { kind: "local", id: "local" }, {
    maxRawBytes: bytes.byteLength, maxNormalizedBytes: EVIDENCE_LIMITS.MAX_NORMALIZED_BYTES,
    authorize(capability, _scope, attachment) {
      if (capability === "import" && (db.query("SELECT can_import FROM current_session WHERE actor_id='operator'").get() as { can_import: number } | null)?.can_import !== 1) throw new EvidenceError("Current import capability denied", 403);
      if (attachment && !db.query("SELECT id FROM current_attachment WHERE id=?").get(attachment.id)) throw new EvidenceError("Current attachment is unavailable", 404);
      return { actorId: "operator" };
    },
  });
});
afterEach(() => db.close());

describe("current-authority durable evidence failure", () => {
  test("every closed owner code terminalizes without cancellation text and releases exact reservations", () => {
    for (const [index, code] of EVIDENCE_IMPORT_FAILURE_CODES.entries()) {
      const admission = store.admit(request(`failure-${index}`));
      if (index % 2) expect(store.start(admission.job.id, admission.publicationToken)).toBe(true);
      expect(row(admission.job.id)).toMatchObject({ reserved_raw_bytes: bytes.byteLength, reserved_normalized_bytes: EVIDENCE_LIMITS.MAX_NORMALIZED_BYTES });
      expect(store.fail(admission.job.id, admission.publicationToken, code)).toBe(true);
      expect(store.getJob(admission.job.id)).toMatchObject({ status: "failed", failureCode: code });
      expect(row(admission.job.id)).toMatchObject({ reserved_raw_bytes: 0, reserved_normalized_bytes: 0 });
      expect(row(admission.job.id).job_token).not.toBe(admission.publicationToken);
      expect(store.fail(admission.job.id, admission.publicationToken, "worker_failed")).toBe(false);
      expect(store.start(admission.job.id, admission.publicationToken)).toBe(false);
      expect(store.publish(admission.job.id, admission.publicationToken, [])).toBeNull();
      const replay = store.admit(request(`failure-${index}`));
      expect(replay.reused).toBe(true); expect(replay.job).toMatchObject({ id: admission.job.id, status: "failed", failureCode: code });
    }
    expect(db.query("SELECT count(*) AS n FROM evaluation_evidence_blobs").get()).toEqual({ n: 0 });
  });
  test("wrong token, scope generation, cancellation and completion cannot be rewritten", () => {
    const admitted = store.admit(request("fenced")), before = row(admitted.job.id);
    expect(store.fail(admitted.job.id, "wrong-token", "worker_failed")).toBe(false); expect(row(admitted.job.id)).toEqual(before);
    db.exec("UPDATE evaluation_evidence_scopes SET generation=2 WHERE scope_key='local:local'");
    expect(store.fail(admitted.job.id, admitted.publicationToken, "worker_failed")).toBe(false); expect(row(admitted.job.id)).toEqual(before);
    db.exec("UPDATE evaluation_evidence_scopes SET generation=1 WHERE scope_key='local:local'");
    expect(store.cancel(admitted.job.id)).toBe(true); const cancelled = row(admitted.job.id);
    expect(store.fail(admitted.job.id, admitted.publicationToken, "worker_failed")).toBe(false); expect(row(admitted.job.id)).toEqual(cancelled);
    const done = store.admit(request("already-completed"));
    db.query("UPDATE evaluation_evidence_jobs SET status='completed',reserved_raw_bytes=0,reserved_normalized_bytes=0 WHERE id=?").run(done.job.id);
    const completed = row(done.job.id);
    expect(store.fail(done.job.id, done.publicationToken, "shutdown")).toBe(false); expect(row(done.job.id)).toEqual(completed);
  });
  test("current coarse capability is checked before existence, then current attachment inside the transaction", () => {
    const admitted = store.admit(request("authorization")), before = row(admitted.job.id);
    db.exec("UPDATE current_session SET can_import=0");
    expect(() => store.fail("absent", admitted.publicationToken, "worker_failed")).toThrow("Current import capability denied");
    expect(() => store.fail(admitted.job.id, admitted.publicationToken, "worker_failed")).toThrow("Current import capability denied");
    expect(row(admitted.job.id)).toEqual(before);
    db.exec("UPDATE current_session SET can_import=1; DELETE FROM current_attachment");
    expect(() => store.fail(admitted.job.id, admitted.publicationToken, "attachment_unavailable")).toThrow("Current attachment is unavailable");
    expect(row(admitted.job.id)).toEqual(before);
    db.exec("INSERT INTO current_attachment VALUES('run-1')");
    expect(store.fail(admitted.job.id, admitted.publicationToken, "attachment_unavailable")).toBe(true);
    expect(store.admit(request("quota-positive-control")).job.status).toBe("queued");
  });
  test("request diagnostics and cancellation cannot be injected as a durable failure code", () => {
    const admitted = store.admit(request("closed-code")), before = row(admitted.job.id);
    for (const value of ["cancelled", "unexpected detail from worker", "__proto__", null, { toString() { throw new Error("must not call"); } }]) {
      expect(() => store.fail(admitted.job.id, admitted.publicationToken, value as EvidenceImportFailureCode)).toThrow("Unsupported evidence failure code");
      expect(row(admitted.job.id)).toEqual(before);
    }
    expect(store.fail(admitted.job.id, admitted.publicationToken, "source_integrity")).toBe(true);
  });
  test("restart recovery retains a prior failure and fences both old queued and running owners", () => {
    const first = store.admit(request("prior-failure")); store.fail(first.job.id, first.publicationToken, "upload_aborted");
    const second = store.admit(request("interrupted")); store.start(second.job.id, second.publicationToken);
    expect(store.recoverUnfinished()).toBe(1);
    expect(store.getJob(first.job.id)).toMatchObject({ status: "failed", failureCode: "upload_aborted" });
    expect(store.getJob(second.job.id)).toMatchObject({ status: "failed", failureCode: "restart_interrupted" });
    expect(store.fail(second.job.id, second.publicationToken, "worker_failed")).toBe(false);
    expect(store.admit(request("restart-positive-control")).job.status).toBe("queued");
  });
});
