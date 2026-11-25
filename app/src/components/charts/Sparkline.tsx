import { useId } from "react";
import { linePath, linear } from "./scale";
import { useElementSize } from "./use-element-size";

/**
 * A tiny trend line with no axes: history in the neutral tone, the last segment
 * and end dot in the series colour (`tone="danger"` for failure-like measures).
 * Null values break the line rather than reading as zero.
 */
export function Sparkline({ values, label, tone = "accent", height = 28, className }: {
  values: readonly (number | null)[];
  label: string;
  tone?: "accent" | "danger";
  height?: number;
  className?: string;
}) {
  const [ref, { width }] = useElementSize<HTMLDivElement>();
  const clipId = useId();
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value));
  const max = known.length ? Math.max(...known) : 0;
  const min = known.length ? Math.min(0, ...known) : 0;
  const pad = 4;
  const x = linear([0, Math.max(1, values.length - 1)], [pad, Math.max(pad, width - pad)]);
  const y = linear([min, max === min ? min + 1 : max], [height - pad, pad]);
  const points = values.map((value, index) => value === null || !Number.isFinite(value) ? null : { x: x(index), y: y(value) });
  let lastIndex = -1;
  for (let index = points.length - 1; index >= 0; index--) if (points[index]) { lastIndex = index; break; }
  let previousIndex = -1;
  for (let index = lastIndex - 1; index >= 0; index--) if (points[index]) { previousIndex = index; break; }
  const last = lastIndex >= 0 ? points[lastIndex] : null;
  const previous = previousIndex >= 0 && previousIndex === lastIndex - 1 ? points[previousIndex] : null;
  const color = tone === "danger" ? "var(--rp-chart-fail)" : "var(--rp-chart-1)";

  return (
    <div ref={ref} className={className} style={{ height }} role="img" aria-label={label} data-sparkline>
      {width > 0 && (
        <svg width={width} height={height} aria-hidden="true" focusable="false" className="block overflow-visible">
          <defs>
            <clipPath id={clipId}><rect x={0} y={0} width={width} height={height} /></clipPath>
          </defs>
          <g clipPath={`url(#${clipId})`}>
            <path d={linePath(points)} fill="none" stroke="var(--rp-chart-history)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
            {last && previous && <path d={linePath([previous, last])} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" />}
          </g>
          {last && <circle cx={last.x} cy={last.y} r={3} fill={color} stroke="var(--rp-surface)" strokeWidth={2} paintOrder="stroke" />}
        </svg>
      )}
    </div>
  );
}
