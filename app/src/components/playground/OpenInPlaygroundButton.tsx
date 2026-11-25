import { SquareTerminal } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

export function playgroundPathForSpan(spanId: string, runId?: string | null): string {
  const params = new URLSearchParams({ span: spanId });
  if (runId) params.set("run", runId);
  return `/playground?${params}`;
}

/**
 * Opens a captured model call in the Playground with its prompt, model and parameters filled in.
 * Self-contained so it can move into any span-actions slot; render it only for model call spans.
 */
export function OpenInPlaygroundButton({ spanId, runId, className }: { spanId: string; runId?: string | null; className?: string }) {
  return (
    <Link
      to={playgroundPathForSpan(spanId, runId)}
      data-open-in-playground={spanId}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-control border border-rp-line bg-rp-surface px-2.5 text-[12px] font-medium text-rp-ink transition-colors duration-fast ease-out hover:border-rp-wash-border hover:bg-rp-wash hover:text-rp-blue focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rp-blue focus-visible:ring-offset-1",
        className,
      )}
    >
      <SquareTerminal aria-hidden="true" className="size-3.5" />
      Open in Playground
    </Link>
  );
}
