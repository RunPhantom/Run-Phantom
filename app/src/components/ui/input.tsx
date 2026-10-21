import * as React from "react";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-md border border-[color:var(--rp-border-strong)] bg-[color:var(--rp-surface)] px-3 py-1 text-sm text-[color:var(--rp-ink)] transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-[color:var(--rp-ink-muted)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };
