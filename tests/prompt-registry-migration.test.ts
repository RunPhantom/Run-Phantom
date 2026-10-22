import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { closeDb, getDrizzleDb } from "../src/db";
import { migrateDatabase } from "../src/db/migrate";
import * as typedSchema from "../src/db/schema";
import { createLocalPromptRegistry } from "../src/prompts/registry";
import { PROMPT_STORAGE_SQL } from "../src/prompts/storage";

const checkout = path.resolve(import.meta.dir, ".."), migrations = path.join(checkout, "drizzle");
const journal = JSON.parse(readFileSync(path.join(migrations, "meta/_journal.json"), "utf8"));
const entry = journal.entries.find((row: { idx: number }) => row.idx === 12);
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
let directory: string, prior: string | undefined;
beforeEach(() => { closeDb(); directory = realpathSync(mkdtempSync(path.join(tmpdir(), "prompt-canonical12-"))); prior = process.env.RUNPHANTOM_DB_PATH; process.env.RUNPHANTOM_DB_PATH = path.join(directory, "actual.db"); });
afterEach(() => { closeDb(); if (prior === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = prior; rmSync(directory, { recursive: true, force: true }); });
function prefix(last: number, suffix = "prefix") {
  const folder = path.join(directory, suffix), entries = journal.entries.filter((row: { idx: number }) => row.idx <= last);
  mkdirSync(path.join(folder, "meta"), { recursive: true }); writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const row of entries) copyFileSync(path.join(migrations, row.tag + ".sql"), path.join(folder, row.tag + ".sql"));
  return folder;
}
function apply(db: Database, folder: string) { db.exec("PRAGMA legacy_alter_table=ON; PRAGMA foreign_keys=OFF"); try { migrateDatabase(db, folder); } finally { db.exec("PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF"); } }
const history = (db: Database) => db.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all();
function seed(db: Database) {
  db.exec("INSERT INTO runs(id,name,started_at,last_updated_at) VALUES('retained','Original source',1,2)");
  db.query("INSERT INTO spans(run_id,id,name,input_payload,output_payload) VALUES('retained','root','Original',?,?)").run("exact α\\n", "exact β\\t");
  db.exec("INSERT INTO evaluation_datasets VALUES('frozen-dataset','Original dataset',1,0,1)");
  db.query("INSERT INTO evaluation_revisions VALUES('frozen-dataset',1,?,'[]',1)").run(digest("[]"));
  db.exec("INSERT INTO evaluation_experiments VALUES('frozen-experiment','completed','original-token',1,'{\"machine\":\"unchanged\"}','{\"verdict\":\"FAIL\"}',1,2)");
  db.query("INSERT INTO review_queues VALUES('retained-queue','Original queue','[]',?,1,1)").run(digest("[]"));
}
function retained(db: Database) { return JSON.stringify(["runs", "spans", "evaluation_datasets", "evaluation_revisions", "evaluation_experiments", "review_queues"].map(table => db.query(`SELECT * FROM ${table}`).all())); }
test("canonical12 appends the approved three-table suffix while every 0..11 SQL and snapshot stays byte-exact", () => {
  expect(journal.entries.slice(0, 13).map((row: { idx: number }) => row.idx)).toEqual(Array.from({ length: 13 }, (_, idx) => idx));
  expect(entry).toEqual({ idx: 12, version: "6", when: 1791766000003, tag: "0012_prompt_registry", breakpoints: true });
  const pins = JSON.parse(readFileSync(`${import.meta.dir}/fixtures/prompt-prefix11-pins.json`, "utf8"));
  for (const [file, sha] of Object.entries(pins)) expect(digest(readFileSync(path.join(checkout, file)))).toBe(sha);
  const old = JSON.parse(readFileSync(path.join(migrations, "meta/0011_snapshot.json"), "utf8")), next = JSON.parse(readFileSync(path.join(migrations, "meta/0012_snapshot.json"), "utf8"));
  expect(next.prevId).toBe(old.id); for (const [name, table] of Object.entries(old.tables)) expect(next.tables[name]).toEqual(table);
  expect(Object.keys(next.tables).filter(name => !Object.hasOwn(old.tables, name)).sort()).toEqual(["prompt_heads", "prompt_revisions", "prompt_scope_controls"]);
  expect(readFileSync(path.join(migrations, entry.tag + ".sql"), "utf8").replaceAll("--> statement-breakpoint\n", "")).toBe(PROMPT_STORAGE_SQL.trimStart());
});
test("actual fresh migration installs prompt tables and trigger with a genuine receipt and no lazy control row", () => {
  const db = getDrizzleDb().$client;
  expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('prompt_heads','prompt_revisions','prompt_scope_controls') ORDER BY name").all()).toEqual(["prompt_heads", "prompt_revisions", "prompt_scope_controls"].map(name => ({ name })));
  expect(db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name='prompt_revision_immutable'").all()).toEqual([{ name: "prompt_revision_immutable" }]);
  expect(history(db)).toHaveLength(journal.entries.length); expect(history(db)[12]).toEqual({ hash: digest(readFileSync(path.join(migrations, entry.tag + ".sql"))), created_at: entry.when });
  expect(db.query("SELECT * FROM prompt_scope_controls").all()).toEqual([]);
  expect(() => createLocalPromptRegistry(db).capture("read")).toThrow("unavailable");
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]); expect(db.query("SELECT * FROM coding_hook_owner").all()).toEqual([]);
});
test("actual prefix11 upgrade preserves source, evaluation, queue, schema and receipt identity across reopen", () => {
  const old = new Database(process.env.RUNPHANTOM_DB_PATH!); apply(old, prefix(11)); seed(old);
  const before = retained(old), receipts = history(old), objects = old.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all() as Array<{ name: string }>;
  old.close(true); let db = getDrizzleDb().$client;
  expect(retained(db)).toBe(before); expect(history(db).slice(0, 12)).toEqual(receipts); expect(history(db)).toHaveLength(journal.entries.length);
  const names = new Set(objects.map(row => row.name)); expect(db.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all().filter(row => names.has((row as { name: string }).name))).toEqual(objects);
  const fullHistory = history(db); closeDb(); db = getDrizzleDb().$client;
  expect(retained(db)).toBe(before); expect(history(db)).toEqual(fullHistory); expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
test("late migration12 failure rolls back all three tables, indexes, trigger and receipt before source repair", () => {
  const db = new Database(process.env.RUNPHANTOM_DB_PATH!); apply(db, prefix(11)); seed(db);
  const before = retained(db), receipts = history(db), objects = db.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
  const broken = prefix(12, "broken"), filename = path.join(broken, entry.tag + ".sql"); writeFileSync(filename, readFileSync(filename, "utf8") + "\n--> statement-breakpoint\nSELECT * FROM intentional_f33_missing_table;\n");
  try { expect(() => apply(db, broken)).toThrow(); expect(retained(db)).toBe(before); expect(history(db)).toEqual(receipts); expect(db.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all()).toEqual(objects); } finally { db.close(true); }
  const repaired = getDrizzleDb().$client; expect(retained(repaired)).toBe(before); expect(history(repaired)).toHaveLength(journal.entries.length); expect(repaired.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
const indexes = [
  { table: "prompt_heads", name: "prompt_heads_create_operation_unique", columns: ["scope_key", "create_operation_key"], unique: 1 },
  { table: "prompt_heads", name: "prompt_heads_scope", columns: ["scope_key", "deleted", "updated_at", "id"], unique: 0 },
  { table: "prompt_revisions", name: "prompt_revisions_operation_unique", columns: ["scope_key", "operation_key"], unique: 1 },
];
test("all three actual named indexes match snapshot names, uniqueness, column order and descending summary columns", () => {
  const db = getDrizzleDb().$client;
  for (const index of indexes) {
    const rows = db.query(`PRAGMA index_list('${index.table}')`).all() as Array<{ name: string }>;
    expect(rows.find(row => row.name === index.name)).toMatchObject({ name: index.name, unique: index.unique, origin: "c", partial: 0 });
    expect((db.query(`PRAGMA index_info('${index.name}')`).all() as Array<{ name: string }>).map(row => row.name)).toEqual(index.columns);
    expect(db.query("SELECT type FROM sqlite_master WHERE name=?").get(index.name)).toEqual({ type: "index" });
  }
  expect((db.query("PRAGMA index_xinfo('prompt_heads_scope')").all() as Array<{ key: number; desc: number }>).filter(row => row.key).map(row => row.desc)).toEqual([0, 0, 1, 1]);
});
test("real next Drizzle generation can drop and recreate all three actual prompt indexes", async () => {
  const db = getDrizzleDb().$client, snapshot = JSON.parse(readFileSync(path.join(migrations, `meta/${String(journal.entries.at(-1).idx).padStart(4, "0")}_snapshot.json`), "utf8"));
  const generated = await generateSQLiteDrizzleJson(typedSchema, snapshot.id); expect(await generateSQLiteMigration(snapshot, generated)).toEqual([]);
  const changed = structuredClone(snapshot); for (const index of indexes) delete changed.tables[index.table].indexes[index.name];
  const removal = await generateSQLiteMigration(snapshot, changed); expect(removal).toHaveLength(3);
  for (const index of indexes) expect(removal).toContain(`DROP INDEX \`${index.name}\`;`);
  expect(() => { for (const sql of removal) db.exec(sql); }).not.toThrow();
  const restoration = await generateSQLiteMigration(changed, snapshot); expect(restoration).toHaveLength(3);
  expect(() => { for (const sql of restoration) db.exec(sql); }).not.toThrow();
  for (const index of indexes) expect((db.query(`PRAGMA index_info('${index.name}')`).all() as Array<{ name: string }>).map(row => row.name)).toEqual(index.columns);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
test("actual source migration and fixed local scope startup preserve immutable revisions across distinct Bun processes without reseeding", () => {
  const old = new Database(process.env.RUNPHANTOM_DB_PATH!); apply(old, prefix(11)); seed(old); const before = retained(old); old.close(true);
  const script = path.join(directory, "reopen.ts");
  writeFileSync(script, `import {getDrizzleDb,closeDb} from ${JSON.stringify(path.join(checkout, "src/db.ts"))}; import {createServer} from ${JSON.stringify(path.join(checkout, "src/server.ts"))}; import {createLocalPromptRegistry} from ${JSON.stringify(path.join(checkout, "src/prompts/registry.ts"))}; import {once} from "node:events"; const {server}=await createServer(0);server.listen(0,"127.0.0.1");await once(server,"listening");const db=getDrizzleDb().$client,registry=createLocalPromptRegistry(db);if(process.argv[2]==="write"){const first=registry.create({operationKey:${JSON.stringify(randomUUID())},name:"Exact",template:"Original {{value}}"},registry.capture("edit"));registry.append(first.id,{operationKey:${JSON.stringify(randomUUID())},name:"Later",template:"New body",expectedRevision:1},registry.capture("edit"));}console.log(JSON.stringify({pid:process.pid,history:db.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all(),heads:db.query("SELECT * FROM prompt_heads").all(),revisions:db.query("SELECT * FROM prompt_revisions ORDER BY revision").all(),controls:db.query("SELECT * FROM prompt_scope_controls").all(),foreignKeys:db.query("PRAGMA foreign_key_check").all()}));await new Promise(resolve=>server.close(resolve));closeDb();`);
  const invoke = (action: string) => { const result = Bun.spawnSync([process.execPath, script, action], { cwd: directory, env: { ...process.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", RUNPHANTOM_CLAUDE_CLI_CHAT: "0" }, timeout: 10000 }); expect(result.exitCode).toBe(0); return JSON.parse(new TextDecoder().decode(result.stdout)); };
  const first = invoke("write"), second = invoke("read");
  expect(first.pid).not.toBe(second.pid); expect(first.pid).not.toBe(process.pid); expect(second.history).toHaveLength(journal.entries.length); expect(second.history).toEqual(first.history);
  expect(second.heads).toEqual(first.heads); expect(second.revisions).toEqual(first.revisions); expect(second.revisions).toHaveLength(2);
  expect(second.controls).toEqual([{ scope_key: "local:local", generation: 1 }]); expect(second.foreignKeys).toEqual([]); expect(retained(getDrizzleDb().$client)).toBe(before);
});
