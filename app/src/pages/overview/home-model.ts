import type { Kpi, Overview, OverviewBucket, OverviewWindow } from "../../api/overview";
import type { RunsViewStatus } from "../../../../src/saved-views-protocol";
import { compact } from "../../components/charts/scale";
import { fmt } from "../../utils/helpers";
import { fmtCost } from "../../utils/costs";

export const WINDOW_COPY: Record<OverviewWindow, { eyebrow: string; phrase: string; short: string; option: string }> = {
  "1h": { eyebrow: "Last hour", phrase: "in the last hour", short: "1h", option: "Last hour" },
  "24h": { eyebrow: "Last 24 hours", phrase: "in the last 24 hours", short: "24h", option: "Last 24 hours" },
  "7d": { eyebrow: "Last 7 days", phrase: "in the last 7 days", short: "7d", option: "Last 7 days" },
  "30d": { eyebrow: "Last 30 days", phrase: "in the last 30 days", short: "30d", option: "Last 30 days" },
};

/** A headline piece: Syne words, Inter digits (`digits`), danger ink for the failure count. */
export interface HeadlinePart { text: string; digits?: boolean; tone?: "danger" }

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/**
 * The computed data sentence that heads Home, e.g.
 * "21 runs in the last 24 hours. 3 failed, all since 13:00. 4 more finished with errors."
 */
export function headlineParts(overview: Overview, timeZone?: string): HeadlinePart[] {
  const window = overview.window.selection;
  const runs = overview.kpis.runs.value ?? 0;
  const failed = overview.kpis.failed.value ?? 0;
  const withErrors = overview.kpis.completedWithErrors.value ?? 0;
  const running = overview.kpis.running.value ?? 0;
  const interrupted = overview.kpis.interrupted.value ?? 0;
  const phrase = WINDOW_COPY[window].phrase;
  if (runs === 0) return [{ text: `No runs ${phrase}.` }];

  const parts: HeadlinePart[] = [{ text: String(runs), digits: true }, { text: ` ${plural(runs, "run", "runs")} ${phrase}.` }];
  const ended = failed + withErrors + (overview.kpis.completed.value ?? 0);
  if (failed > 0) {
    parts.push({ text: " " }, { text: String(failed), digits: true, tone: "danger" }, { text: " failed", tone: "danger" });
    const since = failureOnset(overview.timeseries, failed);
    if (since !== null) {
      const label = bucketClock(since, window, timeZone);
      parts.push({ text: `, ${failed === 2 ? "both" : "all"} since ` }, { text: label, digits: true });
    }
    if (withErrors > 0) parts.push({ text: ". " }, { text: String(withErrors), digits: true }, { text: ` more finished with errors.` });
    else parts.push({ text: "." });
  } else if (withErrors > 0) {
    parts.push({ text: " None failed; " }, { text: String(withErrors), digits: true }, { text: ` finished with errors.` });
  } else if (ended > 0) {
    parts.push({ text: " None failed." });
  }
  if (running > 0) parts.push({ text: " " }, { text: String(running), digits: true }, { text: " still running." });
  if (interrupted > 0) parts.push({ text: " " }, { text: String(interrupted), digits: true }, { text: ` ${plural(interrupted, "was", "were")} interrupted.` });
  return parts;
}

export function headlineText(parts: readonly HeadlinePart[]): string {
  return parts.map(part => part.text).join("");
}

/**
 * Start of the first bucket holding a failure, when two or more failures all fall
 * in the later part of the window after earlier runs that did not fail. Null when
 * the timing says nothing (a single failure, or failures from the start).
 */
export function failureOnset(buckets: readonly OverviewBucket[], failed: number): number | null {
  if (failed < 2) return null;
  const first = buckets.findIndex(bucket => bucket.failed > 0);
  if (first <= 0) return null;
  const earlierRuns = buckets.slice(0, first).reduce((sum, bucket) => sum + bucket.runs, 0);
  if (earlierRuns === 0) return null;
  const counted = buckets.slice(first).reduce((sum, bucket) => sum + bucket.failed, 0);
  if (counted !== failed) return null;
  if (first < buckets.length / 3) return null;
  return buckets[first].start;
}

/** Clock label for a bucket edge: "13:00" within a day, "Tue 18:00" for 7d, "3 Nov" for 30d. */
export function bucketClock(ms: number, window: OverviewWindow, timeZone?: string): string {
  const date = new Date(ms);
  if (window === "30d") return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(date);
  if (window === "7d") return `${new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone }).format(date)} ${time}`;
  return time;
}

/** Tooltip heading for a bucket span, e.g. "13:00–14:00" or "Tue 3 Nov". */
export function bucketTitle(bucket: Pick<OverviewBucket, "start" | "end">, window: OverviewWindow, timeZone?: string): string {
  if (window === "30d") return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone }).format(new Date(bucket.start));
  const start = bucketClock(bucket.start, window, timeZone);
  const end = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(new Date(bucket.end));
  return `${start}–${end}`;
}

