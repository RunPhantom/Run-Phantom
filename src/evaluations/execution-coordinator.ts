import { findRunByEventId, getDrizzleDb } from "../db";
import { getReplayTrace } from "../replay-map";
import { loadSnapshot } from "./loader";
import { boundRuleResult, evaluateRule, CODE_EVALUATOR_VERSION, TOOL_ARGUMENT_EVALUATOR_VERSION } from "./rules";
import { executeFrozen, type EndpointDispatch } from "./executor";
import { registeredExecutionDispatcher } from "./execution-endpoint";
import { type ExecutionStore, type ExecutionAuthority } from "./execution-store";
import { EXECUTION_LIMITS as L, type DatasetExecution, type ExecutionAttempt, type ExecutionCase } from "./execution-protocol";
import type { Snapshot } from "./protocol";
import { EvaluationError } from "./validation";

function unavailable(item: ExecutionCase, reason: string): ExecutionCase["grading"] {
  return { status: "inconclusive", runId: null, reason, checks: item.case.rules.map(rule => boundRuleResult({
    status: "inconclusive", source: "code", evaluatorVersion: rule.kind === "toolArgument" ? TOOL_ARGUMENT_EVALUATOR_VERSION : CODE_EVALUATOR_VERSION,
    score: null, reason, actual: null, expected: rule, spanIds: [], redacted: false, truncated: false,
  })) };
}
type Capture = { attempt: ExecutionAttempt; runId: string | null; snapshot: Snapshot | null; reason: string };

