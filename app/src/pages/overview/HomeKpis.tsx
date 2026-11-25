import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Overview } from "../../api/overview";
import { Sparkline, compact, sparklineTrend } from "../../components/charts";
import { fmt } from "../../utils/helpers";
import { fmtCost } from "../../utils/costs";
import { WINDOW_COPY, costLabel, formatRate, kpiDelta, kpiSeries, runsLink, sumKnown, type Delta } from "./home-model";

interface Tile {
  id: string;
  label: string;
  value: string;
  unit?: string;
  delta: Delta | null;
  detail: ReactNode;
  href: string;
  series: readonly (number | null)[];
  partial: readonly boolean[];
  sparkTone?: "accent" | "danger";
  cumulative?: boolean;
  title?: string;
}

/** Splits "23.6s" into value "23.6" and unit "s" so the unit can be set smaller; "$0.10" keeps its symbol. */
export function splitUnit(text: string): { value: string; unit?: string } {
  const match = /^([<−+\-$]?[\d.,]+)\s?([a-zA-Z%]+(?: [a-z]+)?)$/.exec(text);
  return match ? { value: match[1], unit: match[2] } : { value: text };
}

/** The trend word is read up to the point the sparkline emphasises, so the label and the line agree. */
export function sparkLabel(name: string, values: readonly (number | null)[], partial: readonly boolean[], window: string, cumulative = false): string {
  const word = sparklineTrend(values, partial, cumulative);
  return word ? `${name} trend ${window}: ${word}` : `${name} trend ${window}: not enough data`;
}

export function buildTiles(overview: Overview): Tile[] {
  const { kpis } = overview;
  const window = overview.window.selection;
  const series = kpiSeries(overview.timeseries);
  const copy = WINDOW_COPY[window];
  const runs = kpis.runs.value ?? 0;
  const failed = kpis.failed.value ?? 0;
  const withErrors = kpis.completedWithErrors.value ?? 0;
  const running = kpis.running.value ?? 0;
  const tokens = sumKnown(kpis.inputTokens.value, kpis.outputTokens.value);
  const previousTokens = sumKnown(kpis.inputTokens.previous, kpis.outputTokens.previous);
  const tokenUnknown = Math.max(kpis.inputTokens.unknownCalls, kpis.outputTokens.unknownCalls);
  const cost = kpis.costUsd;
  const costComparable = cost.unknownCalls === 0 && cost.previousUnknownCalls === 0;
  const p95 = kpis.durationP95Ms.value;
  const rateValue = formatRate(kpis.errorRate.value);

  return [
    {
      id: "runs",
      label: "Runs",
      ...splitUnit(compact(runs)),
      delta: kpiDelta(kpis.runs, "count"),
      detail: running ? `${running} running` : `${compact(kpis.activeAgents.value ?? 0)} ${(kpis.activeAgents.value ?? 0) === 1 ? "agent" : "agents"}`,
      href: runsLink({ window }),
      series: series.runs,
      partial: series.partial,
      cumulative: true,
      title: `Runs that started ${copy.phrase}`,
    },
    {
      id: "error-rate",
      label: "Error rate",
      ...splitUnit(rateValue),
      delta: kpiDelta(kpis.errorRate, "rate", "bad"),
      detail: kpis.errorRate.value === null ? "No finished runs yet" : `${failed} failed · ${withErrors} with errors`,
      href: runsLink({ status: ["failed", "completed_with_errors"], window }),
      series: series.errorRate,
      partial: series.partial,
      sparkTone: "danger",
      title: "Finished runs that failed or finished with errors",
    },
    {
      id: "p95-duration",
      label: "p95 duration",
      ...splitUnit(fmt(p95)),
      delta: kpiDelta(kpis.durationP95Ms, "duration", "bad"),
      detail: kpis.durationP95Ms.knownRuns ? `p50 ${fmt(kpis.durationP50Ms.value)} · ${kpis.durationP95Ms.knownRuns} ${kpis.durationP95Ms.knownRuns === 1 ? "run" : "runs"}` : "No finished runs yet",
      href: runsLink({ window, sort: "duration" }),
      series: series.p95,
      partial: series.partial,
      title: "95th percentile duration of finished runs",
    },
    {
      id: "tokens",
      label: "Tokens",
      ...splitUnit(tokens === null ? "—" : compact(tokens)),
      delta: tokenUnknown ? null : kpiDelta({ value: tokens, previous: previousTokens }, "count"),
      detail: tokens === null && !tokenUnknown ? "No model calls"
        : `${compact(kpis.inputTokens.value ?? 0)} in · ${compact(kpis.outputTokens.value ?? 0)} out${tokenUnknown ? ` · ${tokenUnknown} ${tokenUnknown === 1 ? "call" : "calls"} unknown` : ""}`,
      href: runsLink({ window, sort: "tokens" }),
      series: series.tokens,
      partial: series.partial,
      cumulative: true,
      title: "Input plus output tokens of every model call",
    },
    {
      id: "cost",
      label: costLabel(cost),
      value: cost.value === null ? "—" : fmtCost(cost.value),
      delta: costComparable ? kpiDelta(cost, "cost") : null,
      detail: cost.knownCalls + cost.unknownCalls === 0 ? "No model calls"
        : cost.unknownCalls
          ? `${cost.unknownCalls} of ${cost.knownCalls + cost.unknownCalls} calls without a price`
          : cost.estimatedCalls ? `List prices as of ${overview.pricing.asOf}` : `${cost.reportedCalls} reported ${cost.reportedCalls === 1 ? "call" : "calls"}`,
      href: runsLink({ window, sort: "cost" }),
      series: series.cost,
      partial: series.partial,
      cumulative: true,
      title: cost.estimatedCalls
        ? `Estimated from the bundled list prices (${overview.pricing.revision}); reported costs are used where a call carried one. Cache storage, audio, image and tool fees are not included.`
        : "Costs reported by the model calls",
    },
  ];
}

