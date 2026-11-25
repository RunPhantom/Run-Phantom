import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CostAnalyticsReport, MetricPopulation } from "../../../../src/pricing/analytics";
import { BarList, ChartFrame, Sparkline, StackedBars, compact, relativeTimeLabel, trendWord, type StackSeries } from "../charts";
import { fmtCost } from "../../utils/costs";
import {
  COST_WINDOW_COPY, COST_WINDOWS, ESTIMATE_SOURCE_LABELS, comparableTotal, costBucketTitle, costBuckets, coverage, formatShare, metricText, modelRows,
  tokenCoverage, totalDelta, type CostBucket, type CostWindow, type EstimateSource, type ModelRow, type TileDelta,
} from "./cost-model";

export function CostPanel({ id, title, meta, children, className, footer, label }: {
  id: string;
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
  footer?: ReactNode;
  label?: string;
}) {
  return (
    <section aria-labelledby={label ? undefined : id} aria-label={label} className={cn("flex min-w-0 flex-col rounded-lg border border-rp-line bg-rp-surface p-4", className)} data-cost-panel={id}>
      <div className="flex min-h-6 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id={id} className="text-14 font-semibold text-rp-ink">{title}</h2>
        {meta && <div className="text-12 text-rp-ink-subtle">{meta}</div>}
      </div>
      <div className="mt-3 flex min-h-0 flex-1 flex-col">{children}</div>
      {footer && <div className="mt-3 border-t border-rp-line-muted pt-2.5 text-12 text-rp-ink-subtle">{footer}</div>}
    </section>
  );
}

export function WindowToggle({ value, onChange }: { value: CostWindow; onChange: (next: CostWindow) => void }) {
  return (
    <div role="group" aria-label="Time window" className="flex h-8 overflow-hidden rounded-control border border-rp-line bg-rp-surface" data-cost-window>
      {COST_WINDOWS.map(option => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          aria-label={COST_WINDOW_COPY[option].eyebrow}
          onClick={() => onChange(option)}
          className={cn(
            "min-w-11 border-l border-rp-line px-2.5 font-mono text-12 transition-colors duration-fast first:border-l-0 focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--rp-focus)]",
            option === value ? "bg-rp-wash font-semibold text-rp-blue" : "text-rp-ink-muted hover:bg-rp-row-hover hover:text-rp-ink",
          )}
        >
          {COST_WINDOW_COPY[option].short}
        </button>
      ))}
    </div>
  );
}

/** Money axis ticks: "$0", "$0.005", "$0.01", "$1.5", without the trailing zeros fmtCost keeps for amounts. */
export function moneyTick(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (value < 1) return `$${Number(value.toPrecision(2))}`;
  return `$${compact(value)}`;
}

interface Tile {
  id: string;
  testId: string;
  label: string;
  value: string;
  title: string;
  detail: string;
  delta: TileDelta | null;
  deltaUnavailable: string;
  series: readonly (number | null)[];
  partial: readonly boolean[];
}

function metricTile({ id, testId, label, metric, previous, kind, detail, title, series, partial }: {
  id: string; testId: string; label: string; metric: MetricPopulation; previous: MetricPopulation | null; kind: "cost" | "tokens";
  detail: string; title: string; series: readonly (number | null)[]; partial: readonly boolean[];
}): Tile {
  const current = comparableTotal(metric);
  const before = previous ? comparableTotal(previous) : null;
  return {
    id, testId, label, title, detail, series, partial,
    value: metricText(metric, kind),
    delta: totalDelta(current, before, kind === "cost" ? "cost" : "count"),
    deltaUnavailable: !previous ? "No earlier window" : "Not comparable",
  };
}

