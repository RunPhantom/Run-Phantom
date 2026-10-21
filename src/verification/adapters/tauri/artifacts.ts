import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TAURI_LIMITS as L, TauriError } from "./contract";

export interface TauriCapture { id: string; sha256: string; bytes: number; width: number; height: number; generation: number; mode: "private-raw"; source: "owned-tauri-window" }
interface OwnedCapture { meta: TauriCapture; dev: number; ino: number }
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
/** A new private directory, never an imported manifest or a caller-selected file. */
export class TauriArtifactStore {
  readonly #owned = new Map<string, OwnedCapture>();
  readonly #identity: { dev: number; ino: number };
  #closed = false;
  constructor(readonly root: string) {
    try {
      if (!path.isAbsolute(root) || path.resolve(root) !== root || realpathSync(path.dirname(root)) !== path.dirname(root)) throw new TauriError("denied");
      mkdirSync(root, { mode: 0o700 });
    } catch { throw new TauriError("denied"); }
    const stat = lstatSync(root); this.#identity = { dev: stat.dev, ino: stat.ino };
    if (stat.mode & 0o077 || !stat.isDirectory()) throw new TauriError("denied");
  }
  #directory(): void {
    try {
      const stat = lstatSync(this.root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== this.#identity.dev || stat.ino !== this.#identity.ino || stat.mode & 0o077) throw new TauriError("cleanup-unconfirmed");
    } catch { throw new TauriError("cleanup-unconfirmed"); }
  }
  #file(id: string): string { return path.join(this.root, `${id}.png`); }
  admit(input: Uint8Array, generation: number): TauriCapture {
    if (this.#closed) throw new TauriError("closed");
    this.#directory();
    if (!(input instanceof Uint8Array) || input.byteLength > L.pngBytes) throw new TauriError("invalid-reply");
    const bytes = Buffer.from(input);
    if (bytes.length < 45 || bytes.length > L.pngBytes || !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
      || bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString("ascii") !== "IHDR" || bytes.subarray(-8, -4).toString("ascii") !== "IEND") throw new TauriError("invalid-reply");
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (width < 1 || width > L.width || height < 1 || height > L.height || !Number.isSafeInteger(generation) || generation < 0) throw new TauriError("invalid-reply");
    if (this.#owned.size >= L.artifacts || [...this.#owned.values()].reduce((sum, item) => sum + item.meta.bytes, 0) + bytes.length > L.totalBytes) throw new TauriError("capacity");
    const id = randomUUID(), file = this.#file(id);
    const meta: TauriCapture = { id, sha256: digest(bytes), bytes: bytes.length, width, height, generation, mode: "private-raw", source: "owned-tauri-window" };
    let fd: number | undefined;
    try {
      fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const stat = fstatSync(fd);
      // Record ownership before writing so a partial I/O failure remains eligible for owned cleanup.
      this.#owned.set(id, { meta, dev: stat.dev, ino: stat.ino }); writeFileSync(fd, bytes); return { ...meta };
    } catch { throw new TauriError("unavailable"); } finally { if (fd !== undefined) closeSync(fd); }
  }
  readPrivate(id: string, consent: true): Uint8Array {
    if (consent !== true) throw new TauriError("denied");
    this.#directory(); const owned = this.#owned.get(id);
    if (!owned) throw new TauriError("unavailable");
    let fd: number | undefined;
    try {
      fd = openSync(this.#file(id), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.dev !== owned.dev || stat.ino !== owned.ino || stat.nlink !== 1 || stat.mode & 0o077 || stat.size !== owned.meta.bytes) throw new TauriError("unavailable");
      const buffer = Buffer.alloc(owned.meta.bytes + 1); let size = 0, chunk = 0;
      while (size < buffer.length && (chunk = readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += chunk;
      const bytes = buffer.subarray(0, size);
      if (bytes.length !== owned.meta.bytes || digest(bytes) !== owned.meta.sha256) throw new TauriError("unavailable");
      return bytes;
    } catch { throw new TauriError("unavailable"); } finally { if (fd !== undefined) closeSync(fd); }
  }
  close(): boolean {
    this.#closed = true;
    try {
      this.#directory();
      for (const [id, owned] of this.#owned) {
        const file = this.#file(id); let stat;
        try { stat = lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.#owned.delete(id); continue; } throw error; }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.dev !== owned.dev || stat.ino !== owned.ino) continue;
        unlinkSync(file); this.#owned.delete(id);
      }
      if (this.#owned.size || readdirSync(this.root).length) return false;
      rmdirSync(this.root); return true;
    } catch { return false; }
  }
}
