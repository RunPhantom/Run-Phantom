import { useEffect, useRef, useState } from "react";
import { verificationApi, type ChangeWorkspaceOffer, type VerificationChangeContext, type VerificationReport, type VerificationReportContext } from "../../api/verification";
import { PerformanceReadings } from "./PerformanceEvidence";
import { Button } from "../ui/button";
import { Eyebrow } from "../ui/typography";
import { checkbox, fine, inset, summary, warningText, well } from "./section";
import { cn } from "@/lib/utils";

const sourceReasons = {
  "not-react": "Control has no accessible React metadata.",
  "source-unavailable": "No development location was available.",
  "unsafe-source": "The location was withheld because its path was unsafe.",
  "probe-limit": "Source inspection reached its safety limit.",
  "probe-error": "Source metadata could not be inspected.",
  redacted: "A sensitive location was withheld.",
};

function expectedOutcome(value: unknown, depth = 0): string {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 6) return "Expected outcome omitted from retained context";
  const predicate = value as Record<string, unknown>;
  const text = (value: unknown, fallback = "omitted") => typeof value === "string" || typeof value === "number" ? String(value) : fallback;
  switch (predicate.kind) {
    case "performance": return `Native lab ${text(predicate.metric)} ${predicate.op === "lte" ? "at most" : "at least"} ${text(predicate.value)}`;
    case "network": return `${text(predicate.method, "Any method")} ${text(predicate.urlContains)}${predicate.status === undefined ? " returns a response" : ` returns ${text(predicate.status)}`}`;
    case "business-response": {
      const phase = predicate.phase === "acceptance" ? "Acceptance" : predicate.phase === "final" ? "Final persistence" : "Response";
      const expected = JSON.stringify(predicate.equals);
      return `${phase} contract for ${text(predicate.operationId)} at ${text(predicate.urlContains)}: ${text(predicate.path)} equals ${expected?.slice(0, 240) ?? "omitted"}${predicate.witness ? " with declared witness" : ""}`;
    }
    case "console": return `${predicate.absent === true ? "No" : "At least one"} console ${text(predicate.level)} observed`;
    case "signal": return `Signal “${text(predicate.name)}” is observed`;
    case "element": return `${text(predicate.selector)} is ${text(predicate.state)}`;
    case "state": {
      const expected = JSON.stringify(predicate.equals);
      const preview = expected === undefined ? "omitted" : expected.length > 240 ? `${expected.slice(0, 240)}…` : expected;
      return `${text(predicate.store)}${predicate.path ? `.${text(predicate.path)}` : ""} equals ${preview}`;
    }
    case "relative": {
      const target = predicate.target && typeof predicate.target === "object" ? predicate.target as Record<string, unknown> : {};
      const scope = target.kind === "element" ? `Matching elements for ${text(target.selector)}` : `${text(target.store)}${target.path ? `.${text(target.path)}` : ""}`;
      return `${scope} ${predicate.relation === "becomes" ? `became ${JSON.stringify(predicate.equals)?.slice(0, 240) ?? "omitted"}` : text(predicate.relation)} during the click`;
    }
    case "allOf": case "anyOf": {
      if (!Array.isArray(predicate.predicates)) return "Composite expectations omitted from retained context";
      return `${predicate.kind === "allOf" ? "All" : "Any"} of: ${predicate.predicates.slice(0, 20).map(item => expectedOutcome(item, depth + 1)).join("; ")}`;
    }
    default: return "Expected outcome omitted from retained context";
  }
}

