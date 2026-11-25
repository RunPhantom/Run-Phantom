import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../ui/button";
import { Eyebrow } from "../ui/typography";
import type { Dataset, ExperimentSummary } from "../../api/evaluations";
import { DatasetsTable, PassRateHistogram } from "./EvaluationOverview";

const HOUR = 3_600_000;

function sample(now: number): { datasets: Dataset[]; experiments: ExperimentSummary[] } {
  const datasets: Dataset[] = [
    { id: "sample-refunds", name: "Refund requests", latestVersion: 3, caseCount: 12, createdAt: now - 72 * HOUR },
    { id: "sample-orders", name: "Order status questions", latestVersion: 2, caseCount: 8, createdAt: now - 48 * HOUR },
    { id: "sample-tools", name: "Tool errors the agent should recover from", latestVersion: 1, caseCount: 5, createdAt: now - 20 * HOUR },
  ];
  const rates = [[11, 12], [12, 12], [7, 8], [8, 8], [3, 5], [4, 5], [10, 12], [6, 8]];
  const experiments = rates.map(([pass, total], index): ExperimentSummary => {
    const dataset = datasets[index % datasets.length];
    return {
      evaluationVersion: 1, snapshotVersion: 1, id: `sample-${index}`, name: `Sample experiment ${index + 1}`,
      datasetId: dataset.id, datasetName: dataset.name, datasetVersion: dataset.latestVersion, datasetHash: dataset.id,
      status: "completed", verdict: pass === total ? "pass" : "fail", createdAt: now - (index + 1) * 5 * HOUR, completedAt: now - (index + 1) * 5 * HOUR,
      summary: { total, pass, fail: total - pass, inconclusive: 0, passRate: pass / total }, error: null,
    };
  });
  return { datasets, experiments };
}

/** No datasets and no experiments: a faded, labelled sample of the page behind one setup card. */
export function EvaluationsEmptyState({ onCreate }: { onCreate: () => void }) {
  const preview = useMemo(() => sample(Date.now()), []);
  return <div className="evaluation-empty-state" data-evaluations-empty>
    <div aria-hidden="true" inert className="evaluation-ghost" data-evaluations-ghost>
      <p className="rp-type-eyebrow mb-2 text-rp-ink-subtle">Sample · not your data</p>
      <div className="evaluation-overview-grid">
        <section className="evaluation-panel"><div className="evaluation-panel-head"><h2>Datasets</h2></div><DatasetsTable datasets={preview.datasets} experiments={preview.experiments} selectedId="" onOpen={() => {}} /></section>
        <PassRateHistogram experiments={preview.experiments} />
      </div>
    </div>
    <div className="evaluation-empty-card-wrap">
      <section aria-labelledby="evaluations-get-started" className="evaluation-empty-card">
        <Eyebrow marker tone="accent">Get started</Eyebrow>
        <h2 id="evaluations-get-started" className="rp-type-headline mt-3 text-rp-ink">Check every change against runs you already captured.</h2>
        <p className="rp-type-prose mt-2 text-rp-ink-muted">A dataset holds test cases taken from real runs. Grade new runs against it and see which cases got better or worse.</p>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button onClick={onCreate}><Plus aria-hidden="true" />Create a dataset</Button>
          <span className="text-13 text-rp-ink-muted">or open a run and choose <strong className="font-medium text-rp-ink">Evaluate run</strong> from its menu. <Link to="/runs" className="text-rp-blue underline-offset-4 hover:underline">Go to Runs</Link></span>
        </div>
      </section>
    </div>
  </div>;
}
