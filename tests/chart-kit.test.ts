import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import {
  areaPath, binValues, chartKeyStep, columnPath, compact, endpointIndices, linePath, linear, nearestPoint, niceTicks, relativeTimeLabel, slotAt, trendWord,
} from "../app/src/components/charts/scale";
import { ChartFrame } from "../app/src/components/charts/ChartFrame";
import { BarList, CellBar } from "../app/src/components/charts/BarList";
import { Sparkline } from "../app/src/components/charts/Sparkline";
import { StackedBars, stackReadout } from "../app/src/components/charts/StackedBars";
import { TimeSeries, seriesReadout } from "../app/src/components/charts/TimeSeries";
import { Histogram } from "../app/src/components/charts/Histogram";

const appRequire = createRequire(new URL("../app/package.json", import.meta.url));
const { renderToStaticMarkup } = appRequire("react-dom/server");
const { createElement } = appRequire("react");

describe("chart scales", () => {
  test("linear maps a domain onto a range and collapses a zero-width domain", () => {
    const scale = linear([0, 10], [100, 0]);
    expect(scale(0)).toBe(100);
    expect(scale(5)).toBe(50);
    expect(linear([3, 3], [10, 20])(99)).toBe(10);
  });

  test("ticks stay within the three-gridline budget and cover the maximum", () => {
    for (const max of [0.07, 1, 3, 7, 21, 99, 1_234, 23_611, 4_900_000]) {
      const ticks = niceTicks(max);
      expect(ticks[0]).toBe(0);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max);
      expect(ticks.length).toBeLessThanOrEqual(4);
    }
    expect(niceTicks(21)).toEqual([0, 10, 20, 30]);
    expect(niceTicks(0)).toEqual([0, 1]);
  });

  test("integer ticks never split a count", () => {
    expect(niceTicks(7, 3, true)).toEqual([0, 5, 10]);
    expect(niceTicks(1, 3, true)).toEqual([0, 1]);
    expect(niceTicks(3, 3, true)).toEqual([0, 1, 2, 3]);
  });

  test("compact numbers are in full under 10,000 and compact above", () => {
    expect(compact(9_866)).toBe("9,866");
    expect(compact(20_058)).toBe("20.1K");
    expect(compact(3_400_000)).toBe("3.4M");
    expect(compact(Number.NaN)).toBe("—");
  });

  test("endpoint-only x axes label the first, middle and last positions", () => {
    expect(endpointIndices(0)).toEqual([]);
    expect(endpointIndices(1)).toEqual([0]);
    expect(endpointIndices(25)).toEqual([0, 12, 24]);
    const now = 1_000_000_000;
    expect(relativeTimeLabel(now - 86_400_000, now)).toBe("24h ago");
    expect(relativeTimeLabel(now - 3_600_000, now)).toBe("1h ago");
    expect(relativeTimeLabel(now - 30 * 86_400_000, now)).toBe("30d ago");
    expect(relativeTimeLabel(now - 10_000, now)).toBe("now");
  });

  test("hit testing snaps to slots and points and clamps at the edges", () => {
    expect(slotAt(-5, 240, 24)).toBe(0);
    expect(slotAt(25, 240, 24)).toBe(2);
    expect(slotAt(999, 240, 24)).toBe(23);
    expect(nearestPoint(119, 240, 3)).toBe(1);
    expect(nearestPoint(0, 0, 1)).toBe(0);
  });

  test("lines and areas break at unknown values instead of drawing them as zero", () => {
    const points = [{ x: 0, y: 10 }, { x: 10, y: 5 }, null, { x: 30, y: 2 }, { x: 40, y: 1 }];
    expect(linePath(points)).toBe("M0,10L10,5M30,2L40,1");
    expect(areaPath(points, 20)).toBe("M0,20L0,10L10,5L10,20ZM30,20L30,2L40,1L40,20Z");
  });

  test("columns round only the data end and skip empty columns", () => {
    expect(columnPath(0, 0, 10, 0, 2)).toBe("");
    const path = columnPath(0, 10, 10, 30, 2);
    expect(path.startsWith("M0,40V12Q0,10 2,10")).toBe(true);
    expect(path.endsWith("V40Z")).toBe(true);
  });

  test("trend words compare the latest value with the rest", () => {
    expect(trendWord([1, 1, 1, 3])).toBe("rising");
    expect(trendWord([5, 5, 5, 1])).toBe("falling");
    expect(trendWord([2, 2, 2, 2])).toBe("flat");
    expect(trendWord([null, 4])).toBeNull();
  });

  test("chart keys step through buckets, jump to the ends and leave other keys alone", () => {
    expect(chartKeyStep("ArrowRight", null, 5)).toBe(4);
    expect(chartKeyStep("ArrowLeft", null, 5, "first")).toBe(0);
    expect(chartKeyStep("ArrowRight", 4, 5)).toBe(4);
    expect(chartKeyStep("ArrowLeft", 0, 5)).toBe(0);
    expect(chartKeyStep("ArrowLeft", 3, 5)).toBe(2);
    expect(chartKeyStep("Home", 3, 5)).toBe(0);
    expect(chartKeyStep("End", 0, 5)).toBe(4);
    expect(chartKeyStep("Escape", 2, 5)).toBeNull();
    expect(chartKeyStep("Tab", 2, 5)).toBeUndefined();
    expect(chartKeyStep("ArrowRight", null, 0)).toBeUndefined();
  });

  test("histogram bins cover every value once", () => {
    const bins = binValues([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3);
    expect(bins.map(bin => bin.count)).toEqual([3, 3, 4]);
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(10);
    expect(binValues([4, 4, 4])).toEqual([{ from: 4, to: 4, count: 3 }]);
    expect(binValues([])).toEqual([]);
  });
});

