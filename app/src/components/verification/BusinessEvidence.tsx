import { useId } from "react";
import type { RuntimeEvent } from "../../api/verification";
import { Badge } from "../ui/badge";
import { SectionHead } from "./section";
import { bodyFailureFindings } from "../../../../src/verification/business-evidence";

export function BusinessEvidence({ events, enabled, connected, retained = false }: { events: RuntimeEvent[]; enabled: boolean; connected: boolean; retained?: boolean }) {
  const heading = useId();
  const latest = new Map<unknown, RuntimeEvent>();
  for (const event of [...events].sort((a, b) => a.t - b.t)) if (event.type === "network.body") latest.set(event.data.requestId, event);
  return <section aria-labelledby={heading} className={retained ? "space-y-3 border-t border-rp-line-muted pt-4" : "space-y-4"}>
    {retained ? <div className="flex flex-wrap items-center justify-between gap-2"><h2 id={heading} className="text-[14px] font-semibold text-rp-ink">Response evidence</h2><span className="rp-meta">Saved evidence</span></div>
      : <SectionHead eyebrow="Network / Response bodies" title="Response evidence" id={heading} aside={<Badge tone={!connected ? "warning" : enabled ? "accent" : "neutral"}>{!connected ? "App disconnected" : enabled ? "Capture enabled" : "Capture off"}</Badge>} />}
    <p className="max-w-[70ch] text-[13px] leading-[1.7] text-rp-ink-muted">{enabled ? "Bounded response copies reported by the app. Completion records a readable stream ending; it does not authenticate server persistence." : "Off by default. Enable response evidence when pairing, then connect with the updated setup."}</p>
    {latest.size === 0 && <p className="rounded-md border border-dashed border-[color:var(--rp-line-dashed)] px-4 py-4 text-[13px] text-rp-ink-muted">No response bodies captured in this interval.</p>}
    <ul className="space-y-3">{[...latest.values()].reverse().slice(0, 12).map(event => {
      const data = event.data;
      const findings = data.state === "complete" ? bodyFailureFindings(data.body) : [];
      return <li key={String(data.requestId)} className="rp-fade-rise space-y-2 rounded-md border border-rp-line bg-white p-3 text-[13px] text-rp-ink">
        <div className="flex flex-wrap justify-between gap-2"><span className="min-w-0 break-all font-mono text-[12px] font-medium">{String(data.method)} {String(data.url)}</span><span className="text-[12px] text-rp-ink-muted">{String(data.state)}{event.truncated ? " · partial evidence" : ""}</span></div>
        <p className="rp-meta">Request {String(data.requestId)} · {String(data.bytes)} bytes · {String(data.chunks)} chunks · HTTP {String(data.status)}</p>
        {(data.state !== "complete" || event.truncated || data.redacted === true) && <p className="text-[12px] text-rp-warning">Business outcome unknown. Incomplete bodies are withheld; redacted content cannot prove the contract.</p>}
        {findings.length > 0 && <div className="space-y-1"><p className="font-medium text-rp-danger">Possible business failure</p><ul className="list-inside list-disc text-rp-ink-muted">{findings.map(finding => <li key={finding.path}>{finding.reason}: {finding.path}</li>)}</ul><p className="text-[12px] text-rp-ink-muted">Advisory until an explicit contract declares the expected response.</p></div>}
        {Object.prototype.hasOwnProperty.call(data, "body") && <details><summary className="cursor-pointer select-none py-1 text-[12px] font-medium text-rp-ink-muted transition-colors duration-250 ease-standard hover:text-rp-ink">Redacted response body</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-rp-line-muted bg-rp-canvas-blue p-3 font-mono text-[12px]">{JSON.stringify(data.body, null, 2)}</pre></details>}
      </li>;
    })}</ul>
  </section>;
}
