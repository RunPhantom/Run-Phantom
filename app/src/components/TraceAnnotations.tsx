import { useEffect, useRef, useState } from "react";
import { KIND_STYLES, SOURCE_GLYPH, AnnotationChip, ANNOTATION_ARRIVAL_MS, annotationSourceLabel } from "./AnnotationChip";
import type { Annotation, AnnotationKind } from "../hooks/use-annotations";
import { DeepLinkedText } from "../utils/deep-links";

const C = {
  bg: "var(--rp-canvas)",
  panel: "var(--rp-surface)",
  border: "var(--rp-border)",
  fg: "var(--rp-ink-strong)",
  muted: "var(--rp-ink-muted)",
};

interface TraceAnnotationsProps {
  annotations: Annotation[];
  freshIds: Set<string>;
  onClearFresh: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
}

export function TraceAnnotations({ annotations, freshIds, onClearFresh, onDelete }: TraceAnnotationsProps) {
  const traceAnnotations = annotations.filter((a) => a.span_id === null);
  if (traceAnnotations.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-label="Run annotations"
      style={{
        padding: "4px 16px",
        borderBottom: `1px solid ${C.border}`,
        background: C.panel,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        // Without a ceiling this strip grows with the notes in it and pushes the
        // tab bar and the whole span tree below the fold.
        maxHeight: "min(38vh, 320px)",
        overflowY: "auto",
      }}
    >
      {traceAnnotations.map((a) => (
        <TraceAnnotationRow
          key={a.id}
          annotation={a}
          arriving={freshIds.has(a.id)}
          onArrivalEnd={() => onClearFresh(a.id)}
          onDelete={() => onDelete(a.id)}
        />
      ))}
    </div>
  );
}

