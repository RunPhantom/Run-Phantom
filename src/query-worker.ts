/**
 * Executes one read-only trace query in a worker so it can be abandoned.
 *
 * bun:sqlite exposes no `interrupt`, no progress handler and no busy timeout, so
 * a query already inside SQLite cannot be cancelled from the thread that started
 * it. That matters because the daemon is single-threaded: a shape that must fully
 * materialise — an aggregate or ORDER BY over an unbounded join — blocks every
 * other request while it runs. Measured at 8k spans, `ORDER BY` over a two-way
 * cross join took 5.9s and grows with n², so a real trace store freezes outright.
 * A plain cross join is fine, because the LIMIT wrapper short-circuits it.
 *
 * The connection is query_only, so an abandoned query cannot leave a write
 * transaction open or corrupt the store.
 *
 * Running it here means the main thread can stop waiting and terminate this
 * worker; SQLite keeps burning a core until it finishes, but the daemon stays
 * responsive to every other request.
 */
import { Database } from "bun:sqlite";

declare const self: Worker;

interface QueryRequest {
  dbPath: string;
  sql: string;
  limit: number;
}

self.onmessage = (event: MessageEvent<QueryRequest>) => {
  const { dbPath, sql, limit } = event.data;
  let db: Database | null = null;
  let response: { ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string };
  try {
    // Not `{ readonly: true }`: the database runs in WAL mode, and a read-only
    // connection cannot create the -shm file WAL requires, so it fails outright
    // with "unable to open database file". Opening writable and then setting
    // query_only gives SQLite the shared-memory access it needs while still
    // rejecting every write — verified: DELETE raises "attempt to write a
    // readonly database".
    db = new Database(dbPath);
    db.exec("PRAGMA query_only = ON");
    const statement = db.query(`SELECT * FROM (${sql}) LIMIT ${limit}`);
    try {
      const rows = statement.all() as Record<string, unknown>[];
      response = { ok: true, rows };
    } finally {
      statement.finalize();
    }
  } catch (err) {
    response = { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      db?.close(true);
    } catch (err) {
      response = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  // The parent may terminate us as soon as it receives this terminal response.
  self.postMessage(response);
};
