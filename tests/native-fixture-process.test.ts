import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileSha256, launchOwnedProcess, ownedProcessMatches, startManagedDaemon, startFixtureDaemon, startFixtureSupervisor, stopOwnedProcess, windowsNativeEnvironment, windowsOwnershipQuery, windowsProcessBirth } from "../app/tests-e2e/daemon-runtime";
import * as runtime from "../app/tests-e2e/daemon-runtime";

const root = path.resolve(import.meta.dir, "..");
const diagnosticSystem = { PATH: "C:\\Windows\\System32", SystemRoot: "C:\\Windows" };
const diagnosticAppData = "C:\\Users\\fixture\\AppData\\Roaming";
function diagnosticAppDataEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const projected = windowsNativeEnvironment(input);
  let value: string | undefined;
  for (const [key, field] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
    if (![...key].every(character => character.charCodeAt(0) <= 0x7f) || key.toLowerCase() !== "appdata") continue;
    if (!("value" in field) || typeof field.value !== "string" || !field.value || field.value.length > 32767 || field.value.includes("\0"))
      throw new Error("diagnostic_environment_invalid");
    if (value !== undefined && value !== field.value) throw new Error("diagnostic_environment_conflict");
    value = field.value;
  }
  if (value === undefined) throw new Error("diagnostic_environment_required");
  return { ...projected, APPDATA: value };
}
function diagnosticSpawnError(code: string | undefined): string | null {
  return code === undefined ? null : ["ETIMEDOUT", "ENOENT", "EACCES", "EPERM", "ENOBUFS"].includes(code) ? code : "other";
}

test("test-only APPDATA projection admits one own ASCII system field without module or provider options", () => {
  let reads = 0;
  const input = { ...diagnosticSystem, APPDATA: diagnosticAppData, OPENAI_API_KEY: "fixture-secret",
    PSModulePath: "caller-modules", PSExecutionPolicyPreference: "Bypass" };
  Object.defineProperty(input, "UNKNOWN_OPTION", { get: () => { reads++; return "option"; } });
  expect(diagnosticAppDataEnvironment(input)).toEqual({ ...diagnosticSystem, APPDATA: diagnosticAppData, LANG: "C", TZ: "UTC" });
  expect(diagnosticAppDataEnvironment({ ...diagnosticSystem, appdata: diagnosticAppData, APPDATA: diagnosticAppData }))
    .toEqual({ ...diagnosticSystem, APPDATA: diagnosticAppData, LANG: "C", TZ: "UTC" });
  expect(reads).toBe(0);
});

test("test-only APPDATA projection refuses conflicting aliases and unsupported own data without reading getters", () => {
  expect(() => diagnosticAppDataEnvironment({ ...diagnosticSystem, APPDATA: diagnosticAppData, appdata: "different" }))
    .toThrow("diagnostic_environment_conflict");
  let reads = 0;
  const accessor = Object.defineProperty({ ...diagnosticSystem }, "APPDATA", { get: () => { reads++; return diagnosticAppData; } });
  expect(() => diagnosticAppDataEnvironment(accessor)).toThrow("diagnostic_environment_invalid");
  expect(reads).toBe(0);
  for (const APPDATA of [42, "", "value\0other", "x".repeat(32768)])
    expect(() => diagnosticAppDataEnvironment({ ...diagnosticSystem, APPDATA } as unknown as NodeJS.ProcessEnv))
      .toThrow("diagnostic_environment_invalid");
});

test("test-only APPDATA projection never obtains its field from Unicode aliases or inherited values", () => {
  for (const input of [diagnosticSystem, { ...diagnosticSystem, "ＡＰＰＤＡＴＡ": diagnosticAppData },
    Object.assign(Object.create({ APPDATA: diagnosticAppData }) as NodeJS.ProcessEnv, diagnosticSystem)])
    expect(() => diagnosticAppDataEnvironment(input)).toThrow("diagnostic_environment_required");
});

