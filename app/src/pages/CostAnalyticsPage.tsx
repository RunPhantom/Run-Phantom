import { useQuery } from "@tanstack/react-query";
import { CostAnalyticsWorkspace } from "../components/CostAnalytics";
import { JudgeSpendSummary } from "../components/evaluations/JudgeCost";
import { getLocalPricingAnalytics } from "../api/pricing";
import { evaluationsApi } from "../api/evaluations";
import { Eyebrow } from "../components/ui/typography";

function EvaluationJudgeSpend() {
  const totals = useQuery({ queryKey: ["evaluations", "judge-spend"], queryFn: ({ signal }) => evaluationsApi.judgeSpend(signal) });
  return <section aria-label="Evaluation judge spend" className="rounded-lg border border-rp-line bg-white p-5 sm:p-6">
    <Eyebrow as="h2">Evaluation judges / All experiments</Eyebrow>
    <p className="mt-2 text-[13px] leading-6 text-rp-ink-muted">Model judge calls are billed to your provider account but are not captured runs, so they are reported here rather than in the totals above.</p>
    <div className="mt-3">{totals.isPending ? <p className="text-xs text-rp-ink-muted">Loading judge spend…</p> : totals.isError ? <p role="alert" className="text-xs text-rp-danger">Judge spend is unavailable.</p>
      : <><JudgeSpendSummary spend={totals.data.spend} label="Recorded judge spend" />{totals.data.experimentsWithoutUsageRecord > 0 && <p className="mt-1 text-xs text-rp-ink-muted">{totals.data.experimentsWithoutUsageRecord} {totals.data.experimentsWithoutUsageRecord === 1 ? "experiment has" : "experiments have"} no usage record (no model judges, or frozen before usage was recorded); their judge cost is unavailable, not zero.</p>}</>}</div>
  </section>;
}

export function CostAnalyticsPage() {
  return <CostAnalyticsWorkspace scopeKey={["local"]} title="Local captured runs" load={getLocalPricingAnalytics} footer={<EvaluationJudgeSpend />} />;
}
