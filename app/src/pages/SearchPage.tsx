import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronDown, Search, Upload, X } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { RunDetail } from "../components/RunDetail";
import { RunListItem, useShortRunIds } from "../components/RunList";
import { replayDemoTraces } from "../api/demo-traces";
import { getOverview } from "../api/overview";
import {
  listRunsPage, searchRuns, searchSpanHits, searchSuggestions, getSearchScope, type RunListRow, type RunSearchMatch, type RunSearchResult, type SearchHitPage,
} from "../api/runs";
import { SearchFilters } from "../components/SearchFilters";
import { SearchSpanHits } from "../components/SearchSpanHits";
import { RunMatchSnippet } from "../components/RunMatchSnippet";
import { useRunPhantomMessage } from "../hooks/use-runphantom-ws";
import { Button } from "@/components/ui/button";
import { EmptyPanel } from "@/components/ui/empty-panel";
import { Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Eyebrow } from "@/components/ui/typography";
import { useScrollRestoration } from "../hooks/use-scroll-restoration";
import { safeDecodeParam } from "../utils/helpers";
import { tracePath } from "../utils/navigation";
import { STATUS_FILTER_OPTIONS, safeSearchHistory, saveSearchHistory } from "../utils/search-state";
import { useIsMobile } from "../hooks/use-mobile";
import { useRegisterShortcuts } from "../shell/commands";
import { RunsTable } from "../runs/RunsTable";
import type { RunsTableColumn } from "../../../src/saved-views-protocol";

const PAGE_SIZE = 50;
const SNIPPET_HEIGHT = 22;
const BROWSE_COLUMNS: readonly RunsTableColumn[] = ["status", "run", "model", "duration", "tokens", "cost", "errors", "started"];
const MATCH_COLUMNS: readonly RunsTableColumn[] = ["status", "run", "model", "tokens", "cost", "errors", "started"];
const NO_IDS: ReadonlySet<string> = new Set();
const noop = () => undefined;
const matchSnippet = (row: SearchResultRow) => row.match ? <RunMatchSnippet match={row.match} matchedSpans={row.matched_span_count} inline /> : null;

/** A search result with the run list's facts (duration, tokens, cost, model) and why it matched. */
export type SearchResultRow = RunListRow & { match: RunSearchMatch | null; matched_span_count: number | null };
type SearchResultPage = Omit<RunSearchResult, "runs"> & { runs: SearchResultRow[]; key: string };

/**
 * Search ranks and explains; /api/runs carries the per-run facts. A run deleted between the two requests is
 * dropped rather than shown with invented values.
 */
async function searchWithFacts(options: Parameters<typeof searchRuns>[0], signal: AbortSignal): Promise<Omit<SearchResultPage, "key">> {
  const page = await searchRuns(options, signal);
  if (!page.runs.length) return { ...page, runs: [] };
  const facts = await listRunsPage({ ids: page.runs.map(run => run.id).join(","), limit: "100" }, signal);
  const byId = new Map(facts.runs.map(row => [row.id, row]));
  const runs = page.runs.flatMap(run => {
    const row = byId.get(run.id);
    return row ? [{ ...row, match: run.match ?? null, matched_span_count: run.matched_span_count ?? null }] : [];
  });
  return { ...page, runs };
}

