import { freezeRateRevision } from "../pricing/rates";
import { normalizeUsage } from "../pricing/usage";
import { calculateCost } from "../pricing/calculator";
import { PRICING_VERSION, type CategoryRate, type FrozenRateRevision } from "../pricing/protocol";
import { COMPARISON_LIMITS, comparisonTarget, ComparisonError, type ComparisonTarget } from "./comparison-protocol";
import { promptInteger, promptText } from "./protocol";

const observedAt = "2026-10-13T00:00:00.000Z";
const quotes = {
  "gpt-5.4": { input: 2.5, output: 15, cache: 0.25, reference: "https://developers.openai.com/api/docs/models/gpt-5.4", alias: "gpt-5.4-2026-03-05" },
  "gpt-4.1": { input: 2, output: 8, cache: 0.5, reference: "https://developers.openai.com/api/docs/models/gpt-4.1", alias: "gpt-4.1-2025-04-14" },
  "claude-opus-4-6": { input: 5, output: 25, cache: 0.5, reference: "https://platform.claude.com/docs/en/about-claude/pricing", alias: null },
  "claude-sonnet-4-6": { input: 3, output: 15, cache: 0.3, reference: "https://platform.claude.com/docs/en/about-claude/pricing", alias: null },
} as const;
const priced = (usdPerMillionTokens: number): CategoryRate => ({ kind: "priced", usdPerMillionTokens });
/** Public standard text quotes are estimates; credentials and provider invoices are separate. */
export function comparisonRate(targetValue: ComparisonTarget): FrozenRateRevision {
  const target = comparisonTarget(targetValue), quote = quotes[target.model as keyof typeof quotes];
  return freezeRateRevision({ version: PRICING_VERSION, ...target, tier: "standard", revision: `comparison-standard-text-2026-10-13:${target.model}`, currency: "USD", unit: "usd_per_million_tokens",
    source: { kind: "manual", name: "Frozen official standard text quote", reference: quote.reference, observedAt },
    aliases: quote.alias ? [{ provider: target.provider, model: quote.alias, tier: "standard" }] : [],
    bands: [{ maxContextTokens: target.model === "gpt-5.4" ? 272000 : null, categories: { input: priced(quote.input), output: priced(quote.output), cache_read: priced(quote.cache),
      cache_write: { kind: "not_applicable" }, cache_write_5m: { kind: "not_applicable" }, cache_write_1h: { kind: "not_applicable" },
      reasoning: { kind: "included" }, audio_input: { kind: "not_applicable" }, audio_output: { kind: "not_applicable" } } }, ...(target.model === "gpt-5.4" ? [{ maxContextTokens: null, categories: { input: { kind: "unavailable" as const }, output: { kind: "unavailable" as const }, cache_read: { kind: "unavailable" as const }, cache_write: { kind: "not_applicable" as const }, cache_write_5m: { kind: "not_applicable" as const }, cache_write_1h: { kind: "not_applicable" as const }, reasoning: { kind: "included" as const }, audio_input: { kind: "not_applicable" as const }, audio_output: { kind: "not_applicable" as const } } }] : [])] });
}
export interface ComparisonUsage {
  readonly model?: unknown; readonly inputTokens?: unknown; readonly outputTokens?: unknown; readonly cacheReadTokens?: unknown;
  readonly cacheWriteTokens?: unknown; readonly reasoningTokens?: unknown; readonly tier?: unknown; readonly contextTokens?: unknown;
}
export function reserveComparisonAttempt(compiledValue: string, target: ComparisonTarget, outputValue: number): { microusd: number; inputTokenCeiling: number; rate: FrozenRateRevision } {
  const compiled = promptText(compiledValue, COMPARISON_LIMITS.inputBytes), output = promptInteger(outputValue, COMPARISON_LIMITS.outputTokens), rate = comparisonRate(target);
  const inputTokenCeiling = Buffer.byteLength(compiled) + 1024, categories = rate.bands[0].categories;
  if (categories.input.kind !== "priced" || categories.output.kind !== "priced") throw new ComparisonError("budget_refused");
  // One text-only user message, no tools/system/cache creation. Byte count deliberately over-reserves tokenizer input.
  const microusd = Math.ceil(inputTokenCeiling * categories.input.usdPerMillionTokens + output * categories.output.usdPerMillionTokens);
  if (!Number.isSafeInteger(microusd) || microusd < 1 || microusd > COMPARISON_LIMITS.providerBudgetMicrousd) throw new ComparisonError("budget_refused");
  return { microusd, inputTokenCeiling, rate };
}
export function estimateComparisonUsage(target: ComparisonTarget, source: ComparisonUsage, rate: FrozenRateRevision = comparisonRate(target)) {
  const attributes: Record<string, unknown> = { "gen_ai.provider.name": target.provider, "runphantom.usage.tier": source.tier ?? "standard",
    "gen_ai.response.model": source.model, "runphantom.usage.input_includes_cache": target.provider === "openai",
    "runphantom.usage.output_includes_reasoning": true, "runphantom.usage.input_categories_disjoint": true, "runphantom.usage.output_categories_disjoint": true };
  for (const [sourceKey, attribute] of [["inputTokens", "gen_ai.usage.input_tokens"], ["outputTokens", "gen_ai.usage.output_tokens"],
    ["cacheReadTokens", "runphantom.usage.cache_read_tokens"], ["cacheWriteTokens", "runphantom.usage.cache_write_tokens"], ["reasoningTokens", "runphantom.usage.reasoning_tokens"]] as const) {
    if (source[sourceKey] !== undefined) attributes[attribute] = source[sourceKey];
  }
  if (source.contextTokens !== undefined) attributes["runphantom.usage.context_tokens"] = source.contextTokens;
  const usage = normalizeUsage(attributes), estimate = calculateCost(usage, rate);
  return { usage, estimate, invoiceUsd: null };
}

/** Environment configuration is a ceiling, never a statement of actual remaining provider balance. */
export function comparisonBudgetMicrousd(value: string | undefined): number {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value)) return 0;
  const amount = Number(value) * 1000000;
  return Number.isSafeInteger(amount) && amount >= 0 && amount <= COMPARISON_LIMITS.providerBudgetMicrousd ? amount : 0;
}
