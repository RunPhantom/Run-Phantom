import { useEffect, useRef, useState } from "react";
import { KIND_STYLES, SOURCE_GLYPH, AnnotationChip, ANNOTATION_ARRIVAL_MS, annotationSourceLabel } from "./AnnotationChip";
import type { Annotation, AnnotationKind } from "../hooks/use-annotations";
import { DeepLinkedText } from "../utils/deep-links";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { fieldClassName } from "@/components/ui/input";

const C = {
  panel: "var(--rp-surface)",
  border: "var(--rp-line)",
  fg: "var(--rp-ink)",
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
        padding: "6px 20px 8px",
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
        borderRadius: 4,
        background: style.bg,
      }}
    >
      <span style={{ color: C.muted, width: 14, flex: "0 0 14px", fontSize: 11, textAlign: "center", marginTop: 1 }}>
        {SOURCE_GLYPH[annotation.source]}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
          <AnnotationChip annotation={annotation} showLabel />
          <span style={{ fontSize: 11, color: C.muted }}>{author} · {timeAgo(annotation.created_at)}</span>
        </div>
        {annotation.note && (
          <div
            style={{
              fontSize: 13,
              color: C.fg,
              lineHeight: 1.55,
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
        className="rounded-sm transition-colors duration-250 ease-standard hover:bg-white/70 hover:!text-rp-ink"
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
        padding: compact ? "10px" : frameless ? "12px 14px 14px" : "12px",
        background: frameless ? "transparent" : "var(--rp-surface)",
        border: frameless ? "none" : `1px solid ${C.border}`,
        borderRadius: 5,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {title && (
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
          <div className="rp-subsection-title">{title}</div>
          <span className="rp-eyebrow">Run note</span>
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
              className="transition-[background-color,border-color,color] duration-250 ease-standard hover:!text-rp-ink"
              style={{
                padding: "3px 10px",
                borderRadius: 2,
                fontSize: 12,
                fontWeight: 500,
                lineHeight: "18px",
                cursor: "pointer",
                color: selected ? s.fg : C.muted,
                background: selected ? s.bg : "var(--rp-surface)",
                border: `1px solid ${selected ? s.border : C.border}`,
              }}
            >
              <span style={{ fontWeight: 700, marginRight: 3 }}>{s.icon}</span>
              {s.label}
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: C.muted, whiteSpace: "nowrap" }}>
          <kbd className="rounded-sm border border-rp-line px-1 font-mono text-[10px]">⌘↵</kbd> save ·{" "}
          <kbd className="rounded-sm border border-rp-line px-1 font-mono text-[10px]">esc</kbd> cancel
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
        className={cn(fieldClassName, "resize-y py-2 text-[13px] leading-5")}
        style={{ minHeight: 64 }}
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
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          aria-busy={saving || undefined}
          className={buttonVariants({ variant: "primary", size: "sm" })}
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
      className="rp-pop fixed z-[9999] rounded-md border border-rp-line bg-rp-surface shadow-e3"
      role="dialog"
      aria-label="Annotate run"
      style={{
        width: "min(380px, calc(100vw - 32px))",
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
