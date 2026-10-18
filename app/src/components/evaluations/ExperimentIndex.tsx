import { useState } from "react";
import type { ExperimentSummary } from "../../api/evaluations";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Field, Select } from "../verification/PredicateEditor";

const PAGE_SIZE = 8;
export function ExperimentIndex({ experiments, selectedId, onOpen }: { experiments: ExperimentSummary[]; selectedId: string; onOpen: (id: string) => void }) {
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
  function reset() { setQuery(""); setOutcome("all"); setPage(0); }
  return <div className="evaluation-experiment-index">
    <div className="evaluation-index-filters">
      <Field label="Search experiments"><Input type="search" placeholder="Experiment or dataset name" value={query} maxLength={256} onChange={event => { setQuery(event.target.value); setPage(0); }} /></Field>
      <Field label="Experiment outcome"><Select value={outcome} onChange={event => { setOutcome(event.target.value); setPage(0); }}><option value="all">All outcomes</option><option value="pass">Passed</option><option value="fail">Failed</option><option value="inconclusive">Inconclusive</option><option value="active">Queued or running</option><option value="cancelled">Cancelled</option></Select></Field>
      {(query || outcome !== "all") && <Button variant="ghost" onClick={reset}>Clear filters</Button>}
    </div>
    <p className="evaluation-meta" role="status">{filtered.length} matching {filtered.length === 1 ? "experiment" : "experiments"} in the newest {experiments.length} saved. Up to 50 experiments are listed.</p>
    {!filtered.length ? <div className="evaluation-empty"><p>No experiments match these filters.</p><Button variant="outline" onClick={reset}>Show all experiments</Button></div> : <>
      <div className="evaluation-table-scroll" role="region" aria-label="Experiment list" tabIndex={0}>
        <table className="evaluation-experiment-table"><caption className="sr-only">Saved experiments with their frozen dataset, execution state and original automatic verdict.</caption>
          <thead><tr><th scope="col">Experiment</th><th scope="col">Dataset</th><th scope="col">Automatic result</th><th scope="col">Cases passed</th></tr></thead>
          <tbody>{filtered.slice(start, start + PAGE_SIZE).map(item => <tr key={item.id} data-selected={selectedId === item.id}>
            <th scope="row"><button type="button" className="evaluation-experiment-name" aria-label={`Open experiment ${item.name}`} aria-pressed={selectedId === item.id} onClick={() => onOpen(item.id)}>{item.name}</button><span className="evaluation-meta evaluation-execution-state">{item.status}</span></th>
            <td><span className="evaluation-dataset-name">{item.datasetName}</span><span className="evaluation-meta">Revision {item.datasetVersion}</span></td>
            <td><span className="evaluation-outcome" data-outcome={item.verdict ?? "pending"}>{item.status === "cancelled" ? "Cancelled" : item.verdict ?? "Not finished"}</span></td>
            <td className="evaluation-numeric">{item.summary.pass} / {item.summary.total}<span className="evaluation-meta">{item.summary.inconclusive} inconclusive</span></td>
          </tr>)}</tbody>
        </table>
      </div>
      {filtered.length > PAGE_SIZE && <div className="evaluation-pagination"><p className="evaluation-meta">{start + 1}–{Math.min(start + PAGE_SIZE, filtered.length)} of {filtered.length}</p><div><Button variant="outline" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous experiments</Button><Button variant="outline" disabled={start + PAGE_SIZE >= filtered.length} onClick={() => setPage(currentPage + 1)}>Next experiments</Button></div></div>}
    </>}
  </div>;
}
