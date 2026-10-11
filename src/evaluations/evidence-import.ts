import type { IncomingMessage } from "node:http";
import { EVIDENCE_LIMITS as L, EvidenceError, type EvidenceImportRequest } from "./evidence-protocol";
import { evidenceDigest, evidenceObject, parseEvidenceImportRequest } from "./evidence-validation";
import { strictEvidenceJson } from "./evidence-reader/json";
import { readerLimits } from "./evidence-reader/limits";

export const EVIDENCE_IMPORT_CONTENT_TYPE = "application/vnd.runphantom.evidence-import.v1+octet-stream";
export const EVIDENCE_HEADER_BYTES = 64 * 1024;
export const EVIDENCE_FRAME_BYTES = 4 + EVIDENCE_HEADER_BYTES + L.MAX_IMPORT_BYTES;
export class EvidenceUploadError extends EvidenceError {
  constructor(public readonly code: "upload_aborted" | "upload_timeout" | "source_integrity", status: 400 | 409 | 413 = 400) {
    super(code === "upload_timeout" ? "Evidence upload deadline exceeded" : code === "upload_aborted" ? "Evidence upload was interrupted" : "Evidence frame does not match its declared source bytes", status);
  }
}
export interface EvidenceCapturedSource { sourceId: string; bytes: Uint8Array }
export interface EvidenceFrame<T> { request: EvidenceImportRequest; admission: T; sources: EvidenceCapturedSource[]; acquiredBytes: number; acquisitionMs: number }
export interface EvidenceFrameOptions { signal?: AbortSignal; deadlineAt?: number }

