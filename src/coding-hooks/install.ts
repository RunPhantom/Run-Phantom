import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { access, lstat, mkdir, open, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { parseJsonEvidence } from "../evaluations/json-evidence";
import { hasDuplicateJsonKeys } from "../json-keys";
import { CLAUDE_HOOK_EVENTS, type HookJson } from "./shared";

export const SETTINGS_LIMITS = Object.freeze({ bytes: 1048576, depth: 32, nodes: 20000, handlers: 256 });
/** Only trusted local management supplies these values. No capture policy or credential enters settings. */
export interface HookInstallAuthority { executable: string; installationId: string; capabilityFile: string; }
export type SettingsFailure = "invalid_authority" | "invalid_json" | "duplicate_keys" | "unsafe_key" | "byte_limit" | "depth_limit" | "node_limit" | "invalid_fields" | "handler_limit" | "ownership_uncertain" | "path_not_authorized" | "not_regular_file" | "locked" | "settings_changed" | "settings_unavailable";
export type SettingsResult = { status: "accepted"; text: string | null; changed: boolean; ownedHandlers: number; reason?: never } | { status: "unavailable"; reason: SettingsFailure; changed?: never; text?: never };
type JsonObject = { [key: string]: HookJson };
class SettingsRefusal extends Error { constructor(readonly reason: SettingsFailure) { super(reason); } }
function fail(reason: SettingsFailure): never { throw new SettingsRefusal(reason); }
function record(value: HookJson | undefined): value is JsonObject { return !!value && typeof value === "object" && !Array.isArray(value); }
function validateAuthority(authority: HookInstallAuthority): HookInstallAuthority {
  const executable = Object.getOwnPropertyDescriptor(authority, "executable"), id = Object.getOwnPropertyDescriptor(authority, "installationId"), file = Object.getOwnPropertyDescriptor(authority, "capabilityFile");
  if (!executable || !("value" in executable) || typeof executable.value !== "string" || !path.isAbsolute(executable.value)
    || executable.value.includes("\0") || Buffer.byteLength(executable.value, "utf8") > 4096
    || !id || !("value" in id) || typeof id.value !== "string" || !/^[a-f0-9]{32}$/.test(id.value)
    || !file || !("value" in file) || typeof file.value !== "string" || !path.isAbsolute(file.value) || path.normalize(file.value) !== file.value || file.value.includes("\0") || Buffer.byteLength(file.value) > 4096) fail("invalid_authority");
  return { executable: executable.value, installationId: id.value, capabilityFile: file.value };
}

function decodeSettings(text: unknown): JsonObject {
  if (typeof text !== "string") fail("invalid_json");
  if (Buffer.byteLength(text, "utf8") > SETTINGS_LIMITS.bytes) fail("byte_limit");
  let depth = 0, quoted = false;
  for (let index = 0; index < text.length; index++) {
    const next = text[index];
    if (quoted) { if (next === "\\") index++; else if (next === '"') quoted = false; }
    else if (next === '"') quoted = true;
    else if (next === "[" || next === "{") { if (++depth > SETTINGS_LIMITS.depth) fail("depth_limit"); }
    else if (next === "]" || next === "}") depth--;
  }
  let decoded: HookJson;
  try { decoded = parseJsonEvidence(text) as HookJson; } catch { fail("invalid_json"); }
  if (hasDuplicateJsonKeys(text)) fail("duplicate_keys");
  const pending = [decoded];
  let nodes = 0;
  while (pending.length) {
    if (++nodes > SETTINGS_LIMITS.nodes) fail("node_limit");
    const next = pending.pop();
    if (next && typeof next === "object") {
      for (const key of Object.keys(next)) {
        if (["__proto__", "prototype", "constructor"].includes(key)) fail("unsafe_key");
        pending.push((next as JsonObject)[key]);
      }
      if (nodes + pending.length > SETTINGS_LIMITS.nodes) fail("node_limit");
    }
  }
  if (!record(decoded)) fail("invalid_fields");
  return decoded;
}

function handler(authority: HookInstallAuthority): JsonObject {
  return { type: "command", command: authority.executable, args: ["hooks", "handle", "claude", "--installation-id", authority.installationId, "--capability-file", authority.capabilityFile], timeout: 3, onFailure: "continue" };
}
function candidate(value: JsonObject, authority: HookInstallAuthority): boolean {
  return typeof value.command === "string" && Array.isArray(value.args) && value.args[0] === "hooks"
    && value.args[1] === "handle" && value.args[2] === "claude" && value.args.includes(authority.installationId);
}
function exactHandler(value: JsonObject, authority: HookInstallAuthority): boolean {
  const expected = handler(authority);
  return Object.keys(value).length === Object.keys(expected).length
    && Object.keys(expected).every(key => JSON.stringify(value[key]) === JSON.stringify(expected[key]));
}
function hooksObject(settings: JsonObject): JsonObject | null {
  if (settings.hooks === undefined) return null;
  if (!record(settings.hooks)) fail("invalid_fields");
  let total = 0;
  for (const groups of Object.values(settings.hooks)) {
    if (!Array.isArray(groups)) fail("invalid_fields");
    for (const group of groups) {
      if (!record(group) || !Array.isArray(group.hooks) || (group.matcher !== undefined && typeof group.matcher !== "string")) fail("invalid_fields");
      total += group.hooks.length;
      if (total > SETTINGS_LIMITS.handlers) fail("handler_limit");
      if (group.hooks.some(value => !record(value))) fail("invalid_fields");
    }
  }
  return settings.hooks;
}

/** Preserve unknown settings semantically; unchanged operations preserve the original bytes exactly. */
export function mergeClaudeSettings(input: unknown, operation: "install" | "uninstall", authority: HookInstallAuthority): SettingsResult {
  try {
    authority = validateAuthority(authority);
    if (operation !== "install" && operation !== "uninstall") fail("invalid_fields");
    if (input === null && operation === "uninstall") return { status: "accepted", text: null, changed: false, ownedHandlers: 0 };
    const settings = input === null ? {} : decodeSettings(input);
    const hooks = hooksObject(settings) ?? {};
    let changed = false, ownedHandlers = 0;
    for (const event of CLAUDE_HOOK_EVENTS) {
      const groups = hooks[event] as JsonObject[] | undefined;
      let owned = 0;
      for (const group of groups ?? []) {
        const values = group.hooks as JsonObject[];
        for (const value of values) {
          if (!candidate(value, authority)) continue;
          if (!exactHandler(value, authority) || group.matcher !== "*" || Object.keys(group).length !== 2) fail("ownership_uncertain");
          owned++;
        }
      }
      if (owned > 1) fail("ownership_uncertain");
      if (operation === "install") {
        if (!owned) { hooks[event] = [...groups ?? [], { matcher: "*", hooks: [handler(authority)] }]; changed = true; }
        ownedHandlers++;
      } else if (owned) {
        const remaining = (groups ?? []).flatMap(group => {
          const values = group.hooks as JsonObject[];
          if (!values.some(value => candidate(value, authority))) return [group];
          const retained = values.filter(value => !candidate(value, authority));
          return retained.length ? [{ ...group, hooks: retained }] : [];
        });
        if (remaining.length) hooks[event] = remaining; else delete hooks[event];
        changed = true;
      }
    }
    if (operation === "install" || Object.keys(hooks).length) settings.hooks = hooks;
    else if (changed) delete settings.hooks;
    hooksObject(settings);
    const text = changed ? JSON.stringify(settings, null, 2) + "\n" : input as string;
    if (Buffer.byteLength(text, "utf8") > SETTINGS_LIMITS.bytes) fail("byte_limit");
    return { status: "accepted", text, changed, ownedHandlers };
  } catch (error) { return { status: "unavailable", reason: error instanceof SettingsRefusal ? error.reason : "invalid_authority" }; }
}

interface FileSnapshot { text: string; sha256: string; stats: BigIntStats; }
/** Trusted management stages the same bounded settings snapshot that the exact-owned writer admits. */
export async function readClaudeSettingsText(file: string): Promise<string | null> { return (await readSnapshot(file))?.text ?? null; }
const sameFile = (left: BigIntStats, right: BigIntStats): boolean => left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
async function readSnapshot(file: string): Promise<FileSnapshot | null> {
  let before: BigIntStats;
  try { before = await lstat(file, { bigint: true }); } catch (error) { if (isMissing(error)) return null; throw error; }
  if (before.isSymbolicLink()) fail("path_not_authorized");
  if (!before.isFile()) fail("not_regular_file");
  const fileHandle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const start = await fileHandle.stat({ bigint: true });
    if (!start.isFile() || !sameFile(start, before)) fail("settings_changed");
    if (start.size > BigInt(SETTINGS_LIMITS.bytes)) fail("byte_limit");
    const bytes = Buffer.alloc(Number(start.size));
    let position = 0;
    while (position < bytes.length) {
      const result = await fileHandle.read(bytes, position, Math.min(65536, bytes.length - position), position);
      if (!result.bytesRead) fail("settings_changed");
      position += result.bytesRead;
    }
    const after = await fileHandle.stat({ bigint: true }), current = await lstat(file, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || !sameFile(start, current) || !sameFile(start, after)
      || start.size !== after.size || start.mtimeNs !== after.mtimeNs || start.ctimeNs !== after.ctimeNs) fail("settings_changed");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail("invalid_json"); }
    return { text, sha256: createHash("sha256").update(bytes).digest("hex"), stats: start };
  } finally { await fileHandle.close(); }
}
async function removeOwned(file: string, owner: BigIntStats): Promise<void> {
  try { const current = await lstat(file, { bigint: true }); if (sameFile(current, owner)) await unlink(file); }
  catch (error) { if (!isMissing(error)) throw error; }
}

