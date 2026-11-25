import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, ChevronUp, FileSearch, Search, Timer, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { compactTokens, fmt } from "../../utils/helpers";
import { setMeridian, clearMeridian } from "../../utils/meridian";
import type { Span } from "../../utils/types";
import type { Annotation } from "../../hooks/use-annotations";
import { AnnotationChip } from "../AnnotationChip";
import { useRegisterShortcuts } from "../../shell/commands";
import { ariaKeyShortcuts, formatKeys, isMacPlatform } from "../../shell/keyboard";
import { spanCost } from "../../../../src/pricing/span-cost";
import { fmtCost } from "../../utils/costs";
import {
  buildTraceModel,
  countedLlmSpans,
  shortModelName,
  slowestStep,
  visibleTrace,
  TRACE_KINDS,
  TRACE_KIND_FILTER_LABEL,
  TRACE_KIND_LABEL,
  type TraceKind,
  type TraceRow,
} from "./trace-model";
import "./run-detail.css";

const ROW_HEIGHT = 28;
const INDENT = 14;
const MIN_WINDOW_MS = 1;
/** Height of the sticky axis header inside the scroll body. */
const AXIS_HEIGHT = 32;
/** design-direction.md section 6: window the rows past about 2,000 steps. */
const WINDOW_THRESHOLD = 2000;
const OVERSCAN = 30;

const KIND_COLOR: Record<TraceKind, string> = {
  llm: "var(--rp-trace-llm)",
  tool: "var(--rp-trace-tool)",
  agent: "var(--rp-trace-agent)",
  other: "var(--rp-trace-other)",
};

interface Viewport { from: number; to: number }

function niceTicks(from: number, to: number): number[] {
  return [0, 0.25, 0.5, 0.75, 1].map(fraction => from + (to - from) * fraction);
}

function highlight(text: string, query: string): ReactNode {
  const needle = query.trim();
  if (!needle) return text;
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return text;
  return <>{text.slice(0, index)}<mark className="rp-trace-mark">{text.slice(index, index + needle.length)}</mark>{text.slice(index + needle.length)}</>;
}

export interface WaterfallProps {
  spans: Span[];
  agentRootIds?: ReadonlySet<string>;
  selectedId: string | null;
  onSelect: (spanId: string) => void;
  annotationsBySpan?: ReadonlyMap<string, Annotation[]>;
  freshIds?: ReadonlySet<string>;
  onClearFresh?: (id: string) => void;
  onRowContextMenu?: (event: React.MouseEvent, span: Span) => void;
  onRowOpenContextMenu?: (element: HTMLElement, span: Span) => void;
  renderAfterRow?: (span: Span, depth: number) => ReactNode;
  /** Narrow layouts fold the model, token and cost columns into a chip beside the name. */
  width: number;
}

