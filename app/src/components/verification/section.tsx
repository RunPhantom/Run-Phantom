import type { ReactNode } from "react";
import { Eyebrow } from "../ui/typography";

export const panel = "min-w-0 scroll-mt-20 rounded-lg border border-rp-line bg-white p-5 sm:p-6";
export const inset = "min-w-0 rounded-md border border-rp-line bg-white p-4";
export const lede = "max-w-[70ch] text-[13px] leading-[1.7] text-rp-ink-muted";
export const fine = "max-w-[70ch] text-[12px] leading-[1.7] text-rp-ink-muted";
export const warningText = "text-[12px] leading-[1.7] text-rp-warning";
export const dangerText = "break-words text-[13px] leading-5 text-rp-danger";
export const warningNote = "rounded-md border border-rp-warning-border bg-rp-warning-soft px-3 py-2 text-[12px] leading-5 text-rp-warning";
export const dangerNote = "rp-fade-rise break-words rounded-md border border-rp-danger-border bg-rp-danger-soft px-3 py-2.5 text-[13px] leading-5 text-rp-danger";
export const emptyNote = "rounded-md border border-dashed border-[color:var(--rp-line-dashed)] bg-white px-4 py-5 text-[13px] leading-[1.7] text-rp-ink-muted";
export const checkLabel = "flex min-h-9 items-start gap-2.5 text-[13px] text-rp-ink";
export const checkbox = "mt-0.5 size-4 shrink-0 accent-rp-blue";
export const textLink = "inline-flex items-center gap-1 text-rp-blue underline-offset-2 transition-colors duration-250 ease-standard hover:text-rp-blue-hover hover:underline";
export const summary = "rp-disclosure cursor-pointer select-none py-1 text-[12px] font-medium text-rp-ink-muted transition-colors duration-250 ease-standard hover:text-rp-ink";
export const well = "overflow-auto rounded-sm border border-rp-line-muted bg-rp-canvas-blue p-3";

export function SectionHead({ eyebrow, title, id, aside, as: Title = "h2" }: {
  eyebrow: string; title: ReactNode; id?: string; aside?: ReactNode; as?: "h2" | "h3" | "h4";
}) {
  return <div className="flex flex-wrap items-start justify-between gap-3">
    <div className="min-w-0"><Eyebrow marker>{eyebrow}</Eyebrow><Title id={id} className="rp-subsection-title mt-2">{title}</Title></div>
    {aside}
  </div>;
}
