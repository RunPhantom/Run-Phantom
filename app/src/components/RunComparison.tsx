import { useEffect, useId, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { apiJson } from "../api/request";
import { cn } from "@/lib/utils";
import type { ComparisonField, ComparisonFieldName, ComparisonRow, ComparisonSpanLink, ComparisonValue, RunComparison as Comparison } from "../../../src/run-comparison-protocol";
import { DEFINITION_COMPONENTS, type CapturedAgentDefinition, type CapturedAgentDefinitions } from "../../../src/agent-definitions-protocol";
import styles from "./RunComparison.module.css";

const labels: Record<ComparisonFieldName, string> = { name: "Name", span_type: "Span kind", status: "Status", model: "Model", provider: "Provider",
  input_payload: "Input", output_payload: "Output", duration_ms: "Duration (ms)", input_tokens: "Input tokens", output_tokens: "Output tokens" };
const buttonClass = "min-h-8 rounded-control border border-rp-line bg-white px-2.5 text-xs font-medium text-rp-ink transition-[background-color,border-color] duration-250 ease-standard hover:border-rp-wash-border hover:bg-rp-wash";
const stateTone = (state: string) => state === "changed" ? "text-rp-blue" : state === "ambiguous" || state === "unavailable" ? "text-rp-warning" : "text-rp-ink";
const componentLabels = { prompt: "Prompt", tools: "Tools", model: "Model", providers: "Providers", runtime: "Runtime" };
const reasonLabels: Record<CapturedAgentDefinition["reasons"][number], string> = { capture_missing: "Capture missing", capture_unavailable: "Capture unavailable", capture_ambiguous: "Capture ambiguous", capture_invalid: "Capture invalid", capture_partial: "Capture partial", capture_redacted: "Capture redacted", capture_oversized: "Capture oversized", source_receipt_missing: "Original source receipt unavailable", source_receipt_loss: "Original source receipt has loss", source_identity_unavailable: "Source span identity unavailable" };
function DefinitionRecord({ record, side, runId }: { record: CapturedAgentDefinition; side: "baseline" | "candidate"; runId: string }) {
  return <details className={styles.record} data-definition-record>
    <summary className={styles.summary}><span className={record.complete ? styles.complete : styles.partial}>{record.complete ? "Complete capture" : "Partial capture"}</span>
      <span className={styles.id}>{record.sourceSpanId ?? "Source unavailable"}</span></summary>
    <div className={styles.body}>
      <p>{record.provenance === "explicit-v1" ? "Explicit v1 capture" : "Legacy observed attributes"}</p>
      <p className={styles.id}>{record.semanticVersion}</p>
      <dl className={styles.hashes}>
        <div><dt>Version</dt><dd><code data-definition-hash="version">{record.sha256 ?? "Unavailable"}</code></dd></div>
        {DEFINITION_COMPONENTS.map(component => <div key={component}><dt>{componentLabels[component]}</dt><dd>
          <code data-definition-hash={component}>{record.components[component].sha256 ?? `Unavailable · ${record.components[component].status}`}</code>
        </dd></div>)}
      </dl>
      {record.reasons.length > 0 && <ul className={styles.reasons}>{record.reasons.map(reason => <li key={reason}>{reasonLabels[reason]}</li>)}</ul>}
      {record.sourceSpanId && <a className={styles.source} target="_blank" rel="noreferrer" aria-label={`Open ${side} definition source span in a new tab`}
        href={`/runs/${encodeURIComponent(runId)}/span/${encodeURIComponent(record.sourceSpanId)}`}>Open captured span ↗</a>}
    </div>
  </details>;
}
function DefinitionSide({ records, side, runId }: { records: CapturedAgentDefinitions | null; side: "baseline" | "candidate"; runId: string }) {
  return <article className={styles.side} data-definition-side={side}><h4>{side === "baseline" ? "Baseline" : "Candidate"}</h4>
    {records?.records.length ? records.records.map((record, index) => <DefinitionRecord key={record.sourceSpanId ?? `unavailable-${index}`} record={record} side={side} runId={runId} />)
      : <p className={styles.hint}>Definition capture unavailable</p>}
    {!!records?.omittedRecords && <p className={styles.hint}>{records.omittedRecords} definition records omitted by the retained metadata limit.</p>}
    {!!records?.unavailableAttributes && <p className={styles.hint}>{records.unavailableAttributes} span attribute captures unavailable.</p>}
  </article>;
}
function Definitions({ comparison }: { comparison: Comparison }) {
  const evidence = comparison.agentDefinitions;
  if (!evidence) return null;
  const a = evidence.baseline?.records, b = evidence.candidate?.records;
  // A single complete configuration on each side can be compared. Multiple
  // captured sources remain separate records; equal hashes do not pair runs.
  const comparable = evidence.baseline?.complete && evidence.candidate?.complete && a?.length === 1 && b?.length === 1;
  const changed = comparable ? DEFINITION_COMPONENTS.filter(key => a[0].components[key].sha256 !== b[0].components[key].sha256).map(key => componentLabels[key]) : [];
  return <section className={styles.definitions} aria-label="Captured agent definitions">
    <h3 className={styles.title}>Captured definitions</h3>
    <p className={styles.hint}>Safe configuration hashes from captured span evidence. Partial captures retain unavailable versions.</p>
    <p className={styles.result}>{comparable ? a[0].sha256 === b[0].sha256 ? "Same captured configuration" : "Captured configuration changed" : "Complete configuration comparison unavailable"}</p>
    {changed.length > 0 && <p className={styles.hint}>Changed components: {changed.join(", ")}</p>}
    <div className={styles.sides}><DefinitionSide records={evidence.baseline} side="baseline" runId={comparison.baseline.id} />
      <DefinitionSide records={evidence.candidate} side="candidate" runId={comparison.candidate.id} /></div>
  </section>;
}
function Evidence({ evidence }: { evidence: ComparisonValue }) {
  if (evidence.unavailable) return <span className="text-rp-ink-muted">Unavailable · {evidence.unavailable}</span>;
  return <><pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-rp-ink">{String(evidence.value)}</pre>
    {evidence.previewTruncated && <span className="text-[11px] text-rp-ink-muted">Preview shortened; equality uses the complete captured field.</span>}</>;
}
function SpanLinks({ links, side }: { links: ComparisonSpanLink[]; side: "Baseline" | "Candidate" }) {
  return <div className="min-w-0 space-y-1"><span className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-rp-ink-muted">{side} · {links.length}</span>
    {links.length ? links.map(item => <a key={item.id} href={item.href} target="_blank" rel="noreferrer" aria-label={`Open ${side.toLowerCase()} span ${item.name} in a new tab`}
      className="block break-all text-xs font-medium text-rp-blue underline-offset-4 transition-colors duration-250 ease-standard hover:text-rp-blue-hover hover:underline">{item.name || item.id} <span className="font-mono text-[10px] font-normal text-rp-ink-muted">({item.id}) ↗</span></a>)
      : <p className="text-xs text-rp-ink-muted">No matched captured span</p>}</div>;
}
function FieldRow({ field }: { field: ComparisonField }) {
  return <div className="grid min-w-0 gap-2 border-t border-rp-line-muted py-2 sm:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)]" data-comparison-field={field.name}>
    <div className="text-[12px]"><span className="font-medium text-rp-ink">{labels[field.name]}</span><span className={cn("ml-1 sm:ml-0 sm:block", field.state === "changed" ? "text-rp-blue" : "text-rp-ink-muted")}>{field.state}</span>
      {field.delta !== null && field.delta !== 0 && <span className="block font-mono text-rp-ink-muted">Δ {field.delta > 0 ? "+" : ""}{field.delta}</span>}</div>
    <div className="min-w-0"><span className="text-[11px] text-rp-ink-muted sm:hidden">Baseline</span><Evidence evidence={field.baseline} /></div>
    <div className="min-w-0"><span className="text-[11px] text-rp-ink-muted sm:hidden">Candidate</span><Evidence evidence={field.candidate} /></div>
  </div>;
}
function Difference({ row }: { row: ComparisonRow }) {
  const fields = row.fields.filter(item => item.state !== "same");
  return <details className="rounded-sm border border-rp-line bg-rp-surface" data-comparison-row={row.state}>
    <summary className="rp-disclosure cursor-pointer rounded-sm px-3 py-2.5 text-xs transition-colors duration-250 ease-standard hover:bg-rp-row-hover">
      <span className={cn("font-mono text-[11px] font-medium uppercase tracking-[0.08em]", stateTone(row.state))}>{row.state}</span>
      <span className="ml-2 break-all font-mono text-rp-ink">{row.baseline[0]?.name || row.candidate[0]?.name || "Captured spans"}</span>
      {row.reordered && <span className="ml-2 text-rp-ink-muted">order changed</span>}
      {row.match && <span className="ml-2 text-[11px] text-rp-ink-muted">{row.match}</span>}
      {row.state === "ambiguous" && <span className="ml-2 text-rp-ink-muted">{row.baseline.length} baseline · {row.candidate.length} candidate spans</span>}
    </summary>
    <div className="space-y-3 px-3 pb-3">
      {row.reason && <p className="text-xs text-rp-ink-muted">{row.reason}</p>}
      <div className="grid gap-3 sm:grid-cols-2"><SpanLinks links={row.baseline} side="Baseline" /><SpanLinks links={row.candidate} side="Candidate" /></div>
      {fields.map(field => <FieldRow key={field.name} field={field} />)}
      {row.fields.length > 0 && <details><summary className="rp-disclosure cursor-pointer py-1 text-[12px] font-medium text-rp-blue">All captured field comparisons</summary>
        {row.fields.filter(field => field.state === "same").map(field => <FieldRow key={field.name} field={field} />)}</details>}
    </div>
  </details>;
}

/** This is a local, read-only inspector. Team code must use its authenticated API. */
export function RunComparison({ baselineRunId, candidateRunId }: { baselineRunId: string; candidateRunId: string }) {
  const [params, setParams] = useSearchParams();
  const expanded = params.get("debugCompare") === "1";
  const rawOffset = params.get("debugOffset") ?? "0";
  const offset = /^\d{1,4}$/.test(rawOffset) && Number(rawOffset) <= 4000 ? Number(rawOffset) : 0;
  const [revision, setRevision] = useState(0);
  const [response, setResponse] = useState<{ key: string; data?: Comparison; error?: string } | null>(null);
  const panelId = useId();
  const key = JSON.stringify([baselineRunId, candidateRunId, offset, revision]);
  const current = response?.key === key ? response : null;
  const setOffset = (next: number) => setParams(previous => { const value = new URLSearchParams(previous); value.set("debugOffset", String(next)); return value; });
  useEffect(() => {
    if (!expanded) return;
    const abort = new AbortController();
    const query = new URLSearchParams({ baseline: baselineRunId, candidate: candidateRunId, offset: String(offset), limit: "25" });
    void apiJson<Comparison>(`/api/runs/compare?${query}`, { signal: abort.signal }).then(data => {
      if (!abort.signal.aborted) setResponse({ key, data });
    }).catch(error => { if (!abort.signal.aborted) setResponse({ key, error: error instanceof Error ? error.message : "Comparison could not be loaded." }); });
    return () => abort.abort();
  }, [baselineRunId, candidateRunId, offset, expanded, key]);
  return <section aria-label="Captured run comparison" className="min-h-0 flex-shrink-0 border-b border-rp-line bg-rp-surface text-rp-ink" style={{ maxHeight: expanded ? "55%" : undefined, overflow: "auto" }}>
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-1">
      <button type="button" aria-expanded={expanded} aria-controls={panelId} className="flex min-h-8 items-center gap-1.5 rounded-control px-1 text-[12px] font-medium text-rp-ink transition-colors duration-250 ease-standard hover:text-rp-blue"
        onClick={() => setParams(previous => { const value = new URLSearchParams(previous); if (expanded) { value.delete("debugCompare"); value.delete("debugOffset"); } else value.set("debugCompare", "1"); return value; })}>
        {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}Compare captured changes
      </button>
      {expanded && <button type="button" aria-label="Refresh comparison" className="grid min-h-8 min-w-8 place-items-center rounded-control text-rp-ink-muted transition-colors duration-250 ease-standard hover:bg-rp-row-hover hover:text-rp-ink" onClick={() => setRevision(value => value + 1)}><RefreshCw className="size-3.5" /></button>}
    </div>
    {expanded && <div id={panelId} className="rp-fade-rise space-y-3 px-4 pb-4">
      {!current && <p role="status" className="rp-eyebrow">Comparing captured evidence…</p>}
      {current?.error && <div role="alert" className="space-y-2 rounded-sm border border-rp-danger-border bg-rp-danger-soft p-3 text-xs text-rp-danger"><p>Comparison unavailable. {current.error}</p>
        <button type="button" className={buttonClass} onClick={() => setRevision(value => value + 1)}>Retry comparison</button></div>}
      {current?.data && <>
        <div className="grid gap-2 text-xs sm:grid-cols-2">
          {(["baseline", "candidate"] as const).map(side => <a key={side} href={current.data![side].href} target="_blank" rel="noreferrer" className="min-w-0 break-all font-medium text-rp-blue underline-offset-4 transition-colors duration-250 ease-standard hover:text-rp-blue-hover hover:underline">
            {side === "baseline" ? "Baseline" : "Candidate"}: {current.data![side].name} · {current.data![side].spanCount} spans ↗</a>)}
        </div>
        <dl className="flex flex-wrap gap-x-4 gap-y-2 text-xs" aria-label="Comparison counts">
          {(["changed", "unchanged", "added", "removed", "ambiguous", "unavailable"] as const).map(state => <div key={state} className="flex items-baseline gap-1.5"><dt className="capitalize text-rp-ink-muted">{state}</dt><dd className="font-mono font-medium tabular-nums text-rp-ink" data-comparison-count={state}>{current.data!.counts[state]}</dd></div>)}
        </dl>
        <p className="text-[12px] text-rp-ink-muted">{current.data.counts.paired} paired spans · ambiguous spans: {current.data.counts.ambiguousBaselineSpans} baseline / {current.data.counts.ambiguousCandidateSpans} candidate · {current.data.counts.unavailableFields} unavailable field comparisons</p>
        <p className="text-[12px] text-rp-ink-muted">Exact captured text comparison. Links open the original evidence in a new tab.</p>
        {current.data.warnings.map(warning => <p key={warning} className="text-[12px] text-rp-ink-muted">{warning}</p>)}
        <Definitions comparison={current.data} />
        {current.data.rows.length ? <div className="space-y-2">{current.data.rows.map(row => <Difference key={row.id} row={row} />)}</div>
          : <p className="rounded-sm border border-dashed border-rp-line-dashed px-3 py-4 text-center text-xs text-rp-ink-muted">No comparison rows on this page. Empty evidence cannot establish equivalence.</p>}
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] tabular-nums text-rp-ink-muted">
          <button type="button" disabled={offset === 0} className={`${buttonClass} disabled:opacity-40`} onClick={() => setOffset(Math.max(0, offset - 25))}>Previous differences</button>
          <span>{current.data.rows.length ? offset + 1 : 0}–{Math.min(offset + current.data.rows.length, current.data.totalRows)} of {current.data.totalRows}</span>
          <button type="button" disabled={current.data.nextOffset === null} className={`${buttonClass} disabled:opacity-40`} onClick={() => { if (current.data?.nextOffset !== null && current.data?.nextOffset !== undefined) setOffset(current.data.nextOffset); }}>Next differences</button>
        </div>
      </>}
    </div>}
  </section>;
}
