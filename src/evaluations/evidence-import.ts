import type { IncomingMessage } from "node:http";
import type { Database } from "bun:sqlite";
import { EVIDENCE_LIMITS as L, EvidenceError, type EvidenceAttachment, type EvidenceImportRequest } from "./evidence-protocol";
import { evidenceDigest, evidenceInteger, evidenceObject, evidenceText, parseEvidenceImportRequest } from "./evidence-validation";
import { strictEvidenceJson } from "./evidence-reader/json";
import { readerLimits } from "./evidence-reader/limits";
import { EvidenceInventories, type EvidenceOwner } from "./evidence-inventory";
import { EvidenceSupervisor, EvidenceSupervisorError, type ReaderOperationResult } from "./evidence-supervisor";
import type { EvidenceImportFailureCode, EvidenceJob } from "./evidence-protocol";
import { canonicalEvidenceJson } from "./evidence-validation";
import { EXTERNAL_EVIDENCE_PARSER_VERSION } from "./external-evidence";

export const EVIDENCE_IMPORT_CONTENT_TYPE = "application/vnd.runphantom.evidence-import.v1+octet-stream";
export const EVIDENCE_HEADER_BYTES = 64 * 1024;
export const EVIDENCE_FRAME_BYTES = 4 + EVIDENCE_HEADER_BYTES + L.MAX_IMPORT_BYTES;
export const EVIDENCE_READER_IDENTITY = Object.freeze({ parserVersion: EXTERNAL_EVIDENCE_PARSER_VERSION, policyVersion: "redaction/v1",
  configurationSha256: evidenceDigest(canonicalEvidenceJson({ limits: readerLimits(), statement: "in-toto-statement/v1", envelope: "dsse-envelope/v1", junit: "junit-xml/v1", findings: "runphantom-findings-json/v1", policy: "redaction/v1" })) });
export class EvidenceUploadError extends EvidenceError {
  constructor(public readonly code: "upload_aborted" | "upload_timeout" | "source_integrity", status: 400 | 409 | 413 = 400) {
    super(code === "upload_timeout" ? "Evidence upload deadline exceeded" : code === "upload_aborted" ? "Evidence upload was interrupted" : "Evidence frame does not match its declared source bytes", status);
  }
}

