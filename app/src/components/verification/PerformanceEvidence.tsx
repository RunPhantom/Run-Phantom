import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Field, Select } from "./PredicateEditor";
import { verificationApi, type VerificationReport } from "../../api/verification";
import { parsePerformanceSnapshot, performanceClockComplete, performanceMetricUnit, PERFORMANCE_CHECK_METRICS, PERFORMANCE_OBSERVERS, type PerformanceMetric, type PerformanceSnapshot } from "../../../../src/verification/performance";

const labels: Record<PerformanceMetric, string> = {
  fcpMs: "First contentful paint", lcpMs: "Latest LCP candidate", navigationTtfbMs: "Navigation TTFB", navigationDomContentLoadedMs: "Document ready", navigationLoadMs: "Document load",
  clsMaxSessionScore: "Largest CLS session", qualifyingInteractionMaxMs: "Qualifying interaction maximum", longFrameBlockingMaxMs: "Long-frame blocking maximum", resourceCount: "Completed resources", resourceTransferBytes: "Resource transfer size",
};
const observedMetrics: PerformanceMetric[] = [...PERFORMANCE_CHECK_METRICS, "qualifyingInteractionMaxMs"];
function reading(value: number | null, metric: PerformanceMetric): string {
  if (value === null) return "Unavailable";
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: metric === "clsMaxSessionScore" ? 5 : 2 }).format(value)} ${performanceMetricUnit(metric)}`;
}

export function PerformanceReadings({ snapshot, retained = false }: { snapshot: PerformanceSnapshot; retained?: boolean }) {
  return <div className="min-w-0 space-y-3" aria-label={retained ? "Retained native performance readings" : "Native performance readings"}>
    <p className="break-words text-xs text-[color:var(--rp-ink-soft)]">{retained ? "Immutable saved capture" : snapshot.phase === "begin" ? "Lab window opened" : "Lab window captured"} · {snapshot.clock.sinceMs === null ? "unknown" : Number(snapshot.clock.sinceMs.toFixed(2))}–{snapshot.clock.capturedAtMs === null ? "unknown" : Number(snapshot.clock.capturedAtMs.toFixed(2))} ms from document start</p>
    <dl className="divide-y divide-[color:var(--rp-border)] text-xs">{observedMetrics.map(metric => <div key={metric} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
      <dt>{labels[metric]}{metric === "qualifyingInteractionMaxMs" && <span className="ml-1 text-[color:var(--rp-ink-muted)]">(display only)</span>}</dt><dd className="font-medium tabular-nums" title={snapshot.metrics[metric] === null ? undefined : String(snapshot.metrics[metric])}>{reading(snapshot.metrics[metric], metric)}</dd>
    </div>)}</dl>
    <p className="max-w-[70ch] text-xs leading-relaxed text-[color:var(--rp-ink-soft)]">Native samples in this selected window. Interaction timing includes trusted qualifying events, uses browser quantization, and is not INP. Long frames cover frames of at least 50 ms. Measured zero transfer size does not imply zero network cost.</p>
    <details><summary className="cursor-pointer text-xs font-medium">Native coverage and document timing</summary>
      <div className="mt-3 space-y-3 text-xs">
        {!performanceClockComplete(snapshot) && <p className="text-[color:var(--rp-warning)]">Document clock identity or window order is unavailable.</p>}
        <ul className="space-y-2">{PERFORMANCE_OBSERVERS.map(name => { const item = snapshot.coverage[name]; return <li key={name} className="break-words"><span className="font-medium">{name}</span>: {item.state} · {item.observed} admitted · native loss {item.nativeDropped === null ? "unknown" : item.nativeDropped} · {item.invalid} invalid · {item.omitted} omitted{item.overflow ? " · arithmetic overflow" : ""}</li>; })}</ul>
        <dl className="space-y-2">{(["fcpMs", "lcpMs", "navigationTtfbMs", "navigationDomContentLoadedMs", "navigationLoadMs"] as PerformanceMetric[]).map(metric => <div key={metric} className="flex flex-wrap justify-between gap-2"><dt>{labels[metric]} (document only)</dt><dd className="tabular-nums">{reading(snapshot.metrics[metric], metric)}</dd></div>)}</dl>
        <p>Document candidates describe the original document and may be unfinished. They do not measure this lab action.</p>
        <p>Lifetime work: {snapshot.lifetimeWork}/50,000{snapshot.lifetimeExhausted ? " · exhausted; reconnect before another window" : ""}. Numeric processing is bounded; browser-owned buffers are outside this limit.</p>
        <p>Diagnostics omitted: {snapshot.diagnostics.resourceOmitted} resources, {snapshot.diagnostics.frameOmitted} frames, {snapshot.diagnostics.scriptOmitted} scripts, {snapshot.diagnostics.metadataOmitted} locations. Diagnostic omission differs from population loss above.</p>
        <p>Location metadata: {snapshot.metadata === "none" ? "not acquired" : "explicitly enabled; redacted origin/path only"}. No bodies or DOM attribution are acquired.</p>
        {snapshot.diagnostics.resources.length > 0 && <ul className="space-y-1" aria-label="Bounded resource diagnostics">{snapshot.diagnostics.resources.map((item, i) => <li className="break-words" key={i}>{item.durationMs} ms · {item.transferBytes} bytes{item.url && <> · <span className="break-all">{item.url.origin}{item.url.path}</span></>}</li>)}</ul>}
        <p className="break-all">Document {snapshot.documentId} · Window {snapshot.windowId}</p>
      </div>
    </details>
  </div>;
}

export function PerformanceEvidence({ sessionId, connected, capable, disabled, perform, onReport }: {
  sessionId: string; connected: boolean; capable: boolean; disabled: boolean;
  perform: (label: string, operation: () => Promise<void>) => Promise<void>; onReport: (report: VerificationReport) => void;
}) {
  const [snapshot, setSnapshot] = useState<PerformanceSnapshot>();
  const [baseline, setBaseline] = useState<PerformanceSnapshot>();
  const [metric, setMetric] = useState<typeof PERFORMANCE_CHECK_METRICS[number]>("clsMaxSessionScore");
  const [op, setOp] = useState<"lte" | "gte">("lte");
  const [limit, setLimit] = useState("0.1");
  const active = useRef(sessionId);
  useEffect(() => { active.current = sessionId; return () => { active.current = ""; }; }, [sessionId]);
  const unavailable = disabled || !connected || !capable;
  const capture = (phase: "begin" | "capture") => void perform(phase === "begin" ? "Opening native lab window…" : "Capturing native lab window…", async () => {
    const response = await verificationApi.command(sessionId, { type: "performance", phase });
    if (!response.ok) throw new Error(response.error ?? "Native performance capture is unavailable.");
    const result = parsePerformanceSnapshot(response.result);
    if (result.phase !== phase) throw new Error("Native performance response does not match this request.");
    if (active.current === sessionId) setSnapshot(result);
  });
  const check = () => void perform("Checking native lab metric…", async () => {
    if (!/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(limit.trim())) throw new Error("Enter a nonnegative decimal numeric limit.");
    const value = Number(limit);
    if (!Number.isFinite(value) || value < 0 || ((metric === "resourceCount" || metric === "resourceTransferBytes") && !Number.isSafeInteger(value))) throw new Error("This metric requires a finite nonnegative limit; counts and bytes require safe whole numbers.");
    const report = await verificationApi.assert(sessionId, { kind: "performance", metric, op, value }, undefined, `Native lab: ${labels[metric]}`);
    if (active.current === sessionId) { const saved = report.context?.checks[0]?.performance; if (saved) setSnapshot(parsePerformanceSnapshot(saved.snapshot)); onReport(report); }
  });
  const compatible = baseline && snapshot?.phase === "capture" && baseline.documentId === snapshot.documentId && baseline.clock.timeOriginMs === snapshot.clock.timeOriginMs && baseline.windowId !== snapshot.windowId && performanceClockComplete(baseline) && performanceClockComplete(snapshot);
  return <section className="min-w-0 space-y-4 border-t border-[color:var(--rp-border)] pt-5" aria-labelledby={`performance-${sessionId}`}>
    <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 id={`performance-${sessionId}`} className="text-sm font-semibold">Native performance lab</h2><span className="text-xs text-[color:var(--rp-ink-soft)]">{capable ? "Explicit SDK opt-in" : "Capture disabled"}</span></div>
    {!capable ? <p className="max-w-[70ch] text-xs leading-relaxed text-[color:var(--rp-ink-soft)]">Enable native performance capture in the connection setup, then reconnect the app. Capture is off by default and acquires no location metadata.</p> : <p className="max-w-[70ch] text-xs leading-relaxed text-[color:var(--rp-ink-soft)]">Open a window, exercise the app yourself, then capture. Compare selected numeric populations; unsupported, lost or unknown evidence stays inconclusive.</p>}
    <div className="flex flex-wrap gap-2"><Button disabled={unavailable} onClick={() => capture("begin")}>Begin lab window</Button><Button variant="outline" disabled={unavailable || !snapshot} onClick={() => capture("capture")}>Capture readings</Button><Button variant="ghost" disabled={disabled || snapshot?.phase !== "capture"} onClick={() => setBaseline(snapshot)}>Use capture as before</Button></div>
    {snapshot && !connected && <p className="text-xs text-[color:var(--rp-warning)]">Document disconnected. These retained readings cannot support a fresh check.</p>}
    {snapshot ? <PerformanceReadings snapshot={snapshot} /> : <p className="text-xs text-[color:var(--rp-ink-muted)]">No lab window captured yet.</p>}
    {baseline && snapshot && <div className="space-y-2 border-t border-[color:var(--rp-border)] pt-3" aria-label="Selected before and after readings"><p className="text-xs font-medium">Selected before / after</p>{compatible ? <dl className="space-y-2 text-xs">{PERFORMANCE_CHECK_METRICS.map(name => { const before = baseline.metrics[name], after = snapshot.metrics[name]; const difference = before !== null && after !== null ? after - before : null; return <div key={name} className="flex flex-wrap justify-between gap-2"><dt>{labels[name]}</dt><dd>{reading(before, name)} → {reading(after, name)}{difference !== null && Number.isFinite(difference) ? ` · Δ ${difference > 0 ? "+" : ""}${difference} ${performanceMetricUnit(name)}` : " · difference unavailable"}</dd></div>; })}</dl> : <p className="text-xs text-[color:var(--rp-warning)]">Capture a different lab window in the same connected document with valid clocks to compare.</p>}<p className="text-xs leading-relaxed text-[color:var(--rp-ink-soft)]">Observed differences only. Review both windows’ native coverage; incomplete samples remain incomplete. This comparison does not establish causality or improvement.</p></div>}
    <fieldset disabled={unavailable || !snapshot} className="space-y-3"><legend className="mb-2 text-xs font-medium">Optional numeric check</legend><div className="flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-[2_1_180px]"><Field label="Native lab metric"><Select value={metric} onChange={event => setMetric(event.target.value as typeof metric)}>{PERFORMANCE_CHECK_METRICS.map(name => <option value={name} key={name}>{labels[name]}</option>)}</Select></Field></div>
      <div className="min-w-0 flex-[1_1_120px]"><Field label="Comparison"><Select value={op} onChange={event => setOp(event.target.value as typeof op)}><option value="lte">At most</option><option value="gte">At least</option></Select></Field></div>
      <div className="min-w-0 flex-[1_1_100px]"><Field label={`Limit (${performanceMetricUnit(metric)})`}><Input inputMode="decimal" value={limit} onChange={event => setLimit(event.target.value)} /></Field></div>
    </div><Button variant="outline" onClick={check}>Check lab metric</Button></fieldset>
  </section>;
}