test("test-only diagnostic spawn errors expose a closed category rather than arbitrary error text", () => {
  expect(diagnosticSpawnError(undefined)).toBeNull();
  expect(diagnosticSpawnError("ETIMEDOUT")).toBe("ETIMEDOUT");
  expect(diagnosticSpawnError("ENOENT")).toBe("ENOENT");
  expect(diagnosticSpawnError("fixture-private-error-data")).toBe("other");
});

const probeBirth = (pid: number) => {
  const result = process.platform === "win32" ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}";if($p){$p.CreationDate.ToUniversalTime().ToString("o")}`], { encoding: "utf8", timeout: 3000 }) :
    spawnSync("ps", ["-p", String(pid), "-o", "lstart=,command="], { encoding: "utf8", timeout: 3000 });
  return result.stdout?.trim() ?? "";
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function terminateRecorded(pid: number, identity: string, birth: (pid: number) => string): void {
  if (!alive(pid)) return;
  if (!identity || birth(pid) !== identity) throw new Error("probe_child_identity_changed");
  process.kill(pid, "SIGKILL");
}
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

test("a live registered process acquires an exact native birth before cleanup authority is used", async () => {
  const owned = launchOwnedProcess(process.execPath, ["-e", 'console.log("ready");setInterval(()=>{},1000)'], root, process.env);
  let independentBirth = "";
  try {
    await ready(owned);
    let identity: string | null = null, acquisitionFailure: unknown;
    try { identity = await owned.identity; } catch (error) { acquisitionFailure = error; }
    if (!identity && process.platform === "win32") {
      const firstFailure = runtime.nativeCommandFailure(acquisitionFailure);
      if (firstFailure) console.log(JSON.stringify(firstFailure));
      const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${owned.child.pid}";if($p){$p.CreationDate.ToUniversalTime().ToString("o")}`;
      for (const mode of ["full", "current-wrapper"] as const) {
        const began = performance.now();
        const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
          encoding: "utf8", timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true,
          env: mode === "full" ? process.env : { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LANG: "C", TZ: "UTC" },
        });
        if (mode === "full" && result.status === 0) independentBirth = result.stdout.trim();
        console.log(JSON.stringify({ probe: "windows-birth-acquisition", mode, pid: owned.child.pid,
          status: result.status, signal: result.signal, errorCode: diagnosticSpawnError((result.error as NodeJS.ErrnoException | undefined)?.code),
          hasBirth: !!result.stdout?.trim(), wallMs: Math.round(performance.now() - began) }));
      }
      // Diagnose the actual finite environment/query separately from the historical four-field probe.
      for (const mode of ["finite-eight-exact-query", "finite-eight-explicit-cim", "full-exact-query",
        "finite-eight-intrinsic-modules", "finite-eight-appdata", "finite-eight-appdata-intrinsic-modules"] as const) {
        const query = windowsOwnershipQuery(owned.child.pid!);
        let environment: NodeJS.ProcessEnv;
        try {
          environment = mode === "full-exact-query" ? process.env : mode.includes("appdata")
            ? diagnosticAppDataEnvironment(process.env) : windowsNativeEnvironment(process.env);
        } catch {
          console.log(JSON.stringify({ probe: "windows-exact-ownership-query", mode, pid: owned.child.pid,
            configuration: "unavailable", status: null, signal: null, errorCode: "configuration-unavailable",
            hasBirth: false, sameRecordedBirth: null, stages: [], errorClasses: [], stderrBytes: 0, wallMs: 0 }));
          continue;
        }
        const modulePath = mode.includes("intrinsic-modules")
          ? "[Console]::Error.WriteLine('rp-stage:before-module-path');$env:PSModulePath=[System.IO.Path]::Combine($PSHOME,'Modules');[Console]::Error.WriteLine('rp-stage:after-module-path');"
          : "";
        const moduleImport = mode === "finite-eight-explicit-cim"
          ? "[Console]::Error.WriteLine('rp-stage:before-import');Import-Module -Name ([System.IO.Path]::Combine($PSHOME,'Modules','CimCmdlets','CimCmdlets.psd1')) -ErrorAction Stop;[Console]::Error.WriteLine('rp-stage:after-import');"
          : "";
        const diagnostic = "$ErrorActionPreference='Stop';try{[Console]::Error.WriteLine('rp-stage:entered');" + modulePath + moduleImport +
          "[Console]::Error.WriteLine('rp-stage:before-query');" + query +
          ";[Console]::Error.WriteLine('rp-stage:after-query')}catch{$class=switch($_.Exception.GetType().Name){'CommandNotFoundException'{'command-not-found'};'CimException'{'cim'};'FileNotFoundException'{'file-not-found'};'UnauthorizedAccessException'{'access-denied'};'InvalidOperationException'{'invalid-operation'};default{'other'}};[Console]::Error.WriteLine('rp-error:'+$class);exit 1}";
        const began = performance.now();
        const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", diagnostic], {
          encoding: "utf8", timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true,
          env: environment,
        });
        let parsedIdentity: string | null = null;
        if (result.status === 0) {
          try { parsedIdentity = windowsProcessBirth(result.stdout, owned.child.pid!); } catch { /* Diagnostics never provide ownership authority. */ }
        }
        const stderr = typeof result.stderr === "string" ? result.stderr : "";
        const stages = [...stderr.matchAll(/\brp-stage:(entered|before-module-path|after-module-path|before-import|after-import|before-query|after-query)\b/g)].map(match => match[1]);
        const errorClasses = [...stderr.matchAll(/\brp-error:(command-not-found|cim|file-not-found|access-denied|invalid-operation|other)\b/g)].map(match => match[1]);
        console.log(JSON.stringify({ probe: "windows-exact-ownership-query", mode, pid: owned.child.pid,
          configuration: "ready", status: result.status, signal: result.signal, errorCode: diagnosticSpawnError((result.error as NodeJS.ErrnoException | undefined)?.code),
          hasBirth: parsedIdentity !== null, sameRecordedBirth: parsedIdentity && independentBirth ? parsedIdentity === `${owned.child.pid}:${independentBirth}` : null,
          stages, errorClasses, stderrBytes: Buffer.byteLength(stderr), wallMs: Math.round(performance.now() - began) }));
      }
    }
    expect(acquisitionFailure).toBeUndefined();
    expect(identity).not.toBeNull();
    expect(identity?.startsWith(`${owned.child.pid}:`)).toBe(true);
    expect(await ownedProcessMatches(owned)).toBe(true);
    expect(alive(owned.child.pid!)).toBe(true);
    const stopped = await stopOwnedProcess(owned);
    expect(stopped.identity).toBe(identity); expect(stopped.closeObserved).toBe(true);
    expect(alive(owned.child.pid!)).toBe(false);
  } finally {
    if (independentBirth && alive(owned.child.pid!)) {
      terminateRecorded(owned.child.pid!, independentBirth, probeBirth);
      await Promise.race([owned.closed, Bun.sleep(3000).then(() => { throw new Error("probe_pipe_not_closed"); })]);
    } else await stopOwnedProcess(owned);
  }
}, 40_000); // Eight finite 3s probes; the native observation deadline itself remains unchanged.

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
  let childPid = 0, childBirth = "";
  const birth = probeBirth;
  try {
    childPid = await new Promise<number>((resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => reject(new Error("descendant_not_ready")), 5000);
      owned.child.stdout!.on("data", data => {
        text += String(data); const match = /child:(\d+)/.exec(text);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
    });
    childBirth = birth(childPid); console.log(JSON.stringify({ probe: "surviving-parent", parentPid: owned.child.pid, childPid, childBirth }));
    expect(alive(childPid)).toBe(true);
    const stopped = await stopOwnedProcess(owned);
    expect(stopped.closeObserved).toBe(true); expect(alive(owned.child.pid!)).toBe(false); expect(alive(childPid)).toBe(false);
  } finally {
    if (childPid) terminateRecorded(childPid, childBirth, birth);
    await stopOwnedProcess(owned);
  }
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


test.skipIf(process.platform === "win32")("an exited parent cannot abandon its recorded child holding inherited pipes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "runphantom-exited-parent-"));
  const signal = path.join(directory, "exit");
  const childScript = 'process.on("SIGTERM",()=>{});console.log("child:"+process.pid);setInterval(()=>{},1000);';
  const parentScript = `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(childScript)}],{stdio:["ignore","inherit","inherit"]});setInterval(()=>{if(require("node:fs").existsSync(${JSON.stringify(signal)}))process.exit(0)},25);`;
  const owned = launchOwnedProcess(process.execPath, ["-e", parentScript], root, process.env);
  const unrelated = launchOwnedProcess(process.execPath, ["-e", 'console.log("ready");setInterval(()=>{},1000)'], root, process.env);
  let childPid = 0, childBirth = "";
  const birth = probeBirth;
  try {
    await ready(unrelated);
    childPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("descendant_not_ready")), 5000);
      owned.child.stdout!.on("data", data => { const match = /child:(\d+)/.exec(String(data)); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
    });
    childBirth = birth(childPid); expect(childBirth.length).toBeGreaterThan(0);
    await Bun.sleep(500); // The live parent/child relationship is observable before exit.
    const exited = new Promise<void>(resolve => owned.child.once("exit", () => resolve()));
    await writeFile(signal, "exit"); await exited;
    expect(alive(owned.child.pid!)).toBe(false); expect(alive(childPid)).toBe(true); expect(owned.closeObserved).toBe(false);
    let failure: unknown;
    try { await stopOwnedProcess(owned); } catch (error) { failure = error; }
    console.log(JSON.stringify({ probe: "exited-parent", parentPid: owned.child.pid, childPid, childBirth, failure: failure instanceof Error ? failure.message : null, childAlive: alive(childPid), closeObserved: owned.closeObserved }));
    expect(failure).toBeUndefined(); expect(alive(childPid)).toBe(false); expect(owned.closeObserved).toBe(true); expect(alive(unrelated.child.pid!)).toBe(true);
  } finally {
    if (childPid) terminateRecorded(childPid, childBirth, birth);
    if (alive(owned.child.pid!)) await stopOwnedProcess(owned);
    await Promise.race([owned.closed, Bun.sleep(3000).then(() => { throw new Error("probe_pipe_not_closed"); })]);
    await stopOwnedProcess(unrelated); await rm(directory, { recursive: true, force: true });
  }
}, 15_000);