function SavedReportContext({ context }: { context?: VerificationReportContext }) {
  if (!context) return <p className="text-[12px] text-rp-ink-muted">Saved check details are unavailable for this report.</p>;
  return <div className="space-y-3 pt-1 text-[13px]">
    <p className="rp-meta break-words">App: {context.origin}</p>
    {context.execution && <div aria-label="Saved browser execution context" className={cn(inset, "space-y-1 text-[12px]")}>
      <p className="font-medium text-rp-ink">Browser-observed context · {context.execution.engine} · {context.execution.ownership}</p>
      <p>Dispatch: {context.execution.dispatch} · Input: {context.execution.inputMode} · Generation {context.execution.generation}</p>
      <p className="text-rp-ink-muted">Saved execution context cannot restore browser authority. The declared outcome determines the verdict.</p>
      {context.execution.artifactIds?.length ? <p>{context.execution.artifactIds.length} private artifact references retained; files require local access.</p> : null}
    </div>}
    {context.executionOmitted && <p className={warningText}>Saved browser execution context is unavailable ({context.executionOmitted === "context-limit" ? "size limit" : "invalid retained metadata"}). Outcomes remain unchanged.</p>}
    {context.redacted && <p className={warningText}>Sensitive context was redacted. Some expected values may be omitted.</p>}
    {context.truncated && <p className={warningText}>Saved context is truncated. Some check details may be missing.</p>}
    {!context.checks.length && <p className="text-rp-ink-muted">No individual check details were retained.</p>}
    <ol className="space-y-3" aria-label="Saved expected outcomes">{context.checks.map((check, index) => <li key={index} className={cn(inset, "space-y-2.5 bg-rp-canvas-blue")}>
      <div className="flex flex-wrap items-center justify-between gap-2"><Eyebrow as="span" marker className="text-rp-ink">Expected outcome {check.step}</Eyebrow><span className={cn("text-[12px] font-semibold", check.status === "pass" ? "text-rp-success" : check.status === "fail" ? "text-rp-danger" : "text-rp-warning")}>{check.status === "pass" ? "Passed" : check.status === "fail" ? "Failed" : "Inconclusive"}</span></div>
      <p className="break-words font-medium leading-[1.6] text-rp-ink">{expectedOutcome(check.predicate)}</p>
      <p className="break-words text-[12px] leading-[1.7] text-rp-ink-muted">{check.reason}</p>
      {check.performance && <PerformanceReadings snapshot={check.performance.snapshot} retained />}
      {check.performanceOmitted && <p className={warningText}>Native performance evidence unavailable: {check.performanceOmitted === "context-limit" ? "optional snapshot omitted to preserve the report’s outcome budget" : "stored snapshot failed validation"}. The evaluated outcome and reason remain retained.</p>}
      <div className="rp-meta flex flex-wrap gap-x-4 gap-y-1"><span>{check.complete ? "Complete capture" : "Incomplete capture"}</span><span>{check.dropped} events dropped</span><span>{check.settled ? `Settled: ${context.quietMs} ms quiet` : "Did not settle"}</span></div>
      {(check.controlSource || check.controlSourceOmitted) && <div className={cn(inset, "space-y-2 text-[12px]")} aria-label="Control source context">
        <p className="font-medium text-rp-ink">SDK-reported React source{check.controlSource && " · Before dispatch"}</p>
        {check.controlSourceOmitted ? <p className="text-rp-ink-muted">Source unavailable. Location omitted to keep the saved report within its size limit.</p> : check.controlSource?.observation.status === "captured" ? <>
          <p className="break-words">{check.controlSource.observation.component && <span>{check.controlSource.observation.component} · </span>}<code className="break-all font-mono text-rp-blue">{check.controlSource.observation.file}:{check.controlSource.observation.line}{check.controlSource.observation.column ? `:${check.controlSource.observation.column}` : ""}</code></p>
          <p className="text-rp-ink-muted">{check.controlSource.observation.mechanism === "dev-stamp" ? "Development stamp" : "React development metadata"} · {check.controlSource.observation.scope === "control" ? "Acted control" : "Component ancestor"} · Action generation {check.controlSource.generation}</p>
        </> : <p className="text-rp-ink-muted">Source unavailable. {check.controlSource?.observation.status === "unavailable" && sourceReasons[check.controlSource.observation.reason]}</p>}
        <p className="leading-[1.7] text-rp-ink-muted">Source context helps locate code. The observed outcome determines this check’s verdict.</p>
        {check.controlSource && !check.complete && <p className="leading-[1.7] text-rp-warning">Capture is incomplete. This source was retained before the action; it cannot establish the outcome.</p>}
      </div>}
      {check.causal && <div className={cn(inset, "space-y-2 text-[12px]")} aria-label="Action transition readings">
        <p className="font-medium text-rp-ink">SDK-reported action result · {check.causal.attribution === "captured" ? "Matched captured readings" : "Attribution unavailable"}</p>
        <p className="leading-[1.7] text-rp-ink-muted">These saved readings describe the synchronous click. Asynchronous business completion needs a declared operation.</p>
        {check.causal.omitted && <p className="text-rp-warning">Readings were omitted to keep the saved report within its size limit.</p>}
        <ul className="space-y-2">{check.causal.readings.map((pair, at) => <li className="min-w-0 space-y-1 break-words" key={at}>
          <p>{pair.target.kind === "element" ? pair.target.selector : `${pair.target.store}${pair.target.path ? `.${pair.target.path}` : ""}`}</p>
          <p>Before: {pair.before ? `${JSON.stringify(pair.before.value)?.slice(0, 400) ?? "unavailable"} (${pair.before.availability})` : "unavailable"}</p>
          <p>After: {pair.after ? `${JSON.stringify(pair.after.value)?.slice(0, 400) ?? "unavailable"} (${pair.after.availability})` : "unavailable"}</p>
        </li>)}</ul>
      </div>}
      <details><summary className={summary}>Capture details</summary><dl className="mt-2 space-y-2 text-[12px] text-rp-ink">
        <div><dt className="rp-meta">Observation window</dt><dd className="break-words">After cursor {check.since} through {check.through}. The starting cursor is excluded.</dd></div>
        <div><dt className="rp-meta">App connection generation</dt><dd className="rp-num">{check.generation}</dd></div>
        <div><dt className="rp-meta">Observer coverage during this check</dt><dd className="mt-1 flex flex-wrap gap-x-3 gap-y-1">{Object.entries(check.coverage).map(([observer, present]) => <span key={observer} className={present ? "text-rp-ink-muted" : "text-rp-warning"}>{observer}: {present ? "observed" : "unavailable"}</span>)}</dd></div>
      </dl></details>
    </li>)}</ol>
  </div>;
}

