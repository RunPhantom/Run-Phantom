import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "rp-state-dir-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test.skipIf(process.platform === "win32")("a new state folder is private to the owner", async () => {
  const dbPath = path.join(root, "fresh", ".runphantom", "runphantom.db");
  const child = Bun.spawn([process.execPath, "-e", `const { getDrizzleDb, closeDb } = await import(${JSON.stringify(path.join(import.meta.dir, "..", "src", "db.ts"))}); getDrizzleDb(); closeDb();`], {
    env: { ...process.env, RUNPHANTOM_DB_PATH: dbPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(stderr).toBe("");
  expect(status).toBe(0);
  expect(statSync(path.dirname(dbPath)).mode & 0o777).toBe(0o700);
});
