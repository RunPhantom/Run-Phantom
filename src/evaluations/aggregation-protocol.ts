export const SCORE_AGGREGATION_LIMITS = { values: 8000, bins: 20 } as const;

export interface ScoreAggregates {
  population: { total: number; finite: number; excluded: number; zero: number };
  sum: number | null;
  mean: number | null;
  min: number | null;
  max: number | null;
  median: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  sumUnavailable: "empty" | "overflow" | null;
  histogram: Array<{ lower: number; upper: number; upperInclusive: boolean; count: number }>;
}
