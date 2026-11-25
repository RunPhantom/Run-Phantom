export const RUN_STATUSES = ["running", "completed", "completed_with_errors", "failed"] as const;
export type RunStatus = typeof RUN_STATUSES[number];

export interface RunStatusEvidence {
  /** Root spans (no parent) captured for the run. */
  readonly rootCount: number;
  /** Root spans whose status is OK or ERROR, i.e. roots that have ended. */
  readonly endedRootCount: number;
  readonly rootErrorCount: number;
  /** `rootFailed` from src/run-status.ts: the span standing for the whole run errored. */
  readonly rootFailed: boolean;
  /** Every span with status ERROR, roots included. */
  readonly errorCount: number;
}

/**
 * The single place overview and run-list metrics decide a run's status.
 * The run failed when the span standing for it errored (the same `rootFailed`
 * rule the run list, run header and search use); errors confined to child steps
 * (a tool that returned failing tests) leave a finished run "completed with errors".
 */
export function deriveRunStatus(evidence: RunStatusEvidence): RunStatus {
  if (evidence.rootFailed) return "failed";
  const ended = evidence.rootCount > 0 && evidence.endedRootCount === evidence.rootCount;
  if (!ended) return "running";
  return evidence.errorCount > 0 ? "completed_with_errors" : "completed";
}
