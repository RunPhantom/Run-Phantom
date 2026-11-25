import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowUp, Bookmark, Pencil, Trash2 } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Eyebrow, PageTitle } from "@/components/ui/typography";
import { EmptyState } from "../components/EmptyState";
import { useShortRunIds } from "../components/RunList";
import { clearRuns, listRunsPage, type RunListRow } from "../api/runs";
import { SAVED_VIEWS_KEY, savedViewsApi, useSavedViews } from "../api/saved-views";
import { useRuns } from "../hooks/use-runs";
import { useIsMobile } from "../hooks/use-mobile";
import { useRegisterShortcuts } from "../shell/commands";
import { ago, plural, runDisplayName, runStatus, runStatusTone } from "../utils/helpers";
import { runPath } from "../utils/navigation";
import {
  filtersEqual,
  filtersFromSearchParams,
  filtersToSearchParams,
  hasActiveFilters,
  type RunsTableColumn,
  type RunsViewFilters,
} from "../../../src/saved-views-protocol";
import { RunsTable, STATUS_DOT } from "./RunsTable";
import { ColumnChooser, DensityToggle, RunsToolbar, WINDOW_LABELS } from "./RunsToolbar";
import { RunsBulkBar } from "./RunsBulkBar";
import { ViewNameDialog } from "./SavedViewDialogs";
import { rememberRunsSearch } from "./last-search";
import { costCell, durationCell, isSampleRun, loadColumns, loadDensity, modelCell, nextSort, saveColumns, saveDensity, toggleColumn, type RunsDensity } from "./table-model";
import { useRunsTable } from "./use-runs-table";

const PAUSE_SCROLL_PX = 8;

function sameColumns(a: readonly RunsTableColumn[] | null, b: readonly RunsTableColumn[]): boolean {
  return !a || (a.length === b.length && a.every((column, index) => column === b[index]));
}

