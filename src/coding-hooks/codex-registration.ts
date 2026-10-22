import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { parseBoundedHookJson, type HookJson } from "./shared";
import { CODEX_EVENTS, codexObject } from "./codex";

export interface CodexRegistration { version: 1; id: string; enabled: boolean; workspace: string; sessionsRoot: string; port: number; command: string; }
const same = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.size === b.size;
export const missing = (e: unknown): boolean => e instanceof Error && "code" in e && e.code === "ENOENT";
export function fail(reason: string): never { throw new Error(reason); }
export const stateRoot = (home: string): string => path.join(home, ".runphantom", "codex-hooks");
export const canonicalPath = (s: unknown): s is string => typeof s === "string" && path.isAbsolute(s) && path.normalize(s) === s && !/[\0\r\n]/.test(s) && Buffer.byteLength(s) <= 4096;

export async function privateDirectory(dir: string): Promise<void> {
  if (process.platform === "win32" || typeof process.getuid !== "function") fail("private_filesystem_profile_unavailable");
  const s = await lstat(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid!() || (s.mode & 0o077) !== 0 || await realpath(dir) !== dir) fail("private_directory_required");
}
export async function readRegular(file: string, cap: number, privateFile: boolean): Promise<string> {
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(cap) || privateFile && (before.uid !== BigInt(process.getuid!()) || (before.mode & 0o077n) !== 0n)) fail("private_regular_file_required");
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const start = await fd.stat({ bigint: true });
    if (!same(before, start)) fail("source_changed");
    const bytes = Buffer.alloc(Number(start.size));
    for (let offset = 0; offset < bytes.length;) {
      const read = await fd.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) fail("source_changed");
      offset += read.bytesRead;
    }
    if (!same(start, await fd.stat({ bigint: true })) || !same(start, await lstat(file, { bigint: true }))) fail("source_changed");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally { await fd.close(); }
}
export function decodeRegistration(raw: string): CodexRegistration {
  const parsed = parseBoundedHookJson(raw, 16384);
  if (parsed.status !== "accepted" || !codexObject(parsed.value)) return fail("invalid_registration");
  const p = parsed.value;
  if (Object.keys(p).sort().join() !== "command,enabled,id,port,sessionsRoot,version,workspace" || p.version !== 1 || typeof p.enabled !== "boolean"
    || typeof p.id !== "string" || !/^[a-f0-9]{32}$/.test(p.id) || !canonicalPath(p.workspace) || !canonicalPath(p.sessionsRoot)
    || typeof p.port !== "number" || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535 || typeof p.command !== "string" || p.command.length > 12000) return fail("invalid_registration");
  return p as unknown as CodexRegistration;
}
function ownedGroup(reg: CodexRegistration): HookJson {
  return { hooks: [{ type: "command", command: reg.command, timeout: 2 }] };
}
export function mergeSettings(raw: string | null, reg: CodexRegistration, action: "install" | "uninstall"): { text: string; changed: boolean; count: number } {
  const parsed = parseBoundedHookJson(raw ?? "{}");
  if (parsed.status !== "accepted" || !codexObject(parsed.value)) return fail("invalid_hooks_json");
  const settings = parsed.value;
  if (settings.hooks !== undefined && !codexObject(settings.hooks)) fail("invalid_hooks_json");
  const hooks = (settings.hooks ?? {}) as Record<string, HookJson>;
  let changed = false, count = 0, handlers = 0;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) fail("invalid_hooks_json");
    for (const group of groups as HookJson[]) {
      if (!codexObject(group) || !Array.isArray(group.hooks) || group.hooks.some(h => !codexObject(h))) fail("invalid_hooks_json");
      handlers += group.hooks.length;
    }
  }
  if (handlers > 256) fail("handler_limit");
  const exact = JSON.stringify(ownedGroup(reg));
  for (const event of CODEX_EVENTS) {
    const groups = (hooks[event] ?? []) as HookJson[];
    const owned = groups.filter(g => JSON.stringify(g) === exact);
    if (owned.length > 1) fail("ambiguous_owned_hooks");
    for (const group of groups) {
      const hs = (group as Record<string, HookJson>).hooks as Record<string, HookJson>[];
      if (hs.some(h => typeof h.command === "string" && h.command.includes(reg.id)) && JSON.stringify(group) !== exact) fail("changed_owned_hook");
    }
    count += owned.length;
    if (action === "install" && !owned.length) { hooks[event] = [...groups, ownedGroup(reg)]; changed = true; }
    if (action === "uninstall" && owned.length) {
      const remaining = groups.filter(g => JSON.stringify(g) !== exact);
      if (remaining.length) hooks[event] = remaining; else delete hooks[event];
      changed = true;
    }
  }
  if (action === "install" || Object.keys(hooks).length) settings.hooks = hooks;
  else if (changed) delete settings.hooks;
  const text = changed ? JSON.stringify(settings, null, 2) + "\n" : raw ?? "{}";
  if (Buffer.byteLength(text) > 262144) fail("settings_limit");
  return { text, changed, count };
}
