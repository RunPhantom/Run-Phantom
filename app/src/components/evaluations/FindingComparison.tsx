import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { evidenceApi, type EvidenceAttachment, type ExperimentSummary } from "../../api/evaluations";
import { findingsApi, type FindingBatchOption, type FindingComparisonPage } from "../../api/findings";
import { useRuns } from "../../hooks/use-runs";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Field, Select } from "../verification/PredicateEditor";
import { prepareEvidenceUpload, type EvidenceCapabilities } from "./evidence-upload";
import "./evidence-workspace.css";
import "./finding-workspace.css";

const key = (item: FindingBatchOption) => JSON.stringify(item.reference);
const message = (cause: unknown) => cause instanceof Error ? cause.message : "Finding authority is unavailable.";
const count = (value: number | null) => value === null ? "Unavailable" : String(value);
export function FindingComparison({ experiments }: { experiments: ExperimentSummary[] }) {
  const [params, setParams] = useSearchParams(), runs = useRuns();
  const kind = params.get("anchorKind") === "experiment" ? "experiment" : "run", id = params.get("anchorId") ?? "", selected = params.get("findingComparison") ?? "";
  const attachment = useMemo<EvidenceAttachment | null>(() => id ? { kind, id } : null, [kind, id]), context = JSON.stringify(attachment);
  const epoch = useRef(0), currentContext = useRef(context), controllers = useRef(new Set<AbortController>()), work = useRef(false);
  if (currentContext.current !== context) { currentContext.current = context; epoch.current++; }
  const [capabilities, setCapabilities] = useState<EvidenceCapabilities | null>(null), [batches, setBatches] = useState<FindingBatchOption[]>([]), [history, setHistory] = useState<{ id: string; createdAt: number }[]>([]);
  const [authorized, setAuthorized] = useState(false), [refused, setRefused] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [baseline, setBaseline] = useState(""), [candidate, setCandidate] = useState(""), [files, setFiles] = useState<{ baseline: File | null; candidate: File | null }>({ baseline: null, candidate: null }), [retain, setRetain] = useState(false);
  const [report, setReport] = useState<FindingComparisonPage | null>(null), [offset, setOffset] = useState(0), [mappingId, setMappingId] = useState<string | null>(null), [reviewed, setReviewed] = useState(false), [baselinePath, setBaselinePath] = useState(""), [candidatePath, setCandidatePath] = useState(""), [reason, setReason] = useState("");
  const active = useRef({ selected, offset }); active.current = { selected, offset };
  const cancelPending = useCallback(() => {
    epoch.current++; for (const controller of controllers.current) controller.abort(); controllers.current.clear(); work.current = false;
  }, []);
  const revoke = useCallback((cause = "") => {
    cancelPending();
    setAuthorized(false); setCapabilities(null); setBatches([]); setHistory([]); setReport(null); setMappingId(null); setReviewed(false); setReason(""); setBaselinePath(""); setCandidatePath(""); setBaseline(""); setCandidate(""); setFiles({ baseline: null, candidate: null }); setNotice(""); setBusy(false); setRefused(!!cause); setError(cause);
  }, [cancelPending]);
  const refresh = useCallback(async () => {
    if (!attachment) return;
    const captured = epoch.current, selection = { ...active.current }, controller = new AbortController(); controllers.current.add(controller);
    const same = () => captured === epoch.current && !controller.signal.aborted && currentContext.current === context && active.current.selected === selection.selected && active.current.offset === selection.offset;
    try {
      const permission = await findingsApi.capabilities(controller.signal); if (!same()) return;
      if (!permission.enabled || permission.scope !== "local") throw Error("Finding comparison is unavailable in this workspace.");
      const available = await findingsApi.batches(attachment, controller.signal); if (!same()) return;
      // This exact check is fresh and independent of bounded discovery or a deferred detail body.
      if (selection.selected) { await findingsApi.authority(selection.selected, attachment, controller.signal); if (!same()) return; }
      const prior = await findingsApi.history(attachment, controller.signal); if (!same()) return;
      const reader = await evidenceApi.capabilities(); if (!same()) return;
      let next: FindingComparisonPage | null = null;
      if (selection.selected) { next = await findingsApi.get(selection.selected, selection.offset, controller.signal); if (!same()) return; }
      setCapabilities(reader); setBatches(available.items); setHistory(prior.items); setReport(next); setAuthorized(true);
      if (available.truncated || prior.truncated) setNotice("History is bounded. Older saved comparisons remain available through their direct link.");
    } catch (cause) { if (same()) revoke(message(cause)); } finally { controllers.current.delete(controller); }
  }, [attachment, context, revoke]);
  useEffect(() => { revoke(); void refresh(); return cancelPending; }, [context, refresh, revoke, cancelPending]);
  useEffect(() => { if (!attachment || refused) return; const timer = setInterval(() => { void refresh(); }, 1_500); return () => clearInterval(timer); }, [attachment, refused, refresh]);
  useEffect(() => { if (authorized && selected) void refresh(); }, [selected, offset, authorized, refresh]);
  function chooseContext(nextKind: string, nextId: string) { revoke(); setOffset(0); setParams(previous => { const next = new URLSearchParams(previous); next.set("anchorKind", nextKind); next.set("anchorId", nextId); next.delete("findingComparison"); return next; }); }
  function chooseReport(nextId: string) {
    cancelPending(); setBusy(false);
    active.current = { selected: nextId, offset: 0 }; setReport(null); setOffset(0); setParams(previous => { const next = new URLSearchParams(previous); if (nextId) next.set("findingComparison", nextId); else next.delete("findingComparison"); return next; });
  }
  async function perform(action: (signal: AbortSignal, valid: () => boolean) => Promise<void>) {
    if (!authorized || !capabilities || work.current) return;
    const captured = epoch.current, selection = { ...active.current }, controller = new AbortController(), valid = () => captured === epoch.current && currentContext.current === context && !controller.signal.aborted && active.current.selected === selection.selected && active.current.offset === selection.offset;
    controllers.current.add(controller); work.current = true; setBusy(true); setError("");
    try { await action(controller.signal, valid); } catch (cause) { if (valid()) revoke(message(cause)); } finally { controllers.current.delete(controller); if (valid()) { work.current = false; setBusy(false); } }
  }
  function download(value: unknown, valid: () => boolean) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }); if (!valid()) return;
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    try { link.href = url; link.download = "runphantom-finding-comparison.json"; if (valid()) link.click(); }
    finally { URL.revokeObjectURL(url); }
  }
  const left = batches.find(item => key(item) === baseline), right = batches.find(item => key(item) === candidate), ready = authorized && !!capabilities && !busy;
  async function importFile(side: "baseline" | "candidate", signal: AbortSignal, valid: () => boolean) {
    const file = files[side]; if (!file || !capabilities || !attachment) throw Error("Select an authorized finding report first.");
    const upload = await prepareEvidenceUpload([{ file, sourceId: "findings", dialect: "runphantom-findings-json/v1", shardId: "" }], capabilities, { attachment, inventory: null, retention: retain ? "raw_and_normalized" : "normalized_only", operationKey: crypto.randomUUID(), signal }); if (!valid()) return;
    const receipt = await evidenceApi.upload(upload.body, capabilities.transport.contentType, signal); if (!valid()) return;
    let job = receipt.job;
    while (["queued", "running"].includes(job.status)) { await new Promise(resolve => setTimeout(resolve, 100)); if (!valid()) return; job = (await evidenceApi.job(job.id, signal)).job; }
    if (job.status !== "completed" || !job.setId) throw Error(`Finding import ${job.status}; no comparison was created.`);
    const available = await findingsApi.batches(attachment, signal); if (!valid()) return;
    const imported = available.items.find(item => item.reference.setId === job.setId && item.reference.sourceId === "findings"); if (!imported) throw Error("The current imported finding interpretation is unavailable.");
    setBatches(available.items); if (side === "baseline") setBaseline(key(imported)); else setCandidate(key(imported)); setMappingId(null); setReviewed(false); setNotice(`${side === "baseline" ? "Baseline" : "Candidate"} report saved. Execution remains producer-declared.`);
  }
  const options = kind === "run" ? (runs.isError ? [] : runs.data ?? []).map(run => ({ id: run.id, name: run.display_name || run.name || run.id })) : experiments.map(experiment => ({ id: experiment.id, name: experiment.name }));
  const detail = report?.comparison.difference;
  return <main className="evidence-workspace finding-workspace" data-testid="finding-workspace">
    <header className="evidence-intro"><p className="evidence-eyebrow">LOCAL FINDING COMPARISON</p><h1>Finding comparison</h1><p>See which exact finding occurrences were retained, introduced or removed. Recorded coverage controls what the comparison can explain.</p></header>
    {error && <div role="alert" className="evidence-alert"><p>{error} Previous comparison details and actions have been withheld.</p><Button variant="outline" onClick={() => { chooseReport(""); revoke(); void refresh(); }}>Reload authorized findings</Button></div>}
    {notice && <p role="status" className="evidence-notice">{notice}</p>}
    <section aria-label="Finding attachment" className="evidence-panel"><h2>Attach to existing work</h2><p className="evidence-meta">Comparisons preserve the original captured output and machine verdict.</p><div className="evidence-grid mt-5"><Field label="Finding context type"><Select value={kind} disabled={busy} onChange={event => chooseContext(event.target.value, "")}><option value="run">Captured run</option><option value="experiment">Frozen experiment</option></Select></Field><Field label="Finding attachment"><Select value={id} disabled={busy} onChange={event => chooseContext(kind, event.target.value)}><option value="">Choose existing work</option>{options.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</Select></Field></div></section>
    {attachment && <>
      {!authorized && !refused && <p role="status">Checking current finding authority…</p>}
      <section aria-label="Import finding reports" className="evidence-panel"><h2>Import the two snapshots</h2><p className="evidence-meta">Use the closed Run Phantom finding JSON format. Uploaded reports declare execution; they do not authenticate it or establish passed tests.</p><div className="evidence-grid mt-5">{(["baseline", "candidate"] as const).map(side => <div key={side}><Field label={`${side === "baseline" ? "Baseline" : "Candidate"} finding JSON`}><input type="file" accept=".json,application/json" disabled={!ready} onChange={event => { setFiles(previous => ({ ...previous, [side]: event.target.files?.[0] ?? null })); }} /></Field><Button className="evidence-primary mt-3" disabled={!ready || !files[side]} onClick={() => void perform((signal, valid) => importFile(side, signal, valid))}>Import {side} findings</Button></div>)}</div><label className="evidence-checkbox"><input type="checkbox" checked={retain} disabled={!ready} onChange={event => setRetain(event.target.checked)} />Retain raw finding reports for separate download and reparse</label></section>
      <section aria-label="Choose finding snapshots" className="evidence-panel"><h2>Compare immutable reports</h2><div className="evidence-grid mt-5">{(["baseline", "candidate"] as const).map(side => <Field key={side} label={`${side === "baseline" ? "Baseline" : "Candidate"} finding snapshot`}><Select disabled={!ready} value={side === "baseline" ? baseline : candidate} onChange={event => { if (side === "baseline") setBaseline(event.target.value); else setCandidate(event.target.value); setMappingId(null); setReviewed(false); }}><option value="">Choose a saved report</option>{batches.map(item => <option key={key(item)} value={key(item)}>{item.sourceSnapshot ?? "Unavailable interpretation"} · {item.reference.setId.slice(0, 8)} · revision {item.reference.revision} · {item.observed === null ? "unknown records" : `${item.observed} observed`}</option>)}</Select></Field>)}</div>
        {left && right && <div className="evidence-trust"><span>Baseline coverage: <strong>{left.reportedExecution ?? "unavailable"}</strong></span><span>Candidate coverage: <strong>{right.reportedExecution ?? "unavailable"}</strong></span><span>Execution authentication: <strong>not authenticated</strong></span></div>}
        <details><summary>Review an exact rename or checker compatibility mapping</summary><p className="evidence-meta">A local operator review binds only these two snapshots and checker configurations. This declaration does not authenticate execution or infer broader compatibility.</p><div className="evidence-grid mt-4"><Field label="Reviewed baseline path"><Input maxLength={1024} value={baselinePath} disabled={!ready} onChange={event => setBaselinePath(event.target.value)} /></Field><Field label="Reviewed candidate path"><Input maxLength={1024} value={candidatePath} disabled={!ready} onChange={event => setCandidatePath(event.target.value)} /></Field></div><Field label="Mapping review reason"><Input maxLength={1024} value={reason} disabled={!ready} onChange={event => setReason(event.target.value)} /></Field><label className="evidence-checkbox"><input type="checkbox" checked={reviewed} disabled={!ready} onChange={event => setReviewed(event.target.checked)} />I reviewed these exact snapshots and checker configurations</label><Button variant="outline" disabled={!ready || !left || !right || !reviewed || !reason.trim() || !!baselinePath !== !!candidatePath} onClick={() => void perform(async (signal, valid) => { const mapping = await findingsApi.mapping(left!.reference, right!.reference, baselinePath ? [{ baseline: baselinePath, candidate: candidatePath }] : [], reason, signal); if (valid()) { setMappingId(mapping.id); setNotice("Exact mapping saved by local_operator. It applies only to the selected immutable reports."); } })}>Save operator-reviewed mapping</Button>{mappingId && <p className="evidence-meta mt-3">Exact reviewed mapping selected.</p>}</details>
        <div className="evidence-actions"><Button className="evidence-primary" disabled={!ready || !left || !right} onClick={() => void perform(async (signal, valid) => { const next = await findingsApi.compare(left!.reference, right!.reference, mappingId, signal); if (valid()) { setReport(next); chooseReport(next.comparison.id); setNotice("Immutable finding comparison saved. Conditional counts do not change the machine verdict."); } })}>Compare selected findings</Button></div>
        <Field label="Saved finding comparison"><Select disabled={!ready} value={selected} onChange={event => chooseReport(event.target.value)}><option value="">Choose a saved comparison</option>{history.map(item => <option value={item.id} key={item.id}>{item.id.slice(0, 8)} · {new Date(item.createdAt).toLocaleString()}</option>)}</Select></Field>
      </section>
      {authorized && report && detail && <section aria-label="Persisted finding comparison" className="evidence-panel"><div className="evidence-row"><h2>Immutable finding observations</h2><span className="evidence-badge">{detail.interpretation === "conditional" ? "Conditional delta" : "Delta unavailable"}</span></div><p className="evidence-meta">Counts describe the recorded producer reports only. Execution is not authenticated; no test-pass verdict is inferred.</p><dl className="evidence-counts">{(["retained", "introduced", "removed", "unresolved"] as const).map(name => <div key={name}><dt>{name === "unresolved" ? "Observed unresolved" : `Conditional ${name}`}</dt><dd>{count(detail.counts[name])}</dd></div>)}</dl><p className="evidence-meta">Observed baseline records: {count(detail.observed.baseline)} · Observed candidate records: {count(detail.observed.candidate)}</p>{detail.reasons.length > 0 && <p className="evidence-reasons">Unavailable because: {detail.reasons.join(", ")}</p>}
        <ol className="evidence-leaves mt-5">{report.page.items.map((item, index) => <li key={`${report.page.offset + index}`}><h3>{item.classification}{item.severityChanged ? " · severity changed" : ""}{item.locationChanged ? " · location moved" : ""}</h3><div className="evidence-grid mt-3">{(["baseline", "candidate"] as const).map(side => <div key={side}><p className="evidence-meta">{side === "baseline" ? "Baseline" : "Candidate"}</p>{item[side] ? <><p className="finding-path">{item[side]!.path} · {item[side]!.startLine === null ? "line unavailable" : `line ${item[side]!.startLine}`}</p><p className="evidence-meta">{item[side]!.ruleId} · {item[side]!.severity} · occurrence {item[side]!.id}</p><pre>{item[side]!.message}</pre></> : <p className="evidence-meta">No paired occurrence</p>}</div>)}</div></li>)}</ol>
        <div className="evidence-actions"><Button variant="outline" disabled={!ready || offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>Previous finding page</Button><Button variant="outline" disabled={!ready || offset + report.page.items.length >= report.page.total} onClick={() => setOffset(offset + 100)}>Next finding page</Button><Button variant="outline" disabled={!ready} onClick={() => void perform(async (signal, valid) => { const value = await findingsApi.export(report.comparison.id, signal); if (valid()) download(value, valid); })}>Export finding comparison JSON</Button></div><p className="evidence-meta">Showing {report.page.items.length ? report.page.offset + 1 : 0}–{report.page.offset + report.page.items.length} of {report.page.total} observed occurrences.</p>
        <details><summary>Measured comparison stages</summary><p className="evidence-meta">One saved comparison sample. CPU and peak memory were not measured.</p><dl className="evidence-identities">{(["acquisitionWallMs", "matchingWallMs", "serializationWallMs"] as const).map(stage => <div key={stage}><dt>{stage}</dt><dd>{report.comparison.timing[stage].toFixed(3)} ms</dd></div>)}</dl></details>
      </section>}
    </>}
  </main>;
}
