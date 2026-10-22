import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Field, Select } from "../verification/PredicateEditor";
import { evaluationsApi, type DistributionRequest, type ExperimentSummary, type ScoreDistributionAnalysis } from "../../api/evaluations";
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
  const first = selected[0] ?? "";
  const frozen = useQuery({ queryKey: ["evaluations", "distribution-definition", first], queryFn: ({ signal }) => evaluationsApi.experiment(first, signal), enabled: mode === "check_score" && !!first });
  const choices = frozen.data?.results.flatMap(result => result.case.rules.map((rule, ruleIndex) => ({ key: JSON.stringify([result.caseId, ruleIndex]), caseId: result.caseId, ruleIndex, label: `${result.caseName} · Check ${ruleIndex + 1} · ${rule.kind === "rubric" ? "Model" : "Code"}` }))) ?? [];
  const check = choices.find(choice => choice.key === checkKey);
  const selector: DistributionRequest["selector"] | null = mode === "snapshot_metric" ? { kind: mode, metric } : check ? { kind: mode, caseId: check.caseId, ruleIndex: check.ruleIndex } : null;
  function invalidate() { generation.current++; active.current?.abort(); setBusy(false); setAnalysis(null); setError(""); }
  function toggle(id: string) { invalidate(); setSelected(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]); }
  async function analyze() {
    if (!selector || !selected.length || busy) return;
    const current = ++generation.current; active.current?.abort(); const controller = new AbortController(); active.current = controller;
    setBusy(true); setError(""); setAnalysis(null);
    try { const value = await evaluationsApi.analyzeDistribution({ experimentIds: selected, selector, direction, bins }, controller.signal); if (current === generation.current) setAnalysis(value); }
    catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : "Could not analyze frozen experiments."); }
    finally { if (current === generation.current) setBusy(false); }
  }
  function download() {
    if (!analysis) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(analysis)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "score-distribution.json"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  const label = (id: string) => experiments.find(item => item.id === id)?.name ?? id;
  const maximum = Math.max(1, ...(analysis?.overall.histogram.map(bin => bin.count) ?? []));
  return <section aria-label="Score distribution analysis" className="min-w-0 space-y-4 border-t border-[color:var(--rp-border)] pt-5">
    <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-sm font-semibold">Distributions and trends</h2><span className="text-xs text-[color:var(--rp-ink-soft)]">Frozen evidence · no reruns</span></div>
    <p className="max-w-3xl text-xs leading-relaxed text-[color:var(--rp-ink-soft)]">Select 1–20 finished experiments with identical case definitions and evaluators. Analyze one precise check or one captured metric. Unknown observations remain excluded, and automatic verdicts stay unchanged.</p>
    <details open><summary className="cursor-pointer text-xs font-medium">Choose experiments · {selected.length} of 20 selected</summary><div className="mt-3 space-y-3">
      <fieldset className="max-h-48 space-y-2 overflow-y-auto"><legend className="sr-only">Distribution experiments</legend>
        {!experiments.length && <p className="text-xs text-[color:var(--rp-ink-soft)]">Start an experiment to retain frozen results, or add a retained experiment ID below.</p>}
        {experiments.map(item => <label key={item.id} className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5 accent-[var(--rp-accent)]" checked={selected.includes(item.id)} disabled={!['completed','cancelled'].includes(item.status) || (!selected.includes(item.id) && selected.length >= 20)} onChange={() => toggle(item.id)} /><span className="break-all">{item.name} · r{item.datasetVersion} · {item.status}</span></label>)}
        {selected.filter(id => !experiments.some(item => item.id === id)).map(id => <label key={id} className="flex items-start gap-2 text-xs"><input type="checkbox" checked onChange={() => toggle(id)} /><span className="break-all">Retained experiment: {id}</span></label>)}
      </fieldset>
      <p className="text-xs text-[color:var(--rp-ink-soft)]">The list shows the latest 50 experiments. Selection order defines adjacent trends; it does not establish chronology or independent sampling.</p>
      <div className="flex flex-wrap items-end gap-2"><div className="min-w-0 flex-[1_1_220px]"><Field label="Retained experiment ID"><Input value={retainedId} maxLength={128} onChange={event => setRetainedId(event.target.value)} placeholder="Add an experiment outside the list" /></Field></div><Button size="sm" variant="outline" disabled={!retainedId.trim() || selected.includes(retainedId.trim()) || selected.length >= 20} onClick={() => { toggle(retainedId.trim()); setRetainedId(""); }}>Add experiment ID</Button></div>
    </div></details>
    <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Distribution source"><Select value={mode} onChange={event => { invalidate(); setMode(event.target.value as typeof mode); }}><option value="check_score">Check score</option><option value="snapshot_metric">Captured metric</option></Select></Field>
      {mode === "check_score" ? <Field label="Exact check"><Select value={check?.key ?? ""} onChange={event => { invalidate(); setCheckKey(event.target.value); }} disabled={!choices.length}><option value="">{first ? "Choose one check" : "Select an experiment first"}</option>{choices.map(choice => <option key={choice.key} value={choice.key}>{choice.label}</option>)}</Select></Field> : <Field label="Captured metric"><Select value={metric} onChange={event => { invalidate(); setMetric(event.target.value as typeof metric); }}>{Object.entries(metrics).map(([key, name]) => <option key={key} value={key}>{name} ({DISTRIBUTION_UNITS[key as typeof metric]})</option>)}</Select></Field>}
      <Field label="Numeric preference"><Select value={direction} onChange={event => { invalidate(); setDirection(event.target.value as typeof direction); }}><option value="none">No preference</option><option value="higher">Higher is preferred</option><option value="lower">Lower is preferred</option></Select></Field>
      <Field label="Histogram bins"><Input type="number" min={1} max={20} step={1} value={Number.isFinite(bins) ? bins : ""} onChange={event => { invalidate(); setBins(event.target.value === "" ? NaN : Number(event.target.value)); }} /></Field>
    </div>
    {mode === "check_score" && frozen.error && <p role="alert" className="text-xs text-[color:var(--rp-danger)]">{frozen.error.message}</p>}
    <Button disabled={!selected.length || !selector || !Number.isInteger(bins) || bins < 1 || bins > 20 || busy} onClick={() => void analyze()}>{busy ? "Analyzing frozen evidence…" : "Analyze distribution"}</Button>
    {error && <p role="alert" className="text-xs text-[color:var(--rp-danger)]">{error}</p>}
    {analysis && <div aria-label="Distribution results" className="min-w-0 space-y-4 text-xs">
      <p role="status">{analysis.experiments.length} selected experiments · {analysis.overall.population.finite} known / {analysis.overall.population.total} observations · {analysis.overall.population.excluded} excluded · {analysis.overall.population.zero} zero · {analysis.unit}</p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">{([['Mean',analysis.overall.mean],['Median',analysis.overall.median],['P90',analysis.overall.p90],['P95',analysis.overall.p95],['P99',analysis.overall.p99],['Minimum',analysis.overall.min],['Maximum',analysis.overall.max],['Sum',analysis.overall.sum]] as const).map(([name,value]) => <div key={name}><dt className="text-[color:var(--rp-ink-soft)]">{name}</dt><dd className="mt-1 break-all font-medium tabular-nums">{number(value)}{name === 'Sum' && analysis.overall.sumUnavailable === 'overflow' ? ' (overflow)' : ''}</dd></div>)}</dl>
      <p className="text-[color:var(--rp-ink-soft)]">Displayed numbers are rounded; the JSON download retains exact numeric values.</p>
      <figure aria-label="Numeric histogram" className="space-y-2"><figcaption className="font-medium">Histogram · {analysis.overall.histogram.length} actual bins</figcaption>{!analysis.overall.histogram.length ? <p>No finite observations. Statistics remain unavailable.</p> : <ol className="space-y-2">{analysis.overall.histogram.map((bin,index) => <li key={index} className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-center gap-3"><span className="break-all tabular-nums">[{number(bin.lower)}, {number(bin.upper)}{bin.upperInclusive ? ']' : ')'}</span><span className="h-2 bg-[color:var(--rp-surface)]" aria-hidden="true"><span className="block h-full bg-[color:var(--rp-accent)]" style={{width:`${bin.count/maximum*100}%`}} /></span><span className="tabular-nums">{bin.count}</span></li>)}</ol>}</figure>
      <div role="region" aria-label="Per-experiment statistics, scroll horizontally" tabIndex={0} className="max-w-full overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--rp-accent)]"><table className="w-full text-left"><caption className="mb-2 text-left font-medium">Per experiment · selection order</caption><thead><tr>{['Experiment','Known / total','Excluded','Mean','Median','Verdict'].map(heading => <th key={heading} className="whitespace-nowrap border-b border-[color:var(--rp-border)] px-2 py-2 font-medium first:pl-0">{heading}</th>)}</tr></thead><tbody>{analysis.experiments.map(item => <tr key={item.experimentId}><td className="min-w-28 max-w-48 break-words px-2 py-2 first:pl-0">{label(item.experimentId)}<span className="block text-[color:var(--rp-ink-soft)]">{item.status}</span></td><td className="px-2 py-2 tabular-nums">{item.stats.population.finite} / {item.stats.population.total}</td><td className="px-2 py-2">{item.stats.population.excluded}</td><td className="px-2 py-2">{number(item.stats.mean)}</td><td className="px-2 py-2">{number(item.stats.median)}</td><td className="px-2 py-2">{item.verdict ?? 'Unavailable'}</td></tr>)}</tbody></table></div>
      {!!analysis.trend.length && <ol aria-label="Adjacent numeric trends" className="space-y-2">{analysis.trend.map((item,index) => <li key={index} className="break-words">{label(item.from)} → {label(item.to)}: {number(item.delta)}{item.deltaUnavailable === 'overflow' ? ' (overflow)' : ''} · {item.change}{item.preference ? ` · ${item.preference} for the chosen numeric preference` : ''}</li>)}</ol>}
      <Button size="sm" variant="outline" onClick={download}>Download distribution JSON</Button>
      <details><summary className="cursor-pointer">Interpretation and limits</summary><ul className="mt-2 list-disc space-y-2 pl-4 text-[color:var(--rp-ink-soft)]">{analysis.limitations.map(text => <li key={text}>{text}</li>)}</ul></details>
    </div>}
  </section>;
}
