import type { RunOutcome } from "../run-status";

/**
 * The runphantom-overview/1 contract. Kept free of runtime imports so the browser
 * build can import it too (app/src/api/overview.ts); src/stats/overview.ts computes it.
 */
export const OVERVIEW_VERSION = "runphantom-overview/1" as const;
export const OVERVIEW_WINDOWS = {
  "1h": { durationMs: 3_600_000, bucketMs: 300_000 },
  "24h": { durationMs: 86_400_000, bucketMs: 3_600_000 },
  "7d": { durationMs: 7 * 86_400_000, bucketMs: 6 * 3_600_000 },
  "30d": { durationMs: 30 * 86_400_000, bucketMs: 86_400_000 },
} as const;
export type OverviewWindow = keyof typeof OVERVIEW_WINDOWS;
export const OVERVIEW_LIMITS = Object.freeze({ tableRows: 50, topFailingTools: 10, recentFailures: 10, liveRuns: 10, liveActivityMs: 10 * 60_000 });

export interface Kpi { value: number | null; previous: number | null }
export interface TokenKpi extends Kpi { knownCalls: number; unknownCalls: number }
export interface CostKpi extends Kpi { knownCalls: number; unknownCalls: number; reportedCalls: number; estimatedCalls: number; previousUnknownCalls: number }
export interface DurationKpi extends Kpi { knownRuns: number }

export interface OverviewBucket {
  start: number;
  end: number;
  runs: number;
  /** Runs that recorded how they ended (completed, completed with errors or failed): the error-rate denominator. */
  finished: number;
  failed: number;
  completedWithErrors: number;
  /** True for the first and last buckets when they extend past the window: the first holds only runs from window.from on, the last only up to window.to. */
  partial: boolean;
  /** Sum of the known counts; calls missing a count add nothing and are counted in tokenUnknownCalls. */
  inputTokens: number;
  outputTokens: number;
  /** Model calls missing input or output tokens. */
  tokenUnknownCalls: number;
  /** Known spend; null when the bucket has model calls but none with a known cost. */
  costUsd: number | null;
  costUnknownCalls: number;
  durationP95Ms: number | null;
}

export interface OverviewGroupStats {
  runs: number;
  failed: number;
  completedWithErrors: number;
  failureRate: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  tokenUnknownCalls: number;
  costUsd: number | null;
  costKnownCalls: number;
  costUnknownCalls: number;
}
export interface OverviewAgentRow extends OverviewGroupStats { agent: string | null; durationP50Ms: number | null; durationP95Ms: number | null }
/** durationP50Ms/P95Ms are run durations of the runs that called the model; callP50Ms/P95Ms are per-call latencies. */
export interface OverviewModelRow extends OverviewGroupStats { model: string | null; provider: string | null; calls: number; callP50Ms: number | null; callP95Ms: number | null; durationP50Ms: number | null; durationP95Ms: number | null }
export interface OverviewFailingTool { tool: string; failures: number; calls: number; failedRuns: number; lastError: { message: string | null; runId: string; spanId: string; at: number | null } }
export interface OverviewFailure { runId: string; name: string; agent: string | null; status: Extract<RunOutcome, "failed" | "completed_with_errors">; startedAt: number; errorCount: number; error: { spanId: string; step: string; message: string | null } | null }
export interface OverviewLiveRun { runId: string; name: string; agent: string | null; startedAt: number; lastUpdatedAt: number; spanCount: number; model: string | null }

export interface Overview {
  version: typeof OVERVIEW_VERSION;
  asOf: number;
  window: { selection: OverviewWindow; from: number; to: number; previousFrom: number; previousTo: number; bucketMs: number; tzOffsetMinutes: number; field: "startedAt" };
  filters: { agent: string | null; model: string | null };
  /** Unreported model calls are estimated from the bundled list-price table (src/pricing/list-prices.ts). */
  pricing: { estimateMode: "list-prices"; rateCount: number; revision: string; asOf: string };
  kpis: {
    runs: Kpi;
    running: Kpi;
    completed: Kpi;
    completedWithErrors: Kpi;
    failed: Kpi;
    interrupted: Kpi;
    cancelled: Kpi;
    unknown: Kpi;
    /** Shares of finished runs (completed, completed with errors, failed); null when none finished. */
    failureRate: Kpi;
    errorRate: Kpi;
    durationP50Ms: DurationKpi;
    durationP95Ms: DurationKpi;
    inputTokens: TokenKpi;
    outputTokens: TokenKpi;
    costUsd: CostKpi;
    activeAgents: Kpi;
  };
  timeseries: OverviewBucket[];
  byAgent: OverviewAgentRow[];
  byModel: OverviewModelRow[];
  topFailingTools: OverviewFailingTool[];
  recentFailures: OverviewFailure[];
  liveRuns: OverviewLiveRun[];
  truncated: { byAgent: boolean; byModel: boolean };
}
