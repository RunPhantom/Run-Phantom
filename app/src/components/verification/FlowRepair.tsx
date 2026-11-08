import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Field, Select } from "./PredicateEditor";
import { verificationApi, type VerificationFlow } from "../../api/verification";
import type { FlowRepairProposal } from "../../../../src/verification/protocol";
import { relativeTargets, type FlowAnchor } from "../../../../src/verification/protocol";
import { Meta } from "../ui/typography";
import { dangerText, fine, inset, warningNote } from "./section";
import { cn } from "@/lib/utils";
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
  const firstEditable = editable[0] ?? 0;
  useEffect(() => () => { ticket.current++; running.current = false; }, []);
  useEffect(() => {
    ticket.current++; running.current = false; setBusy(false); setError(""); setProposal(null); setSelected(""); setStep(firstEditable);
  }, [scope, firstEditable]);
  useEffect(() => { setNotice(""); }, [flow.id, sessionId, available]);
  async function perform(work: (current: () => boolean) => Promise<void>) {
    if (running.current || disabled) return;
    running.current = true; setBusy(true); setError(""); setNotice("");
    const owned = currentScope.current; const sequence = ++ticket.current;
    const current = () => currentScope.current === owned && ticket.current === sequence;
    try { await work(current); }
    catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : "Repair review failed."); }
    finally { if (current()) { running.current = false; setBusy(false); } }
  }
  return <div className="flow-repair w-full min-w-0 space-y-3">
    <Button variant="outline" size="sm" disabled={disabled || busy || !editable.length} aria-expanded={open} aria-label={`Review repair for ${flow.name}`} onClick={() => { setOpen(!open); setStep(editable[0] ?? 0); }}>Review repair</Button>
    {open && <section aria-label={`Repair ${flow.name}`} className="rp-fade-rise space-y-4 rounded-md border border-rp-line bg-white p-4 text-[13px] text-rp-ink sm:p-5">
      <h4 className="flow-repair-heading rp-subsection-title">Review a durable anchor</h4>
      <p className={fine}>Discover current matches, compare the old and proposed identity, then select one candidate. Saving a repair changes this flow only. Replay is a separate action.</p>
      <Meta as="p" className="break-words">Version {flow.version} · revision {flow.revision.slice(0, 12)}</Meta>
      {!available && <p role="status" className={warningNote}>Select a connected app at this origin with semantic discovery to review a repair.</p>}
      <fieldset disabled={disabled || busy || !available} className="space-y-3">
        <Field label="Repair step"><Select className="min-h-11" value={step} onChange={event => { setStep(Number(event.target.value)); setProposal(null); setSelected(""); }}>{editable.map(index => <option key={index} value={index}>Step {index + 1}</option>)}</Select></Field>
        <Button size="sm" onClick={() => void perform(async current => {
          setProposal(null); setSelected("");
          const result = await verificationApi.proposeRepair(flow.id, sessionId, step);
          if (current()) setProposal(result);
        })} className="flow-repair-primary">Propose repair</Button>
      </fieldset>
      {currentProposal && <div className={cn(inset, "rp-fade-rise space-y-3 bg-rp-canvas-blue")}>
        <p className="break-words font-medium text-rp-ink" aria-label="Original anchor">Old: {describe(currentProposal.oldAnchor)}</p>
        <p aria-label="Original anchor matches" className="text-rp-ink-muted">Old match: {currentProposal.oldMatch.matches ?? "unavailable"} · {currentProposal.oldMatch.reason}</p>
        <p className="rp-meta break-words">Old source: {source(currentProposal.oldAnchor)}</p>
        <p className={currentProposal.coverage.complete ? fine : "text-[12px] leading-[1.7] text-rp-warning"}>{currentProposal.coverage.complete ? "Complete within visible observable DOM." : `Incomplete scope: ${currentProposal.coverage.reasons.join(", ") || "unavailable regions"}. Commit unavailable.`} Closed shadow roots are unobservable. Open roots: {currentProposal.coverage.openShadowRoots}; same-origin frames: {currentProposal.coverage.sameOriginFrames}; inaccessible frames: {currentProposal.coverage.inaccessibleFrames}.</p>
        <p className={fine}>Ambiguity: {currentProposal.ambiguous ? "Some candidates are ambiguous and cannot be selected." : "No ambiguous candidate identities observed."} Source coverage: {currentProposal.sourceIncomplete ? "Incomplete; some candidates have no source identity." : "Captured for listed candidates."}</p>
        <fieldset disabled={disabled || busy || !available} className="space-y-2 border-t border-rp-line-muted pt-3"><legend className="rp-field-label mb-2 pt-3">Select the new identity</legend>
          {!currentProposal.candidates.length && <p className="text-rp-ink-muted">No complete interactive candidate observed. Refresh after checking the app.</p>}
          {currentProposal.candidates.map(candidate => <label key={candidate.id} className={cn("flex min-w-0 cursor-pointer items-start gap-3 rounded-sm border p-3 transition-[background-color,border-color] duration-250 ease-standard", selected === candidate.id ? "border-rp-wash-border bg-rp-wash" : "border-rp-line bg-white hover:bg-rp-row-hover", !candidate.selectable && "cursor-not-allowed opacity-60")}>
            <input type="radio" className="mt-0.5 size-4 shrink-0" name={`repair-${flow.id}`} aria-label={`Select ${candidate.anchor.instance.name || candidate.anchor.instance.testId || candidate.anchor.instance.role}`} disabled={!candidate.selectable} checked={selected === candidate.id} onChange={() => setSelected(candidate.id)} />
            <span className="min-w-0 break-words">New: {describe(candidate.anchor)}<br />New source: {source(candidate.anchor)} · comparison: {candidate.sourceMatch}<br />{candidate.reason}</span>
          </label>)}
        </fieldset>
        <div className="flow-repair-actions flex flex-wrap gap-2"><Button size="sm" disabled={disabled || busy || !selected || !available} onClick={() => void perform(async current => {
          await verificationApi.commitRepair(flow.id, currentProposal.id, selected, currentProposal.revision);
          if (!current()) return;
          setProposal(null); setSelected(""); setNotice("Reviewed repair saved. Replay separately to check the outcome."); await onCommitted();
        })} className="flow-repair-primary">Commit selected repair</Button><Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => void perform(async current => { await verificationApi.cancelRepair(flow.id, currentProposal.id); if (!current()) return; setProposal(null); setSelected(""); setNotice("Repair canceled. Saved flow unchanged."); })}>Cancel repair</Button></div>
      </div>}
      <div role="status" aria-live="polite" className="text-rp-ink-muted">{busy ? "Reading or saving the review…" : notice}</div>
      {error && <p role="alert" className={dangerText}>{error}</p>}
    </section>}
  </div>;
}
