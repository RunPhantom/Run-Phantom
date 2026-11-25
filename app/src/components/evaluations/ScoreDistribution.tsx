import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DisabledReason, Field, Select } from "./field";
import { evaluationsApi, type DistributionRequest, type ExperimentSummary, type ScoreDistributionAnalysis } from "../../api/evaluations";
import { ChartFrame, Histogram } from "../charts";
import { DISTRIBUTION_UNITS } from "../../../../src/evaluations/aggregation-protocol";

const number = (value: number | null) => value === null ? "Unavailable" : new Intl.NumberFormat("en", { maximumFractionDigits: 6, ...(value !== 0 && (Math.abs(value) < .000001 || Math.abs(value) >= 1e9) ? { notation: "scientific" as const } : {}) }).format(value);
const metrics = { inputTokens: "Input tokens", outputTokens: "Output tokens", totalTokens: "Total tokens", durationMs: "Duration", costUsd: "Reported cost", toolCalls: "Tool calls" };

export function ScoreDistribution({ experiments }: { experiments: ExperimentSummary[] }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [retainedId, setRetainedId] = useState("");
  const [mode, setMode] = useState<"check_score" | "snapshot_metric">("check_score");
  const [checkKey, setCheckKey] = useState("");
  const [metric, setMetric] = useState<keyof typeof metrics>("totalTokens");
  const [direction, setDirection] = useState<DistributionRequest["direction"]>("none");
  const [bins, setBins] = useState(10);
  const [analysis, setAnalysis] = useState<ScoreDistributionAnalysis | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0), active = useRef<AbortController | null>(null);
  useEffect(() => () => { generation.current++; active.current?.abort(); }, []);
  const addIdReason = useId();
  const addIdBlocker = !retainedId.trim() ? "Paste an experiment ID to add it." : selected.includes(retainedId.trim()) ? "That experiment is already selected." : selected.length >= 20 ? "You can select up to 20 experiments." : null;
  const first = selected[0] ?? "";
  const frozen = useQuery({ queryKey: ["evaluations", "distribution-definition", first], queryFn: ({ signal }) => evaluationsApi.experiment(first, signal), enabled: mode === "check_score" && !!first });
  const choices = frozen.data?.results.flatMap(result => result.case.rules.map((rule, ruleIndex) => ({ key: JSON.stringify([result.caseId, ruleIndex]), caseId: result.caseId, ruleIndex, label: `${result.caseName} · Check ${ruleIndex + 1} · ${rule.kind === "rubric" ? "Model" : "Code"}` }))) ?? [];
  const check = choices.find(choice => choice.key === checkKey);
  const selector: DistributionRequest["selector"] | null = mode === "snapshot_metric" ? { kind: mode, metric } : check ? { kind: mode, caseId: check.caseId, ruleIndex: check.ruleIndex } : null;
  const reasonId = useId();
  const analyzeBlocker = !selected.length ? "Select at least one finished experiment." : !selector ? "Choose the check to chart." : !Number.isInteger(bins) || bins < 1 || bins > 20 ? "Use 1 to 20 histogram bins." : null;
  function invalidate() { generation.current++; active.current?.abort(); setBusy(false); setAnalysis(null); setError(""); }
  function toggle(id: string) { invalidate(); setSelected(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]); }
  async function analyze() {
    if (!selector || !selected.length || busy) return;
    const current = ++generation.current; active.current?.abort(); const controller = new AbortController(); active.current = controller;
    setBusy(true); setError(""); setAnalysis(null);
    try { const value = await evaluationsApi.analyzeDistribution({ experimentIds: selected, selector, direction, bins }, controller.signal); if (current === generation.current) setAnalysis(value); }
    catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : "Could not analyze these experiments."); }
    finally { if (current === generation.current) setBusy(false); }
  }
  function download() {
    if (!analysis) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(analysis)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "score-distribution.json"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  const label = (id: string) => experiments.find(item => item.id === id)?.name ?? id;
  return <section aria-label="Score distribution analysis" className="min-w-0 space-y-4">
    <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-sm font-semibold">Score distribution</h2></div>
    <p className="max-w-3xl text-xs leading-relaxed text-[color:var(--rp-ink-soft)]">Chart one check’s scores, or one measured value such as tokens or duration, across up to 20 finished experiments that share the same cases and rules. Runs without a value are left out.</p>
    <details open><summary className="rp-disclosure cursor-pointer text-xs font-medium">Choose experiments · {selected.length} of 20 selected</summary><div className="mt-3 space-y-3">
      <fieldset className="max-h-48 space-y-2 overflow-y-auto"><legend className="sr-only">Distribution experiments</legend>
        {!experiments.length && <p className="text-xs text-[color:var(--rp-ink-soft)]">Finished experiments appear here. You can also add an experiment by its ID below.</p>}
        {experiments.map(item => <label key={item.id} className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5 accent-[var(--rp-accent)]" checked={selected.includes(item.id)} disabled={!['completed','cancelled'].includes(item.status) || (!selected.includes(item.id) && selected.length >= 20)} onChange={() => toggle(item.id)} /><span className="break-all">{item.name} · r{item.datasetVersion} · {item.status}</span></label>)}
        {selected.filter(id => !experiments.some(item => item.id === id)).map(id => <label key={id} className="flex items-start gap-2 text-xs"><input type="checkbox" checked onChange={() => toggle(id)} /><span className="break-all">Experiment outside the list: {id}</span></label>)}
      </fieldset>
      <p className="text-xs text-[color:var(--rp-ink-soft)]">The list shows the newest 50 experiments. Trends compare experiments in the order you select them, not the order they ran.</p>
      <div className="flex flex-wrap items-end gap-2"><div className="min-w-0 flex-[1_1_220px]"><Field label="Experiment ID"><Input value={retainedId} maxLength={128} onChange={event => setRetainedId(event.target.value)} placeholder="Add an experiment outside the list" /></Field></div><Button size="sm" variant="outline" disabled={!!addIdBlocker} aria-describedby={addIdBlocker ? addIdReason : undefined} onClick={() => { toggle(retainedId.trim()); setRetainedId(""); }}>Add experiment ID</Button></div><DisabledReason id={addIdReason} reason={addIdBlocker} />
    </div></details>
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <Field label="Distribution source"><Select value={mode} onChange={event => { invalidate(); setMode(event.target.value as typeof mode); }}><option value="check_score">Check score</option><option value="snapshot_metric">Captured metric</option></Select></Field>
      <div className="min-w-0 sm:col-span-2">{mode === "check_score" ? <Field label="Exact check"><Select value={check?.key ?? ""} onChange={event => { invalidate(); setCheckKey(event.target.value); }} disabled={!choices.length}><option value="">{first ? "Choose one check" : "Select an experiment first"}</option>{choices.map(choice => <option key={choice.key} value={choice.key}>{choice.label}</option>)}</Select></Field> : <Field label="Captured metric"><Select value={metric} onChange={event => { invalidate(); setMetric(event.target.value as typeof metric); }}>{Object.entries(metrics).map(([key, name]) => <option key={key} value={key}>{name} ({DISTRIBUTION_UNITS[key as typeof metric]})</option>)}</Select></Field>}</div>
      <Field label="Better direction"><Select value={direction} onChange={event => { invalidate(); setDirection(event.target.value as typeof direction); }}><option value="none">No preference</option><option value="higher">Higher is preferred</option><option value="lower">Lower is preferred</option></Select></Field>
      <Field label="Histogram bins"><Input type="number" min={1} max={20} step={1} value={Number.isFinite(bins) ? bins : ""} onChange={event => { invalidate(); setBins(event.target.value === "" ? NaN : Number(event.target.value)); }} /></Field>
    </div>
    {mode === "check_score" && frozen.error && <p role="alert" className="text-xs text-[color:var(--rp-danger)]">{frozen.error.message}</p>}
    <div className="space-y-2"><Button disabled={!!analyzeBlocker || busy} aria-describedby={analyzeBlocker ? reasonId : undefined} onClick={() => void analyze()}>{busy ? "Analyzing…" : "Analyze distribution"}</Button><DisabledReason id={reasonId} reason={analyzeBlocker} /></div>
    {error && <p role="alert" className="text-xs text-[color:var(--rp-danger)]">{error}</p>}
    {analysis && <div aria-label="Distribution results" className="min-w-0 space-y-4 text-xs">
      <p role="status">{analysis.experiments.length} selected experiments · {analysis.overall.population.finite} known / {analysis.overall.population.total} observations · {analysis.overall.population.excluded} excluded · {analysis.overall.population.zero} zero · {analysis.unit}</p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">{([['Mean',analysis.overall.mean],['Median',analysis.overall.median],['P90',analysis.overall.p90],['P95',analysis.overall.p95],['P99',analysis.overall.p99],['Minimum',analysis.overall.min],['Maximum',analysis.overall.max],['Sum',analysis.overall.sum]] as const).map(([name,value]) => <div key={name}><dt className="text-[color:var(--rp-ink-soft)]">{name}</dt><dd className="rp-num mt-1 break-all text-[13px] font-medium">{number(value)}{name === 'Sum' && analysis.overall.sumUnavailable === 'overflow' ? ' (overflow)' : ''}</dd></div>)}</dl>
      <p className="text-[color:var(--rp-ink-soft)]">Displayed numbers are rounded; the JSON download retains exact numeric values.</p>
      <figure aria-label="Numeric histogram" className="space-y-2">{!analysis.overall.histogram.length ? <><p className="font-medium">Histogram</p><p>No values to chart. Every observation was missing or not a number.</p></> : <ChartFrame interactive summary={`Histogram of ${analysis.overall.population.finite} values in ${analysis.overall.histogram.length} bins.`} title={<span className="font-medium">Histogram · {analysis.overall.histogram.length} {analysis.overall.histogram.length === 1 ? "bin" : "bins"}</span>} table={{ caption: "Histogram bins", columns: ["Range", "Count"], rows: analysis.overall.histogram.map(bin => [`[${number(bin.lower)}, ${number(bin.upper)}${bin.upperInclusive ? "]" : ")"}`, String(bin.count)]) }}><Histogram label={`Histogram of ${analysis.overall.population.finite} values in ${analysis.overall.histogram.length} bins.`} bins={analysis.overall.histogram.map(bin => ({ from: bin.lower, to: bin.upper, count: bin.count }))} unitLabel="observations" height={140} formatValue={value => number(value)} /></ChartFrame>}</figure>
      <div role="region" aria-label="Per-experiment statistics, scroll horizontally" tabIndex={0} className="max-w-full overflow-x-auto"><table className="w-full text-left"><caption className="mb-2 text-left font-medium">Per experiment · selection order</caption><thead><tr>{['Experiment','Known / total','Excluded','Mean','Median','Verdict'].map(heading => <th key={heading} className="whitespace-nowrap border-b border-rp-line px-2 py-2 font-mono text-[10.5px] font-medium uppercase tracking-[0.1em] text-rp-ink-muted first:pl-0">{heading}</th>)}</tr></thead><tbody>{analysis.experiments.map(item => <tr key={item.experimentId}><td className="min-w-28 max-w-48 break-words px-2 py-2 first:pl-0">{label(item.experimentId)}<span className="block text-[color:var(--rp-ink-soft)]">{item.status}</span></td><td className="px-2 py-2 tabular-nums">{item.stats.population.finite} / {item.stats.population.total}</td><td className="px-2 py-2">{item.stats.population.excluded}</td><td className="px-2 py-2">{number(item.stats.mean)}</td><td className="px-2 py-2">{number(item.stats.median)}</td><td className="px-2 py-2">{item.verdict ?? 'Unavailable'}</td></tr>)}</tbody></table></div>
      {!!analysis.trend.length && <ol aria-label="Adjacent numeric trends" className="space-y-2">{analysis.trend.map((item,index) => <li key={index} className="break-words">{label(item.from)} → {label(item.to)}: {number(item.delta)}{item.deltaUnavailable === 'overflow' ? ' (overflow)' : ''} · {item.change}{item.preference ? ` · ${item.preference} for the chosen direction` : ''}</li>)}</ol>}
      <Button size="sm" variant="outline" onClick={download}>Download distribution JSON</Button>
      <details><summary className="rp-disclosure cursor-pointer">Interpretation and limits</summary><ul className="mt-2 list-disc space-y-2 pl-4 text-[color:var(--rp-ink-soft)]">{analysis.limitations.map(text => <li key={text}>{text}</li>)}</ul></details>
    </div>}
  </section>;
}
