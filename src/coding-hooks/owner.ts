import { randomBytes } from "node:crypto";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { CodingHookStore } from "./store";

export type OwnerLeaseNamespace = "coding-hooks" | "prompt-comparisons";
export class CodingHookOwnerRefusal extends Error { constructor(readonly reason: "invalid_owner_path" | "occupied" | "deadline" | "aborted" | "unavailable") { super(reason); } }
export interface CodingHookOwnerLease { readonly databasePath: string; readonly lockPath: string; readonly birth: string; isActive(): boolean; release(): Promise<void>; }

function ownerPath(value: string): { file: string; stat: Stats; parent: Stats } {
  try {
    if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value || value.includes("\0") || Buffer.byteLength(value) > 4096) throw new Error();
    const file = realpathSync(value), stat = lstatSync(file), parent = lstatSync(path.dirname(file));
    if (file !== value || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !parent.isDirectory() || parent.isSymbolicLink()) throw new Error();
    return { file, stat, parent };
  } catch { throw new CodingHookOwnerRefusal("invalid_owner_path"); }
}
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
const lockFile = (stat: Stats) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
/**
 * The lease is an exclusive SQLite lock held for the owner's lifetime on a sidecar of the database, so the
 * kernel releases it when the process dies. A hashed loopback port was used before; every profile on the host
 * shared one port range, so an unrelated daemon or socket on a colliding port refused ownership as "occupied".
 */
export function codingHookOwnerLockPath(databasePath: string, namespace: OwnerLeaseNamespace = "coding-hooks"): string {
  if (namespace !== "coding-hooks" && namespace !== "prompt-comparisons") throw new CodingHookOwnerRefusal("invalid_owner_path");
  return ownerPath(databasePath).file + (namespace === "coding-hooks" ? ".hook-owner.lock" : ".comparison-owner.lock");
}
export async function acquireCodingHookOwner(databasePath: string, signal?: AbortSignal, namespace: OwnerLeaseNamespace = "coding-hooks"): Promise<CodingHookOwnerLease> {
  const before = ownerPath(databasePath), lockPath = codingHookOwnerLockPath(before.file, namespace);
  if (signal?.aborted) throw new CodingHookOwnerRefusal("aborted");
  const existing = (() => { try { return lstatSync(lockPath); } catch { return null; } })();
  if (existing && !lockFile(existing)) throw new CodingHookOwnerRefusal("invalid_owner_path");
  let lock: Database;
  try { lock = new Database(lockPath, { create: true, readwrite: true }); } catch { throw new CodingHookOwnerRefusal("unavailable"); }
  let active = false, releasing: Promise<void> | undefined, held: Stats | undefined;
  const release = (): Promise<void> => {
    active = false;
    if (releasing) return releasing;
    releasing = new Promise<void>((resolve, reject) => { try { lock.close(); resolve(); } catch { reject(new CodingHookOwnerRefusal("unavailable")); } });
    return releasing;
  };
  try {
    try { lock.exec("PRAGMA busy_timeout=0"); lock.exec("BEGIN EXCLUSIVE"); }
    catch (error) { throw new CodingHookOwnerRefusal((error as { code?: string }).code === "SQLITE_BUSY" ? "occupied" : "unavailable"); }
    held = lstatSync(lockPath);
    if (!lockFile(held)) throw new CodingHookOwnerRefusal("invalid_owner_path");
    await new Promise<void>(resolve => setImmediate(resolve));
    const after = ownerPath(databasePath);
    if (signal?.aborted) throw new CodingHookOwnerRefusal("aborted");
    if (!same(before.stat, after.stat) || !same(before.parent, after.parent)) throw new CodingHookOwnerRefusal("invalid_owner_path");
    active = true;
    const heldLock = held;
    return Object.freeze({ databasePath: before.file, lockPath, birth: randomBytes(16).toString("hex"), isActive: () => {
      if (!active) return false;
      try {
        // A replaced lock file would let a second owner lock the new inode, so authority ends with the held one.
        if (!same(heldLock, lstatSync(lockPath))) return false;
        if (namespace === "coding-hooks") return true;
        const current = ownerPath(databasePath); return same(before.stat, current.stat) && same(before.parent, current.parent);
      } catch { return false; }
    }, release });
  } catch (error) { await release(); throw error; }
}

/** The migrated owner connection is supplied by trusted startup, never selected by callback input. */
export async function startCodingHookOwner(db: Database, signal?: AbortSignal, options: { contextTransport: boolean } = { contextTransport: false }): Promise<{ store: CodingHookStore; lease: CodingHookOwnerLease; revoke(): void; close(): Promise<void> }> {
  const lease = await acquireCodingHookOwner(db.filename, signal);
  try {
    let active = true;
    const store = new CodingHookStore(db, {}, () => active && lease.isActive(), options); store.beginOwner();
    return Object.freeze({ store, lease, revoke: () => { active = false; }, close: () => { active = false; return lease.release(); } });
  } catch (error) { await lease.release(); throw error; }
}
