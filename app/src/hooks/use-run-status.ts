import { useEffect, useState } from "react";
import { deriveRunStatus, RUN_QUIET_AFTER_MS, type RunStatusEvidence, type RunStatusSummary } from "../../../src/run-status";

/**
 * The shared run status, re-derived when a live run's quiet window elapses.
 * A run that stops receiving spans gets no websocket event, so without this
 * timer it would read "Run live" until something else re-rendered it.
 */
export function useRunStatus(run: RunStatusEvidence | null | undefined): RunStatusSummary | null {
  const [tick, setTick] = useState(0);
  const summary = run ? deriveRunStatus(run, Date.now()) : null;
  const live = summary?.status === "live";
  const lastUpdatedAt = run?.last_updated_at ?? null;
  useEffect(() => {
    if (!live || lastUpdatedAt === null) return;
    const timer = setTimeout(() => setTick(value => value + 1), Math.max(250, lastUpdatedAt + RUN_QUIET_AFTER_MS - Date.now() + 50));
    return () => clearTimeout(timer);
  }, [live, lastUpdatedAt, tick]);
  return summary;
}
