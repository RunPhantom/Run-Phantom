import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { linkSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, getDrizzleDb } from "../src/db";
import { acquireCodingHookOwner, codingHookOwnerPort, CodingHookOwnerRefusal, startCodingHookOwner } from "../src/coding-hooks/owner";
import { CodingHookStore } from "../src/coding-hooks/store";

let directory: string, file: string, prior: string | undefined;
const children: ReturnType<typeof Bun.spawn>[] = [];
beforeEach(() => {
  directory = realpathSync(mkdtempSync(path.join(tmpdir(), "runphantom-f11-owner-"))); file = path.join(directory, "owner.sqlite");
  closeDb(); prior = process.env.RUNPHANTOM_DB_PATH; process.env.RUNPHANTOM_DB_PATH = file;
  getDrizzleDb(); closeDb();
});
afterEach(async () => { for (const child of children.splice(0)) { child.kill("SIGKILL"); await child.exited; } closeDb(); if (prior === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = prior; rmSync(directory, { recursive: true, force: true }); });
async function launch(dbPath = file) {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/coding-hooks-owner-process.ts"), dbPath], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" } }); children.push(child);
  const reader = child.stdout.getReader(); let raw = "";
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  try { while (!raw.includes("\n")) { const next = await reader.read(); if (next.done) break; raw += new TextDecoder().decode(next.value); } }
  finally { clearTimeout(timer); reader.releaseLock(); }
  return { child, receipt: JSON.parse(raw) as { status: string; reason?: string; generation?: string; source_epoch?: string; birth?: string } };
}
test("a competing actual process refuses before changing the current owner generation", async () => {
  const first = await launch(); expect(first.receipt).toMatchObject({ status: "owned" });
  const second = await launch(); expect(second.receipt.status).toBe("refused"); expect(second.receipt.reason).toBe("occupied");
  const db = new Database(file); try { expect(db.query("SELECT generation FROM coding_hook_owner").get()).toEqual({ generation: first.receipt.generation }); } finally { db.close(); }
});
test("actual SIGKILL recovery releases the lease and creates a new birth/generation with stable source epoch", async () => {
  const first = await launch(); expect(first.receipt).toMatchObject({ status: "owned" });
  first.child.kill("SIGKILL"); await first.child.exited;
  const next = await launch(); expect(next.receipt).toMatchObject({ status: "owned" }); expect(next.receipt.birth).toMatch(/^[a-f0-9]{32}$/);
  expect(next.receipt.birth).not.toBe(first.receipt.birth); expect(next.receipt.generation).not.toBe(first.receipt.generation); expect(next.receipt.source_epoch).toBe(first.receipt.source_epoch);
});
test("two unrelated actual database files can be owned concurrently", async () => {
  const other = path.join(directory, "other.sqlite"); process.env.RUNPHANTOM_DB_PATH = other;
  getDrizzleDb(); closeDb();
  const fixture = new Database(other); expect(fixture.query("SELECT count(*) count FROM coding_hook_owner").get()).toEqual({ count: 0 }); fixture.close();
  // Distinct deterministic lease ports qualify this positive fixture; collisions have a separate refusal control.
  expect(codingHookOwnerPort(other)).not.toBe(codingHookOwnerPort(file));
  const first = await launch(), second = await launch(other); expect(first.receipt).toMatchObject({ status: "owned" }); expect(second.receipt).toMatchObject({ status: "owned" }); expect(second.receipt.birth).not.toBe(first.receipt.birth);
});
test("an occupied fixed lease port refuses without creating an owner row or choosing another port", async () => {
  const blocker = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => { blocker.once("error", reject); blocker.listen({ host: "127.0.0.1", port: codingHookOwnerPort(file), exclusive: true, reusePort: false }, resolve); });
  try { const attempted = await launch(); expect(attempted.receipt.status).toBe("refused"); expect(attempted.receipt.reason).toBe("occupied"); const db = new Database(file); try { expect(db.query("SELECT * FROM coding_hook_owner").all()).toEqual([]); } finally { db.close(); } }
  finally { await new Promise<void>(resolve => blocker.close(() => resolve())); }
});
test("incoming connections get no endpoint response and release is idempotent and permits recovery", async () => {
  const lease = await acquireCodingHookOwner(file); expect(lease.isActive()).toBe(true);
  const data = await new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: lease.port }); let bytes = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("lease connection did not close")); }, 500);
    socket.on("data", chunk => { bytes += chunk.toString(); }); socket.on("error", () => {}); socket.once("close", () => { clearTimeout(timer); resolve(bytes); });
  }); expect(data).toBe("");
  const first = lease.release(); expect(lease.isActive()).toBe(false); expect(lease.release()).toBe(first); await first;
  const next = await acquireCodingHookOwner(file); expect(next.birth).not.toBe(lease.birth); await next.release();
});
test("unowned stores stay inactive, and a released lease fences persisted policy transactions", async () => {
  const db = new Database(file);
  try {
    expect(() => new CodingHookStore(db).beginOwner()).toThrow("inactive"); expect(db.query("SELECT * FROM coding_hook_owner").all()).toEqual([]);
    const owner = await startCodingHookOwner(db); const before = JSON.stringify(db.query("SELECT * FROM coding_hook_owner").all()); await owner.close();
    expect(() => owner.store.beginOwner()).toThrow("inactive"); expect(() => owner.store.rotateOwner()).toThrow("inactive");
    expect(() => owner.store.commitInstallation("a".repeat(32), "b".repeat(32), "c".repeat(64), "d".repeat(64), "e".repeat(32))).toThrow("inactive");
    expect(JSON.stringify(db.query("SELECT * FROM coding_hook_owner").all())).toBe(before);
  } finally { db.close(); }
});
test("noncanonical, symlink and hardlink aliases cannot select another lease for the same database", async () => {
  const symlink = path.join(directory, "symlink.sqlite"), hardlink = path.join(directory, "hardlink.sqlite"); symlinkSync(file, symlink);
  for (const value of [symlink, "owner.sqlite", path.join(directory, "absent.sqlite")]) { let error: unknown; try { await acquireCodingHookOwner(value); } catch (caught) { error = caught; } expect(error).toBeInstanceOf(CodingHookOwnerRefusal); expect((error as CodingHookOwnerRefusal).reason).toBe("invalid_owner_path"); }
  linkSync(file, hardlink); expect(() => codingHookOwnerPort(file)).toThrow("invalid_owner_path"); expect(() => codingHookOwnerPort(hardlink)).toThrow("invalid_owner_path");
});
test("pre-aborted acquisition creates no lease or owner generation", async () => {
  const controller = new AbortController(); controller.abort(); let error: unknown;
  try { await acquireCodingHookOwner(file, controller.signal); } catch (caught) { error = caught; } expect(error).toBeInstanceOf(CodingHookOwnerRefusal); expect((error as CodingHookOwnerRefusal).reason).toBe("aborted");
  const lease = await acquireCodingHookOwner(file); await lease.release(); const db = new Database(file); try { expect(db.query("SELECT * FROM coding_hook_owner").all()).toEqual([]); } finally { db.close(); }
});
test("cancellation during acquisition releases any pending listener before retry", async () => {
  const controller = new AbortController(), pending = acquireCodingHookOwner(file, controller.signal); controller.abort();
  let error: unknown; try { await pending; } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(CodingHookOwnerRefusal); expect((error as CodingHookOwnerRefusal).reason).toBe("aborted");
  const next = await acquireCodingHookOwner(file); expect(next.isActive()).toBe(true); await next.release();
});
