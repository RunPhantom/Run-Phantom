import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import type http from "node:http";
import { closeDb, insertSpan, upsertRun } from "../src/db";
import { createServer } from "../src/server";

const envNames = ["RUNPHANTOM_DB_PATH", "RUNPHANTOM_SECRET_STORE_PATH", "OPENAI_API_KEY", "RUNPHANTOM_OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];
const originalEnv = new Map<string, string | undefined>();
let directory: string, base: string, server: http.Server;
const upstream: string[] = [];

beforeAll(async () => {
  for (const key of envNames) { originalEnv.set(key, process.env[key]); delete process.env[key]; }
  directory = mkdtempSync(path.join(realpathSync(tmpdir()), "runphantom-settings-data-"));
  closeDb();
  process.env.RUNPHANTOM_DB_PATH = path.join(directory, "traces.db");
  process.env.RUNPHANTOM_SECRET_STORE_PATH = path.join(directory, "secrets.json");
  ({ server } = await createServer(0, {
    providerCheckFetch: async url => {
      upstream.push(url);
      await new Promise(resolve => setTimeout(resolve, 30));
      return new Response(JSON.stringify({ data: [{ id: "gpt-5-nano" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  closeDb();
  for (const [key, value] of originalEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(directory, { recursive: true, force: true });
});

describe.serial("settings provider and data endpoints", () => {
  test("key status carries a masked hint of the effective key and never the key", async () => {
    const key = "sk-proj-settings-7Q2x";
    expect((await fetch(`${base}/api/secrets/openai`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: key }) })).ok).toBe(true);
    const body = await (await fetch(`${base}/api/secrets`)).text();
    expect(body).not.toContain(key);
    const parsed = JSON.parse(body);
    expect(parsed.hints).toEqual({ anthropic: null, openai: "sk-proj-…7Q2x", gemini: null });
    expect(parsed.keys.openai).toEqual({ configured: true, source: "store", env_var: "OPENAI_API_KEY", stored: true });
  });

  test("a connection check answers from one models-list call even when clicked twice", async () => {
    upstream.length = 0;
    const [first, second] = await Promise.all([
      fetch(`${base}/api/secrets/openai/test`, { method: "POST" }).then(response => response.json()),
      fetch(`${base}/api/secrets/openai/test`, { method: "POST" }).then(response => response.json()),
    ]);
    expect(upstream).toEqual(["https://api.openai.com/v1/models"]);
    expect(first).toMatchObject({ provider: "openai", ok: true, source: "store", modelCount: 1 });
    expect(second).toEqual(first);
    const missing = await (await fetch(`${base}/api/secrets/gemini/test`, { method: "POST" })).json();
    expect(missing).toMatchObject({ ok: false, failure: "missing_key" });
    expect(upstream).toHaveLength(1);
    expect((await fetch(`${base}/api/secrets/mistral/test`, { method: "POST" })).status).toBe(404);
  });

  test("a repeat check inside the cooldown reuses the answer until the key changes", async () => {
    upstream.length = 0;
    await fetch(`${base}/api/secrets/openai`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: "sk-proj-cool-a-9Kd2" }) });
    const first = await (await fetch(`${base}/api/secrets/openai/test`, { method: "POST" })).json();
    const repeat = await fetch(`${base}/api/secrets/openai/test`, { method: "POST" });
    const repeated = await repeat.json();
    expect(upstream).toHaveLength(1);
    expect(repeated.checkedAt).toBe(first.checkedAt);
    expect(repeated.reusedUntil).toBeGreaterThan(first.checkedAt);
    expect(Number(repeat.headers.get("Retry-After"))).toBeGreaterThan(0);

    await fetch(`${base}/api/secrets/openai`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: "sk-proj-cool-b-4Hq8" }) });
    const replaced = await (await fetch(`${base}/api/secrets/openai/test`, { method: "POST" })).json();
    expect(upstream).toHaveLength(2);
    expect(replaced.reusedUntil).toBeUndefined();

    await fetch(`${base}/api/secrets/openai`, { method: "DELETE" });
    const removed = await (await fetch(`${base}/api/secrets/openai/test`, { method: "POST" })).json();
    expect(removed).toMatchObject({ ok: false, failure: "missing_key" });
    expect(upstream).toHaveLength(2);
  });

  test("a foreign page cannot trigger a check or read the data summary", async () => {
    const headers = { Origin: "https://example.test" };
    expect((await fetch(`${base}/api/secrets/openai/test`, { method: "POST", headers })).status).toBe(403);
    expect((await fetch(`${base}/api/data`, { headers })).status).toBe(403);
    expect((await fetch(`${base}/api/data/backup`, { headers })).status).toBe(403);
  });

  test("the data summary counts what is stored and where", async () => {
    const now = Date.now();
    upsertRun({ id: "data-summary-run", name: "summary", started_at: now, last_updated_at: now });
    insertSpan({ id: "data-summary-span", run_id: "data-summary-run", name: "step", start_time_ms: now, end_time_ms: now + 5, duration_ms: 5 });
    const summary = await (await fetch(`${base}/api/data`)).json();
    expect(summary).toMatchObject({ dbPath: path.join(realpathSync(directory), "traces.db"), runs: 1, steps: 1, savedRuns: 0 });
    expect(summary.dbBytes).toBeGreaterThan(0);
    expect(typeof summary.version).toBe("string");
  });

  test("the backup is a complete, openable copy and its temporary file is removed", async () => {
    const scratch = path.join(directory, "scratch");
    mkdirSync(scratch);
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = scratch;
    let response: Response;
    try { response = await fetch(`${base}/api/data/backup`); } finally { if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; }
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/attachment; filename="runphantom-backup-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.db"/);
    const copy = path.join(directory, "copy.db");
    writeFileSync(copy, new Uint8Array(await response.arrayBuffer()));
    const db = new Database(copy, { readonly: true });
    try {
      expect((db.query("SELECT id FROM runs").all() as { id: string }[]).map(row => row.id)).toEqual(["data-summary-run"]);
      expect((db.query("SELECT COUNT(*) AS n FROM spans").get() as { n: number }).n).toBe(1);
    } finally { db.close(); }
    for (let attempt = 0; attempt < 20 && readdirSync(scratch).length; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    expect(readdirSync(scratch)).toEqual([]);
  });
});
