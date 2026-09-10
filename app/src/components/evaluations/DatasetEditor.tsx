import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Field, Select } from "../verification/PredicateEditor";
import { buildRule, emptyRule, ruleDraft, ruleLabel, RuleEditor, textareaClass } from "./RuleEditor";
import { ResponseSpanSelect, SnapshotPreview } from "./SnapshotPreview";
import { evaluationsApi, type DatasetRevision, type DatasetCaseDraft, type Snapshot } from "../../api/evaluations";
import { useRuns } from "../../hooks/use-runs";
import { runDisplayName } from "../../utils/helpers";

export function DatasetEditor({ revision, latestVersion, initialRunId, onSaved }: { revision: DatasetRevision; latestVersion: number; initialRunId: string; onSaved: (revision: DatasetRevision) => void }) {
  const runs = useRuns();
  const [cases, setCases] = useState<DatasetCaseDraft[]>(() => revision.cases.map(item => ({ id: item.id, name: item.name, ...(item.input === null ? {} : { input: item.input }), ...(item.sourceRunId ? { sourceRunId: item.sourceRunId } : {}), ...(item.sourceSpanId ? { sourceSpanId: item.sourceSpanId } : {}), tags: item.tags, rules: item.rules })));
  const [sourceRunId, setSourceRunId] = useState(initialRunId);
  const [sourceSpanId, setSourceSpanId] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [caseName, setCaseName] = useState("");
  const [tags, setTags] = useState("");
  const [overrideInput, setOverrideInput] = useState(false);
  const [input, setInput] = useState("");
  const [rules, setRules] = useState([emptyRule()]);
  const [editing, setEditing] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const historical = revision.version !== latestVersion;
  async function perform(operation: () => Promise<void>) { if (busy) return; setBusy(true); setError(""); try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update the dataset."); } finally { setBusy(false); } }
  function addCase() {
    setError("");
    try {
      if (!caseName.trim()) throw new Error("Case name is required.");
      if (!sourceRunId && !overrideInput) throw new Error("Choose a source run or explicitly provide reference input.");
      const next: DatasetCaseDraft = { ...(editing !== null && cases[editing].id ? { id: cases[editing].id } : {}), name: caseName.trim(), ...(sourceRunId ? { sourceRunId } : {}), ...(sourceSpanId ? { sourceSpanId } : {}), ...(overrideInput ? { input } : {}), tags: tags.split(",").map(value => value.trim()).filter(Boolean), rules: rules.map(buildRule) };
      setCases(previous => editing === null ? [...previous, next] : previous.map((item, index) => index === editing ? next : item));
      setDirty(true); setEditing(null); setCaseName(""); setTags(""); setRules([emptyRule()]); setNotice("Case added to the draft. Save a new revision to use it in an experiment.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not add case."); }
  }
  return <section aria-label="Dataset cases" className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">Cases · revision {revision.version}</h2><span className="text-xs text-[color:var(--rp-ink-muted)]">{cases.length} of 50 cases{dirty ? " · Unsaved changes" : ""}</span></div>
    {historical && <p className="text-xs text-[color:var(--rp-warning)]">This is an immutable historical revision. Select the latest revision to make changes.</p>}
    {error && <p role="alert" className="text-xs text-[color:var(--rp-danger)]">{error}</p>}
    {notice && <p role="status" className="text-xs text-[color:var(--rp-ink-soft)]">{notice}</p>}
    {!cases.length && <p className="text-xs text-[color:var(--rp-ink-soft)]">Add a captured example and explicit expectations to create your first regression case.</p>}
    <ol className="space-y-3">{cases.map((item, index) => <li key={item.id ?? index} className="space-y-2 border-b border-[color:var(--rp-border)] pb-3"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">{item.name}</h3><div className="flex gap-1"><Button variant="ghost" size="sm" disabled={historical || busy} aria-label={`Edit case ${item.name}`} onClick={() => { setEditing(index); setCaseName(item.name); setSourceRunId(item.sourceRunId ?? ""); setSourceSpanId(item.sourceSpanId ?? ""); setSnapshot(null); setOverrideInput(item.input !== undefined); setInput(item.input ?? ""); setTags(item.tags?.join(", ") ?? ""); setRules(item.rules.map(ruleDraft)); }}>Edit</Button><Button variant="ghost" size="sm" disabled={historical || busy} aria-label={`Remove case ${item.name}`} onClick={() => { setCases(previous => previous.filter((_, at) => at !== index)); setDirty(true); setEditing(null); }}>Remove</Button></div></div><ul className="space-y-1 text-xs text-[color:var(--rp-ink-soft)]">{item.rules.map((rule, at) => <li className="break-words" key={at}>{ruleLabel(rule)}</li>)}</ul></li>)}</ol>
    <fieldset disabled={busy || historical} className="space-y-4">
      <h3 className="text-sm font-medium">{editing === null ? "Create a case" : "Edit case"}</h3>
      <Field label="Source run"><Select value={sourceRunId} onChange={event => { setSourceRunId(event.target.value); setSourceSpanId(""); setSnapshot(null); }}><option value="">Manual reference input</option>{sourceRunId && !runs.data?.some(run => run.id === sourceRunId) && <option value={sourceRunId}>Run from link</option>}{runs.data?.map(run => <option key={run.id} value={run.id}>{runDisplayName(run)}</option>)}</Select></Field>
      {runs.isError && <p className="text-xs text-[color:var(--rp-danger)]">Captured run choices could not load.</p>}
      {sourceRunId && <><ResponseSpanSelect runId={sourceRunId} value={sourceSpanId} onChange={value => { setSourceSpanId(value); setSnapshot(null); }} /><Button variant="outline" onClick={() => void perform(async () => { setSnapshot(await evaluationsApi.snapshot(sourceRunId, sourceSpanId || undefined)); })}>Preview source</Button></>}
      {snapshot && <SnapshotPreview snapshot={snapshot} />}
      <Field label="Case name"><Input value={caseName} onChange={event => setCaseName(event.target.value)} maxLength={128} placeholder="Checkout result" /></Field>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={overrideInput} onChange={event => setOverrideInput(event.target.checked)} />Override reference input</label>
      {overrideInput && <Field label="Reference input" hint="Candidate input must match this exactly, except line endings. This is an explicit manual override."><textarea className={textareaClass} maxLength={16384} value={input} onChange={event => setInput(event.target.value)} /></Field>}
      <Field label="Tags (optional)" hint="Up to eight comma-separated tags."><Input value={tags} onChange={event => setTags(event.target.value)} /></Field>
      {rules.map((draft, index) => <RuleEditor key={index} index={index} draft={draft} onChange={value => setRules(previous => previous.map((item, at) => at === index ? value : item))} onRemove={rules.length > 1 ? () => setRules(previous => previous.filter((_, at) => at !== index)) : undefined} />)}
      <div className="flex flex-wrap gap-2"><Button variant="ghost" disabled={rules.length >= 8} onClick={() => setRules(previous => [...previous, emptyRule()])}>Add rule</Button><Button disabled={(!snapshot && !!sourceRunId && editing === null) || (cases.length >= 50 && editing === null)} onClick={addCase}>{editing === null ? "Add case" : "Update case draft"}</Button></div>
    </fieldset>
    <Button disabled={busy || historical || !dirty} onClick={() => void perform(async () => { const next = await evaluationsApi.saveRevision(revision.datasetId, revision.version, cases); onSaved(next); })}>Save new revision</Button>
    {busy && <p role="status" className="text-xs">Updating dataset…</p>}
  </section>;
}