export interface ClaudeHookDoctor {
  configuration: "installed" | "partial" | "missing" | "unavailable";
  ownedHandlers: number;
  executable: "available" | "unavailable";
  installedVendorVersion: null;
  capturePolicy: "inactive";
  transport: "unavailable";
  captureVerified: false;
  reason?: SettingsFailure;
}

/** Configuration and executable availability do not prove consent, transport or observed capture. */
export async function inspectClaudeHookSettings(file: string, authority: HookInstallAuthority): Promise<ClaudeHookDoctor> {
  const result: ClaudeHookDoctor = { configuration: "unavailable", ownedHandlers: 0, executable: "unavailable", installedVendorVersion: null, capturePolicy: "inactive", transport: "unavailable", captureVerified: false };
  try {
    authority = validateAuthority(authority);
    if (!path.isAbsolute(file) || file.includes("\0") || Buffer.byteLength(file, "utf8") > 4096) fail("path_not_authorized");
    const snapshot = await readSnapshot(file);
    if (!snapshot) result.configuration = "missing";
    else {
      const settings = decodeSettings(snapshot.text), hooks = hooksObject(settings);
      for (const event of CLAUDE_HOOK_EVENTS) {
        let owned = 0;
        for (const group of (hooks?.[event] as JsonObject[] | undefined) ?? []) {
          for (const value of group.hooks as JsonObject[]) {
            if (!candidate(value, authority)) continue;
            if (!exactHandler(value, authority) || group.matcher !== "*" || Object.keys(group).length !== 2) fail("ownership_uncertain");
            owned++;
          }
        }
        if (owned > 1) fail("ownership_uncertain");
        result.ownedHandlers += owned;
      }
      result.configuration = result.ownedHandlers === CLAUDE_HOOK_EVENTS.length ? "installed" : result.ownedHandlers ? "partial" : "missing";
    }
    try {
      if ((await stat(authority.executable)).isFile()) {
        await access(authority.executable, constants.R_OK | constants.X_OK); result.executable = "available";
      }
    } catch { /* A missing or unreadable binary is an unavailable fact, never a launch attempt. */ }
  } catch (error) {
    result.configuration = "unavailable"; result.ownedHandlers = 0;
    result.reason = error instanceof SettingsRefusal ? error.reason : "settings_unavailable";
  }
  return result;
}

