import { useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { evaluationsApi, type ExperimentSummary } from "../../api/evaluations";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Field, Select } from "./field";
import { PassRate } from "./EvaluationOverview";
import { previousComparable } from "./overview-model";

const PAGE_SIZE = 8;
export type ChangeFilter = "regression" | "improvement";
export interface ComparisonRequest { baseline: string; candidate: string; filter: ChangeFilter | "all"; nonce: number }

const statusLabel = { queued: "Queued", running: "Running", completed: "Finished", cancelled: "Cancelled" } as const;

export function ExperimentIndex({ experiments, selectedId, onOpen, onCompare }: { experiments: ExperimentSummary[]; selectedId: string; onOpen: (id: string) => void; onCompare?: (baseline: string, candidate: string, filter: ChangeFilter) => void }) {
  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState("all");
  const [page, setPage] = useState(0);
  const needle = query.trim().toLocaleLowerCase();
  const filtered = experiments.filter(item => (!needle || `${item.name} ${item.datasetName}`.toLocaleLowerCase().includes(needle))
    && (outcome === "all" || outcome === "active" && ["queued", "running"].includes(item.status)
      || outcome === "cancelled" && item.status === "cancelled"
      || outcome !== "active" && outcome !== "cancelled" && item.status === "completed" && item.verdict === outcome));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  const start = currentPage * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);
  const pairs = visible.map(item => ({ item, previous: previousComparable(item, experiments) }));
  const comparisons = useQueries({ queries: pairs.map(({ item, previous }) => ({
    queryKey: ["evaluations", "compare", previous?.id ?? "", item.id],
    queryFn: () => evaluationsApi.compare(previous!.id, item.id),
    enabled: !!previous, staleTime: Infinity, retry: false,
  })) });
  function reset() { setQuery(""); setOutcome("all"); setPage(0); }
  return <div className="evaluation-experiment-index">
    <div className="evaluation-index-filters">
      <Field label="Search experiments"><Input type="search" placeholder="Experiment or dataset name" value={query} maxLength={256} onChange={event => { setQuery(event.target.value); setPage(0); }} /></Field>
      <Field label="Experiment outcome"><Select value={outcome} onChange={event => { setOutcome(event.target.value); setPage(0); }}><option value="all">All outcomes</option><option value="pass">Passed</option><option value="fail">Failed</option><option value="inconclusive">Inconclusive</option><option value="active">Queued or running</option><option value="cancelled">Cancelled</option></Select></Field>
      {(query || outcome !== "all") && <Button variant="ghost" onClick={reset}>Clear filters</Button>}
    </div>
    <p className="evaluation-meta" role="status">{filtered.length} of the newest {experiments.length} {experiments.length === 1 ? "experiment" : "experiments"}{experiments.length >= 50 ? " (the list shows up to 50)" : ""}.</p>
    {!filtered.length ? <div className="evaluation-empty"><p>No experiments match these filters.</p><Button variant="outline" onClick={reset}>Show all experiments</Button></div> : <>
      <div className="evaluation-table-scroll" role="region" aria-label="Experiment list" tabIndex={0}>
        <table className="evaluation-experiment-table"><caption className="sr-only">Experiments with their dataset, result, pass rate and changes against the previous finished experiment on the same dataset revision.</caption>
          <thead><tr><th scope="col">Experiment</th><th scope="col">Dataset</th><th scope="col">Result</th><th scope="col">Pass rate</th><th scope="col" title="Cases that changed against the previous finished experiment on the same dataset revision">Since previous</th></tr></thead>
          <tbody>{pairs.map(({ item, previous }, index) => {
            const comparison = comparisons[index];
            return <tr key={item.id} data-selected={selectedId === item.id}>
              <th scope="row"><button type="button" className="evaluation-experiment-name" aria-label={`Open experiment ${item.name}`} aria-pressed={selectedId === item.id} onClick={() => onOpen(item.id)}>{item.name}</button><span className="evaluation-meta evaluation-execution-state">{statusLabel[item.status]}</span></th>
              <td><span className="evaluation-dataset-name">{item.datasetName}</span><span className="evaluation-meta">Revision {item.datasetVersion}</span></td>
              <td><span className="evaluation-outcome" data-outcome={item.verdict ?? "pending"}>{item.status === "cancelled" ? "Cancelled" : item.verdict ?? "Not finished"}</span></td>
              <td>{item.status === "completed" || item.status === "cancelled" ? <PassRate experiment={item} /> : <span className="evaluation-meta">Not finished</span>}{item.summary.inconclusive > 0 && <span className="evaluation-meta">{item.summary.inconclusive} inconclusive</span>}</td>
              <td>{!previous ? <span className="evaluation-meta" title="No earlier finished experiment uses this dataset revision.">—</span>
                : comparison.isError ? <span className="evaluation-meta" title={comparison.error.message}>Not comparable</span>
                  : !comparison.data ? <span className="evaluation-meta">Comparing…</span>
                    : <span className="evaluation-change-counts">
                      <ChangeButton count={comparison.data.summary.regressions} kind="regression" against={previous.name} onClick={() => onCompare?.(previous.id, item.id, "regression")} />
                      <ChangeButton count={comparison.data.summary.improvements} kind="improvement" against={previous.name} onClick={() => onCompare?.(previous.id, item.id, "improvement")} />
                    </span>}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      {filtered.length > PAGE_SIZE && <div className="evaluation-pagination"><p className="evaluation-meta">{start + 1}–{Math.min(start + PAGE_SIZE, filtered.length)} of {filtered.length}</p><div><Button variant="outline" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous experiments</Button><Button variant="outline" disabled={start + PAGE_SIZE >= filtered.length} onClick={() => setPage(currentPage + 1)}>Next experiments</Button></div></div>}
    </>}
  </div>;
}

function ChangeButton({ count, kind, against, onClick }: { count: number; kind: ChangeFilter; against: string; onClick: () => void }) {
  const noun = kind === "regression" ? count === 1 ? "regression" : "regressions" : count === 1 ? "improvement" : "improvements";
  if (!count) return <span className="evaluation-change" data-kind={kind} data-zero>0 {noun}</span>;
  return <button type="button" className="evaluation-change" data-kind={kind} aria-label={`Show ${count} ${noun} against ${against}`} onClick={onClick}>{count} {noun}</button>;
}
