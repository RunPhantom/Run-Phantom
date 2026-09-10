import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Search, X } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { EmptyState } from "../components/EmptyState";
import { RunDetail, TraceNotFound } from "../components/RunDetail";
import { RunListItem } from "../components/RunList";
import { listRuns } from "../api/runs";
import { useRunPhantomMessage } from "../hooks/use-runphantom-ws";
import { C } from "../utils/colors";
import { useScrollRestoration } from "../hooks/use-scroll-restoration";
import { runDisplayName, safeDecodeParam } from "../utils/helpers";
import { tracePath } from "../utils/navigation";
import type { Run } from "../utils/types";
import { useIsMobile } from "../hooks/use-mobile";

function matchesQuery(run: Run, query: string): boolean {
  const haystack = [
    runDisplayName(run),
    run.event_name ?? "",
    run.name ?? "",
    run.user_id ?? "",
    run.convo_id ?? "",
    run.id,
  ]
    .join("\n")
    .toLowerCase();

  return haystack.includes(query.toLowerCase());
}

export function SearchPage() {
  const navigate = useNavigate();
  const { runId: routeRunId } = useParams<{ runId?: string }>();
  const selectedId = routeRunId ? safeDecodeParam(routeRunId) : null;
  const searchListRef = useRef<HTMLDivElement>(null);
  // EmptyState renders its own pending/error affordance from the promise, so this
  // only has to do the work and land the user on the trace it created.
  const loadDemoTraces = useCallback(async () => {
    const res = await fetch("/api/demo-traces/replay", { method: "POST" });
    if (!res.ok) throw new Error(`Could not load demo traces (${res.status})`);
    const body = await res.json().catch(() => null) as { runIds?: string[] } | null;
    const first = body?.runIds?.[0];
    if (first) navigate(tracePath("/search", first));
  }, [navigate]);
  useScrollRestoration(searchListRef, "searchpage-list");
  const isMobile = useIsMobile();
  const [runs, setRuns] = useState<Run[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const refreshRuns = useCallback(async () => {
    try {
      setRuns(await listRuns());
    } catch {} finally { setLoaded(true); }
  }, []);

  useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);

  useRunPhantomMessage(refreshRuns);

  useEffect(() => {
    const handleRunRemoved = (event: Event) => {
      const runId = (event as CustomEvent<{ runId?: string }>).detail?.runId;
      if (!runId) return;
      setRuns((prev) => prev.filter((run) => run.id !== runId));
    };
    window.addEventListener("runphantom:run-removed", handleRunRemoved);
    return () => window.removeEventListener("runphantom:run-removed", handleRunRemoved);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "/" && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape" && query) {
        setQuery("");
        searchRef.current?.blur();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [query]);

  const filteredRuns = useMemo(() => {
    if (!query.trim()) return runs;
    return runs.filter((run) => matchesQuery(run, query.trim()));
  }, [query, runs]);

  useEffect(() => {
    if (filteredRuns.length === 0 || selectedId || isMobile) return;
    navigate(tracePath("/search", filteredRuns[0].id), { replace: true });
  }, [filteredRuns, isMobile, navigate, selectedId]);

  const selectedRun = selectedId
    ? filteredRuns.find((run) => run.id === selectedId) ?? runs.find((run) => run.id === selectedId) ?? null
    : null;

  // Only show the heavy onboarding EmptyState once the first fetch has resolved,
  // otherwise it flashes before local runs load.
  if (loaded && runs.length === 0) {
    return <EmptyState onSeeDemoTraces={loadDemoTraces} />;
  }

  return (
    <div className="flex h-full">
      <div
        className={`${isMobile ? (selectedRun ? "hidden" : "w-full") : "w-[280px]"} flex-shrink-0 flex flex-col`}
        style={{ borderRight: isMobile ? "none" : `1px solid ${C.border}` }}
      >
        <div className="px-4 py-4" style={{ borderBottom: `1px solid ${C.border}` }}>
          <div className="flex items-center justify-between gap-3 pl-10 lg:pl-0">
            <div>
              <h1 className="text-[11px] uppercase tracking-[0.18em]" style={{ color: C.fg0 }}>
                Local Search
              </h1>
              <div className="mt-1 text-[14px] font-medium" style={{ color: C.fg4 }}>
                Filter captured runs
              </div>
            </div>
            <div className="rounded-full border px-2 py-1 text-[10px] font-mono" style={{ background: C.surface, color: C.fg1, borderColor: C.border }}>
              {filteredRuns.length}
            </div>
          </div>

          <div className="relative mt-4">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2" style={{ color: C.fg0 }} />
            <input
              ref={searchRef}
              aria-label="Search captured runs"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by title, event, user, conversation, or id"
              className="w-full rounded-xl border pl-9 pr-9 py-2 text-[12px] outline-none transition-colors"
              style={{
                background: C.surface,
                color: C.fg4,
                borderColor: query ? C.selectedBorder : C.border,
              }}
            />
            {query && (
              <button
                type="button"
                className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full transition-colors hover:bg-[color:var(--rp-ink-wash)]"
                onClick={() => setQuery("")}
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" style={{ color: C.fg1 }} />
              </button>
            )}
          </div>

          <p className="mt-3 text-[11px] leading-5" style={{ color: C.fg1 }}>
            Search stays local to this machine. Results update as new runs stream into Run Phantom.
          </p>
        </div>

        <div ref={searchListRef} className="flex-1 overflow-auto px-3 py-3 space-y-1.5 rp-list-scroll">
          {filteredRuns.length === 0 ? (
            <div className="rounded-2xl border px-4 py-5 text-center" style={{ borderColor: C.border, background: C.surface }}>
              <div className="text-[13px] font-medium" style={{ color: C.fg3 }}>
                No matching runs
              </div>
              <p className="mt-2 text-[11px] leading-5" style={{ color: C.fg1 }}>
                Try a shorter phrase, a run type, a user id, or part of the trace id.
              </p>
            </div>
          ) : (
            filteredRuns.map((run) => (
              <RunListItem
                key={run.id}
                run={run}
                selected={selectedRun?.id === run.id}
                onClick={() => navigate(tracePath("/search", run.id))}
              />
            ))
          )}
        </div>
      </div>

      <div className={`${isMobile && !selectedRun ? "hidden" : ""} flex-1 min-w-0`}>
        {selectedRun ? (
          <div className="flex h-full flex-col">
            {isMobile && (
              <button
                type="button"
                className="flex flex-shrink-0 items-center gap-2 py-2 pl-12 pr-4 text-left text-[12px] font-medium"
                style={{ color: C.fg3, borderBottom: `1px solid ${C.border}` }}
                onClick={() => navigate("/search")}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>Back to search</span>
              </button>
            )}
            <div className="min-h-0 flex-1 overflow-auto">
              <RunDetail runId={selectedRun.id} routeBase="/search" />
            </div>
          </div>
        ) : selectedId ? (
          // A deep link whose run no longer exists used to fall through to the
          // generic "nothing selected" prompt, which reads as an empty state
          // rather than a dead link.
          <TraceNotFound runId={selectedId} backPath="/search" />
        ) : (
          <div className="flex h-full items-center justify-center px-8">
            <div className="max-w-md text-center">
              <div className="text-[18px] font-medium" style={{ color: C.fg4 }}>
                Search your local traces
              </div>
              <p className="mt-3 text-[13px] leading-6" style={{ color: C.fg1 }}>
                Pick a run from the left to inspect spans, conversation turns, and replay context without leaving the local workspace.
              </p>

            </div>
          </div>
        )}
      </div>
    </div>
  );
}
