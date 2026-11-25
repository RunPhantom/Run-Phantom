import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";

/** A thin horizontal bar for a table cell; the track is the lighter step so the share reads at a glance. */
export function CellBar({ value, max, tone = "accent", className }: { value: number; max: number; tone?: "accent" | "danger"; className?: string }) {
  const share = max > 0 && Number.isFinite(value) ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <span aria-hidden="true" className={cn("block h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--rp-chart-track)]", className)} data-cell-bar>
      <span
        className="block h-full rounded-full"
        style={{ width: `${share > 0 ? Math.max(2, share * 100) : 0}%`, background: tone === "danger" ? "var(--rp-chart-fail)" : "var(--rp-chart-1)" }}
      />
    </span>
  );
}

export interface BarListColumn<T> {
  id: string;
  header: string;
  /** Tooltip for the header, e.g. what an estimate excludes. */
  headerTitle?: string;
  cell: (row: T) => ReactNode;
  className?: string;
}

/**
 * A ranked table whose first numeric measure is drawn as an in-cell bar. Every row
 * links somewhere: the name is a real link for keyboard and screen readers, and
 * the rest of the row forwards clicks to it.
 */
export function BarList<T>({ caption, rows, rowKey, nameHeader, name, nameTitle, href, bar, columns, emptyLabel, className, barPlacement = "column" }: {
  caption: string;
  rows: readonly T[];
  rowKey: (row: T) => string;
  nameHeader: string;
  name: (row: T) => ReactNode;
  nameTitle?: (row: T) => string | undefined;
  href: (row: T) => string;
  bar: { header: string; value: (row: T) => number; max?: number; tone?: (row: T) => "accent" | "danger" };
  columns: readonly BarListColumn<T>[];
  emptyLabel: string;
  className?: string;
  /** "under" draws the bar beneath the name, leaving the full row width for long names. */
  barPlacement?: "column" | "under";
}) {
  const navigate = useNavigate();
  const max = bar.max ?? Math.max(0, ...rows.map(bar.value));
  if (!rows.length) return <p className="py-6 text-center text-13 text-rp-ink-subtle">{emptyLabel}</p>;
  return (
    <table className={cn("w-full border-collapse text-13", className)} data-bar-list>
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="text-left">
          <th scope="col" className="w-full pb-1.5 font-mono text-11 font-medium uppercase tracking-[0.08em] text-rp-ink-subtle">{nameHeader}</th>
          {barPlacement === "column" && <th scope="col" className="pb-1.5"><span className="sr-only">{bar.header} bar</span></th>}
          {columns.map(column => (
            <th key={column.id} scope="col" title={column.headerTitle} className={cn("whitespace-nowrap pb-1.5 pl-3 text-right font-mono text-11 font-medium uppercase tracking-[0.08em] text-rp-ink-subtle", column.className)}>{column.header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(row => {
          const target = href(row);
          return (
            <tr
              key={rowKey(row)}
              className="group cursor-pointer border-t border-rp-line-muted transition-colors duration-fast hover:bg-rp-row-hover"
              onClick={event => {
                if ((event.target as HTMLElement).closest("a")) return;
                navigate(target);
              }}
            >
              <th scope="row" className={cn("max-w-0 pr-3 text-left font-normal", barPlacement === "under" ? "py-1.5" : "h-8")}>
                <Link to={target} title={nameTitle?.(row)} className="block truncate rounded-control text-rp-ink underline-offset-4 group-hover:text-rp-blue group-hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--rp-focus)]">
                  {name(row)}
                </Link>
                {barPlacement === "under" && <CellBar className="mt-1 h-1" value={bar.value(row)} max={max} tone={bar.tone?.(row)} />}
              </th>
              {barPlacement === "column" && <td className="w-12 min-w-12"><CellBar value={bar.value(row)} max={max} tone={bar.tone?.(row)} /></td>}
              {columns.map(column => (
                <td key={column.id} className={cn("whitespace-nowrap pl-3 text-right font-mono text-12 tabular-nums text-rp-ink", column.className)}>{column.cell(row)}</td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
