import { describe, expect, test } from "bun:test";
import { datasetRows, passRateBins, percent, previousComparable } from "../app/src/components/evaluations/overview-model";
import type { Dataset, ExperimentSummary } from "../src/evaluations/protocol";

function experiment(id: string, overrides: Partial<ExperimentSummary> = {}): ExperimentSummary {
  return {
    evaluationVersion: 1, snapshotVersion: 1, id, name: id, datasetId: "d1", datasetName: "Checkout", datasetVersion: 2, datasetHash: "h2",
    status: "completed", verdict: "pass", createdAt: 1_000, completedAt: 1_500,
    summary: { total: 4, pass: 4, fail: 0, inconclusive: 0, passRate: 1 }, error: null, ...overrides,
  };
}
const dataset = (id: string): Dataset => ({ id, name: id, latestVersion: 2, caseCount: 4, createdAt: 0 });

describe("evaluation overview model", () => {
  test("joins each dataset with its newest experiment and newest finished experiment", () => {
    const rows = datasetRows([dataset("d1"), dataset("d2")], [
      experiment("old", { createdAt: 100 }),
      experiment("running", { createdAt: 300, status: "running", verdict: null }),
      experiment("finished", { createdAt: 200 }),
    ]);
    expect(rows[0]).toMatchObject({ experimentCount: 3, latest: { id: "running" }, latestCompleted: { id: "finished" } });
    expect(rows[1]).toMatchObject({ experimentCount: 0, latest: null, latestCompleted: null });
  });

  test("compares only with the previous finished experiment on the same dataset revision", () => {
    const list = [
      experiment("a", { createdAt: 100 }),
      experiment("other-revision", { createdAt: 150, datasetVersion: 1, datasetHash: "h1" }),
      experiment("cancelled", { createdAt: 160, status: "cancelled" }),
      experiment("b", { createdAt: 200 }),
      experiment("c", { createdAt: 300 }),
    ];
    expect(previousComparable(list[4], list)?.id).toBe("b");
    expect(previousComparable(list[3], list)?.id).toBe("a");
    expect(previousComparable(list[0], list)).toBeNull();
    expect(previousComparable(experiment("live", { status: "running", createdAt: 400 }), list)).toBeNull();
  });

  test("skips older experiments graded with a different evaluation or snapshot version", () => {
    const list = [
      experiment("a", { createdAt: 100 }),
      experiment("old-evaluator", { createdAt: 200, evaluationVersion: 0 as unknown as 1 }),
      experiment("old-snapshot", { createdAt: 250, snapshotVersion: 0 as unknown as 1 }),
      experiment("c", { createdAt: 300 }),
    ];
    expect(previousComparable(list[3], list)?.id).toBe("a");
    expect(previousComparable(list[1], list)).toBeNull();
  });

  test("bins finished pass rates into ten buckets with 100% in the last one", () => {
    const bins = passRateBins([
      experiment("all", { summary: { total: 2, pass: 2, fail: 0, inconclusive: 0, passRate: 1 } }),
      experiment("none", { summary: { total: 2, pass: 0, fail: 2, inconclusive: 0, passRate: 0 } }),
      experiment("third", { summary: { total: 3, pass: 1, fail: 2, inconclusive: 0, passRate: 1 / 3 } }),
      experiment("running", { status: "running" }),
      experiment("empty", { summary: { total: 0, pass: 0, fail: 0, inconclusive: 0, passRate: 0 } }),
    ]);
    expect(bins).toHaveLength(10);
    expect(bins.map(bin => bin.count)).toEqual([1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
    expect(passRateBins([experiment("running", { status: "running" })])).toEqual([]);
  });

  test("formats pass rates to one decimal place", () => {
    expect(percent(1 / 3)).toBe("33.3%");
    expect(percent(1)).toBe("100%");
  });
});
