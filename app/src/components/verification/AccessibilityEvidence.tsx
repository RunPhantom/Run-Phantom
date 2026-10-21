import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import type { BrowserSummary } from "../../../../src/verification/browser-types";
import type { AccessibilityEvidence as Evidence, AccessibilityRequest, AccessibilityRule } from "../../../../src/verification/accessibility-types";

const rules: Array<{ id: AccessibilityRule; label: string }> = [
  { id: "button-name", label: "Button names" }, { id: "image-alt", label: "Image alternatives" },
  { id: "label", label: "Form labels" }, { id: "color-contrast", label: "Text contrast" },
];
const losses: Record<string, string> = {
  "engine-unavailable": "The engine did not produce a completed result.", "engine-identity": "Engine identity could not be verified.",
  "engine-result-invalid": "The engine result could not be validated.", "region-unavailable": "A selected region was unavailable.",
  "rule-unavailable": "A requested rule was not covered.", "review-required": "Some nodes need manual review.",
  "no-applicable-nodes": "No applicable nodes were tested.", "closed-shadow-root": "Closed shadow content was inaccessible.",
  "iframe-excluded": "Embedded content was outside the audit scope.", "root-inventory-limit": "The page scope exceeded the node or metadata limit.",
  "root-inventory-unavailable": "Native root coverage could not be established.", "finding-limit": "The finding display limit omitted results.",
  "target-redacted": "Private selector text was redacted.", "target-unavailable": "Some selectors could not be retained safely.",
  "output-limit": "The output budget omitted findings.", "population-limit": "The engine population exceeded the limit.",
  "document-changed": "The page or selected roots changed during the audit.", "engine-timeout": "The audit timed out and the owned connection was closed.",
  "unsupported-browser": "This connection does not support the initial audit adapter.",
};
const title = (status: Evidence["status"]) => status === "no-findings" ? "No findings in selected scope" : status === "findings" ? "Accessibility findings" : "Audit inconclusive";

