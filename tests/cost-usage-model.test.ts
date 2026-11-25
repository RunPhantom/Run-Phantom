import { describe, expect, test } from "bun:test";
import type { AnalyticsGroup, CostAnalyticsReport, MetricPopulation } from "../src/pricing/analytics";
import { TOKEN_CATEGORIES } from "../src/pricing/protocol";
import {
  comparableTotal, costBucketTitle, costBuckets, coverage, formatShare, metricText, modelRows, populationSentences, reasonLines, tokenCoverage, totalDelta,
} from "../app/src/components/cost/cost-model";
import { moneyTick } from "../app/src/components/cost/CostPanels";

const HOUR = 3_600_000;

function metric(values: readonly (number | null)[], reason = "reported_cost_missing"): MetricPopulation {
  const known = values.filter((value): value is number => value !== null);
  const unknown = values.length - known.length;
  return {
    eligibleCount: values.length, knownCount: known.length, unavailableCount: unknown, zeroCount: known.filter(value => value === 0).length,
    knownSum: known.length ? known.reduce((sum, value) => sum + value, 0) : null,
    completeTotal: values.length && !unknown ? known.reduce((sum, value) => sum + value, 0) : null,
    sumState: known.length ? "known" : "empty", unavailableReasons: unknown ? { [reason]: unknown } : {},
  };
}

function group(identity: string | null, spend: readonly (number | null)[], input: readonly (number | null)[] = spend.map(() => 10), output: readonly (number | null)[] = spend.map(() => 2)): AnalyticsGroup {
  return {
    identity,
    reportedUsd: metric(spend.map(() => null)),
    estimatedUsd: metric(spend, "rate_identity_unavailable"),
    tokens: Object.fromEntries(TOKEN_CATEGORIES.map(category => [category, category === "input" ? metric(input, "usage_missing") : category === "output" ? metric(output, "usage_missing") : metric(spend.map(() => null), "usage_missing")])) as AnalyticsGroup["tokens"],
  };
}

describe("cost buckets", () => {
  const from = Date.UTC(2026, 10, 25, 10, 30);
  const to = from + 3 * HOUR;
  const report = {
    window: { from, to, bucket: "hour" as const, timezone: "UTC" as const, field: "generationStartedAt" as const },
    byTime: [group(new Date(Date.UTC(2026, 10, 25, 11)).toISOString(), [0.01, 0.02]), group(new Date(Date.UTC(2026, 10, 25, 13)).toISOString(), [null]), group(null, [0.5])],
  } satisfies Pick<CostAnalyticsReport, "window" | "byTime">;

  test("lists every bucket of the window, marks the partial edges and keeps unknown apart from zero", () => {
    const buckets = costBuckets(report, "estimatedUsd");
    expect(buckets.map(bucket => new Date(bucket.start).toISOString())).toEqual([
      "2026-11-25T10:00:00.000Z", "2026-11-25T11:00:00.000Z", "2026-11-25T12:00:00.000Z", "2026-11-25T13:00:00.000Z"]);
    expect(buckets.map(bucket => bucket.partial)).toEqual([true, false, false, true]);
    expect(buckets.map(bucket => bucket.spend)).toEqual([0, 0.03, 0, null]);
    expect(buckets.map(bucket => bucket.calls)).toEqual([0, 2, 0, 1]);
    expect(buckets[3]).toMatchObject({ spendUnknown: 1, inputTokens: 10 });
  });

  test("day buckets are titled by their UTC date", () => {
    expect(costBucketTitle({ start: Date.UTC(2026, 10, 24), end: Date.UTC(2026, 10, 25) }, "day")).toBe("Tue 24 Nov (UTC)");
  });
});

describe("tiles and copy", () => {
  test("a window with no calls is a known zero; any unknown call makes the total incomparable", () => {
    expect(comparableTotal(metric([]))).toBe(0);
    expect(comparableTotal(metric([0.1, 0.2]))).toBeCloseTo(0.3);
    expect(comparableTotal(metric([0.1, null]))).toBeNull();
  });

  test("deltas say which way and by how much, and need both windows", () => {
    expect(totalDelta(0.3, 0.1, "cost")).toMatchObject({ text: "+$0.200", direction: "up" });
    expect(totalDelta(5, 10, "count")).toMatchObject({ text: "−50%", direction: "down", label: "Down 50% from the previous window" });
    expect(totalDelta(1200, 0, "count")).toMatchObject({ text: "+1,200" });
    expect(totalDelta(2, 2, "count")).toMatchObject({ text: "±0%", direction: "flat" });
    expect(totalDelta(null, 2, "count")).toBeNull();
  });

  test("coverage lines count calls in plain English", () => {
    expect(coverage(metric([]), "priced")).toBe("No model calls in this window");
    expect(coverage(metric([0.1, 0.2]), "priced")).toBe("All 2 calls priced");
    expect(coverage(metric([0.1]), "priced")).toBe("The 1 call priced");
    expect(coverage(metric([0.1, null, null]), "priced")).toBe("1 of 3 calls priced");
    expect(coverage(metric([null, null]), "reported a cost")).toBe("None of 2 calls reported a cost");
    expect(tokenCoverage(metric([3, null]))).toBe("1 of 2 calls without a count");
    expect(tokenCoverage(metric([3, 4]))).toBe("From 2 calls");
    expect(metricText(metric([null]), "cost")).toBe("—");
    expect(metricText(metric([0.00275]), "cost")).toBe("$0.0028");
    expect(metricText(metric([54_820]), "tokens")).toBe("54.8K");
  });

  test("unknown reasons read as sentences, most common first", () => {
    const value = { ...metric([null, null, null]), unavailableReasons: { provider_unresolved: 1, rate_identity_unavailable: 2 } };
    expect(reasonLines(value)).toEqual([{ text: "no known price for the model", count: 2 }, { text: "provider unclear, or a reseller with its own prices", count: 1 }]);
  });

  test("the population is described without internal vocabulary, mentioning only what applies", () => {
    expect(populationSentences({ selectedGenerations: 3, nestedExcluded: 0, ancestryUnavailable: 0, untimedGenerations: 0, outsideWindow: 4, acquiredSpans: 9 }))
      .toEqual(["3 model calls started in this window and are counted."]);
    const lines = populationSentences({ selectedGenerations: 3, nestedExcluded: 2, ancestryUnavailable: 1, untimedGenerations: 1, outsideWindow: 0, acquiredSpans: 9 });
    expect(lines).toHaveLength(4);
    expect(lines.join(" ")).not.toMatch(/generation|ancestry|candidate/i);
  });

  test("money ticks drop the trailing zeros of amounts", () => {
    expect([0, 0.005, 0.01, 0.025, 1.5, 12_000].map(moneyTick)).toEqual(["$0", "$0.005", "$0.01", "$0.025", "$1.5", "$12K"]);
  });
});

describe("model rows", () => {
  test("rank by spend with unknown spend last, and share the known total", () => {
    const rows = modelRows({ byModel: [group("cheap", [0.01, 0.01]), group("unpriced", [null]), group("dear", [0.06]), group(null, [0.02])] }, "estimatedUsd");
    expect(rows.map(row => row.model)).toEqual(["dear", "cheap", null, "unpriced"]);
    expect(rows.map(row => formatShare(row.share))).toEqual(["60%", "20%", "20%", "—"]);
    expect(rows[1]).toMatchObject({ calls: 2, inputTokens: 20, outputTokens: 4, spendUnknown: 0 });
    expect(formatShare(0.0004)).toBe("<0.1%");
  });
});
