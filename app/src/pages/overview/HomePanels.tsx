import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import type { LatestRunRow, Overview, OverviewLiveRun, OverviewWindow } from "../../api/overview";
import { Skeleton } from "@/components/ui/skeleton";
import { BarList, ChartFrame, StackedBars, compact, relativeTimeLabel, type StackSeries } from "../../components/charts";
import { ago, fmt, runDisplayName, runStatus, runStatusTone } from "../../utils/helpers";
import { fmtCost } from "../../utils/costs";
import { runPath, traceSpanPath } from "../../utils/navigation";
import { useRunStatus } from "../../hooks/use-run-status";
import { WINDOW_COPY, bucketTitle, formatRate, formatTokens, runsLink, sumKnown } from "./home-model";

export function Panel({ id, title, meta, children, className, footer }: {
  id: string;
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
  footer?: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className={cn("flex h-full min-w-0 flex-col rounded-lg border border-rp-line bg-rp-surface p-4", className)} data-home-panel={id}>
      <div className="flex min-h-6 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id={id} className="text-14 font-semibold text-rp-ink">{title}</h2>
        {meta && <div className="font-mono text-12 text-rp-ink-subtle">{meta}</div>}
      </div>
      <div className="mt-3 flex min-h-0 flex-1 flex-col">{children}</div>
      {footer && <div className="mt-3 border-t border-rp-line-muted pt-2.5 text-12 text-rp-ink-subtle">{footer}</div>}
    </section>
  );
}

const BUCKET_NOUN: Record<OverviewWindow, string> = { "1h": "5 minutes", "24h": "hour", "7d": "6 hours", "30d": "day" };

export const RUN_SERIES: readonly StackSeries[] = [
  { id: "ok", label: "No errors", color: "var(--rp-chart-ok)" },
  { id: "errors", label: "With errors", color: "var(--rp-chart-warn)" },
  { id: "failed", label: "Failed", color: "var(--rp-chart-fail)" },
  { id: "open", label: "No recorded end", color: "var(--rp-chart-history)" },
];

export function RunsOverTimePanel({ overview, interactive = true }: { overview: Overview; interactive?: boolean }) {
  const navigate = useNavigate();
  const window = overview.window.selection;
  const buckets = overview.timeseries;
  const anyOpen = buckets.some(bucket => bucket.runs > bucket.finished);
  const series = anyOpen ? RUN_SERIES : RUN_SERIES.filter(item => item.id !== "open");
  const stack = buckets.map(bucket => ({
    key: bucket.start,
    title: bucketTitle(bucket, window),
    values: [Math.max(0, bucket.finished - bucket.failed - bucket.completedWithErrors), bucket.completedWithErrors, bucket.failed, ...(anyOpen ? [bucket.runs - bucket.finished] : [])],
    partial: bucket.partial,
    notes: bucket.runs ? [bucketUsage(bucket)] : undefined,
  }));
  const total = overview.kpis.runs.value ?? 0;
  const peak = buckets.reduce((best, bucket) => (bucket.runs > (best?.runs ?? 0) ? bucket : best), null as (typeof buckets)[number] | null);
  const failed = overview.kpis.failed.value ?? 0;
  const summary = total
    ? `Runs per ${BUCKET_NOUN[window]} ${WINDOW_COPY[window].phrase}: ${total} in total, ${failed} failed, ${overview.kpis.completedWithErrors.value ?? 0} finished with errors.${peak ? ` Busiest: ${bucketTitle(peak, window)} with ${peak.runs}.` : ""}`
    : `No runs ${WINDOW_COPY[window].phrase}.`;
  const titleId = "home-runs-over-time";
  return (
    <section aria-labelledby={titleId} className="flex h-full min-w-0 flex-col rounded-lg border border-rp-line bg-rp-surface p-4" data-home-panel="runs-over-time">
      <ChartFrame
        interactive
        className="flex-1"
        title={<h2 id={titleId} className="text-14 font-semibold text-rp-ink">Runs per {BUCKET_NOUN[window]}</h2>}
        summary={summary}
        legend={series.map(item => ({ label: item.label, color: item.color }))}
        table={{
          caption: `Runs per ${BUCKET_NOUN[window]}`,
          columns: ["Time", "Runs", "With errors", "Failed", ...(anyOpen ? ["No recorded end"] : []), "Tokens", "Cost"],
          rows: buckets.filter(bucket => bucket.runs > 0).map(bucket => [
            `${bucketTitle(bucket, window)}${bucket.partial ? " (partial)" : ""}`,
            bucket.runs,
            bucket.completedWithErrors,
            bucket.failed,
            ...(anyOpen ? [bucket.runs - bucket.finished] : []),
            compact(bucket.inputTokens + bucket.outputTokens) + (bucket.tokenUnknownCalls ? ` + ${bucket.tokenUnknownCalls} unknown` : ""),
            bucket.costUsd === null ? "Unknown" : fmtCost(bucket.costUsd) + (bucket.costUnknownCalls ? ` + ${bucket.costUnknownCalls} unknown` : ""),
          ]),
        }}
      >
        <StackedBars
          label={summary}
          buckets={stack}
          series={series}
          minHeight={160}
          axisLabels={index => index === buckets.length - 1 ? "now"
            : relativeTimeLabel(index === 0 ? overview.window.from : (overview.window.from + overview.window.to) / 2, overview.window.to)}
          emptyLabel={`No runs ${WINDOW_COPY[window].phrase}`}
          onActivate={interactive ? index => {
            const bucket = buckets[index];
            if (bucket.runs) navigate(runsLink({ since: Math.max(bucket.start, overview.window.from), until: Math.min(bucket.end, overview.window.to) }));
          } : undefined}
          activateHint="Click to open these runs"
        />
      </ChartFrame>
    </section>
  );
}