interface ImportEntry {
  owner: EvidenceOwner; controller: AbortController; started: number; timer: ReturnType<typeof setTimeout>;
  admission?: ReturnType<EvidenceInventories["admit"]>; draft?: EvidenceImportRequest;
  active: boolean; captured: boolean; worker?: ReturnType<EvidenceSupervisor["submit"]>;
  queueMs: number;
  acquisitionWallMs: number | null; workerLifetimeWallMs: number | null; publicationWallMs: number | null;
  ready?: { resolve: () => void; reject: (error: Error) => void }; done: Promise<void>; finish: () => void;
}
export interface EvidenceOperationTimings {
  availability: "measured_in_current_daemon" | "unavailable";
  acquisitionWallMs: number | null; queueWallMs: number | null; workerLifetimeWallMs: number | null; publicationWallMs: number | null; totalOperationWallMs: number | null;
  cpuMs: null; rssBytes: null;
}
export interface EvidenceImportReceipt { job: EvidenceJob; reused: boolean; timings: EvidenceOperationTimings }
/** One coordinator and one injected supervisor per daemon, shared across every trustworthy owner. */
export class EvidenceImportService {
  readonly #supervisor: EvidenceSupervisor;
  readonly #entries = new Set<ImportEntry>();
  readonly #initialized = new WeakMap<Database, Set<string>>();
  readonly #blocked = new WeakMap<Database, Set<string>>();
  readonly #databaseIds = new WeakMap<Database, number>();
  readonly #observations = new Map<string, EvidenceOperationTimings>();
  #databaseSequence = 0;
  #active = 0;
  #closed = false;
  readonly #importMs: number;
  constructor(supervisor: EvidenceSupervisor, options: { maxImportMs?: number } = {}) {
    this.#supervisor = supervisor;
    this.#importMs = evidenceInteger(options.maxImportMs ?? L.MAX_IMPORT_MS, "import deadline", L.MAX_IMPORT_MS, 1);
  }
  get state() { return { active: this.#active, queued: [...this.#entries].filter(entry => entry.admission && !entry.active).length, acquiringMetadata: [...this.#entries].filter(entry => !entry.admission).length, closed: this.#closed }; }
  #metricKey(owner: EvidenceOwner, id: string): string {
    if (!this.#databaseIds.has(owner.database)) this.#databaseIds.set(owner.database, ++this.#databaseSequence);
    return `${this.#databaseIds.get(owner.database)}:${canonicalEvidenceJson(owner.scope)}:${id}`;
  }
  #timing(entry: ImportEntry, terminal = false): EvidenceOperationTimings {
    return { availability: "measured_in_current_daemon", acquisitionWallMs: entry.acquisitionWallMs, queueWallMs: entry.queueMs,
      workerLifetimeWallMs: entry.workerLifetimeWallMs, publicationWallMs: entry.publicationWallMs, totalOperationWallMs: terminal ? performance.now() - entry.started : null, cpuMs: null, rssBytes: null };
  }
  timings(owner: EvidenceOwner, id: string): EvidenceOperationTimings {
    owner.store.getJob(id);
    const entry = this.#find(owner, id);
    return entry ? this.#timing(entry) : this.#observations.get(this.#metricKey(owner, id)) ?? { availability: "unavailable", acquisitionWallMs: null,
      queueWallMs: null, workerLifetimeWallMs: null, publicationWallMs: null, totalOperationWallMs: null, cpuMs: null, rssBytes: null };
  }
  initialize(owner: EvidenceOwner): void {
    const key = `${owner.scope.kind}:${owner.scope.id}`, seen = this.#initialized.get(owner.database) ?? new Set<string>();
    if (seen.has(key)) return;
    // The actual database owner explicitly creates its scope; neither constructor creates tables or team scopes.
    owner.store.recoverUnfinished(); seen.add(key); this.#initialized.set(owner.database, seen);
  }
  #find(owner: EvidenceOwner, id: string): ImportEntry | undefined {
    return [...this.#entries].find(entry => entry.owner.database === owner.database && canonicalEvidenceJson(entry.owner.scope) === canonicalEvidenceJson(owner.scope) && entry.admission?.job.id === id);
  }
  #failure(entry: ImportEntry, code: EvidenceImportFailureCode): void {
    try { if (entry.admission && !entry.admission.reused) entry.owner.store.fail(entry.admission.job.id, entry.admission.publicationToken, code); }
    finally { entry.controller.abort(code); entry.worker?.cancel(); entry.ready?.reject(new EvidenceUploadError(code === "upload_timeout" ? "upload_timeout" : "upload_aborted", 409)); entry.ready = undefined; }
  }
  #release(entry: ImportEntry): void {
    if (!this.#entries.has(entry)) return;
    clearTimeout(entry.timer); this.#entries.delete(entry);
    if (entry.active) this.#active--;
    if (entry.admission && !entry.admission.reused) {
      this.#observations.set(this.#metricKey(entry.owner, entry.admission.job.id), this.#timing(entry, true));
      if (this.#observations.size > 1_000) this.#observations.delete(this.#observations.keys().next().value!);
    }
    entry.finish(); this.#pump();
  }
  #pump(): void {
    for (const entry of this.#entries) {
      if (this.#closed || this.#active >= L.MAX_ACTIVE) return;
      if (!entry.ready || entry.controller.signal.aborted) continue;
      try { if (!entry.admission!.reused && !entry.owner.store.start(entry.admission!.job.id, entry.admission!.publicationToken)) throw new EvidenceError("Evidence admission cannot start", 409); }
      catch (error) { entry.ready.reject(error instanceof EvidenceError ? error : new EvidenceError("Evidence admission cannot start", 409)); entry.ready = undefined; continue; }
      entry.active = true; this.#active++; entry.ready.resolve(); entry.ready = undefined;
    }
  }
  #wait(entry: ImportEntry, signal: AbortSignal): Promise<void> {
    if (signal.aborted || entry.controller.signal.aborted) return Promise.reject(new EvidenceUploadError("upload_timeout", 409));
    const queued = performance.now();
    return new Promise<void>((resolve, reject) => {
      const abort = () => { entry.queueMs = performance.now() - queued; entry.ready = undefined; reject(new EvidenceUploadError(signal.reason === "upload_timeout" ? "upload_timeout" : "upload_aborted", 409)); };
      signal.addEventListener("abort", abort, { once: true });
      entry.ready = { resolve: () => { entry.queueMs = performance.now() - queued; signal.removeEventListener("abort", abort); resolve(); }, reject: error => { entry.queueMs = performance.now() - queued; signal.removeEventListener("abort", abort); reject(error); } };
      this.#pump();
    });
  }
  #current(entry: ImportEntry): boolean {
    if (entry.controller.signal.aborted || !entry.admission) return false;
    try { const job = entry.owner.store.getJob(entry.admission.job.id); return job.status === "running" && job.scopeGeneration === entry.admission.job.scopeGeneration; }
    catch { return false; }
  }
  #entry(owner: EvidenceOwner): ImportEntry {
    owner.database.transaction(() => owner.authorize("import", null)).immediate();
    this.initialize(owner);
    const scopeKey = canonicalEvidenceJson(owner.scope);
    if (this.#closed || this.#blocked.get(owner.database)?.has(scopeKey)) throw new EvidenceError("Evidence admission is closed", 409);
    if (this.#entries.size >= L.MAX_ACTIVE + L.MAX_QUEUED) throw new EvidenceError("Evidence queue is full", 409);
    const started = performance.now(); let finish!: () => void;
    const entry: ImportEntry = { owner, started, controller: new AbortController(), active: false, captured: false, queueMs: 0, acquisitionWallMs: null, workerLifetimeWallMs: null, publicationWallMs: null,
      timer: setTimeout(() => {
        try { this.#failure(entry, entry.captured ? "import_timeout" : "upload_timeout"); }
        catch { entry.controller.abort(); entry.worker?.cancel(); }
      }, this.#importMs), done: new Promise(resolve => { finish = resolve; }), finish: () => finish() };
    this.#entries.add(entry);
    return entry;
  }
  async receive(owner: EvidenceOwner, request: IncomingMessage): Promise<EvidenceImportReceipt> {
    const entry = this.#entry(owner), started = entry.started, scopeKey = canonicalEvidenceJson(owner.scope);
    try {
      const captured = await readEvidenceImportFrame(request, draft => {
        if (this.#blocked.get(owner.database)?.has(`${scopeKey}:${canonicalEvidenceJson(draft.attachment)}`)) throw new EvidenceError("Evidence attachment is being removed", 409);
        if (draft.parserVersion !== EVIDENCE_READER_IDENTITY.parserVersion || draft.policyVersion !== EVIDENCE_READER_IDENTITY.policyVersion || draft.configurationSha256 !== EVIDENCE_READER_IDENTITY.configurationSha256) throw new EvidenceError("Evidence parser configuration is not registered");
        const admitted = new EvidenceInventories(owner).admit(draft);
        entry.draft = draft; entry.admission = admitted; return admitted;
      }, { signal: entry.controller.signal, deadlineAt: started + this.#importMs, beforeSources: (_admission, signal) => this.#wait(entry, signal) });
      entry.captured = true;
      entry.acquisitionWallMs = Math.max(0, captured.acquisitionMs - entry.queueMs);
      if (captured.admission.reused) {
        this.#release(entry);
        return { job: owner.store.getJob(captured.admission.job.id), reused: true, timings: this.timings(owner, captured.admission.job.id) };
      }
      entry.worker = this.#supervisor.submit({ jobId: captured.admission.job.id, publicationToken: captured.admission.publicationToken,
        scopeGeneration: captured.admission.job.scopeGeneration, sources: captured.sources.map((source, index) => ({ ...source, dialect: captured.request.sources[index].dialect })), isCurrent: () => this.#current(entry) });
      void this.#complete(entry, captured.sources, entry.worker.result);
      return { job: owner.store.getJob(captured.admission.job.id), reused: false, timings: this.#timing(entry) };
    } catch (error) {
      try {
        const code = error instanceof EvidenceUploadError ? error.code : error instanceof EvidenceSupervisorError ? supervisorFailure(error) : "source_integrity";
        this.#failure(entry, code);
      } finally { this.#release(entry); }
      throw error;
    }
  }
  async reparse(owner: EvidenceOwner, setId: string, value: unknown): Promise<EvidenceImportReceipt> {
    const input = evidenceObject(value, ["operationKey", "expectedRevision", "inventory", "retention"], "evidence reparse");
    const revision = evidenceInteger(input.expectedRevision, "expected revision", Number.MAX_SAFE_INTEGER, 1);
    const entry = this.#entry(owner);
    try {
      const previous = owner.store.getSet(evidenceText(setId, "set ID"), revision).revision;
      const draft = parseEvidenceImportRequest({ ...EVIDENCE_READER_IDENTITY, operationKey: evidenceText(input.operationKey, "operation key"),
        target: { setId: previous.id, expectedRevision: revision }, attachment: previous.attachment, sources: previous.sources.map(source => ({
          sourceId: source.sourceId, kind: source.kind, dialect: source.dialect, shardId: source.shardId, artifactSha256: source.artifactSha256, byteLength: source.byteLength,
        })), inventory: Object.hasOwn(input, "inventory") ? input.inventory : previous.inventory ? { id: previous.inventory.id, revision: previous.inventory.revision } : null,
        retention: input.retention ?? previous.initialRetention });
      owner.database.transaction(() => owner.authorize("raw_export", previous.attachment)).immediate();
      entry.draft = draft; entry.admission = new EvidenceInventories(owner).admit(draft);
      if (entry.admission.reused) { const job = owner.store.getJob(entry.admission.job.id); this.#release(entry); return { job, reused: true, timings: this.timings(owner, job.id) }; }
      await this.#wait(entry, entry.controller.signal);
      const acquired = performance.now(), sources = previous.sources.map(source => ({ sourceId: source.sourceId, bytes: owner.store.exportRaw(previous.id, revision, source.sourceId) }));
      entry.captured = true;
      entry.acquisitionWallMs = performance.now() - acquired;
      entry.worker = this.#supervisor.submit({ jobId: entry.admission.job.id, publicationToken: entry.admission.publicationToken, scopeGeneration: entry.admission.job.scopeGeneration,
        sources: sources.map((source, index) => ({ ...source, dialect: draft.sources[index].dialect })), isCurrent: () => this.#current(entry) });
      void this.#complete(entry, sources, entry.worker.result);
      return { job: owner.store.getJob(entry.admission.job.id), reused: false, timings: this.#timing(entry) };
    } catch (error) {
      try { this.#failure(entry, error instanceof EvidenceSupervisorError ? supervisorFailure(error) : "source_integrity"); }
      finally { this.#release(entry); }
      throw error;
    }
  }
  async #complete(entry: ImportEntry, sources: EvidenceCapturedSource[], result: Promise<ReaderOperationResult>): Promise<void> {
    try {
      const parsed = await result;
      entry.workerLifetimeWallMs = parsed.workers.reduce((sum, worker) => sum + worker.lifetimeMs, 0);
      if (this.#current(entry)) {
        const started = performance.now();
        entry.owner.store.publish(entry.admission!.job.id, entry.admission!.publicationToken,
          sources.map((source, index) => ({ sourceId: source.sourceId, raw: source.bytes, normalized: parsed.sources[index] })));
        entry.publicationWallMs = performance.now() - started;
      }
    } catch (error) {
      try { this.#failure(entry, error instanceof EvidenceSupervisorError ? supervisorFailure(error) : "worker_failed"); }
      catch { entry.controller.abort(); entry.worker?.cancel(); }
    } finally { this.#release(entry); }
  }
  async cancel(owner: EvidenceOwner, id: string): Promise<boolean> {
    const cancelled = owner.store.cancel(id), entries = [...this.#entries].filter(entry => entry.owner.database === owner.database && canonicalEvidenceJson(entry.owner.scope) === canonicalEvidenceJson(owner.scope) && entry.admission?.job.id === id);
    await this.#stopEntries(entries);
    return cancelled;
  }
  async #stopEntries(entries: ImportEntry[]): Promise<void> {
    for (const entry of entries) { entry.controller.abort(); entry.worker?.cancel(); entry.ready?.reject(new EvidenceUploadError("upload_aborted", 409)); }
    await Promise.all(entries.map(entry => entry.done));
  }
  async removePayloads(owner: EvidenceOwner, id: string, revision: number, kind: "raw_removed" | "normalized_removed"): Promise<number> {
    const removed = owner.store.removePayloads(id, revision, kind);
    const entries = [...this.#entries].filter(entry => entry.owner.database === owner.database && canonicalEvidenceJson(entry.owner.scope) === canonicalEvidenceJson(owner.scope) && entry.draft?.target?.setId === id);
    await this.#stopEntries(entries);
    return removed;
  }
  async #invalidate(entries: ImportEntry[]): Promise<void> {
    let failure: unknown;
    for (const entry of entries) { try { this.#failure(entry, "attachment_unavailable"); } catch (error) { failure ??= error; } }
    await Promise.all(entries.map(entry => entry.done));
    if (failure) throw failure instanceof Error ? failure : new EvidenceError("Evidence invalidation failed", 409);
  }
  async invalidateAttachments(owner: EvidenceOwner, attachments: EvidenceAttachment[]): Promise<void> {
    const blocks = this.#blocked.get(owner.database) ?? new Set<string>(), keys = attachments.map(attachment => `${canonicalEvidenceJson(owner.scope)}:${canonicalEvidenceJson(attachment)}`);
    keys.forEach(key => blocks.add(key)); this.#blocked.set(owner.database, blocks);
    const entries = [...this.#entries].filter(entry => entry.owner.database === owner.database && canonicalEvidenceJson(entry.owner.scope) === canonicalEvidenceJson(owner.scope) &&
      entry.draft && attachments.some(attachment => canonicalEvidenceJson(attachment) === canonicalEvidenceJson(entry.draft!.attachment)));
    try { await this.#invalidate(entries); }
    finally { keys.forEach(key => blocks.delete(key)); }
  }
  async clear(owner: EvidenceOwner): Promise<void> {
    const blocks = this.#blocked.get(owner.database) ?? new Set<string>(), key = canonicalEvidenceJson(owner.scope);
    blocks.add(key); this.#blocked.set(owner.database, blocks);
    const entries = [...this.#entries].filter(entry => entry.owner.database === owner.database && canonicalEvidenceJson(entry.owner.scope) === canonicalEvidenceJson(owner.scope));
    try { await this.#invalidate(entries); owner.store.purgeScope(); }
    finally { blocks.delete(key); }
  }
  async shutdown(): Promise<void> {
    this.#closed = true;
    const entries = [...this.#entries];
    for (const entry of entries) { try { this.#failure(entry, "shutdown"); } catch { /* Current authority may already be gone; cancellation and reaping still run. */ } }
    await this.#supervisor.shutdown(); await Promise.all(entries.map(entry => entry.done));
  }
}
function supervisorFailure(error: EvidenceSupervisorError): EvidenceImportFailureCode {
  if (error.code === "source_timeout") return "worker_timeout";
  if (["worker_unavailable", "worker_failed", "worker_protocol", "import_timeout", "queue_full", "shutdown"].includes(error.code)) return error.code as EvidenceImportFailureCode;
  return "worker_failed";
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
  const externalAbort = () => controller.abort(options.signal?.reason === "upload_timeout" ? "upload_timeout" : "upload_aborted");
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
      const sourceTimer = setTimeout(() => controller.abort("upload_timeout"), L.MAX_SOURCE_MS);
      let bytes: Uint8Array;
      try { bytes = await cursor.exact(source.byteLength); } finally { clearTimeout(sourceTimer); }
      if (evidenceDigest(bytes) !== source.artifactSha256) throw new EvidenceUploadError("source_integrity");
      sources.push({ sourceId: source.sourceId, bytes });
    }
    await cursor.end();
    return { request: parsed, admission, sources, acquiredBytes: cursor.bytes, acquisitionMs: performance.now() - started };
  } finally {
    clearTimeout(timeout); options.signal?.removeEventListener("abort", externalAbort);
  }
}
