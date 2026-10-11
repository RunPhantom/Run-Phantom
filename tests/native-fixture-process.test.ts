import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileSha256, launchOwnedProcess, startManagedDaemon, stopOwnedProcess } from "../app/tests-e2e/daemon-runtime";

const root = path.resolve(import.meta.dir, "..");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function expectFailure(operation: Promise<unknown>, code: string): Promise<void> {
  let error: unknown;
  try { await operation; } catch (failure) { error = failure; }
  expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain(code);
}
async function ready(child: ReturnType<typeof launchOwnedProcess>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture_probe_not_ready")), 5000);
    child.child.stdout!.once("data", () => { clearTimeout(timer); resolve(); });
    child.child.once("error", error => { clearTimeout(timer); reject(error); });
  });
}

test("a native digest mismatch and a script artifact refuse before a daemon or private store exists", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "runphantom-native-refusal-"));
  try {
    const script = path.join(directory, "script"); await writeFile(script, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await expectFailure(startManagedDaemon(root, { RUNPHANTOM_E2E_RUNTIME: "installed", RUNPHANTOM_E2E_BINARY: process.execPath,
      RUNPHANTOM_E2E_SHA256: "0".repeat(64) }, 4801), "native_digest_mismatch");
    await expectFailure(startManagedDaemon(root, { RUNPHANTOM_E2E_RUNTIME: "installed", RUNPHANTOM_E2E_BINARY: script,
      RUNPHANTOM_E2E_SHA256: await fileSha256(script) }, 4801), "native_artifact_format");
    expect((await readdir(await realpath(tmpdir()))).filter(name => name.startsWith("runphantom-w4801-"))).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a real healthy wrong native app is refused and its copied process/store are removed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "runphantom-wrong-native-"));
  try {
    const source = path.join(directory, "foreign.ts"), binary = path.join(directory, process.platform === "win32" ? "foreign.exe" : "foreign");
    const receipt = path.join(directory, "launched.json");
    await writeFile(source, 'await Bun.write(process.env.FIXTURE_RECEIPT!, JSON.stringify({pid:process.pid,cwd:process.cwd(),exe:process.execPath})); Bun.serve({hostname:"127.0.0.1",port:Number(process.env.RUNPHANTOM_PORT),fetch(){return Response.json({ok:true,service:"foreign-native",pid:process.pid,port:Number(process.env.RUNPHANTOM_PORT)})}});');
    const build = spawnSync(process.execPath, ["build", source, "--compile", "--outfile", binary], { stdio: "pipe", maxBuffer: 512 * 1024 });
    expect(build.status).toBe(0);
    await expectFailure(startManagedDaemon(root, { ...process.env, RUNPHANTOM_E2E_RUNTIME: "installed", RUNPHANTOM_E2E_BINARY: binary,
      RUNPHANTOM_E2E_SHA256: await fileSha256(binary), FIXTURE_RECEIPT: receipt }, 4802, 5000), "fixture_service_identity");
    const actual = JSON.parse(await readFile(receipt, "utf8")) as { pid: number; cwd: string; exe: string };
    expect(actual.exe).not.toBe(binary); expect(actual.cwd.startsWith(root)).toBe(false);
    expect(alive(actual.pid)).toBe(false);
    expect((await readdir(await realpath(tmpdir()))).filter(name => name.startsWith("runphantom-w4802-"))).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15_000);

test("forced teardown awaits owned process exit while an unrelated daemon remains alive", async () => {
  const script = 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000);';
  const owned = launchOwnedProcess(process.execPath, ["-e", script], root, process.env);
  const unrelated = launchOwnedProcess(process.execPath, ["-e", script], root, process.env);
  try {
    await Promise.all([ready(owned), ready(unrelated)]);
    const stopped = await stopOwnedProcess(owned);
    expect(stopped.forced).toBe(true); expect(stopped.closeObserved).toBe(true); expect(stopped.identity).not.toBeNull();
    expect(alive(owned.child.pid!)).toBe(false); expect(alive(unrelated.child.pid!)).toBe(true);
  } finally { await stopOwnedProcess(owned); await stopOwnedProcess(unrelated); }
}, 15_000);

test("forced teardown closes a real owned descendant tree", async () => {
  const childScript = 'process.on("SIGTERM",()=>{});console.log("child:"+process.pid);setInterval(()=>{},1000);';
  const parentScript = `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(childScript)}],{stdio:["ignore","inherit","inherit"]});process.on("SIGTERM",()=>{});setInterval(()=>{},1000);`;
  const owned = launchOwnedProcess(process.execPath, ["-e", parentScript], root, process.env);
  try {
    const childPid = await new Promise<number>((resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => reject(new Error("descendant_not_ready")), 5000);
      owned.child.stdout!.on("data", data => {
        text += String(data); const match = /child:(\d+)/.exec(text);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
    });
    expect(alive(childPid)).toBe(true);
    const stopped = await stopOwnedProcess(owned);
    expect(stopped.closeObserved).toBe(true); expect(alive(owned.child.pid!)).toBe(false); expect(alive(childPid)).toBe(false);
  } finally { await stopOwnedProcess(owned); }
}, 12_000);

test("lost process identity refuses escalation and retains the live process until ownership is restored", async () => {
  const owned = launchOwnedProcess(process.execPath, ["-e", 'console.log("ready");setInterval(()=>{},1000)'], root, process.env);
  const identity = owned.identity;
  try {
    await ready(owned); await identity; owned.identity = Promise.resolve("different-process-birth");
    await expectFailure(stopOwnedProcess(owned), "fixture_process_identity_lost");
    expect(alive(owned.child.pid!)).toBe(true);
  } finally { owned.identity = identity; await stopOwnedProcess(owned); }
}, 10_000);
