import { createHash, randomBytes } from "node:crypto";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { CodingHookStore } from "./store";

export type OwnerLeaseNamespace = "coding-hooks" | "prompt-comparisons";
export const OWNER_LEASE_LIMITS = Object.freeze({ firstPort: 40000, ports: 10000, acquireMs: 500, releaseMs: 500 });
export class CodingHookOwnerRefusal extends Error { constructor(readonly reason: "invalid_owner_path" | "occupied" | "deadline" | "aborted" | "unavailable") { super(reason); } }
export interface CodingHookOwnerLease { readonly databasePath: string; readonly port: number; readonly birth: string; isActive(): boolean; release(): Promise<void>; }

function ownerPath(value: string): { file: string; stat: Stats; parent: Stats } {
  try {
    if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value || value.includes("\0") || Buffer.byteLength(value) > 4096) throw new Error();
    const file = realpathSync(value), stat = lstatSync(file), parent = lstatSync(path.dirname(file));
    if (file !== value || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !parent.isDirectory() || parent.isSymbolicLink()) throw new Error();
    return { file, stat, parent };
  } catch { throw new CodingHookOwnerRefusal("invalid_owner_path"); }
}
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
/** A collision refuses ownership; this port is never a discovery or HTTP endpoint. */
export function codingHookOwnerPort(databasePath: string, namespace: OwnerLeaseNamespace = "coding-hooks"): number {
  if (namespace !== "coding-hooks" && namespace !== "prompt-comparisons") throw new CodingHookOwnerRefusal("invalid_owner_path");
  const { file } = ownerPath(databasePath);
  const domain = namespace === "coding-hooks" ? "runphantom.coding-hook-owner/v1\0" : "runphantom.prompt-comparison-owner/v1\0";
  return OWNER_LEASE_LIMITS.firstPort + createHash("sha256").update(domain + file).digest().readUInt32BE(0) % OWNER_LEASE_LIMITS.ports;
}
export async function acquireCodingHookOwner(databasePath: string, signal?: AbortSignal, namespace: OwnerLeaseNamespace = "coding-hooks"): Promise<CodingHookOwnerLease> {
  const before = ownerPath(databasePath), port = codingHookOwnerPort(before.file, namespace);
  if (signal?.aborted) throw new CodingHookOwnerRefusal("aborted");
  const server = createServer(socket => { socket.on("error", () => {}); socket.destroy(); }); server.maxConnections = 1;
  let active = false, releasing: Promise<void> | undefined;
  const release = (): Promise<void> => {
    active = false;
    if (releasing) return releasing;
    releasing = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CodingHookOwnerRefusal("deadline")), OWNER_LEASE_LIMITS.releaseMs);
      server.close(error => { clearTimeout(timer); if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(new CodingHookOwnerRefusal("unavailable")); else resolve(); });
    });
    return releasing;
  };
  // A listener error invalidates authority immediately, including after acquisition.
  server.on("error", () => { active = false; }); server.on("close", () => { active = false; });
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: CodingHookOwnerRefusal) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", aborted); server.removeListener("error", failed); server.removeListener("listening", listening);
        if (error) reject(error); else resolve();
      };
      const failed = (error: NodeJS.ErrnoException) => finish(new CodingHookOwnerRefusal(error.code === "EADDRINUSE" ? "occupied" : "unavailable"));
      const aborted = () => finish(new CodingHookOwnerRefusal("aborted"));
      const listening = () => finish();
      const timer = setTimeout(() => finish(new CodingHookOwnerRefusal("deadline")), OWNER_LEASE_LIMITS.acquireMs);
      signal?.addEventListener("abort", aborted, { once: true }); server.once("error", failed); server.once("listening", listening);
      try { server.listen({ host: "127.0.0.1", port, exclusive: true, reusePort: false, backlog: 1 }); } catch { finish(new CodingHookOwnerRefusal("unavailable")); }
    });
    const after = ownerPath(databasePath);
    if (signal?.aborted) throw new CodingHookOwnerRefusal("aborted");
    if (!same(before.stat, after.stat) || !same(before.parent, after.parent) || !server.listening) throw new CodingHookOwnerRefusal("invalid_owner_path");
    active = true;
    return Object.freeze({ databasePath: before.file, port, birth: randomBytes(16).toString("hex"), isActive: () => {
      if (!active || !server.listening) return false;
      if (namespace === "coding-hooks") return true;
      try { const current = ownerPath(databasePath); return same(before.stat, current.stat) && same(before.parent, current.parent); }
      catch { return false; }
    }, release });
  } catch (error) { await release(); throw error; }
}

/** The migrated owner connection is supplied by trusted startup, never selected by callback input. */
export async function startCodingHookOwner(db: Database, signal?: AbortSignal): Promise<{ store: CodingHookStore; lease: CodingHookOwnerLease; close(): Promise<void> }> {
  const lease = await acquireCodingHookOwner(db.filename, signal);
  try {
    const store = new CodingHookStore(db, {}, () => lease.isActive()); store.beginOwner();
    return Object.freeze({ store, lease, close: () => lease.release() });
  } catch (error) { await lease.release(); throw error; }
}
