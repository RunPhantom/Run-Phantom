import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listRunsPage, type RunListRow } from "../api/runs";
import { useRunPhantomEvent } from "../hooks/use-runphantom-ws";
import { filtersToSearchParams, runsListQuery, type RunsViewFilters } from "../../../src/saved-views-protocol";

export const RUNS_PAGE_SIZE = 100;
const LIVE_FLUSH_MS = 750;
const FLASH_MS = 1600;
/** Rows below the loaded head that a paused list re-reads one by one; more than this waits for resume. */
const PAUSED_ROW_REFRESH_LIMIT = 20;

export interface RunsTableData {
  rows: RunListRow[];
  /** Runs matching the filters on the last successful read; null before the first one. */
  total: number | null;
  hasMore: boolean;
  status: "loading" | "ready" | "error";
  error: string | null;
  /** New filters are loading; `rows` still hold the previous result. */
  refreshing: boolean;
  loadingMore: boolean;
  loadMoreError: string | null;
  /** New matching runs that arrived while paused, newest first. */
  pendingNew: string[];
  /** Ids that just entered the list; rows render a one-off highlight. */
  flashIds: ReadonlySet<string>;
  loadMore: () => void;
  retry: () => void;
  /** Reload the head of the list and highlight what was waiting. Runs by itself when `paused` turns false. */
  resume: () => void;
  removeLocal: (ids: readonly string[]) => void;
}

interface Snapshot {
  rows: RunListRow[];
  total: number | null;
  cursor: string | null;
  status: "loading" | "ready" | "error";
  error: string | null;
  refreshing?: boolean;
}

const EMPTY: Snapshot = { rows: [], total: null, cursor: null, status: "loading", error: null };

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Could not load runs";
}

/** Same fields as the daemon's `q` match (runMatchesQuery in src/stats/runs-list.ts). */
function matchesText(row: RunListRow, q: string): boolean {
  const needle = q.toLowerCase();
  return [row.id, row.display_name, row.name, row.event_name, row.input_preview].some(field => field?.toLowerCase().includes(needle));
}

/** One run as the current filters see it; null when it is gone or no longer matches them. */
async function readRow(id: string, filters: RunsViewFilters): Promise<RunListRow | null> {
  // `q` carries the id here, so the filters' own text search is re-checked on the returned row.
  const page = await listRunsPage({ ...runsListQuery(filters, Date.now()), q: id, limit: "50" });
  const row = page.runs.find(item => item.id === id) ?? null;
  return row && (!filters.q || matchesText(row, filters.q)) ? row : null;
}

/**
 * Cursor-paged GET /api/runs for the table, with live tail. While `paused` (scrolled or rows selected) rows keep
 * their order: known rows update in place, removed rows disappear, and new matching runs wait in `pendingNew`
 * instead of shifting the list under the reader.
 */
