import type { VerificationReportContext } from "../../api/verification";

function expectedOutcome(value: unknown, depth = 0): string {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 6) return "Expected outcome omitted from retained context";
  const predicate = value as Record<string, unknown>;
  const text = (value: unknown, fallback = "omitted") => typeof value === "string" || typeof value === "number" ? String(value) : fallback;
  switch (predicate.kind) {
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

export function ReportContext({ context }: { context?: VerificationReportContext }) {
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
