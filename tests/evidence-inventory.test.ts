import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { EvidenceInventories, createLocalEvidenceOwner, type EvidenceOwner } from "../src/evaluations/evidence-inventory";
import { EVIDENCE_READER_IDENTITY } from "../src/evaluations/evidence-import";
import { evidenceDigest } from "../src/evaluations/evidence-validation";
import type { EvidenceImportRequest } from "../src/evaluations/evidence-protocol";

let db: Database, owner: EvidenceOwner, inventories: EvidenceInventories;
const expected = [{ shardId: "unit", kind: "junit" as const, constraints: { runnerId: null, commit: null, sourceSha256: null } }];
const raw = new TextEncoder().encode("actual anchored request");
const datasetHash = evidenceDigest("[]");
function draft(key: string, attachment: EvidenceImportRequest["attachment"] = { kind: "run", id: "run-1" }): EvidenceImportRequest {
  return { ...EVIDENCE_READER_IDENTITY, operationKey: key, attachment, target: null, inventory: null, retention: "normalized_only",
    sources: [{ sourceId: "unit", shardId: "unit", kind: "junit", dialect: "junit-xml/v1", artifactSha256: evidenceDigest(raw), byteLength: raw.byteLength }] };
}
function experiment(id: string, createdAt: number, hash = datasetHash) {
  db.query("INSERT INTO evaluation_experiments(id,status,job_token,completed_checks,data,summary,created_at) VALUES(?,'completed','token',0,?,'{}',?)")
    .run(id, JSON.stringify({ id, createdAt, datasetId: "dataset-1", datasetVersion: 1, datasetHash: hash }), createdAt);
}
beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA legacy_alter_table=ON; PRAGMA foreign_keys=OFF");
  migrate(drizzle(db), { migrationsFolder: `${import.meta.dir}/../drizzle` });
  db.exec("PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF");
  expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(db.query("PRAGMA legacy_alter_table").get()).toEqual({ legacy_alter_table: 0 });
  db.exec("INSERT INTO evaluation_evidence_scopes VALUES('local:local',1,1)");
  db.exec("INSERT INTO runs(id,started_at,last_updated_at) VALUES('run-1',1,1),('run-2',1,1)");
  db.exec("INSERT INTO evaluation_datasets VALUES('dataset-1','Actual dataset',1,0,1)");
  db.query("INSERT INTO evaluation_revisions VALUES('dataset-1',1,?,'[]',1)").run(datasetHash);
  owner = createLocalEvidenceOwner(db); inventories = new EvidenceInventories(owner);
});
afterEach(() => db.close());
describe("actual local evidence inventory authority", () => {
  test("arbitrary attachment and dataset identities never create inventory rows or reserve quota", () => {
    for (const anchor of [{ kind: "run", id: "absent" }, { kind: "inspection", id: "invented-inspection" }, { kind: "check", id: "absent" }, { kind: "experiment", id: "absent" }, { kind: "dataset_revision", id: "dataset-1", version: 2 }]) {
      expect(() => inventories.save({ anchor, expectedRevision: 0, expected })).toThrow("not found");
    }
    expect(() => inventories.admit(draft("absent", { kind: "run", id: "absent" }))).toThrow("not found");
    expect(db.query("SELECT count(*) AS n FROM evaluation_evidence_jobs").get()).toEqual({ n: 0 });
    expect(db.query("SELECT count(*) AS n FROM evaluation_evidence_inventories").get()).toEqual({ n: 0 });
  });
  test("CAS edits are complete, separate from import and frozen across exact retries", () => {
    const anchor = { kind: "run", id: "run-1" }, first = inventories.save({ anchor, expectedRevision: 0, expected });
    expect(first.declaration).toBe("retrospective");
    const input = draft("frozen"); input.inventory = { id: first.id, revision: 1 };
    const admitted = inventories.admit(input);
    const second = inventories.save({ anchor, expectedRevision: 1, expected: [...expected, { ...expected[0], shardId: "integration" }] });
    expect(second).toMatchObject({ id: first.id, revision: 2 });
    expect(() => inventories.save({ anchor, expectedRevision: 1, expected })).toThrow("changed");
    expect(inventories.admit(input)).toMatchObject({ reused: true, job: { id: admitted.job.id } });
    expect(() => inventories.admit({ ...input, operationKey: "new-stale" })).toThrow("current authorized revision");
    expect(db.query("SELECT count(*) AS n FROM evaluation_evidence_jobs").get()).toEqual({ n: 1 });
    expect(inventories.get(anchor, 1)).toEqual(first); expect(inventories.get(anchor, 2)).toEqual(second);
  });
  test("same database unrelated anchors cannot borrow an inventory or self-declare a smaller roster during upload", () => {
    const first = inventories.save({ anchor: { kind: "run", id: "run-1" }, expectedRevision: 0, expected });
    const input = draft("foreign-roster", { kind: "run", id: "run-2" }); input.inventory = { id: first.id, revision: 1 };
    expect(() => inventories.admit(input)).toThrow("does not belong");
    expect(db.query("SELECT count(*) AS n FROM evaluation_evidence_jobs").get()).toEqual({ n: 0 });
    expect(() => inventories.save({ anchor: { kind: "run", id: "run-1" }, expectedRevision: 1, expected: [] })).toThrow("entry limit");
    expect(() => inventories.get({ kind: "inspection", id: "run-1" }, 1)).toThrow("not found");
  });
  test("a prospective dataset roster binds only a later experiment with the exact frozen revision hash", () => {
    const inventory = inventories.save({ anchor: { kind: "dataset_revision", id: "dataset-1", version: 1 }, expectedRevision: 0, expected });
    experiment("later", inventory.createdAt + 1); experiment("earlier", inventory.createdAt - 1); experiment("wrong-hash", inventory.createdAt + 1, evidenceDigest("other revision"));
    const input = draft("prospective", { kind: "experiment", id: "later" }); input.inventory = { id: inventory.id, revision: 1 };
    expect(inventories.admit(input).reused).toBe(false);
    expect(() => inventories.admit({ ...input, operationKey: "earlier", attachment: { kind: "experiment", id: "earlier" } })).toThrow("does not belong");
    expect(() => inventories.admit({ ...input, operationKey: "wrong", attachment: { kind: "experiment", id: "wrong-hash" } })).toThrow("does not belong");
    expect(db.query("SELECT count(*) AS n FROM evaluation_evidence_jobs").get()).toEqual({ n: 1 });
  });
  test("corrupt or oversized actual experiment identity is refused before materializing its JSON", () => {
    experiment("corrupt", Date.now());
    db.query("UPDATE evaluation_experiments SET data=? WHERE id='corrupt'").run(" ".repeat(4 * 1024 * 1024 + 1));
    expect(() => inventories.save({ anchor: { kind: "experiment", id: "corrupt" }, expectedRevision: 0, expected })).toThrow("integrity boundary");
    db.exec("UPDATE evaluation_experiments SET data='{}' WHERE id='corrupt'");
    expect(() => inventories.save({ anchor: { kind: "experiment", id: "corrupt" }, expectedRevision: 0, expected })).toThrow("identity changed");
    expect(inventories.save({ anchor: { kind: "run", id: "run-1" }, expectedRevision: 0, expected }).expected).toEqual(expected);
  });
});
