import { useRef, useState } from "react";
import { Button } from "../ui/button";
import { Field, Select } from "./PredicateEditor";
import { verificationApi, type VerificationFlow } from "../../api/verification";
import type { FlowRepairProposal } from "../../../../src/verification/protocol";
import { relativeTargets, type FlowAnchor } from "../../../../src/verification/protocol";
import { C } from "../../utils/colors";
import "./FlowRepair.css";

function describe(anchor: FlowAnchor): string {
  if (anchor.kind === "css") return `CSS: ${anchor.selector}`;
  const query = anchor.query;
  const address = query.kind === "test-id" ? `Test id: ${query.testId}` : query.kind === "role" ? `Role: ${query.role}${query.name ? ` · Name: ${query.name}` : ""}` : query.kind === "label" ? `Label: ${query.label}` : `Name: ${query.name}`;
  return `${address} · ${anchor.instance.role || anchor.instance.tag}: ${anchor.instance.name || anchor.instance.label || anchor.instance.testId}`;
}
function source(anchor: FlowAnchor): string {
  return anchor.kind === "semantic" && anchor.source?.status === "captured" ? `${anchor.source.file}:${anchor.source.line}${anchor.source.column === undefined ? "" : `:${anchor.source.column}`} (${anchor.source.scope}, SDK-reported)` : "Source unavailable or unrecorded";
}
export function FlowRepair({ flow, sessionId, available, disabled, onCommitted }: {
  flow: VerificationFlow; sessionId: string; available: boolean; disabled: boolean; onCommitted: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [proposal, setProposal] = useState<FlowRepairProposal | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const running = useRef(false);
  const ticket = useRef(0);
  const scope = `${flow.id}:${flow.revision}:${sessionId}:${available}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  const editable = flow.steps.flatMap((entry, index) => entry.command?.type === "click" && relativeTargets(entry.predicate).length === 0 ? [index] : []);
  const currentProposal = proposal && proposal.revision === flow.revision && available ? proposal : null;
  async function perform(work: () => Promise<void>) {
    if (running.current || disabled) return;
    running.current = true; setBusy(true); setError(""); setNotice("");
    const owned = currentScope.current; const sequence = ++ticket.current;
    try { await work(); }
    catch (cause) { if (currentScope.current === owned && ticket.current === sequence) setError(cause instanceof Error ? cause.message : "Repair review failed."); }
    finally { running.current = false; setBusy(false); }
  }
  return <div className="flow-repair w-full min-w-0 space-y-3">
    <Button variant="outline" size="sm" disabled={disabled || busy || !editable.length} aria-expanded={open} aria-label={`Review repair for ${flow.name}`} onClick={() => { setOpen(!open); setStep(editable[0] ?? 0); }}>Review repair</Button>
    {open && <section aria-label={`Repair ${flow.name}`} className="space-y-4 rounded-md border p-4 text-xs" style={{ borderColor: C.border, background: C.surface }}>
      <h4 className="flow-repair-heading text-sm font-semibold" style={{ color: C.fg3 }}>Review a durable anchor</h4>
      <p style={{ color: C.fg1 }}>Discover current matches, compare the old and proposed identity, then select one candidate. Saving a repair changes this flow only. Replay is a separate action.</p>
      <p className="break-words">Version {flow.version} · revision {flow.revision.slice(0, 12)}</p>
      {!available && <p role="status" style={{ color: C.orange }}>Select a connected app at this origin with semantic discovery to review a repair.</p>}
      <fieldset disabled={disabled || busy || !available} className="space-y-3">
        <Field label="Repair step"><Select value={step} onChange={event => { setStep(Number(event.target.value)); setProposal(null); setSelected(""); }}>{editable.map(index => <option key={index} value={index}>Step {index + 1}</option>)}</Select></Field>
        <Button size="sm" onClick={() => void perform(async () => {
          const owned = currentScope.current; setProposal(null); setSelected("");
          const result = await verificationApi.proposeRepair(flow.id, sessionId, step);
          if (owned === currentScope.current) setProposal(result);
        })} className="flow-repair-primary">Propose repair</Button>
      </fieldset>
      {currentProposal && <div className="space-y-3">
        <p className="break-words" aria-label="Original anchor">Old: {describe(currentProposal.oldAnchor)}</p>
        <p aria-label="Original anchor matches">Old match: {currentProposal.oldMatch.matches ?? "unavailable"} · {currentProposal.oldMatch.reason}</p>
        <p className="break-words">Old source: {source(currentProposal.oldAnchor)}</p>
        <p style={{ color: currentProposal.coverage.complete ? C.fg1 : C.orange }}>{currentProposal.coverage.complete ? "Complete within visible observable DOM." : `Incomplete scope: ${currentProposal.coverage.reasons.join(", ") || "unavailable regions"}. Commit unavailable.`} Closed shadow roots are unobservable. Open roots: {currentProposal.coverage.openShadowRoots}; same-origin frames: {currentProposal.coverage.sameOriginFrames}; inaccessible frames: {currentProposal.coverage.inaccessibleFrames}.</p>
        <p>Ambiguity: {currentProposal.ambiguous ? "Some candidates are ambiguous and cannot be selected." : "No ambiguous candidate identities observed."} Source coverage: {currentProposal.sourceIncomplete ? "Incomplete; some candidates have no source identity." : "Captured for listed candidates."}</p>
        <fieldset disabled={disabled || busy || !available} className="space-y-2"><legend className="mb-2 font-medium">Select the new identity</legend>
          {!currentProposal.candidates.length && <p>No complete interactive candidate observed. Refresh after checking the app.</p>}
          {currentProposal.candidates.map(candidate => <label key={candidate.id} className="flex min-w-0 items-start gap-2 rounded border p-3" style={{ borderColor: C.border }}>
            <input type="radio" name={`repair-${flow.id}`} aria-label={`Select ${candidate.anchor.instance.name || candidate.anchor.instance.testId || candidate.anchor.instance.role}`} disabled={!candidate.selectable} checked={selected === candidate.id} onChange={() => setSelected(candidate.id)} />
            <span className="min-w-0 break-words">New: {describe(candidate.anchor)}<br />New source: {source(candidate.anchor)} · comparison: {candidate.sourceMatch}<br />{candidate.reason}</span>
          </label>)}
        </fieldset>
        <div className="flow-repair-actions flex flex-wrap gap-2"><Button size="sm" disabled={disabled || busy || !selected || !available} onClick={() => void perform(async () => {
          await verificationApi.commitRepair(flow.id, currentProposal.id, selected, currentProposal.revision);
          setProposal(null); setSelected(""); setNotice("Reviewed repair saved. Replay separately to check the outcome."); await onCommitted();
        })} className="flow-repair-primary">Commit selected repair</Button><Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => void perform(async () => { await verificationApi.cancelRepair(flow.id, currentProposal.id); setProposal(null); setSelected(""); setNotice("Repair canceled. Saved flow unchanged."); })}>Cancel repair</Button></div>
      </div>}
      <div role="status" aria-live="polite">{busy ? "Reading or saving the review…" : notice}</div>
      {error && <p role="alert" className="break-words" style={{ color: C.red }}>{error}</p>}
    </section>}
  </div>;
}
