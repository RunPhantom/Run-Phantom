import { randomUUID, createHash } from "node:crypto";
import { fields, object, boundedText, parseId, parseVersion, canonicalCaseDefinitions, parseRule, EvaluationError } from "./validation";
import { sanitizeSnapshotText } from "./snapshot";
import type { DatasetRevision, DatasetCase } from "./protocol";
import { EXECUTION_FORMAT, EXECUTION_LIMITS as L, type ExecutionDraft, type DatasetExecution, type ExecutionCase, type ExecutionAttempt, type DispatchResult } from "./execution-protocol";

const dollars = (value: number) => Math.ceil(value * 1_000_000);
function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new EvaluationError(`${label} must be ${min}–${max}`);
  return value;
}
function budget(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > L.MAX_PROVIDER_USD) throw new EvaluationError(`${label} must be 0–30 USD`);
  return dollars(value) / 1_000_000;
}
export function parseExecutionDraft(body: unknown): ExecutionDraft {
  const value = object(body); fields(value, ["datasetId", "version", "datasetHash", "endpointName", "operationKey", "concurrency", "timeoutMs", "maxAttempts", "maxTotalCostUsd", "maxCostPerAttemptUsd", "allowSideEffects"]);
  if (value.allowSideEffects !== true) throw new EvaluationError("Explicit permission for endpoint and tool side effects is required");
  const hash = boundedText(value.datasetHash, "dataset hash", 64);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new EvaluationError("Dataset hash is invalid");
  return { datasetId: parseId(value.datasetId), version: parseVersion(value.version), datasetHash: hash,
    endpointName: parseId(value.endpointName), operationKey: parseId(value.operationKey),
    concurrency: integer(value.concurrency ?? 1, "Concurrency", 1, L.MAX_CONCURRENCY), timeoutMs: integer(value.timeoutMs ?? 30_000, "Admission deadline", L.MIN_TIMEOUT_MS, L.MAX_TIMEOUT_MS),
    maxAttempts: integer(value.maxAttempts ?? 1, "Attempts per case", 1, L.MAX_ATTEMPTS), maxTotalCostUsd: budget(value.maxTotalCostUsd ?? 0, "Operation budget"),
    maxCostPerAttemptUsd: budget(value.maxCostPerAttemptUsd ?? 0, "Maximum attempt cost"), allowSideEffects: true };
}
export function freezeExecution(revision: DatasetRevision, request: ExecutionDraft): DatasetExecution {
  if (revision.datasetId !== request.datasetId || revision.version !== request.version || revision.hash !== request.datasetHash) throw new EvaluationError("Dataset revision changed", 409);
  if (!revision.cases.length || revision.cases.length > L.MAX_CASES || new Set(revision.cases.map(item => item.id)).size !== revision.cases.length) throw new EvaluationError("Dataset case population is invalid");
  const reserved = dollars(request.maxCostPerAttemptUsd) * revision.cases.length * request.maxAttempts;
  if (reserved > dollars(request.maxTotalCostUsd)) throw new EvaluationError("Complete attempt population exceeds the operation budget");
  const cases: DatasetCase[] = revision.cases.map(value => {
    const item = object(value), input = sanitizeSnapshotText(item.input), output = sanitizeSnapshotText(item.sourceOutput);
    const name = sanitizeSnapshotText(boundedText(item.name, "Case name", 128));
    if (!Array.isArray(item.rules) || item.rules.length < 1 || item.rules.length > 8 || !Array.isArray(item.tags) || item.tags.length > 8) throw new EvaluationError("Frozen case definition is invalid");
    return { id: parseId(item.id), name: name.value ?? "[UNAVAILABLE]", input: input.redacted || input.truncated ? null : input.value,
      sourceRunId: item.sourceRunId === null ? null : parseId(item.sourceRunId), sourceSpanId: item.sourceSpanId === null ? null : parseId(item.sourceSpanId),
      sourceOutput: output.value, tags: item.tags.map(tag => sanitizeSnapshotText(boundedText(tag, "Tag", 64)).value ?? "[UNAVAILABLE]"), rules: item.rules.map(parseRule),
      sourceCapturedAt: typeof item.sourceCapturedAt === "number" && Number.isSafeInteger(item.sourceCapturedAt) && item.sourceCapturedAt >= 0 ? item.sourceCapturedAt : null,
      sourceRedacted: item.sourceRedacted === true || input.redacted || output.redacted, sourceTruncated: item.sourceTruncated === true || input.truncated || output.truncated,
      sourceSnapshotVersion: item.sourceSnapshotVersion === 1 ? 1 : null };
  });
  const createdAt = Date.now();
  const result: DatasetExecution = { format: EXECUTION_FORMAT, kind: "registered_endpoint_execution", id: randomUUID(),
    requestDigest: createHash("sha256").update(JSON.stringify([request, canonicalCaseDefinitions(cases)])).digest("hex"),
    dataset: { id: revision.datasetId, name: sanitizeSnapshotText(boundedText(revision.datasetName, "Dataset name", 128)).value ?? "[UNAVAILABLE]", version: revision.version, hash: revision.hash }, request: structuredClone(request),
    createdAt, completedAt: null, status: "queued", reservedCostUsd: reserved / 1_000_000,
    cases: cases.map(item => ({ case: item, attempts: Array.from({ length: request.maxAttempts }, (_, index) => ({ id: randomUUID(), index,
      status: "not_started", startedAt: null, completedAt: null, runId: null, actualCostUsd: null, reason: "Not dispatched", sideEffects: "not_dispatched" })),
      grading: { status: "inconclusive", checks: [], runId: null, reason: "Execution has not supplied a complete attributed capture" } })) };
  if (Buffer.byteLength(JSON.stringify(result)) > L.MAX_RECORD_BYTES) throw new EvaluationError("Frozen execution exceeds its retention limit", 413);
  return result;
}

