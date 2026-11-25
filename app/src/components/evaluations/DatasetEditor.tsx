import { useEffect, useId, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DisabledReason, Field, Select } from "./field";
import { buildRule, emptyRule, ruleDraft, ruleLabel, RuleEditor, textareaClass } from "./RuleEditor";
import { ResponseSpanSelect, SnapshotPreview } from "./SnapshotPreview";
import { evaluationsApi, type DatasetRevision, type DatasetCaseDraft, type Snapshot } from "../../api/evaluations";
import { useRuns } from "../../hooks/use-runs";
import { runOptionLabel } from "./EvaluationOverview";

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
  const addReason = useId(), ruleReason = useId(), saveReason = useId();
  const [sourceState, setSourceState] = useState<"idle" | "loading" | "error">("idle");
  // "Add case" needs the source snapshot; load it as soon as a source is chosen
  // so a run linked from "Evaluate run" is ready without an extra click.
  useEffect(() => {
    if (!sourceRunId || historical) return;
    const controller = new AbortController();
    setSourceState("loading");
    evaluationsApi.snapshot(sourceRunId, sourceSpanId || undefined).then(next => { if (!controller.signal.aborted) { setSnapshot(next); setSourceState("idle"); } },
      () => { if (!controller.signal.aborted) setSourceState("error"); });
    return () => controller.abort();
  }, [sourceRunId, sourceSpanId, historical]);
  async function perform(operation: () => Promise<void>) { if (busy) return; setBusy(true); setError(""); try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update the dataset."); } finally { setBusy(false); } }
  function addCase() {
    setError("");
    try {
      if (!caseName.trim()) throw new Error("Case name is required.");
      if (!sourceRunId && !overrideInput) throw new Error("Choose a source run or explicitly provide reference input.");
      const next: DatasetCaseDraft = { ...(editing !== null && cases[editing].id ? { id: cases[editing].id } : {}), name: caseName.trim(), ...(sourceRunId ? { sourceRunId } : {}), ...(sourceSpanId ? { sourceSpanId } : {}), ...(overrideInput ? { input } : {}), tags: tags.split(",").map(value => value.trim()).filter(Boolean), rules: rules.map(buildRule) };
      setCases(previous => editing === null ? [...previous, next] : previous.map((item, index) => index === editing ? next : item));
      setDirty(true); setEditing(null); setCaseName(""); setTags(""); setRules([emptyRule()]); setNotice("Case added. Save a new revision to use it in an experiment.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not add case."); }
  }
  const addBlocker = editing !== null ? null
    : cases.length >= 50 ? "A dataset holds up to 50 cases. Remove one to add another."
      : sourceRunId && !snapshot ? sourceState === "loading" ? "Loading the source run…" : "Use Preview source to load the run first."
        : null;
  return <section aria-label="Dataset cases" className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">Cases · revision {revision.version}</h2><span className="text-xs text-[color:var(--rp-ink-muted)]">{cases.length} of 50 cases{dirty ? " · Unsaved changes" : ""}</span></div>
    {historical && <p className="text-xs text-[color:var(--rp-warning)]">This is an immutable historical revision. Select the latest revision to make changes.</p>}
    {error && <p role="alert" className="text-xs text-[color:var(--rp-danger)]">{error}</p>}
    {notice && <p role="status" className="text-xs text-[color:var(--rp-ink-soft)]">{notice}</p>}
    {!cases.length && <p className="text-13 text-rp-ink-muted">No cases yet. Pick a captured run below, describe what a good result looks like, then save a new revision.</p>}
    <ol className="space-y-3">{cases.map((item, index) => <li key={item.id ?? index} className="space-y-2 border-b border-[color:var(--rp-border)] pb-3"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">{item.name}</h3><div className="flex gap-1"><Button variant="ghost" size="sm" disabled={historical || busy} aria-label={`Edit case ${item.name}`} onClick={() => { setEditing(index); setCaseName(item.name); setSourceRunId(item.sourceRunId ?? ""); setSourceSpanId(item.sourceSpanId ?? ""); setSnapshot(null); setOverrideInput(item.input !== undefined); setInput(item.input ?? ""); setTags(item.tags?.join(", ") ?? ""); setRules(item.rules.map(ruleDraft)); }}>Edit</Button><Button variant="ghost" size="sm" disabled={historical || busy} aria-label={`Remove case ${item.name}`} onClick={() => { setCases(previous => previous.filter((_, at) => at !== index)); setDirty(true); setEditing(null); }}>Remove</Button></div></div><ul className="space-y-1 text-xs text-[color:var(--rp-ink-soft)]">{item.rules.map((rule, at) => <li className="break-words" key={at}>{ruleLabel(rule)}</li>)}</ul></li>)}</ol>
    <fieldset id="new-case" disabled={busy || historical} className="scroll-mt-6 space-y-4">
      <h3 className="text-sm font-medium">{editing === null ? "Add a case" : "Edit case"}</h3>
      <Field label="Source run"><Select value={sourceRunId} onChange={event => { setSourceRunId(event.target.value); setSourceSpanId(""); setSnapshot(null); }}><option value="">No run: type the input yourself</option>{sourceRunId && !runs.data?.some(run => run.id === sourceRunId) && <option value={sourceRunId}>Run from the link</option>}{runs.data?.map(run => <option key={run.id} value={run.id}>{runOptionLabel(run)}</option>)}</Select></Field>
      {runs.isError && <p className="text-xs text-[color:var(--rp-danger)]">Captured run choices could not load.</p>}
      {sourceRunId && <><ResponseSpanSelect runId={sourceRunId} value={sourceSpanId} onChange={value => { setSourceSpanId(value); setSnapshot(null); }} /><Button variant="outline" onClick={() => void perform(async () => { setSnapshot(await evaluationsApi.snapshot(sourceRunId, sourceSpanId || undefined)); })}>Preview source</Button></>}
      {sourceRunId && !snapshot && sourceState === "loading" && <p role="status" className="text-xs text-[color:var(--rp-ink-soft)]">Loading the source run…</p>}
      {sourceRunId && !snapshot && sourceState === "error" && <p role="alert" className="text-xs text-[color:var(--rp-danger)]">The source run could not be loaded. Use Preview source to try again.</p>}
      {snapshot && <SnapshotPreview snapshot={snapshot} />}
      <Field label="Case name"><Input value={caseName} onChange={event => setCaseName(event.target.value)} maxLength={128} placeholder="Checkout result" /></Field>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={overrideInput} onChange={event => setOverrideInput(event.target.checked)} />Use my own input instead of the run’s input</label>
      {overrideInput && <Field label="Reference input" hint="An experiment grades a run only when its input matches this text exactly. Line endings are ignored."><textarea className={textareaClass} maxLength={16384} value={input} onChange={event => setInput(event.target.value)} /></Field>}
      <Field label="Tags (optional)" hint="Up to eight comma-separated tags."><Input value={tags} onChange={event => setTags(event.target.value)} /></Field>
      {rules.map((draft, index) => <RuleEditor key={index} index={index} draft={draft} onChange={value => setRules(previous => previous.map((item, at) => at === index ? value : item))} onRemove={rules.length > 1 ? () => setRules(previous => previous.filter((_, at) => at !== index)) : undefined} />)}
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={rules.length >= 8} aria-describedby={rules.length >= 8 ? ruleReason : undefined} onClick={() => setRules(previous => [...previous, emptyRule()])}>Add rule</Button><Button disabled={!!addBlocker} aria-describedby={addBlocker ? addReason : undefined} onClick={addCase}>{editing === null ? "Add case" : "Update case draft"}</Button></div>
      <DisabledReason id={ruleReason} reason={rules.length >= 8 && "A case holds up to 8 rules."} /><DisabledReason id={addReason} reason={addBlocker} />
    </fieldset>
    <div className="space-y-2"><Button disabled={busy || historical || !dirty} aria-describedby={!busy && !historical && !dirty ? saveReason : undefined} onClick={() => void perform(async () => { const next = await evaluationsApi.saveRevision(revision.datasetId, revision.version, cases); onSaved(next); })}>Save new revision</Button><DisabledReason id={saveReason} reason={!busy && !historical && !dirty && "Add, edit or remove a case first."} /></div>
    {busy && <p role="status" className="text-13">Updating dataset…</p>}
  </section>;
}
