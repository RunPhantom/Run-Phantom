import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, CornerDownLeft, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmt } from "../../utils/helpers";
import { fmtCost } from "../../utils/costs";
import type { PlaygroundCallResult } from "../../api/playground";
import {
  costUnavailableReason, errorHelp, estimateResultCost, FINISH_REASON_LABEL, PRICE_LIST_DATE, recordedCostUsd, type LeadMetric,
} from "./playground-model";
import { diffStats, wordDiff } from "./word-diff";
import { Markdown } from "../Markdown";

export type ColumnState =
  | { status: "idle" }
  | { status: "running"; text: string; startedAt: number }
  | { status: "done"; result: PlaygroundCallResult; text: string }
  | { status: "stopped"; text: string; note: string; comparisonId: string | null; runId?: string; spanId?: string | null };

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="rp-num">{((now - since) / 1000).toFixed(1)}s</span>;
}

function Metric({ label, value, title, span = 1, numeric = true, lead }: { label: string; value: React.ReactNode; title?: string; span?: 1 | 2 | "full"; numeric?: boolean; lead?: string }) {
  return (
    <div className={cn("min-w-0", span === 2 && "col-span-2", span === "full" && "col-span-full")} title={title}>
      <dt className="font-mono text-[11px] uppercase tracking-[0.1em] text-rp-ink-muted">{label}</dt>
      <dd className={cn("mt-0.5 truncate text-[12px] text-rp-ink", numeric ? "font-mono tabular-nums" : "font-medium")}>
        {value}
        {lead && <span className="ml-1.5 font-sans text-[11px] font-medium text-rp-success" data-playground-lead>{lead}</span>}
      </dd>
    </div>
  );
}

const LEAD_LABEL: Record<LeadMetric, string> = { latency: "Fastest", firstToken: "Fastest", cost: "Cheapest" };

const tokenFormat = new Intl.NumberFormat("en-US");

function Metrics({ result, leads }: { result: PlaygroundCallResult; leads: readonly LeadMetric[] }) {
  const lead = (metric: LeadMetric) => leads.includes(metric) ? LEAD_LABEL[metric] : undefined;
  const cost = estimateResultCost(result);
  const usage = result.usage;
  const tokens = usage.inputTokens === null && usage.outputTokens === null
    ? "—"
    : `${usage.inputTokens === null ? "—" : tokenFormat.format(usage.inputTokens)} in · ${usage.outputTokens === null ? "—" : tokenFormat.format(usage.outputTokens)} out`;
  const reasoning = usage.reasoningTokens ? `${tokenFormat.format(usage.reasoningTokens)} of the output tokens were reasoning.` : undefined;
  return (
    <dl className="grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-x-3 gap-y-2 border-b border-rp-line-muted px-3 py-2.5" data-playground-metrics>
      <Metric label="Finish" numeric={false} value={result.finishReason ? FINISH_REASON_LABEL[result.finishReason] ?? result.finishReason : "—"} title={result.providerFinishReason ? `Provider reason: ${result.providerFinishReason}` : undefined} />
      <Metric label="Latency" value={fmt(result.latencyMs)} lead={lead("latency")} />
      <Metric label="First token" value={fmt(result.timeToFirstTokenMs)} lead={lead("firstToken")} title={result.timeToFirstTokenMs === null ? "No output streamed, so there is no first-token time." : undefined} />
      <Metric label="Tokens" span={2} value={tokens} title={reasoning} />
      <Metric
        label="Est. cost"
        span={2}
        value={cost.kind === "estimated" ? fmtCost(recordedCostUsd(cost.totalUsd)) : "—"}
        lead={lead("cost")}
        title={cost.kind === "estimated"
          ? `Estimated from ${cost.model} list prices as of ${PRICE_LIST_DATE}: $${cost.inputUsdPerMillion} in, $${cost.outputUsdPerMillion} out per million tokens.`
          : costUnavailableReason(cost)}
      />
      <Metric label="Model" span="full" value={result.responseModel ?? result.model} title={result.responseModel ?? result.model} />
    </dl>
  );
}

