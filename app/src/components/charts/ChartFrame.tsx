import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface LegendItem { label: string; color: string; shape?: "square" | "line"; muted?: boolean }

export interface ChartTable {
  caption: string;
  columns: readonly string[];
  rows: readonly (readonly ReactNode[])[];
}

export function ChartLegend({ items, className }: { items: readonly LegendItem[]; className?: string }) {
  if (items.length < 2) return null;
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-12 text-rp-ink-subtle", className)} aria-label="Legend">
      {items.map(item => (
        <li key={item.label} className="flex items-center gap-1.5 whitespace-nowrap">
          <span
            aria-hidden="true"
            className={item.shape === "line" ? "h-0.5 w-3 rounded-full" : "size-2 rounded-[2px]"}
            style={{ background: item.color, opacity: item.muted ? 0.45 : 1 }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * The accessible shell every chart sits in: a one-sentence summary as the image's
 * name, and a "View as table" toggle that swaps the plot for the same numbers as rows.
 * Set `interactive` for a focusable chart (StackedBars, TimeSeries, Histogram): the
 * children of role="img" are presentational to assistive technology, so the chart
 * then names itself with `label` and announces the bucket under the keyboard.
 */
export function ChartFrame({ summary, table, legend, title, titleId, className, children, actions, interactive = false }: {
  summary: string;
  interactive?: boolean;
  table: ChartTable;
  legend?: readonly LegendItem[];
  title?: ReactNode;
  titleId?: string;
  className?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  const regionId = useId();
  return (
    <div className={cn("flex min-w-0 flex-col", className)} data-chart>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {title ? <div id={titleId} className="min-w-0">{title}</div> : <span />}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {legend && !asTable && <ChartLegend items={legend} />}
          {actions}
          <button
            type="button"
            aria-pressed={asTable}
            aria-controls={regionId}
            onClick={() => setAsTable(value => !value)}
            className="whitespace-nowrap rounded-control px-1 text-12 text-rp-ink-subtle underline-offset-4 transition-colors duration-fast hover:text-rp-blue hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--rp-focus)]"
          >
            {asTable ? "View as chart" : "View as table"}
          </button>
        </div>
      </div>
      <div id={regionId} className="mt-3 min-h-0 flex-1">
        {asTable ? <ChartDataTable table={table} />
          : interactive ? <div className="h-full">{children}</div>
            : <div role="img" aria-label={summary} className="h-full">{children}</div>}
      </div>
    </div>
  );
}

export function ChartDataTable({ table }: { table: ChartTable }) {
  return (
    <div className="max-h-[320px] overflow-auto rounded-control border border-rp-line">
      <table className="w-full border-collapse text-12">
        <caption className="sr-only">{table.caption}</caption>
        <thead className="sticky top-0 bg-rp-surface">
          <tr>
            {table.columns.map((column, index) => (
              <th key={column} scope="col" className={cn("border-b border-rp-line px-2 py-1.5 font-mono text-11 font-medium uppercase tracking-[0.08em] text-rp-ink-subtle", index === 0 ? "text-left" : "text-right")}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-rp-line-muted last:border-0">
              {row.map((cell, cellIndex) => cellIndex === 0
                ? <th key={cellIndex} scope="row" className="px-2 py-1 text-left font-normal text-rp-ink">{cell}</th>
                : <td key={cellIndex} className="px-2 py-1 text-right font-mono tabular-nums text-rp-ink">{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Floating readout positioned inside a relatively positioned chart box; flips left near the right edge. */
export function ChartTooltip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const flip = x > width * 0.6;
  return (
    <div
      role="presentation"
      className="pointer-events-none absolute top-1 z-10 min-w-[148px] rounded-sm border border-rp-line bg-rp-surface px-2.5 py-2 text-12 leading-5 text-rp-ink shadow-e3"
      style={flip ? { right: Math.max(0, width - x + 12) } : { left: x + 12 }}
    >
      {children}
    </div>
  );
}

export function TooltipRow({ color, label, value, shape = "line" }: { color?: string; label: string; value: ReactNode; shape?: "line" | "square" }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="flex items-center gap-1.5 text-rp-ink-subtle">
        {color && <span aria-hidden="true" className={shape === "line" ? "h-0.5 w-3 rounded-full" : "size-2 rounded-[2px]"} style={{ background: color }} />}
        {label}
      </span>
      <span className="font-mono font-medium tabular-nums text-rp-ink">{value}</span>
    </div>
  );
}

/**
 * Accessible name, key help and a polite live readout for a focusable chart. The
 * readout is the text of the tooltip, so keyboard and screen-reader users hear the
 * bucket the arrow keys moved to.
 */
export function useChartA11y({ label, readout, hint }: { label: string; readout: string; hint: string }) {
  const hintId = useId();
  return {
    rootProps: { role: "group", "aria-roledescription": "chart", "aria-label": label, "aria-describedby": hintId } as const,
    announcer: (
      <>
        <span id={hintId} className="sr-only">{hint}</span>
        <span className="sr-only" aria-live="polite" aria-atomic="true" data-chart-readout>{readout}</span>
      </>
    ),
  };
}
