import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Search, Upload, X } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { RunDetail } from "../components/RunDetail";
import { RunListItem, useShortRunIds } from "../components/RunList";
import { searchRuns, searchSpanHits, searchSuggestions, getSearchScope, type RunSearchResult, type SearchHitPage } from "../api/runs";
import { SearchFilters } from "../components/SearchFilters";
import { SearchSpanHits } from "../components/SearchSpanHits";
import { useRunPhantomMessage } from "../hooks/use-runphantom-ws";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyPanel } from "@/components/ui/empty-panel";
import { Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Eyebrow } from "@/components/ui/typography";
import { useScrollRestoration } from "../hooks/use-scroll-restoration";
import { safeDecodeParam } from "../utils/helpers";
import { tracePath } from "../utils/navigation";
import { useIsMobile } from "../hooks/use-mobile";

const PAGE_SIZE = 50;

export function SearchPage() {
  const navigate = useNavigate();
  const { runId: routeRunId } = useParams<{ runId?: string }>();
  const selectedId = routeRunId ? safeDecodeParam(routeRunId) : null;
  const [params, setParams] = useSearchParams();
  const latestParams=useRef(params), renderedQuery=useRef(params.toString());
  if(renderedQuery.current!==params.toString()){renderedQuery.current=params.toString();latestParams.current=params;}
  const submitParams=useCallback((next:URLSearchParams)=>{latestParams.current=next;setParams(next,{replace:true});},[setParams]);
  const query = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const model = params.get("model") ?? "";
  const provider = params.get("provider") ?? "";
  const typed = params.get("filter") ?? undefined;
  const resource = params.get("resource") === "span-hits" ? "span-hits" : "runs";
  const options = useMemo(() => ({ q: query, status, model, provider, filter: typed, limit: PAGE_SIZE }), [query, status, model, provider, typed]);
  const filterKey = JSON.stringify([resource, options]);
  const hasFilters = !!(options.q || status && status !== "all" || options.model || options.provider || typed);
  const querySuffix = params.size ? `?${params}` : "";
  const updateFilter = useCallback((key: string, value: string) => {
    const next = new URLSearchParams(latestParams.current);
    if (value) next.set(key,value);else next.delete(key);
    submitParams(next);
  }, [submitParams]);
  const clearFilters = () => submitParams(new URLSearchParams());
  const searchListRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  useScrollRestoration(searchListRef, "searchpage-list");
  const isMobile = useIsMobile();
  const [result, setResult] = useState<(RunSearchResult & { key: string }) | null>(null);
  const [hitResult, setHitResult] = useState<(SearchHitPage & { key: string }) | null>(null);
  const [scope, setScope] = useState({resource:"",key:""});
  const scopeKey=scope.resource===resource?scope.key:"";
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [demoLoading, setDemoLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
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
  useEffect(() => {const controller=new AbortController();void getSearchScope(resource,controller.signal).then(value=>{if(!controller.signal.aborted)setScope({resource,key:`runphantom:search:local:${value.scope}`});},()=>{});return ()=>controller.abort();},[resource]);
  const shortRunIds = useShortRunIds(currentRunResult?.runs);

  useEffect(() => {
    const generation = ++generationRef.current;
    const controller = new AbortController();
    requestRef.current = controller;
    busyRef.current = true;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    const timer = setTimeout(async () => {
      try {
        if(resource === "span-hits") { const next=await searchSpanHits(options,controller.signal); if(generation!==generationRef.current||controller.signal.aborted)return;setHitResult({...next,key:filterKey}); }
        else {const next=await searchRuns(options,controller.signal);if(generation!==generationRef.current||controller.signal.aborted)return;setResult({...next,key:filterKey});}
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
      if(resource === "span-hits") {
        const next=await searchSpanHits({...options,cursor:currentResult.nextCursor},controller.signal);
        if(generation!==generationRef.current||controller.signal.aborted)return;
        setHitResult(previous=>{if(!previous||previous.key!==filterKey)return previous;const seen=new Set(previous.items.map(hit=>JSON.stringify([hit.runId,hit.spanId])));return {...next,key:filterKey,items:[...previous.items,...next.items.filter(hit=>!seen.has(JSON.stringify([hit.runId,hit.spanId])))]};});
      } else {
        const next=await searchRuns({...options,cursor:currentResult.nextCursor},controller.signal);
        if(generation!==generationRef.current||controller.signal.aborted)return;
        setResult(previous=>{if(!previous||previous.key!==filterKey)return previous;const seen=new Set(previous.runs.map(run=>run.id));return {...next,key:filterKey,runs:[...previous.runs,...next.runs.filter(run=>!seen.has(run.id))]};});
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
      setRefresh((value) => value + 1);
    };
    refreshTimerRef.current = setTimeout(refreshWhenIdle, 500);
  }, []);
  useRunPhantomMessage<{ event?: string }>((message) => {
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
      if (event.key === "/" && !editing) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape" && query) {
        updateFilter("q", "");
        searchRef.current?.blur();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [query, updateFilter]);

  useEffect(() => {
    if (!currentRunResult?.runs.length || loading || selectedId || isMobile) return;
    navigate(`${tracePath("/search", currentRunResult.runs[0].id)}${querySuffix}`, { replace: true });
  }, [currentRunResult, loading, isMobile, navigate, selectedId, querySuffix]);

  const loadDemoTraces = async () => {
    setDemoLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/demo-traces/replay", { method: "POST" });
      if (!response.ok) throw new Error(`Could not load demo traces (${response.status})`);
      const body = await response.json() as { runIds?: string[] };
      setRefresh((value) => value + 1);
      if (body.runIds?.[0]) navigate(`${tracePath("/search", body.runIds[0])}${querySuffix}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load demo traces.");
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
      setRefresh((value) => value + 1);
      navigate(`${tracePath("/search", body.runId)}${querySuffix}`);
    } catch (cause) {
      setImportError(cause instanceof SyntaxError ? "This file is not valid JSON." : cause instanceof Error ? cause.message : "Could not import trace.");
    } finally {
      setImporting(false);
      if (importRef.current) importRef.current.value = "";
    }
  };
  return (
    <div className="flex h-full">
      <div className={`${isMobile ? (selectedId ? "hidden" : "w-full") : "w-[300px] border-r border-rp-line"} flex min-h-0 flex-shrink-0 flex-col bg-white`}>
        <div className="flex-shrink-0 overflow-auto border-b border-rp-line px-5 py-5" style={{ maxHeight: "66dvh" }}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Eyebrow marker tone="accent">Search / Captured runs</Eyebrow>
              <h1 className="rp-subsection-title mt-2">Local search</h1>
            </div>
            <Badge mono tone="outline" className="mt-0.5" aria-label={`${count}${currentResult?.hasMore ? " or more" : ""} results loaded`}>
              {count}{currentResult?.hasMore ? "+" : ""}
            </Badge>
          </div>
          <div className="relative mt-4">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-rp-ink-muted" />
            <Input
              ref={searchRef}
              aria-label="Search captured runs"
              aria-describedby="search-scope"
              maxLength={256}
              value={query}
              onChange={(event) => updateFilter("q", event.target.value)}
              placeholder="Search by title, event, user, conversation, or id"
              className={`pl-9 pr-9 ${query ? "border-rp-blue" : ""}`}
            />
            {query && <button type="button" className="rp-ease absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-control text-rp-ink-muted hover:bg-rp-row-hover hover:text-rp-ink" onClick={() => updateFilter("q", "")} aria-label="Clear search">
              <X aria-hidden="true" className="size-3.5" />
            </button>}
          </div>
          <p id="search-scope" className="rp-field-hint mt-2">Matches titles, captured inputs and outputs, and tool names across every local run.<span className="hidden lg:inline"> Press / to focus.</span></p>
          <input ref={importRef} type="file" accept=".json,application/json" aria-label="Import trace file" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importTrace(file); }} />
          <Button type="button" variant="link" size="sm" disabled={importing} onClick={() => importRef.current?.click()} className="mt-2 h-8 text-xs"><Upload aria-hidden="true" className="!size-3.5" />{importing ? "Importing trace…" : "Import trace"}</Button>
          {importError && <div role="alert" className="mt-2 rounded-sm border border-rp-danger-border bg-rp-danger-soft px-3 py-2 text-xs leading-5 text-rp-danger"><strong className="font-semibold">Import failed.</strong> {importError}</div>}
          <div className="mt-4 grid gap-3">
            <label className="grid gap-1.5">
              <span className="rp-field-label">Status</span>
              <Select value={status} onChange={(event) => updateFilter("status", event.target.value)} className="text-[13px]">
                <option value="">All statuses</option>
                <option value="running">Running</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
              </Select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="grid min-w-0 gap-1.5">
                <span className="rp-field-label">Model</span>
                <Input value={model} onChange={(event) => updateFilter("model", event.target.value)} maxLength={256} placeholder="Any model" className="text-[13px]" />
              </label>
              <label className="grid min-w-0 gap-1.5">
                <span className="rp-field-label">Provider</span>
                <Input value={provider} onChange={(event) => updateFilter("provider", event.target.value)} maxLength={256} placeholder="Any provider" className="text-[13px]" />
              </label>
            </div>
            <p className="rp-field-hint -mt-1">Model and provider match exact names.</p>
            {hasFilters && <Button type="button" variant="link" size="sm" onClick={clearFilters} className="w-fit text-xs">Clear all filters</Button>}
          </div>
          <SearchFilters query={params.toString()} onChange={submitParams} scopeKey={scopeKey} suggestions={searchSuggestions}/>
        </div>
        <div ref={searchListRef} aria-label="Search results" aria-busy={loading || loadingMore} className="flex-1 space-y-1.5 overflow-auto bg-rp-canvas px-3 py-3 rp-list-scroll">
          <div role="status" className="rp-meta px-2 pb-1 uppercase tracking-[0.12em]">
            {loading ? "Searching local traces…" : currentResult && !error ? `${count} ${resource === "span-hits" ? "spans" : count === 1 ? "run" : "runs"} loaded${currentResult.hasMore ? "; more available" : ""}` : ""}
          </div>
          {loading && !currentResult && !error && <div aria-hidden="true" className="space-y-2 px-2">
            {[0, 1, 2].map((item) => <div key={item} className="space-y-2 rounded-lg border border-rp-line-muted bg-white px-3 py-3"><Skeleton className="h-3.5 w-2/3" /><Skeleton className="h-3 w-1/2" /></div>)}
          </div>}
          {error && <div role="alert" className="animate-fade-rise rounded-lg border border-rp-danger-border bg-white px-4 py-4">
            <Eyebrow className="text-rp-danger">Search / Error</Eyebrow>
            <p className="mt-2 text-[13px] font-semibold text-rp-ink">Search unavailable</p>
            <p className="mt-1 break-words text-xs leading-5 text-rp-ink-muted">{error}</p>
            <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setRefresh((value) => value + 1)}>Retry search</Button>
          </div>}
          {!loading && !error && currentResult && count === 0 && <EmptyPanel
            compact
            className="animate-fade-rise"
            titleAs="h2"
            title={hasFilters ? "No matching runs" : "No captured runs yet"}
            description={hasFilters ? "Try a shorter phrase or clear the filters to browse all captured runs." : "Capture a local agent run or load demo traces to start searching."}
            action={hasFilters ? undefined : <Button type="button" variant="outline" size="sm" loading={demoLoading} onClick={() => void loadDemoTraces()}>{demoLoading ? "Loading demo traces…" : "Load demo traces"}</Button>}
          />}
          {runs.map((run) => <RunListItem key={run.id} run={run} shortRunIds={shortRunIds} selected={selectedId === run.id} onClick={() => navigate(`${tracePath("/search", run.id)}${querySuffix}`)} />)}
          {resource === "span-hits" && <SearchSpanHits items={hits} open={hit=>navigate(`${tracePath("/search",hit.runId)}/span/${encodeURIComponent(hit.spanId)}${querySuffix}`)}/>}
          {currentResult?.hasMore && <Button type="button" variant="outline" size="sm" onClick={() => void loadMore()} disabled={loading} loading={loadingMore} className="w-full">{loadingMore ? "Loading more…" : resource === "span-hits" ? "Load more spans" : "Load more runs"}</Button>}
        </div>
      </div>
      <div className={`${isMobile && !selectedId ? "hidden" : ""} min-w-0 flex-1`}>
        {selectedId ? <div className="flex h-full flex-col">
          {isMobile && <button type="button" className="rp-ease flex min-h-11 flex-shrink-0 items-center gap-2 border-b border-rp-line bg-white px-5 py-2 text-left text-[13px] font-medium text-rp-ink hover:bg-rp-row-hover" onClick={() => navigate(`/search${querySuffix}`)}>
            <ArrowLeft aria-hidden="true" className="size-3.5 text-rp-blue" /><span>Back to search</span>
          </button>}
          <div className="min-h-0 flex-1 overflow-auto"><RunDetail key={selectedId} runId={selectedId} routeBase="/search" /></div>
        </div> : <div className="flex h-full items-center justify-center px-8 py-10">
          <EmptyPanel
            className="w-full max-w-lg animate-fade-rise"
            eyebrow="Search / No run selected"
            title={!loading && currentResult && count === 0 ? "No result to open" : "Pick a run to inspect"}
            description={!loading && currentResult && count === 0 ? "When the search matches a run, choose it on the left to open its trace here." : "Choose a result on the left to open its spans, conversation turns and replay context here."}
          />
        </div>}
      </div>
    </div>
  );
}
