import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, copyFile, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

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
function command(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(file, args, { timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true },
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
async function groupIdentities(pid: number): Promise<Map<number, string>> {
  const output = await command("ps", ["-axo", "pid=,pgid=,lstart="]);
  const result = new Map<number, string>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match && Number(match[2]) === pid) result.set(Number(match[1]), match[3]);
  }
  return result;
}
async function stillOwned(owned: OwnedProcess): Promise<boolean> {
  const expected = await owned.identity, pid = owned.child.pid;
  return !!expected && !!pid && expected === await processIdentity(pid);
}
export function launchOwnedProcess(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): OwnedProcess {
  const child = spawn(file, args, { cwd, env, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const owned: OwnedProcess = { child, closed: Promise.resolve(), closeObserved: false, error: null, identity: child.pid ? processIdentity(child.pid) : Promise.resolve(null) };
  owned.closed = new Promise(resolve => child.once("close", () => { owned.closeObserved = true; resolve(); }));
  child.once("error", error => { owned.error = error; });
  return owned;
}
async function closedWithin(owned: OwnedProcess, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([owned.closed.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer); }
}
export async function stopOwnedProcess(owned: OwnedProcess): Promise<{ pid: number | null; closeObserved: true; forced: boolean; identity: string | null }> {
  const pid = owned.child.pid; let forced = false;
  let originalGroup = new Map<number, string>();
  if (!owned.closeObserved && pid) {
    if (!await stillOwned(owned)) {
      if (!await closedWithin(owned, 2500)) throw refusal("fixture_process_identity_lost");
    } else if (process.platform === "win32") {
      forced = true;
      await command("taskkill.exe", ["/PID", String(pid), "/T", "/F"]).catch(error => { if (!owned.closeObserved) throw error; });
    } else {
      originalGroup = await groupIdentities(pid);
      try { process.kill(-pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  }
  if (!await closedWithin(owned, 2500)) {
    forced = true;
    if (!await stillOwned(owned)) throw refusal("fixture_process_identity_lost");
    if (pid && process.platform !== "win32") { try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
    else owned.child.kill("SIGKILL");
    if (!await closedWithin(owned, 2500)) throw refusal("fixture_process_not_closed");
  }
  if (pid && process.platform !== "win32") {
    // A surviving original member reserves the detached group identity after its parent exits.
    const deadline = Date.now() + 2000;
    for (;;) {
      const current = await groupIdentities(pid);
      if (!current.size) break;
      if (![...current].some(([member, stamp]) => originalGroup.get(member) === stamp)) throw refusal("fixture_process_group_identity_lost");
      try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      if (Date.now() >= deadline) throw refusal("fixture_process_group_not_reaped");
      await sleep(25);
    }
  }
  return { pid: pid ?? null, closeObserved: true, forced, identity: await owned.identity };
}
export async function removeOwnedDirectory(directory: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rm(directory, { recursive: true, force: true }); break; }
    catch (error) {
      if (attempt >= 9 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await sleep(100);
    }
  }
  try { await stat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw refusal("fixture_directory_not_removed");
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
