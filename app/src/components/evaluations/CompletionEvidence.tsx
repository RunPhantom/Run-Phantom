import { useEffect, useRef, useState } from "react";
import { claimsApi, CompletionRequestError } from "../../api/claims";
import type { CompletionHistory, CompletionSavedReport } from "../../../../src/claims/protocol";
import type { EvidenceSetView } from "../../../../src/evaluations/evidence-protocol";
import { Button } from "../ui/button";
import { Field, Select } from "../verification/PredicateEditor";
import { Input } from "../ui/input";
import { textareaClass } from "./RuleEditor";

const preferenceKey = "runphantom:completionEvidenceConsent";
function enabledPreference(): boolean { try { return localStorage.getItem(preferenceKey) === "1"; } catch { return false; } }
const labels = { ambiguous_text: "Ambiguous text", unsupported_claim: "Unlinked prose", evidence_available: "Evidence available", evidence_missing: "Evidence missing", scope_mismatch: "Outside selected revision", reported_outcome: "Reported outcome" };
const categories = { prose: "Prose", negated: "Negation", conditional: "Conditional", quoted: "Quotation", code: "Code", unchecked_task: "Unchecked task", checked_task: "Checked task", question: "Question", structured: "Operator-linked statement" };
const outcomes = { reports_pass: "Reports pass", reports_fail: "Reports failure", no_tests: "No tests", unknown: "Unknown" };

