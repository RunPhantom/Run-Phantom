import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { parseBoundedHookJson } from "./shared";

export const CAPABILITY_VERSION = "runphantom.claude-capability/v2";
export const CAPABILITY_LIMITS = Object.freeze({ bytes: 16384, acquisitionMs: 250, ancestors: 64 });
export interface ClaudeCapabilityDescriptor { version: typeof CAPABILITY_VERSION; installationId: string; capabilityFile: string; ownerKey: string; state: "active" | "disabled"; token: string | null; ownerGeneration: string | null; installationGeneration: string | null; origin: string | null; }
export class ClaudeCapabilityRefusal extends Error { constructor(readonly reason: "unauthorized" | "corrupt" | "unavailable" | "deadline" | "aborted") { super(reason); } }
function fail(reason: ClaudeCapabilityRefusal["reason"]): never { throw new ClaudeCapabilityRefusal(reason); }
const hex = (value: unknown, length: number) => typeof value === "string" && value.length === length && /^[a-f0-9]+$/.test(value);
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
const owned = (value: BigIntStats) => process.platform !== "win32" && typeof process.getuid === "function" && value.uid === BigInt(process.getuid());
export const capabilityOwnerKey = (canonicalDatabasePath: string): string => createHash("sha256").update("runphantom.claude-capability-owner/v1\0" + canonicalDatabasePath).digest("hex");
export function validClaudeCapabilityPath(value: unknown): value is string { return typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value && !value.includes("\0") && Buffer.byteLength(value) <= 4096; }
export function validClaudeCapabilityOrigin(value: unknown): value is string {
  if (typeof value !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value)) return false;
  return Number(value.slice(value.lastIndexOf(":") + 1)) <= 65535;
}
export function encodeClaudeCapability(value: ClaudeCapabilityDescriptor): string {
  const raw = JSON.stringify(value); validateDescriptor(raw, value.capabilityFile, value.installationId, value.ownerKey); return raw + "\n";
}
function validateDescriptor(raw: string, file: string, id: string, expectedOwnerKey?: string): ClaudeCapabilityDescriptor {
  const parsed = parseBoundedHookJson(raw, CAPABILITY_LIMITS.bytes);
  if (parsed.status !== "accepted" || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) fail("corrupt");
  const value = parsed.value;
  if (Object.keys(value).sort().join(",") !== "capabilityFile,installationGeneration,installationId,origin,ownerGeneration,ownerKey,state,token,version" || value.version !== CAPABILITY_VERSION
    || value.capabilityFile !== file || value.installationId !== id || !hex(id, 32) || !validClaudeCapabilityPath(file) || !hex(value.ownerKey, 64) || expectedOwnerKey !== undefined && value.ownerKey !== expectedOwnerKey) fail("corrupt");
  if (value.state === "active" ? !hex(value.token, 64) || !hex(value.ownerGeneration, 32) || !hex(value.installationGeneration, 32) || !validClaudeCapabilityOrigin(value.origin)
    : value.state !== "disabled" || value.token !== null || value.ownerGeneration !== null || value.installationGeneration !== null || value.origin !== null) fail("corrupt");
  return value as unknown as ClaudeCapabilityDescriptor;
}

/** Reads only the installed private path; no ambient profile lookup or remote fallback. */
export async function readClaudeCapabilityDescriptor(file: string, installationId: string, expectedOwnerKey?: string, signal?: AbortSignal): Promise<ClaudeCapabilityDescriptor> {
  if (!validClaudeCapabilityPath(file) || !hex(installationId, 32) || expectedOwnerKey !== undefined && !hex(expectedOwnerKey, 64)) fail("unauthorized");
  const controller = new AbortController(); let timedOut = false;
  const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  const check = () => { if (controller.signal.aborted) fail(timedOut ? "deadline" : "aborted"); };
  let timeout: ReturnType<typeof setTimeout>, rejectAbort: () => void;
  const expiration = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new ClaudeCapabilityRefusal(timedOut ? "deadline" : "aborted")); controller.signal.addEventListener("abort", rejectAbort, { once: true });
    timeout = setTimeout(() => { timedOut = true; controller.abort(); }, CAPABILITY_LIMITS.acquisitionMs);
  });
  const acquire = async () => {
    check(); const ancestors: { file: string; stat: BigIntStats }[] = []; let directory = path.dirname(file);
    for (;;) {
      if (ancestors.length >= CAPABILITY_LIMITS.ancestors) fail("unauthorized");
      const stat = await lstat(directory, { bigint: true }); check();
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unauthorized");
      ancestors.push({ file: directory, stat }); const next = path.dirname(directory); if (next === directory) break; directory = next;
    }
    const parent = ancestors[0].stat;
    if (!owned(parent) || (parent.mode & 0o777n) !== 0o700n || await realpath(file) !== file) fail("unauthorized"); check();
    const before = await lstat(file, { bigint: true }); check();
    const privateFile = (stat: BigIntStats) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && owned(stat) && (stat.mode & 0o777n) === 0o600n && stat.size <= BigInt(CAPABILITY_LIMITS.bytes);
    if (!privateFile(before)) fail("unauthorized");
    if (constants.O_NOFOLLOW === undefined) fail("unavailable");
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    try {
      check(); const initial = await handle.stat({ bigint: true }); check(); if (!same(initial, before) || !privateFile(initial)) fail("unauthorized");
      const bytes = Buffer.alloc(Number(initial.size)); let offset = 0;
      while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); check(); if (!result.bytesRead) fail("unavailable"); offset += result.bytesRead; }
      const after = await handle.stat({ bigint: true }), current = await lstat(file, { bigint: true }); check();
      if (!privateFile(after) || !privateFile(current) || !same(initial, after) || !same(initial, current) || after.size !== initial.size || current.size !== initial.size || after.mtimeNs !== initial.mtimeNs || after.ctimeNs !== initial.ctimeNs || current.mtimeNs !== initial.mtimeNs || current.ctimeNs !== initial.ctimeNs) fail("unavailable");
      for (const ancestor of ancestors) { const current = await lstat(ancestor.file, { bigint: true }); check(); if (!same(ancestor.stat, current) || current.isSymbolicLink() || current.mode !== ancestor.stat.mode || current.uid !== ancestor.stat.uid) fail("unavailable"); }
      if (await realpath(file) !== file) fail("unavailable"); check();
      let raw: string; try { raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail("corrupt"); }
      return validateDescriptor(raw, file, installationId, expectedOwnerKey);
    } finally { await handle.close(); }
  };
  try { return await Promise.race([acquire(), expiration]); }
  catch (error) { if (error instanceof ClaudeCapabilityRefusal) throw error; return fail("unavailable"); }
  finally { clearTimeout(timeout!); signal?.removeEventListener("abort", abort); controller.signal.removeEventListener("abort", rejectAbort!); controller.abort(); }
}
