import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Eyebrow } from "@/components/ui/typography";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DEFAULT_OVERVIEW_WINDOW, OVERVIEW_WINDOW_OPTIONS, getLatestRuns, getOverview, isOverviewWindow, type Overview, type OverviewWindow,
} from "../api/overview";
import { useRunPhantomConnectionStatus, useRunPhantomEvent } from "../hooks/use-runphantom-ws";
import { useRegisterCommands } from "../shell/commands";
import { KpiStrip } from "./overview/HomeKpis";
import { ActivityPanel, AgentsPanel, ModelsPanel, NeedsALookPanel, RunsOverTimePanel } from "./overview/HomePanels";
import { HomeEmptyState } from "./overview/HomeEmptyState";
import { WINDOW_COPY, headlineParts, headlineText, isWorkspaceEmpty } from "./overview/home-model";

const LATEST_RUNS = 8;
// /api/overview aggregates every run in the window (p95 ~50 ms at 5,000 runs over 30d), and a streaming
// agent emits a WebSocket frame per token, so live refreshes are throttled harder than the Runs list's 400 ms.
const LIVE_REFRESH_MS = 1_000;
const CLOCK_TICK_MS = 30_000;

async function replaySampleRuns(): Promise<void> {
  const response = await fetch("/api/demo-traces/replay", { method: "POST" });
  if (response.ok) return;
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  throw new Error(typeof body?.error === "string" ? body.error : "Could not load sample runs.");
}

