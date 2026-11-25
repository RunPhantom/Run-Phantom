import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { ChartTooltip, TooltipRow, useChartA11y } from "./ChartFrame";
import { chartKeyStep, columnPath, compact, linear, niceTicks, slotAt, type HistogramBin } from "./scale";
import { useElementSize } from "./use-element-size";

const AXIS_W = 40;
const AXIS_H = 20;
const TOP = 6;
const GAP = 2;
const RADIUS = 2;

/**
 * Distribution of a measure as touching columns separated by a 2px surface gap.
 * The x axis labels only the range ends; hover or arrow keys read each bin.
 */
export function Histogram({ label, bins, formatValue, unitLabel, width: fixedWidth, height = 160, color = "var(--rp-chart-1)", emptyLabel = "No values in this window" }: {
  /** One-sentence summary; the chart's accessible name. */
  label: string;
  bins: readonly HistogramBin[];
  formatValue: (value: number) => string;
  /** What a bin counts, e.g. "runs". */
  unitLabel: string;
  /** Fixed width in pixels; omit to fill the parent. */
  width?: number;
  height?: number;
  color?: string;
  emptyLabel?: string;
}) {
  const [ref, { width }] = useElementSize<HTMLDivElement>(fixedWidth);
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(0, ...bins.map(bin => bin.count));
  const ticks = niceTicks(max || 1, 3, true);
  const top = ticks[ticks.length - 1];
  const plotW = Math.max(0, width - AXIS_W);
  const plotH = Math.max(0, height - AXIS_H - TOP);
  const y = linear([0, top], [TOP + plotH, TOP]);
  const slot = bins.length ? plotW / bins.length : 0;
  const empty = max === 0;

  const pointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const offset = event.clientX - box.left;
    setActive(offset < AXIS_W ? null : slotAt(offset - AXIS_W, plotW, bins.length));
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = chartKeyStep(event.key, active, bins.length, "first");
    if (next === undefined) return;
    if (event.key !== "Escape") event.preventDefault();
    setActive(next);
  };
  const bin = active !== null ? bins[active] : null;
  const a11y = useChartA11y({
    label,
    readout: bin && !empty ? `${formatValue(bin.from)} to ${formatValue(bin.to)}: ${compact(bin.count)} ${unitLabel}.` : "",
    hint: empty ? "" : "Use the left and right arrow keys to read each bin.",
  });

  return (
    <div
      ref={ref}
      className="relative select-none outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-[color:var(--rp-focus)]"
      style={{ height }}
      tabIndex={bins.length ? 0 : -1}
      {...a11y.rootProps}
      aria-keyshortcuts="ArrowLeft ArrowRight Home End"
      onPointerMove={pointer}
      onPointerLeave={() => setActive(null)}
      onBlur={() => setActive(null)}
      onKeyDown={key}
      data-histogram
    >
      {width > 0 && (
        <svg width={width} height={height} aria-hidden="true" focusable="false" className="block">
          {ticks.map(tick => (
            <g key={tick}>
              <line x1={AXIS_W} x2={width} y1={y(tick)} y2={y(tick)} stroke="var(--rp-chart-grid)" strokeWidth={1} shapeRendering="crispEdges" />
              <text x={AXIS_W - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-[color:var(--rp-chart-axis)] font-mono text-11 tabular-nums">{compact(tick)}</text>
            </g>
          ))}
          {bins.map((item, index) => {
            const h = TOP + plotH - y(item.count);
            return (
              <path
                key={index}
                d={columnPath(AXIS_W + slot * index + GAP / 2, y(item.count), Math.max(1, slot - GAP), h, RADIUS)}
                fill={color}
                opacity={active === null || active === index ? 1 : 0.55}
              />
            );
          })}
          <line x1={AXIS_W} x2={width} y1={TOP + plotH} y2={TOP + plotH} stroke="var(--rp-chart-baseline)" strokeWidth={1} shapeRendering="crispEdges" />
          {bins.length > 0 && (
            <>
              <text x={AXIS_W} y={height - 4} textAnchor="start" className="fill-[color:var(--rp-chart-axis)] font-mono text-11">{formatValue(bins[0].from)}</text>
              <text x={width} y={height - 4} textAnchor="end" className="fill-[color:var(--rp-chart-axis)] font-mono text-11">{formatValue(bins[bins.length - 1].to)}</text>
            </>
          )}
          {empty && <text x={AXIS_W + plotW / 2} y={TOP + plotH / 2} textAnchor="middle" dy="0.32em" className="fill-[color:var(--rp-ink-subtle)] text-13">{emptyLabel}</text>}
        </svg>
      )}
      {bin && !empty && (
        <ChartTooltip x={AXIS_W + slot * ((active ?? 0) + 0.5)} width={width}>
          <p className="mb-1 font-mono text-11 text-rp-ink-subtle">{formatValue(bin.from)} – {formatValue(bin.to)}</p>
          <TooltipRow color={color} shape="square" label={unitLabel} value={compact(bin.count)} />
        </ChartTooltip>
      )}
      {a11y.announcer}
    </div>
  );
}
