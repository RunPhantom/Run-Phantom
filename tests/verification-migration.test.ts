import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, getDrizzleDb } from "../src/db";
import { getFlow, listReports, saveFlow, saveReport } from "../src/verification/store";
import type { VerificationReport } from "../src/verification/protocol";

interface MigrationJournal {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
}

test("verification migrations preserve an existing 0003 trace database and retain contextual reports after reopening", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "runphantom-verification-migration-"));
  const dbPath = path.join(directory, "existing-traces.db");
  const priorMigrations = path.join(directory, "prior-migrations");
  const sourceMigrations = path.resolve(import.meta.dir, "../drizzle");
  const journal = JSON.parse(readFileSync(path.join(sourceMigrations, "meta/_journal.json"), "utf8")) as MigrationJournal;
  const priorEntries = journal.entries.filter((entry) => entry.idx <= 3);
  const previousDbPath = process.env.RUNPHANTOM_DB_PATH;
  let baseline: Database | null = null;
  closeDb();

  try {
    expect(priorEntries.map((entry) => entry.idx)).toEqual([0, 1, 2, 3]);
    mkdirSync(path.join(priorMigrations, "meta"), { recursive: true });
    writeFileSync(path.join(priorMigrations, "meta/_journal.json"), JSON.stringify({ ...journal, entries: priorEntries }));
    for (const entry of priorEntries) {
      copyFileSync(path.join(sourceMigrations, `${entry.tag}.sql`), path.join(priorMigrations, `${entry.tag}.sql`));
    }

    baseline = new Database(dbPath, { create: true });
    // The 0003 table rebuild needs these connection-level pragmas before Drizzle's transaction.
    baseline.exec("PRAGMA legacy_alter_table = ON");
    baseline.exec("PRAGMA foreign_keys = OFF");
    migrate(drizzle(baseline), { migrationsFolder: priorMigrations });
    baseline.exec("PRAGMA foreign_keys = ON");
    baseline.exec("PRAGMA legacy_alter_table = OFF");
    expect(baseline.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'verification_%'").all()).toEqual([]);

    const createdAt = 1_700_000_000_000;
    const addRun = baseline.query("INSERT INTO runs (id, name, display_name, event_name, started_at, last_updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const addSpan = baseline.query("INSERT INTO spans (run_id, id, name, status, input_payload, output_payload, start_time_ms, end_time_ms, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const [id, outcome] of [["existing-run-a", "First preserved result"], ["existing-run-b", "Second preserved result"]]) {
      addRun.run(id, "existing.agent", `Existing ${id}`, "existing.event", createdAt, createdAt + 10, '{"workspace":"migration-fixture"}');
      addSpan.run(id, "shared-span-id", "existing.tool", "OK", '{"prompt":"Keep prior trace data"}', outcome, createdAt, createdAt + 10, 10);
    }
    const originalRuns = baseline.query("SELECT * FROM runs ORDER BY id").all();
    const originalSpans = baseline.query("SELECT * FROM spans ORDER BY run_id, id").all();
    const originalHistory = baseline.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at").all();
    expect(originalHistory).toHaveLength(4);
    expect(originalSpans).toHaveLength(2);
    baseline.close();
    baseline = null;

    process.env.RUNPHANTOM_DB_PATH = dbPath;
    const upgraded = getDrizzleDb().$client;
    expect(upgraded.query("SELECT * FROM runs ORDER BY id").all()).toEqual(originalRuns);
    expect(upgraded.query("SELECT * FROM spans ORDER BY run_id, id").all()).toEqual(originalSpans);
    expect(upgraded.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const upgradedHistory = upgraded.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at").all();
    expect(upgradedHistory).toHaveLength(journal.entries.length);
    expect(upgradedHistory.slice(0, 4)).toEqual(originalHistory);
    expect(upgraded.query("PRAGMA table_info(verification_reports)").all()).toContainEqual(expect.objectContaining({ name: "context", type: "TEXT" }));

    const predicate = { kind: "network", urlContains: "/api/checkout", method: "POST", status: 200 } as const;
    const flow = saveFlow("Checkout after upgrade", "http://127.0.0.1:3000", [
      { command: { type: "click", selector: "#checkout" }, predicate },
    ]);
    const report: VerificationReport = {
      id: "migration-verification-report",
      sessionId: "migration-session",
      runId: "existing-run-a",
      flowId: flow.id,
      name: "Checkout verified after database upgrade",
      status: "pass",
      reason: "The expected checkout response was observed.",
      createdAt: createdAt + 100,
      evidence: [{ t: 12, type: "network", data: { url: "http://127.0.0.1:3000/api/checkout", method: "POST", status: 200 } }],
      context: {
        origin: flow.origin,
        quietMs: 300,
        redacted: false,
        truncated: false,
        checks: [{
          step: 1, predicate, status: "pass", reason: "Observed the required response.",
          since: 10, through: 14, generation: 1,
          coverage: { network: true, console: true, dom: true, state: true, signal: true, route: true },
          complete: true, dropped: 0, settled: true,
        }],
      },
    };
    expect(saveReport(report)).toEqual(report);
    expect(listReports("existing-run-a")).toEqual([report]);
    expect(listReports("existing-run-b")).toEqual([]);

    closeDb();
    const reopened = getDrizzleDb().$client;
    expect(listReports("existing-run-a")).toEqual([report]);
    expect(getFlow(flow.id)).toEqual(flow);
    expect(reopened.query("SELECT * FROM runs ORDER BY id").all()).toEqual(originalRuns);
    expect(reopened.query("SELECT * FROM spans ORDER BY run_id, id").all()).toEqual(originalSpans);
    expect(reopened.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at").all()).toEqual(upgradedHistory);
    expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    baseline?.close();
    closeDb();
    if (previousDbPath === undefined) delete process.env.RUNPHANTOM_DB_PATH;
    else process.env.RUNPHANTOM_DB_PATH = previousDbPath;
    rmSync(directory, { recursive: true, force: true });
  }
});
