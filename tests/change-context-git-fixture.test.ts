import { afterAll, expect, test } from "bun:test";
import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import { compileChangeGitFixture } from "./fixtures/change-context-git";

const sleepers: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => { for (const sleeper of sleepers) sleeper.kill(); });

const started = (directory: string, pid: number) =>
  appendFileSync(path.join(directory, "children.jsonl"), JSON.stringify({ id: `fixture-${pid}`, phase: "started", pid }) + "\n");

test("child-close confirmation waits for a Git child that is still exiting", async () => {
  const native = compileChangeGitFixture();
  try {
    const exiting = Bun.spawn([process.execPath, "-e", "await Bun.sleep(300)"]);
    started(native.directory, exiting.pid);
    await native.assertClosed();
    expect(exiting.exitCode).toBe(0);
  } finally { await native.close(); }
  expect(existsSync(native.directory)).toBe(false);
}, 60_000);

test("a child that never closes fails the check and the fixture directory is still removed", async () => {
  const native = compileChangeGitFixture();
  const stuck = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30_000)"]);
  sleepers.push(stuck);
  started(native.directory, stuck.pid);
  const failure = await native.close(200).then(() => null, (error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(`Native Git fixture child close was not confirmed within 200 ms (pids ${stuck.pid})`);
  expect(existsSync(native.directory)).toBe(false);
}, 60_000);