describe("chart components", () => {
  test("a chart frame names its image with the summary and offers the table view", () => {
    const html = renderToStaticMarkup(createElement(ChartFrame, {
      summary: "Runs per hour: 21 in total.",
      table: { caption: "Runs per hour", columns: ["Time", "Runs"], rows: [["13:00–14:00", 21]] },
      legend: [{ label: "No errors", color: "red" }, { label: "Failed", color: "blue" }],
    }, createElement("svg"))) as string;
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Runs per hour: 21 in total."');
    expect(html).toContain("View as table");
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("No errors");
  });

  test("a sparkline carries its trend sentence as the accessible name", () => {
    const html = renderToStaticMarkup(createElement(Sparkline, { values: [1, 2, 3], label: "Runs trend: rising" })) as string;
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Runs trend: rising"');
  });

  test("cell bars scale to the maximum and draw nothing for zero", () => {
    expect(renderToStaticMarkup(createElement(CellBar, { value: 5, max: 10 }))).toContain("width:50%");
    expect(renderToStaticMarkup(createElement(CellBar, { value: 0, max: 10 }))).toContain("width:0%");
    expect(renderToStaticMarkup(createElement(CellBar, { value: 1, max: 0 }))).toContain("width:0%");
  });
});

const render = (type: unknown, props: Record<string, unknown>) => renderToStaticMarkup(createElement(type, props)) as string;
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("interactive charts", () => {
  const series = [
    { id: "ok", label: "No errors", color: "green" },
    { id: "failed", label: "Failed", color: "red" },
  ];
  const buckets = [
    { key: 1, title: "12:00–13:00", values: [3, 1] },
    { key: 2, title: "13:00–14:00", values: [0, 0] },
    { key: 3, title: "14:00–15:00", values: [2, 2], partial: true, notes: ["40 tokens"] },
  ];

  test("a chart frame leaves naming to an interactive chart instead of hiding it inside role=img", () => {
    const html = render(ChartFrame, {
      interactive: true,
      summary: "Runs per hour: 8 in total.",
      table: { caption: "Runs per hour", columns: ["Time", "Runs"], rows: [] },
      children: createElement(StackedBars, { label: "Runs per hour: 8 in total.", buckets, series, axisLabels: () => "", width: 300, height: 160 }),
    });
    expect(html).not.toContain('role="img"');
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-roledescription="chart"');
    expect(html).toContain('aria-label="Runs per hour: 8 in total."');
  });

  test("stacked bars are focusable, describe their keys and carry a polite live readout", () => {
    const html = render(StackedBars, { label: "Runs", buckets, series, axisLabels: (index: number) => `t${index}`, width: 300, height: 160, onActivate: () => {}, activateHint: "Click to open these runs" });
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("press Enter to open its runs");
    expect(html).toMatch(/aria-describedby="[^"]+"/);
  });

  test("stacked bars draw the partial bucket lighter and skip zero segments", () => {
    const html = render(StackedBars, { label: "Runs", buckets, series, axisLabels: () => "", width: 300, height: 160 });
    expect(count(html, 'data-partial="true"')).toBe(1);
    expect(html).toContain('opacity="0.55"');
    expect(count(html, "<path")).toBe(4);
    expect(count(html, "<text")).toBeGreaterThanOrEqual(3);
  });

  test("an empty stacked chart says so and takes no focus stop", () => {
    const html = render(StackedBars, { label: "Runs", buckets: [], series, axisLabels: () => "", width: 300, height: 160, emptyLabel: "No runs in the last hour" });
    expect(html).toContain('tabindex="-1"');
    const zero = render(StackedBars, { label: "Runs", buckets: [buckets[1]], series, axisLabels: () => "", width: 300, height: 160, emptyLabel: "No runs in the last hour" });
    expect(zero).toContain("No runs in the last hour");
  });

  test("the stacked readout reads every series, the partial note and the Enter hint", () => {
    expect(stackReadout(buckets[2], series, "Press Enter to open these runs"))
      .toBe("14:00–15:00: No errors 2, Failed 2. Partial: only part of this span is in the window. 40 tokens. Press Enter to open these runs.");
    expect(stackReadout(buckets[0], series)).toBe("12:00–13:00: No errors 3, Failed 1.");
  });

  test("a time series breaks its line at unknown values and draws partial points hollow", () => {
    const html = render(TimeSeries, {
      label: "p95 duration by hour",
      series: [{ id: "p95", label: "p95", color: "blue", values: [1, 2, null, 4, 5] }],
      titles: ["a", "b", "c", "d", "e"],
      axisLabels: (index: number) => `x${index}`,
      partial: [false, false, false, false, true],
      width: 320,
      height: 160,
      area: true,
    });
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="p95 duration by hour"');
    const line = /<path d="([^"]+)" fill="none" stroke="blue"/.exec(html)?.[1] ?? "";
    expect(count(line, "M")).toBe(2);
    expect(html).toContain('fill="var(--rp-surface)" stroke="blue"');
    expect(html).toContain("x0");
    expect(html).toContain("x2");
    expect(html).toContain("x4");
    expect(html).not.toContain(">x1<");
  });

  test("the time-series readout says unknown rather than zero", () => {
    const line = [{ id: "a", label: "Runs", color: "blue", values: [1, null] }, { id: "b", label: "Failed", color: "red", values: [0, 0] }];
    expect(seriesReadout("13:00", line, 1, String)).toBe("13:00: Runs unknown, Failed 0.");
    expect(seriesReadout("14:00", line, 0, String, true)).toBe("14:00: Runs 1, Failed 0. Partial: only part of this span is in the window.");
  });

  test("a histogram labels only the range ends and draws one column per bin", () => {
    const html = render(Histogram, {
      label: "Run durations",
      bins: binValues([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3),
      formatValue: (value: number) => `${value}s`,
      unitLabel: "runs",
      width: 300,
      height: 160,
    });
    expect(html).toContain('aria-label="Run durations"');
    expect(html).toContain(">1s<");
    expect(html).toContain(">10s<");
    expect(count(html, 'fill="var(--rp-chart-1)"')).toBe(3);
  });
});

