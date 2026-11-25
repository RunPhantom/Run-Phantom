import { apiJson } from "./request";
import type { Run } from "../utils/types";
import { OVERVIEW_WINDOWS, type Overview, type OverviewWindow } from "../../../src/stats/overview-types";

export type {
  CostKpi, DurationKpi, Kpi, Overview, OverviewAgentRow, OverviewBucket, OverviewFailingTool, OverviewFailure, OverviewGroupStats,
  OverviewLiveRun, OverviewModelRow, OverviewWindow, TokenKpi,
} from "../../../src/stats/overview-types";

export const OVERVIEW_WINDOW_OPTIONS = Object.keys(OVERVIEW_WINDOWS) as readonly OverviewWindow[];
export const DEFAULT_OVERVIEW_WINDOW: OverviewWindow = "24h";

export function isOverviewWindow(value: string | null | undefined): value is OverviewWindow {
  return !!value && (OVERVIEW_WINDOW_OPTIONS as readonly string[]).includes(value);
}

/** Minutes east of UTC, the unit the endpoint takes. */
export function localTzOffsetMinutes(date = new Date()): number {
  const offset = -date.getTimezoneOffset();
  return Object.is(offset, -0) ? 0 : offset;
}

/** The browser's IANA zone, so buckets follow local midnight across clock changes; undefined when the runtime does not expose one. */
export function localTimeZone(): string | undefined {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; }
}

export function getOverview(window: OverviewWindow, signal?: AbortSignal): Promise<Overview> {
  const params = new URLSearchParams({ window, tz_offset_minutes: String(localTzOffsetMinutes()) });
  const timeZone = localTimeZone();
  if (timeZone) params.set("tz", timeZone);
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

