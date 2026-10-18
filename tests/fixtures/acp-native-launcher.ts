import { spawn } from "node:child_process";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Compile only these controlled fixtures; never select an executable from a request. */
export async function compileNativeAcpFixture(directory: string, bunExecutable: string): Promise<string> {
  const source = path.dirname(fileURLToPath(import.meta.url));
  const entry = path.join(directory, "controlled-entry.ts");
  const executable = path.join(directory, process.platform === "win32" ? "controlled acp.exe" : "controlled acp");
  writeFileSync(entry, `if (process.env.RUNPHANTOM_ACP_UI_MODE === "actual_mcp") await import(${JSON.stringify(path.join(source, "acp-verification-provider.ts"))}); else await import(${JSON.stringify(path.join(source, "acp-provider.ts"))});\n`, { mode: 0o600 });
  const env: Record<string, string> = { HOME: directory, USERPROFILE: directory, TMPDIR: directory, TMP: directory, TEMP: directory };
  for (const key of ["PATH", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR", "COMSPEC"]) if (process.env[key]) env[key] = process.env[key]!;
  const child = spawn(bunExecutable, ["--no-env-file", "build", "--compile", entry, "--outfile", executable], { cwd: directory, env, stdio: "ignore" });
  let failed = false, timedOut = false;
  child.once("error", () => { failed = true; });
  const closed = new Promise<number | null>(resolve => child.once("close", resolve));
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 15_000);
  try {
    const code = await closed;
    if (failed || timedOut || code !== 0 || !statSync(executable).isFile()) throw new Error("Controlled ACP fixture compilation unavailable");
    return executable;
  } finally { clearTimeout(timer); }
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
