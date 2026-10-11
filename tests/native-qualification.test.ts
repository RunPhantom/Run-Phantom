import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileSha256, startManagedDaemon } from "../app/tests-e2e/daemon-runtime";

test("qualification refuses missing artifacts, mismatched native digests and ambiguous arguments before creating receipts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "runphantom-qualifier-negative-"));
  const root = path.resolve(import.meta.dir, "..");
  const output = path.join(directory, "receipts");
  const run = (args: string[]) => spawnSync(process.execPath, ["scripts/qualify-native.ts", ...args], { cwd: root, timeout: 5000, maxBuffer: 64 * 1024, encoding: "utf8" });
  try {
    for (const [args, code] of [
      [[`--binary=${path.join(directory, "missing")}`, `--sha256=${"0".repeat(64)}`, `--output=${output}`], "ENOENT"],
      [[`--binary=${process.execPath}`, `--sha256=${"0".repeat(64)}`, `--output=${output}`], "native_digest_mismatch"],
      [[`--binary=${process.execPath}`, `--binary=${process.execPath}`], "native_duplicate_option"],
      [["--build"], "native_unknown_option"],
    ] as const) {
      const result = run([...args]);
      expect(result.status).toBe(1); expect(result.stderr).toContain(code); expect(result.error).toBeUndefined();
      expect(await readdir(directory)).toEqual([]);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a native Bun interpreter cannot become an installed application or fall back to source", async () => {
  let error: unknown;
  try {
    await startManagedDaemon(path.resolve(import.meta.dir, ".."), { ...process.env, RUNPHANTOM_E2E_RUNTIME: "installed",
      RUNPHANTOM_E2E_BINARY: process.execPath, RUNPHANTOM_E2E_SHA256: await fileSha256(process.execPath) }, 4803, 5000);
  } catch (failure) { error = failure; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("fixture_daemon_exit");
  expect((await readdir(tmpdir())).filter(name => name.startsWith("runphantom-w4803-"))).toEqual([]);
}, 10_000);
