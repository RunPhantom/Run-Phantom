import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CostAnalyticsReport, MetricPopulation } from "../../../../src/pricing/analytics";
import { TOKEN_CATEGORIES } from "../../../../src/pricing/protocol";
import { PRICE_TABLE_AS_OF } from "../../../../src/pricing/list-prices";
import { Select } from "../ui/input";
import { fmtCost } from "../../utils/costs";
import { populationSentences, ratePolicyLines, reasonLines } from "./cost-model";

const dateTime = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function Amount({ value, money = false }: { value: MetricPopulation; money?: boolean }) {
  const text = value.knownSum === null ? "—" : money ? fmtCost(value.knownSum) : value.knownSum.toLocaleString("en-US");
  const total = value.eligibleCount;
  const note = total === 0 ? "no calls" : value.knownCount === total ? `all ${total}` : `${value.knownCount} of ${total}`;
  return (
    <>
      <span className={cn("block font-mono tabular-nums", value.knownSum === null ? "text-rp-ink-subtle" : "text-rp-ink")}>{text}{value.sumState === "overflow" ? " (too large to add up)" : ""}</span>
      <span className="block text-11 text-rp-ink-subtle">{note}</span>
    </>
  );
}

function ReasonList({ title, metric }: { title: string; metric: MetricPopulation }) {
  const lines = reasonLines(metric);
  if (!lines.length) return null;
  return (
    <div>
      <h4 className="text-13 font-medium text-rp-ink">{title}</h4>
      <ul className="mt-1 space-y-0.5 text-13 text-rp-ink-muted">
        {lines.map(line => <li key={line.text} className="flex gap-2"><span className="min-w-[3ch] text-right font-mono tabular-nums text-rp-ink">{line.count.toLocaleString("en-US")}</span><span>{line.text}</span></li>)}
      </ul>
    </div>
  );
}

function estimateExplanation(report: CostAnalyticsReport): string {
  if (report.estimateMode === "list-prices") return `Estimates multiply each call's input, output and cached-input tokens by the list prices bundled with Run Phantom, read from the OpenAI, Anthropic and Google pricing pages on ${PRICE_TABLE_AS_OF}. Dated model ids such as gpt-5-nano-2025-08-07 use their listed model's price. Cache storage, audio, discounts, fees and calls through other vendors are not priced.`;
  if (report.estimateMode === "nominal-input-output") return "Estimates use the input and output prices in the OpenRouter public catalogue. They do not account for your provider, tier, caching, reasoning, audio, discounts or fees, so they are a rough guide rather than an invoice.";
  if (report.rateRevisions.length) return "Estimates use only the frozen provider, model and tier rates you applied, with the token categories each rate declares.";
  return "Estimates are off. Only the cost each call reported is shown.";
}

/**
 * The detailed accounting behind the page: who is counted, why some calls have no value, every breakdown and the
 * exact rates. Closed by default; the page above shows the totals.
 */
