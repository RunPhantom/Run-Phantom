import { useEffect, useRef, useState } from "react";
import { setMeridian, clearMeridian } from "../utils/meridian";
import { Chevron, Check, Spinner, AlertCircle } from "./Icons";
import { C, spanColor } from "../utils/colors";
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

export function ToolCallPill({ span, colorMap }: { span: Span; colorMap: Map<string, string> }) {
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState(false);
  const prefersReducedMotion = usePrefersReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const err = span.status === "ERROR";
  const name = getNormalizedTool(span)?.name ?? span.name;
  const pending = span.status === "UNSET" && !span.end_time_ms;
  const icon = pending ? <Spinner style={{ marginRight: 3 }} /> : err ? <AlertCircle /> : <Check />;
  const color = spanColor(name, colorMap);
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
        transition: prefersReducedMotion ? "none" : "background 300ms, box-shadow 300ms",
        borderRadius: "var(--rp-r-lg)",
        background: flash ? `color-mix(in srgb, ${color} 14%, transparent)` : undefined,
        boxShadow: flash ? `0 0 0 2px color-mix(in srgb, ${color} 42%, transparent)` : undefined,
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} tool call ${name}`}
        className={`rp-hover-wash inline-flex items-center gap-1.5 ${pending ? '' : 'px-2.5'} py-1 rounded text-xs font-medium transition-colors w-fit max-w-full`}
        style={{
          ...(pending ? { paddingLeft: 7, paddingRight: 12 } : {}),
          background: err
            ? "color-mix(in srgb, var(--rp-danger) 10%, white 90%)"
            : pending
              ? `color-mix(in srgb, ${color} 10%, white 90%)`
              : C.surface,
          color: err ? C.red : pending ? color : C.fg2,
          border: `1px solid ${err
            ? "color-mix(in srgb, var(--rp-danger) 20%, white 80%)"
            : pending
              ? `color-mix(in srgb, ${color} 22%, white 78%)`
              : C.border}`,
        }}
        onClick={() => setOpen(!open)}
      >
        {icon}
        <span style={{ color: err ? undefined : pending ? C.fg3 : C.fg4 }}>{name}</span>
        {preview && (
          <span className="truncate max-w-[200px]" style={{ color: C.fg0, fontSize: "10px" }}>({preview})</span>
        )}
        {span.duration_ms > 0 && <span style={{ color: C.fg0, fontSize: "10px", marginLeft: 2 }}>{fmt(span.duration_ms)}</span>}
        {resultTokens && <span style={{ color: C.fg0, fontSize: "10px" }}>{resultTokens}</span>}
        <Chevron open={open} size={10} />
      </button>

      {open && (
        <div
          className="rp-clipped-ring mt-1.5 rounded-lg overflow-hidden"
          style={{ background: C.elevated, border: `1px solid ${C.borderLight}` }}
        >
          <div className="flex items-center gap-2 px-3 py-1.5" style={{ borderBottom: `1px solid ${C.border}` }}>
            {err && <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded" style={{ color: C.red, background: "color-mix(in srgb, var(--rp-danger) 10%, white 90%)" }}>ERROR</span>}
            <span className="text-[11px] font-mono font-medium" style={{ color: err ? C.red : C.fg4 }}>{name}</span>
            {span.duration_ms > 0 && <span className="text-[10px] font-mono" style={{ color: C.fg0 }}>{fmt(span.duration_ms)}</span>}
            {resultTokens && <span className="text-[10px] font-mono" style={{ color: C.fg0 }}>{resultTokens}</span>}
          </div>
          {err && span.output_payload && (
            <div className="px-3 py-2" style={{ background: "color-mix(in srgb, var(--rp-danger) 8%, white 92%)", borderBottom: `1px solid color-mix(in srgb, var(--rp-danger) 18%, white 82%)` }}>
              <pre className="text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-words" style={{ color: C.red }}>{trunc(tryJson(span.output_payload), 300)}</pre>
            </div>
          )}
          <div className="flex flex-col md:flex-row" style={{ maxHeight: 400 }}>
            {span.input_payload && (
              <div className="flex-1 min-w-0 p-2.5 overflow-auto sb" style={{ borderRight: span.output_payload ? `1px solid ${C.border}` : "none" }}>
                <div className="text-[9px] uppercase tracking-wide mb-1 font-sans font-medium" style={{ color: C.fg0 }}>Input</div>
                <pre className="text-[11px] font-mono leading-relaxed select-all whitespace-pre-wrap break-words" style={{ color: C.fg2 }}>{displayPayload(span.input_payload)}</pre>
              </div>
            )}
            {span.output_payload && (
              <div className="flex-1 min-w-0 p-2.5 overflow-auto sb">
                <div className="text-[9px] uppercase tracking-wide mb-1 font-sans font-medium" style={{ color: C.fg0 }}>Output</div>
                <pre className="text-[11px] font-mono leading-relaxed select-all whitespace-pre-wrap break-words" style={{ color: err ? C.red : C.fg2 }}>{displayPayload(span.output_payload)}</pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
