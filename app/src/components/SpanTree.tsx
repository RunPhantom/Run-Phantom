import { CaptureVisibilityDetails } from "./CaptureVisibilityDetails";
import { useCallback, useMemo, useRef, useState, useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import { setMeridian, clearMeridian } from "../utils/meridian";
import { cn } from "@/lib/utils";
import { fmt, tryJson, displayPayload, detectProvider, isoTimestamp } from "../utils/helpers";
import type { Span } from "../utils/types";
import { Chevron } from "./Icons";
import { JsonView } from "./JsonView";
import { AnnotationChip, KIND_STYLES, SOURCE_GLYPH, annotationSourceLabel } from "./AnnotationChip";
import { InlineCreateForm } from "./TraceAnnotations";
import type { Annotation, AnnotationKind } from "../hooks/use-annotations";
import { DeepLinkedText } from "../utils/deep-links";
import { sendRunPhantomMessage } from "../hooks/use-runphantom-ws";
import { useIsMobile } from "../hooks/use-mobile";
import { usePrefersReducedMotion } from "../hooks/use-prefers-reduced-motion";
import { GuardDecisions } from "./GuardDecisions";

function CollapsibleSection({ title, preview, data, maxExpand = 3 }: { title: string; preview: string; data: unknown; maxExpand?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(!open)}>
        <Chevron open={open} size={8} />
        <span className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-rp-ink-muted">{title}</span>
        {!open && <span className="rp-meta flex-1 truncate text-[10px]">{preview}</span>}
      </button>
      {open && (
        <div className="mt-1.5 rounded-sm border border-rp-line bg-rp-canvas-blue p-2.5">
          <JsonView data={data} maxExpand={maxExpand} />
        </div>
      )}
    </div>
  );
}