export function AccessibilityEvidence({ session, ready, epoch, runAudit, onComplete }: {
  session?: BrowserSummary; ready: boolean; epoch: number;
  runAudit: (request: AccessibilityRequest) => Promise<Evidence>; onComplete: () => void;
}) {
  const [regionText, setRegionText] = useState("");
  const [selectedRules, setSelectedRules] = useState<AccessibilityRule[]>(rules.map(rule => rule.id));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [completed, setCompleted] = useState<{ scope: string; evidence: Evidence }>();
  const currentScope = `${session?.id ?? ""}:${session?.generation ?? ""}:${epoch}`;
  const result = completed?.scope === currentScope ? completed.evidence : undefined;
  const scope = useRef(currentScope), ticket = useRef(0);
  // Fence responses during render; an effect alone leaves a late-response window.
  if (scope.current !== currentScope) { scope.current = currentScope; ticket.current++; }
  useEffect(() => { setCompleted(undefined); setBusy(false); setError(""); }, [currentScope]);
  useEffect(() => () => { ticket.current++; }, []);
  const supported = session?.ownership === "owned" && session.engine === "chromium";
  const regions = regionText.split("\n").map(value => value.trim()).filter(Boolean);
  const audit = async () => {
    if (!session || !ready || !supported || busy) return;
    const expected = ++ticket.current, captured = scope.current;
    setBusy(true); setError(""); setCompleted(undefined);
    try {
      const next = await runAudit({ generation: session.generation, rules: [...selectedRules], regions });
      if (ticket.current !== expected || scope.current !== captured) return;
      if (next.sessionId !== session.id || next.generation !== session.generation) throw new Error("scope");
      setCompleted({ scope: captured, evidence: next });
    } catch { if (ticket.current === expected && scope.current === captured) setError("Audit unavailable. Check the selected connection and explicit scope."); }
    finally { if (ticket.current === expected && scope.current === captured) setBusy(false); onComplete(); }
  };
  return <section aria-labelledby="accessibility-evidence-heading" className="min-w-0 space-y-4 border-t border-[color:var(--rp-border)] pt-4">
    <header className="space-y-2"><h3 id="accessibility-evidence-heading" className="text-sm font-semibold text-[color:var(--rp-ink-strong)]">Accessibility evidence</h3>
      <p className="text-xs leading-relaxed text-[color:var(--rp-ink-soft)]">Run an explicit audit of selected rules and page regions. Automated evidence covers this scope; manual accessibility checks remain necessary.</p>
      <p className="text-[11px] leading-relaxed text-[color:var(--rp-ink-muted)]">Selected engine: axe-core 4.11.0. Initial support requires an owned Chromium connection. Embedded frames and closed shadow content cannot establish complete coverage.</p>
    </header>
    <fieldset disabled={busy} className="space-y-1"><legend className="mb-1 text-xs font-medium">Audit rules</legend><div className="grid gap-x-4 sm:grid-cols-2">{rules.map(rule => <label key={rule.id} className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked={selectedRules.includes(rule.id)} onChange={event => setSelectedRules(previous => event.target.checked ? [...previous, rule.id] : previous.filter(id => id !== rule.id))} />{rule.label}</label>)}</div></fieldset>
    <div className="space-y-2 text-xs font-medium"><label htmlFor="accessibility-regions" className="block">Audit regions</label>
      <textarea id="accessibility-regions" value={regionText} onChange={event => setRegionText(event.target.value)} disabled={busy} rows={3} placeholder={'#checkout\n#navigation'}
        className="min-h-11 w-full rounded-md border border-[color:var(--rp-border)] bg-[color:var(--rp-surface)] px-3 py-2 font-mono text-xs font-normal outline-none focus-visible:border-[color:var(--rp-accent)] focus-visible:ring-2 focus-visible:ring-[color:var(--rp-accent)]" aria-describedby="accessibility-region-hint" />
    </div>
    <p id="accessibility-region-hint" className="text-[11px] leading-relaxed text-[color:var(--rp-ink-muted)]">One to four exact CSS roots, one per line. Each must match a single visible main-document region. No audit runs automatically. HTML, entered text, and raw check messages are excluded from evidence.</p>
    <div className="flex flex-wrap items-center gap-3"><Button className="min-h-11" type="button" disabled={!ready || !supported || busy || !selectedRules.length || !regions.length || regions.length > 4} onClick={() => void audit()}>Run accessibility audit</Button>
      <p aria-live="polite" className="min-w-0 break-words text-xs text-[color:var(--rp-ink-soft)]">{busy ? "Auditing selected page regions…" : !session ? "Select an explicit browser connection." : !supported ? "Audit adapter unavailable for this connection." : result ? title(result.status) : "Audit has not run."}</p>
    </div>
    {error && <p role="alert" className="break-words text-xs text-[color:var(--rp-danger)]">{error}</p>}
    {result && <article aria-label="Accessibility audit result" className="min-w-0 space-y-3 rounded-md border border-[color:var(--rp-border)] p-3 text-xs">
      <h4 className="font-semibold">{title(result.status)}</h4>
      <p className="text-[color:var(--rp-ink-soft)]">{result.engine.name} {result.engine.version} · Generation {result.generation} · Coverage {result.coverage}</p>
      <p>{result.population.retained} findings shown · Total {result.population.total ?? "unknown"} · {result.population.dropped} known findings omitted</p>
      {!!result.loss.length && <ul className="list-disc space-y-1 pl-4 text-[color:var(--rp-warning)]">{result.loss.map(reason => <li key={reason}>{losses[reason]}</li>)}</ul>}
      <div className="space-y-3">{result.regions.map(region => <section key={region.region} aria-label={`Audit region ${region.region}`} className="min-w-0 space-y-2"><p className="break-all font-mono">{region.region} · {region.coverage}</p><ul className="space-y-1 text-[color:var(--rp-ink-soft)]">{region.rules.map(rule => <li key={rule.rule}>{rules.find(item => item.id === rule.rule)?.label}: {rule.observed ? rule.inapplicable ? "inapplicable" : `${rule.passed} passed, ${rule.violations} findings, ${rule.incomplete} need review` : "coverage unavailable"}</li>)}</ul></section>)}</div>
      {!!result.findings.length && <ol className="space-y-3 border-t border-[color:var(--rp-border)] pt-3">{result.findings.map((finding, index) => <li key={index} className="min-w-0 space-y-1"><p className="font-medium">{rules.find(item => item.id === finding.rule)?.label} · {finding.impact ?? "unspecified impact"}</p><p className="break-all font-mono">Region {finding.region}</p><code className="block break-all text-[color:var(--rp-ink-soft)]">{finding.target.map(part => Array.isArray(part) ? part.join(" → ") : part).join(" → ")}</code></li>)}</ol>}
    </article>}
  </section>;
}
