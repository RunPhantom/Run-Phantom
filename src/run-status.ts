export const RUN_STATUSES = ["live", "quiet", "complete", "completed_with_errors", "failed", "cancelled", "interrupted", "unknown"] as const;
export type RunStatus = typeof RUN_STATUSES[number];

/** A run whose roots have not all ended reads as live only while spans keep arriving this recently. */
export const RUN_QUIET_AFTER_MS = 30_000;
/**
 * Spans are exported only when they end (src/parse.ts), so a run waiting on
 * one long model or tool call receives nothing until that call returns. Only
 * a silence this long is treated as evidence that the run was interrupted.
 */
export const RUN_INTERRUPTED_AFTER_MS = 10 * 60_000;

/**
 * Stored facts a status is derived from. `/api/runs` rows and run detail
 * payloads carry every field, so the UI re-derives with its own clock and a
 * run that stops receiving spans leaves "live" without a refetch.
 */
export interface RunStatusEvidence {
  readonly last_updated_at: number | null;
  /** 1 when at least one root span exists and every root reached OK or ERROR. */
  readonly finished?: number | boolean | null;
  readonly span_count?: number | null;
  readonly metadata?: string | null;
  readonly capture_completion?: "unavailable" | null;
  readonly error_count?: number | null;
  readonly tool_error_count?: number | null;
  /** The span that stands for the whole run errored. See `rootFailed`. */
  readonly root_failed?: number | boolean | null;
  /** `replayOutcome(metadata)` precomputed by a payload that omits metadata, such as search rows. */
  readonly replay_outcome?: "failed" | "cancelled" | null;
}

export interface RunStatusSummary {
  readonly status: RunStatus;
  readonly label: string;
  /** Plain-English reason, suitable for a tooltip or screen-reader description. */
  readonly detail: string;
  readonly errorCount: number;
  readonly toolErrorCount: number;
}

export interface RootSpanCounts {
  readonly roots: number;
  readonly rootErrors: number;
  readonly agentRoots: number;
  readonly agentRootErrors: number;
}

/**
 * Whether the span standing for the whole run errored. With an AGENT_ROOT
 * that span decides. Legacy SDKs emit every span as a sibling root, so
 * without one a single errored tool root is a child error, not a failed run,
 * unless every root errored.
 */
export function rootFailed(counts: RootSpanCounts): boolean {
  if (counts.agentRoots > 0) return counts.agentRootErrors > 0;
  return counts.roots > 0 && counts.rootErrors === counts.roots;
}

/**
 * Errors shown for a run. An errored AGENT_ROOT stands for the run's outcome ("Run failed"); when an errored
 * span beneath it explains the failure, counting the root as well would report one rejected call as 2 errors.
 * run-status-sql.ts errorCountSql mirrors this for search.
 */
export function countedErrors(errors: number, agentRootErrors: number): number {
  return agentRootErrors > 0 && errors > agentRootErrors ? errors - agentRootErrors : errors;
}

/** Error evidence from spans already in memory; db.ts derives the same counts in SQL for run lists. */
export function runErrorEvidenceFromSpans(spans: readonly { parent_span_id?: string | null; span_type?: string | null; status?: string | null }[]) {
  let errors = 0, toolErrors = 0, roots = 0, rootErrors = 0, agentRoots = 0, agentRootErrors = 0;
  for (const span of spans) {
    const errored = span.status === "ERROR";
    if (errored) errors++;
    if (errored && span.span_type === "TOOL_CALL") toolErrors++;
    if (span.parent_span_id) continue;
    roots++;
    if (errored) rootErrors++;
    if (span.span_type === "AGENT_ROOT") { agentRoots++; if (errored) agentRootErrors++; }
  }
  return { error_count: countedErrors(errors, agentRootErrors), tool_error_count: toolErrors, root_failed: rootFailed({ roots, rootErrors, agentRoots, agentRootErrors }) };
}

/**
 * A replay placeholder that failed or was cancelled never gets spans, an
 * ERROR status or a finish flag; the daemon records the outcome only as
 * `replay.error` in its metadata (src/replay.ts recordPlaceholderError).
 */
export function replayOutcome(run: { metadata?: string | null }): "failed" | "cancelled" | null {
  if (!run.metadata) return null;
  try {
    const error = JSON.parse(run.metadata)?.replay?.error;
    if (!error || typeof error !== "object" || Array.isArray(error)) return null;
    return error.code === "replay_cancelled" ? "cancelled" : "failed";
  } catch {
    return null;
  }
}

const count = (value: number | null | undefined): number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
const plural = (value: number, noun: string): string => `${value} ${noun}${value === 1 ? "" : "s"}`;

