import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireCodingHookOwner, codingHookOwnerLockPath } from "../src/coding-hooks/owner";
import { acquireComparisonOwner } from "../src/prompts/comparison-owner";

let directory: string, file: string;
const children: ReturnType<typeof Bun.spawn>[] = [];
const owners: Awaited<ReturnType<typeof acquireComparisonOwner>>[] = [];
beforeEach(() => {
  directory = realpathSync(mkdtempSync(path.join(tmpdir(), "rp-comparison-owner-"))); file = path.join(directory, "owner.sqlite");
  const db = new Database(file); db.exec("CREATE TABLE lease_probe(recovery_writes INTEGER NOT NULL); INSERT INTO lease_probe VALUES(0)"); db.close();
});
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close().catch(() => owner.drained());
  for (const child of children.splice(0)) { child.kill("SIGKILL"); await child.exited; }
  rmSync(directory, { recursive: true, force: true });
});
async function owned() { const owner = await acquireComparisonOwner(file); owners.push(owner); return owner; }
async function refusal(pending: Promise<unknown>) { try { await pending; throw new Error("unexpected ownership"); } catch (error) { return error; } }
async function launch(dbPath = file) {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/prompt-comparison-owner-process.ts"), dbPath], { stdout: "pipe", stderr: "pipe", env: { ...process.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" } }); children.push(child);
  const reader = child.stdout.getReader(); let raw = "";
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  try { while (!raw.includes("\n")) { const next = await reader.read(); if (next.done) break; raw += new TextDecoder().decode(next.value); } }
  finally { clearTimeout(timer); reader.releaseLock(); }
  return { child, receipt: JSON.parse(raw) as { status: string; reason?: string; birth?: string; recoveryWrites: number; providerCalls: number } };
}
test("closed comparison namespace uses its own lock beside the database and refuses arbitrary domains", async () => {
  expect(codingHookOwnerLockPath(file)).toBe(file + ".hook-owner.lock"); expect(codingHookOwnerLockPath(file, "coding-hooks")).toBe(file + ".hook-owner.lock");
  expect(codingHookOwnerLockPath(file, "prompt-comparisons")).toBe(file + ".comparison-owner.lock");
  expect(() => codingHookOwnerLockPath(file, "caller-domain" as "prompt-comparisons")).toThrow();
  const hooks = await acquireCodingHookOwner(file); try { expect(hooks.lockPath).toBe(file + ".hook-owner.lock"); const comparison = await owned(); expect(comparison.capture().birth).toMatch(/^[a-f0-9]{32}$/); } finally { await hooks.release(); }
});
test("actual competing process refuses before recovery writes or provider calls; kernel exit permits a new birth", async () => {
  const first = await launch(); expect(first.receipt.status).toBe("owned"); expect(first.receipt.recoveryWrites).toBe(1);
  const second = await launch(); expect(second.receipt).toMatchObject({ status: "refused", reason: "occupied", recoveryWrites: 0, providerCalls: 0 });
  const db = new Database(file); try { expect(db.query("SELECT recovery_writes FROM lease_probe").get()).toEqual({ recovery_writes: 1 }); } finally { db.close(); }
  first.child.kill("SIGKILL"); await first.child.exited;
  const successor = await launch(); expect(successor.receipt.status).toBe("owned"); expect(successor.receipt.birth).not.toBe(first.receipt.birth);
});
test("a held comparison lock refuses without recovery", async () => {
  const holder = new Database(codingHookOwnerLockPath(file, "prompt-comparisons")); holder.exec("PRAGMA busy_timeout=0"); holder.exec("BEGIN EXCLUSIVE");
  try { expect((await launch()).receipt).toMatchObject({ status: "refused", reason: "occupied", recoveryWrites: 0, providerCalls: 0 }); }
  finally { holder.close(); }
});
test("many distinct databases are owned concurrently without contending for a shared namespace", async () => {
  for (let index = 0; index < 64; index++) { const candidate = path.join(directory, `distinct-${index}.sqlite`); writeFileSync(candidate, ""); owners.push(await acquireComparisonOwner(candidate)); }
});
test("file replacement and symlink aliases invalidate captured comparison authority", async () => {
  const owner = await owned(), fence = owner.capture(); renameSync(file, file + ".old"); writeFileSync(file, "");
  expect(() => owner.assertCurrent(fence)).toThrow(); expect(() => owner.capture()).toThrow();
  const symlink = path.join(directory, "alias.sqlite"); symlinkSync(file, symlink);
  expect(await refusal(acquireComparisonOwner(symlink))).toHaveProperty("reason", "invalid_owner_path");
});
test("pre-aborted and racing-aborted acquisition leave no comparison listener", async () => {
  const before = new AbortController(); before.abort(); expect(await refusal(acquireComparisonOwner(file, before.signal))).toHaveProperty("reason", "aborted");
  const racing = new AbortController(), pending = acquireComparisonOwner(file, racing.signal); racing.abort(); expect(await refusal(pending)).toHaveProperty("reason", "aborted");
  const owner = await owned(); expect(owner.capture().birth).toMatch(/^[a-f0-9]{32}$/);
});
test("one owner grants at most two dispatch slots across every operation and fences late callbacks", async () => {
  const owner = await owned(), fence = owner.capture(); let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; }); let running = 0, peak = 0;
  const task = async () => { running++; peak = Math.max(peak, running); await held; running--; };
  const one = owner.dispatch(fence, task), two = owner.dispatch(fence, task);
  expect(await refusal(owner.dispatch(fence, task))).toHaveProperty("code", "busy"); expect(peak).toBe(2);
  const closing = owner.close(); expect(() => owner.assertCurrent(fence)).toThrow();
  expect(await refusal(acquireComparisonOwner(file))).toHaveProperty("reason", "occupied");
  finish(); await Promise.all([one, two]); await closing; expect(running).toBe(0);
  const successor = await acquireComparisonOwner(file); owners.push(successor); expect(successor.capture().birth).not.toBe(fence.birth);
});
test("native fetch abort drains before lease release and an uncooperative fixture cannot release on deadline", async () => {
  const owner = await owned(), fence = owner.capture(); let received!: () => void;
  const requestSeen = new Promise<void>(resolve => { received = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { received(); return new Response(new ReadableStream({ start() {} })); } });
  try {
    const result = owner.dispatch(fence, async signal => { try { const response = await fetch(server.url, { signal }); await response.arrayBuffer(); } catch { expect(signal.aborted).toBe(true); } });
    await requestSeen; await owner.close(); await result;
  } finally { await server.stop(true); }
  const uncooperative = await acquireComparisonOwner(file); owners.push(uncooperative); const captured = uncooperative.capture(); let finish!: () => void;
  const result = uncooperative.dispatch(captured, () => new Promise<void>(resolve => { finish = resolve; }));
  const failure = await refusal(uncooperative.close()); expect(failure).toHaveProperty("reason", "deadline");
  expect(await refusal(acquireComparisonOwner(file))).toHaveProperty("reason", "occupied"); finish(); await result;
  await uncooperative.drained(); const successor = await acquireComparisonOwner(file); owners.push(successor);
}, 10000);