const unavailableReasons: Record<string, string> = {
  "not-git": "The selected directory is not a Git repository.", "workspace-is-not-git-root": "Select the repository root explicitly.",
  "unborn-head": "This repository has no committed revision.", "unsupported-git-storage": "This Git storage or remote object configuration is unsupported.",
  "git-metadata-unavailable": "Required Git metadata is unavailable or exceeds its bound.", "git-metadata-changed": "Git metadata changed during this read.",
  "git-read-failed": "Git could not provide this metadata.", "git-unavailable": "Git is unavailable.", "deadline": "The one-second read deadline was reached.",
  "git-output-limit": "Git output exceeded its byte limit.", "git-error-limit": "Git error output exceeded its byte limit.", "invalid-utf8": "Git output was not valid UTF-8.",
  "invalid-git-records": "Git records could not be safely interpreted.", "invalid-head": "The revision metadata was invalid.", "invalid-git-count": "A change count was invalid.",
  "path-unavailable": "Sensitive, unsafe or oversized paths were withheld.", "row-limit": "The changed-file row limit was reached.",
  "untracked-content-unavailable": "Untracked content is unavailable; only file metadata is retained.", "untracked-metadata-unavailable": "Some untracked file metadata is unavailable.",
  "untracked-metadata-limit": "The untracked metadata limit was reached.", "merge-conflict": "Some files have unresolved conflicts.",
  "test-inventory-limit": "The tracked test inventory limit was reached.", "related-test-limit": "The related-test hint limit was reached.", "response-limit": "Some rows were omitted to keep this response bounded.",
};

