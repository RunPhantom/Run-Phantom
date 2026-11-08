import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Download, RefreshCw } from "lucide-react";
import { ANALYTICS_LIMITS, parseCostAnalyticsRequest, type AnalyticsPopulation, type CostAnalyticsReport, type CostAnalyticsRequest, type MetricPopulation } from "../../../src/pricing/analytics";
import { TOKEN_CATEGORIES, type FrozenRateRevision } from "../../../src/pricing/protocol";
import { parseJsonEvidence } from "../../../src/evaluations/json-evidence";
import { hasDuplicateJsonKeys } from "../../../src/json-keys";
import { fmtCost, getPricingSnapshot, subscribePricing } from "../utils/costs";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { EmptyPanel } from "./ui/empty-panel";
import { Select, Textarea } from "./ui/input";
import { Skeleton } from "./ui/skeleton";
import { Eyebrow, PageHeader } from "./ui/typography";

const PANEL = "rounded-lg border border-rp-line bg-white p-5 sm:p-6";
const CONTROL = "h-9 min-w-[11rem] text-[13px]";
const WINDOW_MS = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
type WindowSelection = keyof typeof WINDOW_MS;
const count = (value: number | null): string => value === null ? "Unavailable" : value.toLocaleString();

function Amount({ value, money = false, lead = false }: { value: MetricPopulation; money?: boolean; lead?: boolean }) {
  const text = value.knownSum === null ? value.eligibleCount ? "Unavailable" : "No eligible generations" : money ? fmtCost(value.knownSum) : count(value.knownSum);
  const measured = value.knownSum !== null;
  return <><span className={cn("block", measured ? "rp-num font-semibold text-rp-ink" : "font-medium text-rp-ink-muted", lead && (measured ? "text-[28px] leading-9 tracking-[-0.02em]" : "text-[17px] leading-9"))}>{text}</span>
    <span className={cn("rp-meta block", lead ? "mt-1" : "mt-0.5")}>{value.knownCount} known · {value.unavailableCount} unavailable{value.sumState === "overflow" ? " · sum overflow" : ""}</span></>;
}
function PopulationSummary({ data }: { data: AnalyticsPopulation }) {
  return <div className="grid gap-4 sm:grid-cols-2"><section className={PANEL} aria-label="Reported cost"><Eyebrow as="h2">Reported cost</Eyebrow><div className="mt-3" data-testid="reported-cost"><Amount value={data.reportedUsd} money lead /></div><p className="mt-4 border-t border-rp-line-muted pt-3 text-[12px] leading-5 text-rp-ink-muted">{data.reportedUsd.completeTotal === null ? "Known subtotal; complete reported spend unavailable." : "Complete total for eligible captured generations."} {data.reportedUsd.zeroCount} observed zero.</p></section>
    <section className={PANEL} aria-label="Estimated cost"><Eyebrow as="h2">Estimated cost</Eyebrow><div className="mt-3" data-testid="estimated-cost"><Amount value={data.estimatedUsd} money lead /></div><p className="mt-4 border-t border-rp-line-muted pt-3 text-[12px] leading-5 text-rp-ink-muted">{data.estimatedUsd.completeTotal === null ? "Known subtotal; complete estimate unavailable." : "Complete estimate under the selected frozen rates."} {data.estimatedUsd.zeroCount} observed zero.</p></section></div>;
}
export function CostAnalytics({ data, controls }: { data: CostAnalyticsReport; controls?: ReactNode }) {
  const [dimension, setDimension] = useState<"byModel" | "byProvider" | "byProject" | "byTime">("byModel");
  const id = useId();
  const labels = { byModel: "Model", byProvider: "Provider", byProject: "Project", byTime: "Time (UTC)" };
  const th = "py-3 pr-4 font-mono text-[11px] font-normal uppercase leading-4 tracking-[0.14em] text-rp-ink-muted";
  return <div className="animate-fade-rise space-y-6 text-[14px] leading-5 text-rp-ink">
    {controls}
    <p className="text-[13px] text-rp-ink-muted">{data.population.selectedGenerations} timed generation candidates · {data.population.nestedExcluded} nested generations excluded · {data.population.untimedGenerations} with unavailable timestamps · {data.population.ancestryUnavailable} with unavailable ancestry</p>
    <PopulationSummary data={data} />
    {data.reportedUsd.eligibleCount === 0 && <EmptyPanel compact title="No captured generations in this window" description="Choose a wider window or capture an agent run. An empty population has no measured cost." />}
    {data.population.untimedGenerations > 0 && <p role="status" className="rounded-lg border border-rp-wash-border bg-rp-wash p-4 text-[13px] leading-6 text-rp-ink">Untimed captures might belong in this window. Their unavailable rows remain in the denominator, so timed subtotals cannot prove a complete window total.</p>}
    <section className={PANEL} aria-labelledby={`${id}-breakdown`}><div className="mb-4 flex flex-wrap items-end justify-between gap-3"><div><Eyebrow>Breakdown / {labels[dimension]}</Eyebrow><h2 id={`${id}-breakdown`} className="rp-subsection-title mt-1.5">Cost breakdown</h2></div><label className="flex items-center gap-2"><span className="rp-field-label whitespace-nowrap">Group by</span><Select className={CONTROL} value={dimension} onChange={event => setDimension(event.target.value as typeof dimension)}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></label></div>
      <div className="overflow-auto" tabIndex={0} role="region" aria-label="Cost breakdown table"><table className="w-full min-w-[560px] text-left text-[13px]"><thead><tr className="border-b border-rp-line"><th scope="col" className={th}>{labels[dimension]}</th><th scope="col" className={th}>Reported USD</th><th scope="col" className={th}>Estimated USD</th><th scope="col" className={th}>Input tokens</th><th scope="col" className={cn(th, "pr-0")}>Output tokens</th></tr></thead><tbody>{data[dimension].map(row => <tr key={row.identity ?? "unknown"} className="rp-ease border-b border-rp-line-muted last:border-0 hover:bg-rp-row-hover"><th scope="row" className={cn("max-w-[240px] break-words py-3.5 pr-4 font-medium", row.identity === null ? "text-rp-ink-muted" : dimension === "byTime" ? "rp-num" : "font-mono text-[12px]")}>{row.identity ?? (dimension === "byTime" ? "Timestamp unavailable" : `${labels[dimension]} unavailable`)}</th><td className="py-3.5 pr-4"><Amount value={row.reportedUsd} money /></td><td className="py-3.5 pr-4"><Amount value={row.estimatedUsd} money /></td><td className="py-3.5 pr-4"><Amount value={row.tokens.input} /></td><td className="py-3.5"><Amount value={row.tokens.output} /></td></tr>)}</tbody></table></div>
    </section>
    <section className={PANEL} aria-label="Categorized usage"><Eyebrow>Tokens / By category</Eyebrow><h2 className="rp-subsection-title mt-1.5">Categorized usage</h2><p className="mt-2 text-[13px] leading-6 text-rp-ink-muted">Captured categories may overlap. These counts are shown separately and are never added into an invented token total.</p><dl className="mt-5 grid gap-px overflow-hidden rounded-md border border-rp-line-muted bg-rp-line-muted sm:grid-cols-2 lg:grid-cols-3">{TOKEN_CATEGORIES.map(category => <div key={category} className="bg-white px-4 py-3"><dt className="rp-eyebrow">{category.replace(/_/g, " ")}</dt><dd className="mt-1.5 text-[13px]"><Amount value={data.tokens[category]} /></dd></div>)}</dl></section>
    <details className={cn(PANEL, "group")}><summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 font-semibold [&::-webkit-details-marker]:hidden"><span>Rate and capture provenance</span><ChevronDown aria-hidden="true" className="size-4 shrink-0 text-rp-ink-muted transition-transform duration-250 ease-standard group-open:rotate-180 motion-reduce:transition-none" /></summary><div className="mt-3 space-y-3 break-words text-[12px] leading-5 text-rp-ink-muted"><p>{data.estimateMode === "nominal-input-output" ? "Nominal public input/output catalogue estimate. Actual provider, tier, cache, reasoning, audio, discounts, fees and invoiced spend are not established by these quotes." : "Estimates use only the explicitly supplied frozen provider/model/tier rates and captured category declarations."} Rates are request-declared; Run Phantom does not verify provider invoices.</p><p>UTC window: <span className="rp-num text-rp-ink">{new Date(data.window.from).toISOString()}</span> inclusive → <span className="rp-num text-rp-ink">{new Date(data.window.to).toISOString()}</span> exclusive. Captured generation start time.</p><p>Source roster: <code className="rp-meta text-rp-ink">{data.sourceRevision}</code> · {data.population.acquiredSpans} spans including ancestor context. Captured {new Date(data.asOf).toISOString()}.</p>{data.rateRevisions.length === 0 ? <p>No rates selected. Reported cost and observed token populations remain available independently.</p> : data.rateRevisions.map(rate => <div key={JSON.stringify([rate.provider, rate.model, rate.tier, rate.revision])} className="border-t border-rp-line-muted pt-3"><strong className="font-mono text-rp-ink">{rate.model}</strong><p>{rate.provider} · {rate.tier} · {rate.currency} · {rate.unit}</p><p>{rate.source.name} · {rate.source.observedAt}</p><p>Revision <code>{rate.revision}</code> · {rate.version}</p><p>Category policies: {TOKEN_CATEGORIES.map(category => `${category}: ${rate.bands.map(band => band.categories[category].kind).join("/")}`).join(" · ")}</p></div>)}</div></details>
  </div>;
}