/** Inactive native component: the qualified owner constructs/admit stores, never this module. */
export async function coordinateExecution(id: string, token: string, store: ExecutionStore, authority: ExecutionAuthority,
  options: { signal?: AbortSignal; dispatch?: EndpointDispatch } = {}): Promise<DatasetExecution> {
  const db = getDrizzleDb().$client;
  const current = () => { authority.assertCurrent(); store.assertDatabase(getDrizzleDb().$client); };
  current();
  const frozen = store.get(id);
  if (!["queued", "running"].includes(frozen.status)) return frozen;
  if (frozen.status !== "queued") throw new EvaluationError("Execution is already owned by an active coordinator", 409);
  if (!frozen.cases.length || frozen.cases.length > L.MAX_CASES || frozen.cases.some(item => item.attempts.length < 1 || item.attempts.length > L.MAX_ATTEMPTS || item.case.rules.length < 1 || item.case.rules.length > 8)) throw new EvaluationError("Execution population is unavailable", 409);
  const endpoint = options.dispatch ?? registeredExecutionDispatcher(frozen.request.endpointName, frozen.id).dispatch;
  const controller = new AbortController(), abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true }); if (options.signal?.aborted) abort();
  const preexisting = new Set<string>();
  const candidates = (eventId: string) => db.query("SELECT id,started_at FROM runs WHERE event_id=? LIMIT 2").all(eventId) as Array<{ id: string; started_at: number | null }>;
  const observedClaims = new Map<string, Set<string>>();
  const originals = new Set(frozen.cases.flatMap(item => item.case.sourceRunId === null ? [] : [item.case.sourceRunId]));
  const guarded: EndpointDispatch = async (...args) => {
    current();
    const attempt = args[2];
    if (getReplayTrace(attempt.id) !== undefined || candidates(attempt.id).length) preexisting.add(attempt.id);
    if (!store.begin(frozen.id, attempt.id, token)) return { status: "unavailable", runId: null, actualCostUsd: null };
    const result = await endpoint(...args);
    current();
    const mapped = getReplayTrace(attempt.id);
    observedClaims.set(attempt.id, new Set([...candidates(attempt.id).map(row => row.id), ...(mapped === undefined ? [] : [mapped])]));
    // The endpoint response cannot authorize a capture identity or a provider cost.
    return { ...result, runId: null };
  };
  try {
    const result = await executeFrozen(frozen, guarded, { signal: controller.signal, publish: value => {
      current();
      // Grade the entire bounded roster before the single terminal population commit.
      if (value.status === "running" && !store.publish(value, token)) controller.abort();
    } });
    current();
    const captures = new Map<string, Capture>(), counts = new Map<string, number>();
    const identities = new Map<string, { rows: ReturnType<typeof candidates>; mapped: string | undefined }>();
    // Count every exact claim before grading. A last-writer run event or replay map
    // must not leave a later case passing while an earlier conflicting case fails closed.
    for (const item of result.cases) for (const attempt of item.attempts) if (attempt.status === "transport_success") {
      current();
      const rows = candidates(attempt.id), mapped = getReplayTrace(attempt.id);
      identities.set(attempt.id, { rows, mapped });
      for (const runId of new Set([...rows.map(row => row.id), ...(mapped === undefined ? [] : [mapped]), ...observedClaims.get(attempt.id) ?? []])) counts.set(runId, (counts.get(runId) ?? 0) + 1);
    }
    for (const item of result.cases) for (const attempt of item.attempts) {
      const capture: Capture = { attempt, runId: null, snapshot: null, reason: "Dispatch did not supply a complete attributed capture" };
      captures.set(attempt.id, capture);
      if (attempt.status !== "transport_success" || result.status !== "completed" || controller.signal.aborted) continue;
      current();
      try {
        const { rows, mapped } = identities.get(attempt.id)!;
        if (preexisting.has(attempt.id)) { capture.reason = "Capture identity existed before dispatch"; continue; }
        if (rows.length !== 1 || observedClaims.get(attempt.id)?.size !== 1 || !observedClaims.get(attempt.id)?.has(rows[0].id) ||
          findRunByEventId(attempt.id)?.id !== rows[0].id || mapped !== undefined && mapped !== rows[0].id) {
          capture.reason = "Exact persistent event attribution is missing, duplicated, or contradictory"; continue;
        }
        const row = rows[0]; capture.runId = row.id;
        if (originals.has(row.id)) { capture.reason = "Original dataset source cannot certify a new dispatch"; continue; }
        const timing = db.query("SELECT count(*) n,min(start_time_ms) started,max(end_time_ms) ended FROM spans WHERE run_id=?").get(row.id) as { n: number; started: number | null; ended: number | null };
        if (attempt.startedAt === null || !Number.isSafeInteger(row.started_at) || row.started_at! < attempt.startedAt || !timing.n ||
          !Number.isSafeInteger(timing.started) || timing.started! < attempt.startedAt || !Number.isSafeInteger(timing.ended) || timing.ended! > Date.now()) {
          capture.reason = "Captured run timing does not establish a fresh dispatch"; continue;
        }
        const snapshot = loadSnapshot(row.id);
        if (!snapshot.complete || !snapshot.output.complete || snapshot.redacted || snapshot.truncated || snapshot.input !== item.case.input) {
          capture.reason = "Fresh capture is partial, withheld, or differs from the frozen literal input"; continue;
        }
        capture.snapshot = snapshot;
      } catch { capture.reason = "Native capture is inaccessible or exceeds its acquisition boundary"; }
    }
    current();
    for (const item of result.cases) {
      const successful = item.attempts.find(attempt => attempt.status === "transport_success"), capture = successful ? captures.get(successful.id) : undefined;
      item.grading = unavailable(item, capture?.reason ?? "No completed attributed dispatch is available");
      if (!capture?.snapshot || capture.runId === null) continue;
      if (counts.get(capture.runId) !== 1) { item.grading = unavailable(item, "One captured run is attributed to multiple planned attempts"); continue; }
      const checks = item.case.rules.map(rule => evaluateRule(rule, capture.snapshot!));
      const status = checks.some(check => check.status === "fail") ? "fail" : checks.some(check => check.status === "inconclusive") ? "inconclusive" : "pass";
      item.grading = { status, checks, runId: capture.runId, reason: "Graded the complete fresh capture against frozen case rules" };
      successful!.runId = capture.runId;
    }
    current();
    if (!store.publish(result, token)) return store.get(id);
    return result;
  } finally { options.signal?.removeEventListener("abort", abort); }
}