export function SearchPage() {
  const navigate = useNavigate();
  const { runId: routeRunId } = useParams<{ runId?: string }>();
  const selectedId = routeRunId ? safeDecodeParam(routeRunId) : null;
  const [params, setParams] = useSearchParams();
  const latestParams = useRef(params), renderedQuery = useRef(params.toString());
  if (renderedQuery.current !== params.toString()) { renderedQuery.current = params.toString(); latestParams.current = params; }
  const submitParams = useCallback((next: URLSearchParams) => { latestParams.current = next; setParams(next, { replace: true }); }, [setParams]);
  const query = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const model = params.get("model") ?? "";
  const provider = params.get("provider") ?? "";
  const typed = params.get("filter") ?? undefined;
  const resource = params.get("resource") === "span-hits" ? "span-hits" : "runs";
  const options = useMemo(() => ({ q: query, status, model, provider, filter: typed, limit: PAGE_SIZE }), [query, status, model, provider, typed]);
  const filterKey = JSON.stringify([resource, options]);
  const hasFilters = !!(options.q || status && status !== "all" || options.model || options.provider || typed);
  const activeFilterCount = [status && status !== "all", model, provider, typed].filter(Boolean).length;
  const querySuffix = params.size ? `?${params}` : "";
  const updateFilter = useCallback((key: string, value: string) => {
    const next = new URLSearchParams(latestParams.current);
    if (value) next.set(key, value); else next.delete(key);
    submitParams(next);
  }, [submitParams]);
  const clearFilters = () => submitParams(new URLSearchParams());
  const railListRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  useScrollRestoration(railListRef, "searchpage-list");
  const isMobile = useIsMobile();
  const [result, setResult] = useState<SearchResultPage | null>(null);
  const [hitResult, setHitResult] = useState<(SearchHitPage & { key: string }) | null>(null);
  const [scope, setScope] = useState({ resource: "", key: "" });
  const scopeKey = scope.resource === resource ? scope.key : "";
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [demoLoading, setDemoLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const requestRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const busyRef = useRef(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentRunResult = resource === "runs" && result?.key === filterKey ? result : null;
  const currentHitResult = resource === "span-hits" && hitResult?.key === filterKey ? hitResult : null;
  const currentResult = currentRunResult ?? currentHitResult;
  const runs = currentRunResult?.runs ?? [];
  const hits = error ? [] : currentHitResult?.items ?? [];
  const count = resource === "span-hits" ? hits.length : runs.length;
  useEffect(() => {
    const controller = new AbortController();
    void getSearchScope(resource, controller.signal).then(value => { if (!controller.signal.aborted) setScope({ resource, key: `runphantom:search:local:${value.scope}` }); }, () => {});
    return () => controller.abort();
  }, [resource]);
  const shortRunIds = useShortRunIds(currentRunResult?.runs);
  // A run the user or the page opened stays open for the search it was opened
  // under, even when a refresh pushes it off the loaded page: an imported trace
  // keeps its original started_at, so it can sort below 50 newer runs.
  const [pin, setPin] = useState<{ runId: string; filterKey: string } | null>(null);
  const pinned = !!selectedId && pin?.runId === selectedId && pin.filterKey === filterKey;

  const recordSearch = useCallback(() => {
    const encoded = latestParams.current.toString();
    if (!scopeKey || !latestParams.current.get("q")?.trim() || !safeSearchHistory(encoded)) return;
    try { saveSearchHistory(localStorage, scopeKey, encoded); setHistoryVersion(value => value + 1); } catch {}
  }, [scopeKey]);
  const openRun = useCallback((runId: string, path: string, record = true) => {
    setPin({ runId, filterKey });
    if (record) recordSearch();
    navigate(path);
  }, [filterKey, navigate, recordSearch]);

  useEffect(() => {
    const generation = ++generationRef.current;
    const controller = new AbortController();
    requestRef.current = controller;
    busyRef.current = true;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setActiveIndex(-1);
    const timer = setTimeout(async () => {
      try {
        if (resource === "span-hits") {
          const next = await searchSpanHits(options, controller.signal);
          if (generation !== generationRef.current || controller.signal.aborted) return;
          setHitResult({ ...next, key: filterKey });
        } else {
          const next = await searchWithFacts(options, controller.signal);
          if (generation !== generationRef.current || controller.signal.aborted) return;
          setResult({ ...next, key: filterKey });
        }
      } catch (cause) {
        if (generation !== generationRef.current || controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Search could not be completed.");
      } finally {
        if (generation === generationRef.current && !controller.signal.aborted) {
          busyRef.current = false;
          setLoading(false);
        }
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
      requestRef.current?.abort();
    };
  }, [options, resource, filterKey, refresh]);

  const loadMore = async () => {
    if (!currentResult?.nextCursor || busyRef.current) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    requestRef.current = controller;
    busyRef.current = true;
    setLoadingMore(true);
    setError(null);
    try {
      if (resource === "span-hits") {
        const next = await searchSpanHits({ ...options, cursor: currentResult.nextCursor }, controller.signal);
        if (generation !== generationRef.current || controller.signal.aborted) return;
        setHitResult(previous => {
          if (!previous || previous.key !== filterKey) return previous;
          const seen = new Set(previous.items.map(hit => JSON.stringify([hit.runId, hit.spanId])));
          return { ...next, key: filterKey, items: [...previous.items, ...next.items.filter(hit => !seen.has(JSON.stringify([hit.runId, hit.spanId])))] };
        });
      } else {
        const next = await searchWithFacts({ ...options, cursor: currentResult.nextCursor }, controller.signal);
        if (generation !== generationRef.current || controller.signal.aborted) return;
        setResult(previous => {
          if (!previous || previous.key !== filterKey) return previous;
          const seen = new Set(previous.runs.map(run => run.id));
          return { ...next, key: filterKey, runs: [...previous.runs, ...next.runs.filter(run => !seen.has(run.id))] };
        });
      }
    } catch (cause) {
      if (generation !== generationRef.current || controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : "More results could not be loaded.");
    } finally {
      if (generation === generationRef.current && !controller.signal.aborted) {
        busyRef.current = false;
        setLoadingMore(false);
      }
    }
  };

  // Coalesce ingest bursts and let the current search finish before refreshing.
  const queueRefresh = useCallback(() => {
    if (refreshTimerRef.current) return;
    const refreshWhenIdle = () => {
      if (busyRef.current) {
        refreshTimerRef.current = setTimeout(refreshWhenIdle, 500);
        return;
      }
      refreshTimerRef.current = null;
      setRefresh(value => value + 1);
    };
    refreshTimerRef.current = setTimeout(refreshWhenIdle, 500);
  }, []);
  useRunPhantomMessage<{ event?: string }>(message => {
    if (["spans", "live", "clear"].includes(message.event ?? "")) queueRefresh();
  });
  useEffect(() => {
    window.addEventListener("runphantom:run-removed", queueRefresh);
    return () => {
      window.removeEventListener("runphantom:run-removed", queueRefresh);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [queueRefresh]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const editing = event.target instanceof HTMLElement && (event.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName));
      if (event.key === "/" && !editing && !event.defaultPrevented) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape" && query && !document.querySelector("[role=dialog],[role=alertdialog]")) {
        updateFilter("q", "");
        searchRef.current?.blur();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [query, updateFilter]);

  // The detail pane only ever shows a run from the current results: searching
  // "Z-9999" once listed one match while the pane still showed another run.
  // An open run that leaves the results moves to the first result on desktop,
  // or back to the results when nothing matches (and always on a phone).
  const resultRunIds = useMemo(() => {
    if (error) return null;
    if (currentHitResult) return new Set(currentHitResult.items.map(hit => hit.runId));
    return currentRunResult ? new Set(currentRunResult.runs.map(run => run.id)) : null;
  }, [currentHitResult, currentRunResult, error]);
  const selectedInResults = !!selectedId && !!resultRunIds?.has(selectedId);
  useEffect(() => {
    if (loading || !resultRunIds || !selectedId || selectedInResults || pinned) return;
    if (isMobile) { navigate(`/search${querySuffix}`, { replace: true }); return; }
    const firstHit = currentHitResult?.items[0];
    const firstRun = currentRunResult?.runs[0];
    const next = firstHit ? `${tracePath("/search", firstHit.runId)}/span/${encodeURIComponent(firstHit.spanId)}${querySuffix}`
      : firstRun ? `${tracePath("/search", firstRun.id)}${querySuffix}` : `/search${querySuffix}`;
    navigate(next, { replace: true });
  }, [currentHitResult, currentRunResult, isMobile, loading, navigate, pinned, querySuffix, resultRunIds, selectedId, selectedInResults]);

  const activeRow = activeIndex >= 0 ? runs[activeIndex] : undefined;
  const openRow = useCallback((id: string) => openRun(id, `${tracePath("/search", id)}${querySuffix}`), [openRun, querySuffix]);
  const tableMode = !selectedId;
  const moveActive = useCallback((delta: number) => {
    if (!runs.length) return;
    setActiveIndex(index => Math.max(0, Math.min(runs.length - 1, index < 0 ? 0 : index + delta)));
    if (document.activeElement === document.body || !document.activeElement) gridRef.current?.focus({ preventScroll: true });
  }, [runs.length]);
  useRegisterShortcuts(tableMode && !isMobile && resource === "runs" ? [
    { id: "search:next", keys: "j", scope: "Search results", description: "Next result", handler: () => moveActive(1) },
    { id: "search:prev", keys: "k", scope: "Search results", description: "Previous result", handler: () => moveActive(-1) },
    { id: "search:open", keys: "enter", scope: "Search results", description: "Open the highlighted result",
      when: () => !!activeRow && (document.activeElement === gridRef.current || document.activeElement === document.body),
      handler: () => { if (activeRow) openRow(activeRow.id); } },
  ] : [], [activeRow, isMobile, moveActive, openRow, resource, tableMode]);

  const failingTools = useQuery({
    queryKey: ["search", "failing-tools"],
    queryFn: ({ signal }) => getOverview("30d", signal).then(overview => overview.topFailingTools.slice(0, 3).map(tool => tool.tool)),
    staleTime: 60_000,
    enabled: tableMode || isMobile,
  });

  const loadSamples = async () => {
    setDemoLoading(true);
    setError(null);
    try {
      const [firstRunId] = await replayDemoTraces();
      setRefresh(value => value + 1);
      if (firstRunId) openRun(firstRunId, `${tracePath("/search", firstRunId)}${querySuffix}`, false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load sample runs.");
    } finally {
      setDemoLoading(false);
    }
  };
  const importTrace = async (file: File) => {
    setImportError(null);
    setImporting(true);
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("Choose a trace file smaller than 10 MiB.");
      const payload: unknown = JSON.parse(await file.text());
      const response = await fetch("/api/import-run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json() as { runId?: string; error?: string };
      if (!response.ok || !body.runId) throw new Error(body.error ?? `Could not import trace (${response.status})`);
      setRefresh(value => value + 1);
      openRun(body.runId, `${tracePath("/search", body.runId)}${querySuffix}`, false);
    } catch (cause) {
      setImportError(cause instanceof SyntaxError ? "This file is not valid JSON." : cause instanceof Error ? cause.message : "Could not import trace.");
    } finally {
      setImporting(false);
      if (importRef.current) importRef.current.value = "";
    }
  };

  const statusLine = loading ? "Searching local traces…"
    : currentResult && !error ? `${count} ${resource === "span-hits" ? (count === 1 ? "step" : "steps") : count === 1 ? "run" : "runs"} loaded${currentResult.hasMore ? "; more available" : ""}` : "";
  const order = resource === "span-hits" ? "" : query.trim() ? "Most relevant first" : "Newest first";
  const suggestions = ["error", "timeout", ...(failingTools.data ?? []).filter(tool => tool !== "error" && tool !== "timeout")];

  const filterFields = (
    <div className="grid gap-3">
      <label className="grid gap-1.5">
        <span className="rp-field-label">Status</span>
        <Select value={status} onChange={event => updateFilter("status", event.target.value)} className="h-9 text-13">
          <option value="">All statuses</option>
          {STATUS_FILTER_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="grid min-w-0 gap-1.5">
          <span className="rp-field-label">Model</span>
          <Input value={model} onChange={event => updateFilter("model", event.target.value)} maxLength={256} placeholder="Any model" className="text-13" />
        </label>
        <label className="grid min-w-0 gap-1.5">
          <span className="rp-field-label">Provider</span>
          <Input value={provider} onChange={event => updateFilter("provider", event.target.value)} maxLength={256} placeholder="Any provider" className="text-13" />
        </label>
      </div>
      <p className="rp-field-hint -mt-1">Model and provider match exact names.</p>
      {hasFilters && <Button type="button" variant="link" size="sm" onClick={clearFilters} className="w-fit text-12">Clear all filters</Button>}
      <SearchFilters query={params.toString()} onChange={submitParams} scopeKey={scopeKey} suggestions={searchSuggestions} historyVersion={historyVersion} />
    </div>
  );

  const failureChips = (
    <div role="group" className="flex flex-wrap items-center gap-1.5" aria-label="Find failures">
      <span className="text-12 text-rp-ink-subtle">Find failures:</span>
      {suggestions.map(term => (
        <button key={term} type="button" onClick={() => updateFilter("q", term)} aria-pressed={query === term}
          className={cn("h-7 max-w-full truncate rounded-sm border px-2 font-mono text-12 transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--rp-focus)]",
            query === term ? "border-rp-wash-border bg-rp-wash text-rp-blue" : "border-rp-line text-rp-ink-soft hover:border-rp-line-strong hover:text-rp-ink")}>
          {term}
        </button>
      ))}
    </div>
  );

  const searchBox = (
    <div className="relative">
      <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-rp-ink-subtle" />
      <Input
        ref={searchRef}
        aria-label="Search captured runs"
        aria-describedby="search-scope"
        maxLength={256}
        value={query}
        onChange={event => updateFilter("q", event.target.value)}
        onKeyDown={event => { if (event.key === "Enter") recordSearch(); }}
        placeholder="Errors, tools or any text"
        className={cn("pl-9", query ? "border-rp-blue pr-9" : "pr-3")}
      />
      {query && (
        <button type="button" className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-control text-rp-ink-subtle transition-colors duration-fast hover:bg-rp-row-hover hover:text-rp-ink" onClick={() => updateFilter("q", "")} aria-label="Clear search">
          <X aria-hidden="true" className="size-3.5" />
        </button>
      )}
    </div>
  );

  const importControl = (
    <div>
      <input ref={importRef} type="file" accept=".json,application/json" aria-label="Import trace file" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void importTrace(file); }} />
      <Button type="button" variant="link" size="sm" disabled={importing} onClick={() => importRef.current?.click()} className="h-8 text-12"><Upload aria-hidden="true" className="!size-3.5" />{importing ? "Importing trace…" : "Import trace"}</Button>
      {importError && <div role="alert" className="mt-1 rounded-sm border border-rp-danger-border bg-rp-danger-soft px-3 py-2 text-12 leading-5 text-rp-danger"><strong className="font-semibold">Import failed.</strong> {importError}</div>}
    </div>
  );

  const heading = (
    <div className="min-w-0">
      <Eyebrow marker tone="accent">Search / Captured runs</Eyebrow>
      <h1 className="rp-subsection-title mt-2">Local search</h1>
    </div>
  );

  const resultsBody = (variant: "table" | "list"): ReactNode => {
    if (error) {
      return (
        <div role="alert" className="m-4 rounded-lg border border-rp-danger-border bg-rp-surface px-4 py-4">
          <p className="text-13 font-semibold text-rp-danger">Search unavailable</p>
          <p className="mt-1 break-words text-12 leading-5 text-rp-ink-muted">{error}</p>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setRefresh(value => value + 1)}>Retry search</Button>
        </div>
      );
    }
    if (loading && !currentResult) {
      return (
        <div aria-hidden="true" className="space-y-2 p-4">
          {Array.from({ length: variant === "table" ? 8 : 3 }, (_, item) => <Skeleton key={item} className="h-8 w-full" />)}
        </div>
      );
    }
    if (currentResult && count === 0) {
      return (
        <EmptyPanel
          compact
          className="m-4"
          titleAs="h2"
          title={hasFilters ? "No matching runs" : "No captured runs yet"}
          description={hasFilters ? "Try a shorter phrase, or search “error” to list every run with a failed step." : "Connect an agent or load sample runs to start searching."}
          action={hasFilters
            ? <Button type="button" variant="outline" size="sm" onClick={clearFilters}>Clear filters</Button>
            : <Button type="button" variant="outline" size="sm" loading={demoLoading} onClick={() => void loadSamples()}>{demoLoading ? "Loading sample runs…" : "Load sample runs"}</Button>}
        />
      );
    }
    if (resource === "span-hits") {
      return <div className="p-3"><SearchSpanHits items={hits} open={hit => openRun(hit.runId, `${tracePath("/search", hit.runId)}/span/${encodeURIComponent(hit.spanId)}${querySuffix}`)} /></div>;
    }
    if (variant === "table") {
      return (
        <RunsTable
          rows={runs}
          total={null}
          columns={query.trim() ? MATCH_COLUMNS : BROWSE_COLUMNS}
          density="comfortable"
          filters={{}}
          shortIds={shortRunIds}
          selected={NO_IDS}
          activeIndex={activeIndex}
          flashIds={NO_IDS}
          hasMore={false}
          loadingMore={false}
          loadMoreError={null}
          scrollRef={tableScrollRef}
          gridRef={gridRef}
          onSort={noop}
          onToggle={noop}
          onToggleAll={noop}
          onActiveIndexChange={setActiveIndex}
          onOpen={openRow}
          onLoadMore={noop}
          onScroll={noop}
          label="Matching runs"
          selectable={false}
          sortable={false}
          rowHref={id => `${tracePath("/search", id)}${querySuffix}`}
          renderDetail={query.trim() ? row => matchSnippet(row as SearchResultRow) : undefined}
          detailHeight={SNIPPET_HEIGHT}
        />
      );
    }
    return (
      <ul className="space-y-1 p-2" aria-label="Matching runs">
        {runs.map(run => (
          <li key={run.id}>
            <RunListItem run={run} shortRunIds={shortRunIds} selected={selectedId === run.id}
              detail={run.match ? <RunMatchSnippet match={run.match} matchedSpans={run.matched_span_count} /> : undefined}
              onClick={() => openRun(run.id, `${tracePath("/search", run.id)}${querySuffix}`)} />
          </li>
        ))}
      </ul>
    );
  };

  const loadMoreButton = currentResult?.hasMore && !error ? (
    <div className="shrink-0 border-t border-rp-line bg-rp-surface p-2">
      <Button type="button" variant="outline" size="sm" onClick={() => void loadMore()} disabled={loading} loading={loadingMore} className="w-full">
        {loadingMore ? "Loading more…" : resource === "span-hits" ? "Load more steps" : "Load more runs"}
      </Button>
    </div>
  ) : null;

  const statusBar = (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-rp-line bg-rp-surface px-4 py-2">
      <p role="status" className="text-13 text-rp-ink">{statusLine}</p>
      {order && <p className="text-12 text-rp-ink-subtle">{order}</p>}
    </div>
  );

  // Phone: one column. The list (filters, then results) or the open run, never both.
  if (isMobile) {
    if (selectedId && (selectedInResults || pinned)) {
      return (
        <div className="flex h-full flex-col">
          <button type="button" className="flex min-h-11 shrink-0 items-center gap-2 border-b border-rp-line bg-rp-surface px-4 py-2 text-left text-13 font-medium text-rp-ink transition-colors duration-fast hover:bg-rp-row-hover" onClick={() => navigate(`/search${querySuffix}`)}>
            <ArrowLeft aria-hidden="true" className="size-3.5 text-rp-blue" /><span>Back to search</span>
          </button>
          <div className="min-h-0 flex-1 overflow-auto"><RunDetail key={selectedId} runId={selectedId} routeBase="/search" /></div>
        </div>
      );
    }
    return (
      <div className="h-full overflow-auto bg-rp-canvas" data-search-page>
        <div className="space-y-3 border-b border-rp-line bg-rp-surface px-4 py-4">
          {heading}
          {searchBox}
          <p id="search-scope" className="rp-field-hint">Matches run and step names, models, inputs, outputs and error messages.</p>
          {failureChips}
          <details className="group border-t border-rp-line-muted pt-2">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between text-14 font-medium text-rp-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--rp-focus)] [&::-webkit-details-marker]:hidden">
              <span>Filters{activeFilterCount ? ` · ${activeFilterCount} on` : ""}</span>
              <ChevronDown aria-hidden="true" className="size-4 text-rp-ink-subtle transition-transform duration-state group-open:rotate-180 motion-reduce:transition-none" />
            </summary>
            <div className="pb-2 pt-1">{filterFields}{importControl}</div>
          </details>
        </div>
        <div aria-label="Search results" aria-busy={loading || loadingMore} className="min-w-0">
          {statusBar}
          {resultsBody("list")}
          {loadMoreButton}
        </div>
      </div>
    );
  }

  if (tableMode) {
    return (
      <div className="flex h-full min-h-0" data-search-page>
        <aside aria-label="Search filters" className="sb flex w-[280px] shrink-0 flex-col gap-4 overflow-auto border-r border-rp-line bg-rp-surface px-4 py-4">
          {heading}
          <div className="space-y-2">
            {searchBox}
            <p id="search-scope" className="rp-field-hint">Matches run and step names, models, inputs, outputs and error messages.<span className="hidden lg:inline"> Press / to focus.</span></p>
            {failureChips}
          </div>
          <div className="border-t border-rp-line-muted pt-4">{filterFields}</div>
          <div className="mt-auto border-t border-rp-line-muted pt-2">{importControl}</div>
        </aside>
        <div aria-label="Search results" aria-busy={loading || loadingMore} className="flex min-w-0 flex-1 flex-col bg-rp-surface">
          {statusBar}
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">{resultsBody("table")}</div>
          {loadMoreButton}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0" data-search-page>
      <aside aria-label="Search filters" className="flex w-[280px] shrink-0 flex-col border-r border-rp-line bg-rp-surface">
        <h1 className="sr-only">Local search</h1>
        <div className="shrink-0 space-y-2.5 border-b border-rp-line px-4 py-3">
          <Link to={`/search${querySuffix}`} className="inline-flex items-center gap-1.5 rounded-control text-12 font-medium text-rp-blue underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--rp-focus)]">
            <ArrowLeft aria-hidden="true" className="size-3.5" />All results
          </Link>
          {searchBox}
          <p id="search-scope" className="sr-only">Matches run and step names, models, inputs, outputs and error messages.</p>
          <details className="group">
            <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between rounded-control text-13 font-medium text-rp-ink hover:text-rp-blue focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--rp-focus)] [&::-webkit-details-marker]:hidden">
              <span>Filters{activeFilterCount ? ` · ${activeFilterCount} on` : ""}</span>
              <ChevronDown aria-hidden="true" className="size-3.5 text-rp-ink-subtle transition-transform duration-state group-open:rotate-180 motion-reduce:transition-none" />
            </summary>
            <div className="mt-2 max-h-[50dvh] overflow-auto pb-1">{filterFields}{importControl}</div>
          </details>
        </div>
        <div ref={railListRef} aria-label="Search results" aria-busy={loading || loadingMore} className="sb flex min-h-0 flex-1 flex-col overflow-auto bg-rp-canvas">
          <div className="flex items-baseline justify-between gap-2 px-4 pb-1 pt-2 text-12 text-rp-ink-subtle">
            <p role="status">{statusLine}</p>
            {order && !loading && <span>{order}</span>}
          </div>
          {resultsBody("list")}
          {loadMoreButton}
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        {selectedInResults || pinned
          ? <RunDetail key={selectedId} runId={selectedId!} routeBase="/search" />
          : (
            <div className="flex h-full items-center justify-center px-8 py-10">
              <EmptyPanel className="w-full max-w-lg" eyebrow="Search / Opening" title="Searching…" description="The run opens here once it appears in the results." />
            </div>
          )}
      </div>
    </div>
  );
}
