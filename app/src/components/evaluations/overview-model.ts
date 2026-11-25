import type { Dataset, ExperimentSummary } from "../../../../src/evaluations/protocol";
import type { HistogramBin } from "../charts/scale";

export interface DatasetRow {
  dataset: Dataset;
  experimentCount: number;
  latest: ExperimentSummary | null;
  latestCompleted: ExperimentSummary | null;
}

const newestFirst = (a: ExperimentSummary, b: ExperimentSummary) => b.createdAt - a.createdAt || b.id.localeCompare(a.id);

/** Joins each dataset with the experiments listed for it. The experiment list is capped by the API, so counts describe that list only. */
export function datasetRows(datasets: readonly Dataset[], experiments: readonly ExperimentSummary[]): DatasetRow[] {
  return datasets.map(dataset => {
    const own = experiments.filter(item => item.datasetId === dataset.id).sort(newestFirst);
    return { dataset, experimentCount: own.length, latest: own[0] ?? null, latestCompleted: own.find(item => item.status === "completed") ?? null };
  });
}

/**
 * The completed experiment that ran immediately before `experiment` on the same dataset revision.
 * Only that pairing is comparable: the API rejects comparisons across revisions or evaluators.
 */
export function previousComparable(experiment: ExperimentSummary, experiments: readonly ExperimentSummary[]): ExperimentSummary | null {
  if (experiment.status !== "completed") return null;
  return experiments
    .filter(item => item.id !== experiment.id && item.status === "completed" && item.datasetId === experiment.datasetId
      && item.datasetVersion === experiment.datasetVersion && item.datasetHash === experiment.datasetHash
      && (item.createdAt < experiment.createdAt || item.createdAt === experiment.createdAt && item.id < experiment.id))
    .sort(newestFirst)[0] ?? null;
}

/** Ten equal 10-point bins of completed experiment pass rates; the last bin includes 100%. */
export function passRateBins(experiments: readonly ExperimentSummary[]): HistogramBin[] {
  const completed = experiments.filter(item => item.status === "completed" && item.summary.total > 0 && Number.isFinite(item.summary.passRate));
  if (!completed.length) return [];
  const bins = Array.from({ length: 10 }, (_, index) => ({ from: index * 10, to: (index + 1) * 10, count: 0 }));
  for (const item of completed) bins[Math.min(9, Math.floor(Math.max(0, Math.min(1, item.summary.passRate)) * 10))].count++;
  return bins;
}

export function percent(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}
