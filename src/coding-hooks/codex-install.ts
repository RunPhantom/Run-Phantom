import { lstat, mkdir, open, realpath, rename, unlink, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { readClaudeSettingsText } from "./install";
import { CODEX_EVENTS, codexDigest } from "./codex";
import { canonicalPath, decodeRegistration, fail, mergeSettings, missing, privateDirectory, readRegular, stateRoot, type CodexRegistration } from "./codex-registration";
import { IS_PACKAGED_RUNTIME } from "../version";
import { SOURCE_ENTRY } from "../source-paths";

export interface CodexInstallOptions { workspace: string; home?: string; codexHome?: string; executable?: string[]; port?: number; fullConsent?: boolean; }
const quote = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

async function replace(file: string, text: string, before: string | null): Promise<void> {
  const tmp = file + "." + randomBytes(12).toString("hex") + ".tmp";
  const f = await open(tmp, "wx", 0o600);
  try { await f.writeFile(text); await f.sync(); } finally { await f.close(); }
  try {
    if (await readClaudeSettingsText(file) !== before) fail("configuration_changed");
    await rename(tmp, file);
  } finally { await unlink(tmp).catch(() => {}); }
}
async function registrationFile(options: CodexInstallOptions): Promise<{ file: string; id: string; home: string; workspace: string }> {
  const home = await realpath(options.home ?? os.homedir()), workspace = await realpath(options.workspace);
  if (!canonicalPath(home) || !canonicalPath(workspace)) fail("invalid_workspace");
  const id = codexDigest(JSON.stringify([home, workspace])).slice(0, 32);
  return { home, workspace, id, file: path.join(stateRoot(home), id + ".json") };
}

/** Installs only explicit local full capture; it neither changes config.toml nor grants vendor hook trust. */
export async function manageCodexHooks(action: "install" | "uninstall" | "doctor", options: CodexInstallOptions): Promise<unknown> {
  const location = await registrationFile(options), { file, id, home, workspace } = location;
  if (action === "install") await mkdir(path.join(home, ".runphantom"), { recursive: true, mode: 0o700 });
  await privateDirectory(path.join(home, ".runphantom"));
  if (action === "install") await mkdir(stateRoot(home), { recursive: true, mode: 0o700 });
  await privateDirectory(stateRoot(home));
  const lock = await open(file + ".lock", "wx", 0o600);
  try {
    let original: string | null = null;
    try { original = await readRegular(file, 16384, true); } catch (e) { if (!missing(e)) throw e; }
    let reg: CodexRegistration;
    if (original) reg = decodeRegistration(original);
    else {
      if (action !== "install") return { configuration: "missing", captureVerified: false };
      const codexHome = await realpath(options.codexHome ?? path.join(home, ".codex"));
      const argv = options.executable ?? (IS_PACKAGED_RUNTIME ? [process.execPath] : [process.execPath, "--no-env-file", SOURCE_ENTRY]);
      if (!argv.length || argv.some(s => typeof s !== "string" || !s || /[\0\r\n]/.test(s)) || !canonicalPath(argv[0])) fail("invalid_executable");
      reg = { version: 1, id, enabled: true, workspace, sessionsRoot: path.join(codexHome, "sessions"), port: options.port ?? 5947, command: [...argv, "hooks", "handle", "codex", "--registration-file", file, "--installation-id", id].map(quote).join(" ") };
      decodeRegistration(JSON.stringify(reg));
    }
    if (reg.workspace !== workspace || reg.id !== id) fail("registration_mismatch");
    const parent = path.join(workspace, ".codex"), settingsFile = path.join(parent, "hooks.json");
    if (action === "install") {
      if (!options.fullConsent) fail("local_full_capture_requires_consent");
      await mkdir(parent, { recursive: true, mode: 0o700 });
    }
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || await realpath(parent) !== parent) fail("linked_config_directory");
    const before = await readClaudeSettingsText(settingsFile), result = mergeSettings(before, reg, action === "doctor" ? "install" : action);
    if (action === "doctor") return { configuration: result.count === CODEX_EVENTS.length ? "installed" : result.count ? "partial" : "missing", enabled: reg.enabled, captureVerified: false, vendorTrust: "review_in_codex_hooks", transport: "not_probed", rolloutVersion: "0.163.0", profile: "local_full_posix" };
    if (action === "uninstall") {
      await replace(file, JSON.stringify({ ...reg, enabled: false }), original);
      if (result.changed) await replace(settingsFile, result.text, before);
      await unlink(file);
    } else {
      if (result.changed) await replace(settingsFile, result.text, before);
      const text = JSON.stringify({ ...reg, enabled: true });
      if (text !== original) await replace(file, text, original);
    }
    return { configuration: action === "install" ? "installed" : "removed", changed: result.changed, captureVerified: false, vendorTrust: "review_in_codex_hooks", installationId: id };
  } finally { await lock.close(); await unlink(file + ".lock"); }
}

export async function removeConfiguredCodexHooks(home = os.homedir()): Promise<number> {
  let resolved: string;
  try { resolved = await realpath(home); } catch (e) { if (missing(e)) return 0; throw e; }
  const root = stateRoot(resolved);
  try { await privateDirectory(root); } catch (e) { if (missing(e)) return 0; throw e; }
  const names = (await readdir(root)).filter(n => /^[a-f0-9]{32}\.json$/.test(n));
  if (names.length > 64) fail("registration_limit");
  for (const name of names) {
    const reg = decodeRegistration(await readRegular(path.join(root, name), 16384, true));
    await manageCodexHooks("uninstall", { workspace: reg.workspace, home });
  }
  return names.length;
}

export async function cmdCodexHooks(argv: string[]): Promise<number> {
  try {
    const action = argv[0];
    if (!["install", "uninstall", "doctor"].includes(action)) fail("usage: runphantom hooks install|doctor|uninstall codex --local --cwd PATH [--full --consent-full] [--port PORT]");
    const options: CodexInstallOptions = { workspace: process.cwd() }; let local = false, full = false;
    for (let i = 2; i < argv.length; i++) {
      if (argv[i] === "--local") local = true;
      else if (argv[i] === "--cwd" && argv[i + 1]) options.workspace = path.resolve(argv[++i]);
      else if (argv[i] === "--full") full = true;
      else if (argv[i] === "--consent-full") options.fullConsent = true;
      else if (argv[i] === "--port" && /^[1-9][0-9]{0,4}$/.test(argv[i + 1] ?? "")) options.port = Number(argv[++i]);
      else fail("unsupported Codex hook argument");
    }
    if (!local || action === "install" && !full) fail("Codex capture requires explicit --local --full --consent-full");
    console.log(JSON.stringify(await manageCodexHooks(action as "install" | "doctor" | "uninstall", options))); return 0;
  } catch (e) { console.error(e instanceof Error ? e.message : "Codex capture unavailable"); return 64; }
}
