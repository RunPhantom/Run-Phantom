import { RUN_INTERRUPTED_AFTER_MS, RUN_QUIET_AFTER_MS, RUN_STATUS_FILTER_GROUPS, RUN_STATUS_FILTER_VALUES, runStatusFilterMembers } from "./run-status";

/**
 * SQL mirror of `deriveRunStatus` for a local `runs` row, so search filters
 * and search rows agree with /api/runs and the UI. One gap: a validated
 * partial hook capture ("Completion unavailable") needs JavaScript
 * validation, so SQL classifies it by its span evidence instead.
 */
export function runStatusSql(run: string) {
  const spans = (alias: string, where: string) => `EXISTS (SELECT 1 FROM spans ${alias} WHERE ${alias}.run_id=${run}.id AND ${where})`;
  const metadata = `${run}.metadata`;
  const replay = `(CASE WHEN json_valid(${metadata}) AND json_type(${metadata},'$.replay.error')='object' THEN CASE WHEN json_extract(${metadata},'$.replay.error.code')='replay_cancelled' THEN 'cancelled' ELSE 'failed' END END)`;
  const rootFailed = `(SELECT CASE WHEN SUM(CASE WHEN rsf.span_type='AGENT_ROOT' THEN 1 ELSE 0 END)>0
      THEN SUM(CASE WHEN rsf.span_type='AGENT_ROOT' AND rsf.status='ERROR' THEN 1 ELSE 0 END)>0
      ELSE COUNT(*)>0 AND SUM(CASE WHEN rsf.status='ERROR' THEN 1 ELSE 0 END)=COUNT(*) END
    FROM spans rsf WHERE rsf.run_id=${run}.id AND rsf.parent_span_id IS NULL)`;
  const finished = `(${spans("rsr", "rsr.parent_span_id IS NULL")} AND NOT ${spans("rso", "rso.parent_span_id IS NULL AND (rso.status IS NULL OR rso.status NOT IN ('OK','ERROR'))")})`;
  const now = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
  const silent = `(${now}-${run}.last_updated_at)`;
  const status = `(CASE
    WHEN ${replay} IS NOT NULL THEN ${replay}
    WHEN ${rootFailed} THEN 'failed'
    WHEN ${finished} THEN CASE WHEN ${spans("rse", "rse.status='ERROR'")} THEN 'completed_with_errors' ELSE 'complete' END
    WHEN ${run}.last_updated_at IS NOT NULL AND ${silent}<${RUN_QUIET_AFTER_MS} THEN 'live'
    WHEN NOT ${spans("rsa", "1=1")} THEN 'unknown'
    WHEN ${run}.last_updated_at IS NOT NULL AND ${silent}<${RUN_INTERRUPTED_AFTER_MS} THEN 'quiet'
    ELSE 'interrupted' END)`;
  return { status, replay, rootFailed, finished };
}

export { RUN_STATUS_FILTER_GROUPS, RUN_STATUS_FILTER_VALUES };

export function runStatusFilterSql(status: string, value: string, op: "eq" | "ne"): { sql: string; params: string[] } {
  const members = runStatusFilterMembers(value);
  if (!members.length) return { sql: op === "ne" ? "1=1" : "0=1", params: [] };
  return { sql: `${status} ${op === "ne" ? "NOT IN" : "IN"} (${members.map(() => "?").join(",")})`, params: [...members] };
}