function DeltaBadge({ delta, window }: { delta: Delta | null; window: string }) {
  if (!delta) return <span className="text-rp-ink-subtle">No earlier data</span>;
  const Icon = delta.direction === "up" ? ArrowUpRight : delta.direction === "down" ? ArrowDownRight : Minus;
  return (
    <span
      className={cn("inline-flex items-center gap-0.5 font-medium", delta.tone === "bad" ? "text-rp-danger" : delta.tone === "good" ? "text-rp-success" : "text-rp-ink-muted")}
      title={delta.label}
      data-delta-tone={delta.tone}
    >
      <Icon aria-hidden="true" className="size-3.5" strokeWidth={2.25} />
      <span className="font-mono tabular-nums">{delta.text}</span>
      <span className="sr-only"> ({delta.label})</span>
      <span className="ml-1 font-normal text-rp-ink-subtle" aria-hidden="true">vs prev {window}</span>
    </span>
  );
}

export function KpiStrip({ overview, interactive = true }: { overview: Overview; interactive?: boolean }) {
  const tiles = buildTiles(overview);
  const window = WINDOW_COPY[overview.window.selection].short;
  return (
    <ul className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-rp-line bg-rp-line sm:grid-cols-6 xl:grid-cols-5" aria-label="Key numbers" data-home-kpis>
      {tiles.map((tile, index) => {
        const body = (
          <>
            <span className="rp-type-eyebrow text-rp-ink-subtle">{tile.label}</span>
            <span className="mt-2 flex items-end justify-between gap-3">
              <span className="flex min-w-0 items-baseline gap-1 text-rp-ink">
                <span className="rp-type-kpi" data-kpi-value>{tile.value}</span>
                {tile.unit && <span className="text-14 font-medium text-rp-ink-muted">{tile.unit}</span>}
              </span>
              <Sparkline className={cn("mb-1 w-[64px] shrink-0 2xl:w-[88px]", index > 0 && "max-sm:hidden")} values={tile.series} partial={tile.partial} cumulative={tile.cumulative} tone={tile.sparkTone} label={sparkLabel(tile.label, tile.series, tile.partial, WINDOW_COPY[overview.window.selection].phrase, tile.cumulative)} />
            </span>
            <span className="mt-1.5 flex min-h-5 flex-wrap items-center gap-x-1 text-12"><DeltaBadge delta={tile.delta} window={window} /></span>
            <span className="mt-0.5 truncate text-12 text-rp-ink-subtle" title={typeof tile.detail === "string" ? tile.detail : undefined}>{tile.detail}</span>
          </>
        );
        const classes = "flex h-full min-w-0 flex-col bg-rp-surface px-4 pb-3 pt-3";
        return (
          <li key={tile.id} className={cn("min-w-0 xl:col-span-1", index === 0 && "col-span-2", index < 3 ? "sm:col-span-2" : "sm:col-span-3")} data-kpi={tile.id}>
            {interactive ? (
              <Link to={tile.href} title={tile.title} className={cn(classes, "transition-colors duration-fast hover:bg-rp-row-hover focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--rp-focus)]")}>
                {body}
              </Link>
            ) : <div className={classes}>{body}</div>}
          </li>
        );
      })}
    </ul>
  );
}
