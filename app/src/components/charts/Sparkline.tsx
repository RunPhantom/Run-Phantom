import { useId } from "react";
import { linePath, linear } from "./scale";
import { useElementSize } from "./use-element-size";

/**
 * A tiny trend line with no axes: history in the neutral tone, the last segment
 * and end dot in the series colour (`tone="danger"` for failure-like measures).
 * Null values break the line rather than reading as zero. Points flagged in
 * `partial` cover only part of their span, so they are joined with a dashed line
 * and a hollow dot and never carry the emphasis: a half-finished bucket would
 * otherwise read as a dip. The trailing partial point carries the emphasis only
 * when it cannot mislead: when every complete point is zero or unknown, or, for a
 * `cumulative` series, when it already matches or exceeds the last complete point.
 * With fewer than two known points there is no trend to draw.
 */
export function Sparkline({ values, partial, cumulative = false, label, tone = "accent", width: fixedWidth, height = 28, className }: {
  values: readonly (number | null)[];
  partial?: readonly boolean[];
  /** Counts and sums, which only grow as a bucket fills, so a partial value is a lower bound. */
  cumulative?: boolean;
  label: string;
  tone?: "accent" | "danger";
  /** Fixed width in pixels; omit to fill the parent. */
  width?: number;
  height?: number;
  className?: string;
}) {
  const [ref, { width }] = useElementSize<HTMLDivElement>(fixedWidth);
  const clipId = useId();
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value));
  const max = known.length ? Math.max(...known) : 0;
  const min = known.length ? Math.min(0, ...known) : 0;
  const pad = 4;
  const x = linear([0, Math.max(1, values.length - 1)], [pad, Math.max(pad, width - pad)]);
  const y = linear([min, max === min ? min + 1 : max], [height - pad, pad]);
  const points = values.map((value, index) => value === null || !Number.isFinite(value) ? null : { x: x(index), y: y(value) });
  const isPartial = (index: number) => partial?.[index] === true;
  const complete = points.map((point, index) => (isPartial(index) ? null : point));
  const partialSegments = points.flatMap((point, index) => {
    if (!point || !isPartial(index)) return [];
    return [points[index - 1], points[index + 1]].filter((neighbour): neighbour is { x: number; y: number } => !!neighbour).map(neighbour => linePath([neighbour, point]));
  });
  let lastIndex = -1;
  for (let index = complete.length - 1; index >= 0; index--) if (complete[index]) { lastIndex = index; break; }
  let lastKnown = -1;
  for (let index = points.length - 1; index >= 0; index--) if (points[index]) { lastKnown = index; break; }
  const drawable = known.length >= 2;
  const completeActivity = values.some((value, index) => !isPartial(index) && value !== null && Number.isFinite(value) && value !== 0);
  const partialValue = lastKnown > lastIndex && isPartial(lastKnown) ? values[lastKnown] : null;
  const lastCompleteValue = lastIndex >= 0 ? values[lastIndex] : null;
  const partialLeads = partialValue !== null && partialValue !== 0
    && (!completeActivity || (cumulative && lastCompleteValue !== null && partialValue >= lastCompleteValue));
  const emphasis = !drawable ? null : partialLeads ? points[lastKnown] : lastIndex >= 0 ? complete[lastIndex] : null;
  const last = !drawable || partialLeads ? null : emphasis;
  const previous = last && lastIndex > 0 ? complete[lastIndex - 1] : null;
  const color = tone === "danger" ? "var(--rp-chart-fail)" : "var(--rp-chart-1)";

  return (
    <div ref={ref} className={className} style={{ height, width: fixedWidth }} role="img" aria-label={label} data-sparkline>
      {width > 0 && drawable && (
        <svg width={width} height={height} aria-hidden="true" focusable="false" className="block overflow-visible">
          <defs>
            <clipPath id={clipId}><rect x={0} y={0} width={width} height={height} /></clipPath>
          </defs>
          <g clipPath={`url(#${clipId})`}>
            <path d={linePath(complete)} fill="none" stroke="var(--rp-chart-history)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
            {partialSegments.map((d, index) => <path key={index} d={d} fill="none" stroke="var(--rp-chart-history)" strokeWidth={1.5} strokeDasharray="2 2" data-partial-segment />)}
            {last && previous && <path d={linePath([previous, last])} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" />}
          </g>
          {points.map((point, index) => point && isPartial(index) && !(partialLeads && index === lastKnown)
            ? <circle key={index} cx={point.x} cy={point.y} r={2} fill="var(--rp-surface)" stroke="var(--rp-chart-history)" strokeWidth={1.5} data-partial-point />
            : null)}
          {emphasis && <circle cx={emphasis.x} cy={emphasis.y} r={3} fill={color} stroke="var(--rp-surface)" strokeWidth={2} paintOrder="stroke" data-sparkline-end data-sparkline-end-partial={partialLeads || undefined} />}
        </svg>
      )}
    </div>
  );
}
