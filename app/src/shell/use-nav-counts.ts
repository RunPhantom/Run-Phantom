import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRuns } from "../hooks/use-runs";
import { useRunPhantomEvent } from "../hooks/use-runphantom-ws";
import type { Run } from "../utils/types";
import { useSavedRuns } from "../api/saved-runs";
import { reviewQueuesApi } from "../components/review-queues/client";

export interface NavCount {
  text: string;
  /** Read to screen readers through aria-describedby on the nav link. */
  description: string;
  tone?: "danger";
}

/** /api/runs caps its response at this many rows (src/server.ts GET /api/runs). */
const RUN_LIST_CAP = 5000;
const RUN_COUNT_REFRESH_MS = 5000;
const REVIEW_COUNT_REFRESH_MS = 30_000;

function compact(value: number): string {
  return value >= 10_000 ? `${Math.floor(value / 1000)}k` : String(value);
}

/**
 * Counts come only from successful responses; while a request is pending or after it
 * fails there is no count, because an absent number is not zero. Zero is also hidden
 * to keep the rail quiet.
 */
export function useNavCounts(): Partial<Record<string, NavCount>> {
  const queryClient = useQueryClient();
  const runs = useRuns();
  const { events: saved } = useSavedRuns();
  const review = useQuery({
    queryKey: ["review-queues", "nav-counts"],
    queryFn: reviewQueuesApi.queues,
    refetchInterval: REVIEW_COUNT_REFRESH_MS,
    retry: false,
  });

  const refreshTimer = useRef<number | null>(null);
  const scheduleRunsRefresh = () => {
    if (refreshTimer.current !== null) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void queryClient.invalidateQueries({ queryKey: ["runs"], exact: true });
    }, RUN_COUNT_REFRESH_MS);
  };
  // Only a new run id or a clear changes the count; "spans" for known runs (one per
  // streamed batch during live capture) would otherwise refetch the full run list.
  useRunPhantomEvent<{ runIds?: unknown } | undefined>("spans", data => {
    const ids = Array.isArray(data?.runIds) ? data.runIds.filter((id): id is string => typeof id === "string") : [];
    const known = queryClient.getQueryData<Run[]>(["runs"]);
    if (!known || ids.some(id => !known.some(run => run.id === id))) scheduleRunsRefresh();
  });
  useRunPhantomEvent("clear", scheduleRunsRefresh);
  useEffect(() => {
    window.addEventListener("runphantom:run-removed", scheduleRunsRefresh);
    return () => {
      window.removeEventListener("runphantom:run-removed", scheduleRunsRefresh);
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const counts: Partial<Record<string, NavCount>> = {};
  if (runs.isSuccess && runs.data.length > 0) {
    const capped = runs.data.length >= RUN_LIST_CAP;
    counts.runs = {
      text: capped ? `${compact(RUN_LIST_CAP)}+` : compact(runs.data.length),
      description: capped ? `More than ${RUN_LIST_CAP} runs` : `${runs.data.length} ${runs.data.length === 1 ? "run" : "runs"}`,
    };
  }
  if (saved.length > 0) {
    counts.saved = { text: compact(saved.length), description: `${saved.length} saved ${saved.length === 1 ? "run" : "runs"}` };
  }
  if (review.isSuccess) {
    const waiting = review.data.reduce((sum, queue) => sum + (queue.counts?.draft ?? 0), 0);
    if (waiting > 0) {
      counts["review-queues"] = {
        text: compact(waiting),
        description: `${waiting} ${waiting === 1 ? "item" : "items"} waiting for review`,
        tone: "danger",
      };
    }
  }
  return counts;
}
