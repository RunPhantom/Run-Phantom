import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearAll, closeDb, getDrizzleDb } from "../src/db";
import { migrateDatabase } from "../src/db/migrate";
import { createReviewQueue, insertReviewItem } from "../src/review-queues/store";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import * as typedSchema from "../src/db/schema";

const checkout = path.resolve(import.meta.dir,".."), migrations = path.join(checkout,"drizzle");
const journal = JSON.parse(readFileSync(path.join(migrations,"meta/_journal.json"),"utf8"));
let directory: string, prior: string | undefined;
beforeEach(() => { closeDb(); directory=realpathSync(mkdtempSync(path.join(tmpdir(),"rq-canonical-prefix11-"))); prior=process.env.RUNPHANTOM_DB_PATH; process.env.RUNPHANTOM_DB_PATH=path.join(directory,"actual.db"); });
afterEach(() => { closeDb(); if (prior===undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH=prior; rmSync(directory,{ recursive:true,force:true }); });
function prefix(last: number, suffix="prefix") {
  const folder=path.join(directory,suffix),entries=journal.entries.filter((row:{idx:number})=>row.idx<=last); mkdirSync(path.join(folder,"meta"),{ recursive:true });
  writeFileSync(path.join(folder,"meta/_journal.json"),JSON.stringify({ ...journal,entries }));
  for (const entry of entries) copyFileSync(path.join(migrations,`${entry.tag}.sql`),path.join(folder,`${entry.tag}.sql`)); return folder;
}
function apply(db: Database, folder: string) { db.exec("PRAGMA legacy_alter_table=ON; PRAGMA foreign_keys=OFF"); try { migrateDatabase(db,folder); } finally { db.exec("PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF"); } }
function seed(db: Database) {
  db.exec("INSERT INTO runs(id,name,started_at,last_updated_at) VALUES('retained-source','Original source',1,2)");
  db.query("INSERT INTO spans(run_id,id,name,span_type,status,input_payload,output_payload,attributes,start_time_ms,end_time_ms) VALUES('retained-source','root','Original response','AGENT_ROOT','OK',?,?,'{}',1,2)").run('Input α\\n','Frozen output β\\t');
  db.exec("INSERT INTO evaluation_datasets VALUES('retained-dataset','Original dataset',1,0,1)");
  db.query("INSERT INTO evaluation_revisions VALUES('retained-dataset',1,?,'[]',1)").run(createHash("sha256").update("[]").digest("hex"));
  db.exec("INSERT INTO evaluation_experiments VALUES('retained-experiment','completed','original-token',1,'{\"machine\":\"unchanged\"}','{\"verdict\":\"FAIL\"}',1,2)");
}
function retained(db: Database) { return JSON.stringify(["runs","spans","evaluation_datasets","evaluation_revisions","evaluation_experiments"].map(table=>db.query(`SELECT * FROM ${table}`).all())); }
function history(db: Database) { return db.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all(); }

test("canonical idx11 preserves approved row semantics with only the authorized named-index amendment and preserves every prior snapshot table", () => {
  expect(journal.entries.slice(0,12).map((row:{idx:number})=>row.idx)).toEqual(Array.from({ length:12 },(_,idx)=>idx));
  expect(journal.entries[11]).toEqual({ idx:11,version:"6",when:1791766000002,tag:"0011_review_queues",breakpoints:true });
  const sql=readFileSync(path.join(migrations,"0011_review_queues.sql"),"utf8");
  const amended = sql.replaceAll("--> statement-breakpoint\n", "");
  expect(createHash("sha256").update(amended).digest("hex")).toBe("1d1ce8d6c1e99b229f69069270af373b69c13295df17e09fad4c760fab0cb062");
  const original = amended
    .replace("CREATE UNIQUE INDEX review_queue_items_ordinal_unique ON review_queue_items(queue_id, ordinal);\n", "")
    .replace("CREATE UNIQUE INDEX review_queue_items_source_unique ON review_queue_items(queue_id, source_run_id, source_span_key);\n", "")
    .replace("CREATE UNIQUE INDEX review_queue_promotions_key_unique ON review_queue_promotions(queue_id, idempotency_key);\n", "")
    .replace("    OR (state = 'promoted' AND promoted_dataset_id IS NOT NULL AND promoted_dataset_version IS NOT NULL AND promoted_case_id IS NOT NULL))\n);", "    OR (state = 'promoted' AND promoted_dataset_id IS NOT NULL AND promoted_dataset_version IS NOT NULL AND promoted_case_id IS NOT NULL)),\n  UNIQUE(queue_id, ordinal),\n  UNIQUE(queue_id, source_run_id, source_span_key)\n);")
    .replace("  FOREIGN KEY(dataset_id, dataset_version)", "  UNIQUE(queue_id, idempotency_key),\n  FOREIGN KEY(dataset_id, dataset_version)");
  expect(createHash("sha256").update(original).digest("hex")).toBe("496af813726aff4be22a9ffb9b00c7e8b82eda5daa295d45c4ea180b64fceb54");
  const old=JSON.parse(readFileSync(path.join(migrations,"meta/0010_snapshot.json"),"utf8")),next=JSON.parse(readFileSync(path.join(migrations,"meta/0011_snapshot.json"),"utf8"));
  expect(next.prevId).toBe(old.id); for (const [name,table] of Object.entries(old.tables)) expect(next.tables[name]).toEqual(table);
  expect(Object.keys(next.tables).filter(name=>!Object.hasOwn(old.tables,name)).sort()).toEqual(["review_queue_items","review_queue_promotions","review_queues"]);
});
test("actual fresh source migration installs all three review tables and eight named indexes with a real receipt", () => {
  const db=getDrizzleDb().$client;
  expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'review_%' ORDER BY name").all()).toEqual(["review_queue_items","review_queue_promotions","review_queues"].map(name=>({ name })));
  expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'review_%' ORDER BY name").all()).toHaveLength(8);
  expect(history(db)).toHaveLength(journal.entries.length); expect(history(db)[11]).toEqual({ hash:createHash("sha256").update(readFileSync(path.join(migrations,"0011_review_queues.sql"))).digest("hex"),created_at:1791766000002 });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]); expect(db.query("SELECT * FROM coding_hook_owner").all()).toEqual([]);
});
test("actual prefix10 upgrade preserves prior source, frozen dataset, experiment and schema bytes across reopen", () => {
  const old=new Database(process.env.RUNPHANTOM_DB_PATH!); apply(old,prefix(10)); seed(old);
  const original=retained(old), receipts=history(old),objects=old.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all() as Array<{ name:string }>;
  old.close(true); let db=getDrizzleDb().$client; expect(retained(db)).toBe(original); expect(history(db).slice(0,11)).toEqual(receipts); expect(history(db)).toHaveLength(journal.entries.length);
  const names=new Set(objects.map(row=>row.name)); expect(db.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all().filter(row=>names.has((row as {name:string}).name))).toEqual(objects);
  const queue=createReviewQueue({ name:"Migrated curation" }),item=insertReviewItem(queue.id,{ runId:"retained-source" }); expect(item.source.output).toBe("Frozen output β\\t");
  const frozen=db.query("SELECT source_json,source_hash,draft_json,revision,ordinal FROM review_queue_items").all(),allHistory=history(db); closeDb();db=getDrizzleDb().$client;
  expect(retained(db)).toBe(original); expect(history(db)).toEqual(allHistory); expect(db.query("SELECT source_json,source_hash,draft_json,revision,ordinal FROM review_queue_items").all()).toEqual(frozen); expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
test("a late idx11 SQL failure rolls back every new object and receipt before clean source repair", () => {
  const db=new Database(process.env.RUNPHANTOM_DB_PATH!); apply(db,prefix(10)); seed(db);
  const before=retained(db),receipts=history(db),objects=db.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
  const broken=prefix(11,"broken"),file=path.join(broken,"0011_review_queues.sql"); writeFileSync(file,readFileSync(file,"utf8")+"\n--> statement-breakpoint\nSELECT * FROM intentional_f29_missing_table;\n");
  try { expect(()=>apply(db,broken)).toThrow(); expect(retained(db)).toBe(before); expect(history(db)).toEqual(receipts); expect(db.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all()).toEqual(objects); } finally { db.close(true); }
  const repaired=getDrizzleDb().$client;expect(retained(repaired)).toBe(before);expect(history(repaired)).toHaveLength(journal.entries.length);expect(repaired.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
test("actual source upgrade and frozen review intake survive a genuine second Bun process without reseeding", () => {
  const old=new Database(process.env.RUNPHANTOM_DB_PATH!);apply(old,prefix(10));seed(old);const original=retained(old);old.close(true);
  const imports=`import {getDrizzleDb,closeDb} from ${JSON.stringify(path.join(checkout,"src/db.ts"))}; import {createReviewQueue,insertReviewItem} from ${JSON.stringify(path.join(checkout,"src/review-queues/store.ts"))};`;
  const script=path.join(directory,"source-reopen.ts");
  writeFileSync(script,imports+`const db=getDrizzleDb().$client; if(process.argv[2]==="write"){const queue=createReviewQueue({name:"Process curation"});insertReviewItem(queue.id,{runId:"retained-source"});}console.log(JSON.stringify({pid:process.pid,history:db.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all(),items:db.query("SELECT * FROM review_queue_items ORDER BY id").all(),queues:db.query("SELECT * FROM review_queues ORDER BY id").all(),foreignKeys:db.query("PRAGMA foreign_key_check").all()}));closeDb();`);
  const invoke=(action:string)=>{ const result=Bun.spawnSync([process.execPath,script,action],{ cwd:directory,env:{ ...process.env,OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",RUNPHANTOM_CLAUDE_CLI_CHAT:"0" },timeout:10000 });expect(result.exitCode).toBe(0);return JSON.parse(new TextDecoder().decode(result.stdout)); };
  const first=invoke("write"),second=invoke("read");expect(first.pid).not.toBe(second.pid);expect(first.pid).not.toBe(process.pid);expect(second.history).toHaveLength(journal.entries.length);expect(second.history).toEqual(first.history);expect(second.items).toEqual(first.items);expect(second.items).toHaveLength(1);expect(second.queues).toEqual(first.queues);expect(second.foreignKeys).toEqual([]);
  expect(retained(getDrizzleDb().$client)).toBe(original);
});
test("the existing clear transaction deletes actual queue rows and cascades their frozen sources", () => {
  const db=getDrizzleDb().$client;seed(db);const queue=createReviewQueue({ name:"Clear source owner" });insertReviewItem(queue.id,{ runId:"retained-source" });
  clearAll();expect(db.query("SELECT * FROM review_queues").all()).toEqual([]);expect(db.query("SELECT * FROM review_queue_items").all()).toEqual([]);expect(db.query("SELECT * FROM review_queue_promotions").all()).toEqual([]);expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);expect(history(db)).toHaveLength(journal.entries.length);
});
const queueUniqueIndexes = [
  { table: "review_queue_items", name: "review_queue_items_ordinal_unique", columns: ["queue_id", "ordinal"] },
  { table: "review_queue_items", name: "review_queue_items_source_unique", columns: ["queue_id", "source_run_id", "source_span_key"] },
  { table: "review_queue_promotions", name: "review_queue_promotions_key_unique", columns: ["queue_id", "idempotency_key"] },
];
test("actual queue unique indexes use the exact snapshot names, column order and SQLite index type", () => {
  const db = getDrizzleDb().$client;
  for (const index of queueUniqueIndexes) {
    const indexes = db.query(`PRAGMA index_list('${index.table}')`).all() as Array<{ name: string; unique: number; origin: string; partial: number }>;
    expect(indexes.find(row => row.name === index.name)).toMatchObject({ name: index.name, unique: 1, origin: "c", partial: 0 });
    const columns = db.query(`PRAGMA index_info('${index.name}')`).all() as Array<{ name: string }>;
    expect(columns.map(row => row.name)).toEqual(index.columns);
    expect(db.query("SELECT type FROM sqlite_master WHERE name=?").get(index.name)).toEqual({ type: "index" });
  }
});
test("real next Drizzle generation can drop and recreate each canonical queue unique index", async () => {
  const db = getDrizzleDb().$client;
  const latest = journal.entries.at(-1);
  const snapshot = JSON.parse(readFileSync(path.join(migrations, `meta/${String(latest.idx).padStart(4, "0")}_snapshot.json`), "utf8"));
  const generated = await generateSQLiteDrizzleJson(typedSchema, snapshot.id);
  expect(await generateSQLiteMigration(snapshot, generated)).toEqual([]);
  const changed = structuredClone(snapshot);
  for (const index of queueUniqueIndexes) delete changed.tables[index.table].indexes[index.name];
  const removal = await generateSQLiteMigration(snapshot, changed);
  expect(removal).toHaveLength(3);
  for (const index of queueUniqueIndexes) expect(removal).toContain(`DROP INDEX \`${index.name}\`;`);
  expect(() => { for (const statement of removal) db.exec(statement); }).not.toThrow();
  for (const index of queueUniqueIndexes) expect(db.query("SELECT name FROM sqlite_master WHERE name=?").get(index.name)).toBeNull();
  const restoration = await generateSQLiteMigration(changed, snapshot); expect(restoration).toHaveLength(3);
  expect(() => { for (const statement of restoration) db.exec(statement); }).not.toThrow();
  for (const index of queueUniqueIndexes) {
    const indexes = db.query(`PRAGMA index_list('${index.table}')`).all() as Array<{ name: string; unique: number; origin: string }>;
    expect(indexes.find(row => row.name === index.name)).toMatchObject({ unique: 1, origin: "c" });
    const columns = db.query(`PRAGMA index_info('${index.name}')`).all() as Array<{ name: string }>;
    expect(columns.map(row => row.name)).toEqual(index.columns);
  }
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
