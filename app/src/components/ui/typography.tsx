import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";

type HeadingLevel = "h1" | "h2" | "h3" | "h4";

export function PageTitle({ as: Tag = "h1", className, children, id }: {
  as?: HeadingLevel; className?: string; children: ReactNode; id?: string;
}) {
  return <Tag id={id} className={cn("rp-page-title", className)}>{children}</Tag>;
}

export function SectionHeading({ as: Tag = "h2", size = "md", className, children, id }: {
  as?: HeadingLevel; size?: "md" | "sm"; className?: string; children: ReactNode; id?: string;
}) {
  return <Tag id={id} className={cn(size === "md" ? "rp-section-title" : "rp-subsection-title", className)}>{children}</Tag>;
}

export function Eyebrow({ as: Tag = "p", marker = false, tone = "muted", className, children }: {
  as?: ElementType; marker?: boolean; tone?: "muted" | "accent"; className?: string; children: ReactNode;
}) {
  return (
    <Tag className={cn("rp-eyebrow", className)} data-tone={tone}>
      {marker && <span aria-hidden="true" className="rp-eyebrow-marker" />}
      {children}
    </Tag>
  );
}

export function Meta({ as: Tag = "span", className, children, title }: {
  as?: ElementType; className?: string; children: ReactNode; title?: string;
}) {
  return <Tag title={title} className={cn("rp-meta", className)}>{children}</Tag>;
}

export function Num({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("rp-num", className)} data-numeric>{children}</span>;
}

export function PageHeader({ eyebrow, title, description, actions, titleId, className }: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  titleId?: string;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6", className)}>
      <div className="min-w-0">
        {eyebrow && <Eyebrow marker tone="accent">{eyebrow}</Eyebrow>}
        <PageTitle id={titleId} className={eyebrow ? "mt-3" : undefined}>{title}</PageTitle>
        {description && <p className="rp-lede mt-3">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
