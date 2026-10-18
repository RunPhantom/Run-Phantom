import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, realpathSync, statSync, writeFileSync, lstatSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AcpCompilerClose { code: number | null; signal: NodeJS.Signals | null; }
export interface AcpCompilerLaunch { child: ChildProcess; closed: Promise<AcpCompilerClose>; }
export interface AcpCompilerLimits { runMs: number; confirmationMs: number; }
const compilerLimits: AcpCompilerLimits = { runMs: 15_000, confirmationMs: 2_000 };

/** Actual native close is separate from signal acceptance. The owner survives failed setup. */
export function ownAcpCompiler(directory: string) {
  const identity = lstatSync(directory), admitted = performance.now();
  if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error("Controlled ACP compiler directory unavailable");
  let launched: AcpCompilerLaunch | undefined, observed: AcpCompilerClose | undefined;
  let attempted = false, removed = false, terminalConfirmed = false, primaryError: unknown, killAccepted: boolean | null = null;
  const secondaryErrors: unknown[] = [];
  const secondary = (error: unknown) => { if (secondaryErrors.length < 8) secondaryErrors.push(error); };
  const absent = () => {
    // Once close and absence release this identity, never probe a potentially reused PID/group.
    if (terminalConfirmed) return true;
    if (!launched) return true;
    if (!observed) return false;
    const pid = launched.child.pid; if (pid === undefined) { terminalConfirmed = true; return true; }
    try { process.kill(process.platform === "win32" ? pid : -pid, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { terminalConfirmed = true; return true; } secondary(error); return false; }
  };
  const ownership = () => ({ directory, device: identity.dev, inode: identity.ino, pid: launched?.child.pid ?? null,
    scope: process.platform === "win32" ? "direct-child-and-pipes" : "owned-posix-group", closeObserved: !!observed,
    terminalConfirmed: absent(), removed, killAccepted, secondaryErrorCount: secondaryErrors.length });
  const retain = () => { try {
    const current = lstatSync(directory);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error("Controlled ACP compiler directory identity changed");
    writeFileSync(path.join(directory, "compiler-ownership.json"), JSON.stringify(ownership()) + "\n", { mode: 0o600 });
  } catch (error) { secondary(error); } };
  async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<{ value: T } | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise.then(value => ({ value })), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, milliseconds)); })]); }
    finally { clearTimeout(timer); }
  }
  async function run(start: () => AcpCompilerLaunch, limits: AcpCompilerLimits = compilerLimits): Promise<void> {
    if (attempted || removed || !Number.isSafeInteger(limits.runMs) || !Number.isSafeInteger(limits.confirmationMs) || limits.runMs < 1 || limits.runMs > compilerLimits.runMs || limits.confirmationMs < 1 || limits.confirmationMs > compilerLimits.confirmationMs) throw new Error("Controlled ACP compiler admission unavailable");
    attempted = true;
    try {
      launched = start();
      const failed = new Promise<Error>(resolve => launched!.child.once("error", resolve));
      void launched.closed.then(value => { observed = value; }, secondary);
      const result = await bounded(Promise.race([launched.closed.then(value => ({ kind: "close" as const, value })), failed.then(error => ({ kind: "error" as const, error }))]), admitted + limits.runMs - performance.now());
      if (result === null) throw new Error("Controlled ACP compiler deadline");
      if (result.value.kind === "error") throw result.value.error;
      if (result.value.value.code !== 0) throw new Error("Controlled ACP fixture compilation unavailable");
      if (!absent()) throw new Error("Controlled ACP compiler terminal ownership unavailable");
    } catch (error) {
      primaryError = error;
      if (launched && !absent()) {
        try {
          const pid = launched.child.pid;
          killAccepted = pid === undefined ? false : process.platform === "win32" ? launched.child.kill("SIGKILL") : process.kill(-pid, "SIGKILL");
        } catch (failure) { secondary(failure); }
        const deadline = Math.min(admitted + limits.runMs + limits.confirmationMs, performance.now() + limits.confirmationMs);
        while (!absent() && performance.now() < deadline) await bounded(new Promise<void>(resolve => setTimeout(resolve, 10)), deadline - performance.now());
      }
      if (!absent()) retain();
      throw error;
    }
  }
  function cleanup() {
    if (removed) return ownership();
    if (!absent()) { retain(); return ownership(); }
    try {
      const current = lstatSync(directory);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error("Controlled ACP compiler directory identity changed");
      rmSync(directory, { recursive: true, force: true }); removed = true;
    } catch (error) { secondary(error); retain(); }
    return ownership();
  }
  return { run, cleanup, ownership, get primaryError() { return primaryError; }, secondaryErrors };
}

