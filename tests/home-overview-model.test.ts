import { describe, expect, test } from "bun:test";
import type { Overview, OverviewBucket } from "../app/src/api/overview";
import {
  bucketClock, failureOnset, formatRate, headlineParts, headlineText, isWorkspaceEmpty, kpiDelta, kpiSeries, runsLink, sumKnown,
} from "../app/src/pages/overview/home-model";
import { splitUnit } from "../app/src/pages/overview/HomeKpis";
import { ModelsPanel, activityItems } from "../app/src/pages/overview/HomePanels";
import { createRequire } from "node:module";
import type { LatestRunRow, OverviewLiveRun } from "../app/src/api/overview";
import { sampleOverview } from "../app/src/pages/overview/sample-overview";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 25, 18, 0, 0);

function bucket(index: number, runs: number, failed = 0, completedWithErrors = 0, finished = runs): OverviewBucket {
  const start = NOW - 24 * HOUR + index * HOUR;
  return { start, end: start + HOUR, partial: false, runs, finished, failed, completedWithErrors, inputTokens: runs * 10, outputTokens: runs, tokenUnknownCalls: 0, costUsd: runs ? runs * 0.01 : 0, costUnknownCalls: 0, durationP95Ms: runs ? 1000 : null };
}

function overview(patch: { runs: number; failed?: number; withErrors?: number; running?: number; interrupted?: number; cancelled?: number; unknown?: number; buckets?: OverviewBucket[]; window?: Overview["window"]["selection"] }): Overview {
  const base = sampleOverview(NOW);
  return {
    ...base,
    window: { ...base.window, selection: patch.window ?? "24h" },
    kpis: {
      ...base.kpis,
      runs: { value: patch.runs, previous: 0 },
      failed: { value: patch.failed ?? 0, previous: 0 },
      completedWithErrors: { value: patch.withErrors ?? 0, previous: 0 },
      running: { value: patch.running ?? 0, previous: 0 },
      interrupted: { value: patch.interrupted ?? 0, previous: 0 },
      cancelled: { value: patch.cancelled ?? 0, previous: 0 },
      unknown: { value: patch.unknown ?? 0, previous: 0 },
      completed: { value: patch.runs - (patch.failed ?? 0) - (patch.withErrors ?? 0) - (patch.running ?? 0) - (patch.interrupted ?? 0) - (patch.cancelled ?? 0) - (patch.unknown ?? 0), previous: 0 },
    },
    timeseries: patch.buckets ?? [bucket(0, patch.runs, patch.failed, patch.withErrors)],
  };
}

