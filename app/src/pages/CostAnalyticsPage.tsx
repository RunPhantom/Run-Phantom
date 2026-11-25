import { Link } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CostAnalyticsWorkspace, type CostContext } from "../components/CostAnalytics";
import { CostPanel, costCellText } from "../components/cost/CostPanels";
import { COST_WINDOW_COPY, formatShare } from "../components/cost/cost-model";
import { BarList, compact } from "../components/charts";
import { JudgeSpendSummary } from "../components/evaluations/JudgeCost";
import { getLocalPricingAnalytics } from "../api/pricing";
import { evaluationsApi } from "../api/evaluations";
import { getOverview, type OverviewAgentRow } from "../api/overview";
import { listRunsPage, type RunListRow } from "../api/runs";
import { useShortRunIds } from "../components/RunList";
import { absoluteTime, modelCell } from "../runs/table-model";
import { ago, runDisplayName } from "../utils/helpers";
import { runPath } from "../utils/navigation";
import { runsLink } from "./overview/home-model";
import { PRICE_TABLE_AS_OF } from "../../../src/pricing/list-prices";

const TOP_RUNS = 8;
const SHARED_RULE = `Reported cost where a call has one, otherwise list prices (${PRICE_TABLE_AS_OF}).`;

function EvaluationJudgeSpend() {
  const totals = useQuery({ queryKey: ["evaluations", "judge-spend"], queryFn: ({ signal }) => evaluationsApi.judgeSpend(signal) });
  return (
    <section aria-label="Evaluation judge spend" className="rounded-lg border border-rp-line bg-rp-surface p-4">
      <h2 className="text-14 font-semibold text-rp-ink">Grader spend</h2>
      <p className="mt-1 text-13 text-rp-ink-muted">Model graders in evaluations are billed to your provider account but are not captured runs, so they are not in the totals above.</p>
      <div className="mt-2">
        {totals.isPending ? <p className="text-12 text-rp-ink-subtle">Loading grader spend…</p>
          : totals.isError ? <p role="alert" className="text-12 text-rp-danger">Grader spend is unavailable.</p>
          : <>
            <JudgeSpendSummary spend={totals.data.spend} label="Recorded judge spend" />
            {totals.data.experimentsWithoutUsageRecord > 0 && (
              <p className="mt-1 text-12 text-rp-ink-subtle">
                {totals.data.experimentsWithoutUsageRecord} {totals.data.experimentsWithoutUsageRecord === 1 ? "experiment has" : "experiments have"} no usage record (no model judges, or frozen before usage was recorded); their judge cost is unavailable, not zero.
              </p>
            )}
          </>}
      </div>
    </section>
  );
}

function agentCalls(row: OverviewAgentRow): number {
  return row.costKnownCalls + row.costUnknownCalls;
}

function AgentsPanel({ context }: { context: CostContext }) {
  const overview = useQuery({
    queryKey: ["costs", "overview", context.window, context.to],
    queryFn: ({ signal }) => getOverview(context.window, signal),
    placeholderData: keepPreviousData,
  });
  const rows = (overview.data?.byAgent ?? []).filter(row => agentCalls(row) > 0)
    .sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || agentCalls(b) - agentCalls(a));
  const total = rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
  return (
    <CostPanel id="cost-by-agent" label="Cost by agent" title="By agent" meta={<span title={SHARED_RULE}>Reported, else list price</span>}
      footer={context.source !== "list" ? "Agent totals always use reported cost, else list prices, whatever the estimate source above." : undefined}>
      {overview.isError ? <p role="alert" className="py-4 text-13 text-rp-danger">Spend by agent did not load: {(overview.error as Error).message}</p>
        : !overview.data ? <p className="py-4 text-13 text-rp-ink-subtle">Loading agents…</p>
        : (
          <BarList<OverviewAgentRow>
            caption={`Model calls, tokens and cost by agent ${COST_WINDOW_COPY[context.window].phrase}`}
            rows={rows}
            rowKey={row => row.agent ?? "\u0000unnamed"}
            nameHeader="Agent"
            name={row => row.agent ?? <span className="text-rp-ink-subtle">Unnamed agent</span>}
            nameTitle={row => row.agent ?? "Runs that did not name an agent"}
            href={row => row.agent ? runsLink({ agent: row.agent, window: context.window, sort: "cost" }) : undefined}
            barPlacement="under"
            bar={{ header: "Cost", value: row => row.costUsd ?? 0 }}
            columns={[
              { id: "runs", header: "Runs", cell: row => row.runs.toLocaleString("en-US") },
              { id: "calls", header: "Calls", cell: row => agentCalls(row).toLocaleString("en-US") },
              { id: "tokens", header: "Tokens in / out", className: "max-sm:hidden", cell: row => `${row.inputTokens === null ? "?" : compact(row.inputTokens)} / ${row.outputTokens === null ? "?" : compact(row.outputTokens)}${row.tokenUnknownCalls ? "+" : ""}` },
              { id: "cost", header: "Cost", headerTitle: SHARED_RULE, cell: row => costCellText(row.costUsd, row.costUnknownCalls, agentCalls(row)) },
              { id: "share", header: "Share", cell: row => formatShare(row.costUsd !== null && total > 0 ? row.costUsd / total : null) },
            ]}
            emptyLabel={`No model calls ${COST_WINDOW_COPY[context.window].phrase}.`}
          />
        )}
    </CostPanel>
  );
}

