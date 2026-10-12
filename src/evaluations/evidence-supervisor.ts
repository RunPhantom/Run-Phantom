import { evidenceWorkerLaunchEnv } from "./evidence-worker-environment";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { EVIDENCE_LIMITS as L, type NormalizedEvidenceSource } from "./evidence-protocol";
import { evidenceText, parseNormalizedEvidence } from "./evidence-validation";
import { EVIDENCE_WORKER_ENTRY, EVIDENCE_WORKER_OUTPUT_BYTES, readBoundedStream, type EvidenceWorkerRequest } from "./evidence-worker";
import { readerLimits, snapshotEvidenceBytes, type ReaderLimits } from "./evidence-reader/limits";
import { strictEvidenceJson } from "./evidence-reader/json";

declare const __RUNPHANTOM_PACKAGED__: boolean;
export type EvidenceSupervisorFailure = "queue_full" | "cancelled" | "shutdown" | "source_timeout" | "import_timeout" |
  "worker_unavailable" | "worker_failed" | "worker_protocol" | "stale_publication" | "input_limit";
export class EvidenceSupervisorError extends Error {
  constructor(public readonly code: EvidenceSupervisorFailure) { super(code); this.name = "EvidenceSupervisorError"; }
}
type WorkerProcess = Bun.Subprocess<"pipe", "pipe", "ignore">;
export interface ReaderSource { sourceId: string; dialect: string; bytes: Uint8Array }
export interface ReaderOperation {
  jobId: string;
  publicationToken: string;
  scopeGeneration: number;
  sources: readonly ReaderSource[];
  /** Trusted service check only; publication still requires the store's atomic fence. */
  isCurrent?: () => boolean;
}
export interface ReaderOperationResult {
  jobId: string;
  publicationToken: string;
  scopeGeneration: number;
  sources: NormalizedEvidenceSource[];
  workers: { pid: number; exitCode: number; lifetimeMs: number }[];
  queueMs: number;
  totalMs: number;
  cpuMs: null;
  rssBytes: null;
}
export interface EvidenceSupervisorOptions {
  maxSourceMs?: number;
  maxImportMs?: number;
  limits?: Partial<ReaderLimits>;
  /** Application-owned launch seam for compiled entrypoints and real process fixtures. Never accept it from a request. */
  workerFactory?: () => WorkerProcess;
}
interface Job {
  request: ReaderOperation;
  admitted: number;
  controller: AbortController;
  failure: EvidenceSupervisorFailure | null;
  started: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: ReaderOperationResult) => void;
  reject: (reason: Error) => void;
  promise: Promise<ReaderOperationResult>;
}
function boundedTime(value: number | undefined, max: number): number {
  if (value === undefined) return max;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError("Deadlines can only narrow the fixed worker budget");
  return value;
}
export function spawnEvidenceWorker(): WorkerProcess {
  const packaged = typeof __RUNPHANTOM_PACKAGED__ !== "undefined" && __RUNPHANTOM_PACKAGED__;
  const command = packaged ? [process.execPath, EVIDENCE_WORKER_ENTRY] : [process.execPath, "--no-env-file", "--no-install", fileURLToPath(new URL("./evidence-worker.ts", import.meta.url))];
  const env = evidenceWorkerLaunchEnv();
  return Bun.spawn(command, { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
}

/** One instance per daemon; callers across local and private project stores share admission. */
export class EvidenceSupervisor {
  #active = 0;
  #queue: Job[] = [];
  #jobs = new Set<Job>();
  #closed = false;
  readonly #sourceMs: number;
  readonly #importMs: number;
  readonly #limits: ReaderLimits;
  readonly #factory: () => WorkerProcess;
  constructor(options: EvidenceSupervisorOptions = {}) {
    this.#sourceMs = boundedTime(options.maxSourceMs, L.MAX_SOURCE_MS);
    this.#importMs = boundedTime(options.maxImportMs, L.MAX_IMPORT_MS);
    this.#limits = readerLimits(options.limits);
    this.#factory = options.workerFactory ?? spawnEvidenceWorker;
  }
  get state(): { active: number; queued: number; closed: boolean } { return { active: this.#active, queued: this.#queue.length, closed: this.#closed }; }
  submit(request: ReaderOperation): { result: Promise<ReaderOperationResult>; cancel: () => void } {
    if (this.#closed) throw new EvidenceSupervisorError("shutdown");
    if (this.#queue.length >= L.MAX_QUEUED) throw new EvidenceSupervisorError("queue_full");
    evidenceText(request.jobId, "job ID"); evidenceText(request.publicationToken, "publication token");
    if (!Number.isSafeInteger(request.scopeGeneration) || request.scopeGeneration < 0 || !Array.isArray(request.sources) || !request.sources.length || request.sources.length > L.MAX_REPORTS) throw new EvidenceSupervisorError("input_limit");
    let bytes = 0; const ids = new Set<string>();
    const sources = request.sources.map(source => {
      evidenceText(source.sourceId, "source ID"); evidenceText(source.dialect, "dialect");
      if (ids.has(source.sourceId)) throw new EvidenceSupervisorError("input_limit");
      let snapshot: Uint8Array;
      try { snapshot = snapshotEvidenceBytes(source.bytes, this.#limits.maxSourceBytes, L.MAX_IMPORT_BYTES - bytes); }
      catch { throw new EvidenceSupervisorError("input_limit"); }
      bytes += snapshot.byteLength; ids.add(source.sourceId);
      return { sourceId: source.sourceId, dialect: source.dialect, bytes: snapshot };
    });
    let resolve!: Job["resolve"], reject!: Job["reject"];
    const promise = new Promise<ReaderOperationResult>((yes, no) => { resolve = yes; reject = no; });
    const job: Job = { request: { ...request, sources }, admitted: performance.now(), controller: new AbortController(), failure: null, started: false,
      timer: setTimeout(() => this.#stop(job, "import_timeout"), this.#importMs), resolve, reject, promise };
    this.#jobs.add(job); this.#queue.push(job); this.#pump();
    return { result: promise, cancel: () => this.#stop(job, "cancelled") };
  }
  async shutdown(): Promise<void> {
    this.#closed = true;
    const jobs = [...this.#jobs];
    for (const job of jobs) this.#stop(job, "shutdown");
    await Promise.allSettled(jobs.map(job => job.promise));
  }
  #stop(job: Job, reason: EvidenceSupervisorFailure): void {
    if (!this.#jobs.has(job) || job.failure) return;
    job.failure = reason; job.controller.abort();
    if (!job.started) {
      this.#queue = this.#queue.filter(queued => queued !== job);
      clearTimeout(job.timer); this.#jobs.delete(job); job.reject(new EvidenceSupervisorError(reason));
    }
  }
  #pump(): void {
    while (!this.#closed && this.#active < L.MAX_ACTIVE && this.#queue.length) {
      const job = this.#queue.shift()!; job.started = true; this.#active++;
      void (async () => {
        let result: ReaderOperationResult | undefined, failure: unknown;
        try { result = await this.#run(job); } catch (error) { failure = error; }
        finally { clearTimeout(job.timer); this.#jobs.delete(job); this.#active--; this.#pump(); }
        if (result) job.resolve(result); else job.reject(failure instanceof Error ? failure : new EvidenceSupervisorError("worker_failed"));
      })();
    }
  }
  async #run(job: Job): Promise<ReaderOperationResult> {
    const result: ReaderOperationResult = { jobId: job.request.jobId, publicationToken: job.request.publicationToken, scopeGeneration: job.request.scopeGeneration,
      sources: [], workers: [], queueMs: performance.now() - job.admitted, totalMs: 0, cpuMs: null, rssBytes: null };
    let normalizedBytes = 0, leaves = 0;
    for (const source of job.request.sources) {
      if (job.failure) throw new EvidenceSupervisorError(job.failure);
      if (performance.now() - job.admitted >= this.#importMs) throw new EvidenceSupervisorError("import_timeout");
      if (job.request.isCurrent && !job.request.isCurrent()) throw new EvidenceSupervisorError("stale_publication");
      let child: WorkerProcess;
      try { child = this.#factory(); } catch { throw new EvidenceSupervisorError("worker_unavailable"); }
      const started = performance.now(), id = randomUUID();
      let timedOut = false;
      const kill = () => { try { child.kill("SIGKILL"); } catch { /* An already reaped child owns no further work. */ } };
      const timer = setTimeout(() => { timedOut = true; kill(); }, this.#sourceMs);
      job.controller.signal.addEventListener("abort", kill, { once: true });
      try {
        const request: EvidenceWorkerRequest = { version: 1, id, sourceId: source.sourceId, dialect: source.dialect, limits: this.#limits, bytes: Buffer.from(source.bytes).toString("base64") };
        await child.stdin.write(JSON.stringify(request));
        await child.stdin.end();
        let output: Uint8Array;
        try { output = await readBoundedStream(child.stdout, EVIDENCE_WORKER_OUTPUT_BYTES); }
        catch { kill(); throw new EvidenceSupervisorError("worker_protocol"); }
        const exitCode = await child.exited;
        result.workers.push({ pid: child.pid, exitCode, lifetimeMs: performance.now() - started });
        if (job.failure) throw new EvidenceSupervisorError(job.failure);
        if (timedOut) throw new EvidenceSupervisorError("source_timeout");
        if (exitCode !== 0) throw new EvidenceSupervisorError("worker_failed");
        const response = strictEvidenceJson(new TextDecoder("utf-8", { fatal: true }).decode(output), this.#limits);
        if (!response || typeof response !== "object" || Array.isArray(response)) throw new EvidenceSupervisorError("worker_protocol");
        const message = response as Record<string, unknown>;
        if (Object.keys(message).length !== 3 || message.version !== 1 || message.id !== id || !Object.hasOwn(message, "normalized")) throw new EvidenceSupervisorError("worker_protocol");
        const normalized = parseNormalizedEvidence(message.normalized, source.dialect === "junit-xml/v1" ? "junit" : "attestation");
        const sourceBytes = Buffer.byteLength(JSON.stringify(normalized));
        if (normalized.sourceId !== source.sourceId || sourceBytes > this.#limits.maxNormalizedBytes) throw new EvidenceSupervisorError("worker_protocol");
        normalizedBytes += sourceBytes; leaves += normalized.leaves.length;
        if (normalizedBytes > this.#limits.maxNormalizedBytes || leaves > this.#limits.maxLeaves) throw new EvidenceSupervisorError("input_limit");
        result.sources.push(normalized);
      } catch (error) {
        if (job.failure) throw new EvidenceSupervisorError(job.failure);
        if (timedOut) throw new EvidenceSupervisorError("source_timeout");
        if (error instanceof EvidenceSupervisorError) throw error;
        throw new EvidenceSupervisorError("worker_protocol");
      } finally {
        clearTimeout(timer); job.controller.signal.removeEventListener("abort", kill);
        kill(); await child.exited;
      }
    }
    if (job.failure) throw new EvidenceSupervisorError(job.failure);
    if (performance.now() - job.admitted >= this.#importMs) throw new EvidenceSupervisorError("import_timeout");
    if (job.request.isCurrent && !job.request.isCurrent()) throw new EvidenceSupervisorError("stale_publication");
    result.totalMs = performance.now() - job.admitted;
    return result;
  }
}
let daemonSupervisor: EvidenceSupervisor | undefined;
export function getEvidenceSupervisor(): EvidenceSupervisor { return daemonSupervisor ??= new EvidenceSupervisor(); }