describe("Home headline", () => {
  test("states runs, failures and errors with digits marked for Inter", () => {
    const parts = headlineParts(overview({ runs: 21, failed: 3, withErrors: 4 }));
    expect(headlineText(parts)).toBe("21 runs in the last 24 hours. 3 failed. 4 more finished with errors.");
    expect(parts.filter(part => part.digits).map(part => part.text)).toEqual(["21", "3", "4"]);
    expect(parts.some(part => part.tone === "danger" && part.text === "3")).toBe(true);
  });

  test("says when failures cluster late in the window", () => {
    const buckets = Array.from({ length: 24 }, (_, index) => bucket(index, 5, index >= 13 ? 1 : 0));
    const text = headlineText(headlineParts(overview({ runs: 120, failed: 11, buckets }), "UTC"));
    expect(text).toBe(`120 runs in the last 24 hours. 11 failed, all since ${bucketClock(buckets[13].start, "24h", "UTC")}.`);
  });

  test("handles the quiet cases truthfully", () => {
    expect(headlineText(headlineParts(overview({ runs: 0 })))).toBe("No runs in the last 24 hours.");
    expect(headlineText(headlineParts(overview({ runs: 1 })))).toBe("1 run in the last 24 hours. None failed.");
    expect(headlineText(headlineParts(overview({ runs: 2, running: 2 })))).toBe("2 runs in the last 24 hours. 2 still running.");
    expect(headlineText(headlineParts(overview({ runs: 6, withErrors: 2, window: "1h" })))).toBe("6 runs in the last hour. None failed; 2 finished with errors.");
  });

  test("names interrupted runs instead of calling them running or finished", () => {
    expect(headlineText(headlineParts(overview({ runs: 3, interrupted: 3 })))).toBe("3 runs in the last 24 hours. 3 were interrupted.");
    expect(headlineText(headlineParts(overview({ runs: 4, failed: 1, running: 1, interrupted: 1 })))).toBe("4 runs in the last 24 hours. 1 failed. 1 still running. 1 was interrupted.");
  });

  test("accounts for every run, cancelled and unknown included", () => {
    expect(headlineText(headlineParts(overview({ runs: 3, cancelled: 3 })))).toBe("3 runs in the last 24 hours. 3 were cancelled.");
    expect(headlineText(headlineParts(overview({ runs: 19, failed: 4, withErrors: 3, running: 1, interrupted: 2, cancelled: 1, unknown: 1 }))))
      .toBe("19 runs in the last 24 hours. 4 failed. 3 more finished with errors. 1 still running. 2 were interrupted. 1 was cancelled. 1 has no recorded end.");
    expect(headlineText(headlineParts(overview({ runs: 2, unknown: 2 })))).toBe("2 runs in the last 24 hours. 2 have no recorded end.");
  });

  test("failure timing needs two or more late failures after earlier healthy runs", () => {
    const early = [bucket(0, 3, 2), bucket(1, 3)];
    expect(failureOnset(early, 2)).toBeNull();
    const single = Array.from({ length: 24 }, (_, index) => bucket(index, 2, index === 20 ? 1 : 0));
    expect(failureOnset(single, 1)).toBeNull();
    const late = Array.from({ length: 24 }, (_, index) => bucket(index, 2, index >= 20 ? 1 : 0));
    expect(failureOnset(late, 4)).toBe(late[20].start);
  });
});

describe("KPI deltas", () => {
  test("colour follows whether the direction is good for the measure", () => {
    expect(kpiDelta({ value: 0.12, previous: 0.1 }, "rate", "bad")).toMatchObject({ text: "+2 pts", tone: "bad", direction: "up" });
    expect(kpiDelta({ value: 9000, previous: 10300 }, "duration", "bad")).toMatchObject({ text: "−1.3s", tone: "good", direction: "down" });
    expect(kpiDelta({ value: 136, previous: 115 }, "count")).toMatchObject({ text: "+18%", tone: "neutral" });
    expect(kpiDelta({ value: 21, previous: 0 }, "count")).toMatchObject({ text: "+21" });
    expect(kpiDelta({ value: 7.45, previous: 6.25 }, "cost")).toMatchObject({ text: "+$1.20" });
  });

  test("an unknown side means no delta rather than a guess", () => {
    expect(kpiDelta({ value: 0.3, previous: null }, "rate", "bad")).toBeNull();
    expect(kpiDelta({ value: null, previous: 3 }, "count")).toBeNull();
  });

  test("rates and unit splits format for the tiles", () => {
    expect(formatRate(null)).toBe("—");
    expect(formatRate(1 / 3)).toBe("33%");
    expect(formatRate(0.055)).toBe("5.5%");
    expect(formatRate(0.0004)).toBe("<0.1%");
    expect(splitUnit("23.6s")).toEqual({ value: "23.6", unit: "s" });
    expect(splitUnit("72.6K")).toEqual({ value: "72.6", unit: "K" });
    expect(splitUnit("33%")).toEqual({ value: "33", unit: "%" });
    expect(splitUnit("1h 5m")).toEqual({ value: "1h 5m" });
    expect(splitUnit("—")).toEqual({ value: "—" });
    expect(sumKnown(null, null)).toBeNull();
    expect(sumKnown(5, null)).toBe(5);
  });

  test("sparkline series keep unknown buckets as gaps", () => {
    const series = kpiSeries([bucket(0, 0), { ...bucket(1, 4, 1, 1), costUsd: null }]);
    expect(series.errorRate).toEqual([null, 0.5]);
    expect(series.cost).toEqual([0, null]);
    expect(series.p95).toEqual([null, 1000]);
  });

  test("the error-rate series divides by finished runs, like the KPI", () => {
    const series = kpiSeries([bucket(0, 4, 1, 0, 2), bucket(1, 3, 0, 0, 0)]);
    expect(series.errorRate).toEqual([0.5, null]);
  });
});