export function useRunsTable(filters: RunsViewFilters, paused: boolean, pageSize = RUNS_PAGE_SIZE): RunsTableData {
  const filtersKey = filtersToSearchParams(filters).toString();
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [pendingNew, setPendingNew] = useState<string[]>([]);
  const [flashIds, setFlashIds] = useState<ReadonlySet<string>>(new Set());
  const generation = useRef(0);
  const headQuery = useRef<Record<string, string>>({});
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const flashTimer = useRef<number | null>(null);
  const pendingRef = useRef(pendingNew);
  pendingRef.current = pendingNew;
  /** Something changed while paused, so the rows on screen may be out of order or incomplete. */
  const staleWhilePaused = useRef(false);

  // Superseded reads are ignored by generation rather than aborted: an aborted list read shows up as a failed request,
  // and the deletion-race specs hold list responses across a delete and expect them to land harmlessly.

  const flash = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return;
    setFlashIds(new Set(ids));
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => { flashTimer.current = null; setFlashIds(new Set()); }, FLASH_MS);
  }, []);

  const headSequence = useRef(0);
  const appliedHead = useRef(0);
  const loadHead = useCallback(async (mode: "reset" | "live") => {
    const run = generation.current;
    const sequence = ++headSequence.current;
    const query = { ...runsListQuery(filtersRef.current, Date.now()), limit: String(pageSize) };
    try {
      const page = await listRunsPage(query);
      // A slow earlier read must not overwrite a newer one (it may still list a run deleted in between).
      if (run !== generation.current || sequence < appliedHead.current) return;
      appliedHead.current = sequence;
      staleWhilePaused.current = false;
      const before = snapshotRef.current.rows;
      headQuery.current = query;
      setLoadMoreError(null);
      setPendingNew([]);
      setSnapshot({ rows: page.runs, total: page.total, cursor: page.nextCursor, status: "ready", error: null });
      if (mode === "live" && before.length > 0) {
        const known = new Set(before.map(row => row.id));
        flash(page.runs.filter(row => !known.has(row.id)).map(row => row.id));
      }
    } catch (error) {
      if (run !== generation.current) return;
      setSnapshot(previous => mode === "reset" || previous.rows.length === 0
        ? { ...EMPTY, status: "error", error: errorMessage(error) }
        : previous);
    }
  }, [flash, pageSize]);

  useEffect(() => {
    generation.current += 1;
    // Keep the previous rows on screen (marked refreshing) so each keystroke in the search box does not blank the table.
    setSnapshot(previous => previous.rows.length > 0 ? { ...previous, cursor: null, refreshing: true } : EMPTY);
    setPendingNew([]);
    setLoadingMore(false);
    void loadHead("reset");
  }, [filtersKey, loadHead]);

  useEffect(() => () => {
    generation.current += 1;
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
  }, []);

  const loadMore = useCallback(() => {
    const current = snapshotRef.current;
    if (!current.cursor || loadingMore) return;
    const run = generation.current;
    setLoadingMore(true);
    setLoadMoreError(null);
    // The head query is reused as is: a relative window resolved to `since` once, and the cursor is bound to it.
    listRunsPage({ ...headQuery.current, cursor: current.cursor }).then(page => {
      if (run !== generation.current) return;
      setSnapshot(previous => {
        const seen = new Set(previous.rows.map(row => row.id));
        return { ...previous, rows: [...previous.rows, ...page.runs.filter(row => !seen.has(row.id))], cursor: page.nextCursor, total: page.total };
      });
    }, error => {
      if (run === generation.current) setLoadMoreError(errorMessage(error));
    }).finally(() => {
      setLoadingMore(false);
    });
  }, [loadingMore]);

  const refreshPaused = useCallback(async (eventIds: ReadonlySet<string>) => {
    const run = generation.current;
    const query = { ...runsListQuery(filtersRef.current, Date.now()), limit: String(pageSize) };
    try {
      const head = await listRunsPage(query);
      if (run !== generation.current) return;
      const rows = snapshotRef.current.rows;
      const known = new Set(rows.map(row => row.id));
      const fresh = new Map(head.runs.map(row => [row.id, row]));
      const outside = [...eventIds].filter(id => known.has(id) && !fresh.has(id)).slice(0, PAUSED_ROW_REFRESH_LIMIT);
      const reread = await Promise.all(outside.map(async id => [id, await readRow(id, filtersRef.current)] as const));
      if (run !== generation.current) return;
      for (const [id, row] of reread) if (row) fresh.set(id, row);
      const removed = new Set(reread.filter(([, row]) => row === null).map(([id]) => id));
      setSnapshot(previous => ({ ...previous, total: head.total,
        rows: previous.rows.filter(row => !removed.has(row.id)).map(row => fresh.get(row.id) ?? row) }));
      const arrivals = head.runs.filter(row => !known.has(row.id)).map(row => row.id);
      setPendingNew(previous => [...arrivals, ...previous.filter(id => !arrivals.includes(id) && !removed.has(id))]);
    } catch {
      // A failed background refresh keeps the rows the reader is looking at; the next event retries.
    }
  }, [pageSize]);

  const eventIds = useRef(new Set<string>());
  const flushTimer = useRef<number | null>(null);
  const scheduleFlush = useCallback(() => {
    if (flushTimer.current !== null) return;
    flushTimer.current = window.setTimeout(() => {
      flushTimer.current = null;
      const ids = eventIds.current;
      eventIds.current = new Set();
      if (pausedRef.current && snapshotRef.current.status === "ready") {
        staleWhilePaused.current = true;
        void refreshPaused(ids);
      }
      else void loadHead(snapshotRef.current.rows.length > 0 ? "live" : "reset");
    }, LIVE_FLUSH_MS);
  }, [loadHead, refreshPaused]);
  useEffect(() => () => { if (flushTimer.current !== null) window.clearTimeout(flushTimer.current); }, []);

  useRunPhantomEvent<{ runIds?: unknown } | undefined>("spans", data => {
    if (Array.isArray(data?.runIds)) for (const id of data.runIds) if (typeof id === "string") eventIds.current.add(id);
    scheduleFlush();
  });
  useRunPhantomEvent("clear", () => {
    generation.current += 1;
    setPendingNew([]);
    void loadHead("reset");
  });

  const removeLocal = useCallback((ids: readonly string[]) => {
    const gone = new Set(ids);
    setSnapshot(previous => ({ ...previous, rows: previous.rows.filter(row => !gone.has(row.id)),
      total: previous.total === null ? null : Math.max(0, previous.total - previous.rows.filter(row => gone.has(row.id)).length) }));
    setPendingNew(previous => previous.filter(id => !gone.has(id)));
  }, []);

  useEffect(() => {
    const onRemoved = (event: Event) => {
      const detail = (event as CustomEvent<{ runId?: string; runIds?: string[] }>).detail;
      const runIds = detail?.runIds ?? (detail?.runId ? [detail.runId] : []);
      if (runIds.length === 0) return;
      // A list read started before the delete may still contain the run; drop it and read again.
      generation.current += 1;
      removeLocal([...runIds]);
      if (pausedRef.current) staleWhilePaused.current = true;
      else void loadHead("live");
    };
    window.addEventListener("runphantom:run-removed", onRemoved);
    return () => window.removeEventListener("runphantom:run-removed", onRemoved);
  }, [loadHead, removeLocal]);

  const resume = useCallback(() => {
    const waiting = pendingRef.current;
    generation.current += 1;
    void loadHead("reset").then(() => flash(waiting));
  }, [flash, loadHead]);

  // Leaving pause by any route (the pill, Esc, unticking, scrolling back up) catches the list up at once, even when
  // no further event arrives to trigger a read.
  const wasPaused = useRef(paused);
  useEffect(() => {
    const was = wasPaused.current;
    wasPaused.current = paused;
    if (!was || paused) return;
    if (pendingRef.current.length > 0 || staleWhilePaused.current) resume();
  }, [paused, resume]);

  const retry = useCallback(() => {
    generation.current += 1;
    setSnapshot(EMPTY);
    void loadHead("reset");
  }, [loadHead]);

  return useMemo(() => ({
    rows: snapshot.rows,
    total: snapshot.total,
    hasMore: snapshot.cursor !== null,
    status: snapshot.status,
    error: snapshot.error,
    refreshing: !!snapshot.refreshing,
    loadingMore,
    loadMoreError,
    pendingNew,
    flashIds,
    loadMore,
    retry,
    resume,
    removeLocal,
  }), [flashIds, loadMore, loadMoreError, loadingMore, pendingNew, removeLocal, resume, retry, snapshot]);
}
