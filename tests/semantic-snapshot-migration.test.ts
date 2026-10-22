import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearAll, closeDb, getDrizzleDb } from "../src/db";

test("semantic snapshot migration preserves prior traces and reports, bounds immutable observations and reopens", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "runphantom-semantic-migration-"));
  const databasePath = path.join(directory, "actual.db");
  const priorFolder = path.join(directory, "prior");
  const migrations = path.resolve(import.meta.dir, "../drizzle");
  const journal = JSON.parse(readFileSync(path.join(migrations, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };
  const priorEntries = journal.entries.filter(entry => entry.idx <= 8);
  const originalPath = process.env.RUNPHANTOM_DB_PATH;
  let prior: Database | undefined;
  closeDb();
  try {
    expect(priorEntries.map(entry => entry.idx)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    mkdirSync(path.join(priorFolder, "meta"), { recursive: true });
    writeFileSync(path.join(priorFolder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: priorEntries }));
    for (const entry of priorEntries) copyFileSync(path.join(migrations, `${entry.tag}.sql`), path.join(priorFolder, `${entry.tag}.sql`));
    prior = new Database(databasePath, { create: true });
    prior.exec("PRAGMA legacy_alter_table=ON; PRAGMA foreign_keys=OFF");
    migrate(drizzle(prior), { migrationsFolder: priorFolder });
    prior.exec("PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF");
    prior.query("INSERT INTO runs(id,name,started_at,last_updated_at,metadata) VALUES(?,?,?,?,?)").run("preserved-run", "Existing capture", 100, 200, '{"business":"unchanged"}');
    prior.query("INSERT INTO spans(run_id,id,name,input_payload,output_payload,otlp_evidence) VALUES(?,?,?,?,?,?)").run("preserved-run", "preserved-span", "Existing span", "original input", "original output", null);
    prior.query("INSERT INTO verification_flows(id,name,origin,steps,created_at) VALUES(?,?,?,?,?)").run("preserved-flow", "Existing flow", "http://127.0.0.1:3000", "[]", 100);
    prior.query("INSERT INTO verification_reports(id,session_id,run_id,name,status,reason,evidence,context,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run("preserved-report", "existing-session", "preserved-run", "Existing report", "inconclusive", "Prior observation", "[]", '{"origin":"http://127.0.0.1:3000"}', 200);
    const originalRuns = prior.query("SELECT * FROM runs").all();
    const originalSpans = prior.query("SELECT * FROM spans").all();
    const originalFlows = prior.query("SELECT * FROM verification_flows").all();
    const originalReports = prior.query("SELECT * FROM verification_reports").all();
    const originalHistory = prior.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all();
    expect(originalHistory).toHaveLength(9);
    prior.close(); prior = undefined;

    process.env.RUNPHANTOM_DB_PATH = databasePath;
    let actual = getDrizzleDb().$client;
    expect(actual.query("SELECT * FROM runs").all()).toEqual(originalRuns);
    expect(actual.query("SELECT * FROM spans").all()).toEqual(originalSpans);
    expect(actual.query("SELECT * FROM verification_flows").all()).toEqual(originalFlows);
    expect(actual.query("SELECT * FROM verification_reports").all()).toEqual(originalReports);
    expect(actual.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const history = actual.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all();
    expect(history).toEqual(journal.entries.map(entry => ({ hash: createHash("sha256").update(readFileSync(path.join(migrations, entry.tag + ".sql"))).digest("hex"), created_at: entry.when })));
    expect(history.slice(0, 9)).toEqual(originalHistory);
    expect(actual.query("SELECT name FROM sqlite_master WHERE type='table' AND name='verification_snapshots'").all()).toHaveLength(1);

    // This raw-SQL fixture exercises storage bounds; the snapshot store separately validates semantic graphs.
    const payload = JSON.stringify({ formatVersion: 1, tree: { formatVersion: 1, source: "sdk-reported", nameModel: "partial-aria", documentGeneration: "fixture", availability: "complete", nodes: [], regions: [{ kind: "document", parentRegion: null, hostIndex: null }], coverage: { visited: 0, emitted: 0 } }, connectionGeneration: null });
    const insert = () => actual.query("INSERT INTO verification_snapshots(id,run_id,session_id,name,origin,captured_at,stored_at,source,content_sha256,coverage_sha256,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    const add = (id: string, body = payload, run: string | null = null) => insert().run(id, run, null, "Captured observation", "http://127.0.0.1:3000", 100, 200, "imported-evidence", "a".repeat(64), "b".repeat(64), body);
    add("linked-observation", payload, "preserved-run");
    expect(() => actual.query("UPDATE verification_snapshots SET name='changed' WHERE id='linked-observation'").run()).toThrow();
    expect(() => add("oversized-observation", JSON.stringify({ text: "汉".repeat(11_000) }))).toThrow();
    expect(() => add("invalid-json", "invalid JSON")).toThrow();
    expect(() => add("missing-run", payload, "absent-run")).toThrow();
    for (let index = 0; index < 98; index++) add(`observation-${index}`);
    expect(actual.query("SELECT count(*) AS count FROM verification_snapshots").get()).toEqual({ count: 99 });
    expect(() => actual.transaction(() => { add("atomic-first"); add("atomic-second"); })()).toThrow();
    expect(actual.query("SELECT count(*) AS count FROM verification_snapshots").get()).toEqual({ count: 99 });
    add("last-observation");
    expect(() => add("over-capacity")).toThrow();
    const stored = actual.query("SELECT * FROM verification_snapshots ORDER BY id").all();
    closeDb(); actual = getDrizzleDb().$client;
    expect(actual.query("SELECT * FROM verification_snapshots ORDER BY id").all()).toEqual(stored);
    expect(actual.query("SELECT * FROM verification_reports").all()).toEqual(originalReports);
    expect(actual.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all()).toEqual(history);
    actual.query("DELETE FROM verification_snapshots WHERE id='last-observation'").run();
    expect(actual.query("SELECT count(*) AS count FROM verification_snapshots").get()).toEqual({ count: 99 });
    clearAll();
    expect(actual.query("SELECT count(*) AS count FROM verification_snapshots").get()).toEqual({ count: 0 });
    expect(actual.query("SELECT count(*) AS count FROM runs").get()).toEqual({ count: 0 });
    expect(actual.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    prior?.close(); closeDb();
    if (originalPath === undefined) delete process.env.RUNPHANTOM_DB_PATH;
    else process.env.RUNPHANTOM_DB_PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});