function ChangeReview({ report }: { report: VerificationReport }) {
  const [offer, setOffer] = useState<ChangeWorkspaceOffer>();
  const [selected, setSelected] = useState(false);
  const [result, setResult] = useState<VerificationChangeContext>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const request = useRef<AbortController | null>(null);
  const revision = useRef(""); revision.current = JSON.stringify(report);
  useEffect(() => () => request.current?.abort(), []);
  const cancel = () => { request.current?.abort(); request.current = null; setBusy(false); setOffer(undefined); setSelected(false); setResult(undefined); setMessage("Review cancelled. The saved report is unchanged."); };
  const run = async (capture: boolean) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const retainedRevision = revision.current; const retainedOffer = offer;
    const current = () => !controller.signal.aborted && request.current === controller && revision.current === retainedRevision;
    setBusy(true); setMessage(""); setResult(undefined);
    try {
      if (capture) {
        if (!selected || !retainedOffer || retainedOffer.expiresAt <= Date.now()) throw new Error("Choose the current workspace again before reviewing changes.");
        const value = await verificationApi.captureChangeContext(report.id, retainedOffer.workspaceId, controller.signal);
        if (!current()) return;
        if (value.handoff.reportId !== report.id || value.handoff.status !== report.status) throw new Error("The retained report changed. Review it again.");
        setResult(value); setOffer(undefined); setSelected(false);
      } else {
        const value = await verificationApi.changeWorkspace(controller.signal);
        if (!current()) return; setOffer(value); setSelected(false);
      }
    } catch (error) { if (current()) { setOffer(undefined); setSelected(false); setMessage(error instanceof Error ? error.message : "Workspace context is unavailable."); } }
    finally { if (current()) { setBusy(false); request.current = null; } }
  };
  const copy = async () => {
    if (!result) return; const retainedRevision = revision.current; const retained = result;
    try { await navigator.clipboard.writeText(JSON.stringify(retained.handoff)); if (revision.current === retainedRevision) setMessage("Measured failure handoff copied."); }
    catch { if (revision.current === retainedRevision) setMessage("Clipboard is unavailable. Select the handoff text below to copy it."); }
  };
  return <section aria-label="Change-aware QA and failure handoff" className="space-y-3 rounded-md border border-rp-line bg-white p-4 text-[13px] text-rp-ink sm:p-5">
    <div><Eyebrow marker>Handoff / Workspace changes</Eyebrow><h3 className="rp-subsection-title mt-2">Change-aware QA</h3></div>
    <p className={fine}>Review bounded metadata from the workspace you explicitly selected. Related tests are filename suggestions. This review runs no tests and changes no saved verdict.</p>
    {!offer && !busy && <Button size="lg" variant="outline" onClick={() => void run(false)}>Prepare failure handoff</Button>}
    {offer && <div className="rp-fade-rise space-y-3 rounded-md border border-rp-wash-border bg-rp-wash p-3">
      <label className="flex min-h-11 items-center gap-3"><input type="checkbox" className={cn(checkbox, "mt-0")} checked={selected} disabled={busy} onChange={event => setSelected(event.target.checked)} /><span className="min-w-0 break-words">Use selected workspace: <strong>{offer.label}</strong></span></label>
      <p className={fine}>The selection expires after one minute. Git may read worktree files to compute counts; retained output contains metadata only.</p>
      <Button size="lg" disabled={!selected || busy} onClick={() => void run(true)}>Review selected changes</Button>
    </div>}
    {busy && <p role="status" className="text-rp-ink-muted">Reading bounded workspace metadata…</p>}
    {(busy || offer) && <Button size="lg" variant="outline" onClick={cancel}>Cancel review</Button>}
    {message && <p role="status" className="break-words text-[12px] text-rp-ink-muted">{message}</p>}
    {result && <div className="rp-fade-rise space-y-3 border-t border-rp-line-muted pt-3 text-[12px] leading-[1.7]">
      <p className="text-[13px]"><strong>Saved measured outcome: {result.handoff.status}</strong>. {result.handoff.reason}</p>
      <p className="break-words">Git HEAD observed after the saved report: <code className="break-all font-mono">{result.head ?? "unavailable"}</code>. Tested revision: unavailable.</p>
      <p>{result.complete ? "Metadata capture complete within its bounds." : "Metadata capture incomplete."} {result.withheldPaths} path records withheld; at least {result.omittedRows} rows omitted.</p>
      {result.reasons.length > 0 && <ul className="list-disc space-y-1 pl-5">{result.reasons.map(reason => <li key={reason}>{unavailableReasons[reason] ?? "Some metadata is unavailable."}</li>)}</ul>}
      <p className="break-words">Metadata-only fingerprint: <code className="break-all font-mono">{result.fingerprint ?? "unavailable"}</code>. It does not fingerprint untracked contents.</p>
      {!result.changes.length && <p className="text-rp-ink-muted">No changed-file rows were retained.</p>}
      <ul className="divide-y divide-rp-line-muted rounded-sm border border-rp-line" aria-label="Changed file metadata">{result.changes.map((row, index) => <li key={index} className="break-words px-3 py-2"><code className="break-all font-mono text-rp-ink">{row.previousPath ? `${row.previousPath} → ` : ""}{row.path}</code><p className="text-rp-ink-muted">Index {row.index}; worktree {row.worktree}; {row.binary === true ? "binary" : row.binary === false ? `+${row.added} / −${row.deleted}` : "counts unavailable"}{row.bytes === undefined ? "" : `; ${row.bytes} bytes`}. Contents unavailable.</p></li>)}</ul>
      <h4 className="rp-field-label pt-1">Advisory related tests</h4>
      {!result.relatedTests.length && <p className="text-rp-ink-muted">No filename match was retained. This does not establish test coverage.</p>}
      <ul className="space-y-1">{result.relatedTests.map(hint => <li className="break-words" key={hint.path}><code className="break-all font-mono">{hint.path}</code> · Filename match; not executed</li>)}</ul>
      <ul className="list-disc space-y-1 pl-5">{result.suggestions.map(hint => <li key={hint.kind}>{hint.text}</li>)}</ul>
      <h4 className="rp-field-label pt-1">Measured failure handoff</h4><p>{result.handoff.reproductionNote}</p>
      {(result.handoff.redacted || result.handoff.truncated) && <p>Some retained details were redacted or omitted. {result.handoff.checksOmitted} checks omitted.</p>}
      <Button size="lg" variant="outline" onClick={() => void copy()}>Copy measured handoff</Button>
      <details><summary className={cn(summary, "flex min-h-11 items-center")}>Retained handoff JSON</summary><pre className={cn(well, "max-h-80 whitespace-pre-wrap break-all font-mono text-[12px]")}>{JSON.stringify(result.handoff, null, 2)}</pre></details>
    </div>}
  </section>;
}

/** Optional report integration stays inactive until the application explicitly supplies a saved report. */
export function ReportContext({ context, report }: { context?: VerificationReportContext; report?: VerificationReport }) {
  return <div className="space-y-4"><SavedReportContext context={context} />{report && <ChangeReview key={`${report.id}:${JSON.stringify(report)}`} report={report} />}</div>;
}
