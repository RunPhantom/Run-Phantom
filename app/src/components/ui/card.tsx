import * as React from "react";
import { cn } from "@/lib/utils";
import { Eyebrow } from "./typography";

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { tone?: "default" | "accent" | "danger" }>(
  ({ className, tone = "default", ...props }, ref) => (
    <div
      ref={ref}
      data-tone={tone}
      className={cn(
        "min-w-0 rounded-lg border bg-white",
        tone === "default" && "border-rp-line",
        tone === "accent" && "border-rp-wash-border bg-rp-wash",
        tone === "danger" && "border-rp-danger-border bg-rp-danger-soft",
        className
      )}
      {...props}
    />
  )
);
Card.displayName = "Card";

function CardHeader({ eyebrow, title, description, actions, titleAs: Title = "h2", className }: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  titleAs?: "h2" | "h3" | "h4";
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-4 px-5 pt-5 sm:px-6 sm:pt-6", className)}>
      <div className="min-w-0">
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <Title className={cn("rp-subsection-title", eyebrow && "mt-1.5")}>{title}</Title>
        {description && <p className="mt-1.5 text-[13px] leading-[1.7] text-rp-ink-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 py-5 sm:px-6", className)} {...props} />;
}

function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-wrap items-center gap-2 border-t border-rp-line px-5 py-4 sm:px-6", className)} {...props} />;
}

export { Card, CardHeader, CardBody, CardFooter };
