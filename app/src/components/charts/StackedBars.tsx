import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { ChartTooltip, TooltipRow } from "./ChartFrame";
import { columnPath, compact, endpointIndices, linear, niceTicks, slotAt } from "./scale";
import { useElementSize } from "./use-element-size";

export interface StackSeries { id: string; label: string; color: string }

export interface StackBucket {
  key: string | number;
  /** Tooltip heading, e.g. "Today 13:00–14:00". */
  title: string;
  /** Values per series, bottom to top, in the order of `series`. */
  values: readonly number[];
  /** Only part of the bucket lies inside the window; drawn lighter so it does not read as a dip. */
  partial?: boolean;
  /** Extra tooltip lines below the series values. */
  notes?: readonly string[];
}

const AXIS_W = 40;
const AXIS_H = 20;
const TOP = 6;
const GAP = 2;
const MAX_COLUMN = 14;
const RADIUS = 2;

/**
 * Stacked columns, one per time bucket. The stack's first series sits on the
 * baseline; later series stack on top, separated by a 2px surface gap. Hover or
 * arrow keys show every series for that bucket; click or Enter calls `onActivate`.
 */
export function StackedBars({ buckets, series, axisLabels, height: fixedHeight, minHeight = 160, emptyLabel = "No runs in this window", onActivate, activateHint, onActiveChange }: {
  buckets: readonly StackBucket[];
  series: readonly StackSeries[];
  /** Labels for the endpoint ticks, indexed like `buckets`. */
  axisLabels: (index: number) => string;
  /** Fixed plot height; omit to fill the parent's height (at least `minHeight`). */
  height?: number;
  minHeight?: number;
  emptyLabel?: string;
  onActivate?: (index: number) => void;
  activateHint?: string;
  onActiveChange?: (index: number | null) => void;
}) {
  const [ref, { width, height: measured }] = useElementSize<HTMLDivElement>();
  const height = fixedHeight ?? Math.max(minHeight, measured);
  const [active, setActiveState] = useState<number | null>(null);
  const setActive = (index: number | null) => { setActiveState(index); onActiveChange?.(index); };
  const totals = buckets.map(bucket => bucket.values.reduce((sum, value) => sum + Math.max(0, value), 0));
  const max = Math.max(0, ...totals);
  const ticks = niceTicks(max || 1, 3, true);
  const top = ticks[ticks.length - 1];
  const plotW = Math.max(0, width - AXIS_W);
  const plotH = Math.max(0, height - AXIS_H - TOP);
  const y = linear([0, top], [TOP + plotH, TOP]);
  const slot = buckets.length ? plotW / buckets.length : 0;
  const columnW = Math.max(2, Math.min(MAX_COLUMN, slot * 0.5));
  const empty = max === 0;

  const pointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const index = slotAt(event.clientX - box.left - AXIS_W, plotW, buckets.length);
    setActive(event.clientX - box.left < AXIS_W ? null : index);
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!buckets.length) return;
    const current = active ?? buckets.length - 1;
    if (event.key === "ArrowRight") { event.preventDefault(); setActive(Math.min(buckets.length - 1, active === null ? current : current + 1)); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); setActive(Math.max(0, active === null ? current : current - 1)); }
    else if (event.key === "Home") { event.preventDefault(); setActive(0); }
    else if (event.key === "End") { event.preventDefault(); setActive(buckets.length - 1); }
    else if ((event.key === "Enter" || event.key === " ") && active !== null && onActivate) { event.preventDefault(); onActivate(active); }
    else if (event.key === "Escape") setActive(null);
  };

  const activeBucket = active !== null ? buckets[active] : null;
  const activeX = active !== null ? AXIS_W + slot * (active + 0.5) : 0;

  return (
    <div
      ref={ref}
      className="relative select-none outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-[color:var(--rp-focus)]"
      style={fixedHeight ? { height: fixedHeight } : { height: "100%", minHeight }}
      tabIndex={buckets.length ? 0 : -1}
      aria-keyshortcuts="ArrowLeft ArrowRight Home End Enter"
      onPointerMove={pointer}
      onPointerLeave={() => setActive(null)}
      onBlur={() => setActive(null)}
      onKeyDown={key}
      onClick={() => { if (active !== null && onActivate) onActivate(active); }}
      data-stacked-bars
    >
      {width > 0 && (
        <svg width={width} height={height} aria-hidden="true" focusable="false" className="block" style={{ cursor: onActivate && !empty ? "pointer" : undefined }}>
          {ticks.map(tick => (
            <g key={tick}>
              <line x1={AXIS_W} x2={width} y1={y(tick)} y2={y(tick)} stroke="var(--rp-chart-grid)" strokeWidth={1} shapeRendering="crispEdges" />
              <text x={AXIS_W - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-[color:var(--rp-chart-axis)] font-mono text-11 tabular-nums">{compact(tick)}</text>
            </g>
          ))}
          {active !== null && !empty && (
            <rect x={AXIS_W + slot * active} y={TOP} width={slot} height={plotH} fill="var(--rp-chart-hover)" />
          )}
          {buckets.map((bucket, index) => {
            const x = AXIS_W + slot * index + (slot - columnW) / 2;
            let base = 0;
            const visible = bucket.values.map((value, seriesIndex) => ({ value: Math.max(0, value), seriesIndex })).filter(item => item.value > 0);
            return (
              <g key={bucket.key} opacity={bucket.partial ? 0.55 : 1} data-bucket={index} data-partial={bucket.partial ? "true" : undefined}>
                {visible.map((item, order) => {
                  const y0 = y(base);
                  base += item.value;
                  const y1 = y(base);
                  const isTop = order === visible.length - 1;
                  const gapBelow = order > 0 ? GAP : 0;
                  const h = Math.max(1, y0 - y1 - gapBelow);
                  const d = isTop ? columnPath(x, y1, columnW, h, RADIUS) : `M${x},${y1}h${columnW}v${h}h${-columnW}Z`;
                  return <path key={series[item.seriesIndex]?.id ?? item.seriesIndex} d={d} fill={series[item.seriesIndex]?.color} />;
                })}
              </g>
            );
          })}
          <line x1={AXIS_W} x2={width} y1={TOP + plotH} y2={TOP + plotH} stroke="var(--rp-chart-baseline)" strokeWidth={1} shapeRendering="crispEdges" />
          {endpointIndices(buckets.length).map((index, position, all) => (
            <text
              key={index}
              x={AXIS_W + slot * (index + 0.5)}
              y={height - 4}
              textAnchor={position === 0 && all.length > 1 ? "start" : position === all.length - 1 && all.length > 1 ? "end" : "middle"}
              dx={position === 0 && all.length > 1 ? -slot / 2 : position === all.length - 1 && all.length > 1 ? slot / 2 : 0}
              className="fill-[color:var(--rp-chart-axis)] font-mono text-11"
            >
              {axisLabels(index)}
            </text>
          ))}
          {empty && (
            <text x={AXIS_W + plotW / 2} y={TOP + plotH / 2} textAnchor="middle" dy="0.32em" className="fill-[color:var(--rp-ink-subtle)] text-13">{emptyLabel}</text>
          )}
        </svg>
      )}
      {activeBucket && !empty && (
        <ChartTooltip x={activeX} width={width}>
          <p className="mb-1 font-mono text-11 text-rp-ink-subtle">{activeBucket.title}</p>
          {series.map((item, index) => (
            <TooltipRow key={item.id} color={item.color} shape="square" label={item.label} value={compact(activeBucket.values[index] ?? 0)} />
          ))}
          {activeBucket.partial && <p className="mt-1 text-11 text-rp-ink-subtle">Partial: only part of this span is in the window.</p>}
          {activeBucket.notes?.map(note => <p key={note} className="mt-1 text-11 text-rp-ink-subtle">{note}</p>)}
          {onActivate && activateHint && <p className="mt-1 border-t border-rp-line-muted pt-1 text-11 text-rp-ink-subtle">{activateHint}</p>}
        </ChartTooltip>
      )}
    </div>
  );
}
