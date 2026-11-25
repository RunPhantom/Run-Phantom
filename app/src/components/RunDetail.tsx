import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { isRunDeleting, subscribeRunDeletions } from "../hooks/use-runs";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  runPath,
  runViewFromPathname,
  traceConvoPath,
  tracePath,
  traceSpanPath,
  traceSpansPath,
  type TraceRouteBase,
} from "../utils/navigation";
import { StickToBottom, useStickToBottomContext, type StickToBottomContext } from "use-stick-to-bottom";
import { Dots } from "./Icons";
import { Button } from "./Button";
import { ChatFlow } from "./ChatFlow";
import { SpanTree } from "./SpanTree";
import { ConvoDetail } from "./ConvoDetail";
import { SavePopover } from "./SavePopover";
import { RotateCcw, Bookmark, Pencil, ChevronDown, ArrowDown, MessageCircle, AlertTriangle } from "lucide-react";
import { LocalAgentSetupCTA, SetupReplayModal } from "./LocalAgentSetupCTA";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { Badge as UiBadge, badgeVariants } from "@/components/ui/badge";
import { fieldClassName } from "@/components/ui/input";
import { runDisplayName, runStatusTone, isoTimestamp, safeDecodeParam } from "../utils/helpers";
import { deriveRunStatus, runErrorEvidenceFromSpans, runInProgress, RUN_QUIET_AFTER_MS, type RunStatusEvidence, type RunStatusSummary } from "../../../src/run-status";
import { useRunStatus } from "../hooks/use-run-status";
import { localRunSummary } from "../utils/run-summary";
import { buildReplayModelOptions } from "../utils/replay-models";
import { captureCompletion, observationReplayUnavailable } from "../../../src/spans/normalized";
import { useQueryClient } from "@tanstack/react-query";
import { parseReplayMetadata } from "../utils/types";
import { renameRun } from "../api/runs";
import type { Run, Span, LiveEvent, SubAgent } from "../utils/types";
import {
  getSavedAnnotationPreview,
  getSavedEvents,
  isEventSaved,
  removeSavedEvent,
  saveEvent,
  type SavedAnnotationPreview,
  type SavedEvent,
  updateSavedEvent,
  useSavedEvent,
} from "../api/saved-runs";
import { parseMessages } from "./MessageList";
import { AnnotationCreatePopover, TraceAnnotations } from "./TraceAnnotations";
import { useAnnotations } from "../hooks/use-annotations";
import type { Annotation, AnnotationKind } from "../hooks/use-annotations";
import { useAgentForEvent } from "../hooks/use-agents";
import { useRunPhantomConnectionStatus, useRunPhantomEvent } from "../hooks/use-runphantom-ws";
import { usePrefersReducedMotion } from "../hooks/use-prefers-reduced-motion";
import { useDialogFocus } from "../hooks/use-dialog-focus";
import { Badge, StatsLine, runStatsFor, type RunStats } from "./run-detail/RunStats";
import { AttachedReportsLink, HEADER_ACTION, MoreMenu } from "./run-detail/RunActionsMenu";
import { failureSentence, type FailureSentence } from "./run-detail/trace-model";

type SpansBroadcast = {
  runIds?: string[];
};

type LiveEventBroadcast = {
  persistedId?: number;
  traceId?: string;
  spanId?: string | null;
  type?: string;
  content?: string | null;
  timestamp?: number;
  metadata?: string | Record<string, unknown> | null;
};

type DetailData = { run: Run; spans: Span[]; liveEvents: LiveEvent[]; subAgents: SubAgent[] };
type DetailContext = {
  lifecycle: object; route: string; tab: string; agentTab: string;
  spanId: string | null; view: string; agentId: string | null;
};
type LiveObservation = { sequence: number; event: LiveEvent; persisted: boolean };
type LiveCoverage = "current-store" | "saved-cache" | "legacy";
type LiveView = {
  base: LiveEvent[]; overlay: LiveObservation[]; coverage: LiveCoverage;
  lifecycle: object | null; generation: number; coveredThrough: number;
};
type DetailOwner = {
  request: number; generation: number; controller: AbortController;
  sequence: number; context: DetailContext; pending: boolean;
};
type DetailLifecycle = {
  runId: string; preloaded: boolean; mounted: boolean; generation: number;
  owner: DetailOwner | null; publication: DetailOwner | null;
  sequence: number;
};

function persistedLiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function liveViewEvents(view: LiveView): LiveEvent[] {
  const events = [...view.base];
  // Cache IDs belong to a historical store, so only a current-store base can
  // acknowledge a native broadcast. Identical rows with different IDs survive.
  const seen = new Set(view.coverage === "current-store" ? view.base.map(event => event.id) : []);
  for (const observation of view.overlay) {
    if (observation.persisted) {
      if (seen.has(observation.event.id)) continue;
      seen.add(observation.event.id);
    }
    events.push(observation.event);
  }
  return view.coverage === "current-store"
    ? events.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id)
    : events;
}

function containsDetailContext(data: DetailData, context: DetailContext): boolean {
  return (!context.spanId || data.spans.some(span => span.id === context.spanId))
    && (context.view !== "convo" || !!data.run.convo_id)
    && (!context.agentId || data.subAgents.some(agent => agent.root_span_id === context.agentId));
}

function handleHorizontalTabKeys(event: ReactKeyboardEvent<HTMLDivElement>): void {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;

  const tabs = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'),
  );
  const currentIndex = tabs.indexOf(event.target as HTMLButtonElement);
  if (currentIndex < 0 || tabs.length === 0) return;

  event.preventDefault();
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? tabs.length - 1
      : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[nextIndex]?.focus();
  tabs[nextIndex]?.click();
}

function toLiveEvent(event: LiveEventBroadcast | undefined): LiveEvent | null {
  if (
    typeof event?.traceId !== "string" ||
    typeof event.type !== "string" ||
    typeof event.timestamp !== "number"
  ) {
    return null;
  }
  return {
    id: persistedLiveId(event.persistedId) ? event.persistedId : event.timestamp,
    trace_id: event.traceId,
    span_id: event.spanId ?? null,
    type: event.type,
    content: event.content ?? null,
    timestamp: event.timestamp,
    metadata: event.metadata ?? null,
  };
}

/** Get token totals per model, only counting root LLM spans to avoid double-counting in ToolLoopAgent */
function getTokensByModel(spans: Span[]): Map<string, { inTok: number; outTok: number }> {
  const byModel = new Map<string, { inTok: number; outTok: number }>();
  // Find root LLM spans — those whose parent is NOT also an LLM span
  const llmIds = new Set(spans.filter(s => s.span_type?.includes("LLM")).map(s => s.id));
  for (const s of spans) {
    if (!s.model || !s.span_type?.includes("LLM")) continue;
    if (!(s.input_tokens || s.output_tokens)) continue;
    // Skip child LLM spans (doGenerate/doStream under a parent LLM)
    if (s.parent_span_id && llmIds.has(s.parent_span_id)) continue;
    const existing = byModel.get(s.model) ?? { inTok: 0, outTok: 0 };
    existing.inTok += s.input_tokens ?? 0;
    existing.outTok += s.output_tokens ?? 0;
    byModel.set(s.model, existing);
  }
  return byModel;
}


function runTabClass(selected: boolean) {
  return cn(
    "rp-tab -mb-px inline-flex h-8 shrink-0 cursor-pointer items-center border-b-2 px-3 text-[13px] font-medium transition-[color,border-color,background-color] duration-250 ease-standard",
    selected ? "border-rp-blue text-rp-ink" : "border-transparent text-rp-ink-muted",
  );
}

function cleanTitle(title: string) {
  return title.replace(/^replay:/i, "").trim();
}

function InlineEdit({ value, onConfirm, className, style, inputStyle }: {
  value: string; onConfirm: (v: string) => void;
  className?: string; style?: React.CSSProperties; inputStyle?: React.CSSProperties;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) { setDraft(value); inputRef.current?.focus(); inputRef.current?.select(); } }, [editing, value]);

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <input ref={inputRef} aria-label="Run title" className={`outline-none ${className ?? ""}`}
          style={{ background: "var(--rp-surface)", border: "1px solid var(--rp-blue)", borderRadius: 4, padding: "0 6px", ...style, ...inputStyle }}
          value={draft} onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { onConfirm(draft); setEditing(false); } if (e.key === "Escape") setEditing(false); }}
          onBlur={() => setEditing(false)}
        />
      </span>
    );
  }
  return (
    <button type="button" aria-label={`Rename ${value}`} title={value} className={`group/edit inline-flex min-w-0 max-w-full items-center gap-1 cursor-pointer bg-transparent text-left ${className ?? ""}`} style={style}
      onClick={() => setEditing(true)}>
      <span className="min-w-0 truncate">{value}</span>
      <Pencil aria-hidden="true" className="size-3 shrink-0 text-rp-ink-muted opacity-0 transition-opacity duration-250 ease-standard group-hover/edit:opacity-100" />
    </button>
  );
}