function errorPhrase(errorCount: number, toolErrorCount: number): string {
  return toolErrorCount === errorCount ? plural(errorCount, "tool error") : plural(errorCount, "error");
}

export function deriveRunStatus(run: RunStatusEvidence, now: number = Date.now()): RunStatusSummary {
  const errorCount = count(run.error_count);
  const toolErrorCount = Math.min(count(run.tool_error_count), errorCount);
  const summary = (status: RunStatus, label: string, detail: string): RunStatusSummary => ({ status, label, detail, errorCount, toolErrorCount });
  const outcome = run.replay_outcome ?? replayOutcome(run);
  if (outcome === "cancelled") return summary("cancelled", "Run cancelled", "The replay was cancelled before it finished.");
  if (outcome === "failed") return summary("failed", "Run failed", "The replay failed before it recorded any spans.");
  if (run.capture_completion === "unavailable") return summary("unknown", "Completion unavailable", "This capture cannot show whether the run finished.");
  if (run.root_failed) return summary("failed", "Run failed", errorCount > 1 ? `The run's root span errored, with ${errorPhrase(errorCount, toolErrorCount)} in total.` : "The run's root span errored.");
  if (run.finished) {
    if (errorCount > 0) return summary("completed_with_errors", `Completed · ${errorPhrase(errorCount, toolErrorCount)}`, `The run finished, but ${errorPhrase(errorCount, toolErrorCount)} occurred inside it.`);
    return summary("complete", "Run complete", "Every root span ended without an error.");
  }
  const silentFor = typeof run.last_updated_at === "number" ? now - run.last_updated_at : null;
  if (silentFor !== null && silentFor < RUN_QUIET_AFTER_MS) return summary("live", "Run live", "Spans are still arriving.");
  if (!count(run.span_count) && run.span_count !== undefined) return summary("unknown", "No spans recorded", "The run recorded no spans, so its outcome is unknown.");
  if (silentFor !== null && silentFor < RUN_INTERRUPTED_AFTER_MS) {
    return summary("quiet", "Run quiet", `No new spans for ${silence(silentFor)}. Spans arrive when they end, so a long model or tool call keeps a running run quiet.`);
  }
  return summary("interrupted", "Run interrupted", `No spans arrived for ${RUN_INTERRUPTED_AFTER_MS / 60_000} minutes and the run never recorded its end.`);
}

function silence(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 120 ? `${seconds}s` : `${Math.floor(seconds / 60)} minutes`;
}

/** Live and quiet runs have not recorded their end yet; actions that need a finished run wait for them. */
export function runInProgress(status: RunStatus): boolean {
  return status === "live" || status === "quiet";
}

/**
 * The coarse status run lists, saved views and the overview count by. It is a
 * projection of `RunStatus`, never derived separately: live and quiet runs share
 * `running`, `complete` keeps its older list name `completed`, and every other
 * status is its own bucket.
 */
export const RUN_OUTCOMES = ["running", "completed", "completed_with_errors", "failed", "interrupted", "cancelled", "unknown"] as const;
export type RunOutcome = typeof RUN_OUTCOMES[number];

export function runOutcome(status: RunStatus): RunOutcome {
  if (status === "live" || status === "quiet") return "running";
  if (status === "complete") return "completed";
  return status;
}

/** Outcomes that recorded how the run ended, the denominator of failure and error rates. */
export const FINISHED_RUN_OUTCOMES: readonly RunOutcome[] = Object.freeze(["completed", "completed_with_errors", "failed"]);

/**
 * Status filter values accepted by GET /api/runs, run search, typed search
 * filters and MCP: every RunStatus, plus each RunOutcome as the group of
 * statuses that project onto it.
 */
export const RUN_STATUS_FILTER_GROUPS: Readonly<Record<string, readonly RunStatus[]>> = Object.freeze({
  ...Object.fromEntries(RUN_OUTCOMES.map(outcome => [outcome, Object.freeze(RUN_STATUSES.filter(status => runOutcome(status) === outcome))])),
  ...Object.fromEntries(RUN_STATUSES.map(status => [status, Object.freeze([status])])),
});
export const RUN_STATUS_FILTER_VALUES: readonly string[] = Object.freeze(Object.keys(RUN_STATUS_FILTER_GROUPS));

export function runStatusFilterMembers(value: string): readonly RunStatus[] {
  return Object.prototype.hasOwnProperty.call(RUN_STATUS_FILTER_GROUPS, value) ? RUN_STATUS_FILTER_GROUPS[value] : [];
}

export function runStatusTone(status: RunStatus): "success" | "warning" | "danger" | "neutral" {
  if (status === "live") return "success";
  if (status === "failed") return "danger";
  if (status === "completed_with_errors" || status === "interrupted") return "warning";
  return "neutral";
}
