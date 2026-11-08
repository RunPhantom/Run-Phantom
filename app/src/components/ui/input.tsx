import * as React from "react";
import { cn } from "@/lib/utils";

export const fieldClassName =
  "w-full min-w-0 rounded-sm border border-rp-line bg-white px-3 text-sm text-rp-ink transition-[border-color,background-color] duration-250 ease-standard placeholder:text-rp-ink-faint hover:border-[color:var(--rp-n10)] focus-visible:border-rp-blue focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-rp-canvas disabled:opacity-60 aria-[invalid=true]:border-rp-danger";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          fieldClassName,
          "flex h-9 py-1 read-only:bg-rp-canvas-blue file:border-0 file:bg-transparent file:text-sm file:font-medium",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(fieldClassName, "min-h-24 resize-y py-2 leading-6 read-only:bg-rp-canvas-blue", className)} {...props} />
  )
);
Textarea.displayName = "Textarea";

const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        fieldClassName,
        "rp-select h-9 cursor-pointer pr-9",
        className
      )}
      {...props}
    >
      {children}
    </select>
  )
);
Select.displayName = "Select";

function Field({ label, hint, htmlFor, children, className }: {
  label: React.ReactNode; hint?: React.ReactNode; htmlFor: string; children: React.ReactNode; className?: string;
}) {
  return (
    <div className={cn("grid gap-2", className)}>
      <label htmlFor={htmlFor} className="rp-field-label">{label}</label>
      {children}
      {hint && <p className="rp-field-hint">{hint}</p>}
    </div>
  );
}

export { Input, Textarea, Select, Field };
