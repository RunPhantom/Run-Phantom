import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { ANALYTICS_LIMITS, parseCostAnalyticsRequest, type AnalyticsPopulation, type CostAnalyticsReport, type CostAnalyticsRequest, type MetricPopulation } from "../../../src/pricing/analytics";
import { TOKEN_CATEGORIES, type FrozenRateRevision } from "../../../src/pricing/protocol";
import { parseJsonEvidence } from "../../../src/evaluations/json-evidence";
import { hasDuplicateJsonKeys } from "../../../src/json-keys";
import { fmtCost, getPricingSnapshot, subscribePricing } from "../utils/costs";
import { Button } from "./ui/button";

const PANEL = "rounded-[7px] border border-[#D9DEEA] bg-white p-4 sm:p-6";
const CONTROL = "min-h-11 rounded-[5px] border border-[#7C8494] bg-white px-3 text-[14px] text-[#0E121B] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0021CC]";
const WINDOW_MS = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
type WindowSelection = keyof typeof WINDOW_MS;
const count = (value: number | null): string => value === null ? "Unavailable" : value.toLocaleString();

function Amount({ value, money = false }: { value: MetricPopulation; money?: boolean }) {
  return <><span className="block font-semibold tabular-nums">{value.knownSum === null ? value.eligibleCount ? "Unavailable" : "No eligible generations" : money ? fmtCost(value.knownSum) : count(value.knownSum)}</span>
    <span className="block text-[12px] text-[#525866]">{value.knownCount} known · {value.unavailableCount} unavailable{value.sumState === "overflow" ? " · sum overflow" : ""}</span></>;
}
function PopulationSummary({ data }: { data: AnalyticsPopulation }) {
  return <div className="grid gap-4 sm:grid-cols-2"><section className={PANEL} aria-label="Reported cost"><h2 className="text-[14px] text-[#525866]">Reported cost</h2><div className="mt-2 text-[24px]" data-testid="reported-cost"><Amount value={data.reportedUsd} money /></div><p className="mt-3 text-[12px] text-[#525866]">{data.reportedUsd.completeTotal === null ? "Known subtotal; complete reported spend unavailable." : "Complete total for eligible captured generations."} {data.reportedUsd.zeroCount} observed zero.</p></section>
    <section className={PANEL} aria-label="Estimated cost"><h2 className="text-[14px] text-[#525866]">Estimated cost</h2><div className="mt-2 text-[24px]" data-testid="estimated-cost"><Amount value={data.estimatedUsd} money /></div><p className="mt-3 text-[12px] text-[#525866]">{data.estimatedUsd.completeTotal === null ? "Known subtotal; complete estimate unavailable." : "Complete estimate under the selected frozen rates."} {data.estimatedUsd.zeroCount} observed zero.</p></section></div>;
}
export function CostAnalytics({ data, controls }: { data: CostAnalyticsReport; controls?: ReactNode }) {
  const [dimension, setDimension] = useState<"byModel" | "byProvider" | "byProject" | "byTime">("byModel");
  const id = useId();
  const labels = { byModel: "Model", byProvider: "Provider", byProject: "Project", byTime: "Time (UTC)" };
  return <div className="space-y-5 text-[14px] leading-5 text-[#0E121B]">
    {controls}
    <p className="text-[#525866]">{data.population.selectedGenerations} timed top-level generations · {data.population.nestedExcluded} nested generations excluded · {data.population.untimedGenerations} with unavailable timestamps · {data.population.ancestryUnavailable} with unavailable ancestry</p>
    <PopulationSummary data={data} />
    {data.reportedUsd.eligibleCount === 0 && <section className={PANEL}><h2 className="text-[20px]">No captured generations in this window</h2><p className="mt-2 text-[#525866]">Choose a wider window or capture an agent run. An empty population has no measured cost.</p></section>}
    {data.population.untimedGenerations > 0 && <p role="status" className="rounded-[7px] border border-[#D9DEEA] bg-[#EEF2FF] p-4">Untimed captures might belong in this window. Their unavailable rows remain in the denominator, so timed subtotals cannot prove a complete window total.</p>}
    <section className={PANEL} aria-labelledby={`${id}-breakdown`}><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 id={`${id}-breakdown`} className="text-[20px] font-semibold">Cost breakdown</h2><label className="flex items-center gap-2"><span>Group by</span><select className={CONTROL} value={dimension} onChange={event => setDimension(event.target.value as typeof dimension)}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
      <div className="overflow-auto focus-visible:outline-2 focus-visible:outline-[#0021CC]" tabIndex={0} role="region" aria-label="Cost breakdown table"><table className="w-full min-w-[560px] text-left"><thead><tr className="border-b border-[#D9DEEA] text-[12px] text-[#525866]"><th scope="col" className="py-3 pr-4">{labels[dimension]}</th><th scope="col" className="py-3 pr-4">Reported USD</th><th scope="col" className="py-3 pr-4">Estimated USD</th><th scope="col" className="py-3 pr-4">Input tokens</th><th scope="col" className="py-3">Output tokens</th></tr></thead><tbody>{data[dimension].map(row => <tr key={row.identity ?? "unknown"} className="border-b border-[#E8ECF5] last:border-0"><th scope="row" className="max-w-[240px] break-words py-4 pr-4 font-medium">{row.identity ?? (dimension === "byTime" ? "Timestamp unavailable" : `${labels[dimension]} unavailable`)}</th><td className="py-4 pr-4"><Amount value={row.reportedUsd} money /></td><td className="py-4 pr-4"><Amount value={row.estimatedUsd} money /></td><td className="py-4 pr-4"><Amount value={row.tokens.input} /></td><td className="py-4"><Amount value={row.tokens.output} /></td></tr>)}</tbody></table></div>
    </section>
    <section className={PANEL} aria-label="Categorized usage"><h2 className="text-[20px] font-semibold">Categorized usage</h2><p className="mt-2 text-[#525866]">Captured categories may overlap. These counts are shown separately and are never added into an invented token total.</p><dl className="mt-4 grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">{TOKEN_CATEGORIES.map(category => <div key={category}><dt className="text-[12px] capitalize text-[#525866]">{category.replace(/_/g, " ")}</dt><dd className="mt-1"><Amount value={data.tokens[category]} /></dd></div>)}</dl></section>
    <details className={PANEL}><summary className="min-h-11 cursor-pointer font-semibold focus-visible:outline-2 focus-visible:outline-[#0021CC]">Rate and capture provenance</summary><div className="mt-3 space-y-3 break-words text-[12px] text-[#525866]"><p>{data.estimateMode === "nominal-input-output" ? "Nominal public input/output catalogue estimate. Actual provider, tier, cache, reasoning, audio, discounts, fees and invoiced spend are not established by these quotes." : "Estimates use only the explicitly supplied frozen provider/model/tier rates and captured category declarations."} Rates are request-declared; Run Phantom does not verify provider invoices.</p><p>UTC window: {new Date(data.window.from).toISOString()} inclusive → {new Date(data.window.to).toISOString()} exclusive. Captured generation start time.</p><p>Source roster: <code>{data.sourceRevision}</code> · {data.population.acquiredSpans} spans including ancestor context. Captured {new Date(data.asOf).toISOString()}.</p>{data.rateRevisions.length === 0 ? <p>No rates selected. Reported cost and observed token populations remain available independently.</p> : data.rateRevisions.map(rate => <div key={JSON.stringify([rate.provider, rate.model, rate.tier, rate.revision])}><strong className="text-[#0E121B]">{rate.model}</strong><p>{rate.provider} · {rate.tier} · {rate.currency} · {rate.unit}</p><p>{rate.source.name} · {rate.source.observedAt}</p><p>Revision <code>{rate.revision}</code> · {rate.version}</p><p>Category policies: {TOKEN_CATEGORIES.map(category => `${category}: ${rate.bands.map(band => band.categories[category].kind).join("/")}`).join(" · ")}</p></div>)}</div></details>
  </div>;
}