// `label` names WHICH payload this copies. Both the Input and the Output button
// announced "Copy span content", so a screen-reader user tabbing the detail pane
// heard the same control twice with no way to tell them apart.
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? `Copied span ${label}` : `Copy span ${label}`}
      className={cn("rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors duration-250 ease-standard", copied ? "bg-rp-success-soft text-rp-success" : "text-rp-ink-muted hover:bg-rp-row-hover hover:text-rp-ink")}
      onClick={() => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

// Blue marks model work, ink marks the agent acting, grey marks structure.
// Status (red) is layered on top, so a type never borrows a status colour.
const TYPE_LABEL: Record<string, { bar: string; chip: string; label: string }> = {
  TRACE: { bar: "var(--rp-line-strong)", chip: "bg-[color:var(--rp-n4)] text-rp-ink-muted", label: "TRACE" },
  TOOL_CALL: { bar: "var(--rp-ink-soft)", chip: "bg-[color:var(--rp-n4)] text-rp-ink", label: "TOOL" },
  LLM_GENERATION: { bar: "var(--rp-blue)", chip: "bg-rp-wash text-rp-blue", label: "LLM" },
  RETRIEVAL: { bar: "var(--rp-ink-soft)", chip: "bg-[color:var(--rp-n4)] text-rp-ink", label: "RETRIEVAL" },
  EMBEDDING: { bar: "var(--rp-blue)", chip: "bg-rp-wash text-rp-blue", label: "EMBEDDING" },
  INTERNAL: { bar: "var(--rp-line-strong)", chip: "bg-[color:var(--rp-n4)] text-rp-ink-muted", label: "SPAN" },
};

function typeInfo(span: Span) {
  if (span.span_type === "RETRIEVAL" || span.span_type === "EMBEDDING") return TYPE_LABEL[span.span_type];
  if (span.span_type === "TRACE") return TYPE_LABEL.TRACE;
  if (span.span_type === "TOOL_CALL") return TYPE_LABEL.TOOL_CALL;
  if (span.span_type?.includes("LLM")) return TYPE_LABEL.LLM_GENERATION;
  return TYPE_LABEL.INTERNAL;
}

function SpanRow({ span, depth, minTime, totalDur, selected, flashing, onClick, onContextMenu, onOpenContextMenu, annotations, freshIds, onClearFresh }: {
  span: Span; depth: number; minTime: number; totalDur: number;
  selected: boolean; flashing: boolean; onClick: () => void;
  onContextMenu?: (e: React.MouseEvent, span: Span) => void;
  onOpenContextMenu?: (element: HTMLElement, span: Span) => void;
  annotations: Annotation[];
  freshIds: Set<string>;
  onClearFresh: (id: string) => void;
}) {
  const info = typeInfo(span);
  const color = info.bar;
  const isErr = span.status === "ERROR";
  const leftPct = totalDur > 0 ? ((span.start_time_ms - minTime) / totalDur) * 100 : 0;
  const widthPct = totalDur > 0 ? Math.max((span.duration_ms / totalDur) * 100, 0.5) : 100;

  return (
    <div
      data-span-row={span.id}
      data-meridian-key={span.id}
      onMouseEnter={() => setMeridian(span.id)}
      onMouseLeave={() => clearMeridian()}
      onFocus={() => setMeridian(span.id)}
      onBlur={() => clearMeridian()}
      className="flex cursor-pointer items-center hover:bg-rp-row-hover"
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      style={{
        minHeight: 28,
        borderBottom: "1px solid var(--rp-line-muted)",
        background: flashing || selected
          ? "var(--rp-wash)"
          : isErr
            ? "var(--rp-danger-soft)"
            : undefined,
        borderLeft: flashing || selected ? "2px solid var(--rp-blue)" : isErr ? "2px solid var(--rp-danger)" : "2px solid transparent",
        transition: "background-color 250ms cubic-bezier(.25,.1,.25,1), border-color 250ms cubic-bezier(.25,.1,.25,1)",
      }}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          onOpenContextMenu?.(event.currentTarget, span);
        }
      }}
      onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(e, span); } : undefined}
    >
      <div className="flex items-center gap-1.5 flex-shrink-0" style={{ width: 220, paddingLeft: depth * 14 + 8, minWidth: 220 }}>
        <span className={cn("rounded-sm px-1 py-0.5 font-mono text-[10px] font-medium tracking-[0.06em]", info.chip)}>
          {info.label}
        </span>
        <span className={cn("truncate font-mono text-[12px]", isErr ? "text-rp-danger" : selected ? "text-rp-blue" : "text-rp-ink")} title={span.name}>
          {span.name}
        </span>
        {annotations.map((a) => (
          <AnnotationChip
            key={a.id}
            annotation={a}
            arriving={freshIds.has(a.id)}
            onArrivalEnd={() => onClearFresh(a.id)}
            title={a.note ?? undefined}
          />
        ))}
      </div>
      <div className="flex-1 relative mx-2" style={{ height: 10 }}>
        <div className="absolute rounded-sm"
          style={{
            left: `${leftPct}%`,
            width: `${widthPct}%`,
            top: 0,
            height: 10,
            backgroundColor: isErr ? "var(--rp-danger)" : color,
            minWidth: 2,
          }} />
      </div>
      <div className="flex-shrink-0 text-right pr-3" style={{ width: 55 }}>
        <span className="font-mono text-[11px] tabular-nums text-rp-ink-muted">{fmt(span.duration_ms)}</span>
      </div>
    </div>
  );
}

// The last 12 characters turned "demo_review_tool-1" into "eview_tool-1",
// which reads as a mangled word. Show the whole id and let CSS add the
// ellipsis when the column is genuinely too narrow.
function SpanIdCopy({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetRef.current) window.clearTimeout(resetRef.current);
  }, []);

  return (
    <button
      type="button"
      className={cn("w-full min-w-0 truncate rounded-sm text-left transition-colors duration-250 ease-standard hover:text-rp-blue", copied ? "text-rp-success" : "text-rp-ink")}
      title={id}
      aria-label={`Copy span id ${id}`}
      onClick={() => {
        void navigator.clipboard.writeText(id).then(() => {
          setCopied(true);
          if (resetRef.current) window.clearTimeout(resetRef.current);
          resetRef.current = window.setTimeout(() => setCopied(false), 1200);
        }).catch(() => {});
      }}
    >
      {id}
    </button>
  );
}

