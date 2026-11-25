import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Download, RefreshCw } from "lucide-react";
import { ANALYTICS_LIMITS, parseCostAnalyticsRequest, type CostAnalyticsReport, type CostAnalyticsRequest } from "../../../src/pricing/analytics";
import type { FrozenRateRevision } from "../../../src/pricing/protocol";
import { parseJsonEvidence } from "../../../src/evaluations/json-evidence";
import { hasDuplicateJsonKeys } from "../../../src/json-keys";
import { getPricingSnapshot, subscribePricing, type PricingSnapshot } from "../utils/costs";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Select, Textarea } from "./ui/input";
import { Skeleton } from "./ui/skeleton";
import { CostAccounting } from "./cost/CostAccounting";
import { CostKpis, ModelTable, SpendOverTime, WindowToggle } from "./cost/CostPanels";
import {
  COST_WINDOW_COPY, COST_WINDOW_MS, DEFAULT_COST_WINDOW, ESTIMATE_SOURCE_LABELS, bucketFor, isCostWindow, type CostWindow, type EstimateSource,
} from "./cost/cost-model";

const PANEL = "rounded-lg border border-rp-line bg-rp-surface p-4";

/** What a page can add below the model table: the window being shown and the estimate source chosen. */
export interface CostContext { window: CostWindow; from: number; to: number; source: EstimateSource }

type Load = (request: CostAnalyticsRequest, signal: AbortSignal) => Promise<CostAnalyticsReport>;

/** The OpenRouter quotes for the models a roster saw; the catalogue is only consulted with consent. */
function nominalRates(roster: CostAnalyticsReport, pricing: PricingSnapshot): FrozenRateRevision[] {
  const models = new Set(roster.byModel.map(row => row.identity));
  const rates = pricing.catalogue!.rates.filter(rate => [rate, ...rate.aliases].some(identity => models.has(identity.model)));
  if (rates.length > ANALYTICS_LIMITS.rates) throw new Error("This window requires too many frozen quotes. Select a smaller window.");
  return rates;
}

async function loadReport(load: Load, request: CostAnalyticsRequest, source: EstimateSource, pricing: PricingSnapshot, signal: AbortSignal): Promise<CostAnalyticsReport> {
  if (source !== "nominal") return load(request, signal);
  const roster = await load({ ...request, estimateMode: "captured", rates: [] }, signal);
  if (pricing.status !== "ready") return roster;
  return load({ ...request, rates: nominalRates(roster, pricing) }, signal);
}

