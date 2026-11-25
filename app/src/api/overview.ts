import { apiJson } from "./request";
import type { Run } from "../utils/types";

// Mirrors src/stats/overview.ts (contract: runphantom-overview/1). Declared here because that module
// pulls in bun:sqlite types, which the browser build cannot resolve.
export const OVERVIEW_WINDOW_OPTIONS = ["1h", "24h", "7d", "30d"] as const;
export type OverviewWindow = typeof OVERVIEW_WINDOW_OPTIONS[number];
export const DEFAULT_OVERVIEW_WINDOW: OverviewWindow = "24h";

export interface Kpi { value: number | null; previous: number | null }
export interface TokenKpi extends Kpi { knownCalls: number; unknownCalls: number }
export interface CostKpi extends Kpi { knownCalls: number; unknownCalls: number; reportedCalls: number; estimatedCalls: number; previousUnknownCalls: number }
export interface DurationKpi extends Kpi { knownRuns: number }

export interface OverviewBucket {
  start: number;
  end: number;
  partial: boolean;
  runs: number;
  failed: number;
  completedWithErrors: number;
  inputTokens: number;
  outputTokens: number;
  tokenUnknownCalls: number;
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
export interface OverviewModelRow extends OverviewGroupStats {
  model: string | null; provider: string | null; calls: number; callP50Ms: number | null; callP95Ms: number | null;
  durationP50Ms: number | null; durationP95Ms: number | null;
}
export interface OverviewFailingTool { tool: string; failures: number; calls: number; failedRuns: number; lastError: { message: string | null; runId: string; spanId: string; at: number | null } }
export interface OverviewFailure {
  runId: string; name: string; agent: string | null; status: "failed" | "completed_with_errors"; startedAt: number; errorCount: number;
  error: { spanId: string; step: string; message: string | null } | null;
}
export interface OverviewLiveRun { runId: string; name: string; agent: string | null; startedAt: number; lastUpdatedAt: number; spanCount: number; model: string | null }

export interface Overview {
  version: "runphantom-overview/1";
  asOf: number;
  window: { selection: OverviewWindow; from: number; to: number; previousFrom: number; previousTo: number; bucketMs: number; tzOffsetMinutes: number; field: "startedAt" };
  filters: { agent: string | null; model: string | null };
  pricing: { estimateMode: "list-prices"; rateCount: number; revision: string; asOf: string };
  kpis: {
    runs: Kpi; running: Kpi; completed: Kpi; completedWithErrors: Kpi; failed: Kpi;
    failureRate: Kpi; errorRate: Kpi;
    durationP50Ms: DurationKpi; durationP95Ms: DurationKpi;
    inputTokens: TokenKpi; outputTokens: TokenKpi;
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

export function isOverviewWindow(value: string | null | undefined): value is OverviewWindow {
  return !!value && (OVERVIEW_WINDOW_OPTIONS as readonly string[]).includes(value);
}

/** Minutes east of UTC, the unit the endpoint takes. */
export function localTzOffsetMinutes(date = new Date()): number {
  const offset = -date.getTimezoneOffset();
  return Object.is(offset, -0) ? 0 : offset;
}

export function getOverview(window: OverviewWindow, signal?: AbortSignal): Promise<Overview> {
  const params = new URLSearchParams({ window, tz_offset_minutes: String(localTzOffsetMinutes()) });
  return apiJson<Overview>(`/api/overview?${params}`, { signal });
}

/** The enriched GET /api/runs row fields Home reads (contract: runs-api.md); status is re-derived in the UI. */
export interface LatestRunRow extends Run {
  agent: string | null;
  duration_ms: number | null;
  primary_model: string | null;
  llm_calls: number;
  tool_count: number;
}

export interface LatestRunsPage { runs: LatestRunRow[]; total: number }

export function getLatestRuns(limit: number, signal?: AbortSignal): Promise<LatestRunsPage> {
  return apiJson<LatestRunsPage>(`/api/runs?envelope=1&limit=${limit}`, { signal });
}