/** Compile only these controlled fixtures; never select an executable from a request. */
export function createNativeAcpFixture(directory: string) {
  const owner = ownAcpCompiler(directory);
  return { ...owner, get primaryError() { return owner.primaryError; }, async compile(bunExecutable: string): Promise<string> {
    const source = path.dirname(fileURLToPath(import.meta.url));
    const entry = path.join(directory, "controlled-entry.ts");
    const executable = path.join(directory, process.platform === "win32" ? "controlled acp.exe" : "controlled acp");
    await owner.run(() => {
      writeFileSync(entry, `if (process.env.RUNPHANTOM_ACP_UI_MODE === "actual_mcp") await import(${JSON.stringify(path.join(source, "acp-verification-provider.ts"))}); else await import(${JSON.stringify(path.join(source, "acp-provider.ts"))});\n`, { mode: 0o600 });
      const env: Record<string, string> = { HOME: directory, USERPROFILE: directory, TMPDIR: directory, TMP: directory, TEMP: directory };
      for (const key of ["PATH", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR", "COMSPEC"]) if (process.env[key]) env[key] = process.env[key]!;
      const child = spawn(bunExecutable, ["--no-env-file", "build", "--compile", entry, "--outfile", executable], { cwd: directory, env, stdio: "ignore", detached: process.platform !== "win32" });
      const closed = new Promise<AcpCompilerClose>(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
      return { child, closed };
    });
    if (!statSync(executable).isFile()) throw new Error("Controlled ACP fixture compilation unavailable");
    return executable;
  } };
}

export type AcpFixtureStage = "private-profile" | "http-ready" | "availability" | "http-failed" | "http-complete" | "ui-ready" | "ui-closed";
export interface AcpFixtureProbe { status: number; available: boolean; reason: string | null; protocolPresent: boolean; versionPresent: boolean; }
const reasons = new Set(["unavailable", "unsupported_protocol", "authentication_required", "protocol_error", "limit", "timeout", "cancelled", "scope_changed", "busy"]);
export function safeAcpFixtureProbe(status: number, body: Record<string, unknown>): AcpFixtureProbe {
  return { status, available: body.available === true, reason: typeof body.reason === "string" && reasons.has(body.reason) ? body.reason : body.reason === undefined ? null : "unknown", protocolPresent: typeof body.protocolVersion === "number", versionPresent: typeof body.version === "string" };
}
/** Fixed-size private diagnostics: no provider stderr, arguments, paths or credentials. */
export function recordAcpFixtureStage(profile: string, stage: AcpFixtureStage, probe?: AcpFixtureProbe): string | undefined {
  try {
    let births: { event: string; pid: number }[] = [], receiptAvailable = false;
    const file = path.join(profile, "native-pids.jsonl");
    try {
      if (statSync(file).size <= 65_536) {
        const entries = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { event?: unknown; pid?: unknown });
        births = entries.filter((v): v is { event: string; pid: number } => typeof v.event === "string" && ["birth", "term", "mcp_birth", "mcp_reaped"].includes(v.event) && typeof v.pid === "number" && Number.isSafeInteger(v.pid) && v.pid > 0).map(v => ({ event: v.event, pid: v.pid }));
        receiptAvailable = true;
      }
    } catch { /* Absence is recorded, never confused with an observed birth. */ }
    const value = { stage, pid: process.pid, privateHome: realpathSync(homedir()) === realpathSync(profile), userProfile: process.env.USERPROFILE === profile, receiptAvailable, nativeBirthCount: births.filter(v => v.event === "birth").length, observations: births.slice(0, 16), truncated: births.length > 16, probe: probe ?? null };
    const text = JSON.stringify(value); if (Buffer.byteLength(text) <= 4096) { writeFileSync(path.join(profile, "launch-diagnostic.json"), text + "\n"); return text; }
  } catch { /* Diagnostic failure must not replace a business assertion or cleanup error. */ }
}
