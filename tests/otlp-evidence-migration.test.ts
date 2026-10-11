import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { closeDb, getDrizzleDb } from "../src/db";

for (const upgrade of [false, true]) test(`OTLP evidence migration: ${upgrade ? "upgrade" : "fresh"} preserves nullable bytes across reopen`, () => {
  const directory = mkdtempSync(path.join(tmpdir(), "runphantom-otlp-migration-"));
  const filename = path.join(directory, "workspace.db");
  const migrations = path.resolve(import.meta.dir, "../drizzle");
  const previous = process.env.RUNPHANTOM_DB_PATH;
  let baseline: Database | undefined;
  closeDb();
  try {
    if (upgrade) {
      const journal = JSON.parse(readFileSync(path.join(migrations, "meta/_journal.json"), "utf8"));
      const entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 7);
      expect(entries).toHaveLength(8);
      const prior = path.join(directory, "prior");
      mkdirSync(path.join(prior, "meta"), { recursive: true });
      writeFileSync(path.join(prior, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
      for (const entry of entries) copyFileSync(path.join(migrations, `${entry.tag}.sql`), path.join(prior, `${entry.tag}.sql`));
      baseline = new Database(filename, { create: true });
      baseline.exec("PRAGMA legacy_alter_table=ON; PRAGMA foreign_keys=OFF");
      migrate(drizzle(baseline), { migrationsFolder: prior });
      baseline.exec("PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF");
      baseline.exec("INSERT INTO runs(id,started_at,last_updated_at) VALUES('prior',1,2)");
      baseline.query("INSERT INTO spans(run_id,id,name,output_payload) VALUES(?,?,?,?)").run("prior", "span", "Retained output", '{"result":"unchanged"}');
      baseline.close(true); baseline = undefined;
    }
    process.env.RUNPHANTOM_DB_PATH = filename;
    const client = getDrizzleDb().$client;
    const columns = client.query("PRAGMA table_info(spans)").all() as { name: string; type: string; notnull: number; dflt_value: unknown }[];
    expect(columns.find(column => column.name === "otlp_evidence")).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null });
    if (upgrade) expect(client.query("SELECT output_payload,otlp_evidence FROM spans WHERE run_id='prior'").get())
      .toEqual({ output_payload: '{"result":"unchanged"}', otlp_evidence: null });
    const envelope = '{"schemaVersion":1,"startTimeUnixNano":"1791757794360000001","events":[],"links":[]}';
    client.exec("INSERT INTO runs(id,started_at,last_updated_at) VALUES('current',3,4)");
    client.query("INSERT INTO spans(run_id,id,name,otlp_evidence) VALUES(?,?,?,?)").run("current", "span", "Exact synthetic bytes", envelope);
    const before = client.query("SELECT * FROM spans ORDER BY run_id,id").all();
    const history = client.query("SELECT * FROM __drizzle_migrations ORDER BY created_at").all();
    closeDb();
    const reopened = getDrizzleDb().$client;
    expect(reopened.query("SELECT * FROM spans ORDER BY run_id,id").all()).toEqual(before);
    expect(reopened.query("SELECT otlp_evidence FROM spans WHERE run_id='current'").get()).toEqual({ otlp_evidence: envelope });
    expect(reopened.query("SELECT * FROM __drizzle_migrations ORDER BY created_at").all()).toEqual(history);
    expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(reopened.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name LIKE 'evaluation_evidence_%'").get()).toEqual({ count: 7 });
  } finally {
    baseline?.close(true); closeDb();
    if (previous === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
