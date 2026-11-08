import type { JudgeSpend, JudgeUsage } from "../../../../src/evaluations/protocol";

/** Six decimals keep a single judge call reconcilable against a provider invoice line. */
export const judgeUsd = (value: number): string => `$${value.toFixed(6)}`;
const tokens = (value: number | null): string => value === null ? "Unavailable" : value.toLocaleString();

export function JudgeUsageLine({ usage }: { usage: JudgeUsage | undefined }) {
  if (!usage) return <p data-testid="judge-usage" className="text-[color:var(--rp-ink-soft)]">Judge cost: Unavailable (no usage was recorded for this judgment)</p>;
  return <div data-testid="judge-usage" className="space-y-1">
    <p>Judge cost: {usage.costUsd === null ? <span className="text-[color:var(--rp-ink-soft)]">Unavailable ({usage.costUnavailableReason})</span> : <span className="rp-num font-medium">{judgeUsd(usage.costUsd)}</span>}</p>
    <p className="text-[color:var(--rp-ink-soft)]">{usage.provider} · {usage.responseModel ?? usage.model} · input {tokens(usage.inputTokens)} · output {tokens(usage.outputTokens)} · cache read {tokens(usage.cacheReadTokens)} · cache write {tokens(usage.cacheWriteTokens)} · reasoning {tokens(usage.reasoningTokens)}{usage.rateRevision ? ` · rate ${usage.rateRevision}` : ""}</p>
  </div>;
}

export function JudgeSpendSummary({ spend, label = "Model judge spend" }: { spend: JudgeSpend | undefined | null; label?: string }) {
  if (!spend) return <p data-testid="judge-spend" className="text-xs text-[color:var(--rp-ink-soft)]">{label}: no recorded model judge calls.</p>;
  return <p data-testid="judge-spend" className="text-xs">
    {label}: {spend.costUsd === null ? "Unavailable" : judgeUsd(spend.costUsd)} across {spend.calls} {spend.calls === 1 ? "call" : "calls"}
    {spend.costUnavailableCalls > 0 ? ` (${spend.costUnavailableCalls} without a reported or priced cost, not included)` : ""}
    {" · "}input {tokens(spend.inputTokens)} · output {tokens(spend.outputTokens)} · cache read {tokens(spend.cacheReadTokens)} · cache write {tokens(spend.cacheWriteTokens)} · reasoning {tokens(spend.reasoningTokens)} tokens.
  </p>;
}
