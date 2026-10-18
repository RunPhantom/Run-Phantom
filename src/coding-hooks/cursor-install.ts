import { constants } from "node:fs";
import { access, lstat, mkdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SOURCE_ROOT } from "../source-paths";
import { IS_PACKAGED_RUNTIME } from "../version";
import { parseBoundedHookJson, type HookJson } from "./shared";
import { CURSOR_HOOK_EVENTS } from "./cursor";
import { SETTINGS_LIMITS, readClaudeSettingsText, type HookInstallAuthority, type SettingsResult, type ClaudeHookDoctor } from "./install";
import type { HookManagementPlatform } from "./management";
import type { HookManagementCommand } from "./configuration";
import type { InstallationBinding } from "./store";
import { hookDigest, isHex, refuse } from "./protocol";

const object = (v: HookJson | undefined): v is { [key: string]: HookJson } => !!v && typeof v === "object" && !Array.isArray(v);
export const cursorInstallationId = (scope: "global" | "local", file: string): string => hookDigest(JSON.stringify(["runphantom.cursor.installation/v1", scope, file])).slice(0, 32);
/** POSIX shell words are quoted independently; a command string is required by Cursor's native schema. */
export function cursorCommand(authority: HookInstallAuthority): string {
  if (process.platform === "win32") throw new Error("Native Windows private capability ownership is unavailable");
  if (!isHex(authority.installationId, 32) || [authority.executable, authority.capabilityFile].some(p => typeof p !== "string" || !path.isAbsolute(p) || path.normalize(p) !== p || /[\0\r\n]/.test(p) || Buffer.byteLength(p) > 4096)) throw new Error("invalid Cursor install authority");
  return [authority.executable, "hooks", "handle", "cursor", "--installation-id", authority.installationId, "--capability-file", authority.capabilityFile].map(x => "'" + x.replace(/'/g, "'\\''") + "'").join(" ");
}
function handler(authority: HookInstallAuthority) { return { command: cursorCommand(authority), timeout: 3, failClosed: false }; }
export function mergeCursorSettings(input: unknown, operation: "install" | "uninstall", authority: HookInstallAuthority): SettingsResult {
  try {
    const expected = handler(authority);
    if (!["install", "uninstall"].includes(operation)) return { status: "unavailable", reason: "invalid_fields" };
    if (input === null && operation === "uninstall") return { status: "accepted", text: null, changed: false, ownedHandlers: 0 };
    const parsed = input === null ? { status: "accepted" as const, value: {} as HookJson } : parseBoundedHookJson(input);
    if (parsed.status !== "accepted") return { status: "unavailable", reason: parsed.reason === "duplicate_keys" ? "duplicate_keys" : "invalid_json" };
    const settings = parsed.value;
    if (!object(settings) || settings.version !== undefined && settings.version !== 1 || settings.hooks !== undefined && !object(settings.hooks)) return { status: "unavailable", reason: "invalid_fields" };
    const hooks = object(settings.hooks) ? settings.hooks : {};
    let count = 0;
    for (const values of Object.values(hooks)) {
      if (!Array.isArray(values) || values.some(x => !object(x) || typeof x.command !== "string")) return { status: "unavailable", reason: "invalid_fields" };
      count += values.length;
    }
    if (count > SETTINGS_LIMITS.handlers) return { status: "unavailable", reason: "handler_limit" };
    let changed = false, ownedHandlers = 0;
    for (const event of CURSOR_HOOK_EVENTS) {
      const values = (hooks[event] ?? []) as HookJson[];
      const owned = values.filter(x => object(x) && typeof x.command === "string" && x.command.includes(authority.installationId));
      if (owned.length > 1 || owned.some(x => !object(x) || Object.keys(x).sort().join() !== Object.keys(expected).sort().join() || Object.entries(expected).some(([k, v]) => x[k] !== v))) return { status: "unavailable", reason: "ownership_uncertain" };
      if (operation === "install") {
        if (!owned.length) { hooks[event] = [...values, expected]; changed = true; }
        ownedHandlers++;
      } else if (owned.length) {
        const remaining = values.filter(x => !owned.includes(x));
        if (remaining.length) hooks[event] = remaining; else delete hooks[event];
        changed = true;
      }
    }
    if (operation === "install") { if (settings.version !== 1) changed = true; settings.version = 1; settings.hooks = hooks; }
    else if (changed) { if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks; }
    const text = changed ? JSON.stringify(settings, null, 2) + "\n" : input as string;
    if (Buffer.byteLength(text) > 262144) return { status: "unavailable", reason: "byte_limit" };
    return { status: "accepted", text, changed, ownedHandlers };
  } catch { return { status: "unavailable", reason: "invalid_authority" }; }
}
export async function inspectCursorSettings(file: string, authority: HookInstallAuthority): Promise<ClaudeHookDoctor> {
  const result: ClaudeHookDoctor = { configuration: "unavailable", ownedHandlers: 0, executable: "unavailable", installedVendorVersion: null, capturePolicy: "inactive", transport: "unavailable", captureVerified: false };
  try {
    const text = await readClaudeSettingsText(file);
    if (text === null) result.configuration = "missing";
    else {
      const removed = mergeCursorSettings(text, "uninstall", authority), installed = mergeCursorSettings(text, "install", authority);
      if (removed.status !== "accepted" || installed.status !== "accepted") return result;
      const parsed = parseBoundedHookJson(text);
      if (parsed.status !== "accepted" || !object(parsed.value) || !object(parsed.value.hooks)) result.configuration = "missing";
      else {
        const hooks = parsed.value.hooks;
        result.ownedHandlers = CURSOR_HOOK_EVENTS.filter(event => {
          const values = hooks[event];
          return Array.isArray(values) && values.some(x => object(x) && x.command === cursorCommand(authority));
        }).length;
        result.configuration = !installed.changed ? "installed" : result.ownedHandlers ? "partial" : "missing";
      }
    }
    if ((await stat(authority.executable)).isFile()) { await access(authority.executable, constants.R_OK | constants.X_OK); result.executable = "available"; }
  } catch { /* Diagnostic cannot create policy, run the vendor or expose descriptor contents. */ }
  return result;
}
export const CURSOR_PLATFORM: HookManagementPlatform = { name: "cursor", settingsRelative: ".cursor/hooks.json", installationId: cursorInstallationId, merge: mergeCursorSettings, inspect: inspectCursorSettings };
async function prepare(directory: string): Promise<void> {
  for (let at = directory, steps = 0; ; steps++) {
    if (steps >= 64) refuse("unknown_scope");
    const entry = await lstat(at).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(at) !== at)) refuse("unknown_scope");
    const next = path.dirname(at); if (next === at) break; at = next;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) refuse("unknown_scope");
}
export async function configuredCursorBinding(command: HookManagementCommand, databaseFile: string, create = false): Promise<InstallationBinding> {
  const workspace = await realpath(command.workspace), home = await realpath(os.homedir());
  if (workspace !== command.workspace || !(await lstat(workspace)).isDirectory()) refuse("unknown_scope");
  const profile = await realpath(path.dirname(databaseFile)), root = path.join(profile, "coding-hooks/cursor/sources"), project = path.join(root, hookDigest(workspace));
  const settingsPath = path.join(command.scope === "global" ? home : workspace, ".cursor/hooks.json");
  if (create) { await prepare(project); await prepare(path.dirname(settingsPath)); }
  const executable = await realpath(IS_PACKAGED_RUNTIME ? process.execPath : process.env.RUNPHANTOM_BIN_PATH || path.join(SOURCE_ROOT, "bin/runphantom-dev"));
  return { installationId: cursorInstallationId(command.scope, settingsPath), scope: command.scope, captureMode: command.captureMode, workspace: command.scope === "global" ? null : workspace, registeredWorkspace: workspace, transcriptRoot: root, projectDirectory: project, homeDirectory: home, settingsPath, executable };
}
