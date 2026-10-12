import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileSha256, outsideCheckout, launchOwnedProcess, stopOwnedProcess, startManagedDaemon, type RuntimeProvenance } from "../app/tests-e2e/daemon-runtime";

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


test("outside-checkout projection accepts another Windows drive and refuses the checkout or its descendants", () => {
  expect(outsideCheckout("D:\\repo", "C:\\Temp\\owned", path.win32)).toBe(true);
  expect(outsideCheckout("D:\\repo", "D:\\repo", path.win32)).toBe(false);
  expect(outsideCheckout("D:\\repo", "D:\\repo\\private", path.win32)).toBe(false);
  expect(outsideCheckout("D:\\repo", "D:\\Temp\\owned", path.win32)).toBe(true);
});

const binary = process.env.RUNPHANTOM_F48_TEST_BINARY;
test.skipIf(!binary || process.platform !== "darwin")("interrupted actual copied qualifier reaps its daemon and private profile independently of the runner", async () => {
  const root = path.resolve(import.meta.dir, "..");
  const directory = await mkdtemp(path.join(tmpdir(), "runphantom-qualifier-interruption-"));
  const receipt = path.join(directory, "probe.json"), output = path.join(directory, "qualification");
  const qualifier = launchOwnedProcess(process.execPath, ["scripts/qualify-native.ts", `--binary=${binary!}`, `--sha256=${await fileSha256(binary!)}`, `--output=${output}`, "native-fixture.spec.ts"], root, { ...process.env, PHANTOM_NATIVE_INTERRUPT_RECEIPT: receipt });
  qualifier.child.stdout?.resume(); qualifier.child.stderr?.resume();
  const unrelated = launchOwnedProcess(process.execPath, ["-e", 'console.log("ready");setInterval(()=>{},1000)'], root, process.env);
  unrelated.child.stdout?.resume(); unrelated.child.stderr?.resume();
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const birth = (pid: number) => spawnSync("ps", ["-p", String(pid), "-o", "lstart=,command="], { encoding: "utf8", timeout: 3000 }).stdout.trim();
  let probe: { runtime: RuntimeProvenance; url: string; workerPid: number; runnerPid: number } | undefined;
  const births = new Map<number, string>();
  try {
    for (let i = 0; i < 400; i++) { try { probe = JSON.parse(await readFile(receipt, "utf8")) as typeof probe; break; } catch { if (qualifier.closeObserved) throw new Error("qualifier_exited_before_probe"); await Bun.sleep(50); } }
    if (!probe) throw new Error("qualifier_probe_missing");
    for (const pid of [probe.runnerPid, probe.workerPid, probe.runtime.pid]) { const identity = birth(pid); expect(identity.length).toBeGreaterThan(0); births.set(pid, identity); }
    expect((await fetch(`${probe.url}/health`, { signal: AbortSignal.timeout(1000) })).status).toBe(200);
    for (const pid of [probe.workerPid, probe.runnerPid]) { if (birth(pid) !== births.get(pid)) throw new Error("probe_runner_identity_changed"); process.kill(pid, "SIGKILL"); }
    await Promise.race([qualifier.closed, Bun.sleep(15_000).then(() => { throw new Error("qualifier_interruption_not_closed"); })]);
    let removed = false; try { await stat(probe.runtime.stateDirectory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") removed = true; else throw error; }
    console.log(JSON.stringify({ probe: "interrupted-qualifier", qualifierPid: qualifier.child.pid, ...probe, daemonAlive: alive(probe.runtime.pid), directoryRemoved: removed, qualifierExit: qualifier.child.exitCode }));
    expect(qualifier.child.exitCode).toBe(1); expect(alive(probe.runtime.pid)).toBe(false); expect(removed).toBe(true); expect(alive(unrelated.child.pid!)).toBe(true);
    let serving = false; try { serving = (await fetch(`${probe.url}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* closed listener */ }
    expect(serving).toBe(false);
  } finally {
    for (const pid of probe ? [probe.workerPid, probe.runnerPid, probe.runtime.pid] : []) {
      if (alive(pid)) { if (birth(pid) !== births.get(pid)) throw new Error("probe_cleanup_identity_changed"); process.kill(pid, "SIGKILL"); }
    }
    if (!qualifier.closeObserved) await stopOwnedProcess(qualifier);
    if (probe) { for (let i = 0; i < 100 && alive(probe.runtime.pid); i++) await Bun.sleep(25); expect(alive(probe.runtime.pid)).toBe(false); await rm(probe.runtime.stateDirectory, { recursive: true, force: true }); }
    await stopOwnedProcess(unrelated); await rm(directory, { recursive: true, force: true });
  }
}, 40_000);