export function CostAccounting({ report }: { report: CostAnalyticsReport }) {
  const [dimension, setDimension] = useState<"byModel" | "byProvider" | "byProject" | "byTime">("byModel");
  const id = useId();
  const labels = { byModel: "Model", byProvider: "Provider", byProject: "Project", byTime: "Time (UTC)" };
  const th = "py-2 pr-4 font-mono text-11 font-medium uppercase tracking-[0.08em] text-rp-ink-subtle";
  return (
    <details className="group rounded-lg border border-rp-line bg-rp-surface" data-cost-accounting>
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 text-14 font-semibold text-rp-ink transition-colors duration-fast hover:bg-rp-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--rp-focus)] [&::-webkit-details-marker]:hidden">
        <span>How this is calculated</span>
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-rp-ink-subtle transition-transform duration-state ease-out group-open:rotate-180 motion-reduce:transition-none" />
      </summary>
      <div className="space-y-5 border-t border-rp-line-muted px-4 pb-4 pt-3 text-14 leading-6 text-rp-ink">
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-2">
            <h3 className="rp-type-eyebrow text-rp-ink-subtle">What is counted</h3>
            {populationSentences(report.population).map(line => <p key={line} data-cost-population>{line}</p>)}
            <p className="text-13 text-rp-ink-muted">
              Window: {dateTime.format(report.window.from)} to {dateTime.format(report.window.to)}, by each call&rsquo;s start time.
              {report.window.bucket === "day" ? " Days in the chart are UTC calendar days." : ""} The exported JSON has the exact UTC bounds.
            </p>
          </div>
          <div className="space-y-2">
            <h3 className="rp-type-eyebrow text-rp-ink-subtle">Estimated and reported</h3>
            <p>{estimateExplanation(report)}</p>
            <p>Reported spend is the cost a call carried itself (for example <code className="font-mono text-13">gen_ai.usage.cost_usd</code>). It is never replaced by an estimate. Run Phantom does not check either figure against provider invoices.</p>
            <p className="text-13 text-rp-ink-muted">A call with no value counts as unknown, never as zero, so totals marked &ldquo;of&rdquo; cover only part of the calls.</p>
          </div>
        </div>
        {(report.estimatedUsd.unavailableCount > 0 || report.reportedUsd.unavailableCount > 0 || report.tokens.input.unavailableCount > 0) && (
          <div className="grid gap-4 border-t border-rp-line-muted pt-4 md:grid-cols-3">
            {report.estimateMode !== "captured" || report.rateRevisions.length ? <ReasonList title="Calls without an estimate" metric={report.estimatedUsd} /> : null}
            <ReasonList title="Calls without a reported cost" metric={report.reportedUsd} />
            <ReasonList title="Calls without input tokens" metric={report.tokens.input} />
          </div>
        )}
        <section aria-labelledby={`${id}-breakdown`} className="border-t border-rp-line-muted pt-4">
          <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
            <h3 id={`${id}-breakdown`} className="text-14 font-semibold">Breakdown</h3>
            <label className="flex items-center gap-2">
              <span className="whitespace-nowrap text-12 text-rp-ink-subtle">Group by</span>
              <Select aria-label="Group by" className="h-8 min-w-[10rem] text-13" value={dimension} onChange={event => setDimension(event.target.value as typeof dimension)}>
                {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </Select>
            </label>
          </div>
          <div className="overflow-auto" tabIndex={0} role="region" aria-label="Cost breakdown table">
            <table className="w-full min-w-[560px] text-left text-13">
              <thead>
                <tr className="border-b border-rp-line">
                  <th scope="col" className={th}>{labels[dimension]}</th>
                  <th scope="col" className={cn(th, "text-right")}>Reported</th>
                  <th scope="col" className={cn(th, "text-right")}>Estimated</th>
                  <th scope="col" className={cn(th, "text-right")}>Input tokens</th>
                  <th scope="col" className={cn(th, "pr-0 text-right")}>Output tokens</th>
                </tr>
              </thead>
              <tbody>
                {report[dimension].map(row => (
                  <tr key={row.identity ?? "unknown"} className="border-b border-rp-line-muted last:border-0">
                    <th scope="row" className={cn("max-w-[260px] break-words py-2 pr-4 font-normal", row.identity === null ? "text-rp-ink-subtle" : "font-mono text-12")}>
                      {row.identity ?? (dimension === "byTime" ? "No start time" : `${labels[dimension]} not reported`)}
                    </th>
                    <td className="py-2 pr-4 text-right"><Amount value={row.reportedUsd} money /></td>
                    <td className="py-2 pr-4 text-right"><Amount value={row.estimatedUsd} money /></td>
                    <td className="py-2 pr-4 text-right"><Amount value={row.tokens.input} /></td>
                    <td className="py-2 text-right"><Amount value={row.tokens.output} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {report[dimension].length === 0 && <p className="py-4 text-center text-13 text-rp-ink-subtle">No model calls in this window.</p>}
          </div>
        </section>
        <section aria-label="Categorized usage" className="border-t border-rp-line-muted pt-4">
          <h3 className="text-14 font-semibold">Tokens by category</h3>
          <p className="mt-1 text-13 text-rp-ink-muted">Categories can overlap (cached input is often part of input), so they are listed separately and never added together.</p>
          <dl className="mt-3 grid gap-px overflow-hidden rounded-md border border-rp-line-muted bg-rp-line-muted sm:grid-cols-2 lg:grid-cols-4">
            {TOKEN_CATEGORIES.map(category => (
              <div key={category} className="bg-rp-surface px-3 py-2">
                <dt className="rp-type-eyebrow text-rp-ink-subtle">{category.replace(/_/g, " ")}</dt>
                <dd className="mt-1 text-13"><Amount value={report.tokens[category]} /></dd>
              </div>
            ))}
          </dl>
        </section>
        <section aria-label="Rates used" className="border-t border-rp-line-muted pt-4 text-13 text-rp-ink-muted">
          <h3 className="text-14 font-semibold text-rp-ink">Rates used</h3>
          {report.rateRevisions.length === 0
            ? <p className="mt-1">No rates were used. Reported cost and token counts do not depend on rates.</p>
            : (
              <ul className="mt-2 grid gap-2 md:grid-cols-2">
                {report.rateRevisions.map(rate => (
                  <li key={JSON.stringify([rate.provider, rate.model, rate.tier, rate.revision])} className="rounded-md border border-rp-line-muted px-3 py-2 break-words">
                    <strong className="font-mono text-12 text-rp-ink">{rate.model}</strong>
                    <p>{rate.provider} · {rate.tier} · {rate.currency} {rate.unit}</p>
                    <p>{rate.source.name} · read {rate.source.observedAt}</p>
                    <p>Revision {rate.revision} · {rate.version}</p>
                    {ratePolicyLines(rate).map(line => <p key={line} className="mt-1 text-12 leading-5" data-rate-policy>{line}</p>)}
                  </li>
                ))}
              </ul>
            )}
          <p className="mt-2 break-words">Captured data revision <code className="font-mono text-12 text-rp-ink">{report.sourceRevision}</code> · {report.population.acquiredSpans.toLocaleString("en-US")} steps read · computed {dateTime.format(report.asOf)}.</p>
        </section>
      </div>
    </details>
  );
}
