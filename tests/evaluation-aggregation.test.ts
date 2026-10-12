import { describe, expect, test } from "bun:test";
import { computeScoreAggregates } from "../src/evaluations/aggregation";

describe("finite evaluation populations", () => {
  test("linear interpolation preserves even median and upper histogram membership", () => {
    const result = computeScoreAggregates([1, 3], 2);
    expect(result).toMatchObject({ sum: 4, mean: 2, median: 2, min: 1, max: 3, p90: 2.8, sumUnavailable: null, population: { total: 2, finite: 2, excluded: 0, zero: 0 } });
    expect(result.histogram).toEqual([{ lower: 1, upper: 2, upperInclusive: false, count: 1 }, { lower: 2, upper: 3, upperInclusive: true, count: 1 }]);
  });
  test("missing and invalid evidence stays excluded while actual zero remains known", () => {
    expect(computeScoreAggregates([0, null, undefined, "0", NaN, Infinity, -Infinity])).toMatchObject({ population: { total: 7, finite: 1, excluded: 6, zero: 1 }, sum: 0, mean: 0, median: 0, histogram: [{ lower: 0, upper: 0, upperInclusive: true, count: 1 }] });
    expect(computeScoreAggregates([])).toMatchObject({ population: { total: 0, finite: 0 }, sum: null, mean: null, median: null, sumUnavailable: "empty", histogram: [] });
    expect(computeScoreAggregates([null, "missing"])).toMatchObject({ population: { total: 2, excluded: 2 }, mean: null, median: null });
  });
  test("all-equal finite values use one honest bin without mutating the input", () => {
    const input = [3, 1, 3, 0];
    computeScoreAggregates(input);
    expect(input).toEqual([3, 1, 3, 0]);
    expect(computeScoreAggregates([5, 5, 5]).histogram).toEqual([{ lower: 5, upper: 5, upperInclusive: true, count: 3 }]);
  });
  test("extreme finite endpoints cannot manufacture infinite means or quantiles", () => {
    const largest = Number.MAX_VALUE;
    const same = computeScoreAggregates([largest, largest]);
    expect(same).toMatchObject({ mean: largest, median: largest, p99: largest, sum: null, sumUnavailable: "overflow" });
    const opposite = computeScoreAggregates([-largest, largest], 20);
    expect(opposite.mean).toBe(0);
    expect(opposite.median).toBe(0);
    expect(opposite.histogram.reduce((count, bin) => count + bin.count, 0)).toBe(2);
    expect(opposite.histogram[0].count).toBe(1);
    expect(opposite.histogram[19].count).toBe(1);
    for (const value of [opposite.mean, opposite.median, opposite.p90, opposite.p95, opposite.p99, ...opposite.histogram.flatMap(bin => [bin.lower, bin.upper])]) expect(Number.isFinite(value)).toBe(true);
  });
  test("small exhaustive populations reconcile known/excluded counts and finite ordering", () => {
    const domain: unknown[] = [-3, 0, 1, 3, null, "1"];
    for (const a of domain) for (const b of domain) for (const c of domain) {
      const values = [a, b, c], result = computeScoreAggregates(values, 4);
      const finite = values.filter((value): value is number => typeof value === "number");
      expect(result.population.total).toBe(result.population.finite + result.population.excluded);
      expect(result.histogram.reduce((sum, bin) => sum + bin.count, 0)).toBe(finite.length);
      if (finite.length) {
        expect(result.mean!).toBeGreaterThanOrEqual(result.min!);
        expect(result.mean!).toBeLessThanOrEqual(result.max!);
        expect(result.median!).toBeGreaterThanOrEqual(result.min!);
        expect(result.median!).toBeLessThanOrEqual(result.max!);
        expect(result.p90!).toBeLessThanOrEqual(result.p95!);
        expect(result.p95!).toBeLessThanOrEqual(result.p99!);
      }
    }
  });
  test("admission rejects excessive work and executes no accessor", () => {
    expect(() => computeScoreAggregates(Array(8001).fill(0))).toThrow("8,000");
    for (const bins of [0, 21, 1.5, NaN]) expect(() => computeScoreAggregates([], bins)).toThrow("bins");
    let reads = 0;
    const accessor = [1]; Object.defineProperty(accessor, "0", { get() { reads++; return 1; } });
    expect(() => computeScoreAggregates(accessor)).toThrow("accessors");
    expect(reads).toBe(0);
    expect(() => computeScoreAggregates(Array(1))).toThrow("holes");
    const extra = [1]; Object.assign(extra, { note: "extra" });
    expect(() => computeScoreAggregates(extra)).toThrow("unsupported");
    expect(computeScoreAggregates(Array(8000).fill(0)).population).toEqual({ total: 8000, finite: 8000, excluded: 0, zero: 8000 });
  });
});