function DiffText({ base, baseLabel, text }: { base: string; baseLabel: string; text: string }) {
  const parts = wordDiff(base, text);
  const stats = diffStats(parts);
  return (
    <>
      <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.1em] text-rp-ink-muted">
        <span className="text-rp-success">+{stats.added}</span> <span className="text-rp-danger">−{stats.removed}</span> words vs. {baseLabel}
      </p>
      <p className="whitespace-pre-wrap break-words text-[13px] leading-[21px] text-rp-ink" data-playground-diff>
        {parts.map((part, index) => part.kind === "same"
          ? <span key={index}>{part.text}</span>
          : part.kind === "added"
            ? <ins key={index} className="rounded-[2px] bg-rp-success-soft px-0.5 text-rp-ink no-underline">{part.text}</ins>
            : <del key={index} className={cn("rounded-[2px] bg-rp-danger-soft px-0.5 text-rp-danger", parts[index + 1]?.kind === "added" && "mr-1")}>{part.text}</del>)}
      </p>
    </>
  );
}

export function ResultColumn({ index, title, subtitle, state, diffBase, leads = [], formatted, onAddToolRound }: {
  index: number;
  formatted: boolean;
  title: string;
  subtitle: string;
  state: ColumnState;
  /** The base column's text and name when the diff view is on and this column is compared against it. */
  diffBase: { text: string; label: string } | null;
  /** Metrics this column leads across the compared columns. */
  leads?: readonly LeadMetric[];
  onAddToolRound?: () => void;
}) {
  const result = state.status === "done" ? state.result : null;
  const error = result?.error ?? null;
  const help = error ? errorHelp(error.kind, error.key) : null;
  const text = state.status === "idle" ? "" : state.text;
  const headingId = `playground-column-${index}`;
  return (
    <section aria-labelledby={headingId} className="flex min-h-0 min-w-0 flex-col rounded-md border border-rp-line bg-rp-surface" data-playground-column={index}>
      <header className="flex items-baseline justify-between gap-2 border-b border-rp-line px-3 py-2.5">
        <h3 id={headingId} className="min-w-0 truncate font-sans text-[13px] font-semibold tracking-normal text-rp-ink">
          <span className="mr-2 font-mono text-[11px] font-medium text-rp-index">{String(index + 1).padStart(2, "0")}</span>{title}
        </h3>
        <span className="shrink-0 text-[12px] text-rp-ink-muted">
          {state.status === "running" ? <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="pulse-dot size-1.5 rounded-full bg-rp-mark-success" /><span className="sr-only">Running, </span><Elapsed since={state.startedAt} /></span>
            : state.status === "stopped" ? "Stopped"
              : result ? (result.status === "ok" ? "Done" : "Failed") : subtitle}
        </span>
      </header>
      {result && <Metrics result={result} leads={leads} />}
      <div className="sb min-h-[120px] flex-1 overflow-auto px-3 py-3" tabIndex={0} aria-label={`Output from ${title}`}>
        {state.status === "idle" && (
          <p className="text-[13px] leading-5 text-rp-ink-muted">Output appears here when you run the prompt.</p>
        )}
        {state.status === "stopped" && (
          <p className="mb-2 text-[13px] leading-5 text-rp-ink-muted">{state.note}</p>
        )}
        {state.status === "running" && !text && (
          <p className="text-[13px] leading-5 text-rp-ink-muted">Waiting for the first token…</p>
        )}
        {error && help && (
          <div role="alert" className="mb-3 rounded-sm border border-rp-danger-border bg-rp-danger-soft p-3" data-playground-error={error.kind}>
            <p className="flex items-center gap-1.5 text-[13px] font-semibold text-rp-danger">
              <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />{help.title}
            </p>
            <p className="mt-1 text-[13px] leading-5 text-rp-ink">{error.message}</p>
            <p className="mt-1 text-[13px] leading-5 text-rp-ink-soft">
              {help.hint}{help.settings && <> <Link to="/settings" className="font-medium text-rp-blue underline-offset-2 hover:underline">Open Settings</Link></>}
            </p>
            {error.providerMessage && (
              <details className="mt-2">
                <summary className="cursor-pointer text-[12px] font-medium text-rp-ink-soft">Provider message{error.httpStatus ? ` · HTTP ${error.httpStatus}` : ""}</summary>
                <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[12px] leading-[18px] text-rp-ink-soft">{error.providerMessage}</p>
              </details>
            )}
          </div>
        )}
        {text && (diffBase !== null && state.status === "done"
          ? <DiffText base={diffBase.text} baseLabel={diffBase.label} text={text} />
          : formatted
            ? <div className="text-[13px] leading-[21px] text-rp-ink" data-playground-output><Markdown>{text}</Markdown></div>
            : <p className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[19px] text-rp-ink" data-playground-output>{text}</p>)}
        {result?.finishReason === "length" && (
          <p className="mb-2 text-[13px] leading-5 text-rp-ink-soft" data-playground-truncated>The answer stopped at the max output tokens limit. Raise it and run again for a full answer.</p>
        )}
        {result?.status === "ok" && !text && !result.output.toolCalls.length && (
          <p className="text-[13px] leading-5 text-rp-ink-muted">The model returned no text.</p>
        )}
        {result && result.output.toolCalls.length > 0 && (
          <div className="mt-3">
            <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-rp-ink-muted">Tool calls</p>
            <ul className="mt-1.5 space-y-1.5">
              {result.output.toolCalls.map(call => (
                <li key={call.id} className="rounded-sm border border-rp-line bg-rp-canvas-blue px-2.5 py-2 font-mono text-[12px] leading-[18px] text-rp-ink">
                  <span className="font-semibold text-rp-blue">{call.name}</span>
                  <pre className="mt-1 whitespace-pre-wrap break-all">{JSON.stringify(call.arguments, null, 2)}</pre>
                </li>
              ))}
            </ul>
            {onAddToolRound && (
              <button
                type="button"
                onClick={onAddToolRound}
                className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-control border border-rp-line bg-rp-surface px-3 text-[12px] font-medium text-rp-ink transition-colors duration-fast ease-out hover:border-rp-wash-border hover:bg-rp-wash hover:text-rp-blue focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rp-blue"
              >
                <CornerDownLeft aria-hidden="true" className="size-3.5" /> Continue with tool results
              </button>
            )}
          </div>
        )}
        {result && result.warnings.length > 0 && (
          <ul className="mt-3 space-y-1" aria-label="Warnings">
            {result.warnings.map(warning => (
              <li key={warning} className="text-[12px] leading-[18px] text-rp-ink-soft">
                <span className="mr-1 font-medium text-rp-warning">Note</span>{warning}
              </li>
            ))}
          </ul>
        )}
      </div>
      {result && (
        <footer className="flex items-center justify-between gap-2 border-t border-rp-line-muted px-3 py-2 text-[12px]">
          {result.runId ? (
            <>
              <span className="min-w-0 truncate text-rp-ink-muted">Recorded</span>
              <Link
                to={result.spanId ? `/runs/${result.runId}/span/${result.spanId}` : `/runs/${result.runId}`}
                className="inline-flex shrink-0 items-center gap-1 font-medium text-rp-blue underline-offset-2 hover:underline"
                data-playground-run-link={result.runId}
                aria-label={`Open run ${result.runId.slice(0, 8)} in Runs`}
              >
                Run <span className="font-mono">{result.runId.slice(0, 8)}</span> <ArrowUpRight aria-hidden="true" className="size-3.5" />
              </Link>
            </>
          ) : (
            <span className="text-rp-ink-muted">Not recorded: nothing was sent to the provider.</span>
          )}
        </footer>
      )}
      {state.status === "stopped" && state.runId && (
        <footer className="flex items-center justify-between gap-2 border-t border-rp-line-muted px-3 py-2 text-[12px]">
          <span className="min-w-0 truncate text-rp-ink-muted">Recorded as cancelled</span>
          <Link
            to={state.spanId ? `/runs/${state.runId}/span/${state.spanId}` : `/runs/${state.runId}`}
            className="inline-flex shrink-0 items-center gap-1 font-medium text-rp-blue underline-offset-2 hover:underline"
            data-playground-run-link={state.runId}
            aria-label={`Open cancelled run ${state.runId.slice(0, 8)} in Runs`}
          >
            Run <span className="font-mono">{state.runId.slice(0, 8)}</span> <ArrowUpRight aria-hidden="true" className="size-3.5" />
          </Link>
        </footer>
      )}
    </section>
  );
}
