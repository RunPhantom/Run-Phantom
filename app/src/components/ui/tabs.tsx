import * as React from "react";
import { cn } from "@/lib/utils";

function moveFocus(container: HTMLElement, selector: string, key: string): HTMLElement | null {
  const items = Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(item => !item.hasAttribute("disabled"));
  if (items.length === 0) return null;
  const current = items.indexOf(document.activeElement as HTMLElement);
  const next = key === "Home" ? 0
    : key === "End" ? items.length - 1
    : key === "ArrowRight" || key === "ArrowDown" ? (current + 1) % items.length
    : (current - 1 + items.length) % items.length;
  items[next]?.focus();
  return items[next] ?? null;
}

const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

function TabList({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn("flex min-w-0 items-end gap-1 overflow-x-auto border-b border-rp-line", className)}
      onKeyDown={event => {
        if (!NAV_KEYS.has(event.key)) return;
        event.preventDefault();
        moveFocus(event.currentTarget, '[role="tab"]', event.key)?.click();
      }}
    >
      {children}
    </div>
  );
}

const Tab = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { selected: boolean }>(
  ({ selected, className, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="tab"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      className={cn(
        "rp-tab -mb-px inline-flex h-10 shrink-0 items-center gap-2 border-b-2 px-3 text-[13px] font-medium transition-[color,border-color] duration-250 ease-standard",
        selected ? "border-rp-blue text-rp-ink" : "border-transparent text-rp-ink-muted hover:text-rp-ink",
        className
      )}
      {...props}
    />
  )
);
Tab.displayName = "Tab";

function SegmentedControl<T extends string>({ label, options, value, onChange, size = "default", className }: {
  label: string;
  options: readonly { value: T; label: React.ReactNode; disabled?: boolean }[];
  value: T;
  onChange: (value: T) => void;
  size?: "default" | "sm";
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("inline-flex flex-wrap gap-1", className)}
      onKeyDown={event => {
        if (!NAV_KEYS.has(event.key)) return;
        event.preventDefault();
        moveFocus(event.currentTarget, '[role="radio"]', event.key)?.click();
      }}
    >
      {options.map(option => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 rounded-sm border font-medium transition-[background-color,border-color,color] duration-250 ease-standard disabled:cursor-not-allowed disabled:opacity-50",
              size === "sm" ? "h-8 px-2.5 text-xs" : "h-9 px-3 text-[13px]",
              checked ? "border-rp-wash-border bg-rp-wash text-rp-blue" : "border-rp-line bg-white text-rp-ink-soft hover:border-[color:var(--rp-n10)] hover:text-rp-ink"
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export { TabList, Tab, SegmentedControl };
