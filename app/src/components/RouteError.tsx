import { useRouteError, isRouteErrorResponse, useNavigate } from "react-router-dom";
import { useState } from "react";
import { AlertTriangle, ChevronDown, Copy, Check, RotateCcw, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Eyebrow } from "@/components/ui/typography";

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
      title: "This view could not be rendered",
      detail: error.message || "An unexpected error occurred while rendering this view.",
      raw: `${error.name}: ${error.message}\n${error.stack ?? ""}`,
    };
  }
  return {
    title: "This view could not be rendered",
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
    <div role="alert" className="flex h-full items-center justify-center overflow-auto px-5 py-10 sm:px-10">
      <section className="w-full max-w-xl animate-fade-rise rounded-lg border border-rp-danger-border bg-white px-6 py-8 sm:px-8">
        <Eyebrow className="text-rp-danger">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          View / Render error
        </Eyebrow>
        <h2 className="rp-section-title mt-3">{title}</h2>

        <p className="mt-2 break-words text-[13px] leading-[1.8] text-rp-ink-muted">
          {detail}
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={() => navigate("/runs", { replace: true })}>
            <ArrowLeft aria-hidden="true" />
            Back to runs
          </Button>
          <Button variant="outline" onClick={() => window.location.reload()}>
            <RotateCcw aria-hidden="true" />
            Reload
          </Button>
          <Button variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <ChevronDown
              className={`transition-transform duration-250 ease-standard motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
              aria-hidden="true"
            />
            {open ? "Hide details" : "Show details"}
          </Button>
        </div>

        {open && (
          <div className="mt-5 animate-fade-rise border-t border-rp-line-muted pt-4">
            <div className="mb-2 flex items-center justify-between">
              <Eyebrow>Error detail</Eyebrow>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={copied ? "Copied error detail" : "Copy error detail"}
                title={copied ? "Copied" : "Copy error detail"}
                className={copied ? "text-rp-success hover:text-rp-success" : undefined}
                onClick={() => {
                  void navigator.clipboard.writeText(raw).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  }).catch(() => {});
                }}
              >
                {copied ? <Check aria-hidden="true" className="!size-3.5" /> : <Copy aria-hidden="true" className="!size-3.5" />}
              </Button>
            </div>
            <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-rp-line-muted bg-rp-canvas-blue p-3 font-mono text-[11px] leading-5 text-rp-ink-soft">
              {raw.slice(0, 4000)}
            </pre>
          </div>
        )}
      </section>
    </div>
  );
}