/** Process-wide permits remain occupied until the actual endpoint promise settles. */
export class DispatchSlots {
  private active = 0;
  private queue: Array<{ signal: AbortSignal; grant: (release: (() => void) | null) => void; abort: () => void }> = [];
  acquire(signal: AbortSignal): Promise<(() => void) | null> {
    if (signal.aborted) return Promise.resolve(null);
    if (this.active < L.MAX_CONCURRENCY) { this.active++; return Promise.resolve(this.release()); }
    if (this.queue.length >= L.MAX_QUEUE) return Promise.resolve(null);
    return new Promise(resolve => {
      const entry = { signal, grant: resolve, abort: () => { const index = this.queue.indexOf(entry); if (index >= 0) this.queue.splice(index, 1); resolve(null); } };
      signal.addEventListener("abort", entry.abort, { once: true }); this.queue.push(entry);
    });
  }
  private release(): () => void {
    let released = false;
    return () => {
      if (released) return; released = true; this.active--;
      while (this.queue.length && this.active < L.MAX_CONCURRENCY) {
        const entry = this.queue.shift()!; entry.signal.removeEventListener("abort", entry.abort);
        if (entry.signal.aborted) { entry.grant(null); continue; }
        this.active++; entry.grant(this.release());
      }
    };
  }
  counts() { return { active: this.active, queued: this.queue.length }; }
}
const processSlots = new DispatchSlots();
export type EndpointDispatch = (request: ExecutionDraft, item: ExecutionCase, attempt: ExecutionAttempt, signal: AbortSignal) => Promise<DispatchResult>;
export async function executeFrozen(frozen: DatasetExecution, dispatch: EndpointDispatch, options: {
  signal?: AbortSignal; slots?: DispatchSlots; publish?: (result: DatasetExecution) => void;
} = {}): Promise<DatasetExecution> {
  const result = structuredClone(frozen), controller = new AbortController(), slots = options.slots ?? processSlots;
  const abort = () => controller.abort(); options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  // Queueing consumes the same admission deadline as dispatch; waiting cannot extend the budget.
  const deadline = result.createdAt + result.request.timeoutMs;
  const timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
  result.status = "running";
  let failed = false, failure: unknown;
  const publish = () => { if (!failed) options.publish?.(structuredClone(result)); };
  let cursor = 0;
  const finish = (attempt: ExecutionAttempt, status: ExecutionAttempt["status"], reason: string) => {
    attempt.status = status; attempt.reason = reason; attempt.completedAt = Date.now();
  };
  const worker = async () => {
    try {
      while (cursor < result.cases.length) {
        const item = result.cases[cursor++];
        for (const attempt of item.attempts) {
          if (controller.signal.aborted) { finish(attempt, options.signal?.aborted ? "cancelled" : "timed_out", "Stopped before completion"); continue; }
          const input = item.case.input, safe = input === null ? null : sanitizeSnapshotText(input);
          if (input === null || item.case.sourceRedacted || item.case.sourceTruncated || !safe || safe.redacted || safe.truncated || safe.value !== input) {
            finish(attempt, "unavailable", "Frozen input is missing or withheld"); continue;
          }
          const release = await slots.acquire(controller.signal);
          if (!release || controller.signal.aborted) { release?.(); finish(attempt, options.signal?.aborted ? "cancelled" : "timed_out", "Dispatch admission unavailable before deadline"); continue; }
          let handedOff = false, stopped: (() => void) | undefined;
          try {
            attempt.status = "running"; attempt.startedAt = Date.now(); attempt.sideEffects = "may_have_occurred"; publish();
            if (controller.signal.aborted) { finish(attempt, options.signal?.aborted ? "cancelled" : "timed_out", "Stopped before endpoint callback"); continue; }
            // Prepare arguments while the worker still owns the permit: publication or cloning may throw.
            const capturedItem = structuredClone(item), capturedAttempt = structuredClone(attempt);
            let settle!: (value: DispatchResult | null) => void;
            const observed = new Promise<DispatchResult | null>(resolve => { settle = resolve; });
            stopped = () => settle(null); controller.signal.addEventListener("abort", stopped, { once: true });
            let callback: Promise<DispatchResult>;
            handedOff = true;
            try { callback = Promise.resolve(dispatch(result.request, capturedItem, capturedAttempt, controller.signal)); }
            catch { callback = Promise.resolve({ status: "failed", runId: null, actualCostUsd: null }); }
            // After handoff only actual callback settlement releases the permit, even if it ignores abort.
            callback.then(value => { release(); settle(value); }, () => { release(); settle({ status: "failed", runId: null, actualCostUsd: null }); });
            const value = await observed;
            if (!value || controller.signal.aborted) { finish(attempt, options.signal?.aborted ? "cancelled" : "timed_out", "Dispatch stopped; external side effects may have occurred"); }
            else {
              if (!["transport_success", "failed", "unavailable"].includes(value.status) || (value.actualCostUsd !== null && (!Number.isFinite(value.actualCostUsd) || value.actualCostUsd < 0 || dollars(value.actualCostUsd) > dollars(result.request.maxCostPerAttemptUsd)))) {
                finish(attempt, "unavailable", "Endpoint completion or usage is outside the frozen contract"); controller.abort();
              } else {
                finish(attempt, value.status, value.status === "transport_success" ? "Endpoint dispatch completed; captured grading is separate" : "Endpoint did not complete successfully");
                try { attempt.runId = value.runId === null ? null : parseId(value.runId); attempt.actualCostUsd = value.actualCostUsd; }
                catch { finish(attempt, "unavailable", "Endpoint returned an invalid capture identity"); attempt.runId = null; }
              }
            }
            publish();
            if ((attempt as ExecutionAttempt).status === "transport_success") break;
          } finally {
            if (stopped) controller.signal.removeEventListener("abort", stopped);
            if (!handedOff) release();
          }
        }
      }
    } catch (cause) {
      // Record synchronously before another granted worker can begin a callback.
      if (!failed) { failed = true; failure = cause; }
      controller.abort();
    }
  };
  try {
    publish();
    // Aborting observation settles peers promptly; their actual callbacks still own any permits.
    await Promise.all(Array.from({ length: result.request.concurrency }, worker));
    if (failed) throw failure;
    result.status = options.signal?.aborted ? "cancelled" : "completed"; result.completedAt = Date.now(); publish();
    return result;
  } catch (cause) { controller.abort(); throw cause; }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
}
