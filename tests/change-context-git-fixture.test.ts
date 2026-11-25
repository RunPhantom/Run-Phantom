import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { compileChangeGitFixture } from "./fixtures/change-context-git";

let native: ReturnType<typeof compileChangeGitFixture>;
const sleepers: ReturnType<typeof Bun.spawn>[] = [];
beforeAll(() => { native = compileChangeGitFixture(); }, 60_000);
afterAll(() => {
  for (const sleeper of sleepers) sleeper.kill();
  if (native) rmSync(native.directory, { recursive: true, force: true });
});

const started = (pid: number) =>
  appendFileSync(path.join(native.directory, "children.jsonl"), JSON.stringify({ id: `fixture-${pid}`, phase: "started", pid }) + "\n");

test("child-close confirmation waits for a Git child that is still exiting", async () => {
  const exiting = Bun.spawn([process.execPath, "-e", "await Bun.sleep(300)"]);
  started(exiting.pid);
  await native.assertClosed();
  expect(exiting.exitCode).toBe(0);
});

// close() removes the shared directory, so this test runs last.
test("a child that never closes fails the check and the fixture directory is still removed", async () => {
  const stuck = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30_000)"]);
  sleepers.push(stuck);
  started(stuck.pid);
  const failure = await native.close(200).then(() => null, (error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(`Native Git fixture child close was not confirmed within 200 ms (pids ${stuck.pid})`);
  expect(existsSync(native.directory)).toBe(false);
});
