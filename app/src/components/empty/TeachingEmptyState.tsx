import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Eyebrow } from "@/components/ui/typography";

/**
 * An empty page that shows what it will look like: a faded, inert sample of the populated
 * layout ("ghost") with a setup card on top. The ghost is hidden from assistive technology
 * and labelled as a sample, so it never reads as real data.
 *
 * Ghost and card share one grid cell, so the block is as tall as the taller of the two and
 * a long card on a phone pushes the page down instead of overflowing the ghost.
 */
export function TeachingEmptyState({
  ghost, ghostLabel = "Sample · not your data", eyebrow, title, titleId, titleAs: Title = "h2", lede, children, actions,
  size = "page", cardClassName, className, ...data
}: {
  ghost: ReactNode;
  ghostLabel?: string;
  eyebrow?: ReactNode;
  title: ReactNode;
  /** Names the card's region; required so the card is a landmark screen readers can jump to. */
  titleId: string;
  titleAs?: "h1" | "h2" | "h3";
  lede?: ReactNode;
  children?: ReactNode;
  /** One primary action, optionally followed by a secondary one. */
  actions?: ReactNode;
  size?: "page" | "inline";
  cardClassName?: string;
  className?: string;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
  const inline = size === "inline";
  return (
    <div className={cn("grid min-w-0 [&>*]:col-start-1 [&>*]:row-start-1", className)} data-teaching-empty {...data}>
      <div aria-hidden="true" inert className="pointer-events-none min-w-0 select-none overflow-hidden opacity-40 saturate-[0.4]" data-empty-ghost>
        <p className="rp-type-eyebrow mb-2 text-rp-ink-subtle">{ghostLabel}</p>
        {ghost}
      </div>
      <div className={cn("relative flex min-w-0 justify-center", inline ? "items-center px-2 py-4" : "items-start pb-6 pt-4 sm:px-6 sm:pt-10")}>
        <section
          aria-labelledby={titleId}
          className={cn(
            "w-full min-w-0 rounded-lg border border-rp-line bg-rp-surface shadow-e4 animate-fade-rise motion-reduce:animate-none",
            inline ? "max-w-[440px] p-5" : "max-w-[720px] p-5 sm:p-7",
            cardClassName,
          )}
          data-empty-card
        >
          {eyebrow && <Eyebrow marker tone="accent">{eyebrow}</Eyebrow>}
          <Title id={titleId} className={cn(inline ? "rp-type-card-title" : "rp-type-headline", eyebrow && "mt-3", "text-rp-ink")}>{title}</Title>
          {lede && <div className="rp-type-prose mt-2 text-rp-ink-muted">{lede}</div>}
          {children && <div className={cn(inline ? "mt-3" : "mt-5")}>{children}</div>}
          {actions && <div className="mt-4 flex flex-wrap items-center gap-2">{actions}</div>}
        </section>
      </div>
    </div>
  );
}
