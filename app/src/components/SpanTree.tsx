import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Span } from "../utils/types";
import { KIND_STYLES, SOURCE_GLYPH, annotationSourceLabel } from "./AnnotationChip";
import { InlineCreateForm } from "./TraceAnnotations";
import type { Annotation, AnnotationKind } from "../hooks/use-annotations";
import { DeepLinkedText } from "../utils/deep-links";
import { sendRunPhantomMessage } from "../hooks/use-runphantom-ws";
import { useIsMobile } from "../hooks/use-mobile";
import { useDialogFocus } from "../hooks/use-dialog-focus";
import { Waterfall } from "./run-detail/Waterfall";
import { SpanDrawer, type DrawerMode } from "./run-detail/SpanDrawer";
import { buildTraceModel, countedLlmSpans } from "./run-detail/trace-model";

const DRAWER_WIDTH_KEY = "runphantom:span-drawer:width";
const DRAWER_MIN = 360;
const DRAWER_MAX = 720;
const DRAWER_DEFAULT = 400;
/** The drawer may shrink below its preferred minimum when the pane is too narrow for both. */
const DRAWER_FLOOR = 280;
const MIN_TRACE_WIDTH = 240;

function readDrawerWidth(): number {
  try {
    const value = Number(localStorage.getItem(DRAWER_WIDTH_KEY));
    return Number.isFinite(value) && value >= DRAWER_MIN && value <= DRAWER_MAX ? value : DRAWER_DEFAULT;
  } catch { return DRAWER_DEFAULT; }
}

interface SpanTreeProps {
  spans: Span[];
  selectedSpanId?: string | null;
  onSelectSpan?: (spanId: string | null) => void;
  annotations?: Annotation[];
  freshIds?: Set<string>;
  onClearFresh?: (id: string) => void;
  onCreateAnnotation?: (input: { span_id?: string | null; kind: AnnotationKind; note?: string; source?: "user" | "claude-code" }) => Promise<Annotation | null>;
  annotationError?: string | null;
  onDeleteAnnotation?: (id: string) => Promise<void>;
  /** Root span ids of detected sub-agents, drawn as agents in the waterfall. */
  agentRootIds?: ReadonlySet<string>;
}

interface ContextMenuState {
  spanId: string;
  x: number;
  y: number;
}

const EMPTY_ANNOTATIONS: Annotation[] = [];
const EMPTY_FRESH_IDS = new Set<string>();

function MobileSheet({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(true, ref, onClose);
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Step details" className="rp-sheet-in fixed inset-0 z-50 flex flex-col bg-rp-surface">
      {children}
    </div>
  );
}