describe("sparkline gaps and partial buckets", () => {
  test("null values break the line instead of dropping to zero", () => {
    const html = render(Sparkline, { values: [1, 2, null, 4, 5], label: "Runs", width: 100 });
    const history = /<path d="([^"]+)" fill="none" stroke="var\(--rp-chart-history\)"/.exec(html)?.[1] ?? "";
    expect(count(history, "M")).toBe(2);
  });

  test("a trailing partial bucket is dashed and hollow, and the emphasis stays on the last full bucket", () => {
    const html = render(Sparkline, { values: [4, 4, 4, 1], partial: [false, false, false, true], label: "Runs", width: 100 });
    expect(count(html, "data-partial-segment")).toBe(1);
    expect(count(html, "data-partial-point")).toBe(1);
    const end = /<circle cx="([\d.]+)"[^>]*data-sparkline-end/.exec(html)?.[1];
    expect(Number(end)).toBeLessThan(90);
  });
});

describe("bar list links", () => {
  const { MemoryRouter } = appRequire("react-router-dom");

  test("rows a filter can select link to it; rows without a name are plain text", () => {
    const rows = [{ name: "triage", runs: 4 }, { name: null, runs: 2 }];
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(BarList, {
      caption: "Agents",
      rows,
      rowKey: (row: { name: string | null }) => row.name ?? "none",
      nameHeader: "Agent",
      name: (row: { name: string | null }) => row.name ?? "Unnamed agent",
      href: (row: { name: string | null }) => (row.name ? `/runs?agent=${row.name}` : undefined),
      bar: { header: "Runs", value: (row: { runs: number }) => row.runs },
      columns: [],
      emptyLabel: "None",
    }))) as string;
    expect(count(html, "<a ")).toBe(1);
    expect(html).toContain('href="/runs?agent=triage"');
    expect(html).toContain("Unnamed agent");
    expect(count(html, "cursor-pointer")).toBe(1);
  });
});
