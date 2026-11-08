import { useEffect, useRef, useState } from "react";
import { setMeridian, clearMeridian } from "../utils/meridian";
import { Chevron, Check, Spinner, AlertCircle } from "./Icons";
import { cn } from "@/lib/utils";
import { argsPreview, displayPayload, fmt, trunc, tryJson } from "../utils/helpers";
import { getNormalizedTool, type Span } from "../utils/types";
import { usePrefersReducedMotion } from "../hooks/use-prefers-reduced-motion";

function approxTokens(s: string | null | undefined): string | null {
  if (!s || s.length < 20) return null;
  const tokens = Math.round(s.length / 4);
  if (tokens < 10) return null;
  if (tokens < 1000) return `~${tokens} tok`;
  return `~${(tokens / 1000).toFixed(1)}k tok`;
}

export function ToolCallPill({ span }: { span: Span }) {
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState(false);
  const prefersReducedMotion = usePrefersReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const err = span.status === "ERROR";
  const name = getNormalizedTool(span)?.name ?? span.name;
  const pending = span.status === "UNSET" && !span.end_time_ms;
  const icon = pending ? <Spinner style={{ marginRight: 3 }} /> : err ? <AlertCircle /> : <Check />;
  const preview = argsPreview(span.input_payload);
  const resultTokens = approxTokens(span.output_payload);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.spanId === span.id) {
        setOpen(true);
        setFlash(true);
        setTimeout(() => {
          ref.current?.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "center" });
        }, 50);
        setTimeout(() => setFlash(false), 1500);
      }
    };
    document.addEventListener("runphantom:focus-tool", handler);
    return () => document.removeEventListener("runphantom:focus-tool", handler);
  }, [prefersReducedMotion, span.id]);

  return (
    <div
      ref={ref}
      data-tool-span-id={span.id}
      data-meridian-key={span.id}
      onMouseEnter={() => setMeridian(span.id)}
      onMouseLeave={() => clearMeridian()}
      onFocusCapture={() => setMeridian(span.id)}
      onBlurCapture={() => clearMeridian()}
      className={open ? "basis-full max-w-full" : "inline-block max-w-full"}
      style={{
        transition: prefersReducedMotion ? "none" : "background 250ms cubic-bezier(.25,.1,.25,1), box-shadow 250ms cubic-bezier(.25,.1,.25,1)",
        borderRadius: 5,
        background: flash ? "var(--rp-wash)" : undefined,
        boxShadow: flash ? "0 0 0 2px var(--rp-wash-border)" : undefined,
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} tool call ${name}`}
        className={cn(
          "inline-flex w-fit max-w-full items-center gap-1.5 rounded-sm border py-1 text-xs font-medium transition-[background-color,border-color] duration-250 ease-standard",
          pending ? "pl-2 pr-3" : "px-2.5",
          err
            ? "border-rp-danger-border bg-rp-danger-soft text-rp-danger hover:border-rp-danger"
            : pending
              ? "border-rp-wash-border bg-rp-wash text-rp-blue"
              : "border-rp-line bg-rp-surface text-rp-ink hover:border-rp-wash-border hover:bg-rp-wash",
          open && !err && "border-rp-wash-border bg-rp-wash",
        )}
        onClick={() => setOpen(!open)}
      >
        {icon}
        <span className={cn("font-mono", !err && "text-rp-ink")}>{name}</span>
        {preview && (
          <span className="max-w-[220px] truncate text-[11px] font-normal text-rp-ink-muted" title={preview}>({preview})</span>
        )}
        {span.duration_ms > 0 && <span className="rp-num ml-0.5 text-[11px] font-normal text-rp-ink-muted">{fmt(span.duration_ms)}</span>}
        {resultTokens && <span className="rp-num text-[11px] font-normal text-rp-ink-muted">{resultTokens}</span>}
        <Chevron open={open} size={10} />
      </button>

      {open && (
        <div
          className="rp-clipped-ring rp-fade-rise mt-1.5 overflow-hidden rounded-md border border-rp-line bg-rp-surface"
        >
          <div className="flex items-center gap-2 border-b border-rp-line px-3 py-2">
            {err && <span className="rounded-sm bg-rp-danger-soft px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-[0.08em] text-rp-danger">ERROR</span>}
            <span className={cn("font-mono text-[12px] font-medium", err ? "text-rp-danger" : "text-rp-ink")}>{name}</span>
            {span.duration_ms > 0 && <span className="rp-meta">{fmt(span.duration_ms)}</span>}
            {resultTokens && <span className="rp-meta">{resultTokens}</span>}
          </div>
          {err && span.output_payload && (
            <div className="border-b border-rp-danger-border bg-rp-danger-soft px-3 py-2">
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-rp-danger">{trunc(tryJson(span.output_payload), 300)}</pre>
            </div>
          )}
          <div className="flex flex-col md:flex-row" style={{ maxHeight: 400 }}>
            {span.input_payload && (
              <div className={cn("sb min-w-0 flex-1 overflow-auto p-3", span.output_payload && "border-b border-rp-line md:border-b-0 md:border-r")}>
                <div className="mb-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-rp-ink-muted">Input</div>
                <pre className="select-all whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-rp-ink-soft">{displayPayload(span.input_payload)}</pre>
              </div>
            )}
            {span.output_payload && (
              <div className="sb min-w-0 flex-1 overflow-auto p-3">
                <div className="mb-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-rp-ink-muted">Output</div>
                <pre className={cn("select-all whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed", err ? "text-rp-danger" : "text-rp-ink-soft")}>{displayPayload(span.output_payload)}</pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