export function SpanTree({
  spans,
  selectedSpanId,
  onSelectSpan,
  annotations = EMPTY_ANNOTATIONS,
  freshIds = EMPTY_FRESH_IDS,
  onClearFresh = () => {},
  onCreateAnnotation,
  annotationError,
  onDeleteAnnotation,
  agentRootIds,
}: SpanTreeProps) {
  const isMobile = useIsMobile();
  const controlled = onSelectSpan !== undefined;
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null);
  const selectedId = controlled ? (selectedSpanId ?? null) : internalSelectedId;
  const setSelectedId = useCallback((id: string | null) => {
    if (controlled) onSelectSpan?.(id);
    else setInternalSelectedId(id);
  }, [controlled, onSelectSpan]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [addingForSpan, setAddingForSpan] = useState<string | null>(null);
  // The context menu and the note form both take focus when they mount. Without
  // this, dismissing either drops focus to <body>, so a keyboard user restarts
  // from the top of the tree instead of the span they were annotating. Holds the
  // invoking row across the menu -> form handoff, so the form's dismissal is what
  // finally returns focus.
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const restoreFocus = useCallback(() => {
    const el = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (el?.isConnected) el.focus();
  }, []);
  const runId = spans[0]?.run_id ?? null;
  const reportedSelectedId = selectedId && spans.some((s) => s.id === selectedId) ? selectedId : null;
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(1200);
  const [drawerWidth, setDrawerWidth] = useState(readDrawerWidth);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => setContainerWidth(element.getBoundingClientRect().width || 1200);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!runId) return;
    sendRunPhantomMessage({ type: "ui_view", run_id: runId, span_id: reportedSelectedId });
  }, [runId, reportedSelectedId]);

  useEffect(() => {
    if (!runId) return;
    return () => sendRunPhantomMessage({ type: "ui_view", run_id: runId, span_id: null });
  }, [runId]);

  useEffect(() => {
    if (controlled) return;
    const spanIds = new Set(spans.map((s) => s.id));
    const handler = (ev: Event) => {
      const spanId = (ev as CustomEvent).detail?.spanId as string | undefined;
      if (!spanId || !spanIds.has(spanId)) return;
      setInternalSelectedId(spanId);
    };
    window.addEventListener("runphantom:deep-link-span", handler);
    return () => window.removeEventListener("runphantom:deep-link-span", handler);
  }, [controlled, spans]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      restoreFocus();
    };
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onEsc);
    };
  }, [contextMenu, restoreFocus]);

  const annotationsBySpan = useMemo(() => {
    const map = new Map<string, Annotation[]>();
    for (const a of annotations) {
      if (!a.span_id) continue;
      const arr = map.get(a.span_id) ?? [];
      arr.push(a);
      map.set(a.span_id, arr);
    }
    return map;
  }, [annotations]);

  const model = useMemo(() => buildTraceModel(spans, agentRootIds), [spans, agentRootIds]);
  const counted = useMemo(() => new Set(countedLlmSpans(spans).map(span => span.id)), [spans]);
  const selectedSpan = selectedId ? model.byId.get(selectedId)?.span ?? null : null;

  const closeDrawer = useCallback(() => {
    const id = selectedId;
    setSelectedId(null);
    if (id) requestAnimationFrame(() => containerRef.current?.querySelector<HTMLElement>(`[data-span-row="${CSS.escape(id)}"]`)?.focus());
  }, [selectedId, setSelectedId]);

  // Docked beside the trace at every desktop width: an overlay covered rows the
  // reader still needed to click. A narrow trace drops its time track instead.
  const mode: DrawerMode = isMobile ? "sheet" : "docked";
  const maxDrawer = Math.max(DRAWER_FLOOR, Math.min(DRAWER_MAX, Math.round(containerWidth - MIN_TRACE_WIDTH)));
  const effectiveDrawer = Math.max(DRAWER_FLOOR, Math.min(drawerWidth, maxDrawer));
  const waterfallWidth = selectedSpan && mode === "docked" ? containerWidth - effectiveDrawer : containerWidth;

  const setWidth = useCallback((width: number) => {
    const next = Math.round(Math.min(DRAWER_MAX, Math.max(DRAWER_MIN, width)));
    setDrawerWidth(next);
    try { localStorage.setItem(DRAWER_WIDTH_KEY, String(next)); } catch { /* storage unavailable */ }
  }, []);

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const right = containerRef.current?.getBoundingClientRect().right ?? window.innerWidth;
    setDragging(true);
    const move = (moveEvent: PointerEvent) => setWidth(Math.min(maxDrawer, right - moveEvent.clientX));
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Esc closes the drawer from anywhere inside the trace, after the search has
  // had its chance to clear itself (it stops propagation when it does).
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || !selectedSpan || contextMenu || addingForSpan) return;
    if ((event.target as HTMLElement).closest("input, textarea, select")) return;
    event.preventDefault();
    closeDrawer();
  };

  if (spans.length === 0) return <div className="rounded-lg border border-dashed border-rp-line-dashed bg-rp-surface px-6 py-8 text-center text-[13px] text-rp-ink-muted">No spans</div>;

  const renderAfterRow = (span: Span, depth: number) => (
    <>
      {addingForSpan === span.id && onCreateAnnotation && (
        <div style={{ padding: "4px 10px 6px", paddingLeft: depth * 14 + 40 }}>
          <InlineCreateForm
            compact
            error={annotationError ?? null}
            onCancel={() => { setAddingForSpan(null); restoreFocus(); }}
            onSubmit={async ({ kind, note }) => {
              // Keep the form (and the note) up when the save fails.
              const saved = await onCreateAnnotation({ span_id: span.id, kind, note, source: "user" });
              if (!saved) return;
              setAddingForSpan(null);
              restoreFocus();
            }}
          />
        </div>
      )}
      {selectedId === span.id && (annotationsBySpan.get(span.id) ?? []).length > 0 && (
        <div style={{ padding: "4px 10px 6px", paddingLeft: depth * 14 + 40, display: "flex", flexDirection: "column", gap: 4 }}>
          {(annotationsBySpan.get(span.id) ?? []).map((a) => {
            const st = KIND_STYLES[a.kind];
            return (
              <div key={a.id} style={{ padding: "7px 9px", border: `1px solid ${st.border}`, background: st.bg, borderRadius: 4, display: "flex", alignItems: "flex-start", gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--rp-ink)", lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  <span style={{ color: "var(--rp-ink-muted)", fontSize: 11, marginRight: 6 }}>
                    {SOURCE_GLYPH[a.source]} {annotationSourceLabel(a.source)}
                  </span>
                  {a.note ? <DeepLinkedText text={a.note} /> : <em style={{ color: "var(--rp-ink-muted)" }}>(no note)</em>}
                </div>
                {onDeleteAnnotation && (
                  <button
                    type="button"
                    aria-label={`Delete ${a.kind} annotation`}
                    onClick={(e) => { e.stopPropagation(); void onDeleteAnnotation(a.id); }}
                    title="Delete annotation"
                    className="rounded-sm text-rp-ink-muted transition-colors duration-250 ease-standard hover:bg-rp-row-hover hover:text-rp-ink"
                    style={{ background: "transparent", border: 0, fontSize: 14, cursor: "pointer", minWidth: 24, minHeight: 24, padding: "0 4px", lineHeight: 1 }}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );

  const drawer = selectedSpan && (
    <SpanDrawer
      span={selectedSpan}
      spans={spans}
      agentRootIds={agentRootIds}
      traceStart={model.start}
      mode={mode}
      onClose={closeDrawer}
      counted={counted.has(selectedSpan.id)}
    />
  );

  return (
    <div ref={containerRef} onKeyDown={onKeyDown} className="relative flex h-full min-h-0 overflow-hidden border-t border-rp-line bg-rp-surface">
      <div className="min-w-0 flex-1">
        <Waterfall
          spans={spans}
          agentRootIds={agentRootIds}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId(id === selectedId ? null : id)}
          annotationsBySpan={annotationsBySpan}
          freshIds={freshIds}
          onClearFresh={onClearFresh}
          width={waterfallWidth}
          onRowContextMenu={onCreateAnnotation ? (e, s) => {
            restoreFocusRef.current = e.currentTarget as HTMLElement;
            setContextMenu({ spanId: s.id, x: e.clientX, y: e.clientY });
          } : undefined}
          onRowOpenContextMenu={onCreateAnnotation ? (element, s) => {
            restoreFocusRef.current = element;
            const bounds = element.getBoundingClientRect();
            setContextMenu({ spanId: s.id, x: bounds.left + 24, y: bounds.top + bounds.height });
          } : undefined}
          renderAfterRow={renderAfterRow}
        />
      </div>
      {contextMenu && onCreateAnnotation && (
        <SpanContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => { setContextMenu(null); restoreFocus(); }}
          onMarkKind={async (kind) => {
            await onCreateAnnotation({ span_id: contextMenu.spanId, kind, source: "user" });
            setContextMenu(null);
            restoreFocus();
          }}
          onAddNote={() => {
            setAddingForSpan(contextMenu.spanId);
            setContextMenu(null);
          }}
        />
      )}
      {drawer && mode === "sheet" && <MobileSheet onClose={closeDrawer}>{drawer}</MobileSheet>}
      {drawer && mode !== "sheet" && (
        <div
          className="relative flex flex-shrink-0 border-l border-rp-line"
          style={{ width: effectiveDrawer }}
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize step details"
            aria-valuemin={Math.min(DRAWER_MIN, maxDrawer)}
            aria-valuemax={maxDrawer}
            aria-valuenow={effectiveDrawer}
            tabIndex={0}
            data-dragging={dragging || undefined}
            onPointerDown={startResize}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") { event.preventDefault(); setWidth(Math.min(maxDrawer, effectiveDrawer + 24)); }
              else if (event.key === "ArrowRight") { event.preventDefault(); setWidth(effectiveDrawer - 24); }
              else if (event.key === "Home") { event.preventDefault(); setWidth(Math.min(DRAWER_MIN, maxDrawer)); }
              else if (event.key === "End") { event.preventDefault(); setWidth(maxDrawer); }
            }}
            className="rp-drawer-handle absolute inset-y-0 -left-[3px] z-10 w-[6px] cursor-col-resize"
          />
          <div className="min-w-0 flex-1">{drawer}</div>
        </div>
      )}
    </div>
  );
}

function SpanContextMenu({ x, y, onClose, onMarkKind, onAddNote }: {
  x: number; y: number; onClose: () => void;
  onMarkKind: (kind: AnnotationKind) => void | Promise<void>;
  onAddNote: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const clampedX = Math.min(x, window.innerWidth - 230);
  const clampedY = Math.min(y, window.innerHeight - 180);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, []);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    );
    const currentIndex = items.indexOf(event.target as HTMLButtonElement);
    if (currentIndex < 0 || items.length === 0) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Annotate span"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onMenuKeyDown}
      className="rp-pop rounded-md border border-rp-line bg-rp-surface p-1 text-[13px] text-rp-ink shadow-e3"
      style={{
        position: "fixed",
        top: clampedY, left: clampedX, zIndex: 50,
        minWidth: 210,
      }}
    >
      <div className="rp-eyebrow px-2 pb-1 pt-1.5">
        Annotate span
      </div>
      {(["issue", "good", "note"] as AnnotationKind[]).map((kind) => {
        const s = KIND_STYLES[kind];
        return (
          <button
            key={kind}
            type="button"
            role="menuitem"
            onClick={() => { if (kind === "note") onAddNote(); else onMarkKind(kind); }}
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 text-left transition-colors duration-250 ease-standard hover:bg-rp-row-hover"
          >
            <span style={{ width: 14, textAlign: "center", color: s.fg, fontWeight: 700 }}>{s.icon}</span>
            <span style={{ flex: 1 }}>{kind === "note" ? "Add note…" : `Mark as ${kind}`}</span>
          </button>
        );
      })}
    </div>
  );
}