export function costTiles({ report, previous, source }: { report: CostAnalyticsReport; previous: CostAnalyticsReport | null; source: EstimateSource }): Tile[] {
  const buckets = costBuckets(report, source === "reported" ? "reportedUsd" : "estimatedUsd");
  const reportedBuckets = source === "reported" ? buckets : costBuckets(report, "reportedUsd");
  const partial = buckets.map(bucket => bucket.partial);
  const estimateTitle = source === "list"
    ? "Estimated from the list prices bundled with Run Phantom. Discounts, cache storage, audio and tool fees are not included."
    : source === "manual" ? "Estimated with the frozen rates you applied." : source === "nominal" ? "Estimated from the OpenRouter public catalogue." : "Estimates are off: Reported cost only.";
  return [
    metricTile({
      id: "estimated", testId: "estimated-cost", label: "Estimated spend", metric: report.estimatedUsd, previous: previous?.estimatedUsd ?? null, kind: "cost",
      detail: source === "reported" ? "Estimates are off" : coverage(report.estimatedUsd, "priced"),
      title: estimateTitle, series: source === "reported" ? [] : buckets.map(bucket => bucket.spend), partial,
    }),
    metricTile({
      id: "reported", testId: "reported-cost", label: "Reported spend", metric: report.reportedUsd, previous: previous?.reportedUsd ?? null, kind: "cost",
      detail: coverage(report.reportedUsd, "reported a cost"),
      title: "The cost each model call reported itself, for example in gen_ai.usage.cost_usd.",
      series: reportedBuckets.map(bucket => bucket.spend), partial,
    }),
    metricTile({
      id: "input", testId: "input-tokens", label: "Input tokens", metric: report.tokens.input, previous: previous?.tokens.input ?? null, kind: "tokens",
      detail: tokenCoverage(report.tokens.input), title: "Prompt tokens sent to the model, including cached input where the provider counts it there.",
      series: buckets.map(bucket => bucket.inputTokens), partial,
    }),
    metricTile({
      id: "output", testId: "output-tokens", label: "Output tokens", metric: report.tokens.output, previous: previous?.tokens.output ?? null, kind: "tokens",
      detail: tokenCoverage(report.tokens.output), title: "Tokens the model generated.",
      series: buckets.map(bucket => bucket.outputTokens), partial,
    }),
  ];
}

function DeltaLine({ delta, unavailable, window, empty }: { delta: TileDelta | null; unavailable: string; window: CostWindow; empty: boolean }) {
  if (!delta && empty) return null;
  if (!delta) {
    return (
      <span className="text-rp-ink-subtle" title={unavailable === "Not comparable" ? "Some calls in this window or the previous one have no value, so the totals cannot be compared." : "The previous window could not be loaded."}>
        {unavailable}
      </span>
    );
  }
  const Icon = delta.direction === "up" ? ArrowUpRight : delta.direction === "down" ? ArrowDownRight : Minus;
  return (
    <span className="inline-flex items-center gap-0.5 font-medium text-rp-ink-muted" title={delta.label}>
      <Icon aria-hidden="true" className="size-3.5" strokeWidth={2.25} />
      <span className="font-mono tabular-nums">{delta.text}</span>
      <span className="sr-only"> ({delta.label})</span>
      <span className="ml-1 font-normal text-rp-ink-subtle" aria-hidden="true">vs prev {COST_WINDOW_COPY[window].short}</span>
    </span>
  );
}

export function CostKpis({ report, previous, source, window }: { report: CostAnalyticsReport; previous: CostAnalyticsReport | null; source: EstimateSource; window: CostWindow }) {
  const tiles = costTiles({ report, previous, source });
  return (
    <ul className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-rp-line bg-rp-line xl:grid-cols-4" aria-label="Spend and tokens" data-cost-kpis>
      {tiles.map(tile => {
        const word = trendWord(tile.series.map((value, index) => (tile.partial[index] ? null : value)));
        return (
          <li key={tile.id} className="flex min-w-0 flex-col bg-rp-surface px-4 pb-3 pt-3" data-testid={tile.testId} data-kpi={tile.id} title={tile.title}>
            <span className="rp-type-eyebrow text-rp-ink-subtle">{tile.label}</span>
            <span className="mt-1.5 flex items-end justify-between gap-3">
              <span className={cn("rp-type-kpi", tile.value === "—" ? "text-rp-ink-subtle" : "text-rp-ink")} data-kpi-value>{tile.value}</span>
              {tile.series.length > 0 && (
                <Sparkline className="mb-1 w-[72px] shrink-0 max-sm:hidden 2xl:w-[96px]" values={tile.series} partial={tile.partial}
                  label={`${tile.label} ${COST_WINDOW_COPY[window].phrase}: ${word ?? "not enough data for a trend"}`} />
              )}
            </span>
            <span className="mt-1 flex min-h-5 flex-wrap items-center gap-x-1 text-12"><DeltaLine delta={tile.delta} unavailable={tile.deltaUnavailable} window={window} empty={tile.value === "—"} /></span>
            <span className="mt-0.5 text-12 leading-4 text-rp-ink-subtle xl:truncate" data-kpi-detail>{tile.detail}</span>
          </li>
        );
      })}
    </ul>
  );
}

