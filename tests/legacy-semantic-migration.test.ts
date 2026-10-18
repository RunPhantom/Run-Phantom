import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertRecognizedSemanticMigration, bridgeLegacySemanticMigration, SemanticMigrationError } from "../src/db/legacy-semantic-migration";

// Frozen source identities, independently checked against each current immutable SQL file.
// Source-era process/installed fixtures for original PR90/105/122 remain separate gates.
const identities = [
  ["0000_massive_winter_soldier", 1778475472563, "52899c23e0fdf365b2d0e283f11207d8406fd8e3f01acc9f83567d81e279730d"],
  ["0001_cynical_betty_brant", 1778475541625, "c48b564e9ed782d25276077b04a2e207f3f15886245b24a40efff4c274ae4702"],
  ["0002_flowery_shinobi_shaw", 1787429370282, "c761f4aab08c1e08add602bb96a4a70417d1fb4e319544b9dd00a7d0f4bb7010"],
  ["0003_span_identity_per_run", 1787429370283, "7b1e1d7c2d46d593bace5b085b5ece7d91437fc2c49083ad32b8c48017323c11"],
  ["0004_spotty_thunderbolt", 1788822552935, "7299fbdf12b94a15842eb869631ba9d16fedb4efd01785590773d5919c31c1d8"],
  ["0005_sweet_smasher", 1788823828928, "22639daefc1ccbad932e1cb6beabe2a1f8f9fea44de58083f8b31c3189948707"],
  ["0006_lying_proemial_gods", 1788826316549, "a5e09300f1b4500900c3833a8ed7dfb844adf078fb133ca802544dc2ddd7dcdc"],
  ["0007_evidence_storage", 1791756634149, "aef0ee70d71c0ba6bd84061cdd07032455e18f688f0aef2938050be29e00b586"],
  ["0008_otlp_evidence", 1791757794360, "bca976855ea092b54886964466fb7447612cbbfb8c84133565972409a6174069"],
  ["0009_finding_comparisons", 1791766000000, "a963b994517b0725e0794247b4e4207f4f1151457c2f982eabd273c151b1358c"],
  ["0010_coding_hooks", 1791766000001, "0d2d11b4340b76914d46b9113c36bff1c11707f1371a316e08a760c4c7fcffe4"],
  ["0011_review_queues", 1791766000002, "c205637f27e822805e02a117e1c7d5ab806fd5fe5e97983749b726cff65e7c36"],
  ["0012_prompt_registry", 1791766000003, "08959444aed5fb9d1e7e319d7218b2953e678f925c92239299da12b57421dfbc"],
  ["0013_completion_reports", 1791766000004, "8d79d49ff9ac54cad9fbba38a0573fdbac1c59d5325d98d905924ae4c598353e"],
  ["0014_semantic_snapshots", 1791773224836, "69fc773324ff10dda96832470c1e1c5aeb8205f590165ce7f0e116af891f245e"],
] as const;
const migrationsFolder = path.resolve(import.meta.dir, "../drizzle");
const historyDefinitions = [
  'CREATE TABLE "__drizzle_migrations" (\n\t\t\t\tid SERIAL PRIMARY KEY,\n\t\t\t\thash text NOT NULL,\n\t\t\t\tcreated_at numeric\n\t\t\t)',
  'CREATE TABLE "__drizzle_migrations" (\n      id SERIAL PRIMARY KEY,\n      hash text NOT NULL,\n      created_at numeric\n    )',
];
const legacyIndices = [...Array.from({ length: 9 }, (_, index) => index), 14];
const unifiedIndices = identities.map((_, index) => index);
const sqlFor = (index: number) => {
  const [tag, , hash] = identities[index], sql = readFileSync(path.join(migrationsFolder, tag + ".sql"), "utf8");
  expect(createHash("sha256").update(sql).digest("hex")).toBe(hash);
  return sql.split("--> statement-breakpoint");
};
function apply(db: Database, index: number) {
  for (const statement of sqlFor(index)) db.exec(statement);
  const [, when, hash] = identities[index];
  db.query("INSERT INTO __drizzle_migrations(hash,created_at) VALUES(?,?)").run(hash, when);
}
function setup(indices = legacyIndices, definition = historyDefinitions[0], filename = ":memory:") {
  const db = new Database(filename);
  db.exec("PRAGMA legacy_alter_table=ON; PRAGMA foreign_keys=OFF");
  db.exec(definition);
  db.transaction(() => { for (const index of indices) apply(db, index); }).immediate();
  db.exec("PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF");
  return db;
}
function upgrade(db: Database) {
  db.transaction(() => { const validate = bridgeLegacySemanticMigration(db, migrationsFolder); validate?.(); }).immediate();
}
function history(db: Database) { return db.query("SELECT rowid AS receipt_rowid,id,hash,created_at FROM __drizzle_migrations ORDER BY rowid").all(); }
function schema(db: Database) { return db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all(); }
const retainedTables = ["runs", "spans", "verification_flows", "verification_reports", "verification_snapshots", "evaluation_datasets", "evaluation_revisions", "evaluation_evidence_scopes", "evaluation_evidence_jobs", "evaluation_evidence_artifacts", "evaluation_evidence_blobs", "evaluation_evidence_inventory_heads", "evaluation_evidence_inventories", "evaluation_evidence_sets"];
function retained(db: Database) { return retainedTables.map(table => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()); }
function seed(db: Database) {
  db.exec("INSERT INTO runs(id,started_at,last_updated_at) VALUES('retained',1,2)");
  db.query("INSERT INTO spans(run_id,id,name,output_payload,otlp_evidence) VALUES(?,?,?,?,?)").run("retained", "span", "unchanged", '{"exact":"α\\n"}', '{"kind":"reported"}');
  db.exec("INSERT INTO verification_flows VALUES('flow','flow','https://example.test','[]',1)");
  db.query("INSERT INTO verification_reports VALUES(?,?,?,?,?,?,?,?,?,?)").run("report", "session", "retained", "flow", "report", "inconclusive", "retained", '{"exact":"β\\t"}', 1, '{"context":"preserved"}');
  for (const source of ["paired-sdk", "imported-evidence"]) db.query("INSERT INTO verification_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(source, "retained", source === "paired-sdk" ? "session" : null, source, "https://example.test", 1, 2, source, "a".repeat(64), "b".repeat(64), '{"exact":"γ\\r\\n"}');
  db.exec("INSERT INTO evaluation_datasets VALUES('dataset','retained',1,1,1)");
  db.query("INSERT INTO evaluation_revisions VALUES(?,?,?,?,?)").run("dataset", 1, "c".repeat(64), '[{"retained":"case"}]', 1);
  db.exec("INSERT INTO evaluation_evidence_scopes VALUES('local',1,1)");
  db.exec("INSERT INTO evaluation_evidence_jobs(id,scope_key,scope_generation,operation_key,request_digest,request_data,status,job_token,admitted_at,deadline_at,reserved_raw_bytes,reserved_normalized_bytes) VALUES('job','local',1,'op','digest','{}','completed','token',1,2,0,0)");
  db.exec("INSERT INTO evaluation_evidence_artifacts VALUES('local','artifact','job','source','digest',3)");
  db.query("INSERT INTO evaluation_evidence_blobs VALUES('local','artifact',?)").run(new Uint8Array([0, 128, 255]));
  db.exec("INSERT INTO evaluation_evidence_inventory_heads VALUES('local','inventory',1)");
  db.query("INSERT INTO evaluation_evidence_inventories VALUES('local','inventory',1,?,'digest',1)").run('{"retained":"inventory"}');
  db.query("INSERT INTO evaluation_evidence_sets VALUES('local','set',1,'job',?,'digest',1)").run('{"retained":"set"}');
}

for (const [index, definition] of historyDefinitions.entries()) test(`strict semantic L backfill preserves populated bytes and original receipt identities (history form ${index})`, () => {
  const db = setup(legacyIndices, definition), reference = setup(unifiedIndices, definition);
  try {
    seed(db); db.exec("UPDATE __drizzle_migrations SET rowid=rowid+100; UPDATE __drizzle_migrations SET id=700 WHERE created_at=1778475472563; UPDATE __drizzle_migrations SET id='original-S' WHERE created_at=1791773224836");
    const before = retained(db), oldHistory = history(db), changes = db.query("SELECT total_changes() AS n").get();
    expect(assertRecognizedSemanticMigration(db, migrationsFolder)).toBe("legacy");
    expect(db.query("SELECT total_changes() AS n").get()).toEqual(changes);
    upgrade(db);
    expect(assertRecognizedSemanticMigration(db, migrationsFolder)).toBe("unified");
    expect(retained(db)).toEqual(before); expect(schema(db)).toEqual(schema(reference));
    for (const receipt of oldHistory) expect(history(db)).toContainEqual(receipt);
    expect(db.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at,hash").all()).toEqual(identities.map(([, created_at, hash]) => ({ hash, created_at })));
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const unifiedHistory = history(db), unifiedSchema = schema(db), unifiedChanges = db.query("SELECT total_changes() AS n").get();
    upgrade(db); upgrade(db);
    expect(history(db)).toEqual(unifiedHistory); expect(schema(db)).toEqual(unifiedSchema); expect(retained(db)).toEqual(before);
    expect(db.query("SELECT total_changes() AS n").get()).toEqual(unifiedChanges);
    expect(() => db.exec("UPDATE verification_snapshots SET name='changed'")).toThrow("immutable");
    expect(() => db.exec("INSERT INTO verification_snapshots SELECT 'missing-run','absent',session_id,name,origin,captured_at,stored_at,source,content_sha256,coverage_sha256,payload FROM verification_snapshots LIMIT 1")).toThrow("FOREIGN KEY");
    db.exec("INSERT INTO review_queues(id,name,schema_json,schema_hash,created_at) VALUES('new','new','{}','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1)");
    expect(db.query("SELECT name FROM review_queues WHERE id='new'").get()).toEqual({ name: "new" });
    db.exec("DELETE FROM verification_snapshots WHERE id='imported-evidence'");
    expect(db.query("SELECT id FROM verification_snapshots").all()).toHaveLength(1);
    db.exec("WITH RECURSIVE entries(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM entries WHERE n<99) INSERT INTO verification_snapshots SELECT 'capacity-'||n,run_id,NULL,name,origin,captured_at,stored_at,'imported-evidence',content_sha256,coverage_sha256,payload FROM entries CROSS JOIN verification_snapshots WHERE id='paired-sdk'");
    expect(db.query("SELECT count(*) AS n FROM verification_snapshots").get()).toEqual({ n: 100 });
    expect(() => db.exec("INSERT INTO verification_snapshots SELECT 'overflow',run_id,session_id,name,origin,captured_at,stored_at,source,content_sha256,coverage_sha256,payload FROM verification_snapshots LIMIT 1")).toThrow("capacity");
  } finally { db.close(true); reference.close(true); }
});

for (const recognized of [true, false]) test(`semantic dry preflight preserves checkpointed bytes on an actual read-only connection (${recognized ? "recognized" : "refused"})`, () => {
  const root = mkdtempSync(path.join(tmpdir(), "semantic-preflight-")), filename = path.join(root, "owner.sqlite");
  try {
    const writer = setup(legacyIndices, historyDefinitions[0], filename); seed(writer);
    if (!recognized) writer.exec("UPDATE __drizzle_migrations SET hash='unknown' WHERE created_at=1791773224836");
    writer.close(true);
    const before = readFileSync(filename), reader = new Database(filename, { readonly: true, create: false });
    try {
      if (recognized) expect(assertRecognizedSemanticMigration(reader, migrationsFolder)).toBe("legacy");
      else expect(() => assertRecognizedSemanticMigration(reader, migrationsFolder)).toThrow(SemanticMigrationError);
    }
    finally { reader.close(true); }
    expect(readFileSync(filename)).toEqual(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const last of [-1, ...Array.from({ length: 14 }, (_, index) => index)]) test(`semantic helper delegates ordinary canonical prefix ${last} without mutation`, () => {
  const db = last < 0 ? new Database(":memory:") : setup(unifiedIndices.slice(0, last + 1));
  try {
    const before = db.serialize(); expect(assertRecognizedSemanticMigration(db, migrationsFolder)).toBeUndefined();
    db.transaction(() => { expect(bridgeLegacySemanticMigration(db, migrationsFolder)).toBeUndefined(); }).immediate();
    expect(db.serialize()).toEqual(before);
  } finally { db.close(true); }
});

test("semantic helper leaves the recognized pre-OTLP finding lineage to its separate owner", () => {
  const db = setup([...Array.from({ length: 8 }, (_, index) => index), 9]);
  try { expect(assertRecognizedSemanticMigration(db, migrationsFolder)).toBeUndefined(); }
  finally { db.close(true); }
});

const corruptions: Array<[string, (db: Database) => void]> = [
  ["wrong semantic hash", db => db.exec("UPDATE __drizzle_migrations SET hash='unknown' WHERE created_at=1791773224836")],
  ["wrong semantic timestamp", db => db.exec("UPDATE __drizzle_migrations SET created_at=1791773224837 WHERE created_at=1791773224836")],
  ["wrong timestamp type", db => db.exec("UPDATE __drizzle_migrations SET created_at='unknown' WHERE created_at=1791773224836")],
  ["wrong prefix hash", db => db.exec("UPDATE __drizzle_migrations SET hash='unknown' WHERE created_at=1778475472563")],
  ["duplicate semantic receipt", db => db.exec("INSERT INTO __drizzle_migrations(hash,created_at) SELECT hash,created_at FROM __drizzle_migrations WHERE created_at=1791773224836")],
  ["duplicate prefix receipt", db => db.exec("INSERT INTO __drizzle_migrations(hash,created_at) SELECT hash,created_at FROM __drizzle_migrations WHERE created_at=1778475472563")],
  ["semantic table without receipt", db => db.exec("DELETE FROM __drizzle_migrations WHERE created_at=1791773224836")],
  ["semantic receipt without table", db => db.exec("DROP TABLE verification_snapshots")],
  ["altered immutable trigger", db => db.exec("DROP TRIGGER verification_snapshots_no_update; CREATE TRIGGER verification_snapshots_no_update BEFORE UPDATE ON verification_snapshots BEGIN SELECT 1; END")],
  ["altered capacity trigger", db => db.exec("DROP TRIGGER verification_snapshots_capacity; CREATE TRIGGER verification_snapshots_capacity BEFORE INSERT ON verification_snapshots WHEN (SELECT count(*) FROM verification_snapshots)>=101 BEGIN SELECT RAISE(ABORT,'changed'); END")],
  ["missing index", db => db.exec("DROP INDEX idx_verification_snapshots_run")],
  ["altered index", db => db.exec("DROP INDEX idx_verification_snapshots_stored; CREATE INDEX idx_verification_snapshots_stored ON verification_snapshots(id,stored_at)")],
  ["extra business table", db => db.exec("CREATE TABLE sqliteXprivate_state(value text)")],
  ["extra business trigger", db => db.exec("CREATE TRIGGER unknown_trigger AFTER INSERT ON runs BEGIN SELECT 1; END")],
  ["extra column", db => db.exec("ALTER TABLE verification_snapshots ADD unknown text")],
  ["altered table constraint", db => { db.exec("DROP TABLE verification_snapshots"); for (const sql of sqlFor(14)) db.exec(sql.replace("<= 32768", "<= 32769")); }],
  ["history extra column", db => db.exec("ALTER TABLE __drizzle_migrations ADD unknown text")],
  ["history extra index", db => db.exec("CREATE INDEX unknown_history_index ON __drizzle_migrations(hash)")],
  ["history extra trigger", db => db.exec("CREATE TRIGGER unknown_history_trigger AFTER INSERT ON __drizzle_migrations BEGIN SELECT 1; END")],
  ["unknown future receipt", db => db.exec("INSERT INTO __drizzle_migrations(hash,created_at) VALUES('unknown',1791773224837)")],
  ["unpublished F34 receipt", db => db.exec("INSERT INTO __drizzle_migrations(hash,created_at) VALUES('unknown',1791766000005)")],
  ["partial real canonical backfill", db => apply(db, 9)],
  ["mixed finding schema without its receipt", db => { for (const sql of sqlFor(9)) db.exec(sql); }],
  ["broken foreign key", db => { db.exec("PRAGMA foreign_keys=OFF"); db.exec("DELETE FROM evaluation_evidence_jobs"); db.exec("PRAGMA foreign_keys=ON"); }],
  ["failed integrity check", db => { db.exec("PRAGMA ignore_check_constraints=ON"); db.exec("INSERT INTO verification_snapshots VALUES('bad',NULL,NULL,'bad','x',-1,1,'imported-evidence','a','b','{}')"); db.exec("PRAGMA ignore_check_constraints=OFF"); }],
];
for (const [name, corrupt] of corruptions) test(`semantic lineage refuses ${name} before logical writes`, () => {
  const db = setup();
  try {
    seed(db); corrupt(db);
    const before = db.serialize(), originalSchema = schema(db), originalHistory = history(db);
    expect(() => assertRecognizedSemanticMigration(db, migrationsFolder)).toThrow(SemanticMigrationError);
    expect(() => upgrade(db)).toThrow(SemanticMigrationError);
    expect(schema(db)).toEqual(originalSchema); expect(history(db)).toEqual(originalHistory); expect(db.serialize()).toEqual(before);
  } finally { db.close(true); }
});

test("unknown semantic receipt alone never falls through to max-timestamp migration", () => {
  const db = setup(unifiedIndices.slice(0, 9));
  try {
    db.query("INSERT INTO __drizzle_migrations(hash,created_at) VALUES(?,?)").run(identities[14][2], identities[14][1]);
    const before = db.serialize(); expect(() => upgrade(db)).toThrow(SemanticMigrationError); expect(db.serialize()).toEqual(before);
  } finally { db.close(true); }
});

test("semantic bridge refuses execution outside the caller's transaction", () => {
  const db = setup();
  try { const before = db.serialize(); expect(() => bridgeLegacySemanticMigration(db, migrationsFolder)).toThrow("transaction"); expect(db.serialize()).toEqual(before); }
  finally { db.close(true); }
});

for (const needle of ["CREATE TABLE evaluation_finding_mappings", "CREATE TABLE review_queues", "CREATE TABLE evaluation_completion_reports"]) test(`real SQLite DDL rollback after ${needle}`, () => {
  const db = setup();
  try {
    seed(db); const before = retained(db), oldSchema = schema(db), oldHistory = history(db), execute = db.exec.bind(db);
    const failure = spyOn(db, "exec").mockImplementation((sql: string) => { const result = execute(sql); if (sql.includes(needle)) throw new Error("injected after actual DDL"); return result; });
    try { expect(() => upgrade(db)).toThrow("injected after actual DDL"); }
    finally { failure.mockRestore(); }
    expect(schema(db)).toEqual(oldSchema); expect(history(db)).toEqual(oldHistory); expect(retained(db)).toEqual(before);
    expect(assertRecognizedSemanticMigration(db, migrationsFolder)).toBe("legacy"); upgrade(db);
    expect(assertRecognizedSemanticMigration(db, migrationsFolder)).toBe("unified");
  } finally { db.close(true); }
});

test("caller pre-COMMIT failure rolls back all five genuine receipts and DDL", () => {
  const db = setup();
  try {
    seed(db); const before = retained(db), oldSchema = schema(db), oldHistory = history(db);
    expect(() => db.transaction(() => { const validate = bridgeLegacySemanticMigration(db, migrationsFolder); validate?.(); throw new Error("injected before outer commit"); }).immediate()).toThrow("injected before outer commit");
    expect(schema(db)).toEqual(oldSchema); expect(history(db)).toEqual(oldHistory); expect(retained(db)).toEqual(before);
    upgrade(db); expect(assertRecognizedSemanticMigration(db, migrationsFolder)).toBe("unified");
  } finally { db.close(true); }
});

for (const index of [9, 10, 11, 12, 13]) test(`actual SQLite AFTER INSERT receipt failure rolls back canonical migration ${index}`, () => {
  const db = setup();
  try {
    seed(db); const before = retained(db), oldSchema = schema(db), oldHistory = history(db), execute = db.exec.bind(db);
    const firstStatement = sqlFor(index)[0], [, when] = identities[index];
    const failure = spyOn(db, "exec").mockImplementation((sql: string) => {
      const result = execute(sql);
      if (sql === firstStatement) execute(`CREATE TEMP TRIGGER fail_semantic_receipt AFTER INSERT ON main.__drizzle_migrations WHEN NEW.created_at=${when} BEGIN SELECT RAISE(ABORT,'injected actual receipt failure'); END`);
      return result;
    });
    try { expect(() => upgrade(db)).toThrow("injected actual receipt failure"); }
    finally { failure.mockRestore(); }
    expect(schema(db)).toEqual(oldSchema); expect(history(db)).toEqual(oldHistory); expect(retained(db)).toEqual(before);
    expect(assertRecognizedSemanticMigration(db, migrationsFolder)).toBe("legacy"); upgrade(db);
    expect(assertRecognizedSemanticMigration(db, migrationsFolder)).toBe("unified");
  } finally { db.close(true); }
});

for (const column of ["id", "rowid"]) test(`final validation catches old receipt ${column} replacement inside the outer transaction`, () => {
  const db = setup();
  try {
    const before = history(db);
    expect(() => db.transaction(() => {
      const validate = bridgeLegacySemanticMigration(db, migrationsFolder);
      db.exec(`UPDATE __drizzle_migrations SET ${column}=${column === "id" ? "'replaced'" : "rowid+1000"} WHERE created_at=1791773224836`); validate?.();
    }).immediate()).toThrow(SemanticMigrationError);
    expect(history(db)).toEqual(before); expect(assertRecognizedSemanticMigration(db, migrationsFolder)).toBe("legacy");
  } finally { db.close(true); }
});

test("changed packaged SQL is refused before target writes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "semantic-assets-")), db = setup();
  try {
    mkdirSync(path.join(root, "meta")); copyFileSync(path.join(migrationsFolder, "meta/_journal.json"), path.join(root, "meta/_journal.json"));
    for (const [tag] of identities) copyFileSync(path.join(migrationsFolder, tag + ".sql"), path.join(root, tag + ".sql"));
    writeFileSync(path.join(root, identities[9][0] + ".sql"), "CREATE TABLE counterfeit(value text)");
    const before = db.serialize(); expect(() => assertRecognizedSemanticMigration(db, root)).toThrow(SemanticMigrationError); expect(db.serialize()).toEqual(before);
  } finally { db.close(true); rmSync(root, { recursive: true, force: true }); }
});
