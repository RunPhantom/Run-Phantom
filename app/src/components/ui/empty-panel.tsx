import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Eyebrow } from "./typography";

export function EmptyPanel({ eyebrow, title, description, action, tone = "default", compact = false, titleAs: Title = "h2", className }: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  tone?: "default" | "danger";
  compact?: boolean;
  titleAs?: "h1" | "h2" | "h3";
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col items-start border border-dashed bg-white",
        compact ? "gap-3 px-5 py-6" : "gap-4 px-6 py-10 sm:px-10 sm:py-14",
        tone === "danger" ? "border-rp-danger-border" : "border-[color:var(--rp-line-dashed)]",
        className
      )}
    >
      {eyebrow && <Eyebrow marker tone={tone === "danger" ? "muted" : "accent"} className={tone === "danger" ? "text-rp-danger [&>.rp-eyebrow-marker]:bg-rp-danger" : undefined}>{eyebrow}</Eyebrow>}
      <Title className={compact ? "rp-subsection-title" : "rp-section-title"}>{title}</Title>
      {description && <div className="max-w-[60ch] text-[13px] leading-[1.8] text-rp-ink-muted">{description}</div>}
      {action && <div className="flex flex-wrap items-center gap-2 pt-1">{action}</div>}
    </section>
  );
}
