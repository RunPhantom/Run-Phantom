import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, copyFile, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer, createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { removeOwnedDirectory } from "./owned-directory";

export type RuntimeSelection = { mode: "source" } | { mode: "installed"; artifact: string; sha256: string };
export type ProcessObservation = { executable: string; cwd: string | null; command: string; listenerOwned: boolean; cwdEvidence: "observed" | "launch-only" };
export type RuntimeProvenance = {
  mode: "source" | "installed"; platform: string; architecture: string; pid: number; command: string[]; cwd: string;
  stateDirectory: string; profile: string; sourceArtifact: string | null; copiedArtifact: string | null;
  sourceSha256: string | null; copiedSha256: string | null; observation: ProcessObservation | null;
};
export type OwnedProcess = { child: ChildProcess; closed: Promise<void>; closeObserved: boolean; error: Error | null; identity: Promise<string | null> };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const refusal = (code: string) => new Error(code);

export function runtimeSelection(env: NodeJS.ProcessEnv): RuntimeSelection {
  const mode = env.RUNPHANTOM_E2E_RUNTIME ?? "source";
  if (mode === "source") {
    if (env.RUNPHANTOM_E2E_BINARY || env.RUNPHANTOM_E2E_SHA256) throw refusal("native_selection_required");
    return { mode };
  }
  if (mode !== "installed") throw refusal("native_runtime_invalid");
  const artifact = env.RUNPHANTOM_E2E_BINARY, sha256 = env.RUNPHANTOM_E2E_SHA256;
  if (!artifact || !path.isAbsolute(artifact)) throw refusal("native_artifact_missing");
  if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) throw refusal("native_digest_required");
  return { mode, artifact, sha256 };
}
export function outsideCheckout(checkout: string, directory: string, paths = path): boolean {
  const relative = paths.relative(checkout, directory);
  return relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative);
}
export async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
async function checkedArtifact(selection: Extract<RuntimeSelection, { mode: "installed" }>): Promise<string> {
  let artifact: string;
  try {
    artifact = await realpath(selection.artifact);
    if (!(await stat(artifact)).isFile()) throw refusal("native_artifact_missing");
    await access(artifact, process.platform === "win32" ? constants.R_OK : constants.X_OK);
  } catch { throw refusal("native_artifact_missing"); }
  const handle = await open(artifact, "r");
  const header = Buffer.alloc(4);
  try { await handle.read(header, 0, 4, 0); } finally { await handle.close(); }
  const magic = header.toString("hex");
  const native = process.platform === "win32" ? magic.startsWith("4d5a") : process.platform === "linux" ? magic === "7f454c46" :
    ["cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(magic);
  if (!native) throw refusal("native_artifact_format");
  if (await fileSha256(artifact) !== selection.sha256) throw refusal("native_digest_mismatch");
  return artifact;
}
export function windowsNativeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!env || typeof env !== "object" || Array.isArray(env)) throw refusal("native_environment_invalid");
  const allowed = new Map(["PATH", "SystemRoot", "windir", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "ProgramFiles"].map(key => [key.toLowerCase(), key]));
  const projected: NodeJS.ProcessEnv = { LANG: "C", TZ: "UTC" };
  for (const [key, field] of Object.entries(Object.getOwnPropertyDescriptors(env))) {
    // Windows names are ASCII case-insensitive; Unicode lookalikes never supply an operational field.
    const canonical = [...key].every(character => character.charCodeAt(0) <= 0x7f) ? allowed.get(key.toLowerCase()) : undefined;
    if (!canonical) continue;
    if (!("value" in field) || typeof field.value !== "string" || !field.value || field.value.length > 32767 || field.value.includes("\0")) throw refusal("native_environment_invalid");
    if (projected[canonical] !== undefined && projected[canonical] !== field.value) throw refusal("native_environment_conflict");
    projected[canonical] = field.value;
  }
  if (!projected.PATH || !projected.SystemRoot) throw refusal("native_environment_required");
  return projected;
}
export type NativeCommandFailureRecord = Readonly<{
  probe: "windows-first-birth-command"; errorCode: "ETIMEDOUT" | "ENOENT" | "EACCES" | "other";
  status: number | null; signal: "SIGTERM" | "SIGKILL" | "other" | null; killed: boolean | null;
  wallMs: number | null; stdoutUtf8Bytes: number | null; stderrUtf8Bytes: number | null;
  phases: readonly ("entered" | "before-query" | "after-query" | "after-serialization")[];
}>;
const commandFailures = new WeakMap<Error, NativeCommandFailureRecord>();
function ownData(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field && "value" in field ? field.value : undefined;
  } catch { return undefined; }
}
function callbackUtf8Bytes(value: unknown): number | null {
  return typeof value === "string" && value.length <= 64 * 1024 ? Buffer.byteLength(value, "utf8") : null;
}
export function makeNativeCommandFailure(error: unknown, child: unknown, stdout: unknown, stderr: unknown, elapsed: unknown): Error {
  const code = ownData(error, "code"), signal = ownData(error, "signal"), killed = ownData(error, "killed"), status = ownData(child, "exitCode");
  const phases: Array<"entered" | "before-query" | "after-query" | "after-serialization"> = [];
  const stderrUtf8Bytes = callbackUtf8Bytes(stderr);
  if (typeof stderr === "string" && stderrUtf8Bytes !== null) {
    const names = ["entered", "before-query", "after-query", "after-serialization"] as const;
    for (const line of stderr.split("\n")) {
      const phase = names.find(name => line === `rp-first:${name}` || line === `rp-first:${name}\r`);
      if (phase && !phases.includes(phase)) phases.push(phase);
    }
  }
  const failure = refusal("native_observation_failed");
  commandFailures.set(failure, Object.freeze({ probe: "windows-first-birth-command",
    errorCode: code === "ETIMEDOUT" || code === "ENOENT" || code === "EACCES" ? code : "other",
    status: typeof status === "number" && Number.isInteger(status) && status >= -2147483648 && status <= 2147483647 ? status : null,
    signal: signal === undefined || signal === null ? null : signal === "SIGTERM" || signal === "SIGKILL" ? signal : "other",
    killed: typeof killed === "boolean" ? killed : null,
    wallMs: typeof elapsed === "number" && Number.isFinite(elapsed) ? Math.min(2147483647, Math.max(0, Math.round(elapsed))) : null,
    stdoutUtf8Bytes: callbackUtf8Bytes(stdout), stderrUtf8Bytes, phases: Object.freeze(phases) }));
  return failure;
}
export function nativeCommandFailure(error: unknown): NativeCommandFailureRecord | null {
  return error && typeof error === "object" ? commandFailures.get(error as Error) ?? null : null;
}
function command(file: string, args: string[], maxBuffer = 64 * 1024, firstWindowsBirth = false): Promise<string> {
  const env = process.platform === "win32" ? windowsNativeEnvironment(process.env) : { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LANG: "C", TZ: "UTC" };
  return new Promise((resolve, reject) => {
    const began = performance.now();
    const child = execFile(file, args, { timeout: 3000, maxBuffer, windowsHide: true, env },
      (error, stdout, stderr) => error ? reject(firstWindowsBirth
        ? makeNativeCommandFailure(error, child, stdout, stderr, performance.now() - began)
        : refusal("native_observation_failed")) : resolve(stdout));
  });
}
export async function observeNative(pid: number, executable: string, cwd: string, port: number): Promise<ProcessObservation> {
  if (!validWindowsPid(pid) || !Number.isInteger(port) || port < 1 || port > 65535) throw refusal("native_identity_mismatch");
  if (process.platform === "darwin") {
    const [cmd, files, listener] = await Promise.all([
      command("/bin/ps", ["-p", String(pid), "-o", "command="]),
      command("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd,txt", "-F", "pfn"]),
      command("/usr/sbin/lsof", ["-n", "-P", "-a", "-p", String(pid), "-i", `TCP:${port}`, "-sTCP:LISTEN", "-F", "pn"]),
    ]);
    if (!cmd.includes(executable) || !files.includes(`n${executable}\n`) || !files.includes(`n${cwd}\n`) || !listener.includes(`p${pid}\n`)) throw refusal("native_identity_mismatch");
    return { executable, cwd, command: cmd.trim(), listenerOwned: true, cwdEvidence: "observed" };
  }
  if (process.platform === "linux") {
    const proc = `/proc/${pid}`;
    const [exe, actualCwd, cmdline, tcp, tcp6, descriptors] = await Promise.all([
      readlink(`${proc}/exe`), readlink(`${proc}/cwd`), readFile(`${proc}/cmdline`, "utf8"),
      readFile(`${proc}/net/tcp`, "utf8"), readFile(`${proc}/net/tcp6`, "utf8"), readdir(`${proc}/fd`),
    ]);
    const sockets = new Set(await Promise.all(descriptors.map(fd => readlink(`${proc}/fd/${fd}`).catch(() => ""))));
    const listenerOwned = `${tcp}\n${tcp6}`.split("\n").some(line => {
      const fields = line.trim().split(/\s+/);
      return fields[1]?.split(":")[1] === port.toString(16).padStart(4, "0").toUpperCase() && fields[3] === "0A" && sockets.has(`socket:[${fields[9]}]`);
    });
    if (exe !== executable || actualCwd !== cwd || !cmdline.split("\0").includes(executable) || !listenerOwned) throw refusal("native_identity_mismatch");
    return { executable: exe, cwd: actualCwd, command: cmdline.replace(/\0/g, " ").trim(), listenerOwned, cwdEvidence: "observed" };
  }
  if (process.platform === "win32") {
    // CIM exposes executable identity, not a process's current directory.
    const script = `$ErrorActionPreference='Stop';$env:PSModulePath=[System.IO.Path]::Combine($PSHOME,'Modules');$p=Get-CimInstance -ClassName Win32_Process -Property ExecutablePath,CommandLine -Filter "ProcessId = ${pid}"; $l=@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue); @{exe=$p.ExecutablePath;command=$p.CommandLine;owned=(@($l|Where-Object {$_.OwningProcess -eq ${pid}}).Count -gt 0)}|ConvertTo-Json -Compress`;
    const raw = JSON.parse(await command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script])) as { exe: string; command: string; owned: boolean };
    if (!raw.exe || (await realpath(raw.exe)).toLowerCase() !== executable.toLowerCase() || !raw.command?.includes(path.basename(executable)) || !raw.owned) throw refusal("native_identity_mismatch");
    return { executable: raw.exe, cwd: null, command: raw.command, listenerOwned: true, cwdEvidence: "launch-only" };
  }
  throw refusal("native_platform_unsupported");
}
// Fixed SDK proc_bsdinfo layout on supported 64-bit Darwin; kernel start microseconds are stable across title changes.
const DARWIN_BIRTH_QUERY = `import {dlopen,FFIType,ptr} from "bun:ffi";
const lib=dlopen("/usr/lib/libproc.dylib",{proc_listallpids:{args:[FFIType.ptr,FFIType.i32],returns:FFIType.i32},proc_pidinfo:{args:[FFIType.i32,FFIType.i32,FFIType.u64,FFIType.ptr,FFIType.i32],returns:FFIType.i32}});
const requested=process.argv.at(-1),pids=new Int32Array(8192);let count=0;
if(requested==="all"){count=lib.symbols.proc_listallpids(ptr(pids),pids.byteLength);if(count<0||count>=pids.length)throw Error("fixture_process_snapshot_limit");}
else{const pid=Number(requested);if(!Number.isInteger(pid)||pid<1||pid>2147483647)throw Error("fixture_process_pid");pids[0]=pid;count=1;}
const rows=[],buffer=new Uint8Array(136),view=new DataView(buffer.buffer);
for(let i=0;i<count;i++){if(pids[i]<1)continue;buffer.fill(0);if(lib.symbols.proc_pidinfo(pids[i],3,0n,ptr(buffer),buffer.byteLength)!==136)continue;const pid=view.getUint32(12,true),parent=view.getUint32(16,true),seconds=view.getBigUint64(120,true),micros=view.getBigUint64(128,true);if(pid!==pids[i]||seconds===0n||micros>=1000000n)throw Error("fixture_process_birth");rows.push({pid,parent,identity:pid+":"+seconds+":"+micros});}
lib.close();console.log(JSON.stringify(rows));`;
async function darwinRows(pid: number | "all"): Promise<ProcessRow[]> {
  const rows = JSON.parse(await command("bun", ["--no-env-file", "--no-install", "-e", DARWIN_BIRTH_QUERY, "--", String(pid)], 512 * 1024)) as ProcessRow[];
  if (!Array.isArray(rows) || rows.length > 8192 || rows.some(row => !Number.isSafeInteger(row.pid) || row.pid < 1 || row.pid > 2147483647 || !Number.isSafeInteger(row.parent) || row.parent < 0 || row.parent > 2147483647 || !/^[0-9]{1,10}:[0-9]{1,20}:[0-9]{1,6}$/.test(row.identity) || Number(row.identity.split(":")[0]) !== row.pid)) throw refusal("fixture_process_birth");
  return rows;
}
async function processIdentity(pid: number, firstBirth = false): Promise<string | null> {
  if (process.platform === "win32") return windowsProcessBirth(await command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsOwnershipQuery(pid)], 64 * 1024, firstBirth), pid);
  try {
    if (process.platform === "linux") {
      const fields = (await readFile(`/proc/${pid}/stat`, "utf8")).split(")").at(-1)!.trim().split(/\s+/);
      return `${pid}:${fields[19]}`; // Kernel process start ticks, independent of PID reuse.
    }
    if (process.platform === "darwin") return (await darwinRows(pid))[0]?.identity ?? null;
    return null;
  } catch { return null; }
}
type ProcessRow = { pid: number; parent: number; identity: string };
export function windowsProcessSnapshot(raw: string): ProcessRow[] {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 512 * 1024) throw refusal("fixture_process_snapshot_limit");
  let rows: unknown;
  try { rows = JSON.parse(raw); } catch { throw refusal("fixture_process_birth"); }
  if (!Array.isArray(rows)) throw refusal("fixture_process_birth");
  if (rows.length > 8192) throw refusal("fixture_process_snapshot_limit");
  const seen = new Set<number>();
  return rows.map((row: unknown) => {
    if (!row || typeof row !== "object" || Object.keys(row).sort().join(",") !== "birth,parent,pid") throw refusal("fixture_process_birth");
    const { pid, parent, birth } = row as { pid: number; parent: number; birth: unknown };
    if (!validWindowsPid(pid) || !Number.isInteger(parent) || parent < 0 || parent > 0xffffffff || seen.has(pid)) throw refusal("fixture_process_birth");
    seen.add(pid);
    if (birth !== null) {
      if (typeof birth !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(birth)) throw refusal("fixture_process_birth");
      const milliseconds = `${birth.slice(0, 23)}Z`, parsed = Date.parse(milliseconds);
      if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== milliseconds) throw refusal("fixture_process_birth");
    }
    return { pid, parent, identity: birth === null ? "" : `${pid}:${birth}` };
  });
}
export function windowsProcessBirth(raw: string, pid: number): string | null {
  if (!validWindowsPid(pid)) throw refusal("fixture_process_pid");
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 64 * 1024) throw refusal("fixture_process_snapshot_limit");
  const rows = windowsProcessSnapshot(raw);
  if (!rows.length) return null;
  if (rows.length !== 1 || rows[0].pid !== pid || !rows[0].identity) throw refusal("fixture_process_birth");
  return rows[0].identity;
}
const validWindowsPid = (pid: number) => Number.isInteger(pid) && pid > 0 && pid <= 0xffffffff;
export function windowsOwnershipQuery(pid: number | "all"): string {
  if (pid !== "all" && !validWindowsPid(pid)) throw refusal("fixture_process_pid");
  const query = `SELECT ProcessId,ParentProcessId,CreationDate FROM Win32_Process${pid === "all" ? "" : ` WHERE ProcessId = ${pid}`}`;
  return `$ErrorActionPreference='Stop';$env:PSModulePath=[System.IO.Path]::Combine($PSHOME,'Modules');[Console]::Error.WriteLine('rp-first:entered');
$assembly=[System.Reflection.Assembly]::Load('System.Management, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a');
if(-not $assembly.GlobalAssemblyCache -or $assembly.FullName -ne 'System.Management, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a'){throw 'fixture_process_framework'};
$rows=[System.Collections.Generic.List[object]]::new();$searcher=$null;$results=$null;
try{
 $searcher=[System.Management.ManagementObjectSearcher]::new('root\\cimv2','${query}');
 $searcher.Options.ReturnImmediately=$true;$searcher.Options.Rewindable=$false;$searcher.Options.Timeout=[TimeSpan]::FromMilliseconds(1500);
 [Console]::Error.WriteLine('rp-first:before-query');$results=$searcher.Get();
 foreach($row in $results){try{if($row.ProcessId -gt 0){
  if($rows.Count -ge 8192){throw 'fixture_process_snapshot_limit'};
  $birth=$null;$raw=$row.CreationDate;
  if($null -ne $raw){if($raw -isnot [string] -or $raw -cnotmatch '^[0-9]{14}\\.[0-9]{6}[+-][0-9]{3}$'){throw 'fixture_process_birth'};$birth=[System.Management.ManagementDateTimeConverter]::ToDateTime($raw).ToUniversalTime().ToString('o')};
  $rows.Add(@{pid=$row.ProcessId;parent=$row.ParentProcessId;birth=$birth})
 }}finally{$row.Dispose()}}
 [Console]::Error.WriteLine('rp-first:after-query');ConvertTo-Json -InputObject @($rows.ToArray()) -Compress;[Console]::Error.WriteLine('rp-first:after-serialization');
}finally{if($null -ne $results){$results.Dispose()};if($null -ne $searcher){$searcher.Dispose()}};`;
}
type Ownership = { root: ChildProcess; pid: number | undefined; identity: Promise<string | null>; descendants: Map<number, string>; pending: Promise<void>; running?: boolean; timer?: ReturnType<typeof setInterval>; failure?: Error };
const ownership = new WeakMap<OwnedProcess, Ownership>();
const MAX_DESCENDANTS = 64;
async function processRows(): Promise<ProcessRow[]> {
  if (process.platform === "darwin") return await darwinRows("all");
  if (process.platform === "win32") {
    return windowsProcessSnapshot(await command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsOwnershipQuery("all")], 512 * 1024));
  }
  const output = await command("ps", ["-axo", process.platform === "linux" ? "pid=,ppid=" : "pid=,ppid=,lstart="], 512 * 1024);
  const lines = output.trim().split("\n");
  if (lines.length > 8192) throw refusal("fixture_process_snapshot_limit");
  return lines.flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)(?:\s+(.+))?$/.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), identity: match[3] ? `${match[1]}:${match[3].trim()}` : "" }] : [];
  });
}
async function linuxRow(row: ProcessRow): Promise<ProcessRow | null> {
  try {
    const fields = (await readFile(`/proc/${row.pid}/stat`, "utf8")).split(")").at(-1)!.trim().split(/\s+/);
    return { pid: row.pid, parent: Number(fields[1]), identity: `${row.pid}:${fields[19]}` };
  } catch { return null; }
}
async function refreshOwnership(owned: OwnedProcess, lease: Ownership): Promise<void> {
  const expected = await lease.identity, pid = lease.pid;
  if (!expected || !pid) return;
  const rows = await processRows();
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const liveRow = async (id: number) => {
    const row = byPid.get(id);
    return row && process.platform === "linux" ? await linuxRow(row) : row;
  };
  const anchors = new Set<number>();
  const root = await liveRow(pid);
  if (root && !root.identity) throw refusal("fixture_process_birth");
  if (root?.identity === expected) anchors.add(pid);
  for (const [member, identity] of lease.descendants) {
    const row = await liveRow(member);
    if (row && !row.identity) throw refusal("fixture_process_birth");
    if (row?.identity === identity) anchors.add(member);
  }
  // Adopt only edges in a bounded OS snapshot whose parent still has its recorded birth.
  for (let changed = true; changed;) {
    changed = false;
    for (const candidate of rows) {
      if (!anchors.has(candidate.parent) || anchors.has(candidate.pid)) continue;
      const row = await liveRow(candidate.pid), parent = await liveRow(candidate.parent);
      const parentIdentity = candidate.parent === pid ? expected : lease.descendants.get(candidate.parent);
      if (!row || row.parent !== candidate.parent || parent?.identity !== parentIdentity) continue;
      if (!row.identity) throw refusal("fixture_process_birth");
      if (lease.descendants.has(row.pid) && lease.descendants.get(row.pid) !== row.identity) throw refusal("fixture_process_identity_lost");
      if (lease.descendants.size >= MAX_DESCENDANTS) throw refusal("fixture_process_descendant_limit");
      lease.descendants.set(row.pid, row.identity); anchors.add(row.pid); changed = true;
    }
  }
}
function scheduleOwnership(owned: OwnedProcess, lease: Ownership): Promise<void> {
  if (lease.running) return lease.pending;
  lease.running = true;
  lease.pending = refreshOwnership(owned, lease).catch(error => { lease.failure = error instanceof Error ? error : refusal("fixture_process_snapshot_failed"); }).finally(() => { lease.running = false; });
  return lease.pending;
}
export async function ownedProcessMatches(owned: OwnedProcess): Promise<boolean> {
  const lease = ownership.get(owned);
  if (!lease || owned.child !== lease.root || owned.child.pid !== lease.pid || !lease.pid) return false;
  const expected = await lease.identity;
  return !!expected && await owned.identity === expected && await processIdentity(lease.pid) === expected;
}
export function launchOwnedProcess(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): OwnedProcess {
  const child = spawn(file, args, { cwd, env, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const owned: OwnedProcess = { child, closed: Promise.resolve(), closeObserved: false, error: null, identity: child.pid ? processIdentity(child.pid, true) : Promise.resolve(null) };
  const lease: Ownership = { root: child, pid: child.pid, identity: owned.identity, descendants: new Map(), pending: Promise.resolve() }; ownership.set(owned, lease);
  lease.timer = setInterval(() => { void scheduleOwnership(owned, lease); }, 100); lease.timer.unref();
  void scheduleOwnership(owned, lease);
  owned.closed = new Promise(resolve => child.once("close", () => { owned.closeObserved = true; clearInterval(lease.timer); resolve(); }));
  child.once("error", error => { owned.error = error; });
  return owned;
}
async function closedWithin(owned: OwnedProcess, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([owned.closed.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer); }
}
export async function stopOwnedProcess(owned: OwnedProcess): Promise<{ pid: number | null; closeObserved: true; forced: boolean; identity: string | null }> {
  const cleanupDeadline = Date.now() + 20_000;
  const withinDeadline = () => { if (Date.now() > cleanupDeadline) throw refusal("fixture_process_cleanup_timeout"); };
  const lease = ownership.get(owned); if (!lease) throw refusal("fixture_process_unknown_owner");
  if (owned.child !== lease.root || owned.child.pid !== lease.pid || await owned.identity !== await lease.identity) throw refusal("fixture_process_identity_lost");
  clearInterval(lease.timer); await lease.pending; await scheduleOwnership(owned, lease);
  let identityFailure = lease.failure;
  const pid = owned.child.pid, expected = await owned.identity; let forced = false;
  const rootIdentity = pid ? await processIdentity(pid) : null;
  if (rootIdentity && rootIdentity !== expected) identityFailure ??= refusal("fixture_process_identity_lost");
  const recorded = new Map(lease.descendants); if (pid && expected && (!rootIdentity || rootIdentity === expected)) recorded.set(pid, expected);
  const signalOwned = async (signal: "SIGTERM" | "SIGKILL") => {
    let found = false;
    for (const [member, identity] of recorded) {
      withinDeadline();
      const current = await processIdentity(member);
      if (!current) continue;
      if (current !== identity) { identityFailure ??= refusal("fixture_process_identity_lost"); continue; }
      found = true;
      if (process.platform === "win32") {
        forced = true; await command("taskkill.exe", ["/PID", String(member), "/F"]).catch(async error => { if (await processIdentity(member)) throw error; });
      } else {
        try { process.kill(member, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
    return found;
  };
  await signalOwned("SIGTERM");
  if (!await closedWithin(owned, 2500)) {
    forced = true;
    if (!await signalOwned("SIGKILL")) throw refusal("fixture_process_identity_lost");
    if (!await closedWithin(owned, 2500)) throw refusal("fixture_process_not_closed");
  }
  const deadline = Date.now() + 2000;
  for (;;) {
    withinDeadline();
    const rows = new Map((await processRows()).map(row => [row.pid, row]));
    const remaining = await Promise.all([...recorded].map(async ([member, identity]) => {
      const row = rows.get(member), current = row && process.platform === "linux" ? (await linuxRow(row))?.identity : row?.identity;
      if (row && process.platform === "win32" && !current) throw refusal("fixture_process_birth");
      if (current && current !== identity) { identityFailure ??= refusal("fixture_process_identity_lost"); return false; }
      return !!current;
    }));
    if (!remaining.some(Boolean)) break;
    forced = true; await signalOwned("SIGKILL");
    if (Date.now() >= deadline) throw refusal("fixture_process_descendants_not_reaped");
    await sleep(25);
  }
  if (identityFailure) throw identityFailure;
  return { pid: pid ?? null, closeObserved: true, forced, identity: expected };
}
async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer(); server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(refusal("fixture_port_failed")); return; }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}
export async function startManagedDaemon(repoRoot: string, env: NodeJS.ProcessEnv, workerIndex: number, healthMs = 45_000) {
  const selection = runtimeSelection(env);
  const artifact = selection.mode === "installed" ? await checkedArtifact(selection) : null;
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), `runphantom-w${workerIndex}-`));
  let owned: OwnedProcess | undefined;
  try {
    const profile = path.join(directory, "profile"), cwd = selection.mode === "installed" ? path.join(directory, "empty-cwd") : repoRoot;
    await mkdir(profile); if (selection.mode === "installed") await mkdir(cwd);
    let copied: string | null = null;
    if (artifact) {
      const bin = path.join(directory, "bin"); await mkdir(bin);
      copied = path.join(bin, process.platform === "win32" ? "runphantom.exe" : "runphantom");
      await copyFile(artifact, copied); if (process.platform !== "win32") await chmod(copied, (await stat(artifact)).mode & 0o777);
      if (selection.mode !== "installed" || await fileSha256(copied) !== selection.sha256) throw refusal("native_copy_mismatch");
    }
    const port = await reservePort(), dbPath = path.join(directory, "runphantom.db"), url = `http://127.0.0.1:${port}`;
    const cleanEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("RUNPHANTOM_") && key !== "ANTHROPIC_API_KEY" && key !== "OPENAI_API_KEY"));
    const childEnv = { ...cleanEnv, HOME: profile, USERPROFILE: profile, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", RUNPHANTOM_OPENAI_API_KEY: "",
      RUNPHANTOM_PORT: String(port), RUNPHANTOM_BIND_HOST: "127.0.0.1", RUNPHANTOM_ALLOWED_HOSTS: "", RUNPHANTOM_ALLOWED_SOURCE_IPS: "", RUNPHANTOM_ALLOWED_ORIGINS: "",
      RUNPHANTOM_DB_PATH: dbPath, RUNPHANTOM_SECRET_STORE_PATH: path.join(directory, "secrets.json"), RUNPHANTOM_CLAUDE_CLI_CHAT: "0" };
    const file = copied ?? "bun", args = copied ? ["serve"] : ["--no-env-file", "--no-install", path.join(repoRoot, "src/index.ts"), "serve"];
    owned = launchOwnedProcess(file, args, cwd, childEnv);
    const logs: string[] = []; let logBytes = 0;
    const capture = (data: Buffer) => { logBytes += data.length; if (logBytes < 64 * 1024) logs.push(data.toString()); };
    owned.child.stdout?.on("data", capture); owned.child.stderr?.on("data", capture);
    const deadline = Date.now() + Math.min(45_000, Math.max(1, healthMs));
    for (;;) {
      if (owned.error || owned.closeObserved || owned.child.exitCode !== null || owned.child.signalCode !== null) throw refusal("fixture_daemon_exit");
      let response: Response | undefined;
      try { response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) }); } catch { /* bounded startup polling */ }
      if (response?.ok) {
        const health = await response.json() as { ok?: boolean; service?: string; port?: number; pid?: number };
        if (health.ok !== true || health.service !== "runphantom" || health.port !== port || health.pid !== owned.child.pid) throw refusal("fixture_service_identity");
        break;
      }
      if (Date.now() >= deadline) throw refusal("fixture_health_timeout");
      await sleep(100);
    }
    if (!owned.child.pid) throw refusal("fixture_daemon_exit");
    const runtime: RuntimeProvenance = { mode: selection.mode, platform: process.platform, architecture: process.arch, pid: owned.child.pid,
      command: [file, ...args], cwd, stateDirectory: directory, profile, sourceArtifact: artifact, copiedArtifact: copied,
      sourceSha256: selection.mode === "installed" ? selection.sha256 : null, copiedSha256: copied ? await fileSha256(copied) : null,
      observation: copied ? await observeNative(owned.child.pid, copied, cwd, port) : null };
    const active = owned;
    return { url, dbPath, port, runtime, logs: () => logs.join(""), async stop() {
      const process = await stopOwnedProcess(active);
      let unchanged = false;
      try { unchanged = !copied || (await fileSha256(copied) === runtime.copiedSha256 && await fileSha256(artifact!) === runtime.sourceSha256); }
      finally { await removeOwnedDirectory(directory); }
      if (!unchanged) throw refusal("native_artifact_changed");
      return { process, directoryRemoved: true, artifactUnchanged: unchanged };
    } };
  } catch (error) {
    if (owned) await stopOwnedProcess(owned);
    await removeOwnedDirectory(directory);
    throw error;
  }
}


