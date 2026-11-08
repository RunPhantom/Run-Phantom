import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm border px-1.5 py-0.5 text-[11px] font-medium leading-4",
  {
    variants: {
      tone: {
        neutral: "border-rp-line bg-[color:var(--rp-n4)] text-rp-ink-muted",
        accent: "border-transparent bg-rp-wash text-rp-blue",
        success: "border-transparent bg-rp-success-soft text-rp-success",
        danger: "border-transparent bg-rp-danger-soft text-rp-danger",
        warning: "border-transparent bg-rp-warning-soft text-rp-warning",
        outline: "border-rp-line bg-white text-rp-ink",
      },
      mono: {
        true: "font-mono text-[10.5px] uppercase tracking-[0.08em]",
        false: "",
      },
    },
    defaultVariants: { tone: "neutral", mono: false },
  }
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, tone, mono, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone, mono }), className)} {...props} />;
}

export type Status = "success" | "danger" | "warning" | "neutral" | "accent";

function StatusPill({ status, live = false, className, children, ...props }: Omit<BadgeProps, "tone"> & { status: Status; live?: boolean }) {
  return (
    <Badge tone={status} className={className} {...props}>
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full bg-current", live && "pulse-dot")} />
      {children}
    </Badge>
  );
}

export { Badge, StatusPill, badgeVariants };
