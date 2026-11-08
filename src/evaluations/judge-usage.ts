import { validTokenCount } from "../pricing/usage";
import { comparisonTarget } from "../prompts/comparison-protocol";
import { providerResponseUsage } from "../prompts/providers";
import { estimateComparisonUsage } from "../prompts/spend-ledger";
import type { CaseResult, JudgeSpend, JudgeUsage } from "./protocol";

const TOKEN_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const;
const USAGE_KEYS = ["provider", "model", "responseModel", ...TOKEN_FIELDS, "costUsd", "rateRevision", "costUnavailableReason"].sort().join();
const token = (value: unknown): number | null => validTokenCount(value) ? value : null;
const label = (value: unknown, max: number): string | null => typeof value === "string" && value.length > 0 && value.length <= max && /^[\x20-\x7e]+$/.test(value) ? value : null;

/** A request that may have reached the provider but returned no readable usage. */
export function unavailableJudgeUsage(provider: JudgeUsage["provider"], model: string, reason: string): JudgeUsage {
  return { provider, model, responseModel: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
    costUsd: null, rateRevision: null, costUnavailableReason: reason };
}

/** Prices the provider-reported usage with the same frozen rates as prompt comparisons; unpriced models keep their tokens. */
export function measureJudgeUsage(provider: JudgeUsage["provider"], model: string, envelope: unknown): JudgeUsage {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || (envelope as Record<string, unknown>).usage === undefined) {
    return unavailableJudgeUsage(provider, model, "Provider reported no usage");
  }
  let source;
  try { source = providerResponseUsage(provider, envelope as Record<string, unknown>); }
  catch { return unavailableJudgeUsage(provider, model, "Provider usage was malformed"); }
  const usage: JudgeUsage = { provider, model, responseModel: label(source.model, 128),
    inputTokens: token(source.inputTokens), outputTokens: token(source.outputTokens), cacheReadTokens: token(source.cacheReadTokens),
    cacheWriteTokens: token(source.cacheWriteTokens), reasoningTokens: token(source.reasoningTokens),
    costUsd: null, rateRevision: null, costUnavailableReason: null };
  if (usage.inputTokens === null || usage.outputTokens === null) return { ...usage, costUnavailableReason: "Provider usage omitted input or output tokens" };
  let target;
  try { target = comparisonTarget({ provider, model }); }
  catch { return { ...usage, costUnavailableReason: "No frozen rate for this judge model" }; }
  const { estimate } = estimateComparisonUsage(target, source);
  if (estimate.coverage !== "complete" || estimate.totalUsd === null || !Number.isFinite(estimate.totalUsd)) {
    return { ...usage, rateRevision: estimate.rateRevision?.revision ?? null, costUnavailableReason: estimate.reasons[0] ?? "Cost could not be estimated" };
  }
  return { ...usage, costUsd: estimate.totalUsd, rateRevision: estimate.rateRevision?.revision ?? null };
}

/** Admits only the exact usage shape; anything else is dropped rather than repaired. */
export function boundJudgeUsage(value: unknown): JudgeUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== USAGE_KEYS) return undefined;
  const usage = value as Record<string, unknown>;
  if (usage.provider !== "openai" && usage.provider !== "anthropic") return undefined;
  const model = label(usage.model, 128);
  if (!model || (usage.responseModel !== null && !label(usage.responseModel, 128))) return undefined;
  if (TOKEN_FIELDS.some(field => usage[field] !== null && !validTokenCount(usage[field]))) return undefined;
  if (usage.costUsd !== null && (typeof usage.costUsd !== "number" || !Number.isFinite(usage.costUsd) || usage.costUsd < 0)) return undefined;
  if (usage.rateRevision !== null && !label(usage.rateRevision, 200)) return undefined;
  if (usage.costUnavailableReason !== null && !label(usage.costUnavailableReason, 200)) return undefined;
  if ((usage.costUsd === null) === (usage.costUnavailableReason === null)) return undefined;
  return { provider: usage.provider, model, responseModel: usage.responseModel as string | null,
    inputTokens: usage.inputTokens as number | null, outputTokens: usage.outputTokens as number | null, cacheReadTokens: usage.cacheReadTokens as number | null,
    cacheWriteTokens: usage.cacheWriteTokens as number | null, reasoningTokens: usage.reasoningTokens as number | null,
    costUsd: usage.costUsd as number | null, rateRevision: usage.rateRevision as string | null, costUnavailableReason: usage.costUnavailableReason as string | null };
}

/** Sums only known values; a total is null when no call reported that value. Returns undefined when no judge call was made. */
export function summarizeJudgeSpend(results: readonly CaseResult[]): JudgeSpend | undefined {
  const calls = results.flatMap(result => result.checks.map(check => check.usage).filter((usage): usage is JudgeUsage => usage !== undefined));
  if (!calls.length) return undefined;
  const sum = (pick: (usage: JudgeUsage) => number | null): number | null => {
    const known = calls.map(pick).filter((value): value is number => value !== null);
    return known.length ? known.reduce((total, value) => total + value, 0) : null;
  };
  const costKnownCalls = calls.filter(usage => usage.costUsd !== null).length;
  return { calls: calls.length, costKnownCalls, costUnavailableCalls: calls.length - costKnownCalls, costUsd: sum(usage => usage.costUsd),
    inputTokens: sum(usage => usage.inputTokens), outputTokens: sum(usage => usage.outputTokens), cacheReadTokens: sum(usage => usage.cacheReadTokens),
    cacheWriteTokens: sum(usage => usage.cacheWriteTokens), reasoningTokens: sum(usage => usage.reasoningTokens) };
}