describe("drill-down links and empty state", () => {
  test("links use the Runs page filter parameters", () => {
    expect(runsLink({})).toBe("/runs");
    expect(runsLink({ status: ["failed", "completed_with_errors"], window: "24h" })).toBe("/runs?status=failed%2Ccompleted_with_errors&window=24h");
    expect(runsLink({ agent: "support bot", window: "7d" })).toBe("/runs?agent=support+bot&window=7d");
    expect(runsLink({ model: "gpt-5-nano", since: 10, until: 20 })).toBe("/runs?model=gpt-5-nano&since=10&until=20");
    expect(runsLink({ window: "1h", since: 10, sort: "cost" })).toBe("/runs?window=1h&sort=cost");
    expect(runsLink({ agent: null, sort: "last_updated_at" })).toBe("/runs");
  });

  test("the teaching empty state shows only when nothing was ever captured", () => {
    const none = overview({ runs: 0 });
    none.kpis.runs.previous = 0;
    none.liveRuns = [];
    expect(isWorkspaceEmpty(none, 0)).toBe(true);
    expect(isWorkspaceEmpty(none, 12)).toBe(false);
    expect(isWorkspaceEmpty(none, null)).toBe(false);
    expect(isWorkspaceEmpty(undefined, 0)).toBe(false);
    expect(isWorkspaceEmpty(overview({ runs: 3 }), 0)).toBe(false);
  });
});

describe("latest activity", () => {
  const row = (id: string) => ({ id, last_updated_at: 0 }) as unknown as LatestRunRow;
  const live = (runId: string): OverviewLiveRun => ({ runId, name: runId, agent: null, startedAt: 0, lastUpdatedAt: 0, spanCount: 2, model: null });

  test("running runs come first, then the newest finished runs, without duplicates, up to the limit", () => {
    const items = activityItems([row("a"), row("b"), row("c"), row("d")], [live("old-running"), live("b")], 4);
    expect(items.map(item => item.id)).toEqual(["old-running", "b", "a", "c"]);
    expect(items[0].live?.runId).toBe("old-running");
    expect(items[1].run?.id).toBe("b");
  });

  test("with nothing running it is the newest runs as listed", () => {
    expect(activityItems([row("a"), row("b")], [], 8).map(item => item.id)).toEqual(["a", "b"]);
  });
});

test("kpi series carry the partial flag of each bucket", () => {
  const buckets = [bucket(0, 2), { ...bucket(1, 1), partial: true }];
  expect(kpiSeries(buckets).partial).toEqual([false, true]);
});

describe("Models panel", () => {
  const appRequire = createRequire(new URL("../app/package.json", import.meta.url));
  const { renderToStaticMarkup } = appRequire("react-dom/server");
  const { createElement } = appRequire("react");
  const { MemoryRouter } = appRequire("react-router-dom");

  test("adds + only to a token total that has a known part", () => {
    const base = sampleOverview(NOW);
    const row = base.byModel[0];
    const byModel = [
      { ...row, model: "mixed-model", inputTokens: 100, outputTokens: 20, tokenUnknownCalls: 1 },
      { ...row, model: "silent-model", inputTokens: null, outputTokens: null, tokenUnknownCalls: 1, calls: 1 },
    ];
    const html: string = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ModelsPanel, { overview: { ...base, byModel } })));
    expect(html).toContain("120+");
    expect(html).not.toContain("—+");
    expect(html).toContain("1 of 1 call did not report tokens");
  });
});
