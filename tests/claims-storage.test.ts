import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { EVIDENCE_STORAGE_SQL } from "../src/evaluations/evidence-store";
import { COMPLETION_STORAGE_SQL } from "../src/claims/storage";
import { evidenceDigest } from "../src/evaluations/evidence-validation";

function fixture(install: boolean) {
  const db = new Database(":memory:"); db.exec("PRAGMA foreign_keys=ON"); db.exec(EVIDENCE_STORAGE_SQL);
  db.exec("INSERT INTO evaluation_evidence_scopes VALUES('local:local',1,1)");
  db.exec("INSERT INTO evaluation_evidence_jobs(id,scope_key,scope_generation,operation_key,request_digest,request_data,status,job_token,admitted_at,deadline_at,reserved_raw_bytes,reserved_normalized_bytes) VALUES('job','local:local',1,'import','hash','{}','completed','token',1,2,0,0)");
  db.exec("INSERT INTO evaluation_evidence_sets VALUES('local:local','set',1,'job','{}','hash',1)");
  if (install) db.exec(COMPLETION_STORAGE_SQL);
  return db;
}
function insert(db: Database, summary = "Original α summary") {
  const data = JSON.stringify({ summary, detectorVersion: "completion-spans/v1", observations: [] }), digest = evidenceDigest(data);
  db.query("INSERT INTO evaluation_completion_reports VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("local:local", 1, "report", "operation", digest, "run", "run", "set", 1, "completion-spans/v1", evidenceDigest(summary), digest, Buffer.byteLength(data), 1);
  db.query("INSERT INTO evaluation_completion_payloads VALUES(?,?,?)").run("local:local", "report", data); return data;
}
test("proposed observer storage refuses missing schema before any payload publication", () => {
  const db = fixture(false); try { expect(() => insert(db)).toThrow("no such table"); } finally { db.close(); }
});
test("inactive observer schema preserves immutable UTF8, source retention deletion and generation clear", () => {
  const db = fixture(true); try {
    const data = insert(db);
    expect(db.query("SELECT data FROM evaluation_completion_payloads").get()).toEqual({ data });
    expect(() => db.exec("UPDATE evaluation_completion_payloads SET data='{}'")).toThrow("immutable");
    expect(() => db.exec("UPDATE evaluation_completion_reports SET detector_version='other'")).toThrow("immutable");
    db.exec("INSERT INTO evaluation_evidence_retention_events VALUES('deletion','local:local','set',1,'interpretation','normalized_removed','operator',2)");
    expect(db.query("SELECT data FROM evaluation_completion_payloads").all()).toEqual([]);
    expect(db.query("SELECT id FROM evaluation_completion_reports").all()).toEqual([{ id: "report" }]);
    db.exec("UPDATE evaluation_evidence_scopes SET generation=2 WHERE scope_key='local:local'");
    expect(db.query("SELECT id FROM evaluation_completion_reports").all()).toEqual([]); expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});