function bucketUsage(bucket: Overview["timeseries"][number]): string {
  const tokens = `${compact(bucket.inputTokens + bucket.outputTokens)} tokens${bucket.tokenUnknownCalls ? ` + ${bucket.tokenUnknownCalls} calls unknown` : ""}`;
  const cost = bucket.costUsd === null ? "cost unknown" : `${fmtCost(bucket.costUsd)}${bucket.costUnknownCalls ? ` + ${bucket.costUnknownCalls} unpriced` : ""}`;
  return `${tokens} · ${cost}`;
}

function Dot({ tone, pulse }: { tone: "danger" | "warning" | "success" | "neutral" | "accent"; pulse?: boolean }) {
  const color = tone === "danger" ? "bg-rp-mark-danger" : tone === "warning" ? "bg-rp-mark-warning" : tone === "success" ? "bg-rp-mark-success" : tone === "accent" ? "bg-rp-mark" : "bg-[color:var(--rp-ink-faint)]";
  return <span aria-hidden="true" className={cn("mt-1.5 size-2 shrink-0 rounded-full", color, pulse && "pulse-dot")} />;
}

export function NeedsALookPanel({ overview }: { overview: Overview }) {
  const tools = overview.topFailingTools.slice(0, 2);
  const failures = overview.recentFailures.slice(0, tools.length ? 2 : 4);
  const failed = overview.kpis.failed.value ?? 0;
  const withErrors = overview.kpis.completedWithErrors.value ?? 0;
  const window = overview.window.selection;
  return (
    <Panel
      id="home-needs-a-look"
      title="Needs a look"
      meta={failed || withErrors ? <Link to={runsLink({ status: ["failed", "completed_with_errors"], window })} className="rp-touch-target rounded-control underline-offset-4 hover:text-rp-blue hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--rp-focus)]">{failed} failed · {withErrors} with errors</Link> : null}
    >
      {failures.length === 0 ? (
        <p className="flex items-start gap-2 py-2 text-13 text-rp-ink-muted"><Dot tone="success" />Nothing needs a look. No run failed or hit an error {WINDOW_COPY[window].phrase}.</p>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {failures.map(failure => {
            const target = failure.error ? traceSpanPath("/runs", failure.runId, failure.error.spanId) : runPath(failure.runId);
            const step = failure.error?.step;
            const message = failure.error?.message;
            return (
              <li key={failure.runId}>
                <Link
                  to={target}
                  className="flex items-start gap-2.5 rounded-sm px-2 py-0.5 leading-5 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:py-1 transition-colors duration-fast hover:bg-rp-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--rp-focus)]"
                  data-needs-a-look={failure.runId}
                >
                  <Dot tone={failure.status === "failed" ? "danger" : "warning"} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-13 font-medium text-rp-ink">{failure.name}</span>
                      <span className="shrink-0 font-mono text-12 text-rp-ink-subtle">{ago(failure.startedAt)}</span>
                    </span>
                    <span className="block truncate text-12 text-rp-ink-subtle" title={message ?? undefined}>
                      <span className="sr-only">{failure.status === "failed" ? "Failed. " : "Finished with errors. "}</span>
                      {step ? <span className="font-mono text-rp-ink-muted">{step}</span> : null}
                      {step && message ? " · " : null}
                      {message ?? (step ? null : `${failure.errorCount} ${failure.errorCount === 1 ? "error" : "errors"}`)}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {tools.length > 0 && (
        <div className="mt-auto pt-3"><div className="border-t border-rp-line-muted pt-2.5">
          <h3 className="rp-type-eyebrow text-rp-ink-subtle">Failing tools</h3>
          <ul className="-mx-2 mt-1">
            {tools.map(tool => (
              <li key={tool.tool}>
                <Link
                  to={traceSpanPath("/runs", tool.lastError.runId, tool.lastError.spanId)}
                  title={tool.lastError.message ?? undefined}
                  className="flex items-baseline justify-between gap-3 rounded-sm px-2 py-1 [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:min-h-11 text-13 transition-colors duration-fast hover:bg-rp-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--rp-focus)]"
                  data-failing-tool={tool.tool}
                >
                  <span className="truncate font-mono text-12 text-rp-ink">{tool.tool}</span>
                  <span className="shrink-0 font-mono text-12 tabular-nums text-rp-ink-subtle">
                    <span className="text-rp-danger">{tool.failures}</span> of {tool.calls} {tool.calls === 1 ? "call" : "calls"} failed
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div></div>
      )}
    </Panel>
  );
}

export function AgentsPanel({ overview }: { overview: Overview }) {
  const window = overview.window.selection;
  const rows = overview.byAgent.slice(0, 6);
  const total = overview.byAgent.length;
  return (
    <Panel
      id="home-agents"
      title="Agents"
      meta={`${overview.kpis.activeAgents.value ?? 0} active`}
      footer={total > rows.length || overview.truncated.byAgent ? <>Top {rows.length} of {overview.truncated.byAgent ? `${total}+` : total} by runs · <Link className="rp-touch-target min-w-11 justify-center text-rp-blue underline-offset-4 hover:underline" to={runsLink({ window })}>All runs</Link></> : undefined}
    >
      <BarList
        caption={`Agents ${WINDOW_COPY[window].phrase}, by runs`}
        rows={rows}
        rowKey={row => row.agent ?? "\0unnamed"}
        nameHeader="Agent"
        name={row => row.agent ?? <span className="italic text-rp-ink-subtle">Unnamed agent</span>}
        nameTitle={row => row.agent ?? "Runs that reported no agent name. The Runs page has no filter for them, so this row is not a link."}
        href={row => (row.agent ? runsLink({ agent: row.agent, window }) : undefined)}
        bar={{ header: "Runs", value: row => row.runs }}
        barPlacement="under"
        columns={[
          { id: "runs", header: "Runs", cell: row => row.runs },
          { id: "failed", header: "Failed", headerTitle: "Share of finished runs whose root step failed", cell: row => <span className={row.failed ? "text-rp-danger" : undefined}>{formatRate(row.failureRate)}</span> },
          { id: "p95", header: "p95", headerTitle: "95th percentile run duration", cell: row => fmt(row.durationP95Ms) },
        ]}
        emptyLabel={`No agents ran ${WINDOW_COPY[window].phrase}.`}
      />
    </Panel>
  );
}

export function ModelsPanel({ overview }: { overview: Overview }) {
  const window = overview.window.selection;
  const rows = overview.byModel.slice(0, 5);
  const anyEstimated = overview.kpis.costUsd.estimatedCalls > 0;
  const unknownCalls = overview.byModel.reduce((sum, row) => sum + row.costUnknownCalls, 0);
  return (
    <Panel
      id="home-models"
      title="Models"
      meta={`${overview.byModel.reduce((sum, row) => sum + row.calls, 0)} calls`}
      footer={rows.length ? (
        <span title={`Price list ${overview.pricing.revision}. Cache storage, audio, image and tool fees are not included.`}>
          {anyEstimated ? `Costs estimated from list prices as of ${overview.pricing.asOf}` : "Costs as reported by the calls"}
          {unknownCalls ? ` · ${unknownCalls} ${unknownCalls === 1 ? "call" : "calls"} without a price` : ""}
        </span>
      ) : undefined}
    >
      <BarList
        caption={`Models ${WINDOW_COPY[window].phrase}, by calls`}
        rows={rows}
        rowKey={row => row.model ?? "\0unknown"}
        nameHeader="Model"
        name={row => row.model ? <span className="font-mono text-12">{row.model}</span> : <span className="italic text-rp-ink-subtle">Unknown model</span>}
        nameTitle={row => row.model ? [row.model, row.provider].filter(Boolean).join(" · ") : "Model calls that reported no model name. The Runs page has no filter for them, so this row is not a link."}
        href={row => (row.model ? runsLink({ model: row.model, window }) : undefined)}
        bar={{ header: "Calls", value: row => row.calls }}
        barPlacement="under"
        columns={[
          { id: "calls", header: "Calls", cell: row => row.calls },
          { id: "tokens", header: "Tokens", headerTitle: "Input plus output tokens", cell: row => {
            const known = sumKnown(row.inputTokens, row.outputTokens);
            return <span title={row.tokenUnknownCalls ? `${row.tokenUnknownCalls} of ${row.calls} ${row.calls === 1 ? "call" : "calls"} did not report tokens` : undefined}>{formatTokens(known)}{known !== null && row.tokenUnknownCalls ? "+" : ""}</span>;
          } },
          { id: "cost", header: anyEstimated ? "Est." : "Cost", headerTitle: anyEstimated ? "Estimated cost" : "Reported cost", cell: row => <span title={row.costUnknownCalls ? `${row.costUnknownCalls} of ${row.calls} calls have no price` : undefined}>{row.costUsd === null ? "—" : fmtCost(row.costUsd)}{row.costUsd !== null && row.costUnknownCalls ? "+" : ""}</span> },
        ]}
        emptyLabel={`No model calls ${WINDOW_COPY[window].phrase}.`}
      />
    </Panel>
  );
}

const TONE_DOT = { success: "success", warning: "warning", danger: "danger", neutral: "neutral" } as const;
const NO_FRESH: ReadonlySet<string> = new Set();

function ActivityLine({ id, href, status, statusLabel, tone, live, name, meta, at, fresh }: {
  id: string;
  href: string;
  status: string;
  statusLabel: string;
  tone: keyof typeof TONE_DOT;
  live: boolean;
  name: string;
  meta: readonly (string | null | undefined)[];
  at: number;
  fresh: boolean;
}) {
  const parts = meta.filter(Boolean);
  return (
    <li className={fresh ? "rp-flash rounded-sm" : undefined}>
      <Link
        to={href}
        className="flex items-start gap-2.5 rounded-sm px-2 py-0.5 leading-5 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:py-1 transition-colors duration-fast hover:bg-rp-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--rp-focus)]"
        data-activity-run={id}
        data-activity-status={status}
      >
        <Dot tone={TONE_DOT[tone]} pulse={live} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-3">
            <span className="truncate text-13 font-medium text-rp-ink">{name}</span>
            <span className="shrink-0 font-mono text-12 text-rp-ink-subtle">{ago(at)}</span>
          </span>
          <span className="block truncate text-12 text-rp-ink-subtle">
            <span className={tone === "danger" ? "text-rp-danger" : tone === "warning" ? "text-rp-warning" : live ? "text-rp-success" : undefined}>{statusLabel}</span>
            {parts.length ? ` · ${parts.join(" · ")}` : ""}
          </span>
        </span>
      </Link>
    </li>
  );
}

const stepCount = (count: number) => `${count} ${count === 1 ? "step" : "steps"}`;

function ActivityRow({ run, fresh }: { run: LatestRunRow; fresh: boolean }) {
  const status = useRunStatus(run) ?? runStatus(run);
  const live = status.status === "live";
  return (
    <ActivityLine
      id={run.id}
      href={runPath(run.id)}
      status={status.status}
      statusLabel={status.label}
      tone={runStatusTone(status.status)}
      live={live}
      name={runDisplayName(run)}
      meta={[stepCount(run.span_count ?? 0), run.duration_ms !== null && !live ? fmt(run.duration_ms) : null, run.primary_model]}
      at={run.last_updated_at}
      fresh={fresh}
    />
  );
}

type ActivityItem = { id: string; run: LatestRunRow; live?: undefined } | { id: string; live: OverviewLiveRun; run?: undefined };

/**
 * Running runs first (the overview's liveRuns: still open, with a step in the last
 * ten minutes), then the newest runs from GET /api/runs, up to `limit`. A run in both
 * lists uses its /api/runs row, whose status the WebSocket keeps current.
 */
export function activityItems(runs: readonly LatestRunRow[], liveRuns: readonly OverviewLiveRun[], limit: number): ActivityItem[] {
  const byId = new Map(runs.map(run => [run.id, run]));
  const liveIds = new Set(liveRuns.map(run => run.runId));
  const items: ActivityItem[] = liveRuns.map(live => {
    const run = byId.get(live.runId);
    return run ? { id: run.id, run } : { id: live.runId, live };
  });
  for (const run of runs) if (!liveIds.has(run.id)) items.push({ id: run.id, run });
  return items.slice(0, limit);
}

/**
 * Ids that appeared since the previous render with data. The first list that
 * arrives is the baseline, so nothing flashes on load.
 */
function useFreshIds(ids: readonly string[] | null): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(NO_FRESH);
  const key = ids?.join("\n") ?? null;
  useEffect(() => {
    if (key === null) return;
    const current = key ? key.split("\n") : [];
    if (seen.current === null) { seen.current = new Set(current); return; }
    const added = current.filter(id => !seen.current!.has(id));
    for (const id of added) seen.current.add(id);
    if (added.length) setFresh(new Set(added));
  }, [key]);
  return fresh;
}

export function ActivityPanel({ runs, liveRuns, limit = 8 }: { runs: readonly LatestRunRow[] | undefined; liveRuns: readonly OverviewLiveRun[]; limit?: number }) {
  const items = runs ? activityItems(runs, liveRuns, limit) : null;
  const fresh = useFreshIds(items ? items.map(item => item.id) : null);
  return (
    <Panel
      id="home-activity"
      title="Latest activity"
      meta={liveRuns.length ? <span className="flex items-center gap-1.5"><span aria-hidden="true" className="pulse-dot size-1.5 rounded-full bg-rp-mark-success" />{liveRuns.length} running</span> : "Nothing running"}
      footer={<Link className="rp-touch-target text-rp-blue underline-offset-4 hover:underline" to="/runs">Open Runs</Link>}
    >
      {items === null
        ? <div role="status" aria-label="Loading latest runs">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="mt-2 h-8 w-full first:mt-0" />)}</div>
        : items.length === 0
          ? <p className="py-2 text-13 text-rp-ink-subtle">New runs appear here as their steps arrive.</p>
          : (
            <ul className="-mx-2 flex flex-col">
              {items.map(item => item.run
                ? <ActivityRow key={item.id} run={item.run} fresh={fresh.has(item.id)} />
                : (
                  <ActivityLine
                    key={item.id}
                    id={item.id}
                    href={runPath(item.id)}
                    status="live"
                    statusLabel="Running"
                    tone="success"
                    live
                    name={item.live.name}
                    meta={[stepCount(item.live.spanCount), item.live.model]}
                    at={item.live.lastUpdatedAt}
                    fresh={fresh.has(item.id)}
                  />
                ))}
            </ul>
          )}
    </Panel>
  );
}
