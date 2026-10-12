import { SCORE_AGGREGATION_LIMITS as L, type ScoreAggregates } from "./aggregation-protocol";

// Preserve linear interpolation; use weighted endpoints when their distance overflows.
function interpolate(low: number, high: number, fraction: number): number {
  if (fraction === 0) return low;
  if (fraction === 1) return high;
  const distance = high - low;
  return Number.isFinite(distance) ? low + distance * fraction : low * (1 - fraction) + high * fraction;
}

function quantile(sorted: number[], fraction: number): number {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  return interpolate(sorted[lower], sorted[Math.ceil(position)], position - lower);
}

/** Shared statistics over the admitted observations; excluded evidence stays in the denominator. */
export function computeScoreAggregates(observations: readonly unknown[], binCount = 10): ScoreAggregates {
  if (!Array.isArray(observations) || Object.getPrototypeOf(observations) !== Array.prototype || observations.length > L.values) {
    throw new RangeError("Score population requires an ordinary array of at most 8,000 observations.");
  }
  if (!Number.isInteger(binCount) || binCount < 1 || binCount > L.bins) throw new RangeError("Select 1 to 20 histogram bins.");
  for (const key of Reflect.ownKeys(observations)) {
    if (key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= observations.length)) {
      throw new RangeError("Score population contains an unsupported array property.");
    }
  }
  const values: number[] = [];
  for (let i = 0; i < observations.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(observations, String(i));
    if (!descriptor || !("value" in descriptor)) throw new RangeError("Score population cannot contain accessors or holes.");
    if (typeof descriptor.value === "number" && Number.isFinite(descriptor.value)) values.push(descriptor.value);
  }
  const population = { total: observations.length, finite: values.length, excluded: observations.length - values.length, zero: values.filter(value => value === 0).length };
  if (!values.length) return { population, sum: null, mean: null, min: null, max: null, median: null, p90: null, p95: null, p99: null, sumUnavailable: "empty", histogram: [] };

  let sum: number | null = 0;
  let mean = 0;
  for (let i = 0; i < values.length; i++) {
    if (sum !== null) {
      sum += values[i];
      if (!Number.isFinite(sum)) sum = null;
    }
    mean = interpolate(mean, values[i], 1 / (i + 1));
  }
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0], max = sorted[sorted.length - 1];
  const edges = [...new Set(Array.from({ length: binCount + 1 }, (_, i) => interpolate(min, max, i / binCount)))];
  const histogram: ScoreAggregates["histogram"] = min === max
    ? [{ lower: min, upper: max, upperInclusive: true, count: values.length }]
    : edges.slice(0, -1).map((lower, i) => ({ lower, upper: edges[i + 1], upperInclusive: i === edges.length - 2, count: 0 }));
  if (min !== max) {
    for (const value of values) {
      histogram.find(bin => value >= bin.lower && (value < bin.upper || bin.upperInclusive && value <= bin.upper))!.count++;
    }
  }
  return { population, sum, mean, min, max, median: quantile(sorted, 0.5), p90: quantile(sorted, 0.9), p95: quantile(sorted, 0.95), p99: quantile(sorted, 0.99), sumUnavailable: sum === null ? "overflow" : null, histogram };
}
