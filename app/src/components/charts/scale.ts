export type Domain = readonly [number, number];

/** Maps a domain onto a pixel range; a zero-width domain maps everything to the range start. */
export function linear(domain: Domain, range: Domain): (value: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  if (span === 0 || !Number.isFinite(span)) return () => r0;
  return value => r0 + ((value - d0) / span) * (r1 - r0);
}

/**
 * Round ticks from 0 to the smallest nice maximum covering `max`, using at most
 * `maxIntervals` intervals (steps of 1, 2, 2.5 or 5 times a power of ten). The
 * chart gridline budget is three lines above the baseline, so the default is 3.
 * `integer` keeps every tick whole, for counts.
 */
export function niceTicks(max: number, maxIntervals = 3, integer = false): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  let best: { step: number; intervals: number } | null = null;
  for (let intervals = 2; intervals <= Math.max(2, maxIntervals); intervals++) {
    const rough = max / intervals;
    const power = 10 ** Math.floor(Math.log10(rough));
    const steps = [1, 2, 2.5, 5, 10].map(factor => factor * power).filter(candidate => !integer || (candidate >= 1 && Number.isInteger(candidate)));
    const step = steps.find(candidate => candidate * intervals >= max - 1e-9) ?? Math.max(integer ? 1 : 0, 10 * power);
    const used = Math.ceil(max / step - 1e-9);
    if (!best || step * used < best.step * best.intervals - 1e-9) best = { step, intervals: used };
  }
  return Array.from({ length: best!.intervals + 1 }, (_, index) => roundTick(index * best!.step));
}

function roundTick(value: number): number {
  return Number.parseFloat(value.toPrecision(12));
}

const compactFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const fullFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** Axis and tile numbers: in full under 10,000, compact above (12.9K, 3.4M). */
export function compact(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Math.abs(value) < 10_000 ? fullFormat.format(value) : compactFormat.format(value);
}

/** Relative label for a time `ms` before `now`, used for endpoint-only x axes ("24h ago", "now"). */
export function relativeTimeLabel(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return "now";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(diff / 3_600_000);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

/** The ticks an endpoint-only x axis shows: first, middle and last position. */
export function endpointIndices(length: number): number[] {
  if (length <= 0) return [];
  if (length === 1) return [0];
  if (length === 2) return [0, 1];
  return [0, Math.floor((length - 1) / 2), length - 1];
}

/** Index of the slot under `x` for `count` equal slots spanning [0, width). Clamped. */
export function slotAt(x: number, width: number, count: number): number {
  if (count <= 0 || width <= 0) return -1;
  return Math.min(count - 1, Math.max(0, Math.floor((x / width) * count)));
}

/** Index of the point nearest to `x` for `count` points spread evenly from 0 to width. */
export function nearestPoint(x: number, width: number, count: number): number {
  if (count <= 0) return -1;
  if (count === 1 || width <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.round((x / width) * (count - 1))));
}

/** Words for a short series: "rising", "falling" or "flat", comparing the last value with the mean of the others. */
export function trendWord(values: readonly (number | null)[]): "rising" | "falling" | "flat" | null {
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (known.length < 2) return null;
  const last = known[known.length - 1];
  const rest = known.slice(0, -1);
  const mean = rest.reduce((sum, value) => sum + value, 0) / rest.length;
  const scale = Math.max(Math.abs(mean), Math.abs(last), 1e-9);
  const change = (last - mean) / scale;
  if (change > 0.1) return "rising";
  if (change < -0.1) return "falling";
  return "flat";
}

/** Path for a polyline through points, breaking at null values. */
export function linePath(points: readonly ({ x: number; y: number } | null)[]): string {
  let path = "";
  let pen = false;
  for (const point of points) {
    if (!point) { pen = false; continue; }
    path += `${pen ? "L" : "M"}${round(point.x)},${round(point.y)}`;
    pen = true;
  }
  return path;
}

/** Closed area path from each contiguous run of points down to `baseline`. */
export function areaPath(points: readonly ({ x: number; y: number } | null)[], baseline: number): string {
  let path = "";
  let run: { x: number; y: number }[] = [];
  const flush = () => {
    if (run.length > 1) {
      path += `M${round(run[0].x)},${round(baseline)}`;
      for (const point of run) path += `L${round(point.x)},${round(point.y)}`;
      path += `L${round(run[run.length - 1].x)},${round(baseline)}Z`;
    }
    run = [];
  };
  for (const point of points) {
    if (point) run.push(point); else flush();
  }
  flush();
  return path;
}

/**
 * A column with a rounded data end and a square baseline end. `radius` is clamped
 * to half the width and to the height so short columns stay columns.
 */
export function columnPath(x: number, y: number, width: number, height: number, radius: number): string {
  if (height <= 0 || width <= 0) return "";
  const r = Math.max(0, Math.min(radius, width / 2, height));
  const bottom = y + height;
  return `M${round(x)},${round(bottom)}V${round(y + r)}Q${round(x)},${round(y)} ${round(x + r)},${round(y)}H${round(x + width - r)}Q${round(x + width)},${round(y)} ${round(x + width)},${round(y + r)}V${round(bottom)}Z`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface HistogramBin { from: number; to: number; count: number }

/** Equal-width bins over [min, max] of the finite values; at least one bin when there is data. */
export function binValues(values: readonly number[], binCount = 12): HistogramBin[] {
  const finite = values.filter(value => Number.isFinite(value));
  if (!finite.length) return [];
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (min === max) return [{ from: min, to: max, count: finite.length }];
  const count = Math.max(1, Math.floor(binCount));
  const width = (max - min) / count;
  const bins = Array.from({ length: count }, (_, index) => ({ from: min + index * width, to: index === count - 1 ? max : min + (index + 1) * width, count: 0 }));
  for (const value of finite) bins[Math.min(count - 1, Math.floor((value - min) / width))].count++;
  return bins;
}

/**
 * The active index after a key press on a focused chart. Arrow keys start from
 * `from` when nothing is active yet; Home and End jump to the ends; Escape clears
 * (null). Undefined means the key is not a chart key and should not be consumed.
 */
export function chartKeyStep(key: string, active: number | null, count: number, from: "first" | "last" = "last"): number | null | undefined {
  if (count <= 0) return undefined;
  const start = from === "first" ? 0 : count - 1;
  switch (key) {
    case "ArrowRight": return active === null ? start : Math.min(count - 1, active + 1);
    case "ArrowLeft": return active === null ? start : Math.max(0, active - 1);
    case "Home": return 0;
    case "End": return count - 1;
    case "Escape": return null;
    default: return undefined;
  }
}
