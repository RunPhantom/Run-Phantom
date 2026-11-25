import { useSyncExternalStore } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  getRunDetail,
  listConversationRuns,
  listRuns,
  listRunsPage,
  normalizeRunDetail,
  type NormalizedRunDetailData,
} from "../api/runs";

// Synchronous guards also cover WebSocket callbacks before React commits the
// disabled observers. Entries live only for the delete transaction, not forever.
let deletingRuns: ReadonlySet<string> = new Set();
// Failures outlive the menu that started deletion, including navigation away
// and back while the request is pending. A retry clears only that run's error.
const deletionErrors = new Map<string, string>();
const deletionListeners = new Set<() => void>();
export function setRunDeletionError(runId: string, message: string | null) {
  if (message === null) deletionErrors.delete(runId);
  else deletionErrors.set(runId, message);
  for (const listener of deletionListeners) listener();
}
export function useRunDeletionError(runId: string | undefined) {
  return useSyncExternalStore(subscribeRunDeletions, () => runId ? deletionErrors.get(runId) : undefined);
}
export function isRunDeleting(runId: string) { return deletingRuns.has(runId); }
export function subscribeRunDeletions(listener: () => void) {
  deletionListeners.add(listener);
  return () => { deletionListeners.delete(listener); };
}
export function setRunDeleting(runId: string, deleting: boolean) {
  const next = new Set(deletingRuns);
  if (deleting) next.add(runId);
  else next.delete(runId);
  deletingRuns = next;
  for (const listener of deletionListeners) listener();
}
export function useRunDeletions() {
  return useSyncExternalStore(subscribeRunDeletions, () => deletingRuns);
}

export const RUNS_KEY = ["runs"] as const;
export const RECENT_RUNS_KEY = ["runs", "recent"] as const;
export const RECENT_RUN_LIMIT = 8;

/**
 * Every run (up to the server's 5000-row cap). Only pages that list or look up arbitrary runs should use it; the shell
 * reads `useRecentRuns`. Kept current by `useRunListSync`, which merges changed rows instead of refetching the list.
 */
export function useRuns() {
  return useQuery({
    queryKey: RUNS_KEY,
    queryFn: listRuns,
  });
}

/** The newest runs by last activity plus the total run count: one small page for the nav count and the palette. */
export function useRecentRuns() {
  return useQuery({
    queryKey: RECENT_RUNS_KEY,
    queryFn: ({ signal }) => listRunsPage({ limit: String(RECENT_RUN_LIMIT) }, signal),
  });
}

export function useRunDetail(runId: string | null | undefined, initialData?: NormalizedRunDetailData) {
  useRunDeletions();
  return useQuery({
    queryKey: ["run-detail", runId],
    queryFn: async ({ signal }) => normalizeRunDetail(await getRunDetail(runId!, signal)),
    enabled: () => !!runId && !initialData && !isRunDeleting(runId),
    initialData,
  });
}

export function useConversationRuns(convoId: string | null | undefined) {
  return useQuery({
    queryKey: ["conversation-runs", convoId],
    queryFn: ({ signal }) => listConversationRuns(convoId!, signal),
    enabled: !!convoId,
  });
}

export function useConversationDetail(convoId: string | null | undefined) {
  useRunDeletions();
  const runsQuery = useConversationRuns(convoId);
  const runs = runsQuery.data ?? [];
  const detailQueries = useQueries({
    queries: runs.map((run) => ({
      queryKey: ["run-detail", run.id],
      queryFn: async ({ signal }: { signal: AbortSignal }) => normalizeRunDetail(await getRunDetail(run.id, signal)),
      enabled: () => !isRunDeleting(run.id),
    })),
  });

  return {
    turns: runs.map((run, index) => ({
      run,
      spans: detailQueries[index]?.data?.spans ?? [],
      subAgents: detailQueries[index]?.data?.subAgents ?? [],
    })),
    runIds: runs.map(run => run.id),
    isLoading: runsQuery.isLoading || detailQueries.some(query => query.isLoading),
    isError: runsQuery.isError || detailQueries.some(query => query.isError),
  };
}