export function CostAnalyticsWorkspace({ scopeKey, title, load }: { scopeKey: readonly unknown[]; title: string; load: (request: CostAnalyticsRequest, signal: AbortSignal) => Promise<CostAnalyticsReport> }) {
  const pricing = useSyncExternalStore(subscribePricing, getPricingSnapshot, getPricingSnapshot);
  const [selection, setSelection] = useState<WindowSelection>("24h");
  const [to, setTo] = useState(Date.now);
  const [mode, setMode] = useState<"reported" | "manual" | "nominal">("reported");
  const [manualText, setManualText] = useState("");
  const [manualRates, setManualRates] = useState<readonly FrozenRateRevision[]>([]);
  const [manualError, setManualError] = useState<string | null>(null);
  const from = to - WINDOW_MS[selection];
  const request = { from, to, bucket: selection === "1h" || selection === "24h" ? "hour" as const : "day" as const, estimateMode: mode === "nominal" ? "nominal-input-output" as const : "captured" as const, rates: mode === "manual" ? manualRates : [] };
  const result = useQuery({ queryKey: [...scopeKey, "cost-analytics", selection, to, mode, manualRates, mode === "nominal" ? pricing.catalogue?.revision ?? pricing.status : null], retry: false,
    enabled: mode !== "nominal" || pricing.status === "ready", queryFn: async ({ signal }) => {
      if (mode !== "nominal") return load(request, signal);
      const roster = await load({ ...request, estimateMode: "captured", rates: [] }, signal);
      const models = new Set(roster.byModel.map(row => row.identity));
      const rates = pricing.catalogue!.rates.filter(rate => [rate, ...rate.aliases].some(identity => models.has(identity.model)));
      if (rates.length > ANALYTICS_LIMITS.rates) throw new Error("This window requires too many frozen quotes. Select a smaller window.");
      return load({ ...request, rates }, signal);
    } });
  const unavailableNominal = mode === "nominal" && pricing.status !== "ready";
  return <section className="min-h-full bg-[#F9FAFC] p-4 text-[#0E121B] sm:p-6 lg:p-8"><div className="mx-auto max-w-[1180px] space-y-5"><header><p className="text-[12px] font-medium uppercase tracking-[.08em] text-[#525866]">{title}</p><h1 className="mt-2 text-[28px] font-semibold leading-9" style={{ fontFamily: "var(--font-display)" }}>Cost &amp; usage</h1><p className="mt-2 max-w-[720px] text-[14px] leading-5 text-[#525866]">Inspect what was measured, what was reported, and what can be estimated. Missing evidence stays visible.</p></header>
    <div className="flex flex-wrap items-end gap-3"><label className="grid gap-1 text-[12px] text-[#525866]">Time window<select className={CONTROL} value={selection} onChange={event => { setSelection(event.target.value as WindowSelection); setTo(Date.now()); }}>{Object.keys(WINDOW_MS).map(value => <option key={value} value={value}>{value === "1h" ? "Last hour" : value === "24h" ? "Last 24 hours" : value === "7d" ? "Last 7 days" : "Last 30 days"} (UTC)</option>)}</select></label><label className="grid gap-1 text-[12px] text-[#525866]">Estimate source<select className={CONTROL} value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="reported">Reported only</option><option value="manual">Manual frozen rates</option><option value="nominal">Nominal public input/output catalogue</option></select></label><Button type="button" variant="outline" className={`${CONTROL} shadow-none transition-colors duration-[180ms] motion-reduce:transition-none hover:bg-[#EEF2FF]`} disabled={result.isFetching} onClick={() => setTo(Date.now())}><RefreshCw aria-hidden="true" />Refresh</Button></div>
    {mode === "manual" && <form className={PANEL} onSubmit={event => { event.preventDefault(); try { if (new TextEncoder().encode(manualText).byteLength > ANALYTICS_LIMITS.requestBytes || hasDuplicateJsonKeys(manualText)) throw new Error(); const parsed = parseCostAnalyticsRequest({ ...request, rates: parseJsonEvidence(manualText) }); setManualRates(parsed.rates); setManualError(null); } catch { setManualError("Frozen rates must be a valid bounded USD rate revision array. Nothing was applied."); } }}><label className="grid gap-2 text-[14px]">Frozen rate JSON<textarea className="min-h-[120px] rounded-[5px] border border-[#7C8494] bg-white p-3 font-mono text-[12px] focus-visible:outline-2 focus-visible:outline-[#0021CC]" value={manualText} onChange={event => setManualText(event.target.value)} placeholder="Paste a frozen rate revision array" spellCheck={false} /></label><p className="my-3 text-[12px] text-[#525866]">Rates apply to this view. Exact provider, model, tier, source, version and category policies are required. Captured reported costs remain unchanged.</p><Button type="submit" className="min-h-11 rounded-[5px] bg-[#0021CC] px-4 text-white shadow-none transition-colors duration-[180ms] motion-reduce:transition-none hover:bg-[#001AA3]">Apply frozen rates</Button>{manualError && <p role="alert" className="mt-3">{manualError}</p>}</form>}
    {unavailableNominal && <p role="status" className={PANEL}>{pricing.status === "disabled" ? "Public pricing is disabled. Enable model pricing in Settings to load consented catalogue quotes, or use manual frozen rates." : pricing.error ?? "Waiting for consented public pricing…"}</p>}
    {result.error && <div role="alert" className={PANEL}><p>{result.error instanceof Error ? result.error.message : "Cost analytics unavailable"}</p><Button className={`mt-3 ${CONTROL}`} variant="outline" onClick={() => void result.refetch()}>Try again</Button></div>}
    {result.isFetching && <p role="status" aria-live="polite">Loading captured cost and usage…</p>}
    {result.data && !result.error && !unavailableNominal && <CostAnalytics data={result.data} />}
  </div></section>;
}
