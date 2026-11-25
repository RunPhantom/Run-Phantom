import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { ChartTooltip, TooltipRow, useChartA11y } from "./ChartFrame";
import { areaPath, chartKeyStep, compact, endpointIndices, linePath, linear, nearestPoint, niceTicks } from "./scale";
import { useElementSize } from "./use-element-size";

export interface LineSeries {
  id: string;
  label: string;
  color: string;
  /** One value per x position; null breaks the line (unknown, not zero). */
  values: readonly (number | null)[];
}

const AXIS_W = 44;
const AXIS_H = 20;
const TOP = 8;
const SIDE = 6;

/**
 * Lines (optionally one 10% area under the first series) over evenly spaced
 * x positions, sharing one y axis. A crosshair snaps to the nearest position and
 * the readout lists every series there.
 */
export function TimeSeries({ label, series, titles, axisLabels, width: fixedWidth, height = 180, area = false, format = compact, emptyLabel = "No data in this window", partial }: {
  /** One-sentence summary; the chart's accessible name. */
  label: string;
  series: readonly LineSeries[];
  /** Tooltip heading per x position. */
  titles: readonly string[];
  axisLabels: (index: number) => string;
  /** Fixed width in pixels; omit to fill the parent. */
  width?: number;
  height?: number;
  area?: boolean;
  format?: (value: number) => string;
  emptyLabel?: string;
  /** Positions that cover only part of their span; their points are drawn hollow. */
  partial?: readonly boolean[];
}) {
  const [ref, { width }] = useElementSize<HTMLDivElement>(fixedWidth);
  const [active, setActive] = useState<number | null>(null);
  const count = titles.length;
  const known = series.flatMap(item => item.values.filter((value): value is number => value !== null && Number.isFinite(value)));
  const max = known.length ? Math.max(...known) : 0;
  const ticks = niceTicks(max || 1);
  const top = ticks[ticks.length - 1];
  const plotW = Math.max(0, width - AXIS_W - SIDE);
  const plotH = Math.max(0, height - AXIS_H - TOP);
  const x = linear([0, Math.max(1, count - 1)], [AXIS_W, AXIS_W + plotW]);
  const y = linear([0, top], [TOP + plotH, TOP]);
  const empty = known.length === 0;

  const pointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const offset = event.clientX - box.left;
    setActive(offset < AXIS_W - 4 ? null : nearestPoint(offset - AXIS_W, plotW, count));
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = chartKeyStep(event.key, active, count);
    if (next === undefined) return;
    if (event.key !== "Escape") event.preventDefault();
    setActive(next);
  };
  const a11y = useChartA11y({
    label,
    readout: active !== null && !empty ? seriesReadout(titles[active], series, active, format, partial?.[active] ?? false) : "",
    hint: empty ? "" : "Use the left and right arrow keys to read each point.",
  });

  return (
    <div
      ref={ref}
      className="relative select-none outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-[color:var(--rp-focus)]"
      style={{ height }}
      tabIndex={count ? 0 : -1}
      {...a11y.rootProps}
      aria-keyshortcuts="ArrowLeft ArrowRight Home End"
      onPointerMove={pointer}
      onPointerLeave={() => setActive(null)}
      onBlur={() => setActive(null)}
      onKeyDown={key}
      data-time-series
    >
      {width > 0 && (
        <svg width={width} height={height} aria-hidden="true" focusable="false" className="block">
          {ticks.map(tick => (
            <g key={tick}>
              <line x1={AXIS_W} x2={AXIS_W + plotW} y1={y(tick)} y2={y(tick)} stroke="var(--rp-chart-grid)" strokeWidth={1} shapeRendering="crispEdges" />
              <text x={AXIS_W - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-[color:var(--rp-chart-axis)] font-mono text-11 tabular-nums">{format(tick)}</text>
            </g>
          ))}
          {series.map((item, index) => {
            const points = item.values.map((value, position) => value === null || !Number.isFinite(value) ? null : { x: x(position), y: y(value) });
            return (
              <g key={item.id}>
                {area && index === 0 && <path d={areaPath(points, TOP + plotH)} fill={item.color} opacity={0.1} />}
                <path d={linePath(points)} fill="none" stroke={item.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {points.map((point, position) => point && (isolated(item.values, position) || partial?.[position]) ? (
                  <circle key={position} cx={point.x} cy={point.y} r={3} fill={partial?.[position] ? "var(--rp-surface)" : item.color} stroke={partial?.[position] ? item.color : "var(--rp-surface)"} strokeWidth={partial?.[position] ? 1.5 : 2} />
                ) : null)}
              </g>
            );
          })}
          {active !== null && !empty && (
            <g>
              <line x1={x(active)} x2={x(active)} y1={TOP} y2={TOP + plotH} stroke="var(--rp-chart-crosshair)" strokeWidth={1} shapeRendering="crispEdges" />
              {series.map(item => {
                const value = item.values[active];
                return value === null || value === undefined || !Number.isFinite(value) ? null
                  : <circle key={item.id} cx={x(active)} cy={y(value)} r={4} fill={item.color} stroke="var(--rp-surface)" strokeWidth={2} />;
              })}
            </g>
          )}
          <line x1={AXIS_W} x2={AXIS_W + plotW} y1={TOP + plotH} y2={TOP + plotH} stroke="var(--rp-chart-baseline)" strokeWidth={1} shapeRendering="crispEdges" />
          {endpointIndices(count).map((index, position, all) => (
            <text key={index} x={x(index)} y={height - 4} textAnchor={all.length > 1 && position === 0 ? "start" : all.length > 1 && position === all.length - 1 ? "end" : "middle"} className="fill-[color:var(--rp-chart-axis)] font-mono text-11">
              {axisLabels(index)}
            </text>
          ))}
          {empty && <text x={AXIS_W + plotW / 2} y={TOP + plotH / 2} textAnchor="middle" dy="0.32em" className="fill-[color:var(--rp-ink-subtle)] text-13">{emptyLabel}</text>}
        </svg>
      )}
      {active !== null && !empty && (
        <ChartTooltip x={x(active)} width={width}>
          <p className="mb-1 font-mono text-11 text-rp-ink-subtle">{titles[active]}</p>
          {series.map(item => {
            const value = item.values[active];
            return <TooltipRow key={item.id} color={item.color} label={item.label} value={value === null || value === undefined || !Number.isFinite(value) ? "unknown" : format(value)} />;
          })}
          {partial?.[active] && <p className="mt-1 text-11 text-rp-ink-subtle">Partial: only part of this span is in the window.</p>}
        </ChartTooltip>
      )}
      {a11y.announcer}
    </div>
  );
}

function isolated(values: readonly (number | null)[], index: number): boolean {
  const known = (position: number) => position >= 0 && position < values.length && values[position] !== null && Number.isFinite(values[position]);
  return !known(index - 1) && !known(index + 1);
}

/** The readout at one x position as a sentence; unknown values say so rather than reading as zero. */
export function seriesReadout(title: string | undefined, series: readonly LineSeries[], index: number, format: (value: number) => string, partial = false): string {
  const values = series.map(item => {
    const value = item.values[index];
    return `${item.label} ${value === null || value === undefined || !Number.isFinite(value) ? "unknown" : format(value)}`;
  }).join(", ");
  return `${title ?? ""}: ${values}.${partial ? " Partial: only part of this span is in the window." : ""}`;
}
