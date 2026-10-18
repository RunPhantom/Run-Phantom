import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

const checkout = path.resolve(import.meta.dir, "..");
const migrations = path.join(checkout, "drizzle");
const version = "finding-cache-qualification";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "finding-copied-cache-"));
const executable = path.join(scratch, "copied", "migration-bootstrap");
const journal = JSON.parse(fs.readFileSync(path.join(migrations, "meta/_journal.json"), "utf8"));
beforeAll(() => {
  const entry = path.join(scratch, "entry.ts");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(entry, `import { getDrizzleDb,closeDb } from ${JSON.stringify(path.join(checkout, "src/db.ts"))};
const db=getDrizzleDb().$client;
if(process.argv[2]==="write") {db.exec("INSERT INTO runs(id,started_at,last_updated_at) VALUES('copied',1,2)");db.query("INSERT INTO spans(run_id,id,name,otlp_evidence) VALUES(?,?,?,?)").run("copied","span","copied bootstrap",'{"exact":"retained"}');}
console.log(JSON.stringify({tables:db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),columns:db.query("PRAGMA table_info(spans)").all(),history:db.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all(),payload:db.query("SELECT otlp_evidence FROM spans WHERE run_id='copied'").all(),findingRows:db.query("SELECT * FROM evaluation_finding_mappings").all(),foreignKeys:db.query("PRAGMA foreign_key_check").all()}));closeDb();`);
  const built = Bun.spawnSync([process.execPath, "build", entry, "--compile", "--outfile", executable,
    `--define=__RUNPHANTOM_VERSION__=${JSON.stringify(version)}`, "--define=__RUNPHANTOM_PACKAGED__=true", "--define=__RUNPHANTOM_SOURCE_ROOT__=\"/no-source-checkout\""], { cwd: checkout, timeout: 30_000 });
  if (built.exitCode !== 0) throw new Error(new TextDecoder().decode(built.stderr));
}, 30_000);
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

function fixture(name: string, change: (cache: string) => void, run: (invoke: (action?: string) => { result: ReturnType<typeof Bun.spawnSync>; body: Record<string, unknown> }, cache: string) => void) {
  const home = path.join(scratch, name), cache = path.join(home, ".runphantom", "migrations", version);
  fs.mkdirSync(path.join(cache, "meta"), { recursive: true });
  fs.copyFileSync(path.join(migrations, "meta/_journal.json"), path.join(cache, "meta/_journal.json"));
  for (const entry of journal.entries) fs.copyFileSync(path.join(migrations, entry.tag + ".sql"), path.join(cache, entry.tag + ".sql"));
  change(cache);
  const invoke = (action = "read") => {
    const result = Bun.spawnSync([executable, action], { cwd: path.dirname(executable), timeout: 10_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, RUNPHANTOM_DB_PATH: path.join(home, "workspace.db"), ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" } });
    const output = new TextDecoder().decode(result.stdout).trim();
    return { result, body: output ? JSON.parse(output) : {} };
  };
  run(invoke, cache);
}

test("copied same-version runtime replaces a stale journal even when every SQL filename exists", () => {
  fixture("journal", cache => fs.writeFileSync(path.join(cache, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 9) })), (invoke, cache) => {
    const { result, body } = invoke(); expect(result.exitCode).toBe(0);
    expect(body.history).toHaveLength(journal.entries.length);
    expect(body.tables).toContainEqual({ name: "evaluation_finding_comparisons" });
    expect(JSON.parse(fs.readFileSync(path.join(cache, "meta/_journal.json"), "utf8"))).toEqual(journal);
  });
});

test("copied same-version runtime replaces changed SQL bytes instead of silently recording their hash", () => {
  fixture("sql", cache => fs.appendFileSync(path.join(cache, "0008_otlp_evidence.sql"), "\n-- stale cache bytes\n"), (invoke, cache) => {
    const { result, body } = invoke(); expect(result.exitCode).toBe(0);
    const expected = createHash("sha256").update(fs.readFileSync(path.join(migrations, "0008_otlp_evidence.sql"))).digest("hex");
    expect((body.history as { hash: string; created_at: number }[]).find(row => row.created_at === 1791757794360)?.hash).toBe(expected);
    expect(fs.readFileSync(path.join(cache, "0008_otlp_evidence.sql"))).toEqual(fs.readFileSync(path.join(migrations, "0008_otlp_evidence.sql")));
  });
});

test("copied migration bootstrap survives two boots with exact persisted bytes and no reseed", () => {
  fixture("reopen", () => {}, invoke => {
    const first = invoke("write"); expect(first.result.exitCode).toBe(0);
    const second = invoke(); expect(second.result.exitCode).toBe(0);
    expect(second.body.history).toEqual(first.body.history);
    expect(second.body.payload).toEqual([{ otlp_evidence: '{"exact":"retained"}' }]);
    expect(second.body.foreignKeys).toEqual([]);
  });
});

test("copied canonical runtime upgrades the actual legacy F07 schema and preserves its receipts across reopen", () => {
  let retainedRows: unknown[], legacyHistory: unknown[];
  fixture("legacy", cache => {
    const home = path.resolve(cache, "../../.."), legacy = path.join(home, "legacy-migrations");
    const finding = { ...journal.entries[9], idx: 8, tag: "0008_finding_comparisons" };
    const entries = [...journal.entries.slice(0, 8), finding];
    fs.mkdirSync(path.join(legacy, "meta"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    for (const entry of entries) fs.copyFileSync(path.join(migrations, entry === finding ? "0009_finding_comparisons.sql" : entry.tag + ".sql"), path.join(legacy, entry.tag + ".sql"));
    const db = new Database(path.join(home, "workspace.db"));
    db.exec("PRAGMA journal_mode=WAL; PRAGMA legacy_alter_table=ON; PRAGMA foreign_keys=OFF");
    migrate(drizzle(db), { migrationsFolder: legacy }); db.exec("PRAGMA foreign_keys=ON");
    db.exec("INSERT INTO evaluation_evidence_scopes VALUES('local',1,1)");
    db.exec("INSERT INTO evaluation_evidence_jobs(id,scope_key,scope_generation,operation_key,request_digest,request_data,status,job_token,admitted_at,deadline_at,reserved_raw_bytes,reserved_normalized_bytes) VALUES('job','local',1,'op','digest','{}','completed','token',1,2,0,0)");
    db.exec("INSERT INTO evaluation_evidence_sets VALUES('local','set',1,'job','{}','digest',1)");
    db.query("INSERT INTO evaluation_finding_mappings VALUES('local',1,'mapping','set',1,'set',1,?,'digest',1)").run('{"exact":"legacy α\\n"}');
    retainedRows = db.query("SELECT * FROM evaluation_finding_mappings").all();
    legacyHistory = db.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all(); db.close(true);
  }, invoke => {
    const first = invoke(); expect(first.result.exitCode).toBe(0);
    expect(first.body.history).toHaveLength(10); expect(first.body.findingRows).toEqual(retainedRows);
    for (const row of legacyHistory) expect(first.body.history).toContainEqual(row);
    expect((first.body.columns as { name: string }[]).some(column => column.name === "otlp_evidence")).toBe(true);
    const second = invoke(); expect(second.result.exitCode).toBe(0);
    expect(second.body.history).toEqual(first.body.history); expect(second.body.findingRows).toEqual(retainedRows);
    expect(second.body.foreignKeys).toEqual([]);
  });
});
