import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { lookupRunFacts, type RunListRow } from "../api/runs";
import { mergeRunRows } from "../api/run-list-merge";
import { isRunDeleting, RECENT_RUNS_KEY, RUNS_KEY } from "../hooks/use-runs";
import { useRunPhantomEvent } from "../hooks/use-runphantom-ws";

/**
 * Coalesces live "spans" events, which arrive once per streamed batch during capture: the nav count and palette trail
 * the store by at most this long, and a busy capture costs one small request per window instead of one per batch.
 */
const FLUSH_MS = 2000;

/**
 * Keeps run lists current from WebSocket events without downloading the whole list again: the small recent page
 * (nav count, palette) is re-read, and when a page holds the full list only the changed runs are fetched by id and
 * merged into it. Mount once, in the shell.
 */
export function useRunListSync(): void {
  const queryClient = useQueryClient();
  const pending = useRef(new Set<string>());
  const timer = useRef<number | null>(null);
  const generation = useRef(0);

  const flush = () => {
    timer.current = null;
    const ids = [...pending.current].filter(id => !isRunDeleting(id));
    pending.current = new Set();
    void queryClient.invalidateQueries({ queryKey: RECENT_RUNS_KEY, exact: true });
    if (ids.length === 0 || !queryClient.getQueryData(RUNS_KEY)) return;
    const startedAt = generation.current;
    lookupRunFacts(ids).then(fresh => {
      if (generation.current !== startedAt) return;
      queryClient.setQueryData<RunListRow[]>(RUNS_KEY, list => list && mergeRunRows(list, ids.filter(id => !isRunDeleting(id)), fresh));
    }, () => {
      // The merge is an optimisation; when the lookup fails, fall back to one full read so the list is not left stale.
      if (generation.current === startedAt) void queryClient.invalidateQueries({ queryKey: RUNS_KEY, exact: true });
    });
  };
  const schedule = () => {
    if (timer.current === null) timer.current = window.setTimeout(flush, FLUSH_MS);
  };

  useRunPhantomEvent<{ runIds?: unknown } | undefined>("spans", data => {
    if (Array.isArray(data?.runIds)) for (const id of data.runIds) if (typeof id === "string") pending.current.add(id);
    schedule();
  });
  useRunPhantomEvent("clear", () => {
    generation.current += 1;
    pending.current = new Set();
    void queryClient.invalidateQueries({ queryKey: RUNS_KEY });
  });
  useEffect(() => {
    const onRemoved = () => schedule();
    window.addEventListener("runphantom:run-removed", onRemoved);
    return () => {
      window.removeEventListener("runphantom:run-removed", onRemoved);
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