export function CompletionEvidence({ view, onRefusal }: { view: EvidenceSetView; onRefusal: (message: string) => void }) {
  const [enabled, setEnabled] = useState(enabledPreference), [summary, setSummary] = useState(""), [statement, setStatement] = useState(""), [sourceId, setSourceId] = useState("");
  const [saved, setSaved] = useState<CompletionSavedReport | null>(null), [history, setHistory] = useState<CompletionHistory | null>(null), [historyOpen, setHistoryOpen] = useState(false), [selected, setSelected] = useState(""), [offset, setOffset] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const generation = useRef(0), controllers = useRef(new Set<AbortController>()), retainedId = useRef(""), activeSelection = useRef(""), historyVisible = useRef(false), mounted = useRef(true), refusal = useRef(onRefusal); refusal.current = onRefusal;
  const attachment = view.revision.attachment, available = view.sources.filter(source => source.normalizedAvailable), context = JSON.stringify([attachment, view.revision.id, view.revision.revision]);
  function cancel() { generation.current++; for (const controller of controllers.current) controller.abort(); controllers.current.clear(); retainedId.current = ""; activeSelection.current = ""; setSelected(""); setSaved(null); setBusy(false); }
  function reset() { historyVisible.current = false; cancel(); setSummary(""); setStatement(""); setSourceId(""); setHistory(null); setHistoryOpen(false); setSelected(""); setOffset(0); setError(""); }
  function consent(next: boolean) { reset(); try { localStorage.setItem(preferenceKey, next ? "1" : "0"); } catch {} setEnabled(next); }
  useEffect(() => {
    mounted.current = true;
    const lifetime = { mounted, generation, pending: controllers.current };
    const changed = (event: StorageEvent) => { if (event.key === preferenceKey || event.key === null) { reset(); setEnabled(enabledPreference()); } };
    window.addEventListener("storage", changed);
    return () => { lifetime.mounted.current = false; lifetime.generation.current++; for (const controller of lifetime.pending) controller.abort(); lifetime.pending.clear(); window.removeEventListener("storage", changed); };
    // The parent remounts this component for every authority, revision or retention change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context]);
  async function read<T>(work: (signal: AbortSignal) => Promise<T>, accept: (result: T) => void, revoke = true) {
    const token = generation.current, controller = new AbortController(); controllers.current.add(controller);
    try { const result = await work(controller.signal); if (mounted.current && token === generation.current && !controller.signal.aborted) accept(result); }
    catch (cause) {
      if (mounted.current && token === generation.current && !controller.signal.aborted) {
        cancel(); const message = cause instanceof Error ? cause.message : "Completion evidence is unavailable."; setError(message);
        if (revoke || cause instanceof CompletionRequestError && [403, 404].includes(cause.status)) refusal.current(message);
      }
    } finally { controllers.current.delete(controller); if (mounted.current && token === generation.current) setBusy(false); }
  }
  useEffect(() => {
    if (!historyOpen) return;
    const refresh = () => { if (!historyVisible.current) return; void read(signal => claimsApi.history(attachment, offset, signal), next => { setHistory(next); if (retainedId.current && !next.items.some(item => item.id === retainedId.current && item.payloadAvailable) && next.offset === 0) { cancel(); setSelected(""); } }); };
    refresh(); const timer = window.setInterval(refresh, 3_000); return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyOpen, offset, context]);
  useEffect(() => {
    if (!selected) return;
    const refresh = () => { if (activeSelection.current !== selected) return; void read(signal => claimsApi.get(selected, attachment, signal), next => { retainedId.current = next.id; setSaved(next); }); };
    refresh(); const timer = window.setInterval(refresh, 3_000); return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, context]);
  async function create() {
    if (!enabled || busy || !available.length) return;
    cancel(); setError("");
    if (new TextEncoder().encode(summary).byteLength > 16 * 1024 || new TextEncoder().encode(statement).byteLength > 512) { setError("Keep the full summary within 16 KiB and a linked statement within 512 UTF-8 bytes. Text is never silently clipped for retention."); return; }
    if (statement.trim() && !sourceId) { setError("Select the exact source for the linked statement."); return; }
    setBusy(true);
    await read(signal => claimsApi.create({ enabled: true, attachment, setId: view.revision.id, revision: view.revision.revision, summary, assertions: statement.trim() ? [{ text: statement, reference: { setId: view.revision.id, revision: view.revision.revision, sourceId } }] : [] }, crypto.randomUUID(), signal), next => { retainedId.current = next.id; setSaved(next); activeSelection.current = next.id; setSelected(next.id); setOffset(0); historyVisible.current = true; setHistoryOpen(true); }, false);
  }
  async function exportSaved() {
    if (!saved || busy) return; setBusy(true); const id = saved.id;
    await read(signal => claimsApi.get(id, attachment, signal), next => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(next, null, 2)], { type: "application/json" })), link = document.createElement("a"); link.href = url; link.download = "runphantom-completion-observation.json"; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    });
  }
  const report = saved?.report;
  return <section className="evidence-panel completion-evidence" aria-label="Reported completion evidence">
    <div className="evidence-row"><div><p className="evidence-eyebrow">OPTIONAL · REPORT ONLY</p><h2>Reported completion evidence</h2></div><span className="evidence-badge">{enabled ? "Opt-in enabled" : "Disabled"}</span></div>
    <p className="evidence-meta">Locate support for a summary. Prose and producer reports do not prove execution, authenticity or full-set completion. Captured output and machine verdicts stay unchanged.</p>
    <label className="evidence-checkbox"><input type="checkbox" checked={enabled} onChange={event => consent(event.target.checked)} />Enable completion observer on this browser</label>
    {!enabled && <p className="evidence-meta">No summaries are processed while disabled. Retained observations remain read-only and can be deliberately opened below.</p>}
    {enabled && <div className="completion-draft">
      <Field label="Completion summary" hint="Exact operator-supplied text; retained only after your explicit action. Up to 16 KiB of UTF-8."><textarea className={`${textareaClass} min-h-28`} value={summary} maxLength={16 * 1024} disabled={busy || !available.length} onChange={event => { cancel(); setSummary(event.target.value); }} /></Field>
      <div className="evidence-grid"><Field label="Linked statement" hint="Optional explicit assertion, up to 512 UTF-8 bytes."><Input value={statement} maxLength={512} disabled={busy || !available.length} onChange={event => { cancel(); setStatement(event.target.value); }} /></Field><Field label="Statement evidence source"><Select value={sourceId} disabled={busy || !available.length} onChange={event => { cancel(); setSourceId(event.target.value); }}><option value="">Choose a selected source</option>{available.map(source => <option key={source.sourceId} value={source.sourceId}>{source.sourceId} · r{view.revision.revision}</option>)}</Select></Field></div>
      <div className="evidence-actions"><Button className="evidence-primary" disabled={busy || !available.length || !summary.trim() && !statement.trim()} onClick={() => void create()}>Inspect and retain observation</Button><Button variant="outline" onClick={reset}>Clear draft and view</Button></div>
      {!available.length && <p className="evidence-meta">Normalized source content was removed. A new observation cannot be created from this revision.</p>}
    </div>}
    <div className="evidence-actions"><Button variant="outline" onClick={() => { cancel(); setSelected(""); setError(""); historyVisible.current = !historyOpen; setHistoryOpen(!historyOpen); }}> {historyOpen ? "Close saved observations" : "Open saved observations"}</Button></div>
    {historyOpen && <div className="completion-history"><Field label="Saved completion observation"><Select value={selected} disabled={busy} onChange={event => { cancel(); setError(""); activeSelection.current = event.target.value; setSelected(event.target.value); }}><option value="">Choose a retained observation</option>{history?.items.map(item => <option key={item.id} value={item.id} disabled={!item.payloadAvailable}>{item.detectorVersion} · source r{item.revision} · {new Date(item.createdAt).toLocaleString()}{item.payloadAvailable ? "" : " · content removed"}</option>)}</Select></Field><p className="evidence-meta">{history ? `${history.total} retained metadata record(s). ${history.items.length} shown on this page.` : "Loading authorized history…"}</p>{history && history.total > 20 && <div className="evidence-actions"><Button variant="outline" disabled={offset === 0} onClick={() => { cancel(); setSelected(""); setOffset(Math.max(0, offset - 20)); }}>Previous observations</Button><Button variant="outline" disabled={!history.hasMore} onClick={() => { cancel(); setSelected(""); setOffset(offset + 20); }}>Next observations</Button></div>}</div>}
    {error && <p role="alert" className="completion-error">{error}</p>}
    {report && saved && <section aria-label="Retained completion observation" className="completion-report">
      <div className="evidence-row"><h3>Evidence coverage</h3><Button variant="outline" disabled={busy} onClick={() => void exportSaved()}>Export retained observation</Button></div>
      <p className="evidence-meta">{report.detectorVersion} · source revision {report.selected.revision} · {report.coverage.observed} observation(s) · {report.coverage.uncoveredBytes.toLocaleString()} summary bytes uncovered. Authenticity not checked.</p>
      {report.source.partial && <p role="status" className="evidence-reasons">Partial observation: a detector or observation limit was reached. Uncovered text cannot establish completion.</p>}
      <details><summary>Exact retained summary and provenance</summary><div className="evidence-details"><pre className="completion-text">{saved.request.summary || "No free-text summary supplied."}</pre><p className="evidence-meta">Operator-supplied summary · {report.source.totalBytes} UTF-8 bytes · SHA-256 <code>{report.source.sha256}</code></p><p className="evidence-meta">Character offsets use UTF-16 code units; byte offsets use UTF-8. Excerpts are literal text.</p></div></details>
      {!report.observations.length && <p className="evidence-empty">No supported completion spans were observed. The summary remains uncovered.</p>}
      <ol className="completion-observations">{report.observations.map(item => <li key={item.id}><div className="evidence-row"><strong>{labels[item.state]}</strong><span className="evidence-meta">{categories[item.category]} · characters {item.origin.start}–{item.origin.end} · bytes {item.origin.byteStart}–{item.origin.byteEnd}</span></div><pre className="completion-text">{item.snippet}</pre>{item.snippetTruncated && <p className="evidence-meta">Excerpt limited to 512 UTF-8 bytes. The source range above remains exact.</p>}<p className="evidence-meta">{item.explanation}</p>{item.reference && <p className="evidence-meta">Selected link: <code>{item.reference.sourceId}</code> · r{item.reference.revision} · {item.reportedOutcome ? outcomes[item.reportedOutcome] : "No reported outcome"} · unauthenticated</p>}</li>)}</ol>
    </section>}
  </section>;
}
