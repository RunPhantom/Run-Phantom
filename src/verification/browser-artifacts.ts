import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ARTIFACT_ID, BROWSER_LIMITS as L, BrowserInputError, browserObject, browserEngine, browserGeneration, browserText } from "./browser-contract";

export type { BrowserArtifact } from "./browser-types";
import type { BrowserArtifact } from "./browser-types";
export type ArtifactInput = Pick<BrowserArtifact, "kind" | "raw" | "engine" | "ownership" | "generation"> & { maskScope?: BrowserArtifact["maskScope"]; rawConsent?: true };
const unavailable = (): never => { throw new BrowserInputError(409, "Browser artifact is unavailable or corrupt"); };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function artifactId(value: unknown): string { const id = browserText(value, 36); if (!ARTIFACT_ID.test(id)) throw new BrowserInputError(400, "Invalid artifact ID"); return id; }
function parseMeta(value: unknown): BrowserArtifact {
  const b = browserObject(value, ["id", "kind", "mime", "bytes", "sha256", "capturedAt", "raw", "maskScope", "engine", "ownership", "generation", "width", "height"]);
  if (!["screenshot", "video"].includes(b.kind as string) || typeof b.raw !== "boolean" || !["none", "inputs-editable-private-known-secrets"].includes(b.maskScope as string)
    || !["owned", "attached"].includes(b.ownership as string) || !Number.isSafeInteger(b.bytes) || (b.bytes as number) <= 0
    || !Number.isSafeInteger(b.capturedAt) || (b.capturedAt as number) < 0 || typeof b.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(b.sha256)) unavailable();
  if (b.kind === "screenshot" && (b.mime !== "image/png" || (b.bytes as number) > L.PNG_BYTES || !Number.isSafeInteger(b.width) || (b.width as number) < 1 || (b.width as number) > L.WIDTH || !Number.isSafeInteger(b.height) || (b.height as number) < 1 || (b.height as number) > L.HEIGHT)) unavailable();
  if (b.kind === "video" && (b.mime !== "video/webm" || !b.raw || b.maskScope !== "none" || (b.bytes as number) > L.VIDEO_BYTES || b.width !== undefined || b.height !== undefined || b.ownership !== "owned")) unavailable();
  if (b.raw && b.maskScope !== "none" || !b.raw && b.maskScope !== "inputs-editable-private-known-secrets") unavailable();
  return { id: artifactId(b.id), kind: b.kind as BrowserArtifact["kind"], mime: b.mime as BrowserArtifact["mime"], bytes: b.bytes as number, sha256: b.sha256 as string,
    capturedAt: b.capturedAt as number, raw: b.raw as boolean, maskScope: b.maskScope as BrowserArtifact["maskScope"], engine: browserEngine(b.engine), ownership: b.ownership as BrowserArtifact["ownership"], generation: browserGeneration(b.generation),
    ...(b.kind === "screenshot" ? { width: b.width as number, height: b.height as number } : {}) };
}

