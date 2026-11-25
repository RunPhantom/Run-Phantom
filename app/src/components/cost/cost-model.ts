import type { AnalyticsGroup, CostAnalyticsReport, CostAnalyticsRequest, MetricPopulation } from "../../../../src/pricing/analytics";
import { PRICE_TABLE_AS_OF } from "../../../../src/pricing/list-prices";
import { TOKEN_CATEGORIES, type CategoryRate, type FrozenRateRevision } from "../../../../src/pricing/protocol";
import { fmtCost } from "../../utils/costs";
import { compact } from "../charts/scale";

export const COST_WINDOWS = ["1h", "24h", "7d", "30d"] as const;
export type CostWindow = typeof COST_WINDOWS[number];
export const DEFAULT_COST_WINDOW: CostWindow = "24h";
export const COST_WINDOW_MS: Record<CostWindow, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
export const COST_WINDOW_COPY: Record<CostWindow, { eyebrow: string; phrase: string; short: string }> = {
  "1h": { eyebrow: "Last hour", phrase: "in the last hour", short: "1h" },
  "24h": { eyebrow: "Last 24 hours", phrase: "in the last 24 hours", short: "24h" },
  "7d": { eyebrow: "Last 7 days", phrase: "in the last 7 days", short: "7d" },
  "30d": { eyebrow: "Last 30 days", phrase: "in the last 30 days", short: "30d" },
};

export function isCostWindow(value: string | null | undefined): value is CostWindow {
  return !!value && (COST_WINDOWS as readonly string[]).includes(value);
}

export function bucketFor(window: CostWindow): CostAnalyticsRequest["bucket"] {
  return window === "1h" || window === "24h" ? "hour" : "day";
}

export type EstimateSource = "list" | "reported" | "manual" | "nominal";

export const ESTIMATE_SOURCE_LABELS: Record<EstimateSource, string> = {
  list: `List prices (${PRICE_TABLE_AS_OF})`,
  reported: "Reported cost only",
  manual: "Manual frozen rates",
  nominal: "OpenRouter catalogue",
};

/** Which money measure leads the page: the estimate, or the reported cost when estimates are switched off. */
export function spendMeasure(source: EstimateSource): "estimatedUsd" | "reportedUsd" {
  return source === "reported" ? "reportedUsd" : "estimatedUsd";
}

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

/** A whole-window value for comparison: zero calls is a known zero; any unknown call makes the total unknown. */
export function comparableTotal(metric: MetricPopulation): number | null {
  if (metric.eligibleCount === 0) return 0;
  return metric.completeTotal;
}

export interface CostBucket {
  start: number;
  end: number;
  partial: boolean;
  calls: number;
  spend: number | null;
  spendUnknown: number;
  inputTokens: number | null;
  outputTokens: number | null;
  tokenUnknown: number;
}

/**
 * Every bucket of the window in order, including the empty ones the report omits. The report keys buckets by
 * their UTC start (ISO); the first and last buckets usually cover only part of their span.
 */
export function costBuckets(report: Pick<CostAnalyticsReport, "window" | "byTime">, measure: "estimatedUsd" | "reportedUsd"): CostBucket[] {
  const size = report.window.bucket === "hour" ? 3_600_000 : 86_400_000;
  const { from, to } = report.window;
  const byStart = new Map<number, AnalyticsGroup>();
  for (const group of report.byTime) {
    if (group.identity === null) continue;
    const start = Date.parse(group.identity);
    if (Number.isFinite(start)) byStart.set(start, group);
  }
  const buckets: CostBucket[] = [];
  for (let start = Math.floor(from / size) * size; start < to; start += size) {
    const group = byStart.get(start);
    const metric = group?.[measure];
    const input = group?.tokens.input;
    const output = group?.tokens.output;
    buckets.push({
      start,
      end: start + size,
      partial: start < from || start + size > to,
      calls: metric?.eligibleCount ?? 0,
      spend: !metric || metric.eligibleCount === 0 ? 0 : metric.knownSum,
      spendUnknown: metric?.unavailableCount ?? 0,
      inputTokens: !input || input.eligibleCount === 0 ? 0 : input.knownSum,
      outputTokens: !output || output.eligibleCount === 0 ? 0 : output.knownSum,
      tokenUnknown: Math.max(input?.unavailableCount ?? 0, output?.unavailableCount ?? 0),
    });
  }
  return buckets;
}

const hourFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
const dayFormat = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** Tooltip heading: local clock times for hour buckets, the UTC calendar day for day buckets. */
export function costBucketTitle(bucket: Pick<CostBucket, "start" | "end">, size: "hour" | "day"): string {
  if (size === "day") return `${dayFormat.format(new Date(bucket.start))} (UTC)`;
  return `${hourFormat.format(new Date(bucket.start))}–${hourFormat.format(new Date(bucket.end))}`;
}

export interface TileDelta { text: string; direction: "up" | "down" | "flat"; label: string }

export function totalDelta(current: number | null, previous: number | null, kind: "cost" | "count"): TileDelta | null {
  if (current === null || previous === null) return null;
  const diff = current - previous;
  const direction = Math.abs(diff) < 1e-12 ? "flat" : diff > 0 ? "up" : "down";
  const sign = diff > 0 ? "+" : diff < 0 ? "−" : "±";
  let text: string;
  if (kind === "cost") text = direction === "flat" ? "±$0.00" : `${sign}${fmtCost(Math.abs(diff))}`;
  else if (previous === 0) text = direction === "flat" ? "±0" : `${sign}${compact(Math.abs(diff))}`;
  else {
    const percent = Math.abs(diff) / previous * 100;
    text = `${sign}${percent >= 10 ? Math.round(percent) : Math.round(percent * 10) / 10}%`;
  }
  const label = direction === "flat" ? "No change from the previous window" : `${direction === "up" ? "Up" : "Down"} ${text.slice(1)} from the previous window`;
  return { text, direction, label };
}

/** "All 12 calls priced", "9 of 12 calls priced", "None of 12 calls priced". */
export function coverage(metric: MetricPopulation, verb: string): string {
  const total = metric.eligibleCount;
  if (total === 0) return "No model calls in this window";
  if (metric.knownCount === total) return total === 1 ? `The 1 call ${verb}` : `All ${plural(total, "call")} ${verb}`;
  if (metric.knownCount === 0) return total === 1 ? `The 1 call not ${verb}` : `None of ${plural(total, "call")} ${verb}`;
  return `${metric.knownCount.toLocaleString("en-US")} of ${plural(total, "call")} ${verb}`;
}

export function tokenCoverage(metric: MetricPopulation): string {
  if (metric.eligibleCount === 0) return "No model calls in this window";
  if (metric.unavailableCount === 0) return `From ${plural(metric.eligibleCount, "call")}`;
  return `${metric.unavailableCount.toLocaleString("en-US")} of ${plural(metric.eligibleCount, "call")} without a count`;
}

/**
 * The money or token value of a metric, or "—" when no call carries one. A total that leaves out calls without a
 * value ends in "+", as in the tables, so a known subtotal never reads as the complete figure.
 */
export function metricText(metric: MetricPopulation, kind: "cost" | "tokens"): string {
  if (metric.knownSum === null) return "—";
  const text = kind === "cost" ? fmtCost(metric.knownSum) : compact(metric.knownSum);
  return metric.unavailableCount > 0 ? `${text}+` : text;
}

/** Tooltip for a partial metric value; null when the value covers every call. */
export function partialTitle(metric: MetricPopulation, kind: "cost" | "tokens"): string | null {
  if (metric.knownSum === null || metric.unavailableCount === 0) return null;
  const value = kind === "cost" ? fmtCost(metric.knownSum) : metric.knownSum.toLocaleString("en-US");
  const missing = `${plural(metric.unavailableCount, "call")} ${metric.unavailableCount === 1 ? "has" : "have"} no ${kind === "cost" ? "cost" : "count"}`;
  return `At least ${value}: ${missing} and ${metric.unavailableCount === 1 ? "is" : "are"} not included`;
}

const REASON_COPY: Record<string, string> = {
  reported_cost_missing: "no cost reported",
  reported_cost_invalid: "reported cost is not a valid amount",
  reported_cost_conflicting: "two different costs reported",
  reported_currency_unavailable: "reported cost is not in US dollars",
  rate_identity_unavailable: "no known price for the model",
  provider_unresolved: "provider unclear, or a reseller with its own prices",
  usage_unavailable: "no token counts",
  usage_missing: "no token count",
  usage_invalid: "token count is not a valid number",
  usage_conflicting: "two different token counts reported",
  cache_usage_ambiguous: "cached-token usage unclear",
  estimate_failed: "estimate could not be computed",
  attributes_unavailable: "call details unreadable",
  timestamp_unavailable: "no start time",
  ancestry_unavailable: "not placed in its run",
};

