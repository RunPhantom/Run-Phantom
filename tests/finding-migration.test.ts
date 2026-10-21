import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, getDrizzleDb } from "../src/db";

const migrations = path.resolve(import.meta.dir, "../drizzle");
const journal = JSON.parse(fs.readFileSync(path.join(migrations, "meta/_journal.json"), "utf8"));
const finding = journal.entries.find((entry: { tag: string }) => entry.tag === "0009_finding_comparisons");
function priorFolder(root: string, last: number, legacy = false) {
  const folder = path.join(root, "prior");
  const entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= last);
  if (legacy) entries.push({ ...finding, idx: 8, tag: "0008_finding_comparisons" });
  fs.mkdirSync(path.join(folder, "meta"), { recursive: true });
  fs.writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) fs.copyFileSync(path.join(migrations, `${entry.idx === 8 && legacy ? finding.tag : entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
  return folder;
}
function apply(db: Database, folder: string) {
  db.exec("PRAGMA legacy_alter_table=ON; PRAGMA foreign_keys=OFF");
  try { migrate(drizzle(db), { migrationsFolder: folder }); }
  finally { db.exec("PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF"); }
}
function seed(db: Database, legacy: boolean) {
  db.exec("INSERT INTO runs(id,started_at,last_updated_at) VALUES('retained',1,2)");
  db.query("INSERT INTO spans(run_id,id,name,output_payload) VALUES(?,?,?,?)").run("retained", "span", "preserved", '{"exact":"α\\n"}');
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name='evaluation_datasets'").get()) return;
  db.exec("INSERT INTO evaluation_datasets VALUES('dataset','retained',1,1,1)");
  db.query("INSERT INTO evaluation_revisions VALUES(?,?,?,?,?)").run("dataset", 1, "f".repeat(64), '[{"name":"frozen"}]', 1);
  db.query("INSERT INTO evaluation_experiments VALUES(?,?,?,?,?,?,?,?)").run("experiment", "completed", "token", 1, '{"machine":"unchanged"}', '{"verdict":"PASS"}', 1, 2);
  db.query("INSERT INTO evaluation_reviews VALUES(?,?,?,?,?,?)").run("review", "experiment", "case", "good", "retained note", 2);
  if (!legacy) return;
  db.exec("INSERT INTO evaluation_evidence_scopes VALUES('local',1,1)");
  db.exec("INSERT INTO evaluation_evidence_jobs(id,scope_key,scope_generation,operation_key,request_digest,request_data,status,job_token,admitted_at,deadline_at,reserved_raw_bytes,reserved_normalized_bytes) VALUES('job','local',1,'op','digest','{}','completed','token',1,2,0,0)");
  db.query("INSERT INTO evaluation_evidence_sets VALUES('local','set',1,'job',?,'digest',1)").run('{"retained":"set"}');
  db.query("INSERT INTO evaluation_finding_mappings VALUES('local',1,'mapping','set',1,'set',1,?,'digest',1)").run('{"retained":"α\\n"}');
  db.query("INSERT INTO evaluation_finding_comparisons VALUES('local',1,'comparison','op','request','set',1,'set',1,'inspection','a','inspection','b','mapping',?,'digest',2)").run('{"retained":"β\\t"}');
}
function retained(db: Database, legacy: boolean) {
  return ["runs", "evaluation_datasets", "evaluation_revisions", "evaluation_experiments", "evaluation_reviews", ...(legacy ? ["evaluation_evidence_sets", "evaluation_finding_mappings", "evaluation_finding_comparisons"] : [])]
    .map(table => db.query("SELECT 1 FROM sqlite_master WHERE name=?").get(table) ? db.query(`SELECT * FROM ${table}`).all() : []).concat([db.query("SELECT run_id,id,name,output_payload FROM spans").all()]);
}
function fixture(run: (root: string, filename: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "finding-migration-"));
  const previous = process.env.RUNPHANTOM_DB_PATH;
  closeDb(); process.env.RUNPHANTOM_DB_PATH = path.join(root, "workspace.db");
  try { run(root, process.env.RUNPHANTOM_DB_PATH); }
  finally { closeDb(); if (previous === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = previous; fs.rmSync(root, { recursive: true, force: true }); }
}

for (const prior of [null, 5, 7, 8, "legacy"] as const) test(`canonical finding migration upgrades ${prior ?? "fresh"} with retained bytes and second-boot stability`, () => fixture((root, filename) => {
  let before: ReturnType<typeof retained> | undefined, oldHistory: unknown[] = [];
  if (prior !== null) {
    const db = new Database(filename); apply(db, priorFolder(root, prior === "legacy" ? 7 : prior, prior === "legacy"));
    seed(db, prior === "legacy"); before = retained(db, prior === "legacy");
    oldHistory = db.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all(); db.close(true);
  }
  const db = getDrizzleDb().$client;
  expect(db.query("PRAGMA table_info(spans)").all().some((row: unknown) => (row as { name: string }).name === "otlp_evidence")).toBe(true);
  if (before) expect(retained(db, prior === "legacy")).toEqual(before);
  const history = db.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all();
  expect(history).toHaveLength(journal.entries.length);
  for (const old of oldHistory) expect(history).toContainEqual(old);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  closeDb(); const reopened = getDrizzleDb().$client;
  expect(reopened.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all()).toEqual(history);
  if (before) expect(retained(reopened, prior === "legacy")).toEqual(before);
}));

for (const fault of ["hash", "missing-history", "timestamp", "column", "index", "foreign-key", "immutable-trigger", "generation-trigger", "extra-table", "history-index"] as const) test(`legacy finding migration refuses ${fault} without any upgrade writes`, () => fixture((root, filename) => {
  const db = new Database(filename); apply(db, priorFolder(root, 7, true)); seed(db, true);
  if (fault === "hash") db.exec("UPDATE __drizzle_migrations SET hash='unknown' WHERE created_at=1791766000000");
  if (fault === "missing-history") db.exec("DELETE FROM __drizzle_migrations WHERE created_at=1791766000000");
  if (fault === "timestamp") db.exec("UPDATE __drizzle_migrations SET created_at=1791766000001 WHERE created_at=1791766000000");
  if (fault === "column") db.exec("ALTER TABLE spans ADD otlp_evidence text");
  if (fault === "index") db.exec("DROP INDEX finding_mapping_scope");
  if (fault === "foreign-key") { db.exec("PRAGMA foreign_keys=OFF"); db.exec("ALTER TABLE evaluation_finding_mappings RENAME TO obsolete_mapping"); db.exec("CREATE TABLE evaluation_finding_mappings AS SELECT * FROM obsolete_mapping"); }
  if (fault === "immutable-trigger") db.exec("DROP TRIGGER evaluation_finding_mappings_immutable");
  if (fault === "generation-trigger") db.exec("DROP TRIGGER evaluation_finding_generation_revoked");
  if (fault === "extra-table") db.exec("CREATE TABLE unrecognized_state(data text)");
  if (fault === "history-index") db.exec("CREATE UNIQUE INDEX unknown_history_constraint ON __drizzle_migrations(hash)");
  const before = db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
  const history = db.query("SELECT * FROM __drizzle_migrations ORDER BY created_at").all(); db.close(true);
  expect(() => { getDrizzleDb(); }).toThrow("Unrecognized legacy finding migration");
  const reopened = new Database(filename);
  expect(reopened.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(before);
  expect(reopened.query("SELECT * FROM __drizzle_migrations ORDER BY created_at").all()).toEqual(history); reopened.close(true);
}));

test("legacy OTLP backfill rolls back if recording its canonical receipt fails", () => fixture((root, filename) => {
  const db = new Database(filename); apply(db, priorFolder(root, 7, true)); seed(db, true);
  const before = retained(db, true), history = db.query("SELECT * FROM __drizzle_migrations ORDER BY created_at").all(); db.close(true);
  // Fail after SQLite has applied the ALTER, before the receipt can be written.
  const execute = Reflect.get(Database.prototype, "exec") as Database["exec"];
  const failure = spyOn(Database.prototype, "exec").mockImplementation(function (this: Database, sql: string) {
    const result = execute.call(this, sql);
    if (this.filename === filename && sql.includes("ALTER TABLE `spans` ADD `otlp_evidence`")) throw new Error("injected receipt failure");
    return result;
  });
  try { expect(() => { getDrizzleDb(); }).toThrow("injected receipt failure"); }
  finally { failure.mockRestore(); }
  const reopened = new Database(filename);
  expect(reopened.query("PRAGMA table_info(spans)").all().some((row: unknown) => (row as { name: string }).name === "otlp_evidence")).toBe(false);
  expect(retained(reopened, true)).toEqual(before);
  expect(reopened.query("SELECT * FROM __drizzle_migrations ORDER BY created_at").all()).toEqual(history); reopened.close(true);
}));

test("an independent SQLite writer blocks legacy inspection with a bounded honest busy failure", () => fixture((root, filename) => {
  const owner = new Database(filename); apply(owner, priorFolder(root, 7, true)); seed(owner, true);
  const before = retained(owner, true), history = owner.query("SELECT * FROM __drizzle_migrations ORDER BY created_at").all();
  owner.exec("PRAGMA journal_mode=WAL");
  owner.exec("BEGIN IMMEDIATE");
  const started = performance.now();
  try { expect(() => { getDrizzleDb(); }).toThrow("locked"); expect(performance.now() - started).toBeLessThan(2000); }
  finally { owner.exec("ROLLBACK"); }
  expect(retained(owner, true)).toEqual(before);
  expect(owner.query("SELECT * FROM __drizzle_migrations ORDER BY created_at").all()).toEqual(history);
  owner.close(true); expect(getDrizzleDb().$client.query("SELECT count(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: journal.entries.length });
}));

test("two actual processes serialize legacy inspection and record exactly one OTLP backfill", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "finding-migration-race-")), filename = path.join(root, "workspace.db");
  try {
    const db = new Database(filename); apply(db, priorFolder(root, 7, true)); seed(db, true);
    const before = retained(db, true); db.exec("PRAGMA journal_mode=WAL"); db.close(true);
    const worker = path.join(root, "worker.ts");
    fs.writeFileSync(worker, `import { getDrizzleDb,closeDb } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/db.ts"))}; const db=getDrizzleDb().$client;console.log(JSON.stringify(db.query("SELECT count(*) AS n FROM __drizzle_migrations").get()));closeDb();`);
    const children = [0, 1].map(() => Bun.spawn([process.execPath, worker], { stdout: "pipe", stderr: "pipe", env: { ...process.env, RUNPHANTOM_DB_PATH: filename, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" } }));
    const results = await Promise.all(children.map(async child => ({ code: await child.exited, output: await new Response(child.stdout).text(), error: await new Response(child.stderr).text() })));
    for (const result of results) { expect(result.error).toBe(""); expect(result.code).toBe(0); expect(JSON.parse(result.output)).toEqual({ n: journal.entries.length }); }
    const reopened = new Database(filename);
    expect(retained(reopened, true)).toEqual(before);
    expect(reopened.query("SELECT count(*) AS n FROM __drizzle_migrations WHERE created_at=1791757794360").get()).toEqual({ n: 1 });
    expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]); reopened.close(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("canonical migration has the unchanged finding SQL hash and cumulative generated snapshot", () => {
  expect(createHash("sha256").update(fs.readFileSync(path.join(migrations, finding.tag + ".sql"))).digest("hex"))
    .toBe("a963b994517b0725e0794247b4e4207f4f1151457c2f982eabd273c151b1358c");
  const prior = JSON.parse(fs.readFileSync(path.join(migrations, "meta/0008_snapshot.json"), "utf8"));
  const next = JSON.parse(fs.readFileSync(path.join(migrations, "meta/0009_snapshot.json"), "utf8"));
  expect(next.prevId).toBe(prior.id);
  expect(next.tables.spans.columns.otlp_evidence).toEqual(prior.tables.spans.columns.otlp_evidence);
  expect(next.tables.evaluation_finding_mappings).toBeDefined(); expect(next.tables.evaluation_finding_comparisons).toBeDefined();
});