/** A paused HTTP reader. No flowing data listener or eager JSON middleware may precede this endpoint. */
class FrameCursor {
  bytes = 0;
  readonly #request: IncomingMessage;
  readonly #signal: AbortSignal;
  constructor(request: IncomingMessage, signal: AbortSignal) { this.#request = request; this.#signal = signal; }
  #check(): void {
    if (this.#signal.aborted) throw new EvidenceUploadError(this.#signal.reason === "upload_timeout" ? "upload_timeout" : "upload_aborted", 409);
    if (this.#request.aborted || this.#request.destroyed && !this.#request.complete) throw new EvidenceUploadError("upload_aborted");
  }
  async #available(): Promise<void> {
    this.#check();
    if (this.#request.readableEnded) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        this.#request.off("readable", ready); this.#request.off("end", ready); this.#request.off("aborted", aborted); this.#request.off("error", aborted);
        this.#signal.removeEventListener("abort", stopped);
        if (error) reject(error); else resolve();
      };
      const ready = () => finish();
      const aborted = () => finish(new EvidenceUploadError("upload_aborted"));
      const stopped = () => finish(new EvidenceUploadError(this.#signal.reason === "upload_timeout" ? "upload_timeout" : "upload_aborted", 409));
      this.#request.once("readable", ready); this.#request.once("end", ready); this.#request.once("aborted", aborted); this.#request.once("error", aborted);
      this.#signal.addEventListener("abort", stopped, { once: true });
      if (this.#signal.aborted) stopped();
      else if (this.#request.readableEnded) ready();
    });
  }
  async exact(length: number): Promise<Uint8Array> {
    // Length has already passed the metadata/source cap before this allocation.
    const result = new Uint8Array(length); let offset = 0;
    while (offset < length) {
      this.#check();
      const chunk: Buffer | null = this.#request.read(Math.min(length - offset, Math.max(1, this.#request.readableLength), 16 * 1024));
      if (chunk === null) {
        if (this.#request.readableEnded) throw new EvidenceUploadError("source_integrity");
        await this.#available(); continue;
      }
      if (chunk.byteLength > length - offset || this.bytes + chunk.byteLength > EVIDENCE_FRAME_BYTES) throw new EvidenceUploadError("source_integrity", 413);
      result.set(chunk, offset); offset += chunk.byteLength; this.bytes += chunk.byteLength;
    }
    return result;
  }
  async end(): Promise<void> {
    for (;;) {
      this.#check();
      const extra: Buffer | null = this.#request.read(1);
      if (extra !== null) throw new EvidenceUploadError("source_integrity", 413);
      if (this.#request.readableEnded) return;
      await this.#available();
    }
  }
}

/** Metadata authority/admission runs before any source allocation; it must not perform async work inside a DB transaction. */
export async function readEvidenceImportFrame<T>(request: IncomingMessage, admit: (request: EvidenceImportRequest) => T,
  options: EvidenceFrameOptions & { beforeSources?: (admission: T, signal: AbortSignal) => Promise<void> } = {}): Promise<EvidenceFrame<T>> {
  const started = performance.now(), deadline = options.deadlineAt ?? started + L.MAX_IMPORT_MS;
  if (!Number.isFinite(deadline) || deadline > started + L.MAX_IMPORT_MS) throw new EvidenceError("Evidence upload deadline cannot exceed the fixed budget");
  if (request.headers["content-type"] !== EVIDENCE_IMPORT_CONTENT_TYPE || request.headers["content-encoding"] !== undefined && request.headers["content-encoding"] !== "identity") throw new EvidenceError("Evidence imports require the versioned identity binary transport");
  const lengthHeader = request.headers["content-length"];
  if (lengthHeader !== undefined && (typeof lengthHeader !== "string" || !/^(0|[1-9][0-9]*)$/.test(lengthHeader) || !Number.isSafeInteger(Number(lengthHeader)) || Number(lengthHeader) > EVIDENCE_FRAME_BYTES)) throw new EvidenceUploadError("source_integrity", 413);
  const controller = new AbortController();
  const externalAbort = () => controller.abort("upload_aborted");
  options.signal?.addEventListener("abort", externalAbort, { once: true });
  if (options.signal?.aborted) externalAbort();
  const timeout = setTimeout(() => controller.abort("upload_timeout"), Math.max(0, deadline - performance.now()));
  const cursor = new FrameCursor(request, controller.signal);
  try {
    const prefix = await cursor.exact(4), metadataBytes = new DataView(prefix.buffer).getUint32(0, false);
    if (metadataBytes < 1 || metadataBytes > EVIDENCE_HEADER_BYTES) throw new EvidenceUploadError("source_integrity", 413);
    const metadata = await cursor.exact(metadataBytes);
    let raw: unknown;
    try { raw = strictEvidenceJson(new TextDecoder("utf-8", { fatal: true }).decode(metadata), readerLimits({ maxDepth: 16 })); }
    catch { throw new EvidenceError("Evidence metadata requires strict bounded UTF-8 JSON"); }
    const header = evidenceObject(raw, ["version", "request"], "evidence frame metadata");
    if (header.version !== 1) throw new EvidenceError("Unsupported evidence frame version");
    const parsed = parseEvidenceImportRequest(header.request);
    const expectedLength = 4 + metadataBytes + parsed.sources.reduce((sum, source) => sum + source.byteLength, 0);
    if (lengthHeader !== undefined && Number(lengthHeader) !== expectedLength) throw new EvidenceUploadError("source_integrity");
    const admission = admit(parsed);
    if (options.beforeSources) await options.beforeSources(admission, controller.signal);
    const sources: EvidenceCapturedSource[] = [];
    for (const source of parsed.sources) {
      const bytes = await cursor.exact(source.byteLength);
      if (evidenceDigest(bytes) !== source.artifactSha256) throw new EvidenceUploadError("source_integrity");
      sources.push({ sourceId: source.sourceId, bytes });
    }
    await cursor.end();
    return { request: parsed, admission, sources, acquiredBytes: cursor.bytes, acquisitionMs: performance.now() - started };
  } finally {
    clearTimeout(timeout); options.signal?.removeEventListener("abort", externalAbort);
  }
}
