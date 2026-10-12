import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, copyFile, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
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
  return paths.relative(checkout, directory).startsWith("..");
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
function command(file: string, args: string[], maxBuffer = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => execFile(file, args, { timeout: 3000, maxBuffer, windowsHide: true },
    (error, stdout) => error ? reject(refusal("native_observation_failed")) : resolve(stdout)));
}
export async function observeNative(pid: number, executable: string, cwd: string, port: number): Promise<ProcessObservation> {
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
    const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; $l=@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue); @{exe=$p.ExecutablePath;command=$p.CommandLine;owned=(@($l|Where-Object {$_.OwningProcess -eq ${pid}}).Count -gt 0)}|ConvertTo-Json -Compress`;
    const raw = JSON.parse(await command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script])) as { exe: string; command: string; owned: boolean };
    if (!raw.exe || (await realpath(raw.exe)).toLowerCase() !== executable.toLowerCase() || !raw.command?.includes(path.basename(executable)) || !raw.owned) throw refusal("native_identity_mismatch");
    return { executable: raw.exe, cwd: null, command: raw.command, listenerOwned: true, cwdEvidence: "launch-only" };
  }
  throw refusal("native_platform_unsupported");
}
async function processIdentity(pid: number): Promise<string | null> {
  try {
    if (process.platform === "linux") {
      const fields = (await readFile(`/proc/${pid}/stat`, "utf8")).split(")").at(-1)!.trim().split(/\s+/);
      return `${pid}:${fields[19]}`; // Kernel process start ticks, independent of PID reuse.
    }
    if (process.platform === "win32") {
      const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if($p){$p.CreationDate.ToUniversalTime().ToString("o")}`;
      const stamp = (await command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script])).trim();
      return stamp ? `${pid}:${stamp}` : null;
    }
    const stamp = (await command("/bin/ps", ["-p", String(pid), "-o", "lstart=,command="])).trim();
    return stamp ? `${pid}:${stamp}` : null;
  } catch { return null; }
}
type ProcessRow = { pid: number; parent: number; identity: string };
type Ownership = { root: ChildProcess; pid: number | undefined; identity: Promise<string | null>; descendants: Map<number, string>; pending: Promise<void>; running?: boolean; timer?: ReturnType<typeof setInterval>; failure?: Error };
const ownership = new WeakMap<OwnedProcess, Ownership>();
const MAX_DESCENDANTS = 64;
async function processRows(): Promise<ProcessRow[]> {
  if (process.platform === "win32") {
    const script = '@(Get-CimInstance Win32_Process | ForEach-Object { @{pid=$_.ProcessId;parent=$_.ParentProcessId;birth=$_.CreationDate.ToUniversalTime().ToString("o")} })|ConvertTo-Json -Compress';
    const rows = JSON.parse(await command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 512 * 1024)) as { pid: number; parent: number; birth: string }[];
    if (!Array.isArray(rows) || rows.length > 8192) throw refusal("fixture_process_snapshot_limit");
    return rows.map(row => ({ pid: row.pid, parent: row.parent, identity: `${row.pid}:${row.birth}` }));
  }
  const output = await command("ps", ["-axo", process.platform === "linux" ? "pid=,ppid=" : "pid=,ppid=,lstart=,command="], 512 * 1024);
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
  if (root?.identity === expected) anchors.add(pid);
  for (const [member, identity] of lease.descendants) if ((await liveRow(member))?.identity === identity) anchors.add(member);
  // Adopt only edges in a bounded OS snapshot whose parent still has its recorded birth.
  for (let changed = true; changed;) {
    changed = false;
    for (const candidate of rows) {
      if (!anchors.has(candidate.parent) || anchors.has(candidate.pid)) continue;
      const row = await liveRow(candidate.pid), parent = await liveRow(candidate.parent);
      const parentIdentity = candidate.parent === pid ? expected : lease.descendants.get(candidate.parent);
      if (!row || row.parent !== candidate.parent || parent?.identity !== parentIdentity) continue;
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
export function launchOwnedProcess(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): OwnedProcess {
  const child = spawn(file, args, { cwd, env, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const owned: OwnedProcess = { child, closed: Promise.resolve(), closeObserved: false, error: null, identity: child.pid ? processIdentity(child.pid) : Promise.resolve(null) };
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
  const lease = ownership.get(owned); if (!lease) throw refusal("fixture_process_unknown_owner");
  if (owned.child !== lease.root || owned.child.pid !== lease.pid || await owned.identity !== await lease.identity) throw refusal("fixture_process_identity_lost");
  clearInterval(lease.timer); await lease.pending; await scheduleOwnership(owned, lease);
  if (lease.failure) throw lease.failure;
  const pid = owned.child.pid, expected = await owned.identity; let forced = false;
  const rootIdentity = pid ? await processIdentity(pid) : null;
  if (rootIdentity && rootIdentity !== expected) throw refusal("fixture_process_identity_lost");
  const recorded = new Map(lease.descendants); if (pid && expected) recorded.set(pid, expected);
  const signalOwned = async (signal: "SIGTERM" | "SIGKILL") => {
    let found = false;
    for (const [member, identity] of recorded) {
      const current = await processIdentity(member);
      if (!current) continue;
      if (current !== identity) throw refusal("fixture_process_identity_lost");
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
    const remaining = await Promise.all([...recorded].map(async ([member, identity]) => {
      const current = await processIdentity(member);
      if (current && current !== identity) throw refusal("fixture_process_identity_lost");
      return !!current;
    }));
    if (!remaining.some(Boolean)) break;
    forced = true; await signalOwned("SIGKILL");
    if (Date.now() >= deadline) throw refusal("fixture_process_descendants_not_reaped");
    await sleep(25);
  }
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
