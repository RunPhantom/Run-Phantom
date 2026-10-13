import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { closeDb, getDrizzleDb } from "../src/db";
import { migrateDatabase } from "../src/db/migrate";
import * as typedSchema from "../src/db/schema";
import { COMPLETION_STORAGE_SQL } from "../src/claims/storage";
import { createLocalPromptRegistry } from "../src/prompts/registry";

const checkout = path.resolve(import.meta.dir, ".."), migrations = path.join(checkout, "drizzle");
const journal = JSON.parse(readFileSync(path.join(migrations, "meta/_journal.json"), "utf8"));
const entry = journal.entries.find((row: { idx: number }) => row.idx === 13);
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
let directory: string, prior: string | undefined;
beforeEach(() => { closeDb(); directory = realpathSync(mkdtempSync(path.join(tmpdir(), "completion-canonical13-"))); prior = process.env.RUNPHANTOM_DB_PATH; process.env.RUNPHANTOM_DB_PATH = path.join(directory, "actual.db"); });
afterEach(() => { closeDb(); if (prior === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = prior; rmSync(directory, { recursive: true, force: true }); });
function prefix(last: number, suffix = "prefix") {
  const folder = path.join(directory, suffix), entries = journal.entries.filter((row: { idx: number }) => row.idx <= last);
  mkdirSync(path.join(folder, "meta"), { recursive: true }); writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const row of entries) copyFileSync(path.join(migrations, row.tag + ".sql"), path.join(folder, row.tag + ".sql"));
  return folder;
}
function apply(db: Database, folder: string) { db.exec("PRAGMA legacy_alter_table=ON; PRAGMA foreign_keys=OFF"); try { migrateDatabase(db, folder); } finally { db.exec("PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF"); } }
const history = (db: Database) => db.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all();
const witnessTables = ["runs", "spans", "evaluation_datasets", "evaluation_revisions", "evaluation_experiments", "review_queues", "prompt_scope_controls", "prompt_heads", "prompt_revisions"];
function seed(db: Database) {
  db.exec("INSERT INTO runs(id,name,started_at,last_updated_at) VALUES('observer-run','Original source',1,2)");
  db.query("INSERT INTO spans(run_id,id,name,input_payload,output_payload) VALUES('observer-run','root','Original',?,?)").run("exact α\n", "exact β\t");
  db.exec("INSERT INTO evaluation_datasets VALUES('frozen-dataset','Original dataset',1,0,1)");
  db.query("INSERT INTO evaluation_revisions VALUES('frozen-dataset',1,?,'[]',1)").run(digest("[]"));
  db.exec("INSERT INTO evaluation_experiments VALUES('frozen-experiment','completed','original-token',1,'{\"machine\":\"unchanged\"}','{\"verdict\":\"FAIL\"}',1,2)");
  db.query("INSERT INTO review_queues VALUES('retained-queue','Original queue','[]',?,1,1)").run(digest("[]"));
  db.exec("INSERT INTO evaluation_evidence_scopes VALUES('local:local',1,1); INSERT INTO prompt_scope_controls VALUES('local:local',1)");
  const prompts = createLocalPromptRegistry(db), first = prompts.create({ operationKey: "00000000-0000-4000-8000-000000000001", name: "Original prompt", template: "Exact {{value}}" }, prompts.capture("edit"));
  prompts.append(first.id, { operationKey: "00000000-0000-4000-8000-000000000002", name: "Retained prompt", template: "Later exact body", expectedRevision: 1 }, prompts.capture("edit"));
}
function retained(db: Database) { return JSON.stringify(witnessTables.map(table => db.query(`SELECT * FROM ${table}`).all())); }
test("canonical13 appends only the approved two-table suffix while every0..12 migration and prior37 snapshot tables stay exact", () => {
  expect(journal.entries.map((row: { idx: number }) => row.idx)).toEqual(Array.from({ length: 14 }, (_, idx) => idx));
  expect(entry).toEqual({ idx: 13, version: "6", when: 1791766000004, tag: "0013_completion_reports", breakpoints: true });
  const pins = JSON.parse(readFileSync(`${import.meta.dir}/fixtures/claims-prefix12-pins.json`, "utf8")) as { journal: { entries: unknown[] }; files: Record<string, string> };
  expect(journal.entries.slice(0, 13)).toEqual(pins.journal.entries);
  for (const [file, sha] of Object.entries(pins.files)) expect(digest(readFileSync(path.join(checkout, file)))).toBe(sha);
  const old = JSON.parse(readFileSync(path.join(migrations, "meta/0012_snapshot.json"), "utf8")), next = JSON.parse(readFileSync(path.join(migrations, "meta/0013_snapshot.json"), "utf8"));
  expect(Object.keys(old.tables)).toHaveLength(37); expect(next.prevId).toBe(old.id); expect(next.internal).toEqual(old.internal);
  for (const [name, table] of Object.entries(old.tables)) expect(next.tables[name]).toEqual(table);
  expect(Object.keys(next.tables).filter(name => !Object.hasOwn(old.tables, name)).sort()).toEqual(["evaluation_completion_payloads", "evaluation_completion_reports"]);
  expect(readFileSync(path.join(migrations, entry.tag + ".sql"), "utf8").replaceAll("--> statement-breakpoint\n", "")).toBe(COMPLETION_STORAGE_SQL.trimStart());
});
test("actual fresh migration installs two completion tables and four triggers with a genuine receipt and no lazy records", () => {
  const db = getDrizzleDb().$client;
  expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'evaluation_completion_%' ORDER BY name").all()).toEqual(["evaluation_completion_payloads", "evaluation_completion_reports"].map(name => ({ name })));
  expect(db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'evaluation_completion_%' ORDER BY name").all()).toHaveLength(4);
  expect(history(db)).toHaveLength(14); expect(history(db).at(-1)).toEqual({ hash: digest(readFileSync(path.join(migrations, entry.tag + ".sql"))), created_at: entry.when });
  expect(db.query("SELECT * FROM evaluation_completion_reports").all()).toEqual([]); expect(db.query("SELECT * FROM evaluation_completion_payloads").all()).toEqual([]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]); expect(db.query("SELECT * FROM coding_hook_owner").all()).toEqual([]);
});
test("actual prefix12 upgrade preserves source, frozen verdict, queue, prompt witnesses, catalog and receipts across reopen", () => {
  const old = new Database(process.env.RUNPHANTOM_DB_PATH!); apply(old, prefix(12)); seed(old);
  const before = retained(old), receipts = history(old), objects = old.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all() as Array<{ name: string }>;
  old.close(true); let db = getDrizzleDb().$client;
  expect(retained(db)).toBe(before); expect(history(db).slice(0, 13)).toEqual(receipts); expect(history(db)).toHaveLength(14);
  const names = new Set(objects.map(row => row.name)); expect(db.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all().filter(row => names.has((row as { name: string }).name))).toEqual(objects);
  const fullHistory = history(db); closeDb(); db = getDrizzleDb().$client;
  expect(retained(db)).toBe(before); expect(history(db)).toEqual(fullHistory); expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
test("late migration13 failure rolls back both tables, indexes, four triggers and receipt before repair", () => {
  const db = new Database(process.env.RUNPHANTOM_DB_PATH!); apply(db, prefix(12)); seed(db);
  const before = retained(db), receipts = history(db), objects = db.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
  const broken = prefix(13, "broken"), filename = path.join(broken, "0013_completion_reports.sql"); writeFileSync(filename, readFileSync(filename, "utf8") + "\n--> statement-breakpoint\nSELECT * FROM intentional_f08_missing_table;\n");
  try { expect(() => apply(db, broken)).toThrow(); expect(retained(db)).toBe(before); expect(history(db)).toEqual(receipts); expect(db.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all()).toEqual(objects); } finally { db.close(true); }
  const repaired = getDrizzleDb().$client; expect(retained(repaired)).toBe(before); expect(history(repaired)).toHaveLength(14); expect(repaired.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
const indexes = [
  { table: "evaluation_completion_reports", name: "completion_report_operation_unique", columns: ["scope_key", "scope_generation", "operation_key"], unique: 1 },
  { table: "evaluation_completion_reports", name: "completion_report_attachment", columns: ["scope_key", "scope_generation", "attachment_kind", "attachment_id", "created_at", "id"], unique: 0 },
];
test("actual completion named indexes match snapshot uniqueness and exact column order", () => {
  const db = getDrizzleDb().$client;
  for (const index of indexes) {
    const rows = db.query(`PRAGMA index_list('${index.table}')`).all() as Array<{ name: string }>;
    expect(rows.find(row => row.name === index.name)).toMatchObject({ name: index.name, unique: index.unique, origin: "c", partial: 0 });
    expect((db.query(`PRAGMA index_info('${index.name}')`).all() as Array<{ name: string }>).map(row => row.name)).toEqual(index.columns);
  }
});
test("real next Drizzle generation has no delta and can drop and recreate both actual completion indexes", async () => {
  const db = getDrizzleDb().$client, snapshot = JSON.parse(readFileSync(path.join(migrations, "meta/0013_snapshot.json"), "utf8"));
  const generated = await generateSQLiteDrizzleJson(typedSchema, snapshot.id); expect(await generateSQLiteMigration(snapshot, generated)).toEqual([]);
  const changed = structuredClone(snapshot); for (const index of indexes) delete changed.tables[index.table].indexes[index.name];
  const removal = await generateSQLiteMigration(snapshot, changed); expect(removal).toHaveLength(2);
  for (const index of indexes) expect(removal).toContain(`DROP INDEX \`${index.name}\`;`);
  expect(() => { for (const sql of removal) db.exec(sql); }).not.toThrow();
  const restoration = await generateSQLiteMigration(changed, snapshot); expect(restoration).toHaveLength(2);
  expect(() => { for (const sql of restoration) db.exec(sql); }).not.toThrow();
  for (const index of indexes) expect((db.query(`PRAGMA index_info('${index.name}')`).all() as Array<{ name: string }>).map(row => row.name)).toEqual(index.columns);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
test("two distinct actual server processes reopen the same migrated DB without reseeding and preserve exact history before retention and clear", () => {
  const old = new Database(process.env.RUNPHANTOM_DB_PATH!); apply(old, prefix(12)); seed(old); const before = retained(old); old.close(true);
  const fixture = path.join(import.meta.dir, "fixtures/claims-native-process.ts");
  const invoke = (action: string) => { const result = Bun.spawnSync([process.execPath, fixture, action], { cwd: directory, env: { PATH: process.env.PATH, RUNPHANTOM_DB_PATH: process.env.RUNPHANTOM_DB_PATH!, RUNPHANTOM_CLAUDE_CLI_CHAT: "0" }, timeout: 15000 }); expect(new TextDecoder().decode(result.stderr)).toBe(""); expect(result.exitCode).toBe(0); return JSON.parse(new TextDecoder().decode(result.stdout)); };
  const first = invoke("write"), second = invoke("read-retain-clear");
  expect(first.pid).not.toBe(second.pid); expect(first.pid).not.toBe(process.pid); expect(second.history).toHaveLength(14); expect(second.history).toEqual(first.history);
  expect(second.saved).toEqual(first.saved); expect(second.saved.request.summary).toBe("Original α summary.\nNot all tests pass."); expect(second.immutableRefused).toBe(true);
  expect(second.oversizeStatus).toBe(413); expect(second.wrongRevisionStatus).toBe(409); expect(second.normalizedDeleteStatus).toBe(200); expect(second.deletedReadStatus).toBe(404);
  expect(second.tombstone.items[0].payloadAvailable).toBe(false); expect(second.livePayloads).toEqual([]); expect(second.afterClear).toEqual([]); expect(second.foreignKeys).toEqual([]);
  expect(retained(getDrizzleDb().$client)).toBe(before);
  if (process.env.F08_CANONICAL13_PROOF_FILE) writeFileSync(process.env.F08_CANONICAL13_PROOF_FILE, JSON.stringify({ first, second, witnessBefore: before, witnessAfter: retained(getDrizzleDb().$client) }, null, 2) + "\n");
});
