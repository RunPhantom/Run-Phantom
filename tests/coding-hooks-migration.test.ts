import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import path from "node:path";
import { tmpdir } from "node:os";
import { closeDb, getDrizzleDb } from "../src/db";
import { migrateDatabase } from "../src/db/migrate";

let directory: string, prior: string | undefined;
const migrations = path.resolve(import.meta.dir, "../drizzle"), journal = JSON.parse(readFileSync(path.join(migrations, "meta/_journal.json"), "utf8"));
function prefix(last: number, suffix = "prefix") {
  const folder = path.join(directory, suffix), entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= last); mkdirSync(path.join(folder, "meta"), { recursive: true });
  writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) copyFileSync(path.join(migrations, entry.tag + ".sql"), path.join(folder, entry.tag + ".sql")); return folder;
}
function apply(db: Database, folder: string) { db.exec("PRAGMA legacy_alter_table=ON; PRAGMA foreign_keys=OFF"); try { migrateDatabase(db, folder); } finally { db.exec("PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF"); } }
beforeEach(() => { closeDb(); directory = realpathSync(mkdtempSync(path.join(tmpdir(), "runphantom-f11-migration-"))); prior = process.env.RUNPHANTOM_DB_PATH; process.env.RUNPHANTOM_DB_PATH = path.join(directory, "owner.sqlite"); });
afterEach(() => { closeDb(); if (prior === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = prior; rmSync(directory, { recursive: true, force: true }); });
test("actual fresh source migrations install the four hook tables and both tombstone triggers without activating ownership", () => {
  const db = getDrizzleDb().$client;
  expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'coding_hook_%' ORDER BY name").all()).toEqual(["coding_hook_entities", "coding_hook_installations", "coding_hook_owner", "coding_hook_sessions"].map(name => ({ name })));
  expect(db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'coding_hook_%' ORDER BY name").all()).toEqual([{ name: "coding_hook_run_delete" }, { name: "coding_hook_span_delete" }]);
  expect(db.query("SELECT * FROM coding_hook_owner").all()).toEqual([]);
  expect(db.query("SELECT count(*) count FROM __drizzle_migrations").get()).toEqual({ count: journal.entries.length });
});
test("actual canonical idx9 upgrade preserves original payloads/history and reopens with stable idx10 objects", () => {
  const old = new Database(process.env.RUNPHANTOM_DB_PATH!); apply(old, prefix(9));
  old.exec("INSERT INTO runs(id,started_at,last_updated_at) VALUES('retained',1,2)"); old.query("INSERT INTO spans(run_id,id,name,input_payload,output_payload) VALUES(?,?,?,?,?)").run("retained", "span", "original", '{"exact":"α\\n"}', '{"exact":"β\\t"}');
  old.exec("INSERT INTO evaluation_experiments VALUES('frozen','completed','token',1,'{\"machine\":\"unchanged\"}','{\"verdict\":\"FAIL\"}',1,2)");
  const snapshot = (db: Database) => JSON.stringify(["runs", "spans", "evaluation_experiments"].map(table => db.query(`SELECT * FROM ${table}`).all()));
  const before = snapshot(old), oldHistory = old.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all(); old.close(true);
  const db = getDrizzleDb().$client; expect(snapshot(db)).toBe(before); const history = db.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all(); expect(history.slice(0, 10)).toEqual(oldHistory); expect(history).toHaveLength(journal.entries.length);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]); const objects = db.query("SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'coding_hook_%' OR name='idx_coding_hook_sessions_run' ORDER BY name").all(); closeDb();
  const reopened = getDrizzleDb().$client; expect(snapshot(reopened)).toBe(before); expect(reopened.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all()).toEqual(history); expect(reopened.query("SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'coding_hook_%' OR name='idx_coding_hook_sessions_run' ORDER BY name").all()).toEqual(objects);
});
test("idx10 failure rolls back all new objects and its journal receipt on an actual prior database", () => {
  const db = new Database(process.env.RUNPHANTOM_DB_PATH!); apply(db, prefix(9)); const history = db.query("SELECT * FROM __drizzle_migrations").all(), objects = db.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
  const broken = prefix(10, "broken"), file = path.join(broken, "0010_coding_hooks.sql"); writeFileSync(file, readFileSync(file, "utf8") + "\n--> statement-breakpoint\nSELECT * FROM intentional_f11_missing_table;\n");
  try { expect(() => apply(db, broken)).toThrow(); expect(db.query("SELECT * FROM __drizzle_migrations").all()).toEqual(history); expect(db.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all()).toEqual(objects); } finally { db.close(true); }
  expect(getDrizzleDb().$client.query("SELECT count(*) count FROM __drizzle_migrations").get()).toEqual({ count: journal.entries.length });
});
test("exact idx10 constraints, unique identities and both suppression triggers survive actual reopen", () => {
  let db = getDrizzleDb().$client; db.query("INSERT INTO coding_hook_owner VALUES(1,?,?,1)").run("a".repeat(32), "b".repeat(32));
  expect(() => db.query("INSERT INTO coding_hook_owner VALUES(2,?,?,1)").run("a".repeat(32), "b".repeat(32))).toThrow();
  const session = (key: string, run: string) => db.query("INSERT INTO coding_hook_sessions VALUES(?,1,?,?,?,'open',NULL,NULL,0,0,0,'{}',1,1)").run(key, "c".repeat(64), run, "d".repeat(16));
  const run = "e".repeat(32), key = "f".repeat(64); session(key, run); expect(() => session("1".repeat(64), run)).toThrow();
  db.query("INSERT INTO runs(id,started_at,last_updated_at) VALUES(?,1,1)").run(run); db.query("INSERT INTO spans(id,run_id,name) VALUES(?,?,'original')").run("1".repeat(16), run);
  db.query("DELETE FROM spans WHERE run_id=?").run(run); expect(db.query("SELECT state,source_cursor,data FROM coding_hook_sessions WHERE source_key=?").get(key)).toEqual({ state: "suppressed", source_cursor: 0, data: '{"capture":"suppressed","reason":"anchor_replaced"}' });
  const secondRun = "2".repeat(32), secondKey = "3".repeat(64); session(secondKey, secondRun); db.query("INSERT INTO runs(id,started_at,last_updated_at) VALUES(?,1,1)").run(secondRun); db.query("DELETE FROM runs WHERE id=?").run(secondRun);
  closeDb(); db = getDrizzleDb().$client; expect(db.query("SELECT state,data FROM coding_hook_sessions WHERE source_key=?").get(secondKey)).toEqual({ state: "suppressed", data: '{"capture":"suppressed","reason":"anchor_deleted"}' }); expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