export function RunsTableView({ onLoadSamples }: { onLoadSamples: () => Promise<void> }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => filtersFromSearchParams(params), [params]);
  const viewId = params.get("view");
  const savedViews = useSavedViews();
  const activeView = viewId ? savedViews.data?.find(view => view.id === viewId) ?? null : null;
  const isMobile = useIsMobile();

  const [ownColumns, setOwnColumns] = useState<RunsTableColumn[]>(loadColumns);
  /** A saved view's own columns, applied only while that view is open; the reader's choice stays in `ownColumns`. */
  const [viewColumns, setViewColumns] = useState<RunsTableColumn[] | null>(null);
  const columns = viewColumns ?? ownColumns;
  const [density, setDensity] = useState<RunsDensity>(loadDensity);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [activeIndex, setActiveIndex] = useState(-1);
  const [scrolled, setScrolled] = useState(false);
  const [message, setMessage] = useState("");
  const [dialog, setDialog] = useState<null | "save" | "rename" | "delete-view" | "clear-all">(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectionAnchor = useRef<string | null>(null);

  const paused = scrolled || selected.size > 0;
  const data = useRunsTable(filters, paused);
  const rows = data.rows;
  const shortIds = useShortRunIds(rows);
  const filtered = hasActiveFilters(filters);

  useEffect(() => { rememberRunsSearch(params.toString()); }, [params]);

  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick(value => value + 1), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const appliedView = useRef<string | null>(null);
  useEffect(() => {
    if (!activeView || appliedView.current === activeView.id) return;
    appliedView.current = activeView.id;
    setViewColumns(activeView.columns);
  }, [activeView]);
  useEffect(() => {
    if (viewId) return;
    appliedView.current = null;
    setViewColumns(null);
  }, [viewId]);

  const allRuns = useRuns();
  const facets = useMemo(() => {
    const agents = new Set<string>();
    const models = new Set<string>();
    for (const run of (allRuns.data ?? []) as Partial<RunListRow>[]) {
      if (run.agent) agents.add(run.agent);
      for (const model of run.models ?? []) models.add(model);
    }
    return { agents: [...agents].sort(), models: [...models].sort() };
  }, [allRuns.data]);

  // Router navigations commit in a transition, so a render can still carry the previous URL after setParams.
  // Syncing only when the URL's filters change keeps a quick second edit from resurrecting the first one's input.
  const latestFilters = useRef(filters);
  const filtersKey = filtersToSearchParams(filters).toString();
  useEffect(() => { latestFilters.current = filtersFromSearchParams(new URLSearchParams(filtersKey)); }, [filtersKey]);
  const setFilters = useCallback((patch: Partial<RunsViewFilters>) => {
    const next = { ...latestFilters.current, ...patch };
    latestFilters.current = next;
    const search = filtersToSearchParams(next);
    if (viewId) search.set("view", viewId);
    setParams(search, { replace: true });
    setSelected(new Set());
    setActiveIndex(-1);
    scrollRef.current?.scrollTo({ top: 0 });
    setScrolled(false);
  }, [setParams, viewId]);

  const clearFilters = useCallback(() => {
    latestFilters.current = {};
    setParams(new URLSearchParams(), { replace: true });
    setSelected(new Set());
    setActiveIndex(-1);
  }, [setParams]);

  const open = useCallback((id: string) => navigate(runPath(id)), [navigate]);

  const toggle = useCallback((id: string, options?: { range?: boolean }) => {
    setSelected(previous => {
      const next = new Set(previous);
      if (options?.range && selectionAnchor.current) {
        const from = rows.findIndex(row => row.id === selectionAnchor.current);
        const to = rows.findIndex(row => row.id === id);
        if (from >= 0 && to >= 0) {
          for (const row of rows.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(row.id);
          return next;
        }
      }
      if (next.has(id)) next.delete(id); else next.add(id);
      selectionAnchor.current = id;
      return next;
    });
  }, [rows]);

  const toggleAll = useCallback(() => {
    setSelected(previous => rows.length > 0 && rows.every(row => previous.has(row.id)) ? new Set() : new Set(rows.map(row => row.id)));
  }, [rows]);

  const clearSelection = useCallback(() => { setSelected(new Set()); selectionAnchor.current = null; }, []);
  const focusFallback = useCallback(() => gridRef.current ?? searchRef.current, []);

  // The bulk bar unmounts when the selection empties; if focus was on one of its buttons it would fall to <body>.
  const hadSelection = useRef(false);
  useEffect(() => {
    const had = hadSelection.current;
    hadSelection.current = selected.size > 0;
    if (!had || selected.size > 0) return;
    const active = document.activeElement;
    if (!active || active === document.body) focusFallback()?.focus({ preventScroll: true });
  }, [focusFallback, selected.size]);

  // Selection outlives a refresh only for rows that still exist.
  useEffect(() => {
    if (selected.size === 0) return;
    const present = new Set(rows.map(row => row.id));
    if ([...selected].some(id => !present.has(id))) setSelected(new Set([...selected].filter(id => present.has(id))));
  }, [rows, selected]);
  useEffect(() => { if (activeIndex >= rows.length) setActiveIndex(rows.length - 1); }, [activeIndex, rows.length]);

  const move = useCallback((delta: number) => {
    if (rows.length === 0) return;
    setActiveIndex(index => Math.max(0, Math.min(rows.length - 1, index < 0 ? 0 : index + delta)));
    if (document.activeElement === document.body || !document.activeElement) gridRef.current?.focus({ preventScroll: true });
  }, [rows.length]);

  const activeRow = activeIndex >= 0 ? rows[activeIndex] : undefined;
  const focusIsNeutral = () => {
    const active = document.activeElement;
    return !active || active === document.body || active === gridRef.current || active.id === "runphantom-main";
  };
  useRegisterShortcuts([
    { id: "runs:next", keys: "j", scope: "Runs list", description: "Next run", handler: () => move(1) },
    { id: "runs:prev", keys: "k", scope: "Runs list", description: "Previous run", handler: () => move(-1) },
    { id: "runs:open", keys: "enter", scope: "Runs list", description: "Open the highlighted run",
      when: () => !!activeRow && focusIsNeutral(), handler: () => { if (activeRow) open(activeRow.id); } },
    { id: "runs:select", keys: "x", scope: "Runs list", description: "Select or clear the highlighted run",
      when: () => !!activeRow, handler: () => { if (activeRow) toggle(activeRow.id); } },
    { id: "runs:clear-selection", keys: "esc", scope: "Runs list", description: "Clear the selection",
      when: () => selected.size > 0, handler: clearSelection },
  ], [activeRow, move, open, toggle, selected.size, clearSelection]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable) return;
      if (document.querySelector("[role=dialog],[role=alertdialog]")) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const selectedRows = useMemo(() => rows.filter(row => selected.has(row.id)), [rows, selected]);

  const changeColumns = (column: RunsTableColumn) => {
    if (viewColumns) { setViewColumns(toggleColumn(viewColumns, column)); return; }
    const next = toggleColumn(ownColumns, column);
    setOwnColumns(next);
    saveColumns(next);
  };
  const changeDensity = (next: RunsDensity) => { setDensity(next); saveDensity(next); };

  // Leaving pause is enough: useRunsTable reloads the head and highlights the waiting runs.
  const resume = () => {
    clearSelection();
    scrollRef.current?.scrollTo({ top: 0 });
    setScrolled(false);
  };

  const viewModified = !!activeView && (!filtersEqual(activeView.filters, filters) || !sameColumns(activeView.columns, columns));
  const refreshViews = () => queryClient.invalidateQueries({ queryKey: SAVED_VIEWS_KEY, exact: true });

  const samplesOnly = data.status === "ready" && rows.length > 0 && !filtered && rows.every(isSampleRun);
  const empty = data.status === "ready" && data.total === 0;
  const windowLabel = filters.window ? WINDOW_LABELS[filters.window] : filters.since !== undefined || filters.until !== undefined ? "Custom range" : "All time";
  const countLabel = data.total === null ? "Loading runs…"
    : data.total === 0 ? (filtered ? "No matching runs" : "No runs")
    : filtered ? `${plural(data.total, "matching run")}` : plural(data.total, "run");

  const storedTotal = useQuery({
    queryKey: ["runs", "clear-all-total"],
    queryFn: ({ signal }) => listRunsPage({ limit: "1" }, signal).then(page => page.total),
    enabled: dialog === "clear-all" && filtered,
    staleTime: 0,
  });
  const storedRuns = filtered ? storedTotal.data : data.total ?? undefined;
  const everyRun = storedRuns === undefined ? "Every captured run" : storedRuns === 1 ? "The 1 captured run" : `All ${storedRuns.toLocaleString("en-US")} captured runs`;
  const clearAllDescription = (
    <>
      {everyRun} on this machine {storedRuns === 1 ? "is" : "are"} deleted, with {storedRuns === 1 ? "its" : "their"} steps and events.
      {filtered && <> The filters do not apply: this is not limited to the {data.total === null ? "matching runs" : plural(data.total, "matching run")} shown.</>}
      {" "}Saved runs and saved views are kept.
    </>
  );

  const liveState = (
    <span className="flex items-center gap-1.5 text-[12px] text-rp-ink-subtle" title={paused ? "New runs wait while you scroll or select. Scroll to the top or clear the selection to resume." : "New runs appear as they arrive"}>
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", paused ? "bg-rp-ink-faint" : "pulse-dot bg-rp-mark-success")} />
      {paused ? "Paused" : "Live"}
    </span>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-3 px-4 pb-3 pt-4 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div className="min-w-0">
            <Eyebrow marker tone="accent">{activeView ? `Saved view / ${windowLabel}` : `Runs / ${windowLabel}`}</Eyebrow>
            <div className="mt-2 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
              <PageTitle className="!text-[26px] !leading-8">{activeView ? activeView.name : "Runs"}</PageTitle>
              <p role="status" aria-live="polite" className="text-[13px] text-rp-ink-muted">
                {countLabel}{viewModified && <span className="text-rp-warning"> · unsaved changes</span>}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!isMobile && (
              <>
                {liveState}
                <ColumnChooser columns={columns} onToggle={changeColumns} />
                <DensityToggle density={density} onChange={changeDensity} />
                <span aria-hidden="true" className="mx-1 h-5 w-px bg-rp-line" />
              </>
            )}
            {activeView ? (
              <>
                {viewModified && (
                  <Button type="button" size="sm" variant="primary" onClick={async () => {
                    try {
                      await savedViewsApi.update(activeView.id, { filters, columns: activeView.columns ? columns : null });
                      await refreshViews();
                      setMessage(`Saved changes to ${activeView.name}`);
                    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save the view"); }
                  }}>Save changes</Button>
                )}
                <Button type="button" size="sm" variant="secondary" onClick={() => setDialog("save")}><Bookmark aria-hidden="true" />Save as new</Button>
                <Button type="button" size="icon-sm" variant="ghost" aria-label="Rename" title="Rename view" onClick={() => setDialog("rename")}><Pencil aria-hidden="true" /></Button>
                <Button type="button" size="icon-sm" variant="ghost" aria-label="Delete view" title="Delete view" onClick={() => setDialog("delete-view")}><Trash2 aria-hidden="true" /></Button>
              </>
            ) : (
              <Button type="button" size="sm" variant="secondary" onClick={() => setDialog("save")}><Bookmark aria-hidden="true" />Save view</Button>
            )}
            <Button type="button" size="sm" variant="ghost" aria-label="Clear all runs" disabled={empty && !filtered}
              className="text-rp-ink-muted hover:bg-rp-danger-soft hover:text-rp-danger" onClick={() => setDialog("clear-all")}>
              Clear all runs
            </Button>
          </div>
        </div>
        <RunsToolbar
          filters={filters}
          agents={facets.agents}
          models={facets.models}
          compact={isMobile}
          searchRef={searchRef}
          onChange={setFilters}
          onClear={clearFilters}
        />
        {samplesOnly && (
          <p className="flex flex-wrap items-center gap-x-2 rounded-sm border border-rp-wash-border bg-rp-canvas-blue px-3 py-2 text-[13px] text-rp-ink">
            These are sample runs.
            <Link to="/settings" className="font-medium text-rp-blue underline-offset-4 hover:underline">Connect your agent →</Link>
          </p>
        )}
        {message && <p role="status" className="text-[12px] text-rp-ink-muted">{message}</p>}
      </div>

      {selected.size > 0 && (
        <RunsBulkBar
          rows={selectedRows}
          shortIds={shortIds}
          onCompare={(baseline, candidate) => navigate(`${runPath(candidate)}?${new URLSearchParams({ compare: baseline, debugCompare: "1" })}`)}
          onClear={clearSelection}
          onDeleted={ids => { data.removeLocal(ids); setSelected(previous => new Set([...previous].filter(id => !ids.includes(id)))); }}
          announce={setMessage}
          returnFocus={focusFallback}
        />
      )}

      <div className={cn("relative flex min-h-0 flex-1 flex-col transition-opacity duration-state ease-out", data.refreshing && "opacity-60")} aria-busy={data.refreshing || undefined}>
        {paused && data.pendingNew.length > 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-10 z-20 flex justify-center">
            <button type="button" onClick={resume}
              className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full border border-rp-wash-border bg-rp-surface px-3 text-[12px] font-medium text-rp-blue shadow-e2 transition-colors duration-fast ease-out hover:bg-rp-wash focus-visible:outline focus-visible:outline-2 focus-visible:outline-rp-blue">
              <ArrowUp aria-hidden="true" className="size-3.5" />{plural(data.pendingNew.length, "new run")}
            </button>
          </div>
        )}
        {data.status === "error" ? (
          <div role="alert" className="mx-4 mt-4 rounded-sm border border-rp-danger-border bg-rp-danger-soft px-4 py-3 sm:mx-6">
            <p className="text-[13px] font-medium text-rp-danger">Couldn&rsquo;t load runs</p>
            <p className="mt-1 break-words text-[12px] text-rp-ink-muted">{data.error}</p>
            <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={data.retry}>Retry</Button>
          </div>
        ) : empty && !filtered ? (
          <div className="min-h-0 flex-1 overflow-auto border-t border-rp-line">
            <EmptyState onSeeDemoTraces={onLoadSamples} />
          </div>
        ) : empty ? (
          <div className="flex flex-1 flex-col items-center gap-3 border-t border-rp-line px-6 pt-16 text-center">
            <p className="text-[14px] font-medium text-rp-ink">No matching runs</p>
            <p className="max-w-sm text-[13px] text-rp-ink-muted">{windowLabel === "All time" ? "Nothing matches these filters." : `Nothing matches these filters in the ${windowLabel.toLowerCase()}.`}</p>
            <Button type="button" size="sm" variant="secondary" onClick={clearFilters}>Clear filters</Button>
          </div>
        ) : data.status === "loading" ? (
          <div className="flex-1 border-t border-rp-line px-6 pt-6" role="status" aria-live="polite"><span className="rp-eyebrow">Loading runs…</span></div>
        ) : isMobile ? (
          <RunCards rows={rows} shortIds={shortIds} flashIds={data.flashIds} hasMore={data.hasMore} loadingMore={data.loadingMore}
            onLoadMore={data.loadMore} onOpen={open} onScroll={top => setScrolled(top > PAUSE_SCROLL_PX)} scrollRef={scrollRef} />
        ) : (
          <RunsTable
            rows={rows}
            total={data.total}
            columns={columns}
            density={density}
            filters={filters}
            shortIds={shortIds}
            selected={selected}
            activeIndex={activeIndex}
            flashIds={data.flashIds}
            hasMore={data.hasMore}
            loadingMore={data.loadingMore}
            loadMoreError={data.loadMoreError}
            scrollRef={scrollRef}
            gridRef={gridRef}
            onSort={sort => setFilters(nextSort(latestFilters.current, sort))}
            onToggle={toggle}
            onToggleAll={toggleAll}
            onActiveIndexChange={setActiveIndex}
            onOpen={open}
            onLoadMore={data.loadMore}
            onScroll={top => setScrolled(top > PAUSE_SCROLL_PX)}
          />
        )}
      </div>

      <ViewNameDialog
        open={dialog === "save"}
        onOpenChange={value => setDialog(value ? "save" : null)}
        title="Save view"
        description="Saves these filters and the sort order. The view appears in the sidebar with a live count."
        initialName={activeView ? `${activeView.name} copy` : ""}
        submitLabel="Save view"
        includeColumnsChoice
        returnFocus={focusFallback}
        onSubmit={async (name, includeColumns) => {
          const view = await savedViewsApi.create({ name, filters, columns: includeColumns ? columns : null });
          await refreshViews();
          const search = filtersToSearchParams(filters);
          search.set("view", view.id);
          appliedView.current = view.id;
          setViewColumns(view.columns);
          setParams(search, { replace: true });
          setMessage(`Saved view ${view.name}`);
        }}
      />
      {activeView && (
        <ViewNameDialog
          open={dialog === "rename"}
          onOpenChange={value => setDialog(value ? "rename" : null)}
          title="Rename view"
          description="The filters and columns stay the same."
          initialName={activeView.name}
          submitLabel="Rename"
          returnFocus={focusFallback}
          onSubmit={async name => {
            await savedViewsApi.update(activeView.id, { name });
            await refreshViews();
            setMessage(`Renamed the view to ${name}`);
          }}
        />
      )}
      {activeView && (
        <ConfirmDialog
          open={dialog === "delete-view"}
          onOpenChange={value => setDialog(value ? "delete-view" : null)}
          title={`Delete the view ${activeView.name}?`}
          description="Only the saved filters are removed. No runs are deleted."
          confirmLabel="Delete view"
          returnFocus={focusFallback}
          onConfirm={async () => {
            await savedViewsApi.remove(activeView.id);
            await refreshViews();
            const search = new URLSearchParams(params);
            search.delete("view");
            setParams(search, { replace: true });
            setMessage(`Deleted the view ${activeView.name}`);
          }}
        />
      )}
      <ConfirmDialog
        open={dialog === "clear-all"}
        onOpenChange={value => setDialog(value ? "clear-all" : null)}
        title="Clear all runs?"
        description={clearAllDescription}
        confirmLabel="Clear all runs"
        busyLabel="Clearing…"
        returnFocus={focusFallback}
        onConfirm={async () => {
          await clearRuns();
          clearSelection();
          queryClient.setQueryData(["runs"], []);
          void queryClient.invalidateQueries({ queryKey: ["runs"] });
          data.retry();
          setMessage("Cleared all runs");
        }}
      />
    </div>
  );
}

