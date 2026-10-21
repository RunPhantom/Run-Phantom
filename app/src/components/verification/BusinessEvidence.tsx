import { useId } from "react";
import type { RuntimeEvent } from "../../api/verification";
import { bodyFailureFindings } from "../../../../src/verification/business-evidence";

export function BusinessEvidence({ events, enabled, connected, retained = false }: { events: RuntimeEvent[]; enabled: boolean; connected: boolean; retained?: boolean }) {
  const heading = useId();
  const latest = new Map<unknown, RuntimeEvent>();
  for (const event of [...events].sort((a, b) => a.t - b.t)) if (event.type === "network.body") latest.set(event.data.requestId, event);
  return <section aria-labelledby={heading} className="space-y-3 border-t border-[color:var(--rp-border)] pt-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 id={heading} className="text-sm font-semibold text-[color:var(--rp-ink-strong)]">Response evidence</h2><span className="text-[11px] text-[color:var(--rp-ink-muted)]">{retained ? "Saved evidence" : !connected ? "Disconnected" : enabled ? "Capture enabled" : "Capture off"}</span></div>
    <p className="text-xs leading-relaxed text-[color:var(--rp-ink-soft)]">{enabled ? "Bounded response copies reported by the app. Completion records a readable stream ending; it does not authenticate server persistence." : "Off by default. Enable response evidence when pairing, then connect with the updated setup."}</p>
    {latest.size === 0 && <p className="text-xs text-[color:var(--rp-ink-muted)]">No response bodies captured in this interval.</p>}
    <ul className="space-y-3">{[...latest.values()].reverse().slice(0, 12).map(event => {
      const data = event.data;
      const findings = data.state === "complete" ? bodyFailureFindings(data.body) : [];
      return <li key={String(data.requestId)} className="space-y-2 rounded-md border border-[color:var(--rp-border)] p-3 text-xs">
        <div className="flex flex-wrap justify-between gap-2"><span className="min-w-0 break-all font-medium">{String(data.method)} {String(data.url)}</span><span>{String(data.state)}{event.truncated ? " · partial evidence" : ""}</span></div>
        <p className="text-[11px] text-[color:var(--rp-ink-muted)]">Request {String(data.requestId)} · {String(data.bytes)} bytes · {String(data.chunks)} chunks · HTTP {String(data.status)}</p>
        {(data.state !== "complete" || event.truncated || data.redacted === true) && <p className="text-[color:var(--rp-warning)]">Business outcome unknown. Incomplete bodies are withheld; redacted content cannot prove the contract.</p>}
        {findings.length > 0 && <div className="space-y-1"><p className="font-medium">Possible business failure</p><ul className="list-inside list-disc text-[color:var(--rp-ink-soft)]">{findings.map(finding => <li key={finding.path}>{finding.reason}: {finding.path}</li>)}</ul><p className="text-[11px] text-[color:var(--rp-ink-muted)]">Advisory until an explicit contract declares the expected response.</p></div>}
        {Object.prototype.hasOwnProperty.call(data, "body") && <details><summary className="cursor-pointer">Redacted response body</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-[color:var(--rp-canvas)] p-2 text-[11px]">{JSON.stringify(data.body, null, 2)}</pre></details>}
      </li>;
    })}</ul>
  </section>;
}