/** Private files carry inert content identity, never a restored page or worker authority. */
export class BrowserArtifactStore {
  constructor(readonly root: string) {
    if (!path.isAbsolute(root)) throw new BrowserInputError(503, "Private artifact directory is unavailable");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.mode & 0o077) throw new BrowserInputError(503, "Private artifact directory must be restricted to its owner");
  }
  #file(meta: BrowserArtifact): string { return path.join(this.root, `${meta.id}.${meta.kind === "screenshot" ? "png" : "webm"}`); }
  #readFile(file: string, max: number): Buffer {
    let fd: number | undefined;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > max || stat.mode & 0o077) unavailable();
      const bytes = Buffer.alloc(stat.size + 1); let size = 0, chunk = 0;
      while ((chunk = readSync(fd, bytes, size, bytes.length - size, null)) > 0) { size += chunk; if (size > stat.size) unavailable(); }
      return bytes.subarray(0, size);
    } catch { return unavailable(); } finally { if (fd !== undefined) closeSync(fd); }
  }
  #load(): BrowserArtifact[] {
    const file = path.join(this.root, "manifest.json");
    if (!existsSync(file)) return [];
    try {
      const b = browserObject(JSON.parse(this.#readFile(file, 128 * 1024).toString("utf8")), ["formatVersion", "artifacts"]);
      if (b.formatVersion !== 1 || !Array.isArray(b.artifacts) || b.artifacts.length > L.ARTIFACTS) unavailable();
      const metas = (b.artifacts as unknown[]).map(parseMeta);
      if (new Set(metas.map(meta => meta.id)).size !== metas.length || metas.reduce((n, meta) => n + meta.bytes, 0) > L.ARTIFACT_BYTES) unavailable();
      return metas;
    } catch { return unavailable(); }
  }
  #mutate<T>(operation: (metas: BrowserArtifact[]) => { metas: BrowserArtifact[]; result: T }): T {
    const lock = path.join(this.root, "manifest.lock"); let fd: number;
    try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch { throw new BrowserInputError(409, "Browser artifact storage is busy; retained data was not replaced"); }
    const temp = path.join(this.root, `${randomUUID()}.manifest.tmp`);
    try {
      const change = operation(this.#load());
      writeFileSync(temp, JSON.stringify({ formatVersion: 1, artifacts: change.metas }), { mode: 0o600, flag: "wx" });
      renameSync(temp, path.join(this.root, "manifest.json")); return change.result;
    } finally { closeSync(fd); unlinkSync(lock); if (existsSync(temp)) unlinkSync(temp); }
  }
  list(): BrowserArtifact[] { return this.#load(); }
  metadata(value: unknown): BrowserArtifact & { availability: "available" | "unavailable" } {
    const id = artifactId(value), meta = this.#load().find(meta => meta.id === id);
    if (!meta) throw new BrowserInputError(404, "Browser artifact not found");
    try { this.read(id); return { ...meta, availability: "available" }; } catch { return { ...meta, availability: "unavailable" }; }
  }
  read(value: unknown): Buffer {
    const id = artifactId(value), meta = this.#load().find(meta => meta.id === id);
    if (!meta) throw new BrowserInputError(404, "Browser artifact not found");
    const bytes = this.#readFile(this.#file(meta), meta.bytes);
    if (bytes.length !== meta.bytes || hash(bytes) !== meta.sha256) unavailable(); return bytes;
  }
  admit(bytes: Buffer, input: ArtifactInput): BrowserArtifact {
    if (input.raw && input.rawConsent !== true || input.kind === "video" && (!input.raw || input.ownership !== "owned")) throw new BrowserInputError(400, "Private raw capture requires explicit consent");
    const maskScope = input.maskScope ?? (input.kind === "video" ? "none" : "inputs-editable-private-known-secrets");
    const mime = input.kind === "screenshot" ? "image/png" as const : "video/webm" as const;
    let dimensions: { width: number; height: number } | undefined;
    if (input.kind === "screenshot") {
      if (bytes.length < 45 || bytes.length > L.PNG_BYTES || !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) || bytes.subarray(12, 16).toString("ascii") !== "IHDR") unavailable();
      dimensions = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    } else if (bytes.length < 4 || bytes.length > L.VIDEO_BYTES || !bytes.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex"))) unavailable();
    const meta = parseMeta({ id: randomUUID(), kind: input.kind, raw: input.raw, engine: input.engine, ownership: input.ownership, generation: input.generation,
      maskScope, mime, bytes: bytes.length, sha256: hash(bytes), capturedAt: Date.now(), ...dimensions });
    return this.#mutate(metas => {
      if (metas.length >= L.ARTIFACTS || metas.reduce((n, m) => n + m.bytes, 0) + meta.bytes > L.ARTIFACT_BYTES) throw new BrowserInputError(409, "Browser artifact capacity reached; delete an artifact first");
      writeFileSync(this.#file(meta), bytes, { mode: 0o600, flag: "wx" });
      return { metas: [...metas, meta], result: meta };
    });
  }
  delete(value: unknown): void {
    const id = artifactId(value);
    this.#mutate(metas => {
      const meta = metas.find(meta => meta.id === id); if (!meta) throw new BrowserInputError(404, "Browser artifact not found");
      const file = this.#file(meta); if (existsSync(file)) unlinkSync(file);
      return { metas: metas.filter(meta => meta.id !== id), result: undefined };
    });
  }
}