export function CostAnalyticsWorkspace({ scopeKey, title, load, footer }: { scopeKey: readonly unknown[]; title: string; load: (request: CostAnalyticsRequest, signal: AbortSignal) => Promise<CostAnalyticsReport>; footer?: ReactNode }) {
  const pricing = useSyncExternalStore(subscribePricing, getPricingSnapshot, getPricingSnapshot);
  const [selection, setSelection] = useState<WindowSelection>("24h");
  const [to, setTo] = useState(Date.now);
  const [mode, setMode] = useState<"reported" | "manual" | "nominal">("reported");
  const [manualText, setManualText] = useState("");
  const [appliedManualText, setAppliedManualText] = useState<string | null>(null);
  const [manualRates, setManualRates] = useState<readonly FrozenRateRevision[]>([]);
  const [manualError, setManualError] = useState<string | null>(null);
  const [exportState, setExportState] = useState({ key: "", pending: false, error: "" });
  const exportController = useRef<AbortController | null>(null);
  const from = to - WINDOW_MS[selection];
  const request = { from, to, bucket: selection === "1h" || selection === "24h" ? "hour" as const : "day" as const, estimateMode: mode === "nominal" ? "nominal-input-output" as const : "captured" as const, rates: mode === "manual" ? manualRates : [] };
  const queryKey = [...scopeKey, "cost-analytics", selection, to, mode, manualRates, mode === "nominal" ? pricing.catalogue?.revision ?? pricing.status : null];
  const result = useQuery({ queryKey, retry: false,
    enabled: mode !== "nominal" || pricing.status === "ready", queryFn: async ({ signal }) => {
      if (mode !== "nominal") return load(request, signal);
      const roster = await load({ ...request, estimateMode: "captured", rates: [] }, signal);
      const models = new Set(roster.byModel.map(row => row.identity));
      const rates = pricing.catalogue!.rates.filter(rate => [rate, ...rate.aliases].some(identity => models.has(identity.model)));
      if (rates.length > ANALYTICS_LIMITS.rates) throw new Error("This window requires too many frozen quotes. Select a smaller window.");
      return load({ ...request, rates }, signal);
    } });
  const unavailableNominal = mode === "nominal" && pricing.status !== "ready";
  const unappliedManualRates = mode === "manual" && (appliedManualText === null || manualText !== appliedManualText || manualError !== null);
  const exportKey = JSON.stringify(queryKey);
  const exportAvailable = !!result.data && !result.error && !result.isFetching && !unavailableNominal && !unappliedManualRates;
  const currentExport = useRef({ key: exportKey, report: result.data, available: exportAvailable });
  currentExport.current = { key: exportKey, report: result.data, available: exportAvailable };
  useEffect(() => () => { exportController.current?.abort(); }, [exportKey, exportAvailable]);
  const exporting = exportState.key === exportKey && exportState.pending;
  const exportReport = async () => {
    const { key, report, available } = currentExport.current;
    if (!available || !report || exportController.current) return;
    const controller = new AbortController();
    exportController.current = controller;
    setExportState({ key, pending: true, error: "" });
    const current = () => !controller.signal.aborted && currentExport.current.key === key
      && currentExport.current.report === report && currentExport.current.available;
    try {
      // Recheck the owning store's current authority without replacing the displayed snapshot.
      const authorized = await load({ from: report.window.from, to: report.window.to, bucket: report.window.bucket,
        estimateMode: report.estimateMode, rates: report.rateRevisions }, controller.signal);
      if (!current()) return;
      if (authorized.sourceRevision !== report.sourceRevision) throw new Error("Captured cost and usage changed. Refresh this view before exporting.");
      const url = URL.createObjectURL(new Blob([JSON.stringify(report)], { type: "application/json" }));
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `runphantom-cost-analytics-${report.scope.kind}-${report.window.to}.json`;
        anchor.click();
      } finally { window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
    } catch (error) {
      if (current()) setExportState({ key, pending: false, error: error instanceof Error ? error.message : "Cost analytics could not be exported." });
    } finally {
      if (exportController.current === controller) exportController.current = null;
      if (currentExport.current.key === key) setExportState(value => value.key === key ? { ...value, pending: false } : value);
    }
  };
  return <section className="min-h-full bg-rp-canvas px-5 py-8 text-rp-ink sm:px-10 sm:py-11"><div className="mx-auto max-w-[1180px] space-y-6"><PageHeader eyebrow={`Costs / ${title}`} title="Cost & usage" description="Inspect what was measured, what was reported, and what can be estimated. Missing evidence stays visible." />
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-rp-line bg-white p-4"><label className="grid w-full gap-1.5 sm:w-auto"><span className="rp-field-label">Time window</span><Select className={CONTROL} value={selection} onChange={event => { setSelection(event.target.value as WindowSelection); setTo(Date.now()); }}>{Object.keys(WINDOW_MS).map(value => <option key={value} value={value}>{value === "1h" ? "Last hour" : value === "24h" ? "Last 24 hours" : value === "7d" ? "Last 7 days" : "Last 30 days"} (UTC)</option>)}</Select></label><label className="grid w-full gap-1.5 sm:w-auto"><span className="rp-field-label">Estimate source</span><Select className={cn(CONTROL, "min-w-[15rem]")} value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="reported">Reported only</option><option value="manual">Manual frozen rates</option><option value="nominal">Nominal public input/output catalogue</option></Select></label><Button type="button" variant="outline" disabled={result.isFetching} onClick={() => setTo(Date.now())}><RefreshCw aria-hidden="true" className={cn(result.isFetching && "animate-spin motion-reduce:animate-none")} />Refresh</Button>
      {result.data && !result.error && !unavailableNominal && <><Button type="button" variant="outline" className="sm:ml-auto" disabled={!exportAvailable || exporting} loading={exporting} onClick={() => void exportReport()}><Download aria-hidden="true" />Export JSON</Button><p className="rp-field-hint w-full border-t border-rp-line-muted pt-3">{unappliedManualRates ? "Apply the current frozen rates before exporting." : "Export JSON downloads the displayed report with its frozen rates, source revision and UTC window."}</p></>}</div>
    {exporting && <p role="status" className="rp-meta">Checking current access before export…</p>}
    {mode === "manual" && <form className={cn(PANEL, "animate-fade-rise")} onSubmit={event => { event.preventDefault(); try { if (new TextEncoder().encode(manualText).byteLength > ANALYTICS_LIMITS.requestBytes || hasDuplicateJsonKeys(manualText)) throw new Error(); const parsed = parseCostAnalyticsRequest({ ...request, rates: parseJsonEvidence(manualText) }); setManualRates(parsed.rates); setAppliedManualText(manualText); setManualError(null); } catch { setManualError("Frozen rates must be a valid bounded USD rate revision array. Nothing was applied."); } }}><label className="grid gap-2"><span className="rp-field-label">Frozen rate JSON</span><Textarea className="min-h-[140px] font-mono text-[12px]" value={manualText} onChange={event => setManualText(event.target.value)} placeholder="Paste a frozen rate revision array" spellCheck={false} aria-invalid={manualError ? true : undefined} /></label><p className="rp-field-hint my-3">Rates apply to this view. Exact provider, model, tier, source, version and category policies are required. Captured reported costs remain unchanged.</p><Button type="submit" size="lg">Apply frozen rates</Button>{manualError && <p role="alert" className="mt-3 rounded-sm border border-rp-danger-border bg-rp-danger-soft px-3 py-2 text-[13px] text-rp-danger">{manualError}</p>}</form>}
    {unavailableNominal && <p role="status" className="rounded-lg border border-rp-wash-border bg-rp-wash p-4 text-[13px] leading-6 text-rp-ink">{pricing.status === "disabled" ? "Public pricing is disabled. Enable model pricing in Settings to load consented catalogue quotes, or use manual frozen rates." : pricing.error ?? "Waiting for consented public pricing…"}</p>}
    {result.error && <div role="alert" className="rounded-lg border border-rp-danger-border bg-white p-5 sm:p-6"><Eyebrow className="text-rp-danger">Cost &amp; usage / Error</Eyebrow><p className="mt-2 text-[14px] text-rp-ink">{result.error instanceof Error ? result.error.message : "Cost analytics unavailable"}</p><Button className="mt-4" variant="outline" onClick={() => void result.refetch()}>Try again</Button></div>}
    {result.isFetching && <p role="status" aria-live="polite" className="flex items-center gap-2 text-[13px] text-rp-ink-muted"><span aria-hidden="true" className="size-1.5 rounded-full bg-rp-blue pulse-dot" />Loading captured cost and usage…</p>}
    {exportState.key === exportKey && exportState.error && <p role="alert" className="rounded-lg border border-rp-danger-border bg-rp-danger-soft p-4 text-[13px] text-rp-danger">{exportState.error}</p>}
    {!result.data && result.isFetching && <div aria-hidden="true" className="grid gap-4 sm:grid-cols-2">{[0, 1].map(item => <div key={item} className={cn(PANEL, "space-y-3")}><Skeleton className="h-3 w-24" /><Skeleton className="h-8 w-40" /><Skeleton className="h-3 w-32" /></div>)}</div>}
    {result.data && !result.error && !unavailableNominal && <CostAnalytics data={result.data} />}
    {footer}
  </div></section>;
}
