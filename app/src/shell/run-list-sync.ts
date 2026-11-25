import type { QueryClient } from "@tanstack/react-query";
import type { RunFacets, RunListRow } from "../api/runs";
import { mergeRunRows } from "../api/run-list-merge";
import { isSampleRun } from "../../../src/sample-runs";
import { RECENT_RUNS_KEY, RUN_FACETS_KEY, RUNS_KEY } from "../api/run-query-keys";


/**
 * Coalesces live "spans" events, which arrive once per streamed batch during capture: the nav count and palette trail
 * the store by at most this long, and a busy capture costs one small request per window instead of one per batch.
 */
export const FLUSH_MS = 2000;

export interface RunListSyncOptions {
  lookup: (ids: readonly string[]) => Promise<ReadonlyMap<string, RunListRow>>;
  isDeleting: (id: string) => boolean;
  delayMs?: number;
}

/** Facets after `fresh` rows joined: new agents and models are added; nothing is removed until the next full read. */
export function mergeRunFacets(facets: RunFacets, fresh: Iterable<RunListRow>): RunFacets {
  const agents = new Set(facets.agents), models = new Set(facets.models);
  let hasOwnRuns = facets.hasOwnRuns;
  for (const row of fresh) {
    if (row.agent) agents.add(row.agent);
    for (const model of row.models ?? []) models.add(model);
    if (!isSampleRun(row)) hasOwnRuns = true;
  }
  if (agents.size === facets.agents.length && models.size === facets.models.length && hasOwnRuns === facets.hasOwnRuns) return facets;
  return { agents: [...agents].sort(), models: [...models].sort(), hasOwnRuns };
}

/**
 * Keeps cached run lists current from WebSocket events without downloading the whole list again: the small recent
 * page (nav count, palette) is re-read, and when the full list or the facets are cached only the changed runs are
 * fetched by id and merged in.
 */
export function createRunListSync(queryClient: QueryClient, options: RunListSyncOptions) {
  const delayMs = options.delayMs ?? FLUSH_MS;
  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  const fetching = (key: readonly unknown[]) => queryClient.getQueryState(key)?.fetchStatus === "fetching";

  const schedule = () => {
    if (timer === null) timer = setTimeout(flush, delayMs);
  };
  const requeue = (ids: readonly string[]) => {
    for (const id of ids) pending.add(id);
    schedule();
  };

  function flush() {
    timer = null;
    const ids = [...pending].filter(id => !options.isDeleting(id));
    pending = new Set();
    void queryClient.invalidateQueries({ queryKey: RECENT_RUNS_KEY, exact: true });
    const cached = !!queryClient.getQueryData(RUNS_KEY) || !!queryClient.getQueryData(RUN_FACETS_KEY);
    if (ids.length === 0 || !cached) return;
    // A full read already in flight was snapshotted before these changes and would overwrite the merge when it lands.
    if (fetching(RUNS_KEY) || fetching(RUN_FACETS_KEY)) { requeue(ids); return; }
    const startedAt = generation;
    options.lookup(ids).then(fresh => {
      if (generation !== startedAt) return;
      if (fetching(RUNS_KEY) || fetching(RUN_FACETS_KEY)) { requeue(ids); return; }
      const live = ids.filter(id => !options.isDeleting(id));
      queryClient.setQueryData<RunListRow[]>(RUNS_KEY, list => list && mergeRunRows(list, live, fresh));
      queryClient.setQueryData<RunFacets>(RUN_FACETS_KEY, facets => facets && mergeRunFacets(facets, fresh.values()));
    }, () => {
      // The merge is an optimisation; when the lookup fails, fall back to one full read so the lists are not left stale.
      if (generation !== startedAt) return;
      void queryClient.invalidateQueries({ queryKey: RUNS_KEY, exact: true });
      void queryClient.invalidateQueries({ queryKey: RUN_FACETS_KEY, exact: true });
    });
  }

  return {
    /** Runs that gained spans; `undefined` when the event did not say which. */
    spans(runIds: unknown) {
      if (Array.isArray(runIds)) for (const id of runIds) if (typeof id === "string") pending.add(id);
      schedule();
    },
    removed: schedule,
    clear() {
      generation += 1;
      pending = new Set();
      void queryClient.invalidateQueries({ queryKey: RUNS_KEY });
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