function runCost(row: RunListRow) {
  return row.est_cost_usd ?? row.known_cost_usd;
}

function TopRunsPanel({ context }: { context: CostContext }) {
  const runs = useQuery({
    queryKey: ["costs", "top-runs", context.window, context.to],
    queryFn: ({ signal }) => listRunsPage({ sort: "cost", limit: String(TOP_RUNS * 3), since: String(context.from) }, signal),
    placeholderData: keepPreviousData,
  });
  const rows = (runs.data?.runs ?? []).filter(row => row.llm_calls > 0 && runCost(row) !== null)
    .sort((a, b) => (runCost(b) ?? 0) - (runCost(a) ?? 0)).slice(0, TOP_RUNS);
  const shortIds = useShortRunIds(rows);
  const all = runsLink({ window: context.window, sort: "cost" });
  return (
    <div className="xl:col-span-2">
      <CostPanel id="cost-top-runs" label="Most expensive runs" title="Most expensive runs"
        meta={<Link to={all} className="rounded-control text-rp-blue underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--rp-focus)]">All runs by cost →</Link>}
        footer={<span title={SHARED_RULE}>Runs that started {COST_WINDOW_COPY[context.window].phrase}. {SHARED_RULE}</span>}>
        {runs.isError ? <p role="alert" className="py-4 text-13 text-rp-danger">Runs did not load: {(runs.error as Error).message}</p>
          : !runs.data ? <p className="py-4 text-13 text-rp-ink-subtle">Loading runs…</p>
          : (
            <BarList<RunListRow>
              caption={`The most expensive runs ${COST_WINDOW_COPY[context.window].phrase}`}
              rows={rows}
              rowKey={row => row.id}
              nameHeader="Run"
              name={row => <span className="flex min-w-0 items-baseline gap-2"><span className="truncate">{runDisplayName(row)}</span><span className="shrink-0 font-mono text-11 text-rp-ink-subtle">{shortIds.get(row.id) ?? row.id.slice(0, 8)}</span></span>}
              nameTitle={row => runDisplayName(row)}
              href={row => runPath(row.id)}
              barPlacement="under"
              bar={{ header: "Cost", value: row => runCost(row) ?? 0 }}
              columns={[
                { id: "agent", header: "Agent", className: "max-lg:hidden text-left font-sans", cell: row => <span className="block max-w-[180px] truncate text-left" title={row.agent ?? undefined}>{row.agent ?? <span className="text-rp-ink-subtle">—</span>}</span> },
                { id: "model", header: "Model", className: "max-md:hidden text-left", cell: row => { const cell = modelCell(row); return <span className="block max-w-[180px] truncate text-left" title={cell.title}>{cell.text}</span>; } },
                { id: "calls", header: "Calls", cell: row => row.llm_calls.toLocaleString("en-US") },
                { id: "tokens", header: "Tokens in / out", className: "max-sm:hidden", cell: row => `${row.known_input_tokens === null ? "?" : compact(row.known_input_tokens)} / ${row.known_output_tokens === null ? "?" : compact(row.known_output_tokens)}${row.token_unknown_calls ? "+" : ""}` },
                { id: "cost", header: "Cost", headerTitle: SHARED_RULE, cell: row => costCellText(runCost(row), row.cost_unknown_calls, row.llm_calls) },
                { id: "started", header: "Started", className: "max-sm:hidden", cell: row => <span title={absoluteTime(row.started_at)}>{ago(row.started_at)}</span> },
              ]}
              emptyLabel={`No priced runs ${COST_WINDOW_COPY[context.window].phrase}.`}
            />
          )}
      </CostPanel>
    </div>
  );
}

export function CostAnalyticsPage() {
  return (
    <CostAnalyticsWorkspace
      scopeKey={["local"]}
      title="Local runs"
      load={getLocalPricingAnalytics}
      modelHref={(model, window) => runsLink({ model, window, sort: "cost" })}
      sections={context => <><AgentsPanel context={context} /><TopRunsPanel context={context} /></>}
      footer={<EvaluationJudgeSpend />}
    />
  );
}
