import { useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { cn } from "@/lib/utils";

const sections = [
  { id: "pair", label: "Pair app" },
  { id: "inspect", label: "Inspect" },
  { id: "checks", label: "Check outcomes" },
  { id: "flows", label: "Saved flows" },
  { id: "performance", label: "Performance" },
  { id: "browser", label: "Trusted browser" },
  { id: "snapshots", label: "Snapshots" },
  { id: "reports", label: "Reports" },
] as const;

export function WorkspaceNavigation({ sessionId, reports, ready }: { sessionId?: string; reports?: number; ready: boolean }) {
  const [params] = useSearchParams();
  const requested = params.get("section");
  const selected = sections.find(section => section.id === requested)?.id ?? "pair";
  useEffect(() => {
    if (!ready || !sections.some(section => section.id === requested)) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(`verification-${selected}`)
        ?? document.getElementById("verification-connect-first");
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [requested, selected, sessionId, ready]);
  return <nav aria-label="Verification workspace" className="sticky top-0 z-10 -mx-5 flex min-w-0 flex-nowrap gap-1 overflow-x-auto border-y border-rp-line bg-white px-5 py-2 sm:mx-0 sm:rounded-lg sm:border sm:px-2">
    {sections.map(({ id, label }, index) => {
      const next = new URLSearchParams(params); next.set("section", id);
      const current = selected === id;
      return <Link key={id} to={{ search: `?${next}` }} preventScrollReset aria-current={current ? "location" : undefined}
        className={cn("inline-flex min-h-11 shrink-0 items-center gap-2.5 rounded-sm px-3 text-[13px] transition-[background-color,color] duration-250 ease-standard motion-reduce:transition-none",
          current ? "bg-rp-wash font-semibold text-rp-blue" : "font-medium text-rp-ink-muted hover:bg-rp-row-hover hover:text-rp-ink")}>
        <span aria-hidden="true" className={cn("rp-num text-[11px] font-medium", current ? "text-rp-blue" : "text-rp-index")}>{String(index + 1).padStart(2, "0")}</span>{label}
        {id === "reports" && reports !== undefined && <span className={cn("rp-num rounded-sm border px-1.5 text-[11px] font-medium leading-4", current ? "border-rp-wash-border bg-white" : "border-rp-line text-rp-ink-muted")}>{reports}</span>}
      </Link>;
    })}
  </nav>;
}
