import { useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowDownRight, CheckCheck, FileCheck2, Fingerprint, Globe2, Layers2, Plug, Route } from "lucide-react";

const sections = [
  { id: "pair", label: "Pair app", Icon: Plug },
  { id: "inspect", label: "Inspect", Icon: Fingerprint },
  { id: "checks", label: "Check outcomes", Icon: CheckCheck },
  { id: "flows", label: "Saved flows", Icon: Route },
  { id: "browser", label: "Trusted browser", Icon: Globe2 },
  { id: "snapshots", label: "Snapshots", Icon: Layers2 },
  { id: "reports", label: "Reports", Icon: FileCheck2 },
] as const;

export function WorkspaceNavigation({ sessionId, reports }: { sessionId?: string; reports?: number }) {
  const [params] = useSearchParams();
  const requested = params.get("section");
  const selected = sections.find(section => section.id === requested)?.id ?? "pair";
  useEffect(() => {
    if (!sections.some(section => section.id === requested)) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(`verification-${selected}`)
        ?? document.getElementById("verification-connect-first");
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [requested, selected, sessionId]);
  return <nav aria-label="Verification workspace" className="flex min-w-0 flex-wrap gap-1 border-y border-[color:var(--rp-border)] py-2">
    {sections.map(({ id, label, Icon }) => {
      const next = new URLSearchParams(params); next.set("section", id);
      return <Link key={id} to={{ search: `?${next}` }} preventScrollReset aria-current={selected === id ? "location" : undefined}
        className={`inline-flex min-h-11 items-center gap-2 rounded-[5px] px-3 text-xs font-medium transition-colors motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--rp-accent)] ${selected === id ? "bg-[color:var(--rp-accent-soft)] text-[color:var(--rp-accent)]" : "text-[color:var(--rp-ink-soft)] hover:bg-[color:var(--rp-ink-wash)] hover:text-[color:var(--rp-ink-strong)]"}`}>
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />{label}
        {id === "reports" && reports !== undefined && <span className="rounded border border-current/20 px-1 text-[10px] tabular-nums">{reports}</span>}
        {selected === id && <ArrowDownRight aria-hidden="true" className="size-3" />}
      </Link>;
    })}
  </nav>;
}