function SpanDetail({ span }: { span: Span }) {
  const info = typeInfo(span);
  const isErr = span.status === "ERROR";

  return (
    <div className="rp-fade-rise sb h-full space-y-4 overflow-auto p-4 sm:p-5">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className={cn("rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-[0.06em]", info.chip)}>
            {info.label}
          </span>
          {isErr && <span className="rounded-sm bg-rp-danger-soft px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-[0.06em] text-rp-danger">ERROR</span>}
          {(() => { const p = detectProvider(span.model, span.provider); return p ? <span className="rounded-sm border border-rp-line bg-white px-1.5 py-0.5 font-mono text-[10px] font-medium text-rp-ink-muted">{p.label}</span> : null; })()}
        </div>
        <div className="mt-1.5 break-all font-display text-[18px] font-semibold tracking-[-0.02em] text-rp-ink">{span.name}</div>
      </div>

      {isErr && span.output_payload && (
        <div className="rounded-sm border border-rp-danger-border bg-rp-danger-soft p-3">
          <div className="mb-1 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-rp-danger">Error</div>
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-rp-danger">{displayPayload(span.output_payload)}</pre>
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-4 gap-y-1.5 border-y border-rp-line-muted py-3 font-mono text-[11px] tabular-nums">
        <div className="text-rp-ink-muted">duration</div>
        <div className="text-rp-ink">{fmt(span.duration_ms)}</div>
        {span.model && <><div className="text-rp-ink-muted">model</div><div className="text-rp-ink">{span.model}</div></>}
        {span.input_tokens != null && <><div className="text-rp-ink-muted">input tokens</div><div className="text-rp-ink">{span.input_tokens.toLocaleString()}</div></>}
        {span.output_tokens != null && <><div className="text-rp-ink-muted">output tokens</div><div className="text-rp-ink">{span.output_tokens.toLocaleString()}</div></>}
        <div className="text-rp-ink-muted">status</div>
        <div className={isErr ? "text-rp-danger" : "text-rp-ink"}>{span.status}</div>
        <div className="text-rp-ink-muted">start</div>
        <div className="text-rp-ink">{isoTimestamp(span.start_time_ms)}</div>
        <div className="text-rp-ink-muted">end</div>
        <div className="text-rp-ink">{isoTimestamp(span.end_time_ms)}</div>
        <div className="text-rp-ink-muted">span id</div>
        <SpanIdCopy id={span.id} />
        {span.attributes && (() => { try { const a = JSON.parse(span.attributes); return a["ai.provider.baseURL"] ? <><div className="text-rp-ink-muted">base url</div><div className="text-rp-ink-muted">{a["ai.provider.baseURL"]}</div></> : null; } catch { return null; } })()}
      </div>

      {span.attributes && (() => {
        try {
          const attrs: unknown = JSON.parse(span.attributes);
          if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return null;
          const configObj: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(attrs)) {
            if (k === "ai.provider.headers" ||
                k === "ai.request.thinking" || k === "ai.request.providerOptions" ||
                k.startsWith("ai.settings.") || k.startsWith("ai.request.headers.") ||
                (k.startsWith("gen_ai.request.") && k !== "gen_ai.request.model")) {
              const label = k.replace("gen_ai.request.", "").replace("ai.provider.", "").replace("ai.request.", "").replace("ai.settings.", "settings.");
              let parsed = v;
              if (typeof v === "string") { try { parsed = JSON.parse(v); } catch {} }
              if (label === "providerOptions" && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                const parsedOptions = parsed as Record<string, unknown>;
                const keys = Object.keys(parsedOptions);
                if (keys.length === 1 && typeof parsedOptions[keys[0]] === "object") {
                  const inner = parsedOptions[keys[0]];
                  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
                    for (const [ik, iv] of Object.entries(inner)) {
                      configObj[ik] = iv;
                    }
                  }
                  continue;
                }
              }
              configObj[label] = parsed;
            }
          }
          if (Object.keys(configObj).length === 0) return null;
          const previewVal = (v: unknown): string => {
            if (v === null) return "null";
            if (v === true || v === false) return String(v);
            if (typeof v === "string") return v.length > 25 ? v.slice(0, 25) + "\u2026" : v;
            if (typeof v === "number") return String(v);
            if (Array.isArray(v)) return `[${v.length}]`;
            if (v && typeof v === "object") {
              const entries = Object.entries(v).slice(0, 3);
              const inner = entries.map(([ik, iv]) => `${ik}: ${typeof iv === "object" ? (iv === null ? "null" : Array.isArray(iv) ? `[${iv.length}]` : "{...}") : previewVal(iv)}`).join(", ");
              return entries.length < Object.keys(v).length ? `${inner}, \u2026` : inner;
            }
            return String(v);
          };
          const preview = Object.entries(configObj).map(([k, v]) => `${k}: ${previewVal(v)}`).join("  \u00B7  ");

          const providerName = (() => {
            const providerValue = Object.entries(attrs).find(([key]) => key === "ai.model.provider")?.[1];
            const p = typeof providerValue === "string" ? providerValue : undefined;
            if (!p) return "";
            const name = p.split(".")[0];
            return name.charAt(0).toUpperCase() + name.slice(1);
          })();
          const title = providerName ? `Provider Options (${providerName})` : "Provider Options";
          return <CollapsibleSection title={title} preview={preview} data={configObj} maxExpand={10} />;
        } catch { return null; }
      })()}

      <GuardDecisions evidence={span.guardEvidence} />

      <CaptureVisibilityDetails span={span} />

      {span.input_payload && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <div className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-rp-ink-muted">Input</div>
            <CopyButton label="input" text={tryJson(span.input_payload) ?? span.input_payload} />
          </div>
          <div className="rounded-sm border border-rp-line bg-rp-canvas-blue p-2.5">
            <JsonView data={span.input_payload} />
          </div>
        </div>
      )}

      {span.output_payload && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <div className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-rp-ink-muted">Output</div>
            <CopyButton label="output" text={tryJson(span.output_payload) ?? span.output_payload} />
          </div>
          <div className="rounded-sm border border-rp-line bg-rp-canvas-blue p-2.5">
            <JsonView data={span.output_payload} />
          </div>
        </div>
      )}
    </div>
  );
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
}

