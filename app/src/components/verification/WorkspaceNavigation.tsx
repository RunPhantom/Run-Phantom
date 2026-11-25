import { useEffect, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";

export const VERIFICATION_SECTIONS = [
  { id: "pair", label: "Pair app", needsSession: false },
  { id: "inspect", label: "Inspect", needsSession: true },
  { id: "checks", label: "Check outcomes", needsSession: true },
  { id: "flows", label: "Saved flows", needsSession: false },
  { id: "performance", label: "Performance", needsSession: true },
  { id: "browser", label: "Trusted browser", needsSession: false },
  { id: "snapshots", label: "Snapshots", needsSession: false },
  { id: "reports", label: "Reports", needsSession: false },
] as const;

type SectionId = typeof VERIFICATION_SECTIONS[number]["id"];

/**
 * Steps that need a paired app are hidden until one exists, because each of them would only land on the
 * "Connect your first app" panel. A deep link to a hidden step still resolves and focuses that panel.
 * Once a session exists its panels render even while disconnected, so the steps show and the hint says
 * what they still need.
 */
export function WorkspaceNavigation({ sessionId, connected, reports, ready }: { sessionId?: string; connected: boolean; reports?: number; ready: boolean }) {
  const [params] = useSearchParams();
  const requested = params.get("section");
  const selected: SectionId = VERIFICATION_SECTIONS.find(section => section.id === requested)?.id ?? "pair";
  const scroller = useRef<HTMLDivElement>(null);
  const visible = VERIFICATION_SECTIONS.filter(section => !section.needsSession || sessionId);
  const locked = VERIFICATION_SECTIONS.length - visible.length;
  const hint = !ready ? null
    : locked > 0 ? `${locked} more after you pair an app`
    : sessionId && !connected ? "Inspect, Check outcomes and Performance need the app connected"
    : null;

  useEffect(() => {
    if (!ready || !VERIFICATION_SECTIONS.some(section => section.id === requested)) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(`verification-${selected}`)
        ?? document.getElementById("verification-connect-first");
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [requested, selected, sessionId, ready]);

  useEffect(() => {
    const strip = scroller.current;
    const current = strip?.querySelector<HTMLElement>("[aria-current='location']");
    if (!strip || !current) return;
    const left = current.offsetLeft - strip.offsetLeft;
    if (left < strip.scrollLeft || left + current.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = Math.max(0, left - 20);
  }, [selected, sessionId]);

  return <nav aria-label="Verification workspace" className="sticky top-0 z-10 mx-[calc(var(--rp-page-px)*-1)] min-w-0 border-y border-rp-line bg-rp-surface sm:mx-0 sm:rounded-lg sm:border">
    <div ref={scroller} className="flex min-w-0 snap-x flex-nowrap items-center gap-1 overflow-x-auto px-[var(--rp-page-px)] py-2 [scrollbar-width:none] max-sm:[mask-image:linear-gradient(to_right,transparent,#000_16px,#000_calc(100%_-_16px),transparent)] sm:px-2 [&::-webkit-scrollbar]:hidden">
      {visible.map(({ id, label }) => {
        const next = new URLSearchParams(params); next.set("section", id);
        const current = selected === id;
        return <Link key={id} to={{ search: `?${next}` }} preventScrollReset aria-current={current ? "location" : undefined}
          className={cn("inline-flex min-h-11 shrink-0 snap-start items-center gap-2 rounded-sm px-3 text-[13px] transition-[background-color,color] duration-250 ease-standard motion-reduce:transition-none",
            current ? "bg-rp-wash font-semibold text-rp-blue" : "font-medium text-rp-ink-muted hover:bg-rp-row-hover hover:text-rp-ink")}>
          {label}
          {id === "reports" && reports !== undefined && <span className={cn("rp-num rounded-sm border px-1.5 text-[11px] font-medium leading-4", current ? "border-rp-wash-border bg-rp-surface" : "border-rp-line text-rp-ink-muted")}>{reports}</span>}
        </Link>;
      })}
      {hint && <span className="ml-auto hidden min-h-11 shrink-0 items-center gap-1.5 pl-3 pr-2 text-12 text-rp-ink-muted sm:inline-flex" title="Inspect, Check outcomes and Performance need a connected app">
        <Lock aria-hidden="true" className="size-3" />{hint}
      </span>}
    </div>
    {hint && <p className="flex items-center gap-1.5 border-t border-rp-line-muted px-[var(--rp-page-px)] py-2 text-12 text-rp-ink-muted sm:hidden">
      <Lock aria-hidden="true" className="size-3 shrink-0" />{hint}
    </p>}
  </nav>;
}