export function CostAnalyticsWorkspace({ scopeKey, title, load, footer, modelHref, sections }: {
  scopeKey: readonly unknown[];
  title: string;
  load: Load;
  footer?: ReactNode;
  modelHref?: (model: string, window: CostWindow) => string;
  /** Panels shown under the model table, e.g. spend by agent and the most expensive runs. */
  sections?: (context: CostContext) => ReactNode;
}) {
  const pricing = useSyncExternalStore(subscribePricing, getPricingSnapshot, getPricingSnapshot);
  const [params, setParams] = useSearchParams();
  const requested = params.get("window");
  const selection: CostWindow = isCostWindow(requested) ? requested : DEFAULT_COST_WINDOW;
  const [to, setTo] = useState(Date.now);
  const [mode, setMode] = useState<EstimateSource>("list");
  const [view, setView] = useState<"spend" | "tokens">("spend");
  const [manualText, setManualText] = useState("");
  const [appliedManualText, setAppliedManualText] = useState<string | null>(null);
  const [manualRates, setManualRates] = useState<readonly FrozenRateRevision[]>([]);
  const [manualError, setManualError] = useState<string | null>(null);
  const [exportState, setExportState] = useState({ key: "", pending: false, error: "" });
  const exportController = useRef<AbortController | null>(null);
  const span = COST_WINDOW_MS[selection];
  const from = to - span;
  const request: CostAnalyticsRequest = {
    from, to, bucket: bucketFor(selection),
    estimateMode: mode === "nominal" ? "nominal-input-output" : mode === "list" ? "list-prices" : "captured",
    rates: mode === "manual" ? manualRates : [],
  };
  const nominalReady = pricing.status === "ready";
  const queryKey = [...scopeKey, "cost-analytics", selection, to, mode, manualRates, mode === "nominal" ? pricing.catalogue?.revision ?? pricing.status : null];
  // Without a consented catalogue the nominal view still shows captured tokens and reported cost; only the estimate waits.
  const result = useQuery({
    queryKey, retry: false,
    enabled: mode !== "nominal" || pricing.status !== "loading",
    queryFn: ({ signal }) => loadReport(load, request, mode, pricing, signal),
  });
  // The previous window only feeds the deltas, so it loads after the current one and a failure just hides them.
  const previous = useQuery({
    queryKey: [...queryKey, "previous"], retry: false,
    enabled: !!result.data && !result.error,
    queryFn: ({ signal }) => loadReport(load, { ...request, from: from - span, to: from }, mode, pricing, signal).catch(() => null),
  });

  const setWindow = useCallback((next: CostWindow) => {
    setParams(current => {
      const updated = new URLSearchParams(current);
      if (next === DEFAULT_COST_WINDOW) updated.delete("window"); else updated.set("window", next);
      return updated;
    }, { replace: true });
    setTo(Date.now());
  }, [setParams]);

  const unavailableNominal = mode === "nominal" && !nominalReady;
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
        estimateMode: report.estimateMode, rates: report.estimateMode === "list-prices" ? [] : report.rateRevisions }, controller.signal);
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

  const applyManual = () => {
    try {
      if (new TextEncoder().encode(manualText).byteLength > ANALYTICS_LIMITS.requestBytes || hasDuplicateJsonKeys(manualText)) throw new Error();
      const parsed = parseCostAnalyticsRequest({ ...request, rates: parseJsonEvidence(manualText) });
      setManualRates(parsed.rates); setAppliedManualText(manualText); setManualError(null);
    } catch { setManualError("Frozen rates must be a valid bounded USD rate revision array. Nothing was applied."); }
  };

  const report = result.data && !result.error ? result.data : null;
  const context: CostContext = { window: selection, from, to, source: mode };
  const copy = COST_WINDOW_COPY[selection];

  return (
    <section className="min-h-full bg-rp-canvas rp-page text-rp-ink" data-cost-page>
      <div className="mx-auto flex max-w-[1480px] flex-col gap-4">
        <header className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="rp-type-headline text-rp-ink">Cost &amp; usage</h1>
            <p className="text-13 text-rp-ink-subtle"><span className="sr-only">Showing </span>{title} · {copy.eyebrow.toLowerCase()}</p>
            {result.isFetching && <p role="status" aria-live="polite" className="text-12 text-rp-ink-subtle">Loading captured cost and usage…</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2" data-cost-toolbar>
            <WindowToggle value={selection} onChange={setWindow} />
            <label className="flex items-center gap-2">
              <span className="text-12 text-rp-ink-subtle" aria-hidden="true">Estimate</span>
              <Select aria-label="Estimate source" className="h-8 w-auto min-w-[12.5rem] text-13" value={mode} onChange={event => setMode(event.target.value as EstimateSource)}>
                {(Object.keys(ESTIMATE_SOURCE_LABELS) as EstimateSource[]).map(value => <option key={value} value={value}>{ESTIMATE_SOURCE_LABELS[value]}</option>)}
              </Select>
            </label>
            <Button type="button" variant="outline" size="icon-sm" aria-label="Refresh" title="Refresh" disabled={result.isFetching} onClick={() => setTo(Date.now())}>
              <RefreshCw aria-hidden="true" className={cn(result.isFetching && "animate-spin motion-reduce:animate-none")} />
            </Button>
            {result.data && !result.error && !unavailableNominal && (
              <Button type="button" variant="outline" size="sm" disabled={!exportAvailable || exporting} loading={exporting} onClick={() => void exportReport()}
                title={unappliedManualRates ? "Apply the frozen rates before exporting" : "Download this report with its rates, data revision and UTC window"}>
                <Download aria-hidden="true" />Export JSON
              </Button>
            )}
          </div>
        </header>

        {exporting && <p role="status" className="text-12 text-rp-ink-subtle">Checking current access before export…</p>}
        {mode === "manual" && (
          <form className={cn(PANEL, "grid gap-3")} onSubmit={event => { event.preventDefault(); applyManual(); }}>
            <label className="grid gap-1.5">
              <span className="rp-field-label">Frozen rate JSON</span>
              <Textarea className="min-h-[120px] font-mono text-12" value={manualText} onChange={event => setManualText(event.target.value)} placeholder="Paste a frozen rate revision array" spellCheck={false} aria-invalid={manualError ? true : undefined} />
            </label>
            <p className="rp-field-hint">Rates apply to this view only. Each needs the exact provider, model, tier, source, version and category policies. Reported costs are unchanged.</p>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" size="lg">Apply frozen rates</Button>
              {unappliedManualRates && !manualError && <span className="text-13 text-rp-ink-subtle">Apply the current frozen rates before exporting.</span>}
            </div>
            {manualError && <p role="alert" className="rounded-sm border border-rp-danger-border bg-rp-danger-soft px-3 py-2 text-13 text-rp-danger">{manualError}</p>}
          </form>
        )}
        {unavailableNominal && (
          <p role="status" className="rounded-lg border border-rp-wash-border bg-rp-wash px-4 py-3 text-13 text-rp-ink">
            {pricing.status === "disabled" ? "Public pricing is disabled. Turn on public model pricing in Settings to load OpenRouter catalogue quotes, or choose list prices. Tokens and reported cost below are unaffected." : pricing.error ?? "Waiting for consented public pricing…"}
          </p>
        )}
        {result.error && (
          <div role="alert" className="rounded-lg border border-rp-danger-border bg-rp-danger-soft p-4">
            <p className="text-14 font-semibold text-rp-danger">Cost and usage did not load.</p>
            <p className="mt-1 text-13 text-rp-ink-muted">{result.error instanceof Error ? result.error.message : "Cost analytics unavailable"}</p>
            <Button className="mt-3" size="sm" variant="outline" onClick={() => void result.refetch()}>Try again</Button>
          </div>
        )}
        {exportState.key === exportKey && exportState.error && <p role="alert" className="rounded-lg border border-rp-danger-border bg-rp-danger-soft px-4 py-3 text-13 text-rp-danger">{exportState.error}</p>}

        {!result.data && result.isFetching && <CostSkeleton />}
        {report && (
          <div className={cn("flex flex-col gap-4 transition-opacity duration-state", result.isFetching && "opacity-60")} aria-busy={result.isFetching || undefined}>
            <CostKpis report={report} previous={previous.data ?? null} source={mode} window={selection} />
            {report.population.untimedGenerations > 0 && (
              <p role="status" className="text-13 text-rp-ink-muted">
                {report.population.untimedGenerations} {report.population.untimedGenerations === 1 ? "call has" : "calls have"} no start time and may belong to this window, so these totals may be incomplete.
              </p>
            )}
            <SpendOverTime report={report} source={mode} window={selection} view={view} onViewChange={setView} />
            <div className={cn("grid grid-cols-[minmax(0,1fr)] gap-4", sections && "xl:grid-cols-2")}>
              <ModelTable report={report} source={mode} window={selection} modelHref={modelHref ? model => modelHref(model, selection) : undefined} />
              {sections?.(context)}
            </div>
            <CostAccounting report={report} />
          </div>
        )}
        {footer}
      </div>
    </section>
  );
}

function CostSkeleton() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-label="Loading cost and usage">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-rp-line bg-rp-line xl:grid-cols-4">
        {[0, 1, 2, 3].map(item => <div key={item} className="bg-rp-surface px-4 pb-3 pt-3"><Skeleton className="h-3 w-24" /><Skeleton className="mt-3 h-7 w-24" /><Skeleton className="mt-3 h-3 w-32" /></div>)}
      </div>
      <div className={PANEL}><Skeleton className="h-4 w-40" /><Skeleton className="mt-4 h-[200px] w-full" /></div>
    </div>
  );
}
