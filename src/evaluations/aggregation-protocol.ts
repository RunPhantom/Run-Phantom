export const SCORE_AGGREGATION_LIMITS = { values: 8000, bins: 20 } as const;
import type { BudgetMetric, Experiment } from "./protocol";

export const DISTRIBUTION_FORMAT = "runphantom-score-distribution/v1" as const;
export const DISTRIBUTION_UNITS = { inputTokens: "tokens", outputTokens: "tokens", totalTokens: "tokens", durationMs: "ms", costUsd: "USD", toolCalls: "calls" } as const;
export type DistributionSelector = { kind: "check_score"; caseId: string; ruleIndex: number } | { kind: "snapshot_metric"; metric: BudgetMetric };
export interface DistributionRequest { experimentIds: string[]; selector: DistributionSelector; direction: "higher" | "lower" | "none"; bins: number }
export interface ScoreDistributionAnalysis {
  format: typeof DISTRIBUTION_FORMAT;
  selection: DistributionRequest;
  dataset: { id: string; version: number };
  evaluationVersion: number;
  snapshotVersion: number;
  unit: "score" | "tokens" | "ms" | "USD" | "calls";
  overall: ScoreAggregates;
  experiments: Array<{ experimentId: string; status: "completed" | "cancelled"; verdict: Experiment["verdict"]; createdAt: number | null; completedAt: number | null; stats: ScoreAggregates }>;
  trend: Array<{ from: string; to: string; delta: number | null; deltaUnavailable: "empty" | "overflow" | null; change: "higher" | "lower" | "unchanged" | "unavailable"; preference: "improved" | "regressed" | "unchanged" | null }>;
  limitations: string[];
}

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
