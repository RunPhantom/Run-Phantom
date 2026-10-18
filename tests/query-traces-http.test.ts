import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, getDrizzleDb, upsertRun } from "../src/db";
import { createServer } from "../src/server";

test("trace-query HTTP boundary preserves literal values and rejects private-table syntax", async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runphantom-query-http-")));
  const keys = ["RUNPHANTOM_DB_PATH", "RUNPHANTOM_SECRET_STORE_PATH", "RUNPHANTOM_AGENT_PROVIDER"] as const;
  const previous = keys.map(key => process.env[key]);
  closeDb();
  process.env.RUNPHANTOM_AGENT_PROVIDER = "claude";
  process.env.RUNPHANTOM_DB_PATH = path.join(directory, "traces.db");
  process.env.RUNPHANTOM_SECRET_STORE_PATH = path.join(directory, "secrets.json");
  let server: Awaited<ReturnType<typeof createServer>>["server"] | undefined;
  try {
    const db = getDrizzleDb().$client;
    db.exec("CREATE TABLE audit_private (content TEXT); INSERT INTO audit_private VALUES ('synthetic private chat')");
    upsertRun({ id: "fixture-run", started_at: 1, last_updated_at: 1 });
    ({ server } = await createServer(0));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const query = (sql: string) => fetch(`${base}/api/traces/query`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql }),
    });
    for (const sql of [
      "SELECT content FROM (audit_private)",
      "SELECT 'synthetic private chat' IN audit_private",
      `SELECT "printf"('%100s', 'x')`,
    ]) {
      const response = await query(sql);
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toMatch(/trace-safe tables|amplify output size/);
    }
    const literal = await query("SELECT 'ticket--42/*keep*/' AS value");
    expect(literal.status).toBe(200);
    expect((await literal.json() as { rows: unknown[] }).rows).toEqual([{ value: "ticket--42/*keep*/" }]);
    const traces = await query("SELECT id FROM (runs) WHERE id IN (SELECT id FROM runs)");
    expect(traces.status).toBe(200);
    expect((await traces.json() as { rows: unknown[] }).rows).toEqual([{ id: "fixture-run" }]);
  } finally {
    server?.closeAllConnections();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    closeDb();
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test.each([
  ["SELECT id FROM runs", { ok: true, rows: [{ id: "fixture-run" }] }],
  ["SELECT abs(-9223372036854775808) FROM runs", { ok: false, error: "integer overflow" }],
])("trace-query worker releases its database before responding to %s", async (sql, expected) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runphantom-query-worker-")));
  const dbPath = path.join(directory, "traces.db");
  const db = new Database(dbPath, { create: true });
  try {
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE runs (id TEXT); INSERT INTO runs VALUES ('fixture-run')");
  } finally {
    db.close(true);
  }
  const worker = new Worker(new URL("../src/query-worker.ts", import.meta.url).href);
  try {
    const response = await new Promise<unknown>((resolve, reject) => {
      worker.onmessage = event => resolve(event.data);
      worker.onerror = event => reject(new Error(event.message));
      worker.postMessage({ dbPath, sql, limit: 2 });
    });
    // Windows refuses this while a worker still owns a native SQLite handle.
    fs.rmSync(directory, { recursive: true, force: true });
    expect(response).toEqual(expected);
  } finally {
    worker.terminate();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