export type DeltaTone = "good" | "bad" | "neutral";
export interface Delta { text: string; direction: "up" | "down" | "flat"; tone: DeltaTone; label: string }

type DeltaKind = "count" | "rate" | "duration" | "cost";

/**
 * Change against the previous window of the same length. Colour comes from
 * whether the direction is good for this measure: more errors is bad, faster is
 * good, volume and spend are neutral. Null when either side is unknown.
 */
export function kpiDelta(kpi: Kpi, kind: DeltaKind, upIs: DeltaTone = "neutral"): Delta | null {
  const { value, previous } = kpi;
  if (value === null || previous === null || !Number.isFinite(value) || !Number.isFinite(previous)) return null;
  const diff = value - previous;
  const direction = Math.abs(diff) < 1e-12 ? "flat" : diff > 0 ? "up" : "down";
  const tone: DeltaTone = direction === "flat" || upIs === "neutral" ? "neutral" : direction === "up" ? upIs : upIs === "good" ? "bad" : "good";
  const sign = diff > 0 ? "+" : diff < 0 ? "−" : "±";
  let text: string;
  if (kind === "count") {
    if (previous === 0) text = direction === "flat" ? "±0" : `${sign}${compact(Math.abs(diff))}`;
    else text = `${sign}${formatPercent(Math.abs(diff) / previous)}`;
  } else if (kind === "rate") {
    text = `${sign}${trimNumber(Math.abs(diff) * 100)} pts`;
  } else if (kind === "duration") {
    text = direction === "flat" ? "±0s" : `${sign}${fmt(Math.abs(diff))}`;
  } else {
    text = direction === "flat" ? "±$0.00" : `${sign}${fmtCost(Math.abs(diff))}`;
  }
  const label = `${direction === "flat" ? "No change" : `${direction === "up" ? "Up" : "Down"} ${text.replace(/^[+−]/, "")}`} from the previous window`;
  return { text, direction, tone, label };
}

function formatPercent(share: number): string {
  const percent = share * 100;
  return `${percent >= 10 ? Math.round(percent) : trimNumber(percent)}%`;
}

function trimNumber(value: number): string {
  return value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
}

export function formatRate(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const percent = value * 100;
  if (percent === 0) return "0%";
  if (percent < 0.1) return "<0.1%";
  return `${percent >= 10 ? Math.round(percent) : Math.round(percent * 10) / 10}%`;
}

export function formatTokens(value: number | null): string {
  return value === null ? "—" : compact(value);
}

export function sumKnown(...values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

/**
 * Per-bucket series for the KPI sparklines. Unknown buckets are null, not zero.
 * `partial` marks the window-edge buckets that hold only part of their span.
 */
export function kpiSeries(buckets: readonly OverviewBucket[]) {
  return {
    partial: buckets.map(bucket => bucket.partial),
    runs: buckets.map(bucket => bucket.runs),
    errorRate: buckets.map(bucket => bucket.finished ? (bucket.failed + bucket.completedWithErrors) / bucket.finished : null),
    p95: buckets.map(bucket => bucket.durationP95Ms),
    tokens: buckets.map(bucket => bucket.runs ? bucket.inputTokens + bucket.outputTokens : 0),
    cost: buckets.map(bucket => bucket.costUsd),
  };
}

export interface RunsLinkFilters {
  status?: readonly RunsViewStatus[];
  agent?: string | null;
  model?: string | null;
  window?: OverviewWindow;
  since?: number;
  until?: number;
  sort?: "last_updated_at" | "started_at" | "duration" | "cost" | "tokens" | "errors";
}

/**
 * A Runs table URL using the Runs page's filter parameters (status, agent, model,
 * window or since/until, sort), which mirror GET /api/runs.
 */
export function runsLink(filters: RunsLinkFilters): string {
  const params = new URLSearchParams();
  if (filters.status?.length) params.set("status", filters.status.join(","));
  if (filters.agent) params.set("agent", filters.agent);
  if (filters.model) params.set("model", filters.model);
  if (filters.window) params.set("window", filters.window);
  else {
    if (filters.since !== undefined) params.set("since", String(filters.since));
    if (filters.until !== undefined) params.set("until", String(filters.until));
  }
  if (filters.sort && filters.sort !== "last_updated_at") params.set("sort", filters.sort);
  const query = params.toString();
  return query ? `/runs?${query}` : "/runs";
}

/** Whether the Home window should show the teaching empty state: nothing captured at all. */
export function isWorkspaceEmpty(overview: Overview | undefined, knownRunTotal: number | null): boolean {
  if (!overview) return false;
  if ((overview.kpis.runs.value ?? 0) > 0 || (overview.kpis.runs.previous ?? 0) > 0 || overview.liveRuns.length > 0) return false;
  return knownRunTotal === 0;
}

export function costLabel(cost: Overview["kpis"]["costUsd"]): string {
  if (cost.knownCalls === 0) return "Cost";
  if (cost.reportedCalls === cost.knownCalls) return "Reported cost";
  return "Est. cost";
}
