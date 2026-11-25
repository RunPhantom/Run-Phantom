import { useEffect, useState } from "react";
import { deriveRunStatus, RUN_INTERRUPTED_AFTER_MS, RUN_QUIET_AFTER_MS, type RunStatusEvidence, type RunStatusSummary } from "../../../src/run-status";

/**
 * The shared run status, re-derived when an unfinished run crosses the quiet
 * or interrupted threshold. A run that stops receiving spans gets no websocket
 * event, so without this timer it would keep its last label indefinitely.
 */
export function useRunStatus(run: RunStatusEvidence | null | undefined): RunStatusSummary | null {
  const [tick, setTick] = useState(0);
  const summary = run ? deriveRunStatus(run, Date.now()) : null;
  const status = summary?.status;
  const lastUpdatedAt = run?.last_updated_at ?? null;
  useEffect(() => {
    if ((status !== "live" && status !== "quiet") || lastUpdatedAt === null) return;
    const boundary = lastUpdatedAt + (status === "live" ? RUN_QUIET_AFTER_MS : RUN_INTERRUPTED_AFTER_MS);
    const timer = setTimeout(() => setTick(value => value + 1), Math.max(250, boundary - Date.now() + 50));
    return () => clearTimeout(timer);
  }, [status, lastUpdatedAt, tick]);
  return summary;
}