/** Plain-English reason lines with counts, most common first. */
export function reasonLines(metric: MetricPopulation): { text: string; count: number }[] {
  return Object.entries(metric.unavailableReasons)
    .map(([reason, count]) => ({ text: REASON_COPY[reason] ?? reason.replace(/_/g, " "), count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
}

export interface ModelRow {
  model: string | null;
  calls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  tokenUnknown: number;
  spend: number | null;
  spendUnknown: number;
  reported: number | null;
  share: number | null;
}

/** By-model rows for the leading measure, most spend first, then most calls; unknown spend sorts last. */
export function modelRows(report: Pick<CostAnalyticsReport, "byModel">, measure: "estimatedUsd" | "reportedUsd"): ModelRow[] {
  const total = report.byModel.reduce((sum, group) => sum + (group[measure].knownSum ?? 0), 0);
  return report.byModel.map(group => {
    const spend = group[measure].knownSum;
    return {
      model: group.identity,
      calls: group[measure].eligibleCount,
      inputTokens: group.tokens.input.knownSum,
      outputTokens: group.tokens.output.knownSum,
      tokenUnknown: Math.max(group.tokens.input.unavailableCount, group.tokens.output.unavailableCount),
      spend,
      spendUnknown: group[measure].unavailableCount,
      reported: group.reportedUsd.knownSum,
      share: spend !== null && total > 0 ? spend / total : null,
    };
  }).sort((a, b) => (a.spend === null ? 1 : 0) - (b.spend === null ? 1 : 0) || (b.spend ?? 0) - (a.spend ?? 0) || b.calls - a.calls
    || (a.model ?? "￿").localeCompare(b.model ?? "￿"));
}

export function formatShare(share: number | null): string {
  if (share === null || !Number.isFinite(share)) return "—";
  const percent = share * 100;
  if (percent > 0 && percent < 0.1) return "<0.1%";
  return `${percent >= 10 ? Math.round(percent) : Math.round(percent * 10) / 10}%`;
}

/**
 * The population sentence behind "How this is calculated". Only non-zero exclusions are mentioned, so a clean
 * window reads as one sentence.
 */
export function populationSentences(population: CostAnalyticsReport["population"]): string[] {
  const lines = [`${plural(population.selectedGenerations, "model call")} started in this window and ${population.selectedGenerations === 1 ? "is" : "are"} counted.`];
  if (population.nestedExcluded) lines.push(`${plural(population.nestedExcluded, "call")} made inside another model call ${population.nestedExcluded === 1 ? "is" : "are"} counted once, through the outer call.`);
  if (population.untimedGenerations) lines.push(`${plural(population.untimedGenerations, "call")} ${population.untimedGenerations === 1 ? "has" : "have"} no start time, so ${population.untimedGenerations === 1 ? "it" : "they"} may belong to this window; ${population.untimedGenerations === 1 ? "its" : "their"} cost and tokens count as unknown.`);
  if (population.ancestryUnavailable) lines.push(`${plural(population.ancestryUnavailable, "call")} could not be placed in ${population.ancestryUnavailable === 1 ? "its" : "their"} run, so ${population.ancestryUnavailable === 1 ? "its" : "their"} cost and tokens count as unknown.`);
  return lines;
}

function categoryRateText(rate: Exclude<CategoryRate, { kind: "not_applicable" }>): string {
  switch (rate.kind) {
    case "priced": return `$${Number(rate.usdPerMillionTokens.toPrecision(6))} per million`;
    case "included": return "included in another category";
    case "unavailable": return "no price, so unknown";
  }
}

/**
 * How a rate prices each token category, one line per context band: "input: $0.05 per million · cache read: included
 * in another category · not applicable: reasoning, audio input". Lets a manual or catalogue estimate be audited on
 * the page, not only in the export.
 */
export function ratePolicyLines(rate: Pick<FrozenRateRevision, "bands">): string[] {
  return rate.bands.map((band, index) => {
    const label = (category: string) => category.split("_").join(" ");
    const parts: string[] = [];
    const skipped: string[] = [];
    for (const category of TOKEN_CATEGORIES) {
      const policy = band.categories[category];
      if (policy.kind === "not_applicable") skipped.push(label(category));
      else parts.push(`${label(category)}: ${categoryRateText(policy)}`);
    }
    if (skipped.length) parts.push(`not applicable: ${skipped.join(", ")}`);
    const policies = parts.join(" · ");
    if (rate.bands.length === 1) return policies;
    const lower = index === 0 ? null : rate.bands[index - 1]!.maxContextTokens;
    const range = band.maxContextTokens === null ? `Above ${(lower ?? 0).toLocaleString("en-US")} context tokens` : `Up to ${band.maxContextTokens.toLocaleString("en-US")} context tokens`;
    return `${range}: ${policies}`;
  });
}