const TOKEN_SERIES: readonly StackSeries[] = [
  { id: "input", label: "Input", color: "var(--rp-chart-input)" },
  { id: "output", label: "Output", color: "var(--rp-chart-output)" },
];

export function SpendOverTime({ report, source, window, view, onViewChange }: {
  report: CostAnalyticsReport; source: EstimateSource; window: CostWindow; view: "spend" | "tokens"; onViewChange: (view: "spend" | "tokens") => void;
}) {
  const measure = source === "reported" ? "reportedUsd" : "estimatedUsd";
  const buckets = costBuckets(report, measure);
  const size = report.window.bucket;
  const noun = size === "hour" ? "hour" : "day (UTC)";
  const spendLabel = source === "reported" ? "Reported spend" : "Estimated spend";
  const series: readonly StackSeries[] = view === "spend" ? [{ id: "spend", label: spendLabel, color: "var(--rp-chart-1)" }] : TOKEN_SERIES;
  const total = report[measure].knownSum;
  const busiest = buckets.reduce<CostBucket | null>((best, bucket) => (bucket.spend ?? 0) > (best?.spend ?? 0) ? bucket : best, null);
  const summary = view === "spend"
    ? report[measure].eligibleCount === 0 ? `No model calls ${COST_WINDOW_COPY[window].phrase}.`
      : `${spendLabel} per ${noun} ${COST_WINDOW_COPY[window].phrase}: ${total === null ? "unknown" : fmtCost(total)} in total.${busiest && busiest.spend ? ` Highest: ${costBucketTitle(busiest, size)} at ${fmtCost(busiest.spend)}.` : ""}`
    : `Input and output tokens per ${noun} ${COST_WINDOW_COPY[window].phrase}: ${report.tokens.input.knownSum === null ? "unknown" : compact(report.tokens.input.knownSum)} in, ${report.tokens.output.knownSum === null ? "unknown" : compact(report.tokens.output.knownSum)} out.`;
  const stack = buckets.map(bucket => ({
    key: bucket.start,
    title: costBucketTitle(bucket, size),
    values: view === "spend" ? [bucket.spend ?? 0] : [bucket.inputTokens ?? 0, bucket.outputTokens ?? 0],
    partial: bucket.partial,
    notes: bucketNotes(bucket, view),
  }));
  const titleId = "cost-over-time";
  const tableRows = buckets.filter(bucket => bucket.calls > 0).map(bucket => [
    `${costBucketTitle(bucket, size)}${bucket.partial ? " (partial)" : ""}`,
    bucket.calls,
    bucket.spend === null ? "Unknown" : `${fmtCost(bucket.spend)}${bucket.spendUnknown ? ` + ${bucket.spendUnknown} unknown` : ""}`,
    bucket.inputTokens === null ? "Unknown" : compact(bucket.inputTokens),
    bucket.outputTokens === null ? "Unknown" : `${compact(bucket.outputTokens)}${bucket.tokenUnknown ? ` + ${bucket.tokenUnknown} unknown` : ""}`,
  ]);
  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col rounded-lg border border-rp-line bg-rp-surface p-4" data-cost-panel="over-time">
      <ChartFrame
        interactive
        className="flex-1"
        title={<h2 id={titleId} className="text-14 font-semibold text-rp-ink">{view === "spend" ? spendLabel : "Tokens"} per {noun}</h2>}
        summary={summary}
        legend={view === "tokens" ? TOKEN_SERIES.map(item => ({ label: item.label, color: item.color })) : undefined}
        actions={
          <div role="group" aria-label="Chart measure" className="flex h-7 overflow-hidden rounded-control border border-rp-line">
            {(["spend", "tokens"] as const).map(option => (
              <button key={option} type="button" aria-pressed={view === option} onClick={() => onViewChange(option)}
                className={cn("border-l border-rp-line px-2.5 text-12 transition-colors duration-fast first:border-l-0 focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--rp-focus)]",
                  view === option ? "bg-rp-wash font-medium text-rp-blue" : "text-rp-ink-muted hover:bg-rp-row-hover hover:text-rp-ink")}>
                {option === "spend" ? "Spend" : "Tokens"}
              </button>
            ))}
          </div>
        }
        table={{ caption: `Spend and tokens per ${noun}`, columns: ["Time", "Calls", spendLabel, "Input tokens", "Output tokens"], rows: tableRows }}
      >
        <StackedBars
          label={summary}
          buckets={stack}
          series={series}
          height={200}
          format={view === "spend" ? moneyTick : compact}
          integer={view !== "spend"}
          axisLabels={index => index === buckets.length - 1 ? "now" : relativeTimeLabel(index === 0 ? report.window.from : (report.window.from + report.window.to) / 2, report.window.to)}
          emptyLabel={`No model calls ${COST_WINDOW_COPY[window].phrase}`}
        />
      </ChartFrame>
    </section>
  );
}

