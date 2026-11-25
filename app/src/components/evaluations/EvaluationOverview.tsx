import { CellBar, ChartFrame, Histogram } from "../charts";
import type { Dataset, ExperimentSummary } from "../../api/evaluations";
import { ago, plural, runDisplayName, runStatus } from "../../utils/helpers";
import type { Run } from "../../utils/types";
import { datasetRows, passRateBins, percent } from "./overview-model";

/** A run picker label that tells otherwise identical runs apart: name, model, outcome, age and id prefix. */
export function runOptionLabel(run: Run): string {
  return [runDisplayName(run), run.model, runStatus(run).label, ago(run.started_at), run.id.slice(0, 8)].filter(Boolean).join(" · ");
}

export function PassRate({ experiment }: { experiment: ExperimentSummary | null }) {
  if (!experiment) return <span className="evaluation-meta" title="No finished experiment uses this dataset yet.">—</span>;
  const { pass, total, passRate } = experiment.summary;
  return <span className="evaluation-pass-rate">
    <span className="evaluation-pass-rate-value">{percent(passRate)}<span className="evaluation-meta"> · {pass}/{total}</span></span>
    <CellBar value={passRate} max={1} />
  </span>;
}

export function DatasetsTable({ datasets, experiments, selectedId, onOpen }: { datasets: readonly Dataset[]; experiments: readonly ExperimentSummary[]; selectedId: string; onOpen: (id: string) => void }) {
  const rows = datasetRows(datasets, experiments);
  return <div className="evaluation-table-scroll" role="region" aria-label="Dataset list" tabIndex={0}>
    <table className="evaluation-experiment-table evaluation-dataset-table">
      <caption className="sr-only">Datasets with their case count, latest experiment and its pass rate.</caption>
      <thead><tr><th scope="col">Dataset</th><th scope="col" className="evaluation-numeric-head">Cases</th><th scope="col">Last experiment</th><th scope="col">Pass rate</th></tr></thead>
      <tbody>{rows.map(({ dataset, latest, latestCompleted, experimentCount }) => <tr key={dataset.id} data-selected={selectedId === dataset.id}>
        <th scope="row"><button type="button" className="evaluation-experiment-name" aria-label={`Open dataset ${dataset.name}`} aria-pressed={selectedId === dataset.id} onClick={() => onOpen(dataset.id)}>{dataset.name}</button><span className="evaluation-meta">Revision {dataset.latestVersion} · {plural(experimentCount, "experiment")}</span></th>
        <td className="evaluation-numeric">{dataset.caseCount}</td>
        <td>{latest ? <><span className="evaluation-dataset-name">{latest.name}</span><span className="evaluation-meta">{latest.status === "completed" ? "Finished" : latest.status === "cancelled" ? "Cancelled" : "Running"} {ago(latest.completedAt ?? latest.createdAt)}</span></> : <span className="evaluation-meta">Not run yet</span>}</td>
        <td><PassRate experiment={latestCompleted} /></td>
      </tr>)}</tbody>
    </table>
  </div>;
}

export function PassRateHistogram({ experiments }: { experiments: readonly ExperimentSummary[] }) {
  const bins = passRateBins(experiments);
  const finished = bins.reduce((sum, bin) => sum + bin.count, 0);
  const allPassed = bins.length ? bins[9].count : 0;
  const summary = finished ? `${plural(finished, "finished experiment")}; ${allPassed} passed every case.` : "No finished experiments yet.";
  const label = (from: number, to: number) => to === 100 ? `${from}–100%` : `${from}–${to - 1}%`;
  return <section aria-labelledby="evaluation-pass-rate-title" className="evaluation-panel evaluation-chart-panel">
    <ChartFrame
      interactive
      summary={summary}
      title={<><h2 id="evaluation-pass-rate-title">Pass rates</h2><p className="evaluation-meta">{finished ? summary : "Finished experiments appear here by pass rate."}</p></>}
      table={{ caption: "Finished experiments by pass rate", columns: ["Pass rate", "Experiments"], rows: bins.map(bin => [label(bin.from, bin.to), String(bin.count)]) }}
    >
      <Histogram label={`Pass rates. ${summary}`} bins={bins} unitLabel="experiments" height={128} formatValue={value => `${value}%`} emptyLabel="No finished experiments yet" />
    </ChartFrame>
  </section>;
}

export function EvaluationKpis({ datasets, experiments }: { datasets: readonly Dataset[]; experiments: readonly ExperimentSummary[] }) {
  const cases = datasets.reduce((sum, item) => sum + item.caseCount, 0);
  const finished = experiments.filter(item => item.status === "completed");
  const latest = [...finished].sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt))[0];
  const active = experiments.filter(item => item.status === "queued" || item.status === "running").length;
  const capped = experiments.length >= 50;
  const tiles = [
    { label: "Datasets", value: String(datasets.length), detail: `${plural(cases, "saved case")} in latest revisions` },
    { label: "Experiments", value: `${experiments.length}${capped ? "+" : ""}`, detail: active ? `${active} running now` : capped ? "Counting the newest 50" : `${finished.length} finished` },
    { label: "Latest pass rate", value: latest ? percent(latest.summary.passRate) : "—", detail: latest ? `${latest.name} · ${ago(latest.completedAt ?? latest.createdAt)}` : "No finished experiment yet" },
    { label: "Cases not graded", value: latest ? String(latest.summary.inconclusive) : "—", detail: latest ? "In the latest experiment" : "Shown after the first experiment" },
  ];
  return <dl className="evaluation-kpis" aria-label="Evaluation summary">{tiles.map(tile => <div key={tile.label} className="evaluation-kpi"><dt>{tile.label}</dt><dd className="evaluation-kpi-value">{tile.value}</dd><dd className="evaluation-kpi-detail" title={tile.detail}>{tile.detail}</dd></div>)}</dl>;
}
