import { useQuery } from "@tanstack/react-query";
import { useRecentRuns } from "../hooks/use-runs";
import { useSavedRuns } from "../api/saved-runs";
import { reviewQueuesApi } from "../components/review-queues/client";

export interface NavCount {
  text: string;
  /** Read to screen readers through aria-describedby on the nav link. */
  description: string;
  tone?: "danger";
}

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
  const recent = useRecentRuns();
  const { events: saved } = useSavedRuns();
  const review = useQuery({
    queryKey: ["review-queues", "nav-counts"],
    queryFn: reviewQueuesApi.queues,
    refetchInterval: REVIEW_COUNT_REFRESH_MS,
    retry: false,
  });

  const counts: Partial<Record<string, NavCount>> = {};
  if (recent.isSuccess && recent.data.total > 0) {
    const count = recent.data.total;
    counts.runs = { text: compact(count), description: `${count} ${count === 1 ? "run" : "runs"}` };
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
