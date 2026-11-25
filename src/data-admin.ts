import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDbPath, getDrizzleDb } from "./db";
import { VERSION } from "./version";

export interface DataSummary {
  version: string;
  dbPath: string;
  /** Main database file plus its write-ahead log and shared-memory files, in bytes. */
  dbBytes: number;
  runs: number;
  steps: number;
  savedRuns: number;
}

function fileBytes(file: string): number {
  try { return fs.statSync(file).size; } catch { return 0; }
}

export function getDataSummary(): DataSummary {
  const client = getDrizzleDb().$client;
  const dbPath = getDbPath();
  const count = (table: string) => Number((client.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | null)?.n ?? 0);
  return {
    version: VERSION,
    dbPath,
    dbBytes: fileBytes(dbPath) + fileBytes(`${dbPath}-wal`) + fileBytes(`${dbPath}-shm`),
    runs: count("runs"),
    steps: count("spans"),
    savedRuns: count("saved_events"),
  };
}

/**
 * Writes a consistent single-file copy of the live database. VACUUM INTO reads through SQLite, so the copy includes
 * pages still in the WAL; copying runphantom.db directly would miss them. The caller owns and removes the directory.
 */
export function writeDatabaseBackup(): { directory: string; file: string; bytes: number } {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "runphantom-backup-"));
  const file = path.join(directory, "runphantom.db");
  try {
    getDrizzleDb().$client.run(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
    return { directory, file, bytes: fileBytes(file) };
  } catch (cause) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw cause;
  }
}