function TraceAnnotationRow({
  annotation,
  arriving,
  onArrivalEnd,
  onDelete,
}: {
  annotation: Annotation;
  arriving: boolean;
  onArrivalEnd: () => void;
  onDelete: () => void;
}) {
  const style = KIND_STYLES[annotation.kind];
  const author = annotationSourceLabel(annotation.source);
  const endRef = useRef(onArrivalEnd);
  endRef.current = onArrivalEnd;

  useEffect(() => {
    if (!arriving) return;
    const handle = window.setTimeout(() => endRef.current(), ANNOTATION_ARRIVAL_MS);
    return () => window.clearTimeout(handle);
  }, [arriving]);

  return (
    <div
      className={arriving ? `annotation-arriving kind-${annotation.kind}` : undefined}
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        padding: "8px 10px",
        border: `1px solid ${style.border}`,
        borderRadius: "var(--rp-r-lg)",
        background: style.bg,
        boxShadow: "var(--rp-e-inset)",
      }}
    >
      <span style={{ color: C.muted, width: 14, flex: "0 0 14px", fontSize: 11, textAlign: "center", marginTop: 1 }}>
        {SOURCE_GLYPH[annotation.source]}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
          <AnnotationChip annotation={annotation} showLabel />
          <span style={{ fontSize: 10, color: C.muted }}>{author} · {timeAgo(annotation.created_at)}</span>
        </div>
        {annotation.note && (
          <div
            style={{
              fontSize: 12,
              color: C.fg,
              lineHeight: 1.5,
              // The composer takes Enter as a newline and the note is stored with
              // it, so the paragraph the user wrote has to survive rendering.
              whiteSpace: "pre-wrap",
              // A URL, hash, base64 blob or stack path has no break opportunity
              // and ran past the card's edge, clipped and unreadable.
              overflowWrap: "anywhere",
            }}
          >
            <DeepLinkedText text={annotation.note} />
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label={`Delete ${annotation.kind} annotation`}
        onClick={onDelete}
        title="Delete annotation"
        style={{
          background: "transparent",
          border: 0,
          color: C.muted,
          fontSize: 14,
          cursor: "pointer",
          minWidth: 24,
          minHeight: 24,
          padding: "0 4px",
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  );
}

export function InlineCreateForm({
  initialKind = "note",
  onCancel,
  onSubmit,
  compact = false,
  title,
  submitLabel = "Save",
  frameless = false,
  error = null,
}: {
  initialKind?: AnnotationKind;
  onCancel: () => void;
  onSubmit: (input: { kind: AnnotationKind; note: string }) => void | Promise<unknown>;
  compact?: boolean;
  title?: string;
  submitLabel?: string;
  frameless?: boolean;
  error?: string | null;
}) {
  const [kind, setKind] = useState<AnnotationKind>(initialKind);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  // Guarded because Cmd+Enter and the Save button could both fire before the
  // first request settled, storing the same note twice.
  async function save() {
    if (saving) return;
    setSaving(true);
    try { await onSubmit({ kind, note: note.trim() }); }
    finally { setSaving(false); }
  }

  return (
    <div
      style={{
        padding: compact ? "8px" : frameless ? "8px 10px 12px" : "10px",
        background: frameless ? "transparent" : "var(--rp-surface)",
        border: frameless ? "none" : `1px solid ${C.border}`,
        borderRadius: "var(--rp-r-lg)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        boxShadow: frameless ? "none" : "0 1px 0 var(--rp-inset-hairline-soft) inset",
      }}
    >
      {title && (
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.fg }}>{title}</div>
          <span style={{ fontSize: 10, color: C.muted }}>Run note</span>
        </div>
      )}
      <div role="group" aria-label="Annotation type" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {(["issue", "good", "note"] as AnnotationKind[]).map((k) => {
          const s = KIND_STYLES[k];
          const selected = k === kind;
          return (
            <button
              type="button"
              key={k}
              aria-pressed={selected}
              onClick={() => setKind(k)}
              style={{
                padding: "1px 9px",
                borderRadius: "var(--rp-r-full)",
                fontSize: 10,
                fontWeight: 500,
                lineHeight: "18px",
                cursor: "pointer",
                color: selected ? s.fg : C.muted,
                background: selected ? s.bg : "var(--rp-ink-wash)",
                border: `1px solid ${selected ? s.border : C.border}`,
              }}
            >
              <span style={{ fontWeight: 700, marginRight: 3 }}>{s.icon}</span>
              {s.label}
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: C.muted, whiteSpace: "nowrap" }}>
          <kbd style={{ background: "var(--rp-ink-wash)", padding: "0 4px", borderRadius: 3 }}>⌘↵</kbd> save ·{" "}
          <kbd style={{ background: "var(--rp-ink-wash)", padding: "0 4px", borderRadius: 3 }}>esc</kbd> cancel
        </span>
      </div>
      <textarea
        autoFocus
        aria-label="Annotation note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What did you notice?"
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
        }}
        style={{
          minHeight: 48,
          padding: "7px 8px",
          border: `1px solid ${C.border}`,
          background: C.bg,
          borderRadius: "var(--rp-r-md)",
          color: C.fg,
          fontSize: 12,
          fontFamily: "inherit",
          resize: "vertical",
          outline: "none",
        }}
      />
      {error && (
        <div role="alert" style={{ fontSize: 11, lineHeight: 1.45, color: "var(--rp-danger)" }}>
          {error}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={onCancel}
          style={{ padding: "4px 10px", fontSize: 11, background: "transparent", border: `1px solid ${C.border}`, borderRadius: "var(--rp-r-md)", color: C.muted, cursor: "pointer" }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          style={{ padding: "4px 10px", fontSize: 11, background: C.fg, border: `1px solid ${C.fg}`, borderRadius: "var(--rp-r-md)", color: "var(--rp-canvas)", cursor: saving ? "default" : "pointer", fontWeight: 600, opacity: saving ? 0.6 : 1 }}
        >
          {saving ? "Saving…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

export function AnnotationCreatePopover({
  anchorRef,
  onClose,
  onSubmit,
  error = null,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onSubmit: (input: { kind: AnnotationKind; note: string }) => void | Promise<unknown>;
  error?: string | null;
}) {
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node) && !anchorRef.current?.contains(e.target as Node)) onClose();
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
      window.requestAnimationFrame(() => anchorRef.current?.focus());
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [anchorRef, onClose]);

  return (
    <div
      ref={(el) => {
        popRef.current = el;
        if (!el || !anchorRef.current) return;
        const btn = anchorRef.current.getBoundingClientRect();
        el.style.top = `${btn.bottom + 4}px`;
        el.style.right = `${window.innerWidth - btn.right}px`;
      }}
      className="fixed z-[9999] rounded-lg p-1.5 shadow-xl"
      role="dialog"
      aria-label="Annotate run"
      style={{
        background: "var(--rp-surface)",
        border: "1px solid var(--rp-border)",
        boxShadow: "var(--rp-e3)",
        width: "min(360px, calc(100vw - 32px))",
      }}
    >
      <InlineCreateForm
        title="Annotate run"
        submitLabel="Add annotation"
        frameless
        error={error}
        onCancel={onClose}
        onSubmit={async (input) => {
          // Only dismiss on a real save. Closing unconditionally threw away the
          // typed note whenever the request failed, with nothing shown.
          const saved = await onSubmit(input);
          if (saved !== null && saved !== false) onClose();
        }}
      />
    </div>
  );
}

function timeAgo(ts: number): string {
  const delta = (Date.now() - ts) / 1000;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86400)}d ago`;
}
