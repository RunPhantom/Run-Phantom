import { useRouteError, isRouteErrorResponse, useNavigate } from "react-router-dom";
import { useState } from "react";
import { AlertTriangle, ChevronDown, Copy, Check, RotateCcw, ArrowLeft } from "lucide-react";
import { C } from "../utils/colors";

// Without a route errorElement, a single render throw unmounts the entire app and
// leaves React Router's raw stack page. One malformed trace should never cost the
// user the whole session, so this catches the throw at the route boundary: the nav
// chrome survives, every other trace stays reachable, and the failure is reportable
// rather than just a blank pane.
function describe(error: unknown): { title: string; detail: string; raw: string } {
  if (isRouteErrorResponse(error)) {
    return {
      title: `${error.status} ${error.statusText}`,
      detail: typeof error.data === "string" ? error.data : "This view could not be loaded.",
      raw: `${error.status} ${error.statusText}\n${typeof error.data === "string" ? error.data : ""}`,
    };
  }
  if (error instanceof Error) {
    return {
      title: "This trace could not be rendered",
      detail: error.message || "An unexpected error occurred while rendering this view.",
      raw: `${error.name}: ${error.message}\n${error.stack ?? ""}`,
    };
  }
  return {
    title: "This trace could not be rendered",
    detail: "An unexpected error occurred while rendering this view.",
    raw: String(error),
  };
}

export function RouteError() {
  const error = useRouteError();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { title, detail, raw } = describe(error);

  return (
    <div role="alert" className="flex h-full items-center justify-center overflow-auto p-6">
      <div
        className="w-full max-w-lg rounded-xl border p-6"
        style={{ borderColor: C.border, background: C.surface, boxShadow: "var(--rp-e1)" }}
      >
        <div className="mb-3 flex items-center gap-2">
          <AlertTriangle className="size-4 shrink-0" style={{ color: C.red }} aria-hidden="true" />
          <h2 className="text-[15px] font-medium" style={{ color: C.fg4 }}>{title}</h2>
        </div>

        <p className="mb-5 text-[12px] leading-relaxed" style={{ color: C.fg1 }}>
          {detail}
        </p>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => navigate("/runs", { replace: true })}
            className="inline-flex min-h-[32px] items-center gap-1.5 rounded-md border px-3 text-[12px] font-medium transition-colors"
            style={{ borderColor: C.borderLight, color: C.fg4, background: C.elevated }}
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            Back to runs
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex min-h-[32px] items-center gap-1.5 rounded-md border px-3 text-[12px] font-medium transition-colors"
            style={{ borderColor: C.border, color: C.fg2, background: C.surface }}
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            Reload
          </button>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex min-h-[32px] items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors"
            style={{ color: C.fg1 }}
          >
            <ChevronDown
              className="size-3.5 transition-transform"
              style={{ transform: open ? "rotate(180deg)" : "none" }}
              aria-hidden="true"
            />
            {open ? "Hide details" : "Show details"}
          </button>
        </div>

        {open && (
          <div className="mt-4">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[9px] font-medium uppercase tracking-wide" style={{ color: C.fg0 }}>
                Error detail
              </span>
              <button
                type="button"
                aria-label={copied ? "Copied error detail" : "Copy error detail"}
                onClick={() => {
                  void navigator.clipboard.writeText(raw).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  }).catch(() => {});
                }}
                className="rounded p-1 transition-colors"
                style={{ color: copied ? C.green : C.fg0 }}
              >
                {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              </button>
            </div>
            <pre
              className="max-h-52 overflow-auto rounded-md border p-2.5 text-[10px] leading-relaxed"
              style={{ borderColor: C.border, background: C.bg, color: C.fg1, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
            >
              {raw.slice(0, 4000)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