function RunCards({ rows, shortIds, flashIds, hasMore, loadingMore, onLoadMore, onOpen, onScroll, scrollRef }: {
  rows: readonly RunListRow[];
  shortIds: ReadonlyMap<string, string>;
  flashIds: ReadonlySet<string>;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onOpen: (id: string) => void;
  onScroll: (top: number) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div ref={scrollRef} className="sb min-h-0 flex-1 overflow-auto border-t border-rp-line" onScroll={event => onScroll(event.currentTarget.scrollTop)}>
      <ul aria-label="Runs" className="divide-y divide-rp-line-muted">
        {rows.map(row => {
          const status = runStatus(row);
          const tone = runStatusTone(status.status);
          const cost = costCell(row);
          const duration = durationCell(row, "Still running");
          const model = modelCell(row);
          return (
            <li key={row.id} data-run-id={row.id} className={cn(flashIds.has(row.id) && "rp-row-new")}>
              <button type="button" onClick={() => onOpen(row.id)} className="block w-full px-4 py-3 text-left transition-colors duration-fast ease-out hover:bg-rp-row-hover focus-visible:bg-rp-row-hover focus-visible:outline-none">
                <span className="flex items-center gap-2">
                  <span data-run-name className="min-w-0 truncate text-[14px] font-medium text-rp-ink">{runDisplayName(row)}</span>
                  <span className="shrink-0 font-mono text-[11px] text-rp-ink-subtle">{shortIds.get(row.id) ?? row.id}</span>
                  <span className="ml-auto shrink-0 text-[12px] text-rp-ink-muted">{ago(row.started_at)}</span>
                </span>
                <span className="mt-1 flex items-center gap-1.5 text-[12px]" data-run-list-status={status.status}>
                  <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", status.status === "live" ? "pulse-dot bg-rp-mark-success" : STATUS_DOT[tone])} />
                  <span className="text-rp-ink-soft">{status.label}</span>
                </span>
                {row.input_preview && <span className="mt-1 block truncate text-[13px] text-rp-ink-muted">{row.input_preview}</span>}
                <span className="mt-1 flex flex-wrap gap-x-3 font-mono text-[12px] tabular-nums text-rp-ink-muted">
                  {row.agent && row.agent !== runDisplayName(row) && <span className="font-sans">{row.agent}</span>}
                  {row.llm_calls === 0 ? <span className="font-sans">No model calls</span> : (
                    <>
                      <span title={model.title}>{model.unknown ? <span className="font-sans">Model unknown</span> : model.text}</span>
                      <span title={cost.title}>{cost.unknown ? <span className="font-sans">Cost unknown</span> : `${cost.text}${cost.marker ? ` ${cost.marker}` : ""}`}</span>
                    </>
                  )}
                  {!duration.unknown && <span title={duration.title}>{duration.text}</span>}
                  {!!row.error_count && <span className="font-semibold text-rp-danger">{plural(row.error_count, "error")}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {hasMore && (
        <div className="flex justify-center p-4">
          <Button type="button" size="sm" variant="secondary" loading={loadingMore} onClick={onLoadMore}>Load more runs</Button>
        </div>
      )}
    </div>
  );
}
