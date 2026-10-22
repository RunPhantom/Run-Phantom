import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { migrateDatabase } from "../src/db/migrate";
import * as typedSchema from "../src/db/schema";
import { createLocalPromptRegistry } from "../src/prompts/registry";
import { createComparisonRuntime, initializeComparisonScope } from "../src/prompts/comparison-runtime";

const migrations = path.resolve(import.meta.dir, "../drizzle"), journal = JSON.parse(readFileSync(path.join(migrations, "meta/_journal.json"), "utf8"));
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const currentHistory = () => journal.entries.map((entry: { tag: string; when: number }) => ({ hash: digest(readFileSync(path.join(migrations, entry.tag + ".sql"))), created_at: entry.when }));
let directory: string, db: Database, runtime: Awaited<ReturnType<typeof createComparisonRuntime>> | undefined;
beforeEach(() => { directory = realpathSync(mkdtempSync(path.join(tmpdir(), "rp-comparison-canonical14-"))); db = new Database(path.join(directory, "owner.sqlite")); });
afterEach(async () => { await runtime?.close(); runtime = undefined; db.close(); rmSync(directory, { recursive: true, force: true }); });
function prefix(last: number, suffix = "prefix") {
  const folder = path.join(directory, suffix), entries = journal.entries.filter((row: { idx: number }) => row.idx <= last);
  mkdirSync(path.join(folder, "meta"), { recursive: true }); writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const row of entries) copyFileSync(path.join(migrations, row.tag + ".sql"), path.join(folder, row.tag + ".sql")); return folder;
}
function apply(folder: string) { db.exec("PRAGMA legacy_alter_table=ON; PRAGMA foreign_keys=OFF"); try { migrateDatabase(db, folder); } finally { db.exec("PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF"); } }
function witness() {
  const objects = db.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all() as { name: string; type: string }[];
  return { objects, tables: Object.fromEntries(objects.filter(row => row.type === "table").map(row => {
    const name = '"' + row.name.replaceAll('"', '""') + '"';
    return [row.name, db.query(`SELECT * FROM ${name} ORDER BY ${db.query(`PRAGMA table_info(${name})`).all().map((_column, index) => index + 1).join(",")}`).all()];
  })) };
}
function seed() {
  db.exec("INSERT INTO runs(id,name,started_at,last_updated_at) VALUES('comparison-preserved-run','Original source',1,2)");
  db.query("INSERT INTO spans(run_id,id,name,input_payload,output_payload) VALUES('comparison-preserved-run','root','Original',?,?)").run("exact α\n", "exact β\t");
  db.exec("INSERT INTO evaluation_datasets VALUES('frozen-dataset','Original dataset',1,0,1)");
  db.query("INSERT INTO evaluation_revisions VALUES('frozen-dataset',1,?,'[]',1)").run(digest("[]"));
  db.exec("INSERT INTO evaluation_experiments VALUES('frozen-experiment','completed','original-token',1,'{\"machine\":\"unchanged\"}','{\"verdict\":\"FAIL\"}',1,2)");
  db.query("INSERT INTO review_queues VALUES('retained-queue','Original queue','[]',?,1,1)").run(digest("[]"));
  db.exec("INSERT INTO evaluation_evidence_scopes VALUES('local:local',1,1); INSERT INTO prompt_scope_controls VALUES('local:local',1)");
  const prompts = createLocalPromptRegistry(db);
  return prompts.create({ operationKey: "00000000-0000-4000-8000-000000000001", name: "Preserved prompt", template: "Exact {{value}}" }, prompts.capture("edit"));
}
test("actual canonical14 preserves the complete prefix13 catalog, every physical row and all receipts across same-inode reopen", async () => {
  apply(prefix(13)); const source = seed(), before = witness(), filename = db.filename, inode = statSync(filename).ino;
  expect((before.tables.__drizzle_migrations as unknown[]).length).toBe(14); apply(migrations);
  const after = witness(), oldNames = new Set(before.objects.map(row => row.name));
  expect(after.objects.filter(row => oldNames.has(row.name))).toEqual(before.objects);
  for (const [table, rows] of Object.entries(before.tables)) {
    if (table === "__drizzle_migrations") expect((after.tables[table] as { created_at: number }[]).filter(row => row.created_at < 1791766000005) as unknown[]).toEqual(rows);
    else expect(after.tables[table]).toEqual(rows);
  }
  const history = db.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all();
  expect(history).toEqual(currentHistory()); expect(history[14]).toEqual({ hash: "5739e20dc98a32fbb5db8c08833c78f4cb665fef1593e1e1ea80b36a48160726", created_at: 1791766000005 });
  expect(statSync(filename).ino).toBe(inode); expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" }); expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  const owner = { database: db, scope: { kind: "local" as const, id: "local" as const }, authorize() {} };
  runtime = await createComparisonRuntime(db, { budgets: { openai: 0, anthropic: 0 } }); initializeComparisonScope(owner);
  const store = runtime.scope(owner); expect(store.capabilities(store.capture("read")).models.every(model => !model.spendingEnabled)).toBe(true);
  const receipt = runtime.coordinator.submit(store, { operationKey: "00000000-0000-4000-8000-000000000002", promptId: source.id, revision: 1,
    variables: { value: "literal fixture" }, targets: [{ provider: "openai", model: "gpt-4.1" }], options: { maxOutputTokens: 128, temperature: 0 }, operationBudgetMicrousd: 1000000, expectedGeneration: 1 }, store.capture("edit"));
  await runtime.coordinator.idle(); expect(["unavailable", "budget_refused"]).toContain(receipt.attempts[0].status);
  await runtime.close(); runtime = undefined; const complete = witness(); db.close(); db = new Database(filename); db.exec("PRAGMA foreign_keys=ON");
  expect(statSync(filename).ino).toBe(inode); expect(witness()).toEqual(complete); expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
test("canonical14 uses the reserved genuine journal entry and exact reviewed SQL with no snapshot drift", async () => {
  expect(journal.entries.slice(0, 15).map((row: { idx: number }) => row.idx)).toEqual(Array.from({ length: 15 }, (_value, idx) => idx));
  expect(journal.entries[14]).toEqual({ idx: 14, version: "6", when: 1791766000005, tag: "0014_prompt_comparisons", breakpoints: true });
  const bytes = readFileSync(path.join(migrations, "0014_prompt_comparisons.sql")); expect(bytes.byteLength).toBe(8330); expect(digest(bytes)).toBe("5739e20dc98a32fbb5db8c08833c78f4cb665fef1593e1e1ea80b36a48160726");
  const old = JSON.parse(readFileSync(path.join(migrations, "meta/0013_snapshot.json"), "utf8")), current = JSON.parse(readFileSync(path.join(migrations, "meta/0014_snapshot.json"), "utf8"));
  expect(current.prevId).toBe(old.id); for (const [name, table] of Object.entries(old.tables)) expect(current.tables[name]).toEqual(table); expect(current.views).toEqual(old.views);
  expect(Object.keys(current.tables).filter(name => !Object.hasOwn(old.tables, name)).sort()).toEqual(["comparison_scope_controls", "prompt_comparison_attempts", "prompt_comparisons"]);
  const latest = JSON.parse(readFileSync(path.join(migrations, `meta/${String(journal.entries.at(-1).idx).padStart(4, "0")}_snapshot.json`), "utf8"));
  expect(await generateSQLiteMigration(latest, await generateSQLiteDrizzleJson(typedSchema, latest.id))).toEqual([]);
});
test("a late canonical14 failure rolls back all comparison tables/triggers/indexes and the receipt while old data stays exact", () => {
  apply(prefix(13)); seed(); const before = witness(), broken = prefix(14, "broken"), filename = path.join(broken, "0014_prompt_comparisons.sql");
  writeFileSync(filename, readFileSync(filename, "utf8") + "\n--> statement-breakpoint\nSELECT * FROM intentional_comparison_missing_table;\n");
  expect(() => apply(broken)).toThrow(); expect(witness()).toEqual(before); apply(migrations);
  expect(db.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all()).toEqual(currentHistory()); expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