type ManagedDaemon = Awaited<ReturnType<typeof startManagedDaemon>>;
type DaemonCleanup = Awaited<ReturnType<ManagedDaemon["stop"]>>;
type SupervisorJob = { daemon: Promise<ManagedDaemon>; stopped?: Promise<DaemonCleanup>; runtime?: RuntimeProvenance; closed?: boolean };
type SupervisorReply = { job: string; url: string; dbPath: string; port: number; runtime: RuntimeProvenance };
const SUPERVISOR_MESSAGE_BYTES = 64 * 1024;
function supervisorError(error: unknown): string { return error instanceof Error ? error.message : "fixture_supervisor_failed"; }
export async function startFixtureSupervisor(repoRoot: string, env: NodeJS.ProcessEnv) {
  // Only the qualifier chooses execution options; the channel accepts no PID/path/env commands.
  runtimeSelection(env);
  const token = randomBytes(32).toString("hex"), jobs = new Map<string, SupervisorJob>(), sockets = new Set<Socket>();
  let closing = false, nextWorker = 0;
  const stopJob = (job: SupervisorJob): Promise<DaemonCleanup> => job.stopped ??= job.daemon.then(daemon => daemon.stop()).then(cleanup => { job.closed = true; return cleanup; });
  const dispatch = async (input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw refusal("fixture_supervisor_protocol");
    const message = input as Record<string, unknown>;
    if (typeof message.token !== "string" || !/^[a-f0-9]{64}$/.test(message.token) || !timingSafeEqual(Buffer.from(message.token, "hex"), Buffer.from(token, "hex"))) throw refusal("fixture_supervisor_auth");
    if (closing) throw refusal("fixture_supervisor_closed");
    if (message.op === "start" && Object.keys(message).sort().join(",") === "op,token") {
      if (jobs.size >= 256 || [...jobs.values()].some(job => !job.closed)) throw refusal("fixture_supervisor_job_limit");
      const id = randomBytes(16).toString("hex");
      // Register launch ownership synchronously, before any artifact/readiness await can finish.
      const job: SupervisorJob = { daemon: startManagedDaemon(repoRoot, env, nextWorker++) }; jobs.set(id, job);
      const daemon = await job.daemon; job.runtime = daemon.runtime;
      return { job: id, url: daemon.url, dbPath: daemon.dbPath, port: daemon.port, runtime: daemon.runtime } satisfies SupervisorReply;
    }
    if (message.op === "stop" && Object.keys(message).sort().join(",") === "job,op,token" && typeof message.job === "string" && /^[a-f0-9]{32}$/.test(message.job)) {
      const job = jobs.get(message.job); if (!job) throw refusal("fixture_supervisor_unknown_job");
      return await stopJob(job);
    }
    throw refusal("fixture_supervisor_protocol");
  };
  const server = createServer(socket => {
    if (closing || sockets.size >= 8) { socket.destroy(); return; }
    sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => { socket.destroy(); }); socket.setTimeout(5000, () => socket.destroy());
    let bytes = 0, buffer = "", started = false;
    socket.on("data", (chunk: Buffer) => {
      if (started) { socket.destroy(); return; }
      bytes += chunk.length; if (bytes > 4096) { socket.destroy(); return; }
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n"); if (end < 0) return;
      started = true; socket.setTimeout(60_000);
      void (async () => {
        let response: { ok: boolean; value?: unknown; error?: string };
        try { if (end !== buffer.length - 1) throw refusal("fixture_supervisor_protocol"); response = { ok: true, value: await dispatch(JSON.parse(buffer.slice(0, end))) }; }
        catch (error) { response = { ok: false, error: supervisorError(error) }; }
        const body = JSON.stringify(response) + "\n";
        if (Buffer.byteLength(body) > SUPERVISOR_MESSAGE_BYTES) socket.destroy(); else socket.end(body);
      })();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === "string") throw refusal("fixture_supervisor_address");
  return {
    environment: { RUNPHANTOM_E2E_SUPERVISOR_PORT: String(address.port), RUNPHANTOM_E2E_SUPERVISOR_TOKEN: token },
    async close() {
      closing = true;
      for (const socket of sockets) socket.destroy();
      const serverClosed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      // Each promise is the actual launch handle, never reconstructed from a worker receipt.
      const results = await Promise.allSettled([...jobs.values()].map(async job => ({ runtime: (await job.daemon).runtime, cleanup: await stopJob(job) })));
      await serverClosed;
      const failures = results.filter(result => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "fixture_supervisor_cleanup_failed");
      return results.map(result => (result as PromiseFulfilledResult<{ runtime: RuntimeProvenance; cleanup: DaemonCleanup }>).value);
    },
  };
}
async function supervisorRequest(env: NodeJS.ProcessEnv, message: { op: "start" } | { op: "stop"; job: string }): Promise<unknown> {
  const port = env.RUNPHANTOM_E2E_SUPERVISOR_PORT, token = env.RUNPHANTOM_E2E_SUPERVISOR_TOKEN;
  if (!port || !/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535 || !token || !/^[a-f0-9]{64}$/.test(token)) throw refusal("fixture_supervisor_selection");
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: Number(port) }); let bytes = 0, body = "", settled = false;
    const finish = (error?: Error, value?: unknown) => { if (settled) return; settled = true; socket.destroy(); if (error) reject(error); else resolve(value); };
    socket.setTimeout(60_000, () => finish(refusal("fixture_supervisor_timeout")));
    socket.on("error", error => finish(error)); socket.on("close", () => { if (!settled) finish(refusal("fixture_supervisor_disconnected")); });
    socket.once("connect", () => { socket.write(JSON.stringify({ ...message, token }) + "\n"); });
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length; if (bytes > SUPERVISOR_MESSAGE_BYTES) { finish(refusal("fixture_supervisor_reply_limit")); return; }
      body += chunk.toString("utf8"); const end = body.indexOf("\n"); if (end < 0) return;
      try {
        if (end !== body.length - 1) throw refusal("fixture_supervisor_protocol");
        const response = JSON.parse(body.slice(0, end)) as { ok: boolean; value?: unknown; error?: string };
        if (response.ok !== true) throw refusal(response.error ?? "fixture_supervisor_failed");
        finish(undefined, response.value);
      } catch (error) { finish(error instanceof Error ? error : refusal("fixture_supervisor_protocol")); }
    });
  });
}
export async function startFixtureDaemon(repoRoot: string, env: NodeJS.ProcessEnv, workerIndex: number): Promise<ManagedDaemon> {
  if (!env.RUNPHANTOM_E2E_SUPERVISOR_PORT && !env.RUNPHANTOM_E2E_SUPERVISOR_TOKEN) return await startManagedDaemon(repoRoot, env, workerIndex);
  const daemon = await supervisorRequest(env, { op: "start" }) as SupervisorReply;
  return { ...daemon, logs: () => "", stop: async () => await supervisorRequest(env, { op: "stop", job: daemon.job }) as DaemonCleanup };
}
