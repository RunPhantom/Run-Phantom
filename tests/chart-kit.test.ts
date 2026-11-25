import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import {
  areaPath, binValues, columnPath, compact, endpointIndices, linePath, linear, nearestPoint, niceTicks, relativeTimeLabel, slotAt, trendWord,
} from "../app/src/components/charts/scale";
import { ChartFrame } from "../app/src/components/charts/ChartFrame";
import { CellBar } from "../app/src/components/charts/BarList";
import { Sparkline } from "../app/src/components/charts/Sparkline";

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
