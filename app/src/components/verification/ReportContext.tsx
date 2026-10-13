import { useEffect, useRef, useState } from "react";
import { verificationApi, type ChangeWorkspaceOffer, type VerificationChangeContext, type VerificationReport, type VerificationReportContext } from "../../api/verification";

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
    case "network": return `${text(predicate.method, "Any method")} ${text(predicate.urlContains)}${predicate.status === undefined ? " returns a response" : ` returns ${text(predicate.status)}`}`;
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
  if (!context) return <p className="text-[11px] text-[color:var(--rp-ink-muted)]">Saved check details are unavailable for this report.</p>;
  return <div className="space-y-3 pt-1 text-xs">
    <p className="break-words text-[color:var(--rp-ink-soft)]">App: {context.origin}</p>
    {context.redacted && <p className="text-[color:var(--rp-warning)]">Sensitive context was redacted. Some expected values may be omitted.</p>}
    {context.truncated && <p className="text-[color:var(--rp-warning)]">Saved context is truncated. Some check details may be missing.</p>}
    {!context.checks.length && <p className="text-[color:var(--rp-ink-muted)]">No individual check details were retained.</p>}
    <ol className="space-y-3" aria-label="Saved expected outcomes">{context.checks.map((check, index) => <li key={index} className="space-y-2 rounded-md border border-[color:var(--rp-border)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium text-[color:var(--rp-ink-strong)]">Expected outcome {check.step}</span><span className="text-[11px] font-medium" style={{ color: check.status === "pass" ? "var(--rp-success)" : check.status === "fail" ? "var(--rp-danger)" : "var(--rp-warning)" }}>{check.status === "pass" ? "Passed" : check.status === "fail" ? "Failed" : "Inconclusive"}</span></div>
      <p className="break-words leading-relaxed">{expectedOutcome(check.predicate)}</p>
      <p className="break-words text-[11px] leading-relaxed text-[color:var(--rp-ink-soft)]">{check.reason}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[color:var(--rp-ink-soft)]"><span>{check.complete ? "Complete capture" : "Incomplete capture"}</span><span>{check.dropped} events dropped</span><span>{check.settled ? `Settled: ${context.quietMs} ms quiet` : "Did not settle"}</span></div>
      {(check.controlSource || check.controlSourceOmitted) && <div className="space-y-2 rounded-md border border-[color:var(--rp-border)] p-3 text-[11px]" aria-label="Control source context">
        <p className="font-medium">SDK-reported React source{check.controlSource && " · Before dispatch"}</p>
        {check.controlSourceOmitted ? <p className="text-[color:var(--rp-ink-soft)]">Source unavailable. Location omitted to keep the saved report within its size limit.</p> : check.controlSource?.observation.status === "captured" ? <>
          <p className="break-words">{check.controlSource.observation.component && <span>{check.controlSource.observation.component} · </span>}<code className="break-all">{check.controlSource.observation.file}:{check.controlSource.observation.line}{check.controlSource.observation.column ? `:${check.controlSource.observation.column}` : ""}</code></p>
          <p className="text-[color:var(--rp-ink-soft)]">{check.controlSource.observation.mechanism === "dev-stamp" ? "Development stamp" : "React development metadata"} · {check.controlSource.observation.scope === "control" ? "Acted control" : "Component ancestor"} · Action generation {check.controlSource.generation}</p>
        </> : <p className="text-[color:var(--rp-ink-soft)]">Source unavailable. {check.controlSource?.observation.status === "unavailable" && sourceReasons[check.controlSource.observation.reason]}</p>}
        <p className="leading-relaxed text-[color:var(--rp-ink-soft)]">Source context helps locate code. The observed outcome determines this check’s verdict.</p>
        {check.controlSource && !check.complete && <p className="leading-relaxed text-[color:var(--rp-warning)]">Capture is incomplete. This source was retained before the action; it cannot establish the outcome.</p>}
      </div>}
      {check.causal && <div className="space-y-2 rounded-md border border-[color:var(--rp-border)] p-3 text-[11px]" aria-label="Action transition readings">
        <p className="font-medium">SDK-reported action result · {check.causal.attribution === "captured" ? "Matched captured readings" : "Attribution unavailable"}</p>
        <p className="leading-relaxed text-[color:var(--rp-ink-soft)]">These saved readings describe the synchronous click. Asynchronous business completion needs a declared operation.</p>
        {check.causal.omitted && <p className="text-[color:var(--rp-warning)]">Readings were omitted to keep the saved report within its size limit.</p>}
        <ul className="space-y-2">{check.causal.readings.map((pair, at) => <li className="min-w-0 space-y-1 break-words" key={at}>
          <p>{pair.target.kind === "element" ? pair.target.selector : `${pair.target.store}${pair.target.path ? `.${pair.target.path}` : ""}`}</p>
          <p>Before: {pair.before ? `${JSON.stringify(pair.before.value)?.slice(0, 400) ?? "unavailable"} (${pair.before.availability})` : "unavailable"}</p>
          <p>After: {pair.after ? `${JSON.stringify(pair.after.value)?.slice(0, 400) ?? "unavailable"} (${pair.after.availability})` : "unavailable"}</p>
        </li>)}</ul>
      </div>}
      <details><summary className="cursor-pointer text-[11px] text-[color:var(--rp-ink-soft)]">Capture details</summary><dl className="mt-2 space-y-2 text-[11px]">
        <div><dt className="text-[color:var(--rp-ink-muted)]">Observation window</dt><dd className="break-words">After cursor {check.since} through {check.through}. The starting cursor is excluded.</dd></div>
        <div><dt className="text-[color:var(--rp-ink-muted)]">App connection generation</dt><dd>{check.generation}</dd></div>
        <div><dt className="text-[color:var(--rp-ink-muted)]">Observer coverage during this check</dt><dd className="mt-1 flex flex-wrap gap-x-3 gap-y-1">{Object.entries(check.coverage).map(([observer, present]) => <span key={observer} style={{ color: present ? "var(--rp-ink-soft)" : "var(--rp-warning)" }}>{observer}: {present ? "observed" : "unavailable"}</span>)}</dd></div>
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
  const actionStyle = { minHeight: 44, padding: "10px 14px", borderRadius: 8, border: "1px solid #CDD5E4", fontWeight: 600 };
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
  return <section aria-label="Change-aware QA and failure handoff" className="space-y-3 rounded-lg border p-4" style={{ background: "#F9FAFC", color: "#1D2739", borderColor: "#CDD5E4", fontFamily: "Inter, sans-serif" }}>
    <style>{'@font-face{font-family:Syne;src:url(/fonts/syne-variable.ttf) format("truetype");font-weight:400 800;font-display:swap}'}</style>
    <h3 style={{ fontFamily: "Syne, sans-serif", fontWeight: 700, fontSize: 18 }}>Change-aware QA</h3>
    <p className="text-xs leading-relaxed">Review bounded metadata from the workspace you explicitly selected. Related tests are filename suggestions. This review runs no tests and changes no saved verdict.</p>
    {!offer && !busy && <button type="button" style={{ ...actionStyle, background: "#0021CC", color: "white" }} onClick={() => void run(false)}>Prepare failure handoff</button>}
    {offer && <div className="space-y-3 rounded-md border p-3">
      <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={selected} disabled={busy} onChange={event => setSelected(event.target.checked)} /><span className="min-w-0 break-words">Use selected workspace: <strong>{offer.label}</strong></span></label>
      <p className="text-xs">The selection expires after one minute. Git may read worktree files to compute counts; retained output contains metadata only.</p>
      <button type="button" disabled={!selected || busy} style={{ ...actionStyle, background: "#0021CC", color: "white", opacity: !selected || busy ? 0.5 : 1 }} onClick={() => void run(true)}>Review selected changes</button>
    </div>}
    {busy && <p role="status">Reading bounded workspace metadata…</p>}
    {(busy || offer) && <button type="button" style={actionStyle} onClick={cancel}>Cancel review</button>}
    {message && <p role="status" className="break-words text-xs">{message}</p>}
    {result && <div className="space-y-3 text-xs">
      <p><strong>Saved measured outcome: {result.handoff.status}</strong>. {result.handoff.reason}</p>
      <p className="break-words">Git HEAD observed after the saved report: <code className="break-all">{result.head ?? "unavailable"}</code>. Tested revision: unavailable.</p>
      <p>{result.complete ? "Metadata capture complete within its bounds." : "Metadata capture incomplete."} {result.withheldPaths} path records withheld; at least {result.omittedRows} rows omitted.</p>
      {result.reasons.length > 0 && <ul className="list-disc space-y-1 pl-5">{result.reasons.map(reason => <li key={reason}>{unavailableReasons[reason] ?? "Some metadata is unavailable."}</li>)}</ul>}
      <p className="break-words">Metadata-only fingerprint: <code className="break-all">{result.fingerprint ?? "unavailable"}</code>. It does not fingerprint untracked contents.</p>
      {!result.changes.length && <p>No changed-file rows were retained.</p>}
      <ul className="space-y-2" aria-label="Changed file metadata">{result.changes.map((row, index) => <li key={index} className="break-words rounded border p-2"><code className="break-all">{row.previousPath ? `${row.previousPath} → ` : ""}{row.path}</code><p>Index {row.index}; worktree {row.worktree}; {row.binary === true ? "binary" : row.binary === false ? `+${row.added} / −${row.deleted}` : "counts unavailable"}{row.bytes === undefined ? "" : `; ${row.bytes} bytes`}. Contents unavailable.</p></li>)}</ul>
      <h4 className="font-semibold">Advisory related tests</h4>
      {!result.relatedTests.length && <p>No filename match was retained. This does not establish test coverage.</p>}
      <ul className="space-y-1">{result.relatedTests.map(hint => <li className="break-all" key={hint.path}><code>{hint.path}</code> · Filename match; not executed</li>)}</ul>
      <ul className="list-disc space-y-1 pl-5">{result.suggestions.map(hint => <li key={hint.kind}>{hint.text}</li>)}</ul>
      <h4 className="font-semibold">Measured failure handoff</h4><p>{result.handoff.reproductionNote}</p>
      {(result.handoff.redacted || result.handoff.truncated) && <p>Some retained details were redacted or omitted. {result.handoff.checksOmitted} checks omitted.</p>}
      <button type="button" style={actionStyle} onClick={() => void copy()}>Copy measured handoff</button>
      <details><summary className="min-h-11 cursor-pointer py-3">Retained handoff JSON</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded border p-3">{JSON.stringify(result.handoff, null, 2)}</pre></details>
    </div>}
  </section>;
}

/** Optional report integration stays inactive until the application explicitly supplies a saved report. */
export function ReportContext({ context, report }: { context?: VerificationReportContext; report?: VerificationReport }) {
  return <div className="space-y-4"><SavedReportContext context={context} />{report && <ChangeReview key={`${report.id}:${JSON.stringify(report)}`} report={report} />}</div>;
}