function useClock(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** One trailing-edge refresh per window, however many WebSocket frames arrive. */
function useThrottledRefresh(refresh: () => void, enabled: boolean) {
  const timer = useRef<number | null>(null);
  const pending = useRef(false);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const schedule = useCallback(() => {
    if (!enabled) return;
    if (timer.current !== null) { pending.current = true; return; }
    refreshRef.current();
    timer.current = window.setTimeout(function settle() {
      timer.current = null;
      if (!pending.current) return;
      pending.current = false;
      schedule();
    }, LIVE_REFRESH_MS);
  }, [enabled]);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  return schedule;
}

export function HomePage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("window");
  const selection: OverviewWindow = isOverviewWindow(requested) ? requested : DEFAULT_OVERVIEW_WINDOW;
  const queryClient = useQueryClient();
  const connection = useRunPhantomConnectionStatus();
  const [live, setLive] = useState(true);
  const [sampleState, setSampleState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  useClock(CLOCK_TICK_MS);

  const overview = useQuery({
    queryKey: ["home", "overview", selection],
    queryFn: ({ signal }) => getOverview(selection, signal),
    placeholderData: keepPreviousData,
    refetchInterval: live ? 60_000 : false,
  });
  const latest = useQuery({
    queryKey: ["home", "latest-runs"],
    queryFn: ({ signal }) => getLatestRuns(LATEST_RUNS, signal),
    refetchInterval: live ? 60_000 : false,
  });

  const refresh = useCallback(() => { void queryClient.invalidateQueries({ queryKey: ["home"] }); }, [queryClient]);
  const scheduleRefresh = useThrottledRefresh(refresh, live);
  useRunPhantomEvent("spans", scheduleRefresh);
  useRunPhantomEvent("live", scheduleRefresh);
  useRunPhantomEvent("clear", scheduleRefresh);

  const setWindow = useCallback((next: OverviewWindow) => {
    setParams(current => {
      const updated = new URLSearchParams(current);
      if (next === DEFAULT_OVERVIEW_WINDOW) updated.delete("window"); else updated.set("window", next);
      return updated;
    }, { replace: true });
  }, [setParams]);

  useRegisterCommands(OVERVIEW_WINDOW_OPTIONS.map((option, index) => ({
    id: `home:window-${option}`,
    group: "Home",
    label: `Show ${WINDOW_COPY[option].option.toLowerCase()}`,
    keywords: ["window", "time range", "period", option],
    detail: () => (option === selection ? "current" : ""),
    order: index,
    run: ({ announce }) => { setWindow(option); announce(`Showing ${WINDOW_COPY[option].option.toLowerCase()}`); },
  })), [selection, setWindow]);

  const loadSamples = async () => {
    setSampleState({ loading: true, error: null });
    try {
      await replaySampleRuns();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["home"] }),
        queryClient.invalidateQueries({ queryKey: ["runs"], exact: true }),
      ]);
      setSampleState({ loading: false, error: null });
    } catch (error) {
      setSampleState({ loading: false, error: (error as Error).message || "Could not load sample runs." });
    }
  };

  const data = overview.data;
  const empty = isWorkspaceEmpty(data, latest.data?.total ?? null);
  const copy = WINDOW_COPY[selection];
  const stale = overview.isPlaceholderData;

  return (
    <div className="rp-page" data-home>
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
        <div className="min-w-0">
          <Eyebrow marker tone="accent">Overview / {copy.eyebrow}</Eyebrow>
          <h1 className="rp-type-headline mt-2 text-rp-ink" data-home-headline>
            {data && !empty ? <Headline overview={data} /> : empty ? "Nothing captured yet." : "Overview"}
          </h1>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <WindowSelector value={selection} onChange={setWindow} />
          <button
            type="button"
            aria-pressed={live}
            onClick={() => setLive(value => !value)}
            title={live ? "Pause live updates" : "Resume live updates"}
            className="flex h-8 items-center gap-2 rounded-control border border-rp-line bg-rp-surface px-3 text-13 text-rp-ink transition-colors duration-fast hover:bg-rp-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--rp-focus)]"
            data-home-live
          >
            <span aria-hidden="true" className={cn("size-2 rounded-full", live && connection === "connected" ? "pulse-dot bg-rp-mark-success" : "bg-[color:var(--rp-ink-faint)]")} />
            {live ? (connection === "connected" ? "Live" : "Reconnecting") : "Paused"}
          </button>
        </div>
      </header>

      <div className="mt-5" aria-busy={overview.isFetching || undefined}>
        {overview.isError && !data ? (
          <OverviewError message={(overview.error as Error).message} onRetry={() => void overview.refetch()} />
        ) : !data ? (
          <HomeSkeleton />
        ) : empty ? (
          <HomeEmptyState onLoadSamples={() => void loadSamples()} loading={sampleState.loading} loadError={sampleState.error} />
        ) : (
          <div className={cn("flex flex-col gap-4 transition-opacity duration-state", stale && "opacity-60")} data-home-dashboard>
            {overview.isError && (
              <p role="alert" className="flex items-center gap-2 rounded-control border border-rp-danger-border bg-rp-danger-soft px-3 py-2 text-13 text-rp-danger">
                Could not refresh: {(overview.error as Error).message}. Showing the last numbers that loaded.
                <Button type="button" variant="link" size="sm" onClick={() => void overview.refetch()}>Retry</Button>
              </p>
            )}
            <KpiStrip overview={data} />
            <div className="grid gap-4 lg:grid-cols-12">
              <div className="min-w-0 lg:col-span-7 2xl:col-span-8"><RunsOverTimePanel overview={data} /></div>
              <div className="min-w-0 lg:col-span-5 2xl:col-span-4"><NeedsALookPanel overview={data} /></div>
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <AgentsPanel overview={data} />
              <ModelsPanel overview={data} />
              <div className="md:col-span-2 xl:col-span-1">
                <ActivityPanel runs={latest.data?.runs ?? []} liveCount={data.liveRuns.length} />
              </div>
            </div>
            <p className="flex items-center gap-1.5 text-12 text-rp-ink-subtle">
              <Clock3 aria-hidden="true" className="size-3.5" />
              Counted by start time · updated {new Date(data.asOf).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              {overview.isFetching && <RefreshCw aria-label="Refreshing" className="size-3.5 animate-spin motion-reduce:animate-none" />}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Headline({ overview }: { overview: Overview }) {
  const parts = headlineParts(overview);
  return (
    <>
      <span className="sr-only">{headlineText(parts)}</span>
      <span aria-hidden="true">
        {parts.map((part, index) => (
          <span key={index} className={cn(part.tone === "danger" && "text-rp-danger")}>
            {(part.tone === "danger" ? part.text.replace(/^ /, "\u00a0") : part.text).split(/(\d[\d.,:]*)/).map((piece, pieceIndex) => pieceIndex % 2 ? <span key={pieceIndex} className="rp-digits">{piece}</span> : piece)}
          </span>
        ))}
      </span>
    </>
  );
}

function WindowSelector({ value, onChange }: { value: OverviewWindow; onChange: (next: OverviewWindow) => void }) {
  return (
    <div role="group" aria-label="Time window" className="flex h-8 overflow-hidden rounded-control border border-rp-line bg-rp-surface" data-home-window>
      {OVERVIEW_WINDOW_OPTIONS.map(option => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          aria-label={WINDOW_COPY[option].option}
          onClick={() => onChange(option)}
          className={cn(
            "min-w-11 border-l border-rp-line px-2.5 font-mono text-12 transition-colors duration-fast first:border-l-0 focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--rp-focus)]",
            option === value ? "bg-rp-wash font-semibold text-rp-blue" : "text-rp-ink-muted hover:bg-rp-row-hover hover:text-rp-ink",
          )}
        >
          {WINDOW_COPY[option].short}
        </button>
      ))}
    </div>
  );
}

function OverviewError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-rp-danger-border bg-rp-danger-soft p-5" data-home-error>
      <p className="text-14 font-semibold text-rp-danger">The overview did not load.</p>
      <p className="mt-1 text-13 text-rp-ink-muted">{message}. Your runs are still on this machine; the Runs page lists them.</p>
      <div className="mt-3 flex gap-2">
        <Button type="button" size="sm" onClick={onRetry}>Try again</Button>
        <Button asChild size="sm" variant="outline"><Link to="/runs">Open Runs</Link></Button>
      </div>
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-label="Loading overview" role="status" data-home-loading>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-rp-line bg-rp-line sm:grid-cols-6 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className={cn("bg-rp-surface px-4 pb-3 pt-3 xl:col-span-1", index === 0 && "col-span-2", index < 3 ? "sm:col-span-2" : "sm:col-span-3")}>
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-3 h-7 w-20" />
            <Skeleton className="mt-3 h-3 w-28" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="rounded-lg border border-rp-line bg-rp-surface p-4 lg:col-span-7"><Skeleton className="h-4 w-32" /><Skeleton className="mt-4 h-[196px] w-full" /></div>
        <div className="rounded-lg border border-rp-line bg-rp-surface p-4 lg:col-span-5"><Skeleton className="h-4 w-24" />{Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="mt-4 h-6 w-full" />)}</div>
      </div>
    </div>
  );
}
