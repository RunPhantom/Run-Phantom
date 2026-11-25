import { useSyncExternalStore } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  getRunDetail,
  getRunFacets,
  listConversationRuns,
  listRuns,
  listRunsPage,
  lookupRunFacts,
  normalizeRunDetail,
  type NormalizedRunDetailData,
} from "../api/runs";
import { RECENT_RUNS_KEY, RUN_FACETS_KEY, RUNS_KEY } from "../api/run-query-keys";

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

export { RECENT_RUNS_KEY, RUN_FACETS_KEY, RUNS_KEY } from "../api/run-query-keys";
export const RECENT_RUN_LIMIT = 8;
/**
 * The full list is 2.8 MB at 3,000 runs. `useRunListSync` merges every captured change into it, and local deletes
 * edit it in place, so a page that mounts again reuses it instead of downloading it once per visit. What this misses
 * is a run deleted from another tab or through the API; a later visit after this long picks that up.
 */
const RUNS_STALE_MS = 5 * 60_000;

/**
 * Every run (up to the server's 5000-row cap). Only pages that list or look up arbitrary runs should use it; the shell
 * reads `useRecentRuns`, the Runs table `useRunFacets`, and run detail `useRunRows`.
 */
export function useRuns() {
  return useQuery({
    queryKey: RUNS_KEY,
    queryFn: listRuns,
    staleTime: RUNS_STALE_MS,
  });
}

/** The newest runs by last activity plus the total run count: one small page for the nav count and the palette. */
export function useRecentRuns() {
  return useQuery({
    queryKey: RECENT_RUNS_KEY,
    queryFn: ({ signal }) => listRunsPage({ limit: String(RECENT_RUN_LIMIT) }, signal),
  });
}

/**
 * Agent and model filter choices, and whether any run is the user's own, without the full run list. This read and
 * `useRunRows` are a few hundred bytes and are not cancelled on unmount, so leaving a page still fills the cache.
 */
export function useRunFacets() {
  return useQuery({
    queryKey: RUN_FACETS_KEY,
    queryFn: () => getRunFacets(),
  });
}

/** The run-list rows for a few known ids (run detail's selected, source and baseline runs); absent ids are missing. */
export function useRunRows(ids: readonly (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))].sort();
  return useQuery({
    queryKey: ["runs", "by-id", wanted],
    queryFn: () => lookupRunFacts(wanted),
    enabled: wanted.length > 0,
    placeholderData: previous => previous,
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