function buildSavedEventFromRun({
  run,
  spans,
  folder,
  annotationPreview,
}: {
  run: Run;
  spans: Span[];
  folder?: string;
  annotationPreview?: SavedAnnotationPreview;
}): SavedEvent {
  let userInput: string | null = null;
  let assistantOutput: string | null = null;
  const llmSpans = spans.filter(s => s.span_type?.includes("LLM"));
  const best = llmSpans.reduce((b: Span | null, s) =>
    !b || (s.input_payload?.length ?? 0) > (b.input_payload?.length ?? 0) ? s : b, null);
  if (best?.normalized?.kind === "llm" && best.normalized.userMessage) {
    userInput = best.normalized.userMessage;
  } else if (best?.input_payload) {
    const msgs = parseMessages(best.input_payload);
    if (msgs) {
      const lastUser = [...msgs].reverse().find(m => m.role === "user");
      if (lastUser) userInput = lastUser.content;
    }
  }
  const outputSpan = llmSpans.find(s => s.output_payload);
  if (outputSpan?.output_payload) assistantOutput = outputSpan.output_payload;
  const eventName = run.event_name ?? run.name ?? run.id.slice(0, 12);
  const summary = localRunSummary({ name: eventName, userInput, spans });

  return {
    id: run.id,
    event_name: eventName,
    user_id: run.user_id,
    convo_id: run.convo_id,
    timestamp: isoTimestamp(run.started_at),
    user_input: userInput,
    assistant_output: assistantOutput,
    saved_at: Date.now(),
    folder,
    summary,
    properties: { summary_source: "local", local_summary: summary, ...(annotationPreview ? { annotation_preview: annotationPreview } : {}) },
  };
}

function annotationToSavedPreview(annotation: Annotation): SavedAnnotationPreview {
  return {
    id: annotation.id,
    kind: annotation.kind,
    note: annotation.note,
    source: annotation.source,
    span_id: annotation.span_id,
    created_at: annotation.created_at,
  };
}

function ReplayRegistryNotice({ status, onRetry }: {
  status: "pending" | "error";
  onRetry: () => Promise<void>;
}) {
  return (
    <div role={status === "pending" ? "status" : "alert"} className={cn("text-[12px]", status === "error" ? "text-rp-danger" : "text-rp-ink-muted")}>
      {status === "pending" ? "Checking agent replay setup…" : <>
        Could not load agent replay setup.{" "}
        <button type="button" aria-label="Retry agent replay setup" className="font-medium text-rp-blue underline-offset-4 hover:underline" onClick={() => { void onRetry(); }}>Retry</button>
      </>}
    </div>
  );
}

function runStatusEvidence(run: Run, spans: readonly Span[]): RunStatusEvidence {
  const unavailable = run.capture_completion === "unavailable" || spans.some(span => captureCompletion(span.normalized?.capture) === "unavailable");
  return { ...run, ...runErrorEvidenceFromSpans(spans), span_count: spans.length, capture_completion: unavailable ? "unavailable" : null };
}

/** A sub-agent has no root of its own here, so its errors are child errors of a run that is either still live or finished. */
function subAgentStatus(runStatus: RunStatusSummary | null, spans: readonly Span[]): RunStatusSummary {
  const inProgress = runStatus ? runInProgress(runStatus.status) : false;
  const unavailable = spans.some(span => captureCompletion(span.normalized?.capture) === "unavailable");
  const { error_count, tool_error_count } = runErrorEvidenceFromSpans(spans);
  const lastUpdatedAt = runStatus?.status === "live" ? Date.now() : runStatus?.status === "quiet" ? Date.now() - RUN_QUIET_AFTER_MS : null;
  return deriveRunStatus({ last_updated_at: lastUpdatedAt, finished: !inProgress, error_count, tool_error_count, root_failed: false, capture_completion: unavailable ? "unavailable" : null });
}

