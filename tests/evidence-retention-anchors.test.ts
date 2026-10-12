import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, getDrizzleDb } from "../src/db";
import { EVALUATION_LIMITS, EVALUATION_VERSION, SNAPSHOT_VERSION, type Experiment } from "../src/evaluations/protocol";
import { VERIFICATION_LIMITS, type VerificationReport } from "../src/verification/protocol";
import { insertExperiment } from "../src/evaluations/store";
import { saveReport } from "../src/verification/store";
import { createLocalEvidenceOwner } from "../src/evaluations/evidence-inventory";
import { EVIDENCE_READER_IDENTITY } from "../src/evaluations/evidence-import";
import { evidenceDigest } from "../src/evaluations/evidence-validation";

let directory: string, oldDb: string | undefined;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "runphantom-evidence-retention-")); oldDb = process.env.RUNPHANTOM_DB_PATH;
  closeDb(); process.env.RUNPHANTOM_DB_PATH = path.join(directory, "actual.db");
  getDrizzleDb().$client.exec("INSERT INTO evaluation_evidence_scopes VALUES('local:local',1,1)");
});
afterEach(() => { closeDb(); if (oldDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = oldDb; rmSync(directory, { recursive: true, force: true }); });
function experiment(id: string, createdAt: number): Experiment {
  return { id, createdAt, evaluationVersion: EVALUATION_VERSION, snapshotVersion: SNAPSHOT_VERSION, datasetId: "retained-dataset", datasetName: "Frozen", datasetVersion: 1,
    datasetHash: evidenceDigest("frozen"), name: id, status: "completed", verdict: "pass", completedAt: createdAt, results: [], summary: { total: 0, pass: 0, fail: 0, inconclusive: 0, passRate: 0 }, error: null };
}
function report(id: string, createdAt: number): VerificationReport { return { id, sessionId: "actual-session", runId: null, flowId: null, name: id, status: "pass", reason: "Observed", evidence: [], createdAt }; }
function admission(kind: "experiment" | "check", id: string) {
  const store = createLocalEvidenceOwner(getDrizzleDb().$client).store;
  return { store, admitted: store.admit({ ...EVIDENCE_READER_IDENTITY, operationKey: `protect-${id}`, target: null, inventory: null, attachment: { kind, id }, retention: "normalized_only",
    sources: [{ sourceId: "unit", kind: "junit", dialect: "junit-xml/v1", shardId: "unit", artifactSha256: evidenceDigest(""), byteLength: 0 }] }) };
}
test("actual experiment retention protects a nonterminal anchor then allows eviction after terminal failure", () => {
  const db = getDrizzleDb().$client, insert = db.query("INSERT INTO evaluation_experiments(id,status,job_token,completed_checks,data,summary,created_at,completed_at) VALUES(?,'completed','fixture',0,?,'{}',?,?)");
  for (let index = 0; index < EVALUATION_LIMITS.MAX_EXPERIMENTS; index++) { const value = experiment(`e-${index}`, index); insert.run(value.id, JSON.stringify(value), index, index); }
  const { store, admitted } = admission("experiment", "e-0");
  insertExperiment(experiment("next", 1_000), "actual-token");
  expect(db.query("SELECT id FROM evaluation_experiments WHERE id='e-0'").get()).toEqual({ id: "e-0" });
  expect(db.query("SELECT id FROM evaluation_experiments WHERE id='e-1'").get()).toBeNull();
  expect(store.fail(admitted.job.id, admitted.publicationToken, "worker_failed")).toBe(true);
  insertExperiment(experiment("after-terminal", 1_001), "actual-token-2");
  expect(db.query("SELECT id FROM evaluation_experiments WHERE id='e-0'").get()).toBeNull();
  expect(db.query("SELECT count(*) AS n FROM evaluation_experiments").get()).toEqual({ n: EVALUATION_LIMITS.MAX_EXPERIMENTS });
});
test("actual check retention protects a nonterminal anchor and corruption cannot make it evictable", () => {
  const db = getDrizzleDb().$client, insert = db.query("INSERT INTO verification_reports(id,session_id,name,status,reason,evidence,created_at) VALUES(?,'actual-session',?,'pass','Observed','[]',?)");
  for (let index = 0; index < VERIFICATION_LIMITS.MAX_REPORTS; index++) insert.run(`c-${index}`, `c-${index}`, index);
  const { store, admitted } = admission("check", "c-0");
  saveReport(report("next", 1_000));
  expect(db.query("SELECT id FROM verification_reports WHERE id='c-0'").get()).toEqual({ id: "c-0" });
  expect(db.query("SELECT id FROM verification_reports WHERE id='c-1'").get()).toBeNull();
  const original = (db.query("SELECT request_data FROM evaluation_evidence_jobs WHERE id=?").get(admitted.job.id) as { request_data: string }).request_data;
  db.query("UPDATE evaluation_evidence_jobs SET request_data=? WHERE id=?").run(" ".repeat(65_537), admitted.job.id);
  expect(() => saveReport(report("corrupt-refusal", 1_001))).toThrow("integrity boundary");
  expect(db.query("SELECT id FROM verification_reports WHERE id='corrupt-refusal'").get()).toBeNull();
  expect(db.query("SELECT id FROM verification_reports WHERE id='c-0'").get()).toEqual({ id: "c-0" });
  db.query("UPDATE evaluation_evidence_jobs SET request_data=? WHERE id=?").run(original, admitted.job.id);
  store.fail(admitted.job.id, admitted.publicationToken, "worker_failed"); saveReport(report("after-terminal", 1_002));
  expect(db.query("SELECT id FROM verification_reports WHERE id='c-0'").get()).toBeNull();
  expect(db.query("SELECT count(*) AS n FROM verification_reports").get()).toEqual({ n: VERIFICATION_LIMITS.MAX_REPORTS });
});