test("a counterfeit owned handle cannot terminate a genuine live process", async () => {
  const owned = launchOwnedProcess(process.execPath, ["-e", 'console.log("ready");setInterval(()=>{},1000)'], root, process.env);
  try { await ready(owned); await expectFailure(stopOwnedProcess({ ...owned }), "fixture_process_unknown_owner"); expect(alive(owned.child.pid!)).toBe(true); }
  finally { await stopOwnedProcess(owned); }
});

test("the qualifier-owned source supervisor closes normal and interrupted fixture daemons without trusting runner receipts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "runphantom-source-supervisor-"));
  const supervisor = await startFixtureSupervisor(root, { ...process.env, RUNPHANTOM_E2E_RUNTIME: "source", RUNPHANTOM_E2E_BINARY: undefined, RUNPHANTOM_E2E_SHA256: undefined });
  let runner: ReturnType<typeof launchOwnedProcess> | undefined;
  const unrelated = launchOwnedProcess(process.execPath, ["-e", 'console.log("ready");setInterval(()=>{},1000)'], root, process.env);
  let closed = false;
  try {
    await ready(unrelated);
    const environment = { ...process.env, ...supervisor.environment };
    await expectFailure(startFixtureDaemon(root, { ...environment, RUNPHANTOM_E2E_SUPERVISOR_TOKEN: "0".repeat(64) }, 0), "fixture_supervisor_auth");
    const normal = await startFixtureDaemon(root, environment, 0);
    expect(normal.runtime.mode).toBe("source"); expect((await fetch(`${normal.url}/health`)).ok).toBe(true);
    await expectFailure(startFixtureDaemon(root, environment, 1), "fixture_supervisor_job_limit");
    const refused = async (message: Record<string, unknown>) => await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: Number(supervisor.environment.RUNPHANTOM_E2E_SUPERVISOR_PORT) });
      let body = ""; socket.setTimeout(3000, () => { socket.destroy(); reject(new Error("probe_protocol_timeout")); });
      socket.on("error", reject); socket.once("connect", () => { socket.write(JSON.stringify({ token: supervisor.environment.RUNPHANTOM_E2E_SUPERVISOR_TOKEN, ...message }) + "\n"); });
      socket.on("data", chunk => { body += String(chunk); if (body.includes("\n")) { socket.destroy(); resolve((JSON.parse(body) as { error: string }).error); } });
    });
    expect(await refused({ op: "stop", job: "0".repeat(32) })).toBe("fixture_supervisor_unknown_job");
    expect(await refused({ op: "start", command: "kill", pid: unrelated.child.pid })).toBe("fixture_supervisor_protocol");
    expect(alive(unrelated.child.pid!)).toBe(true);
    const cleanup = await normal.stop(); expect(cleanup.process.closeObserved).toBe(true); expect(alive(normal.runtime.pid)).toBe(false);
    const receipt = path.join(directory, "daemon.json");
    const program = path.join(directory, "runner.ts");
    await writeFile(program, `import {startFixtureDaemon} from ${JSON.stringify(path.join(root, "app/tests-e2e/daemon-runtime.ts"))}; const daemon=await startFixtureDaemon(${JSON.stringify(root)},process.env,0);await Bun.write(${JSON.stringify(receipt)},JSON.stringify({runtime:daemon.runtime,url:daemon.url}));setInterval(()=>{},1000);`);
    runner = launchOwnedProcess(process.execPath, [program], directory, environment); runner.child.stdout?.resume(); runner.child.stderr?.resume();
    let daemon: { runtime: { pid: number; mode: string; stateDirectory: string }; url: string } | undefined;
    for (let i = 0; i < 200; i++) { try { daemon = JSON.parse(await readFile(receipt, "utf8")) as typeof daemon; break; } catch { await Bun.sleep(50); } }
    if (!daemon) throw new Error("source_supervisor_probe_missing");
    expect(daemon.runtime.mode).toBe("source"); expect((await fetch(`${daemon.url}/health`)).ok).toBe(true);
    await stopOwnedProcess(runner); expect(alive(daemon.runtime.pid)).toBe(true);
    const jobs = await supervisor.close(); closed = true;
    expect(jobs).toHaveLength(2); expect(alive(daemon.runtime.pid)).toBe(false);
    expect((await readdir(path.dirname(daemon.runtime.stateDirectory))).includes(path.basename(daemon.runtime.stateDirectory))).toBe(false);
    expect(alive(unrelated.child.pid!)).toBe(true);
    console.log(JSON.stringify({ probe: "source-supervisor-interruption", runnerPid: runner.child.pid, daemonPid: daemon.runtime.pid, jobs: jobs.map(job => ({pid:job.runtime.pid,closeObserved:job.cleanup.process.closeObserved,directoryRemoved:job.cleanup.directoryRemoved})) }));
  } finally { if (runner) await stopOwnedProcess(runner); if (!closed) await supervisor.close(); await stopOwnedProcess(unrelated); await rm(directory, { recursive: true, force: true }); }
}, 25_000);


test.skipIf(process.platform === "win32")("changing an owned process title does not impersonate a different process birth", async () => {
  const owned = launchOwnedProcess("node", ["-e", 'console.log("ready");setTimeout(()=>{process.title="runphantom-owned-title-change";console.log("changed")},200);setInterval(()=>{},1000);'], root, process.env);
  let current = "";
  try {
    await ready(owned); const original = probeBirth(owned.child.pid!); await Bun.sleep(500); current = probeBirth(owned.child.pid!);
    expect(original).not.toBe(current); expect(current).toContain("runphantom-owned-title-change");
    let failure: unknown; try { await stopOwnedProcess(owned); } catch (error) { failure = error; }
    console.log(JSON.stringify({probe:"mutable-title",pid:owned.child.pid,original,current,failure:failure instanceof Error ? failure.message : null,closeObserved:owned.closeObserved}));
    expect(failure).toBeUndefined(); expect(owned.closeObserved).toBe(true); expect(alive(owned.child.pid!)).toBe(false);
  } finally { if (current) terminateRecorded(owned.child.pid!, current, probeBirth); await owned.closed; }
}, 8000);