function bucketNotes(bucket: CostBucket, view: "spend" | "tokens"): string[] | undefined {
  if (!bucket.calls) return undefined;
  const notes = [`${bucket.calls} model ${bucket.calls === 1 ? "call" : "calls"}`];
  if (view === "spend" && bucket.spendUnknown) notes.push(bucket.spend === null ? "No call here has a cost" : `${bucket.spendUnknown} without a cost, not included`);
  if (view === "tokens" && bucket.tokenUnknown) notes.push(`${bucket.tokenUnknown} without token counts, not included`);
  return notes;
}

function tokenPair(input: number | null, output: number | null): string {
  if (input === null && output === null) return "—";
  return `${input === null ? "?" : compact(input)} / ${output === null ? "?" : compact(output)}`;
}

export function ModelTable({ report, source, window, modelHref }: { report: CostAnalyticsReport; source: EstimateSource; window: CostWindow; modelHref?: (model: string) => string }) {
  const measure = source === "reported" ? "reportedUsd" : "estimatedUsd";
  const rows = modelRows(report, measure);
  const showReported = source !== "reported" && report.reportedUsd.knownCount > 0;
  const costHeader = source === "reported" ? "Reported" : "Est. cost";
  return (
    <CostPanel id="cost-by-model" label="Cost by model" title="By model" meta={source === "reported" ? "Reported cost" : ESTIMATE_SOURCE_LABELS[source]}>
      <BarList<ModelRow>
        caption={`Model calls, tokens and cost by model ${COST_WINDOW_COPY[window].phrase}`}
        rows={rows}
        rowKey={row => row.model ?? "\u0000unknown"}
        nameHeader="Model"
        name={row => row.model === null ? <span className="text-rp-ink-subtle">Model not reported</span> : <span className="font-mono text-12">{row.model}</span>}
        nameTitle={row => row.model ?? "The calls did not name a model"}
        href={row => row.model && modelHref ? modelHref(row.model) : undefined}
        barPlacement="under"
        bar={{ header: costHeader, value: row => row.spend ?? 0 }}
        columns={[
          { id: "calls", header: "Calls", cell: row => row.calls.toLocaleString("en-US") },
          { id: "tokens", header: "Tokens in / out", className: "max-sm:hidden", cell: row => <span title={row.tokenUnknown ? `${row.tokenUnknown} ${row.tokenUnknown === 1 ? "call" : "calls"} without token counts` : undefined}>{tokenPair(row.inputTokens, row.outputTokens)}{row.tokenUnknown ? "+" : ""}</span> },
          ...(showReported ? [{ id: "reported", header: "Reported", className: "max-md:hidden", cell: (row: ModelRow) => row.reported === null ? <span className="text-rp-ink-subtle">—</span> : fmtCost(row.reported) }] : []),
          { id: "cost", header: costHeader, headerTitle: source === "reported" ? "Cost the calls reported" : "Estimated cost of the calls that could be priced", cell: row => costCellText(row.spend, row.spendUnknown, row.calls) },
          { id: "share", header: "Share", cell: row => formatShare(row.share) },
        ]}
        emptyLabel={`No model calls ${COST_WINDOW_COPY[window].phrase}.`}
      />
    </CostPanel>
  );
}

/** A cost with its gaps: "$0.021", "$0.021+" when some calls have no cost (with a tooltip), "—" when none do. */
export function costCellText(value: number | null, unknown: number, calls: number): ReactNode {
  if (value === null) return <span className="text-rp-ink-subtle" title={calls ? `None of the ${calls} calls has a cost` : "No model calls"}>—</span>;
  if (!unknown) return fmtCost(value);
  return <span title={`${fmtCost(value)} from the calls with a cost; ${unknown} ${unknown === 1 ? "call has" : "calls have"} none and ${unknown === 1 ? "is" : "are"} not included`}>{fmtCost(value)}+</span>;
}
