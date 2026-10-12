import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileSha256, outsideCheckout, launchOwnedProcess, ownedProcessMatches, stopOwnedProcess, startManagedDaemon, windowsNativeEnvironment, windowsProcessSnapshot, windowsProcessBirth, windowsOwnershipQuery, type RuntimeProvenance } from "../app/tests-e2e/daemon-runtime";
import * as runtime from "../app/tests-e2e/daemon-runtime";

const systemEnvironment = { PATH: "C:\\Windows\\System32", SystemRoot: "C:\\Windows", windir: "C:\\Windows", TEMP: "C:\\Temp", TMP: "C:\\Temp",
  USERPROFILE: "C:\\Users\\fixture", LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local", ProgramFiles: "C:\\Program Files" };
const birthStamp = "2026-10-12T02:05:11.1234567Z";

test("Windows native command projection retains only finite system locations and fixed locale", () => {
  let unknownReads = 0;
  const input = { ...systemEnvironment, ANTHROPIC_API_KEY: "fixture-secret", OPENAI_API_KEY: "fixture-secret", RUNPHANTOM_PORT: "1",
    PSModulePath: "untrusted-module", PSExecutionPolicyPreference: "Bypass", LANG: "other", TZ: "other" };
  Object.defineProperty(input, "UNKNOWN_OPTION", { enumerable: true, get: () => { unknownReads++; return "unknown"; } });
  expect(windowsNativeEnvironment(input)).toEqual({ ...systemEnvironment, LANG: "C", TZ: "UTC" });
  expect(unknownReads).toBe(0);
});

test("Windows system projection canonicalizes ASCII names and refuses conflicting aliases", () => {
  expect(windowsNativeEnvironment({ path: systemEnvironment.PATH, SYSTEMROOT: systemEnvironment.SystemRoot, localappdata: systemEnvironment.LOCALAPPDATA }))
    .toEqual({ PATH: systemEnvironment.PATH, SystemRoot: systemEnvironment.SystemRoot, LOCALAPPDATA: systemEnvironment.LOCALAPPDATA, LANG: "C", TZ: "UTC" });
  expect(windowsNativeEnvironment({ ...systemEnvironment, Path: systemEnvironment.PATH })).toEqual({ ...systemEnvironment, LANG: "C", TZ: "UTC" });
  expect(() => windowsNativeEnvironment({ ...systemEnvironment, Path: "different" })).toThrow("native_environment_conflict");
  expect(() => windowsNativeEnvironment({ ...systemEnvironment, SYSTEMROOT: "different" })).toThrow("native_environment_conflict");
});

test("Windows operational fields cannot come from Unicode aliases, prototypes or accessors", () => {
  expect(() => windowsNativeEnvironment({ "ſystemRoot": systemEnvironment.SystemRoot, PATH: systemEnvironment.PATH })).toThrow("native_environment_required");
  expect(() => windowsNativeEnvironment({ "ＰＡＴＨ": systemEnvironment.PATH, SystemRoot: systemEnvironment.SystemRoot })).toThrow("native_environment_required");
  expect(() => windowsNativeEnvironment(Object.create(systemEnvironment) as NodeJS.ProcessEnv)).toThrow("native_environment_required");
  let reads = 0;
  const accessor = Object.defineProperty({ ...systemEnvironment }, "LOCALAPPDATA", { get: () => { reads++; return "getter"; } });
  expect(() => windowsNativeEnvironment(accessor)).toThrow("native_environment_invalid"); expect(reads).toBe(0);
  expect(() => windowsNativeEnvironment({ ...systemEnvironment, TEMP: 42 } as unknown as NodeJS.ProcessEnv)).toThrow("native_environment_invalid");
  expect(() => windowsNativeEnvironment({ ...systemEnvironment, TEMP: "C:\\Temp\0other" })).toThrow("native_environment_invalid");
});

test("Windows snapshots retain exact UTC births while unavailable births cannot become authority", () => {
  const raw = JSON.stringify([{ pid: 71, parent: 12, birth: birthStamp }, { pid: 72, parent: 71, birth: null }]);
  expect(windowsProcessSnapshot(raw)).toEqual([{ pid: 71, parent: 12, identity: `71:${birthStamp}` }, { pid: 72, parent: 71, identity: "" }]);
  expect(windowsProcessBirth(JSON.stringify([{ pid: 71, parent: 12, birth: birthStamp }]), 71)).toBe(`71:${birthStamp}`);
  expect(windowsProcessBirth("[]", 71)).toBeNull();
  expect(() => windowsProcessBirth(JSON.stringify([{ pid: 72, parent: 71, birth: null }]), 72)).toThrow("fixture_process_birth");
  expect(() => windowsProcessBirth(raw, 71)).toThrow("fixture_process_birth");
  expect(() => windowsProcessBirth(JSON.stringify([{ pid: 72, parent: 12, birth: birthStamp }]), 71)).toThrow("fixture_process_birth");
});

test("Windows acquisition refuses corrupt, duplicate and unbounded snapshots before adoption", () => {
  const valid = { pid: 71, parent: 12, birth: birthStamp };
  for (const invalid of ["not-json", "{}", "[null]", JSON.stringify([{ ...valid, pid: 0 }]), JSON.stringify([{ ...valid, pid: 1.5 }]),
    JSON.stringify([{ ...valid, parent: -1 }]), JSON.stringify([{ ...valid, parent: 4294967296 }]), JSON.stringify([{ ...valid, birth: "missing" }]),
    JSON.stringify([{ ...valid, birth: "2026-02-30T02:05:11.1234567Z" }]), JSON.stringify([{ ...valid, extra: true }]), JSON.stringify([valid, valid])]) {
    expect(() => windowsProcessSnapshot(invalid)).toThrow("fixture_process_birth");
  }
  expect(() => windowsProcessSnapshot(" ".repeat(512 * 1024 + 1))).toThrow("fixture_process_snapshot_limit");
  const boundedRows = Array.from({ length: 8192 }, (_, i) => ({ pid: i + 1, parent: 0, birth: null }));
  expect(windowsProcessSnapshot(JSON.stringify(boundedRows))).toHaveLength(8192);
  expect(() => windowsProcessSnapshot(JSON.stringify([...boundedRows, { pid: 8193, parent: 0, birth: null }]))).toThrow("fixture_process_snapshot_limit");
  expect(windowsProcessSnapshot("[]".padEnd(512 * 1024, " "))).toEqual([]);
  for (const pid of [0, -1, 1.5, Infinity, 4294967296]) expect(() => windowsProcessBirth("[]", pid)).toThrow("fixture_process_pid");
  expect(windowsProcessBirth("[]".padEnd(64 * 1024, " "), 71)).toBeNull();
  expect(() => windowsProcessBirth(null as unknown as string, 71)).toThrow("fixture_process_snapshot_limit");
  expect(() => windowsProcessBirth(" ".repeat(64 * 1024 + 1), 71)).toThrow("fixture_process_snapshot_limit");
});

test("Windows ownership queries reject nonlocal selectors before constructing a fixed bounded command", () => {
  for (const selector of [0, -1, 1.5, Infinity, 4294967296, "71;Stop-Process", "remote"])
    expect(() => windowsOwnershipQuery(selector as number)).toThrow("fixture_process_pid");
  const selected = windowsOwnershipQuery(71), snapshot = windowsOwnershipQuery("all");
  expect(selected).toContain('-Property ProcessId,ParentProcessId,CreationDate -Filter "ProcessId = 71"');
  expect(snapshot).not.toContain("-Filter");
  for (const script of [selected, snapshot]) {
    expect(script).toContain("$ErrorActionPreference='Stop'");
    expect(script).toContain("$rows.Count -ge 8192");
    expect(script).toContain("ConvertTo-Json -InputObject @($rows.ToArray())");
    expect(script).not.toMatch(/ComputerName|CimSession|ExecutablePath|CommandLine/);
  }
});

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
function terminateRecorded(pid: number, identity: string | undefined, birth: (pid: number) => string): void {
  try { process.kill(pid, 0); } catch { return; }
  if (!identity || birth(pid) !== identity) throw new Error("probe_cleanup_identity_changed");
  process.kill(pid, "SIGKILL");
}
async function interruptedQualifier(target: "runner" | "qualifier") {
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
    console.log(JSON.stringify({probe:"interruption-owned-pids",target,qualifierPid:qualifier.child.pid,runnerPid:probe.runnerPid,workerPid:probe.workerPid,daemonPid:probe.runtime.pid}));
    for (const pid of [probe.runnerPid, probe.workerPid, probe.runtime.pid]) { const identity = birth(pid); expect(identity.length).toBeGreaterThan(0); births.set(pid, identity); }
    expect((await fetch(`${probe.url}/health`, { signal: AbortSignal.timeout(1000) })).status).toBe(200);
    if (target === "runner") {
      for (const pid of [probe.workerPid, probe.runnerPid]) { if (birth(pid) !== births.get(pid)) throw new Error("probe_runner_identity_changed"); process.kill(pid, "SIGKILL"); }
    } else {
      if (!await ownedProcessMatches(qualifier)) throw new Error("probe_qualifier_identity_changed"); qualifier.child.kill("SIGTERM");
    }
    await Promise.race([qualifier.closed, Bun.sleep(15_000).then(() => { throw new Error("qualifier_interruption_not_closed"); })]);
    let removed = false; try { await stat(probe.runtime.stateDirectory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") removed = true; else throw error; }
    if (process.env.PHANTOM_F48_PROOF_DIRECTORY) {
      await writeFile(path.join(process.env.PHANTOM_F48_PROOF_DIRECTORY, `native-interruption-${target}-${qualifier.child.pid}.json`), await readFile(path.join(output, "qualification.json")));
    }
    console.log(JSON.stringify({ probe: "interrupted-qualifier", target, qualifierPid: qualifier.child.pid, ...probe, daemonAlive: alive(probe.runtime.pid), directoryRemoved: removed, qualifierExit: qualifier.child.exitCode }));
    expect(qualifier.child.exitCode).toBe(1); expect(alive(probe.runtime.pid)).toBe(false); expect(removed).toBe(true); expect(alive(unrelated.child.pid!)).toBe(true);
    let serving = false; try { serving = (await fetch(`${probe.url}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* closed listener */ }
    expect(serving).toBe(false);
  } finally {
    for (const pid of probe ? [probe.workerPid, probe.runnerPid, probe.runtime.pid] : []) {
      terminateRecorded(pid, births.get(pid), birth);
    }
    if (!qualifier.closeObserved) await stopOwnedProcess(qualifier);
    if (probe) { for (let i = 0; i < 100 && alive(probe.runtime.pid); i++) await Bun.sleep(25); expect(alive(probe.runtime.pid)).toBe(false); await rm(probe.runtime.stateDirectory, { recursive: true, force: true }); }
    await stopOwnedProcess(unrelated); await rm(directory, { recursive: true, force: true });
  }
}

test.skipIf(!binary || process.platform !== "darwin")("interrupted actual copied qualifier reaps its daemon and private profile independently of the runner", async () => { await interruptedQualifier("runner"); }, 40_000);
test.skipIf(!binary || process.platform !== "darwin")("catchable qualifier interruption closes its actual copied daemon and runner", async () => { await interruptedQualifier("qualifier"); }, 40_000);
test("Windows ownership command discovery uses only the fixed intrinsic built-in module path", () => {
  const modulePath = "$env:PSModulePath=[System.IO.Path]::Combine($PSHOME,'Modules');";
  const prefix = "$ErrorActionPreference='Stop';" + modulePath;
  for (const selector of [71, "all"] as const) {
    const script = windowsOwnershipQuery(selector);
    expect(script.startsWith(prefix)).toBe(true);
    expect(script.match(/\$env:PSModulePath=[^;]+;/g)).toEqual([modulePath]);
    expect(script.indexOf("Get-CimInstance")).toBeGreaterThan(prefix.length);
    expect(script).not.toMatch(/\$env:(?:APPDATA|ProgramFiles|PSHOME)|Import-Module|CurrentUser|WindowsPowerShell\\Modules/);
  }
});

const firstBirthMarkers = [
  "[Console]::Error.WriteLine('rp-first:entered');",
  "[Console]::Error.WriteLine('rp-first:before-query');",
  "[Console]::Error.WriteLine('rp-first:after-query');",
  ";[Console]::Error.WriteLine('rp-first:after-serialization');",
];
function originalOwnershipQuery(pid: number | "all"): string {
  const filter = pid === "all" ? "" : ` -Filter "ProcessId = ${pid}"`;
  return `$ErrorActionPreference='Stop';$env:PSModulePath=[System.IO.Path]::Combine($PSHOME,'Modules');$rows=[System.Collections.Generic.List[object]]::new();Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate${filter} | ForEach-Object {if($_.ProcessId -gt 0){if($rows.Count -ge 8192){throw 'fixture_process_snapshot_limit'};$birth=$null;if($null -ne $_.CreationDate){$birth=$_.CreationDate.ToUniversalTime().ToString("o")};$rows.Add(@{pid=$_.ProcessId;parent=$_.ParentProcessId;birth=$birth})}};ConvertTo-Json -InputObject @($rows.ToArray()) -Compress`;
}
test("first Windows birth telemetry markers preserve the entire original selected and snapshot queries", () => {
  for (const selector of [71, "all"] as const) {
    const script = windowsOwnershipQuery(selector);
    for (const marker of firstBirthMarkers) expect(script.split(marker).length).toBe(2);
    expect(firstBirthMarkers.reduce((text, marker) => text.replace(marker, ""), script)).toBe(originalOwnershipQuery(selector));
    expect(script.indexOf(firstBirthMarkers[0])).toBeGreaterThan(script.indexOf("$env:PSModulePath="));
    expect(script.indexOf(firstBirthMarkers[1])).toBeLessThan(script.indexOf("Get-CimInstance"));
    expect(script.indexOf(firstBirthMarkers[2])).toBeGreaterThan(script.indexOf("$rows.Add("));
    expect(script.indexOf(firstBirthMarkers[2])).toBeLessThan(script.indexOf("ConvertTo-Json"));
    expect(script.indexOf(firstBirthMarkers[3])).toBeGreaterThan(script.indexOf("ConvertTo-Json"));
  }
});
test("first Windows birth telemetry retains only a closed immutable record for the particular refusal", () => {
  const failure = runtime.makeNativeCommandFailure({ code: "ENOENT", signal: "SIGTERM", killed: true,
    message: "PRIVATE_FIRST_MESSAGE", cmd: "PRIVATE_FIRST_COMMAND", path: "PRIVATE_FIRST_PATH", cause: "PRIVATE_FIRST_CAUSE" },
  { exitCode: -2 }, "雪", "rp-first:entered\nrp-first:before-query\nPRIVATE_FIRST_STDERR\n", 12.6);
  expect(failure.message).toBe("native_observation_failed");
  expect(failure.cause).toBeUndefined();
  const record = runtime.nativeCommandFailure(failure);
  expect(record).toEqual({ probe: "windows-first-birth-command", errorCode: "ENOENT", status: -2, signal: "SIGTERM", killed: true,
    wallMs: 13, stdoutUtf8Bytes: 3, stderrUtf8Bytes: 60, phases: ["entered", "before-query"] });
  expect(Object.isFrozen(record)).toBe(true);
  expect(Object.isFrozen(record!.phases)).toBe(true);
  expect(JSON.stringify(record)).not.toContain("PRIVATE_FIRST");
  expect(runtime.nativeCommandFailure(new Error("native_observation_failed"))).toBeNull();
  expect(runtime.nativeCommandFailure({ ...failure })).toBeNull();
  expect(runtime.nativeCommandFailure(null)).toBeNull();
});
test("first Windows birth telemetry does not infer ETIMEDOUT from a killed process or elapsed deadline", () => {
  for (const [code, expected] of [["ETIMEDOUT", "ETIMEDOUT"], ["EACCES", "EACCES"], ["ENOENT", "ENOENT"],
    [17, "other"], [undefined, "other"], ["PRIVATE_FIRST_CODE", "other"]] as const) {
    const failure = runtime.makeNativeCommandFailure({ code, signal: "SIGTERM", killed: true }, { exitCode: null }, "", "", 3001);
    expect(runtime.nativeCommandFailure(failure)!.errorCode).toBe(expected);
  }
  const missing = runtime.nativeCommandFailure(runtime.makeNativeCommandFailure({}, {}, "", "", 1));
  expect(missing!.signal).toBeNull(); expect(missing!.killed).toBeNull(); expect(missing!.status).toBeNull();
  const unknown = runtime.nativeCommandFailure(runtime.makeNativeCommandFailure({ signal: "PRIVATE_FIRST_SIGNAL", killed: "yes" },
    { exitCode: "17" }, "", "", 1));
  expect(unknown!.signal).toBe("other"); expect(unknown!.killed).toBeNull(); expect(unknown!.status).toBeNull();
});
test("first Windows birth telemetry never invokes getters, inherited metadata or scalar coercions", () => {
  let reads = 0;
  const error = Object.create({ code: "ENOENT", signal: "SIGTERM", killed: true });
  for (const key of ["code", "signal", "killed"]) Object.defineProperty(error, key, { get: () => { reads++; return "PRIVATE_FIRST_GETTER"; } });
  const child = Object.defineProperty({}, "exitCode", { get: () => { reads++; return 17; } });
  const text = { toString: () => { reads++; return "PRIVATE_FIRST_TEXT"; }, valueOf: () => { reads++; return 12; } };
  const record = runtime.nativeCommandFailure(runtime.makeNativeCommandFailure(error, child, text, text, text));
  expect(reads).toBe(0);
  expect(record).toEqual({ probe: "windows-first-birth-command", errorCode: "other", status: null, signal: null, killed: null,
    wallMs: null, stdoutUtf8Bytes: null, stderrUtf8Bytes: null, phases: [] });
  const inherited = runtime.nativeCommandFailure(runtime.makeNativeCommandFailure(Object.create({ code: "EACCES", signal: "SIGTERM", killed: true }),
    Object.create({ exitCode: 17 }), "", "", 1));
  expect(inherited!.errorCode).toBe("other"); expect(inherited!.signal).toBeNull(); expect(inherited!.killed).toBeNull(); expect(inherited!.status).toBeNull();
  const throwing = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("PRIVATE_FIRST_PROXY"); } });
  expect(runtime.nativeCommandFailure(runtime.makeNativeCommandFailure(throwing, throwing, "", "", 1))!.errorCode).toBe("other");
});
test("first Windows birth telemetry bounds clocks and callback text while counting actual UTF8 bytes", () => {
  for (const [elapsed, expected] of [[12.6, 13], [-1, 0], [Number.MAX_VALUE, 2147483647], [Infinity, null], [NaN, null], ["12", null]] as const) {
    const record = runtime.nativeCommandFailure(runtime.makeNativeCommandFailure({}, {}, "", "", elapsed));
    expect(record!.wallMs).toBe(expected);
  }
  const bounded = runtime.nativeCommandFailure(runtime.makeNativeCommandFailure({}, {}, "雪🙂", "x".repeat(64 * 1024), 1));
  expect(bounded!.stdoutUtf8Bytes).toBe(7); expect(bounded!.stderrUtf8Bytes).toBe(64 * 1024);
  const oversized = runtime.nativeCommandFailure(runtime.makeNativeCommandFailure({}, {}, "x".repeat(64 * 1024 + 1), "x".repeat(64 * 1024 + 1), 1));
  expect(oversized!.stdoutUtf8Bytes).toBeNull(); expect(oversized!.stderrUtf8Bytes).toBeNull(); expect(oversized!.phases).toEqual([]);
});
test("first Windows birth telemetry accepts only complete fixed stderr lines with bounded unique phases", () => {
  const stderr = "PRIVATE_FIRST rp-first:entered\nrp-first:enteredX\nrp-first:before-query\nrp-first:before-query\n" +
    "rp-first:after-query\r\nrp-first:after-serialization\nrp-first:entered\nrp-first:unknown\nrp-first:entered\u001b\n";
  const record = runtime.nativeCommandFailure(runtime.makeNativeCommandFailure({}, {}, "", stderr, 1));
  expect(record!.phases).toEqual(["before-query", "after-query", "after-serialization", "entered"]);
  expect(JSON.stringify(record)).not.toContain("PRIVATE_FIRST");
  expect(record!.phases.length).toBe(4);
});
test("first Windows birth telemetry cannot be replaced by a later observation or a counterfeit record", () => {
  const original = runtime.makeNativeCommandFailure({ code: "ENOENT" }, {}, "", "", 1);
  const first = runtime.nativeCommandFailure(original);
  const later = runtime.makeNativeCommandFailure({ code: "EACCES" }, {}, "", "", 2);
  expect(runtime.nativeCommandFailure(later)!.errorCode).toBe("EACCES");
  expect(runtime.nativeCommandFailure(original)).toBe(first);
  expect(first!.errorCode).toBe("ENOENT");
  expect(runtime.nativeCommandFailure(Object.assign(new Error("native_observation_failed"), { diagnostic: first }))).toBeNull();
});
