import { useEffect, useRef, useState } from "react";
import { Check, Copy, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 22px icon button that swaps to a check for 1.2s and announces the result
 * politely. `label` is the accessible name ("Copy span id"), so two buttons in
 * one panel never sound the same.
 */
export function CopyButton({ value, label, className, children, title, icon: Icon = Copy }: {
  value: string | (() => string);
  label: string;
  className?: string;
  children?: React.ReactNode;
  title?: string;
  icon?: LucideIcon;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      data-copy-button
      className={cn(
        "inline-flex h-[22px] min-w-[22px] shrink-0 items-center justify-center gap-1 rounded-control px-1 text-rp-ink-subtle transition-colors duration-fast ease-out hover:bg-rp-row-hover hover:text-rp-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-rp-blue",
        state === "copied" && "text-rp-success hover:text-rp-success",
        state === "failed" && "text-rp-danger hover:text-rp-danger",
        className,
      )}
      onClick={async (event) => {
        event.stopPropagation();
        const ok = await copyText(typeof value === "function" ? value() : value);
        setState(ok ? "copied" : "failed");
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setState("idle"), 1200);
      }}
    >
      {state === "copied" ? <Check aria-hidden="true" className="size-3.5" /> : <Icon aria-hidden="true" className="size-3.5" />}
      {children}
      <span className="sr-only" aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : ""}</span>
    </button>
  );
}