export function Waterfall({
  spans, agentRootIds, selectedId, onSelect, annotationsBySpan, freshIds, onClearFresh,
  onRowContextMenu, onRowOpenContextMenu, renderAfterRow, width,
}: WaterfallProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const axisRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const model = useMemo(() => buildTraceModel(spans, agentRootIds), [spans, agentRootIds]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [kinds, setKinds] = useState<Set<TraceKind>>(() => new Set(TRACE_KINDS));
  const [query, setQuery] = useState("");
  // Filtering and highlighting follow the deferred value, so typing stays
  // responsive on a large trace while the rows catch up.
  const deferredQuery = useDeferredValue(query);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 900 });
  const [activeMatch, setActiveMatch] = useState(0);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [brush, setBrush] = useState<{ from: number; to: number } | null>(null);
  const suppressClickRef = useRef(false);
  const mac = useMemo(() => isMacPlatform(), []);

  const runKey = spans[0]?.run_id ?? "";
  useEffect(() => {
    setCollapsed(new Set());
    setViewport(null);
    setQuery("");
  }, [runKey]);

  const { rows, matches, context } = useMemo(() => visibleTrace(model, { collapsed, kinds, query: deferredQuery }), [model, collapsed, kinds, deferredQuery]);
  const windowed = rows.length > WINDOW_THRESHOLD;
  const rowIndex = useMemo(() => new Map(rows.map((row, index) => [row.span.id, index])), [rows]);
  const counted = useMemo(() => new Set(countedLlmSpans(spans).map(span => span.id)), [spans]);
  const costs = useMemo(() => {
    const map = new Map<string, ReturnType<typeof spanCost>>();
    for (const span of spans) if (counted.has(span.id)) map.set(span.id, spanCost(span));
    return map;
  }, [spans, counted]);
  const slowest = useMemo(() => slowestStep(model), [model]);
  const errorIds = useMemo(() => model.rows.filter(row => row.span.status === "ERROR").map(row => row.span.id), [model]);
  const kindCounts = useMemo(() => {
    const counts: Record<TraceKind, number> = { llm: 0, tool: 0, agent: 0, other: 0 };
    for (const row of model.rows) counts[row.kind]++;
    return counts;
  }, [model]);

  // The list-plus-trace layout leaves the pane about 936px at 1440 wide and
  // about 536px with the drawer open; below these the values move into a chip
  // beside the step name instead of disappearing.
  const showModel = width >= 880;
  const showUsage = width >= 600;
  const narrow = width < 640;
  // Below this the bars would be a few pixels wide; the list keeps names and durations.
  const showTrack = width >= 380;
  // Without the usage columns the name cell also carries the model/usage chip.
  const nameWidth = !showTrack ? Math.max(120, width - 64) : narrow ? Math.max(150, Math.round(width * (showUsage ? 0.46 : 0.58))) : width < 900 ? 280 : 320;
  const trackWidth = width - nameWidth - 64 - (showUsage ? 152 : 0) - (showModel ? 128 : 0);

  const view: Viewport = viewport ?? { from: 0, to: model.span };
  const windowMs = Math.max(MIN_WINDOW_MS, view.to - view.from);
  const zoom = model.span / windowMs;
  const ticks = niceTicks(view.from, view.to);
  const tickStep = trackWidth < 340 ? 2 : 1;

  const clampViewport = useCallback((from: number, to: number): Viewport | null => {
    const total = model.span;
    let size = Math.max(Math.min(to - from, total), Math.max(MIN_WINDOW_MS, total / 2000));
    if (size >= total - 1e-6) return null;
    const start = Math.max(0, Math.min(from, total - size));
    size = Math.min(size, total - start);
    return { from: start, to: start + size };
  }, [model.span]);

  // React registers wheel listeners as passive, so Cmd/Ctrl+scroll could not
  // stop the browser zooming the page; a native non-passive listener can.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const onWheel = (event: WheelEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const axis = axisRef.current?.getBoundingClientRect();
      if (!axis || axis.width <= 0) return;
      event.preventDefault();
      const fraction = Math.min(1, Math.max(0, (event.clientX - axis.left) / axis.width));
      setViewport(current => {
        const base = current ?? { from: 0, to: model.span };
        const size = base.to - base.from;
        const pivot = base.from + fraction * size;
        const next = size * (event.deltaY > 0 ? 1.25 : 0.8);
        return clampViewport(pivot - fraction * next, pivot - fraction * next + next);
      });
    };
    body.addEventListener("wheel", onWheel, { passive: false });
    return () => body.removeEventListener("wheel", onWheel);
  }, [clampViewport, model.span]);

  const timeAt = useCallback((clientX: number) => {
    const axis = axisRef.current?.getBoundingClientRect();
    if (!axis || axis.width <= 0) return null;
    const fraction = Math.min(1, Math.max(0, (clientX - axis.left) / axis.width));
    return view.from + fraction * windowMs;
  }, [view.from, windowMs]);

  const onBrushStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !(event.target as HTMLElement).closest("[data-trace-track]")) return;
    const startX = event.clientX;
    const startTime = timeAt(startX);
    if (startTime === null) return;
    const target = event.currentTarget;
    let active = false;
    const move = (moveEvent: PointerEvent) => {
      if (!active && Math.abs(moveEvent.clientX - startX) < 5) return;
      if (!active) { active = true; try { target.setPointerCapture(event.pointerId); } catch { /* pointer already released */ } }
      const time = timeAt(moveEvent.clientX);
      if (time !== null) setBrush({ from: Math.min(startTime, time), to: Math.max(startTime, time) });
    };
    const up = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!active) return;
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      const time = timeAt(upEvent.clientX);
      setBrush(null);
      if (time === null) return;
      const from = Math.min(startTime, time);
      const to = Math.max(startTime, time);
      if (to - from > 0) setViewport(clampViewport(from, to));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // A row asked for while it is not rendered yet (collapsed, filtered or
  // outside the window) is revealed after the next commit.
  const pendingRef = useRef<{ id: string; focus: boolean } | null>(null);
  const [revealTick, setRevealTick] = useState(0);
  const showRow = useCallback((spanId: string, focus: boolean) => {
    const element = rootRef.current?.querySelector<HTMLElement>(`[data-span-row="${CSS.escape(spanId)}"]`);
    if (element) {
      if (focus) element.focus({ preventScroll: true });
      element.scrollIntoView({ block: "nearest" });
      return;
    }
    pendingRef.current = { id: spanId, focus };
    setRevealTick(tick => tick + 1);
  }, []);
  const focusRow = useCallback((spanId: string) => showRow(spanId, true), [showRow]);

  useLayoutEffect(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    const element = rootRef.current?.querySelector<HTMLElement>(`[data-span-row="${CSS.escape(pending.id)}"]`);
    if (element) {
      pendingRef.current = null;
      if (pending.focus) element.focus({ preventScroll: true });
      element.scrollIntoView({ block: "nearest" });
      return;
    }
    const index = rowIndex.get(pending.id);
    const body = bodyRef.current;
    if (index === undefined || !body || !windowed) return;
    body.scrollTop = Math.max(0, AXIS_HEIGHT + index * ROW_HEIGHT - body.clientHeight / 2);
    setScroll({ top: body.scrollTop, height: body.clientHeight });
  }, [revealTick, rowIndex, windowed, scroll.top]);

  const currentRowId = useCallback((): string | null => {
    const active = document.activeElement as HTMLElement | null;
    const focused = active?.closest?.("[data-span-row]")?.getAttribute("data-span-row");
    if (focused && rootRef.current?.contains(active)) return focused;
    return selectedId && rows.some(row => row.span.id === selectedId) ? selectedId : null;
  }, [rows, selectedId]);

  const moveCursor = useCallback((delta: 1 | -1) => {
    if (!rows.length) return;
    const current = currentRowId();
    const index = current ? rows.findIndex(row => row.span.id === current) : -1;
    const next = index < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, index + delta));
    focusRow(rows[next]!.span.id);
  }, [currentRowId, focusRow, rows]);

  const ensureVisible = useCallback((spanId: string) => {
    const row = model.byId.get(spanId);
    if (!row) return;
    setCollapsed(previous => {
      if (!row.ancestors.some(id => previous.has(id))) return previous;
      const next = new Set(previous);
      for (const id of row.ancestors) next.delete(id);
      return next;
    });
    setKinds(previous => previous.has(row.kind) ? previous : new Set([...previous, row.kind]));
  }, [model]);

  const goToError = useCallback((delta: 1 | -1 = 1) => {
    if (!errorIds.length) return;
    const current = currentRowId();
    const index = current ? errorIds.indexOf(current) : -1;
    const next = errorIds[(index + delta + errorIds.length) % errorIds.length]!;
    ensureVisible(next);
    onSelect(next);
    requestAnimationFrame(() => focusRow(next));
  }, [currentRowId, ensureVisible, errorIds, focusRow, onSelect]);

  const goToMatch = useCallback((delta: 1 | -1) => {
    if (!matches.length) return;
    setActiveMatch(previous => {
      const next = (previous + delta + matches.length) % matches.length;
      const id = matches[next]!;
      requestAnimationFrame(() => showRow(id, false));
      return next;
    });
  }, [matches, showRow]);

  useEffect(() => { setActiveMatch(0); }, [query]);

  const clearSearch = useCallback(() => {
    setQuery("");
    const target = selectedId ?? rows[0]?.span.id;
    if (target) requestAnimationFrame(() => focusRow(target));
  }, [focusRow, rows, selectedId]);

  const toggleCollapsed = useCallback((spanId: string, open?: boolean) => {
    setCollapsed(previous => {
      const next = new Set(previous);
      const shouldOpen = open ?? next.has(spanId);
      if (shouldOpen) next.delete(spanId); else next.add(spanId);
      return next;
    });
  }, []);

  const inTrace = () => !!rootRef.current && (rootRef.current.contains(document.activeElement) || document.activeElement === document.body);
  useRegisterShortcuts([
    // Only from inside the trace (or with nothing focused): elsewhere, such as
    // the step drawer or the debug chat, the browser's own find stays in charge.
    { id: "trace:find", keys: "mod+f", scope: "Run detail", description: "Find a step in the trace", allowInInputs: true, when: inTrace,
      handler: () => { findRef.current?.focus(); findRef.current?.select(); } },
    { id: "trace:next", keys: "j", scope: "Run detail", description: "Next step", when: inTrace, handler: () => moveCursor(1) },
    { id: "trace:previous", keys: "k", scope: "Run detail", description: "Previous step", when: inTrace, handler: () => moveCursor(-1) },
    { id: "trace:next-error", keys: "e", scope: "Run detail", description: "Next failed step", when: inTrace, handler: () => goToError(1) },
    { id: "trace:open", keys: "enter", scope: "Run detail", description: "Open the focused step's details" },
    { id: "trace:clear", keys: "esc", scope: "Run detail", description: "Clear the step search, then close the details" },
  ], []);

  // A row that holds focus handles j/k itself, so the shortcut wins over a list
  // registered elsewhere for the same keys.
  const onRootKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true']")) return;
    if (event.key === "j" || event.key === "k") {
      event.preventDefault();
      moveCursor(event.key === "j" ? 1 : -1);
    } else if (event.key === "e") {
      event.preventDefault();
      goToError(1);
    } else if (event.key === "Escape" && query) {
      event.preventDefault();
      event.stopPropagation();
      clearSearch();
    }
  };

  // A step opened from outside the waterfall (the failure sentence, a deep
  // link, a timeline jump) may sit under a collapsed parent, behind a kind
  // filter or outside the search; open the way to it and bring it into view.
  const revealState = useRef({ model, rows, ensureVisible });
  revealState.current = { model, rows, ensureVisible };
  useEffect(() => {
    if (!selectedId) return;
    const { model: current, rows: shown, ensureVisible: open } = revealState.current;
    if (!current.byId.has(selectedId)) return;
    if (!shown.some(row => row.span.id === selectedId)) {
      setQuery("");
      open(selectedId);
    }
    showRow(selectedId, false);
  }, [selectedId, showRow]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !windowed) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setScroll({ top: body.scrollTop, height: body.clientHeight }));
    };
    update();
    body.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(body);
    return () => { cancelAnimationFrame(frame); body.removeEventListener("scroll", update); observer.disconnect(); };
  }, [windowed]);

  const kindToggle = (kind: TraceKind) => {
    setKinds(previous => {
      const next = new Set(previous);
      if (next.has(kind)) next.delete(kind); else next.add(kind);
      return next.size ? next : new Set(TRACE_KINDS);
    });
  };

  const anyCollapsible = model.rows.some(row => row.childIds.length > 0 && row.depth > 0);
  const allCollapsed = anyCollapsible && model.rows.filter(row => row.childIds.length && row.depth > 0).every(row => collapsed.has(row.span.id));
  const activeMatchId = matches.length ? matches[Math.min(activeMatch, matches.length - 1)] : null;
  const searching = query.trim().length > 0;
  const filtering = deferredQuery.trim().length > 0;
  const first = windowed ? Math.max(0, Math.floor((scroll.top - AXIS_HEIGHT) / ROW_HEIGHT) - OVERSCAN) : 0;
  const last = windowed ? Math.min(rows.length, Math.ceil((scroll.top + scroll.height) / ROW_HEIGHT) + OVERSCAN) : rows.length;
  const rendered = windowed ? rows.slice(first, last) : rows;
  // One tab stop for the whole list; j/k and the arrow keys move within it.
  const tabStopId = [cursorId, selectedId].find(id => id && rendered.some(row => row.span.id === id)) ?? rendered[0]?.span.id ?? null;
  const findShortcut = formatKeys("mod+f", mac);

  const columns = (
    <>
      {showModel && <div className="w-[128px] shrink-0 truncate px-2">Model</div>}
      {showUsage && <div className="w-[84px] shrink-0 px-2 text-right">Tokens</div>}
      {showUsage && <div className="w-[68px] shrink-0 px-2 text-right">Cost</div>}
      <div className="w-[64px] shrink-0 pr-3 text-right">Dur</div>
    </>
  );

  return (
    <div ref={rootRef} data-trace-root className="flex h-full min-h-0 min-w-0 flex-col bg-rp-surface" onKeyDown={onRootKeyDown}>
      <div role="toolbar" aria-label="Trace tools" className="flex min-h-11 flex-shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-rp-line px-3 py-1.5">
        <div className={cn("relative flex flex-1 items-center sm:max-w-[300px]", narrow ? "min-w-[120px]" : "min-w-[180px]")}>
          <Search aria-hidden="true" className="pointer-events-none absolute left-2 size-3.5 text-rp-ink-subtle" />
          <input
            ref={findRef}
            type="search"
            aria-label="Find step"
            aria-keyshortcuts={ariaKeyShortcuts("mod+f", mac)}
            aria-describedby={searching ? "trace-find-status" : undefined}
            placeholder="Find step"
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter") { event.preventDefault(); goToMatch(event.shiftKey ? -1 : 1); }
              else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (query) clearSearch();
                else event.currentTarget.blur();
              }
            }}
            className={cn("h-8 w-full rounded-control border border-rp-line bg-rp-surface pl-7 text-13 text-rp-ink placeholder:text-rp-ink-subtle focus-visible:border-rp-blue focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rp-blue/30 [&::-webkit-search-cancel-button]:hidden", narrow ? "pr-7" : "pr-14")}
          />
          {searching ? (
            <button type="button" aria-label="Clear step search" onClick={clearSearch} className="absolute right-1 inline-flex size-6 items-center justify-center rounded-control text-rp-ink-subtle hover:bg-rp-row-hover hover:text-rp-ink">
              <X aria-hidden="true" className="size-3.5" />
            </button>
          ) : !narrow && <span aria-hidden="true" className="rp-kbd pointer-events-none absolute right-1.5">{findShortcut}</span>}
        </div>
        {searching && (
          <div className="flex items-center gap-1">
            <span id="trace-find-status" role="status" className="min-w-[64px] font-mono text-12 tabular-nums text-rp-ink-subtle">
              {matches.length ? `${Math.min(activeMatch, matches.length - 1) + 1} of ${matches.length}` : "No match"}
            </span>
            <button type="button" aria-label="Previous match" disabled={!matches.length} onClick={() => goToMatch(-1)} className="inline-flex size-7 items-center justify-center rounded-control text-rp-ink-subtle hover:bg-rp-row-hover hover:text-rp-ink disabled:opacity-40"><ChevronUp aria-hidden="true" className="size-3.5" /></button>
            <button type="button" aria-label="Next match" disabled={!matches.length} onClick={() => goToMatch(1)} className="inline-flex size-7 items-center justify-center rounded-control text-rp-ink-subtle hover:bg-rp-row-hover hover:text-rp-ink disabled:opacity-40"><ChevronDown aria-hidden="true" className="size-3.5" /></button>
          </div>
        )}
        {errorIds.length > 0 && (
          <button type="button" data-trace-errors onClick={() => goToError(1)} title="Go to the next failed step (E)"
            className="inline-flex h-8 items-center gap-1.5 rounded-control border border-rp-danger-border bg-rp-danger-soft px-2.5 text-12 font-medium text-rp-danger transition-colors duration-fast hover:border-rp-danger">
            <AlertTriangle aria-hidden="true" className="size-3.5" />
            {narrow ? <><span>{errorIds.length}</span><span className="sr-only">{errorIds.length === 1 ? " failed step" : " failed steps"}</span></> : errorIds.length === 1 ? "1 failed step" : `${errorIds.length} failed steps`}
          </button>
        )}
        {slowest && model.rows.length > 1 && width >= 760 && (
          <button type="button" data-trace-slowest onClick={() => { ensureVisible(slowest.span.id); onSelect(slowest.span.id); requestAnimationFrame(() => focusRow(slowest.span.id)); }}
            title={`Open the slowest step, ${slowest.span.name}`}
            className="inline-flex h-8 min-w-0 max-w-[240px] items-center gap-1.5 rounded-control border border-rp-line px-2.5 text-12 text-rp-ink transition-colors duration-fast hover:bg-rp-row-hover">
            <Timer aria-hidden="true" className="size-3.5 shrink-0 text-rp-ink-subtle" />
            <span className="shrink-0 text-rp-ink-subtle">Slowest</span>
            <span className="min-w-0 truncate font-mono">{slowest.span.name}</span>
            <span className="shrink-0 font-mono tabular-nums">{fmt(slowest.span.duration_ms)}</span>
          </button>
        )}
        <div role="group" aria-label="Show step kinds" className="flex flex-wrap items-center gap-1">
          {TRACE_KINDS.filter(kind => kindCounts[kind] > 0).map(kind => (
            <button key={kind} type="button" aria-pressed={kinds.has(kind)} onClick={() => kindToggle(kind)}
              className={cn("inline-flex h-8 items-center gap-1.5 rounded-control border px-2 text-12 transition-colors duration-fast",
                kinds.has(kind) ? "border-rp-line bg-rp-surface text-rp-ink hover:bg-rp-row-hover" : "border-dashed border-rp-line bg-transparent text-rp-ink-subtle line-through decoration-rp-ink-faint")}>
              <span aria-hidden="true" className="size-2 rounded-[2px]" style={{ background: kinds.has(kind) ? KIND_COLOR[kind] : "transparent", boxShadow: kinds.has(kind) ? undefined : `inset 0 0 0 1px ${KIND_COLOR[kind]}` }} />
              {narrow ? <span className="sr-only">{TRACE_KIND_FILTER_LABEL[kind]}</span> : TRACE_KIND_FILTER_LABEL[kind]}
              <span className="font-mono tabular-nums text-rp-ink-subtle">{kindCounts[kind]}</span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {anyCollapsible && (
            <button type="button" onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(model.rows.filter(row => row.childIds.length && row.depth > 0).map(row => row.span.id)))}
              className="inline-flex h-8 items-center rounded-control px-2 text-12 text-rp-ink-subtle hover:bg-rp-row-hover hover:text-rp-ink">
              {allCollapsed ? "Expand all" : "Collapse all"}
            </button>
          )}
          {showTrack && <button type="button" aria-label="Fit timeline" title="Show the whole run (Cmd or Ctrl + scroll zooms, drag the time axis to zoom in)" disabled={!viewport} onClick={() => setViewport(null)}
            className="inline-flex h-8 items-center gap-1 rounded-control border border-rp-line px-2.5 text-12 text-rp-ink hover:bg-rp-row-hover disabled:border-transparent disabled:text-rp-ink-subtle">
            Fit{viewport && <span className="font-mono tabular-nums text-rp-ink-subtle">{zoom >= 10 ? Math.round(zoom) : zoom.toFixed(1)}×</span>}
          </button>}
        </div>
      </div>

      <div ref={bodyRef} data-trace-body className="sb relative min-h-0 flex-1 overflow-auto" onPointerDown={onBrushStart}>
        <div className="sticky top-0 z-10 flex h-8 items-stretch border-b border-rp-line bg-rp-surface font-mono text-11 uppercase tracking-[0.08em] text-rp-ink-subtle">
          <div className="flex shrink-0 items-center pl-3" style={{ width: nameWidth }}>Step</div>
          <div ref={axisRef} data-trace-track data-trace-axis role="img" hidden={!showTrack} aria-label={`Time axis from ${fmt(view.from)} to ${fmt(view.to)}`} className="relative min-w-[80px] flex-1 cursor-col-resize select-none">
            {ticks.map((tick, index) => index % tickStep !== 0 ? null : (
              <span key={index} className="absolute top-0 flex h-full items-center normal-case tracking-normal tabular-nums"
                style={index === 0 ? { left: 4 } : index === ticks.length - 1 ? { right: 4 } : { left: `${index * 25}%`, transform: "translateX(-50%)" }}>
                {index === 0 && tick === 0 ? "0s" : fmt(tick)}
              </span>
            ))}
            {brush && (
              <span aria-hidden="true" className="rp-trace-brush pointer-events-none absolute inset-y-0"
                style={{ left: `${((brush.from - view.from) / windowMs) * 100}%`, width: `${((brush.to - brush.from) / windowMs) * 100}%` }} />
            )}
          </div>
          <div className="flex items-center">{columns}</div>
        </div>

        {rows.length === 0 ? (
          <div className="px-4 py-8 text-center text-13 text-rp-ink-subtle">{filtering ? `No step matches "${deferredQuery.trim()}".` : "No steps of the selected kinds."}</div>
        ) : <>
          {first > 0 && <div aria-hidden="true" style={{ height: first * ROW_HEIGHT }} />}
          {rendered.map(row => (
          <WaterfallRow
            key={row.span.id}
            tabStop={row.span.id === tabStopId}
            onRowFocus={() => setCursorId(row.span.id)}
            row={row}
            view={view}
            windowMs={windowMs}
            traceStart={model.start}
            nameWidth={nameWidth}
            narrow={narrow}
            showTrack={showTrack}
            showModel={showModel}
            showUsage={showUsage}
            selected={row.span.id === selectedId}
            collapsed={collapsed.has(row.span.id)}
            isContext={context.has(row.span.id)}
            isMatch={filtering && !context.has(row.span.id)}
            isActiveMatch={row.span.id === activeMatchId}
            isSlowest={slowest?.span.id === row.span.id && model.rows.length > 1}
            counted={counted.has(row.span.id)}
            cost={costs.get(row.span.id) ?? null}
            query={deferredQuery}
            onSelect={() => { if (!suppressClickRef.current) onSelect(row.span.id); }}
            onToggle={open => toggleCollapsed(row.span.id, open)}
            onFocusParent={() => row.parentId && focusRow(row.parentId)}
            onContextMenu={onRowContextMenu}
            onOpenContextMenu={onRowOpenContextMenu}
            annotations={annotationsBySpan?.get(row.span.id)}
            freshIds={freshIds}
            onClearFresh={onClearFresh}
            after={renderAfterRow?.(row.span, row.depth)}
          />
          ))}
          {last < rows.length && <div aria-hidden="true" style={{ height: (rows.length - last) * ROW_HEIGHT }} />}
        </>}
      </div>
      <div aria-hidden="true" className={cn("hidden flex-shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap border-t border-rp-line-muted px-3 py-1 font-mono text-11 text-rp-ink-subtle", width >= 560 && "md:flex")}>
        <span><kbd className="rp-kbd">j</kbd> <kbd className="rp-kbd">k</kbd> move</span>
        <span><kbd className="rp-kbd">Enter</kbd> details</span>
        {width >= 760 && <span><kbd className="rp-kbd">←</kbd> <kbd className="rp-kbd">→</kbd> fold</span>}
        {errorIds.length > 0 && <span><kbd className="rp-kbd">e</kbd> next error</span>}
        <span><kbd className="rp-kbd">{findShortcut}</kbd> find</span>
        {width >= 900 && <span>{mac ? "⌘" : "Ctrl"} + scroll or drag the axis to zoom</span>}
      </div>
    </div>
  );
}

function WaterfallRow({
  tabStop, onRowFocus, row, view, windowMs, traceStart, nameWidth, narrow, showTrack, showModel, showUsage, selected, collapsed, isContext, isMatch, isActiveMatch,
  isSlowest, counted, cost, query, onSelect, onToggle, onFocusParent, onContextMenu, onOpenContextMenu, annotations, freshIds,
  onClearFresh, after,
}: {
  tabStop: boolean; onRowFocus: () => void;
  row: TraceRow; view: Viewport; windowMs: number; traceStart: number; nameWidth: number; narrow: boolean; showTrack: boolean; showModel: boolean; showUsage: boolean;
  selected: boolean; collapsed: boolean; isContext: boolean; isMatch: boolean; isActiveMatch: boolean; isSlowest: boolean;
  counted: boolean; cost: ReturnType<typeof spanCost> | null; query: string;
  onSelect: () => void; onToggle: (open?: boolean) => void; onFocusParent: () => void;
  onContextMenu?: (event: React.MouseEvent, span: Span) => void;
  onOpenContextMenu?: (element: HTMLElement, span: Span) => void;
  annotations?: Annotation[]; freshIds?: ReadonlySet<string>; onClearFresh?: (id: string) => void; after?: ReactNode;
}) {
  const { span, depth, kind } = row;
  const isErr = span.status === "ERROR";
  const hasChildren = row.childIds.length > 0;
  const offset = span.start_time_ms - traceStart;
  const left = ((offset - view.from) / windowMs) * 100;
  const widthPct = (Math.max(0, span.duration_ms) / windowMs) * 100;
  // A step that starts where the trace ends (an instant failure that stops the
  // run) sat at left: 100% and was clipped away entirely. Keep every bar inside
  // the track, and give a failed step a mark wide enough to read as one.
  const minBarPx = isErr ? 8 : 2;
  const tokens = span.input_tokens != null || span.output_tokens != null;
  const tokenTitle = tokens ? `${span.input_tokens?.toLocaleString() ?? "unknown"} input · ${span.output_tokens?.toLocaleString() ?? "unknown"} output tokens` : undefined;
  const costText = !counted ? "" : cost?.usd != null ? fmtCost(cost.usd) : "—";
  const costTitle = !counted ? undefined : cost?.source === "reported" ? "Reported by the provider" : cost?.source === "list-price" ? "Estimated at list price" : "Cost unknown for this call";
  const tokenText = tokens ? `${span.input_tokens != null ? compactTokens(span.input_tokens) : "?"}/${span.output_tokens != null ? compactTokens(span.output_tokens) : "?"}` : "";
  // "chat claude-haiku-4-5-20251001" already names its model; repeating it in
  // the chip only took width from the name.
  // A phone-width name cell has no room for it; the step sheet shows the same values.
  const roomForChip = nameWidth >= 260;
  const chipModel = roomForChip && !showModel && span.model && !span.name.includes(shortModelName(span.model)) ? shortModelName(span.model) : "";
  const chipParts = roomForChip ? [chipModel, !showUsage && tokens ? tokenText : "", !showUsage && costText ? costText : ""].filter(Boolean) : [];
  const chipTitle = [span.model, tokenTitle, !showUsage && costText ? `${costText} (${costTitle})` : ""].filter(Boolean).join(" · ");
  const label = `${TRACE_KIND_LABEL[kind]} ${span.name}${isErr ? ", failed" : ""}, ${fmt(span.duration_ms)}`;

  return (
    <div>
      <div
        data-span-row={span.id}
        data-meridian-key={span.id}
        data-span-kind={kind}
        data-span-status={isErr ? "error" : "ok"}
        data-search-match={isMatch ? (isActiveMatch ? "active" : "true") : undefined}
        role="button"
        tabIndex={tabStop ? 0 : -1}
        aria-pressed={selected}
        aria-expanded={hasChildren ? !collapsed : undefined}
        aria-label={label}
        onMouseEnter={() => setMeridian(span.id)}
        onMouseLeave={() => clearMeridian()}
        onFocus={() => { setMeridian(span.id); onRowFocus(); }}
        onBlur={() => clearMeridian()}
        onClick={onSelect}
        onKeyDown={event => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(); }
          else if (event.key === "ArrowRight" && hasChildren) { event.preventDefault(); onToggle(true); }
          else if (event.key === "ArrowLeft") {
            if (hasChildren && !collapsed) { event.preventDefault(); onToggle(false); }
            else if (row.parentId) { event.preventDefault(); onFocusParent(); }
          } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            onOpenContextMenu?.(event.currentTarget, span);
          }
        }}
        onContextMenu={onContextMenu ? (event) => { event.preventDefault(); onContextMenu(event, span); } : undefined}
        className={cn(
          "group/row relative flex cursor-pointer items-stretch border-b border-l-2 border-b-rp-line-muted transition-colors duration-fast",
          selected ? "border-l-rp-blue bg-rp-wash" : isErr ? "border-l-rp-danger hover:bg-rp-row-hover" : "border-l-transparent hover:bg-rp-row-hover",
          isActiveMatch && !selected && "bg-rp-row-hover outline outline-1 -outline-offset-1 outline-rp-line-strong",
        )}
        style={{ height: ROW_HEIGHT }}
      >
        <div className="relative flex min-w-0 shrink-0 items-center gap-1.5 pr-2" style={{ width: nameWidth, paddingLeft: depth * INDENT + 6 }}>
          {depth > 0 && Array.from({ length: depth }, (_, index) => (
            <span key={index} aria-hidden="true" className="absolute inset-y-0 w-px bg-[color:var(--rp-guide)]" style={{ left: index * INDENT + 12 }} />
          ))}
          <span
            aria-hidden="true"
            className={cn("relative z-[1] inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-rp-ink-subtle", hasChildren && "hover:bg-rp-line-muted hover:text-rp-ink")}
            onClick={hasChildren ? (event) => { event.stopPropagation(); onToggle(); } : undefined}
          >
            {hasChildren ? (collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />) : null}
          </span>
          <span aria-hidden="true" className="size-2 shrink-0 rounded-[2px]" style={{ background: KIND_COLOR[kind] }} />
          {!narrow && <span aria-hidden="true" className="w-[46px] shrink-0 font-mono text-11 tracking-[0.04em] text-rp-ink-subtle">{TRACE_KIND_LABEL[kind]}</span>}
          {isErr && <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0 text-rp-danger" />}
          {/* Names win: the chips wrap onto a second line that the one-line
              height clips, so they disappear before the name truncates. */}
          <span data-span-name-cell className="flex h-5 min-w-0 flex-1 flex-wrap items-center gap-x-1.5 overflow-hidden">
            <span title={span.name} className={cn("min-w-0 max-w-full truncate text-13 leading-5", isErr ? "font-medium text-rp-danger" : "text-rp-ink", isContext && "opacity-60")}>
              {highlight(span.name, isMatch ? query : "")}
            </span>
            {isMatch && !span.name.toLowerCase().includes(query.trim().toLowerCase()) && (
              <FileSearch role="img" aria-label="Match inside the step's input or output" className="size-3.5 shrink-0 text-rp-ink-subtle" />
            )}
            {chipParts.length > 0 && (
              <span data-span-chip title={chipTitle} className="min-w-0 max-w-full shrink truncate rounded-sm border border-rp-line-muted px-1 font-mono text-11 leading-4 text-rp-ink-subtle">
                {chipModel && <span data-span-model>{chipModel}</span>}
                {(chipModel ? chipParts.slice(1) : chipParts).map((part, index) => <span key={part}>{chipModel || index > 0 ? " · " : ""}{part}</span>)}
              </span>
            )}
            {isSlowest && !narrow && <span className="shrink-0 rounded-sm border border-rp-line px-1 text-11 leading-4 text-rp-ink-subtle" title="The longest step in this run">slowest</span>}
          </span>
          {annotations?.map(annotation => (
            <AnnotationChip key={annotation.id} annotation={annotation} arriving={!!freshIds?.has(annotation.id)} onArrivalEnd={() => onClearFresh?.(annotation.id)} title={annotation.note ?? undefined} />
          ))}
        </div>
        <div data-trace-track hidden={!showTrack} className="relative min-w-[80px] flex-1 overflow-hidden"
          style={{ backgroundImage: "linear-gradient(to right, var(--rp-line-muted) 1px, transparent 1px)", backgroundSize: "25% 100%", backgroundPosition: "-1px 0" }}>
          <span
            aria-hidden="true"
            className={cn("absolute top-1/2 h-[10px] -translate-y-1/2 rounded-[2px]", isErr && "rp-trace-bar-error", isContext && "opacity-50")}
            data-trace-bar
            style={{ left: `min(${left}%, calc(100% - ${minBarPx}px))`, width: `max(${minBarPx}px, ${widthPct}%)`, background: isErr ? undefined : KIND_COLOR[kind] }}
          />
        </div>
        {showModel && <div className="flex w-[128px] shrink-0 items-center px-2"><span data-span-model className="truncate text-12 text-rp-ink-subtle" title={span.model ?? undefined}>{span.model ? shortModelName(span.model) : ""}</span></div>}
        {showUsage && <div className="flex w-[84px] shrink-0 items-center justify-end px-2 text-12 tabular-nums text-rp-ink-subtle" title={tokenTitle}>{tokenText}</div>}
        {showUsage && <div className="flex w-[68px] shrink-0 items-center justify-end px-2 text-12 tabular-nums text-rp-ink-subtle" title={costTitle}>{costText}</div>}
        <div className="flex w-[64px] shrink-0 items-center justify-end pr-3">
          <span data-span-duration className={cn("font-mono text-12 tabular-nums", isSlowest ? "font-semibold text-rp-ink" : "text-rp-ink-subtle")}>{fmt(span.duration_ms)}</span>
        </div>
      </div>
      {after}
    </div>
  );
}