interface ContextMenuState {
  spanId: string;
  x: number;
  y: number;
}

const EMPTY_ANNOTATIONS: Annotation[] = [];
const EMPTY_FRESH_IDS = new Set<string>();

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
}: SpanTreeProps) {
  const isMobile = useIsMobile();
  const prefersReducedMotion = usePrefersReducedMotion();
  const controlled = onSelectSpan !== undefined;
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null);
  const selectedId = controlled ? (selectedSpanId ?? null) : internalSelectedId;
  const setSelectedId = useCallback((id: string | null) => {
    if (controlled) onSelectSpan?.(id);
    else setInternalSelectedId(id);
  }, [controlled, onSelectSpan]);
  const autoSelectedRunRef = useRef<string | null>(null);
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
  const [flashId, setFlashId] = useState<string | null>(null);
  const runId = spans[0]?.run_id ?? null;
  const reportedSelectedId = selectedId && spans.some((s) => s.id === selectedId) ? selectedId : null;

  useEffect(() => {
    if (controlled || isMobile || !runId || autoSelectedRunRef.current === runId) return;
    autoSelectedRunRef.current = runId;
    setInternalSelectedId(spans[0]?.id ?? null);
  }, [controlled, isMobile, runId, spans]);

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
      setFlashId(spanId);
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(`[data-span-row="${spanId}"]`);
        el?.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "center" });
      });
      window.setTimeout(() => setFlashId(null), 1500);
    };
    window.addEventListener("runphantom:deep-link-span", handler);
    return () => window.removeEventListener("runphantom:deep-link-span", handler);
  }, [controlled, prefersReducedMotion, spans]);

  useEffect(() => {
    if (!selectedSpanId) return;
    setFlashId(selectedSpanId);
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-span-row="${selectedSpanId}"]`);
      el?.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "center" });
    });
    const timeout = window.setTimeout(() => setFlashId(null), 1500);
    return () => window.clearTimeout(timeout);
  }, [prefersReducedMotion, selectedSpanId]);

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

  const spanMap = new Map(spans.map(s => [s.id, s]));
  const children = new Map<string, Span[]>();
  const roots: Span[] = [];
  for (const s of spans) {
    if (!s.parent_span_id || !spanMap.has(s.parent_span_id)) roots.push(s);
    else { const c = children.get(s.parent_span_id) ?? []; c.push(s); children.set(s.parent_span_id, c); }
  }

  const flat: { span: Span; depth: number }[] = [];
  function walk(span: Span, depth: number) {
    flat.push({ span, depth });
    for (const kid of children.get(span.id) ?? []) walk(kid, depth + 1);
  }
  for (const r of roots) walk(r, 0);

  const minTime = flat.length > 0 ? Math.min(...flat.map(f => f.span.start_time_ms)) : 0;
  const maxTime = flat.length > 0 ? Math.max(...flat.map(f => f.span.end_time_ms)) : 0;
  const totalDur = maxTime - minTime || 1;

  const selectedSpan = selectedId ? spanMap.get(selectedId) : null;

  if (flat.length === 0) return <div className="rounded-lg border border-dashed border-rp-line-dashed bg-rp-surface px-6 py-8 text-center text-[13px] text-rp-ink-muted">No spans</div>;

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-rp-line bg-rp-surface">
      <div className="flex flex-1 min-h-0">
        <div
          className="overflow-auto sb"
          style={{
            display: isMobile && selectedSpan ? "none" : undefined,
            flex: selectedSpan ? "0 0 50%" : "1 1 auto",
            borderRight: selectedSpan && !isMobile ? "1px solid var(--rp-line)" : "none",
          }}
        >
          <div className="sticky top-0 z-10 flex items-center border-b border-rp-line bg-rp-surface px-2 py-2">
            <div className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-rp-ink-muted" style={{ width: 220 }}>Span</div>
            <div className={cn("font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-rp-ink-muted", "flex-1")}>Timeline</div>
            <div className={cn("font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-rp-ink-muted", "pr-3 text-right")} style={{ width: 55 }}>Dur</div>
          </div>
          {flat.map(({ span, depth }) => (
            <div key={span.id}>
              <SpanRow
                span={span} depth={depth}
                minTime={minTime} totalDur={totalDur}
                selected={span.id === selectedId}
                flashing={span.id === flashId}
                onClick={() => setSelectedId(span.id === selectedId ? null : span.id)}
                onContextMenu={onCreateAnnotation ? (e, s) => {
                  restoreFocusRef.current = e.currentTarget as HTMLElement;
                  setContextMenu({ spanId: s.id, x: e.clientX, y: e.clientY });
                } : undefined}
                onOpenContextMenu={onCreateAnnotation ? (element, s) => {
                  restoreFocusRef.current = element;
                  const bounds = element.getBoundingClientRect();
                  setContextMenu({ spanId: s.id, x: bounds.left + 24, y: bounds.top + bounds.height });
                } : undefined}
                annotations={annotationsBySpan.get(span.id) ?? []}
                freshIds={freshIds}
                onClearFresh={onClearFresh}
              />
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
            </div>
          ))}
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

        {selectedSpan && (
          <div
            role="region"
            aria-label="Span details"
            className="min-w-0 overflow-auto sb"
            style={{ flex: isMobile ? "1 1 100%" : "0 0 50%", background: "var(--rp-surface)" }}
          >
            {isMobile && (
              <div className="sticky top-0 z-10 border-b border-rp-line bg-rp-surface px-2 py-1.5">
                <button
                  type="button"
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-control px-2 text-[13px] font-medium text-rp-ink transition-colors duration-250 ease-standard hover:bg-rp-row-hover"
                  onClick={() => setSelectedId(null)}
                >
                  <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5 text-rp-ink-muted" />
                  Back to span list
                </button>
              </div>
            )}
            <SpanDetail span={selectedSpan} />
          </div>
        )}
      </div>
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