/** A cooperative lock and observed-change check, not CAS against a noncooperating writer's rename. */
export async function updateClaudeSettings(file: string, operation: "install" | "uninstall", authority: HookInstallAuthority): Promise<SettingsResult> {
  let lock: FileHandle | undefined, lockStats: BigIntStats | undefined, temporary: string | undefined, temporaryStats: BigIntStats | undefined;
  const parent = path.dirname(file), lockPath = path.join(parent, ".runphantom-hooks.lock");
  try {
    authority = validateAuthority(authority);
    if (operation !== "install" && operation !== "uninstall") fail("invalid_fields");
    if (!path.isAbsolute(file) || file.includes("\0") || Buffer.byteLength(file, "utf8") > 4096) fail("path_not_authorized");
    let parentStats: BigIntStats;
    try { parentStats = await lstat(parent, { bigint: true }); }
    catch (error) {
      if (!isMissing(error)) throw error;
      if (operation === "uninstall") return mergeClaudeSettings(null, operation, authority);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      parentStats = await lstat(parent, { bigint: true });
    }
    if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) fail("path_not_authorized");
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "EEXIST") fail("locked"); throw error; }
    lockStats = await lock.stat({ bigint: true });
    const before = await readSnapshot(file), result = mergeClaudeSettings(before?.text ?? null, operation, authority);
    if (result.status !== "accepted" || !result.changed || result.text === null) return result;
    temporary = path.join(parent, `.runphantom-hooks-${randomBytes(12).toString("hex")}.tmp`);
    const next = await open(temporary, "wx", before ? Number(before.stats.mode & 0o777n) : 0o600);
    try {
      temporaryStats = await next.stat({ bigint: true });
      await next.chmod(before ? Number(before.stats.mode & 0o777n) : 0o600);
      await next.writeFile(result.text, "utf8"); await next.sync();
    } finally { await next.close(); }
    const current = await readSnapshot(file), currentParent = await lstat(parent, { bigint: true });
    if (!sameFile(parentStats, currentParent) || currentParent.isSymbolicLink()
      || (before === null) !== (current === null)
      || (before && current && (!sameFile(before.stats, current.stats) || before.sha256 !== current.sha256))) fail("settings_changed");
    await rename(temporary, file); temporary = undefined;
    return result;
  } catch (error) { return { status: "unavailable", reason: error instanceof SettingsRefusal ? error.reason : "settings_unavailable" }; }
  finally {
    if (temporary && temporaryStats) await removeOwned(temporary, temporaryStats).catch(() => undefined);
    if (lock) await lock.close().catch(() => undefined);
    if (lockStats) await removeOwned(lockPath, lockStats).catch(() => undefined);
  }
}