function ViewHeader({
  title, model, status, stats, allSpans, startedAt, anthropicModels,
  run, isReplay, breadcrumb, fork, onAnnotateRun, annotationError, onDownload, failure, onOpenStep,
}: {
  failure?: FailureSentence | null;
  onOpenStep?: (spanId: string) => void;
  title: string;
  model?: string | null;
  status: RunStatusSummary;
  stats: RunStats;
  allSpans?: Span[];
  startedAt?: number;
  anthropicModels?: string[];
  run?: Run;
  isReplay?: boolean;
  breadcrumb?: { onBack: () => void; parentName: string };
  fork?: {
    onFork: (userMessage?: string, mode?: "local", modelOverride?: string, contextOverrides?: Record<string, any>) => void;
    userMessage?: string;
  };
  onAnnotateRun?: (input: { kind: AnnotationKind; note: string }) => Promise<Annotation | null>;
  annotationError?: string | null;
  onDownload?: () => void;
}) {
  const active = runInProgress(status.status);
  const onBack = breadcrumb?.onBack;
  const parentName = breadcrumb?.parentName;
  const onFork = fork?.onFork;
  const userMessage = fork?.userMessage;
  const replayUnavailable = allSpans?.some(span => observationReplayUnavailable(span.normalized?.capture)) === true;
  const queryClient = useQueryClient();
  const replayMeta = run ? parseReplayMetadata(run) : null;
  const traceModelFromMetadata = replayMeta?.replay?.model ?? null;
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [forkMsg, setForkMsg] = useState(userMessage ?? "");
  const [forkModel, setForkModel] = useState(model ?? "");
  const [agentContext, setAgentContext] = useState<Record<string, string>>({});
  const [contextEdits, setContextEdits] = useState<Record<string, string>>({});
  // Live registry lookup — re-renders whenever the server broadcasts
  // `agents_updated` (e.g. after the user runs `runphantom setup` or hits
  // `/api/agents/refresh`).
  const { configured: agentConfigured, config: agentConfig, registryStatus: agentRegistryStatus, refetch: refetchAgents } = useAgentForEvent(run?.event_name);
  const forkMode = "local" as const;
  const [setupModalOpen, setSetupModalOpen] = useState(false);
  const [isSaved, setIsSaved] = useState(() => run ? isEventSaved(run.id) : false);
  const [currentFolder, setCurrentFolder] = useState<string | null>(() => {
    if (!run) return null;
    return getSavedEvents().find(e => e.id === run.id)?.folder ?? null;
  });
  const [savePopoverOpen, setSavePopoverOpen] = useState(false);
  const saveBtnRef = useRef<HTMLButtonElement>(null);
  const [annotationPopoverOpen, setAnnotationPopoverOpen] = useState(false);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const refresh = () => {
      setIsSaved(run ? isEventSaved(run.id) : false);
      setCurrentFolder(run ? (getSavedEvents().find(e => e.id === run.id)?.folder ?? null) : null);
    };
    refresh();
    window.addEventListener("runphantom:saved-runs:updated", refresh);
    return () => window.removeEventListener("runphantom:saved-runs:updated", refresh);
  }, [run]);

  const handleSave = useCallback((folder?: string) => {
    if (!run) return;
    if (isSaved) {
      removeSavedEvent(run.id);
      setIsSaved(false);
      return;
    }
    saveEvent(buildSavedEventFromRun({ run, spans: allSpans ?? [], folder }));
    setIsSaved(true);
  }, [run, allSpans, isSaved]);

  const optionsRef = useRef<HTMLDivElement>(null);
  const replayOptionsButtonRef = useRef<HTMLButtonElement>(null);
  const replayOptionsId = useId();

  useEffect(() => { setForkMsg(userMessage ?? ""); }, [userMessage]);
  useEffect(() => { setForkModel(model ?? ""); }, [model]);
  const forkModelOptions = useMemo(() => buildReplayModelOptions({
    selectedModel: forkModel,
    runModel: model,
    metadataModel: traceModelFromMetadata,
    anthropicModels,
    agentModels: agentConfig?.models,
  }), [forkModel, model, traceModelFromMetadata, anthropicModels, agentConfig?.models]);
  const handleRename = useCallback((name: string) => {
    if (!run) return;
    renameRun(run.id, name)
      .then(() => Promise.all([
        queryClient.invalidateQueries({ queryKey: ["runs"] }),
        queryClient.invalidateQueries({ queryKey: ["run-detail", run.id] }),
      ]))
      .catch(() => {});
  }, [queryClient, run]);

  useEffect(() => {
    if (replayUnavailable || !optionsOpen || !run?.id || !agentConfigured) return;
    fetch("/api/replay/context", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: run.id, eventName: run.event_name }),
    }).then(r => r.json()).then(data => {
      if (data.context) {
        setAgentContext(data.context);
        setContextEdits(Object.fromEntries(Object.entries(data.context).map(([k, v]) => [k, String(v)])));
      }
    }).catch(() => {});
  }, [optionsOpen, run?.id, run?.event_name, agentConfigured, replayUnavailable]);

  useEffect(() => {
    if (!optionsOpen) return;
    optionsRef.current?.querySelector<HTMLElement>("[data-replay-options] select")?.focus();
    const handlePointer = (event: MouseEvent) => {
      if (!optionsRef.current?.contains(event.target as Node)) setOptionsOpen(false);
    };
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOptionsOpen(false);
      replayOptionsButtonRef.current?.focus();
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [optionsOpen]);
  const displayTitle = cleanTitle(title);
  const headerModels = stats.models ?? (model ? [model] : []);
  const completionUnavailable = run?.capture_completion === "unavailable" || allSpans?.some(span => captureCompletion(span.normalized?.capture) === "unavailable") === true;
  const statusLabel = status.label;
  const statusPillClass = cn(badgeVariants({ tone: runStatusTone(status.status) }), "shrink-0");
  return (
    <div className={cn("flex-shrink-0 bg-rp-surface", isReplay ? "px-4 py-2.5" : "px-4 pb-1.5 pt-2 sm:px-5")}>
      {parentName && onBack ? (
        <>
          <div><Button onClick={onBack}>&larr; Show Parent Agent</Button></div>
          <div className="mt-3 mb-1"><button className="cursor-pointer text-[13px] font-medium text-rp-ink-muted transition-colors duration-250 ease-standard hover:text-rp-blue" onClick={onBack}>{parentName}</button></div>
          <div className="flex items-start ml-1">
            <svg className="flex-shrink-0" width="12" height="24" viewBox="0 0 12 24" style={{ marginRight: 6, marginTop: 2 }}>
              <path d="M 1 0 L 1 16 L 12 16" fill="none" stroke="var(--rp-line-strong)" strokeWidth="1" />
            </svg>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h2 className="font-display text-[18px] font-semibold tracking-[-0.02em] text-rp-ink">{displayTitle}</h2>
                {model && <UiBadge tone="neutral" mono>{model}</UiBadge>}
                <span className={statusPillClass} title={status.detail}>
                  {statusLabel}
                </span>
              </div>
              <StatsLine stats={stats} model={model} spans={allSpans} active={active} startedAt={startedAt} completionUnavailable={completionUnavailable} />
            </div>
          </div>
        </>
      ) : isReplay ? (
        // Not on the title row after a "|": in the side-by-side compare view
        // the stats wrapped below the title and left the "|" dangling.
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[13px] font-semibold text-rp-ink">{displayTitle}</span>
              {model && <UiBadge tone="neutral" mono>{model}</UiBadge>}
            </div>
            <MoreMenu runId={run?.id} />
          </div>
          <StatsLine stats={stats} model={model} spans={allSpans} active={active} startedAt={startedAt} completionUnavailable={completionUnavailable} />
        </div>
      ) : (
        <>
          <div data-run-header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            <div data-run-header-title className="flex min-w-[12rem] flex-1 items-center gap-2">
              {status.status === "live" && <span aria-hidden="true" className="pulse-dot size-2 flex-shrink-0 rounded-full bg-rp-mark-success" />}
              <span className="flex min-w-[3rem]">
                {onFork && !active ? (
                  <InlineEdit value={displayTitle}
                    onConfirm={handleRename}
                    className="truncate font-display text-22 font-semibold leading-7 tracking-[-0.02em] text-rp-ink"
                    inputStyle={{ fontSize: 22, fontWeight: 600 }} />
                ) : (
                  <h2 title={displayTitle} className="min-w-0 truncate font-display text-22 font-semibold leading-7 tracking-[-0.02em] text-rp-ink">{displayTitle}</h2>
                )}
              </span>
              <span
                data-run-status
                data-status={status.status}
                className={statusPillClass}
                title={statusLabel}
              >
                {statusLabel}
              </span>
              {headerModels.length > 0 && (
                <span data-run-models className="hidden min-w-0 items-center gap-1 lg:inline-flex" title={headerModels.join(", ")}>
                  <span className="min-w-0 truncate rounded-sm border border-rp-line px-1.5 py-px font-mono text-12 text-rp-ink-subtle">{headerModels[0]}</span>
                  {headerModels.length > 1 && <span className="shrink-0 text-12 text-rp-ink-subtle">+{headerModels.length - 1}</span>}
                </span>
              )}
            </div>
            {run && (
              <div ref={optionsRef} data-run-actions className="relative flex min-w-0 flex-wrap items-center gap-1.5">
                <button
                  ref={saveBtnRef}
                  className={cn(HEADER_ACTION, isSaved && "border-rp-wash-border bg-rp-wash text-rp-blue hover:bg-rp-wash")}
                  onClick={() => {
                    setAnnotationPopoverOpen(false);
                    if (!isSaved) handleSave();
                    setSavePopoverOpen(true);
                  }}
                  title={isSaved ? "Move folder or unsave" : "Save run"}
                >
                  <Bookmark aria-hidden="true" className={cn(isSaved && "fill-current")} />
                  {isSaved ? "Saved" : "Save"}
                </button>
                {savePopoverOpen && (
                  <SavePopover
                    anchorRef={saveBtnRef}
                    currentFolder={currentFolder}
                    onSave={(folder) => { if (run) updateSavedEvent(run.id, { folder }); setSavePopoverOpen(false); }}
                    onUnsave={() => { if (run) { removeSavedEvent(run.id); setIsSaved(false); setCurrentFolder(null); } setSavePopoverOpen(false); }}
                    onClose={() => setSavePopoverOpen(false)}
                  />
                )}
                <button
                  className={HEADER_ACTION}
                  onClick={() => {
                    setSavePopoverOpen(false);
                    setAnnotationPopoverOpen(false);
                    setOptionsOpen(false);
                    window.dispatchEvent(new CustomEvent("runphantom:open-message-pane", { detail: { runId: run?.id } }));
                  }}
                  title="Ask your coding agent about this run"
                >
                  <MessageCircle aria-hidden="true" />
                  Debug
                </button>
                {onFork && (() => {
                  return <>
                  <div className="rp-clipped-ring flex h-8 items-stretch overflow-hidden rounded-control md:h-7">
                    <button
                      disabled={active || replayUnavailable || agentRegistryStatus !== "success"}
                      title={active ? "Replay is available once the run finishes" : undefined}
                      className="rp-primary-control flex items-center gap-1.5 border border-rp-blue bg-rp-blue px-3 text-[12px] font-medium text-white transition-[background-color,border-color] duration-250 ease-standard hover:border-rp-blue-hover hover:bg-rp-blue-hover disabled:cursor-not-allowed disabled:border-rp-line disabled:bg-[color:var(--rp-n4)] disabled:text-rp-ink-muted"
                      onClick={() => {
                        if (active || replayUnavailable || agentRegistryStatus !== "success") return;
                        if (agentConfigured) {
                          onFork(undefined, forkMode, forkModel || undefined);
                        } else {
                          setSetupModalOpen(true);
                        }
                      }}
                    >
                      <RotateCcw aria-hidden="true" className="size-3.5" />
                      Replay
                    </button>
                    <button
                      ref={replayOptionsButtonRef}
                      type="button"
                      aria-label="Replay with options"
                      aria-expanded={optionsOpen}
                      aria-controls={optionsOpen ? replayOptionsId : undefined}
                      aria-haspopup="dialog"
                      disabled={active || replayUnavailable || agentRegistryStatus !== "success"}
                      className="rp-primary-control flex items-center justify-center border border-l-0 border-rp-blue bg-rp-blue px-2 text-white shadow-[inset_1px_0_0_rgb(255_255_255/0.28)] transition-[background-color,border-color] duration-250 ease-standard hover:border-rp-blue-hover hover:bg-rp-blue-hover disabled:cursor-not-allowed disabled:border-rp-line disabled:bg-[color:var(--rp-n4)] disabled:text-rp-ink-muted disabled:shadow-[inset_1px_0_0_var(--rp-line)]"
                      onClick={() => {
                        if (active || replayUnavailable) return;
                        setAnnotationPopoverOpen(false);
                        setOptionsOpen(!optionsOpen);
                      }}
                      title="Replay with options"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {!replayUnavailable && agentRegistryStatus !== "success" && <ReplayRegistryNotice status={agentRegistryStatus} onRetry={refetchAgents} />}
                  <SetupReplayModal
                    open={setupModalOpen && !replayUnavailable}
                    onClose={() => setSetupModalOpen(false)}
                    eventName={run?.event_name ?? undefined}
                  />
                  {optionsOpen && !replayUnavailable && (
                    <div
                      id={replayOptionsId}
                      data-replay-options
                      role="dialog"
                      aria-label="Replay options"
                      className="rp-pop fixed z-[9999] space-y-4 rounded-md border border-rp-line bg-rp-surface p-4 shadow-e3"
                      ref={(el) => {
                        if (!el || !optionsRef.current) return;
                        const btn = optionsRef.current.getBoundingClientRect();
                        el.style.top = `${btn.bottom + 4}px`;
                        el.style.right = `${window.innerWidth - btn.right}px`;
                      }}
                      style={{ width: "min(384px, calc(100vw - 32px))" }}>
                      {agentRegistryStatus === "success" && !agentConfigured && (
                        <LocalAgentSetupCTA eventName={run?.event_name ?? undefined} />
                      )}
                      <div>
                        <div className="rp-field-label mb-1.5">Model</div>
                        <select
                          aria-label="Replay model"
                          className={cn(fieldClassName, "rp-select h-9 cursor-pointer pr-9 font-mono text-[12px]")}
                          value={forkModel}
                          onChange={e => setForkModel(e.target.value)}
                        >
                          <option value="">
                            {traceModelFromMetadata ? `Use trace default (${traceModelFromMetadata})` : "Use trace default model"}
                          </option>
                          {forkModelOptions.map((candidate) => (
                            <option key={candidate} value={candidate}>
                              {candidate === traceModelFromMetadata ? `${candidate} (original trace model)` : candidate}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <div className="rp-field-label mb-1.5">User message</div>
                        <textarea
                          aria-label="Replay user message"
                          className={cn(fieldClassName, "resize-y py-2 font-mono text-[12px] leading-5")}
                          style={{ minHeight: 72, maxHeight: 200 }}
                          value={forkMsg}
                          onChange={e => setForkMsg(e.target.value)}
                          placeholder="Enter user message..."
                        />
                      </div>
                      {Object.keys(contextEdits).length > 0 && (
                        <div>
                          <div className="rp-field-label mb-1.5">Context</div>
                          <div className="space-y-1.5">
                            {Object.entries(contextEdits).map(([key, val]) => (
                              <div key={key} className="flex items-center gap-2">
                                <span className="rp-meta w-24 flex-shrink-0 truncate" title={key}>{key}</span>
                                <input
                                  aria-label={`Replay context ${key}`}
                                  className={cn(fieldClassName, "h-8 flex-1 px-2 font-mono text-[11px]")}
                                  value={val}
                                  onChange={e => setContextEdits(prev => ({ ...prev, [key]: e.target.value }))}
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      <button
                        disabled={replayUnavailable || agentRegistryStatus !== "success"}
                        className={cn(buttonVariants({ variant: "primary", size: "sm" }), "w-full")}
                        onClick={() => {
                          if (replayUnavailable || agentRegistryStatus !== "success") return;
                          if (!agentConfigured) {
                            setOptionsOpen(false);
                            setSetupModalOpen(true);
                            return;
                          }
                          setOptionsOpen(false);
                          const ctxOverrides = Object.keys(contextEdits).length > 0
                            ? Object.fromEntries(Object.entries(contextEdits).filter(([k, v]) => v !== String(agentContext[k] ?? "")))
                            : undefined;
                          onFork(forkMsg || undefined, forkMode, forkModel || undefined, Object.keys(ctxOverrides ?? {}).length ? ctxOverrides : undefined);
                        }}
                      >
                        Replay
                      </button>
                    </div>
                  )}
                </>;
                })()}
                <MoreMenu
                  runId={run?.id}
                  triggerRef={moreBtnRef}
                  onAnnotate={onAnnotateRun ? () => { setSavePopoverOpen(false); setOptionsOpen(false); setAnnotationPopoverOpen(true); } : undefined}
                  onDownload={onDownload}
                />
                {annotationPopoverOpen && onAnnotateRun && (
                  <AnnotationCreatePopover
                    anchorRef={moreBtnRef}
                    onClose={() => setAnnotationPopoverOpen(false)}
                    onSubmit={onAnnotateRun}
                    error={annotationError}
                  />
                )}
              </div>
            )}
          </div>
          {failure && (
            <button
              type="button"
              data-run-failure={failure.tone}
              title={onOpenStep ? `${failure.text}. Open this step.` : failure.text}
              onClick={onOpenStep ? () => onOpenStep(failure.spanId) : undefined}
              disabled={!onOpenStep}
              className={cn("mt-0.5 flex max-w-full items-center gap-1.5 rounded-control text-left text-13 font-medium leading-5 underline-offset-4 enabled:hover:underline disabled:cursor-default",
                failure.tone === "danger" ? "text-rp-danger" : "text-rp-ink")}
            >
              <AlertTriangle aria-hidden="true" className={cn("size-3.5 shrink-0", failure.tone === "danger" ? "text-rp-danger" : "text-rp-warning")} />
              <span className="min-w-0 truncate">{failure.text}</span>
            </button>
          )}
          {!active && onFork && replayUnavailable && <div role="status" className="mb-1 basis-full text-[12px] text-rp-ink-muted">Replay unavailable for partial, unverified observations.</div>}
          {/* Not on the stats row after a separator: at laptop widths the ids
              wrapped and left the separator dangling at the end of the stats. */}
          <div className="mt-1 flex flex-col gap-0.5 text-12">
            <StatsLine stats={stats} model={model} spans={allSpans} active={active} startedAt={startedAt} completionUnavailable={completionUnavailable} hideModels />
            {run && (run.id || run.user_id || run.convo_id) && (
              // Ids are one tap away in the step details; on a phone this row cost the trace two lines.
              <span className="rp-meta-ids hidden min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-1 text-rp-ink-muted md:flex">
                {run.user_id && <span className="inline-flex items-center gap-1" title={run.user_id}><Badge label="user" copyValue={run.user_id} />{run.user_id.length > 12 ? run.user_id.slice(0, 12) + "…" : run.user_id}</span>}
                {run.convo_id && <span className="inline-flex items-center gap-1" title={run.convo_id}><Badge label="conversation" copyValue={run.convo_id} />{run.convo_id.length > 12 ? run.convo_id.slice(0, 12) + "…" : run.convo_id}</span>}
                <span className="inline-flex min-w-0 items-center gap-1"><Badge label="trace" copyValue={run.id} /><span className="min-w-0 truncate" title={run.id}>{run.id}</span></span>
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function EditReplayModal({ userMessage, model, runId, eventName, traceModelFromMetadata, anthropicModels, onReplay, onClose }: {
  userMessage: string; model?: string | null; runId: string; eventName?: string;
  traceModelFromMetadata?: string | null;
  anthropicModels?: string[];
  onReplay: (msg: string, mode: "local", mdl?: string, ctxOverrides?: Record<string, any>) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [msg, setMsg] = useState(userMessage);
  const [mdl, setMdl] = useState(model ?? "");
  const mode = "local" as const;
  // Live registry lookup; re-renders on `agents_updated` WS event, so the
  // modal reflects registry changes that happen while it's open (rare but
  // possible if the user runs the slash command in another window).
  const { configured: agentConfigured, config: agentConfig, registryStatus: agentRegistryStatus, refetch: refetchAgents } = useAgentForEvent(eventName);
  const [agentContext, setAgentContext] = useState<Record<string, string>>({});
  const [contextEdits, setContextEdits] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!agentConfigured) return;
    fetch("/api/replay/context", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId, eventName }),
    }).then(r => r.json()).then(data => {
      if (data.context) {
        setAgentContext(data.context);
        setContextEdits(Object.fromEntries(Object.entries(data.context).map(([k, v]) => [k, String(v)])));
      }
    }).catch(() => {});
  }, [runId, eventName, agentConfigured]);

  useDialogFocus(agentRegistryStatus !== "success" || agentConfigured, dialogRef, onClose);
  const modalModelOptions = useMemo(() => buildReplayModelOptions({
    selectedModel: mdl,
    runModel: model,
    metadataModel: traceModelFromMetadata,
    anthropicModels,
    agentModels: agentConfig?.models,
  }), [mdl, model, traceModelFromMetadata, anthropicModels, agentConfig?.models]);

  const handleReplay = () => {
    if (agentRegistryStatus !== "success" || !agentConfigured) return;
    const ctxOverrides = mode === "local" && Object.keys(contextEdits).length > 0
      ? Object.fromEntries(Object.entries(contextEdits).filter(([k, v]) => v !== String(agentContext[k] ?? "")))
      : undefined;
    onClose();
    onReplay(msg, mode, mdl || undefined, Object.keys(ctxOverrides ?? {}).length ? ctxOverrides : undefined);
  };

  if (agentRegistryStatus === "success" && !agentConfigured) {
    return (
      <SetupReplayModal
        open={true}
        onClose={onClose}
        eventName={eventName}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center px-4" style={{ background: "var(--rp-scrim-soft)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="edit-replay-title" className="rp-fade-rise max-h-[calc(100svh-32px)] w-full max-w-md space-y-4 overflow-auto rounded-lg border border-rp-line bg-rp-surface p-5 shadow-e4 sm:p-6">
        <h2 id="edit-replay-title" className="rp-subsection-title">Edit &amp; Replay</h2>
        {agentRegistryStatus !== "success" && <ReplayRegistryNotice status={agentRegistryStatus} onRetry={refetchAgents} />}

        <div>
          <div className="rp-field-label mb-1.5">Model</div>
          <select
            aria-label="Replay model"
            className={cn(fieldClassName, "rp-select h-9 cursor-pointer pr-9 font-mono text-[12px]")}
            value={mdl}
            onChange={e => setMdl(e.target.value)}
          >
            <option value="">
              {traceModelFromMetadata ? `Use trace default (${traceModelFromMetadata})` : "Use trace default model"}
            </option>
            {modalModelOptions.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate === traceModelFromMetadata ? `${candidate} (original trace model)` : candidate}
              </option>
            ))}
          </select>
        </div>

        <div>
          <div className="rp-field-label mb-1.5">User message</div>
          <textarea
            autoFocus
            aria-label="Replay user message"
            className={cn(fieldClassName, "resize-y py-2 font-mono text-[12px] leading-5")}
            style={{ minHeight: 100, maxHeight: 300 }}
            value={msg} onChange={e => setMsg(e.target.value)}
            placeholder="Enter user message..."
          />
        </div>

        {Object.keys(contextEdits).length > 0 && (
          <div>
            <div className="rp-field-label mb-1.5">Context</div>
            <div className="space-y-1.5">
              {Object.entries(contextEdits).map(([key, val]) => (
                <div key={key} className="flex items-center gap-2">
                  <span className="rp-meta w-28 flex-shrink-0 truncate" title={key}>{key}</span>
                  <input
                    aria-label={`Replay context ${key}`}
                    className={cn(fieldClassName, "h-8 flex-1 px-2 font-mono text-[11px]")}
                    value={val}
                    onChange={e => setContextEdits(prev => ({ ...prev, [key]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            className={buttonVariants({ variant: "secondary", size: "sm" })}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            disabled={agentRegistryStatus !== "success"}
            className={buttonVariants({ variant: "primary", size: "sm" })}
            onClick={handleReplay}
          >
            Replay
          </button>
        </div>
      </div>
    </div>
  );
}

// Rendered as a grid row below the scroll viewport, not overlaid on it: an overlay
// pinned to the viewport bottom covered the last message whenever the view was
// close to, but not at, the end. Callers give the StickToBottom root STICK_LAYOUT.
function ScrollToBottomButton() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  const prefersReducedMotion = usePrefersReducedMotion();
  if (isAtBottom) return null;
  return (
    <div data-testid="scroll-to-bottom-gutter" className="flex justify-center border-t border-rp-line bg-rp-surface py-2">
      <button
        type="button"
        onClick={() => scrollToBottom({ animation: prefersReducedMotion ? "instant" : "smooth" })}
        className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "rp-fade-rise gap-1.5 [&_svg]:size-3")}
      >
        <ArrowDown aria-hidden="true" />
        Scroll to bottom
      </button>
    </div>
  );
}
const STICK_LAYOUT = "relative grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] overflow-hidden";

export function TraceNotFound({ runId, backPath }: { runId: string; backPath: string }) {
  const navigate = useNavigate();
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="rp-fade-rise w-full max-w-md rounded-lg border border-dashed border-rp-line-dashed bg-rp-surface px-6 py-8 text-center">
        <p className="rp-eyebrow justify-center"><span aria-hidden="true" className="rp-eyebrow-marker" />Runs / Not found</p>
        <div className="mt-3 font-display text-[20px] font-semibold tracking-[-0.02em] text-rp-ink">Trace not found</div>
        <div className="mt-2 text-[13px] leading-6 text-rp-ink-muted">
          This trace is not available in the current workspace. It may have been deleted, cleared, or opened from a different project.
        </div>
        <code className="rp-meta mt-4 block truncate rounded-sm border border-rp-line bg-rp-canvas-blue px-2 py-1.5" title={runId}>
          {runId}
        </code>
        <button
          type="button"
          className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "mt-5")}
          onClick={() => navigate(backPath, { replace: true })}
        >
          Back to traces
        </button>
      </div>
    </div>
  );
}

export function RunDetail({ runId, routeBase, initialData, isReplay, onForkStarted }: {
  runId: string;
  /** URL namespace that owns this detail view. Omit for embedded compare/replay panes. */
  routeBase?: TraceRouteBase;
  initialData?: { run: Run; spans: Span[]; liveEvents?: LiveEvent[]; subAgents?: SubAgent[] };
  isReplay?: boolean;
  onForkStarted?: (runId: string, userMessage?: string, mode?: "local", model?: string, contextOverrides?: Record<string, any>) => void;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const tabIdPrefix = useId().replace(/:/g, "");
  const agentOverviewTabId = `${tabIdPrefix}-agent-overview`;
  const agentSpansTabId = `${tabIdPrefix}-agent-spans`;
  const agentPanelId = `${tabIdPrefix}-agent-panel`;
  const runOverviewTabId = `${tabIdPrefix}-run-overview`;
  const runSpansTabId = `${tabIdPrefix}-run-spans`;
  const runConversationTabId = `${tabIdPrefix}-run-conversation`;
  const runPanelId = `${tabIdPrefix}-run-panel`;
  const [data, setData] = useState<DetailData | null>(
    initialData ? { run: initialData.run, spans: initialData.spans, liveEvents: initialData.liveEvents ?? [], subAgents: initialData.subAgents ?? [] } : null
  );
  const dataRef = useRef(data);
  const navigate = useNavigate();
  const { spanId: routeSpanId } = useParams<{ spanId?: string }>();
  const { pathname, search } = useLocation();
  const searchQuery = routeBase === "/search" ? search : "";
  const usesRouteState = routeBase !== undefined;
  const runView = usesRouteState ? runViewFromPathname(pathname) : "overview";
  const tab: "chat" | "tree" | "convo" =
    usesRouteState
      ? runView === "convo" ? "convo" : runView === "spans" || runView === "span" ? "tree" : "chat"
      : "chat";
  const routeSelectedSpanId = routeSpanId ? safeDecodeParam(routeSpanId) : null;
  const [localTab, setLocalTab] = useState<"chat" | "tree" | "convo">("chat");
  const [localSelectedSpanId, setLocalSelectedSpanId] = useState<string | null>(null);
  const activeTab = usesRouteState ? tab : localTab;
  const selectedSpanId = usesRouteState ? routeSelectedSpanId : localSelectedSpanId;
  const [loading, setLoading] = useState(!initialData);
  const [notFound, setNotFound] = useState(false);
  const [agentTab, setAgentTab] = useState<"chat" | "tree">("chat");
  const [liveView, setLiveView] = useState<LiveView>({ base: initialData?.liveEvents ?? [], overlay: [], coverage: "legacy", lifecycle: null, generation: 0, coveredThrough: 0 });
  const liveEvents = useMemo(() => liveViewEvents(liveView), [liveView]);
  const [anthropicModels, setAnthropicModels] = useState<string[]>([]);
  const annotationsApi = useAnnotations(runId);
  const autoSavedAnnotationIdsRef = useRef<Set<string>>(new Set());
  const stickToBottomContextRef = useRef<StickToBottomContext | null>(null);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    let cancelled = false;
    const fetchModels = () => {
      fetch("/api/models/anthropic")
        .then(r => r.ok ? r.json() : null)
        .then((data) => {
          if (cancelled) return;
          if (Array.isArray(data?.models)) setAnthropicModels(data.models);
        })
        .catch(() => {});
    };
    fetchModels();
    const onKeyChange = () => fetchModels();
    window.addEventListener("runphantom:api-key-change", onKeyChange);
    return () => {
      cancelled = true;
      window.removeEventListener("runphantom:api-key-change", onKeyChange);
    };
  }, []);

  const goOverview = useCallback(() => {
    if (routeBase) navigate(`${tracePath(routeBase, runId)}${searchQuery}`);
    else setLocalTab("chat");
  }, [navigate, routeBase, runId, searchQuery]);
  const goSpans = useCallback(() => {
    if (routeBase) navigate(`${traceSpansPath(routeBase, runId)}${searchQuery}`);
    else setLocalTab("tree");
  }, [navigate, routeBase, runId, searchQuery]);
  const goConvo = useCallback(() => {
    if (routeBase) navigate(`${traceConvoPath(routeBase, runId)}${searchQuery}`);
    else setLocalTab("convo");
  }, [navigate, routeBase, runId, searchQuery]);
  const selectSpan = useCallback(
    (spanId: string | null) => {
      if (routeBase) {
        if (spanId) navigate(`${traceSpanPath(routeBase, runId, spanId)}${searchQuery}`);
        else navigate(`${traceSpansPath(routeBase, runId)}${searchQuery}`);
        return;
      }
      setLocalTab("tree");
      setLocalSelectedSpanId(spanId);
    },
    [navigate, routeBase, runId, searchQuery],
  );
  const openConversationTurn = useCallback((id: string) => {
    if (routeBase === "/saved" && (id === runId || isEventSaved(id))) {
      navigate(tracePath("/saved", id));
      return;
    }
    navigate(runPath(id));
  }, [navigate, routeBase, runId]);

  // When another surface fires a span deep-link, open it in the span tree route.
  useEffect(() => {
    const handler = (ev: Event) => {
      const spanId = (ev as CustomEvent).detail?.spanId as string | undefined;
      if (!spanId) return;
      const spans = dataRef.current?.spans;
      if (!spans?.some((s) => s.id === spanId)) return;
      if (routeBase) navigate(`${traceSpanPath(routeBase, runId, spanId)}${searchQuery}`);
      else {
        setLocalTab("tree");
        setLocalSelectedSpanId(spanId);
      }
    };
    window.addEventListener("runphantom:deep-link-span", handler);
    return () => window.removeEventListener("runphantom:deep-link-span", handler);
  }, [navigate, routeBase, runId, searchQuery]);
  const [focusedAgent, setFocusedAgent] = useState<string | null>(null);
  const [editModal, setEditModal] = useState<{ userMessage: string } | null>(null);

  // This component is reused across runs rather than remounted, so a response
  // for the previously selected run could land after the switch and overwrite the
  // new one: the URL showed trace B while the pane rendered trace A. Every write
  // below is gated on the request still being the current one.
  const detailRequestRef = useRef(0);
  const lifecycle = useMemo<DetailLifecycle>(() => ({
    runId, preloaded: !!initialData, mounted: false, generation: 0,
    owner: null, publication: null, sequence: 0,
  }), [runId, initialData]);
  const currentLifecycleRef = useRef<DetailLifecycle | null>(null);
  const context = useMemo<DetailContext>(() => ({
    lifecycle, route: pathname + search, tab: activeTab, agentTab,
    spanId: selectedSpanId, view: runView, agentId: focusedAgent,
  }),
    [lifecycle, pathname, search, activeTab, selectedSpanId, runView, focusedAgent, agentTab]);
  const contextRef = useRef(context);
  const [publishedContext, setPublishedContext] = useState<DetailContext | null>(null);
  const [contextSnapshot, setContextSnapshot] = useState<{ context: DetailContext; data: DetailData } | null>(null);

  const connectionStatus = useRunPhantomConnectionStatus();
  const previousConnectionStatus = useRef(connectionStatus);

  const retireDetail = useCallback(() => {
    // An old passive cleanup must not invalidate a new run's layout-owned read.
    if (currentLifecycleRef.current === lifecycle) ++detailRequestRef.current;
    ++lifecycle.generation;
    const owner = lifecycle.owner;
    lifecycle.owner = lifecycle.publication = null;
    owner?.controller.abort();
  }, [lifecycle]);

  useLayoutEffect(() => {
    currentLifecycleRef.current = lifecycle;
    lifecycle.mounted = true;
    return () => { lifecycle.mounted = false; retireDetail(); };
  }, [lifecycle, retireDetail]);

  useLayoutEffect(() => {
    contextRef.current = context;
    if (data?.run.id === runId && containsDetailContext(data, context)) {
      setContextSnapshot({ context, data });
    }
  }, [context, data, runId]);

  const fetchData = useCallback(async function refresh(): Promise<void> {
    const live = () => lifecycle.mounted && currentLifecycleRef.current === lifecycle
      && !lifecycle.preloaded && !isRunDeleting(lifecycle.runId);
    if (!live()) return;
    if (lifecycle.owner) { lifecycle.owner.pending = true; return; }
    const controller = new AbortController();
    const owner: DetailOwner = {
      request: ++detailRequestRef.current, generation: lifecycle.generation, controller,
      sequence: lifecycle.sequence, context: contextRef.current, pending: false,
    };
    lifecycle.owner = owner;
    const isCurrent = () => live() && lifecycle.owner === owner && owner.generation === lifecycle.generation
      && detailRequestRef.current === owner.request && !controller.signal.aborted;
    // Starting the queued transport does not revoke a completed read's React
    // publication. Retirement or a newer completion does revoke it.
    const canPublish = () => live() && lifecycle.publication === owner
      && owner.generation === lifecycle.generation && !controller.signal.aborted;
    const publishFailure = () => {
      lifecycle.publication = owner;
      setData(previous => canPublish() ? null : previous);
      setNotFound(previous => canPublish() ? true : previous);
    };
    try {
      const res = await fetch(`/api/runs/detail/${lifecycle.runId}`, { signal: controller.signal });
      if (!isCurrent()) return;
      if (res.status === 404) {
        publishFailure();
        return;
      }
      if (!res.ok) throw new Error(`Could not load run (${res.status})`);
      const j = await res.json() as DetailData;
      if (!isCurrent()) return;
      lifecycle.publication = owner;
      setData(previous => canPublish() ? j : previous);
      setNotFound(previous => canPublish() ? false : previous);
      setPublishedContext(previous => canPublish() ? owner.context : previous);
      const source = res.headers.get("X-RunPhantom-Live-Events");
      setLiveView(previous => {
        if (!canPublish()) return previous;
        // The ledger and its watermark are state, not external receipts retired
        // by render-time evaluation. Replaying/discarding this pure calculation
        // cannot acknowledge a frame outside React. Frame updaters reconcile
        // against React's preceding view state; only its commit changes the UI.
        const sameGeneration = previous.lifecycle === lifecycle && previous.generation === owner.generation;
        const overlay = sameGeneration ? previous.overlay.filter(observation => observation.sequence > owner.sequence) : [];
        // Unclassified HTTP still advances the base. Its pre-start overlay is
        // replaced as legacy best effort, never acknowledged by numeric IDs.
        // Post-start frames remain separate; exact-once needs both native IDs
        // and the matching daemon's truthful classification.
        return {
          base: j.liveEvents ?? [], overlay,
          coverage: source === "current-store" || source === "saved-cache" ? source : "legacy",
          lifecycle, generation: owner.generation, coveredThrough: owner.sequence,
        };
      });
    } catch {
      if (!isCurrent()) return;
      publishFailure();
    } finally {
      if (isCurrent()) {
        setLoading(previous => canPublish() ? false : previous);
        lifecycle.owner = null;
        if (owner.pending && live()) void refresh();
      }
    }
  }, [lifecycle]);

  useEffect(() => {
    const recovered = previousConnectionStatus.current !== "connected" && connectionStatus === "connected";
    previousConnectionStatus.current = connectionStatus;
    // Spans committed before the handshake or during an outage have no replayed
    // notification. Reload the snapshot without resetting the selected view.
    if (recovered) void fetchData();
  }, [connectionStatus, fetchData]);

  useEffect(() => {
    // The selected view owns navigation: the menu that started deletion may
    // have unmounted while the user visited another trace and returned here.
    const onRemoved = (event: Event) => {
      if ((event as CustomEvent<{ runId: string }>).detail.runId !== runId) return;
      navigate(routeBase ?? "/runs", { replace: true, flushSync: true });
    };
    window.addEventListener("runphantom:run-removed", onRemoved);
    return () => window.removeEventListener("runphantom:run-removed", onRemoved);
  }, [navigate, routeBase, runId]);

  useEffect(() => {
    let wasDeleting = isRunDeleting(runId);
    const unsubscribe = subscribeRunDeletions(() => {
      const deleting = isRunDeleting(runId);
      if (deleting) {
        retireDetail();
      } else if (wasDeleting) {
        void fetchData(); // A failed delete leaves the trace selected and live.
      }
      wasDeleting = deleting;
    });
    return () => {
      unsubscribe();
      retireDetail();
    };
  }, [runId, fetchData, retireDetail]);

  useEffect(() => {
    if (initialData) return;
    setLoading(true);
    setNotFound(false);
    setData(null);
    setLiveView({ base: [], overlay: [], coverage: "legacy", lifecycle: null, generation: 0, coveredThrough: 0 }); setPublishedContext(null); setFocusedAgent(null); setAgentTab("chat"); setLocalTab("chat"); setLocalSelectedSpanId(null); setEditModal(null); fetchData();
  }, [runId, fetchData, initialData]);

  useEffect(() => {
    if (!routeBase || !selectedSpanId || !data?.spans.length) return;
    if (!data.spans.some((s) => s.id === selectedSpanId)) {
      if (publishedContext !== context) {
        if (lifecycle.owner?.context !== context) void fetchData();
        return;
      }
      navigate(`${traceSpansPath(routeBase, runId)}${searchQuery}`, { replace: true });
    }
  }, [context, data?.spans, fetchData, lifecycle, navigate, publishedContext, routeBase, runId, searchQuery, selectedSpanId]);

  useEffect(() => {
    if (!routeBase || runView !== "convo" || !data?.run) return;
    if (!data.run.convo_id) {
      if (publishedContext !== context) {
        if (lifecycle.owner?.context !== context) void fetchData();
        return;
      }
      navigate(`${tracePath(routeBase, runId)}${searchQuery}`, { replace: true });
    }
  }, [context, data?.run, fetchData, lifecycle, navigate, publishedContext, routeBase, runId, runView, searchQuery]);

  useEffect(() => {
    if (!focusedAgent || !data || data.subAgents.some(agent => agent.root_span_id === focusedAgent)) return;
    if (publishedContext !== context && lifecycle.owner?.context !== context) void fetchData();
  }, [context, data, fetchData, focusedAgent, lifecycle, publishedContext]);

  useLayoutEffect(() => {
    stickToBottomContextRef.current?.stopScroll();
  }, [runId]);

  useLayoutEffect(() => {
    const context = stickToBottomContextRef.current;
    context?.stopScroll();
    const resetScroll = () => {
      context?.stopScroll();
      const scrollElement = context?.scrollRef.current;
      if (scrollElement) scrollElement.scrollTop = 0;
    };
    resetScroll();
    const frame = requestAnimationFrame(resetScroll);
    const timeout = window.setTimeout(resetScroll, 0);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [data?.run.id]);

  // The handshake also covers updates persisted before this socket connected.
  useRunPhantomEvent("agent_provider", () => { void fetchData(); });

  useRunPhantomEvent<SpansBroadcast | undefined>("spans", (data) => {
    if (initialData) return; // No WebSocket updates for pre-loaded data
    if (data?.runIds?.includes(runId)) fetchData();
  });

  // The daemon broadcasts "clear" when every run is deleted, but only "spans"
  // was listened for — so an open trace kept rendering after the store behind it
  // was wiped, and its Annotate and Replay controls kept acting on a run that no
  // longer existed.
  useRunPhantomEvent("clear", () => {
    if (initialData) return;
    fetchData();
  });

  useRunPhantomEvent<LiveEventBroadcast | undefined>("live", (data) => {
    if (initialData || data?.traceId !== runId || !lifecycle.mounted || isRunDeleting(runId)) return;
    const event = toLiveEvent(data);
    if (!event) return;
    const generation = lifecycle.generation;
    const observation: LiveObservation = { sequence: ++lifecycle.sequence, event, persisted: persistedLiveId(data.persistedId) };
    setLiveView(previous => {
      if (!lifecycle.mounted || currentLifecycleRef.current !== lifecycle || generation !== lifecycle.generation) return previous;
      const sameGeneration = previous.lifecycle === lifecycle && previous.generation === generation;
      if (sameGeneration && (observation.sequence <= previous.coveredThrough || previous.overlay.includes(observation))) return previous;
      // A failed deletion resumes the same run. Its last committed display
      // survives retirement; the monotonic sequence lets the next read replace
      // that older prefix without treating a different run's state as current.
      return previous.lifecycle === lifecycle
        ? { ...previous, generation, overlay: [...previous.overlay, observation] }
        : { base: [], overlay: [observation], coverage: "legacy", lifecycle, generation, coveredThrough: 0 };
    });
  });

  // Extract last user message for fork pre-fill (must be before early returns — rules of hooks).
  // The server-side adapter layer already extracted this into `span.normalized.userMessage`
  // for every supported SDK shape, so we just pick the LLM span with the longest input
  // (still a useful "best candidate" heuristic for runs with many LLM calls) and read the
  // pre-extracted field. No JSON.parse, no SDK-specific branching.
  const lastUserMessage = useMemo(() => {
    if (!data?.spans) return "";
    const allLLMs = data.spans.filter((s: Span) => s.span_type?.includes("LLM"));
    const best = allLLMs.reduce((b: Span | null, s) =>
      !b || (s.input_payload?.length ?? 0) > (b.input_payload?.length ?? 0) ? s : b
    , null);
    if (best?.normalized?.kind === "llm" && best.normalized.userMessage) {
      return best.normalized.userMessage;
    }
    // Fallback for cached / saved rows that pre-date the adapter layer.
    return best?.input_payload ?? "";
  }, [data?.spans]);

  const saveAnnotationPreview = useCallback((annotation: Annotation) => {
    if (autoSavedAnnotationIdsRef.current.has(annotation.id)) return;
    const currentData = dataRef.current;
    if (!currentData?.run) return;
    autoSavedAnnotationIdsRef.current.add(annotation.id);

    const preview = annotationToSavedPreview(annotation);
    const existing = getSavedEvents().find(e => e.id === annotation.run_id);
    if (existing) {
      updateSavedEvent(annotation.run_id, {
        saved_at: Date.now(),
        properties: {
          ...(existing.properties ?? {}),
          annotation_preview: preview,
        },
      });
    } else {
      saveEvent(buildSavedEventFromRun({
        run: currentData.run,
        spans: currentData.spans,
        annotationPreview: preview,
      }));
    }
  }, []);

  const createAnnotationAndSave = useCallback(async (
    input: { span_id?: string | null; kind: AnnotationKind; note?: string; source?: "user" | "claude-code" | "codex" | "opencode" }
  ) => {
    const created = await annotationsApi.create({ ...input, source: input.source ?? "user" });
    if (created) saveAnnotationPreview(created);
    return created;
  }, [annotationsApi, saveAnnotationPreview]);

  useEffect(() => {
    for (const annotation of annotationsApi.annotations) {
      if (annotationsApi.freshIds.has(annotation.id)) saveAnnotationPreview(annotation);
    }
  }, [annotationsApi.annotations, annotationsApi.freshIds, saveAnnotationPreview]);

  // The saved card keeps a copy of one annotation. Deleting that annotation
  // left the copy behind, so Saved kept quoting a note the run no longer had.
  const savedForRun = useSavedEvent(runId);
  useEffect(() => {
    if (!runId || !annotationsApi.loaded) return;
    const saved = savedForRun;
    const preview = saved ? getSavedAnnotationPreview(saved) : null;
    if (!saved || !preview || annotationsApi.annotations.some(a => a.id === preview.id)) return;
    const latest = annotationsApi.annotations[annotationsApi.annotations.length - 1];
    const { annotation_preview: _stale, ...rest } = saved.properties ?? {};
    updateSavedEvent(runId, {
      properties: latest ? { ...rest, annotation_preview: annotationToSavedPreview(latest) } : rest,
    });
  }, [runId, savedForRun, annotationsApi.loaded, annotationsApi.annotations]);

  const runStatusSummary = useRunStatus(data?.run ? runStatusEvidence(data.run, data.spans) : null);
  const subAgentList = data?.subAgents;
  const agentRootIds = useMemo(() => new Set((subAgentList ?? []).map(agent => agent.root_span_id)), [subAgentList]);

  if (loading) return <div role="status" className="flex h-full items-center justify-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-rp-ink-muted">Loading run <Dots /></div>;
  if (notFound || !data?.run) return <TraceNotFound runId={runId} backPath={routeBase ?? "/runs"} />;

  const { run, spans, subAgents } = data;
  const paneData = publishedContext !== context && contextSnapshot?.context === context ? contextSnapshot.data : data;
  const paneSpans = paneData.spans;
  const paneConvoId = paneData.run.convo_id;
  const replayMeta = parseReplayMetadata(run);

  // If focused on a sub-agent, show that sub-agent's view
  const agent = focusedAgent ? paneData.subAgents.find(a => a.root_span_id === focusedAgent) : null;

  if (agent) {
    const agentSpanSet = new Set(agent.span_ids);
    // Exclude the root tool call span — it's the parent invocation, not part of the sub-agent's work
    const agentSpans = paneSpans.filter(s => agentSpanSet.has(s.id) && s.id !== agent.root_span_id);
    const agentTools = agentSpans.filter(s => s.span_type === "TOOL_CALL");
    const agentLLMs = agentSpans.filter(s => s.span_type?.includes("LLM"));
    const agentErrs = agentSpans.filter(s => s.status === "ERROR");

    const tabStyle = (k: string) => runTabClass(agentTab === k);

    return (
      <div className="h-full flex flex-col">
        <ViewHeader
          title={agent.name}
          model={agent.model}
          status={subAgentStatus(runStatusSummary, agentSpans)}
          startedAt={agent.start_time_ms}
          anthropicModels={anthropicModels}
          stats={runStatsFor(agentSpans, {
            spans: agentSpans.length, tools: agentTools.length, llms: agentLLMs.length, errors: agentErrs.length, dur: agent.duration_ms,
            inTokens: agent.total_input_tokens, outTokens: agent.total_output_tokens,
          })}
          allSpans={agentSpans}
          breadcrumb={{
            onBack: () => setFocusedAgent(null),
            parentName: runDisplayName(run),
          }}
        />
        <div role="tablist" aria-label="Sub-agent views" aria-orientation="horizontal" onKeyDown={handleHorizontalTabKeys} className="flex flex-shrink-0 gap-1 overflow-x-auto border-b border-rp-line bg-rp-surface px-3 sm:px-4">
          <button type="button" id={agentOverviewTabId} className={tabStyle("chat")} role="tab" aria-selected={agentTab === "chat"} aria-controls={agentPanelId} tabIndex={agentTab === "chat" ? 0 : -1} onClick={() => setAgentTab("chat")}>Overview</button>
          <button type="button" id={agentSpansTabId} className={tabStyle("tree")} role="tab" aria-selected={agentTab === "tree"} aria-controls={agentPanelId} tabIndex={agentTab === "tree" ? 0 : -1} onClick={() => setAgentTab("tree")}>Span Tree</button>
        </div>
        {agentTab === "tree" ? (
          <div id={agentPanelId} role="tabpanel" aria-labelledby={agentSpansTabId} className="relative min-h-0 flex-1">
            <SpanTree spans={agentSpans} />
          </div>
        ) : (
          <StickToBottom id={agentPanelId} role="tabpanel" aria-labelledby={agentOverviewTabId} className={STICK_LAYOUT} resize={prefersReducedMotion ? "instant" : "smooth"} initial={false} contextRef={stickToBottomContextRef}>
            <StickToBottom.Content className="sb">
              {agentTab === "chat" && <ChatFlow spans={agentSpans} liveEvents={[]} subAgents={[]} onDiveIn={setFocusedAgent} />}
            </StickToBottom.Content>
            <ScrollToBottomButton />
          </StickToBottom>
        )}
      </div>
    );
  }

  // Normal run view
  const replayUnavailable = spans.some(span => observationReplayUnavailable(span.normalized?.capture));
  const status = runStatusSummary ?? deriveRunStatus(runStatusEvidence(run, spans));
  const active = runInProgress(status.status);
  const tools = spans.filter(s => s.span_type === "TOOL_CALL");
  const llms = spans.filter(s => s.span_type?.includes("LLM"));
  const errs = spans.filter(s => s.status === "ERROR");
  const dur = run.last_updated_at - run.started_at;
  const model = spans.find(s => s.model)?.model;
  const downloadTrace = async () => {
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(run.id)}/export`);
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        throw new Error(failure?.error || `Could not export trace (${response.status})`);
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `trace-${run.id.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not export trace");
    }
  };

  const tabStyle = (k: string) => runTabClass(activeTab === k);

  return (
    <div className="h-full flex flex-col">
      <ViewHeader
        title={runDisplayName(run)}
        model={model}
        status={status}
        // A run stays "active" for 30s after its last live event, and the
        // header clock kept counting wall time past the run's own end ("12s"
        // for a 6.2s run). Once finished, the header shows the recorded span.
        startedAt={run.finished ? undefined : run.started_at}
        anthropicModels={anthropicModels}
        stats={runStatsFor(spans, {
          spans: spans.length, tools: tools.length, llms: llms.length, errors: errs.length, dur,
          agents: subAgents.length,
          inTokens: [...getTokensByModel(spans).values()].reduce((s, v) => s + v.inTok, 0),
          outTokens: [...getTokensByModel(spans).values()].reduce((s, v) => s + v.outTok, 0),
        })}
        // The status pill already says "Completed · 1 tool error", so the sentence only says where.
        failure={failureSentence(spans, status.status === "failed" ? "failed" : active ? "running" : "other")}
        onOpenStep={selectSpan}
        allSpans={spans}
        run={run}
        isReplay={isReplay}
        onAnnotateRun={(input) => createAnnotationAndSave({ ...input, source: "user" })}
        annotationError={annotationsApi.error}
        onDownload={downloadTrace}
        fork={onForkStarted ? {
          onFork: (msg, mode, mdl, ctx) => onForkStarted(runId, msg, mode, mdl, ctx),
          userMessage: lastUserMessage,
        } : undefined}
      />
      {routeBase && <AttachedReportsLink runId={runId} />}
      <TraceAnnotations
        annotations={annotationsApi.annotations}
        freshIds={annotationsApi.freshIds}
        onClearFresh={annotationsApi.clearFresh}
        onDelete={annotationsApi.remove}
      />
      <div role="tablist" aria-label="Run views" aria-orientation="horizontal" onKeyDown={handleHorizontalTabKeys} className="flex flex-shrink-0 gap-1 overflow-x-auto border-b border-rp-line bg-rp-surface px-3 sm:px-4">
        <button type="button" id={runOverviewTabId} className={tabStyle("chat")} role="tab" aria-selected={activeTab === "chat"} aria-controls={runPanelId} tabIndex={activeTab === "chat" ? 0 : -1} onClick={goOverview}>Overview</button>
        <button type="button" id={runSpansTabId} className={tabStyle("tree")} role="tab" aria-selected={activeTab === "tree"} aria-controls={runPanelId} tabIndex={activeTab === "tree" ? 0 : -1} onClick={goSpans}>Span Tree</button>
        {paneConvoId && (
          <button type="button" id={runConversationTabId} className={tabStyle("convo")} role="tab" aria-selected={activeTab === "convo"} aria-controls={runPanelId} tabIndex={activeTab === "convo" ? 0 : -1} onClick={goConvo}>Conversation</button>
        )}
      </div>
      {activeTab === "tree" ? (
        <div id={runPanelId} role="tabpanel" aria-labelledby={runSpansTabId} className="relative min-h-0 flex-1">
          <SpanTree
            spans={paneSpans}
            agentRootIds={agentRootIds}
            selectedSpanId={selectedSpanId}
            onSelectSpan={selectSpan}
            annotations={annotationsApi.annotations}
            freshIds={annotationsApi.freshIds}
            onClearFresh={annotationsApi.clearFresh}
            onCreateAnnotation={createAnnotationAndSave}
            annotationError={annotationsApi.error}
            onDeleteAnnotation={annotationsApi.remove}
          />
        </div>
      ) : (
        <StickToBottom id={runPanelId} role="tabpanel" aria-labelledby={activeTab === "convo" ? runConversationTabId : runOverviewTabId} className={STICK_LAYOUT} resize={prefersReducedMotion ? "instant" : "smooth"} initial={false} contextRef={stickToBottomContextRef}>
          <StickToBottom.Content className="sb">
            {activeTab === "chat" && <ChatFlow spans={spans} liveEvents={liveEvents} subAgents={subAgents} onDiveIn={setFocusedAgent} isActive={active} lastUpdatedAt={run.last_updated_at} onEditMessage={onForkStarted && !active && !replayUnavailable ? (msg) => setEditModal({ userMessage: msg }) : undefined} replayError={replayMeta?.replay?.error ?? null} />}
            {activeTab === "convo" && paneConvoId && <ConvoDetail convoId={paneConvoId} onOpenTurn={openConversationTurn} />}
          </StickToBottom.Content>
          <ScrollToBottomButton />
        </StickToBottom>
      )}
      {editModal && onForkStarted && !replayUnavailable && (
        <EditReplayModal
          userMessage={editModal.userMessage}
          model={model}
          runId={runId}
          eventName={run.event_name ?? undefined}
          traceModelFromMetadata={parseReplayMetadata(run)?.replay?.model ?? null}
          anthropicModels={anthropicModels}
          onReplay={(msg, mode, mdl, ctx) => onForkStarted(runId, msg, mode, mdl, ctx)}
          onClose={() => setEditModal(null)}
        />
      )}
    </div>
  );
}
