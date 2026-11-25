import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { runPath } from "../utils/navigation";
import { useShortRunIds } from "../components/RunList";
import { RunDetail } from "../components/RunDetail";
import { ReplayView } from "../components/ReplayView";
import { RunComparison } from "../components/RunComparison";
import { useReplay } from "../hooks/use-replay";
import { replayDemoTraces } from "../api/demo-traces";
import { RotateCcw, ArrowRight, X, ArrowLeft } from "lucide-react";
import { fetchPrices, modelPricingConsentEnabled } from "../utils/costs";
import { parseReplayMetadata } from "../utils/types";
import type { Run } from "../utils/types";
import { runDisplayName, safeDecodeParam } from "../utils/helpers";
import { useIsMobile } from "../hooks/use-mobile";
import { useRuns } from "../hooks/use-runs";
import { RunsTableView } from "../runs/RunsTableView";
import { RunRail, useRailRows } from "../runs/RunRail";
import { runsTablePath } from "../runs/last-search";
import { hasActiveFilters } from "../../../src/saved-views-protocol";

const FIRST_TIME_SETUP_DISMISSED_KEY = "runphantom:firstTimeSetupDismissed";

function loadFirstTimeSetupDismissed(): boolean {
  try {
    return localStorage.getItem(FIRST_TIME_SETUP_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveFirstTimeSetupDismissed(): void {
  try {
    localStorage.setItem(FIRST_TIME_SETUP_DISMISSED_KEY, "1");
  } catch {}
}

function isDefaultDemoRun(run: Run): boolean {
  if (run.id.startsWith("demo_")) return true;
  if (!run.metadata) return false;
  try {
    const metadata = JSON.parse(run.metadata);
    return metadata?.demo === true && metadata?.default === true;
  } catch {
    return false;
  }
}

export function RunsPage() {
  const navigate = useNavigate();
  const { runId: routeRunId } = useParams<{ runId?: string }>();
  const selectedId = routeRunId ? safeDecodeParam(routeRunId) : null;
  const allRuns = useRuns();
  const [firstTimeSetupDismissed, setFirstTimeSetupDismissed] = useState(loadFirstTimeSetupDismissed);
  const hasUserTraces = useMemo(() => (allRuns.data ?? []).some((run) => !isDefaultDemoRun(run)), [allRuns.data]);

  useEffect(() => {
    if (modelPricingConsentEnabled()) void fetchPrices();
  }, []);

  useEffect(() => {
    if (!hasUserTraces || firstTimeSetupDismissed) return;
    saveFirstTimeSetupDismissed();
    setFirstTimeSetupDismissed(true);
  }, [firstTimeSetupDismissed, hasUserTraces]);

  const openSamples = useCallback(async () => {
    const runIds = await replayDemoTraces();
    navigate(runPath(runIds[0] ?? "demo_triage"));
  }, [navigate]);

  if (!selectedId) {
    return (
      <div className="h-full">
        <h1 className="sr-only">Runs</h1>
        <RunsTableView onLoadSamples={openSamples} />
      </div>
    );
  }
  return <RunDetailLayout selectedId={selectedId} />;
}

function RunDetailLayout({ selectedId }: { selectedId: string }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const compareBaseline = searchParams.get("compare");
  const isMobile = useIsMobile();
  const [replayOriginalId, setReplayOriginalId] = useState<string | null>(null);
  const [replayCompare, setReplayCompare] = useState(false);
  const replay = useReplay();
  const [hoveredSourceId, setHoveredSourceId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [railScrolled, setRailScrolled] = useState(false);
  const rail = useRailRows(railScrolled);
  const railRows = rail.data.rows;
  const allRuns = useRuns();
  const knownRuns = useMemo(() => {
    const byId = new Map<string, Run>();
    for (const run of allRuns.data ?? []) byId.set(run.id, run);
    for (const run of railRows) byId.set(run.id, run);
    return byId;
  }, [allRuns.data, railRows]);
  const runs = useMemo(() => [...knownRuns.values()], [knownRuns]);

  useEffect(() => {
    if (isMobile && replayCompare) setReplayCompare(false);
  }, [isMobile, replayCompare]);

  useEffect(() => {
    if (replay.replayRunId && replayOriginalId) {
      navigate(runPath(replay.replayRunId), { replace: true });
      listRef.current?.scrollTo({ top: 0 });
    }
  }, [navigate, replay.replayRunId, replayOriginalId]);

  // Ids stay short across every run this page knows, so a row's suffix does not change when the rail pages in more.
  const shortRunIds = useShortRunIds(runs);

  const handleFork = useCallback((sourceRunId: string, userMessage?: string, mode?: "local", model?: string, contextOverrides?: Record<string, any>) => {
    setReplayOriginalId(sourceRunId);
    replay.reset();
    replay.startReplay({ runId: sourceRunId, userMessage, mode: "local", model, contextOverrides });
  }, [replay]);

  const handleSelectRun = useCallback((id: string) => {
    if (replayOriginalId) { replay.reset(); setReplayOriginalId(null); }
    navigate(runPath(id));
  }, [navigate, replay, replayOriginalId]);

  const closeCompare = () => setSearchParams(previous => {
    const next = new URLSearchParams(previous);
    next.delete("compare"); next.delete("debugCompare"); next.delete("debugOffset");
    return next;
  }, { replace: true });

  return (
    <div className="h-full flex">
      <h1 className="sr-only">Runs</h1>
      {!isMobile && (
        <RunRail
          selectedId={selectedId}
          shortRunIds={shortRunIds}
          listRef={listRef}
          highlightedId={hoveredSourceId}
          onSelect={handleSelectRun}
          rows={railRows}
          total={rail.data.total}
          filtered={hasActiveFilters(rail.filters)}
          hasMore={rail.data.hasMore}
          loadingMore={rail.data.loadingMore}
          loadMore={rail.data.loadMore}
          error={rail.data.status === "error" ? rail.data.error : null}
          retry={rail.data.retry}
          onScrolled={setRailScrolled}
        />
      )}

      <div className={`${isMobile && !selectedId ? "hidden" : ""} flex-1 min-w-0 relative overflow-hidden`}>
        {(replay.state !== "idle" || replay.replayRunId) && replayOriginalId
          ? (() => {
              const origRun = knownRuns.get(replayOriginalId);
              const origName = origRun ? runDisplayName(origRun) : replayOriginalId!.slice(0, 12);
              return <ReplayView
                originalRunId={replayOriginalId}
                originalName={origName}
                replayRunId={replay.replayRunId}
                error={replay.error}
                isRunning={replay.state === "running"}
                isCancelled={replay.state === "cancelled"}
                onCancel={() => replay.cancel()}
                onReplay={() => handleFork(replayOriginalId!)}
              />;
            })()
          : selectedId
              ? (() => {
                  const selectedRun = knownRuns.get(selectedId);
                  const meta = selectedRun ? parseReplayMetadata(selectedRun) : null;
                  const srcRun = meta ? knownRuns.get(meta.replay.sourceRunId) : null;
                  const srcName = meta ? (srcRun ? runDisplayName(srcRun) : meta.replay.sourceRunId.slice(0, 12)) : "";
                  return (
                    <div className="h-full flex flex-col">
                      {isMobile && (
                        <button
                          type="button"
                          className="rp-ease flex min-h-11 flex-shrink-0 items-center gap-2 border-b border-rp-line bg-rp-surface px-4 py-2 text-left text-[13px] font-medium text-rp-ink hover:bg-rp-row-hover"
                          onClick={() => navigate(runsTablePath())}
                        >
                          <ArrowLeft aria-hidden="true" className="size-3.5 text-rp-blue" />
                          <span>Back to runs</span>
                        </button>
                      )}
                      {meta && (
                        <div className="z-10 flex flex-shrink-0 border-b border-rp-line bg-rp-canvas-blue">
                          <div
                            className="flex min-w-0 items-center justify-between px-4 py-2"
                            style={{ width: replayCompare ? "50%" : "100%" }}
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <RotateCcw aria-hidden="true" className="size-3 flex-shrink-0 text-rp-blue" />
                              <span className="truncate text-[12px] text-rp-ink-muted">
                                replay of{" "}
                                <button className="font-medium text-rp-ink underline-offset-4 transition-colors duration-250 ease-standard hover:text-rp-blue hover:underline"
                                  onClick={() => { setReplayCompare(false); navigate(runPath(meta.replay.sourceRunId)); }}
                                  onMouseEnter={() => {
                                    const el = listRef.current?.querySelector(`[data-run-id="${meta.replay.sourceRunId}"]`);
                                    if (el) {
                                      const listRect = listRef.current!.getBoundingClientRect();
                                      const elRect = el.getBoundingClientRect();
                                      if (elRect.bottom > listRect.top && elRect.top < listRect.bottom) {
                                        setHoveredSourceId(meta.replay.sourceRunId);
                                      }
                                    }
                                  }}
                                  onMouseLeave={() => setHoveredSourceId(null)}>
                                  {srcName}
                                </button>
                                <span className="rp-meta ml-1.5">({shortRunIds.get(meta.replay.sourceRunId) ?? meta.replay.sourceRunId})</span>
                              </span>
                              {!replayCompare && !isMobile && (
                                <button
                                  className="flex h-7 flex-shrink-0 items-center gap-1 rounded-control border border-rp-line bg-rp-surface px-2 text-[12px] font-medium text-rp-ink transition-[background-color,border-color] duration-250 ease-standard hover:border-rp-wash-border hover:bg-rp-wash"
                                  onClick={() => setReplayCompare(true)}>
                                  compare <ArrowRight aria-hidden="true" className="size-3" />
                                </button>
                              )}
                            </div>
                          </div>

                          {replayCompare && (
                            <>
                              <div className="w-px flex-shrink-0 bg-rp-line" />
                              <div className="flex min-w-0 flex-1 items-center justify-between bg-rp-surface px-4 py-2">
                                <span className="truncate text-[12px] text-rp-ink-muted">
                                  original — <span className="text-rp-ink">{srcName}</span>
                                </span>
                                <button
                                  aria-label="Close comparison"
                                  className="flex size-7 flex-shrink-0 items-center justify-center rounded-control text-rp-ink-muted transition-colors duration-250 ease-standard hover:bg-rp-row-hover hover:text-rp-ink"
                                  onClick={() => setReplayCompare(false)}
                                >
                                  <X aria-hidden="true" className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                      {meta && <RunComparison baselineRunId={meta.replay.sourceRunId} candidateRunId={selectedId} />}
                      {!meta && compareBaseline && compareBaseline !== selectedId && (
                        <>
                          <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-rp-line bg-rp-canvas-blue px-4 py-2">
                            <span className="min-w-0 truncate text-[12px] text-rp-ink-muted">
                              Comparing with baseline{" "}
                              <button type="button" className="font-medium text-rp-ink underline-offset-4 hover:text-rp-blue hover:underline" onClick={() => navigate(runPath(compareBaseline))}>
                                {knownRuns.get(compareBaseline) ? runDisplayName(knownRuns.get(compareBaseline)!) : compareBaseline.slice(0, 12)}
                              </button>
                              <span className="rp-meta ml-1.5">({shortRunIds.get(compareBaseline) ?? compareBaseline})</span>
                            </span>
                            <button type="button" aria-label="Stop comparing" onClick={closeCompare}
                              className="flex size-7 flex-shrink-0 items-center justify-center rounded-control text-rp-ink-muted transition-colors duration-fast ease-out hover:bg-rp-row-hover hover:text-rp-ink">
                              <X aria-hidden="true" className="size-3.5" />
                            </button>
                          </div>
                          <RunComparison baselineRunId={compareBaseline} candidateRunId={selectedId} />
                        </>
                      )}
                      <div className="flex-1 min-h-0 flex">
                        <div className="flex-1 min-w-0 overflow-auto sb">
                          <RunDetail runId={selectedId} routeBase="/runs" onForkStarted={handleFork} />
                        </div>
                        {replayCompare && meta && (
                          <>
                            <div className="w-px flex-shrink-0 bg-rp-line" />
                            <div className="flex-1 min-w-0 overflow-auto sb">
                              <RunDetail key={meta.replay.sourceRunId} runId={meta.replay.sourceRunId} />
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })()
              : null
        }
      </div>
    </div>
  );
}
