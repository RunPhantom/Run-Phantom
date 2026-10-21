import { PRICING_VERSION, TOKEN_CATEGORIES, type CategoryCost, type CategoryRate, type CostEstimate, type DetailCategory, type FrozenRateRevision, type NormalizedUsage, type TokenCategory } from "./protocol";
import { freezeRateRevision, rateMatchesUsage } from "./rates";
import { validTokenCount } from "./usage";

const INPUT_DETAILS: readonly DetailCategory[] = ["cache_read", "cache_write", "cache_write_5m", "cache_write_1h", "audio_input"];
const OUTPUT_DETAILS: readonly DetailCategory[] = ["reasoning", "audio_output"];

function unavailable(revision: FrozenRateRevision | null, reasons: readonly string[]): CostEstimate {
  return { version: PRICING_VERSION, kind: "estimated", currency: "USD", rateRevision: revision, contextBandMaximum: null, categories: [], totalUsd: null, coverage: "unavailable", reasons };
}

function cost(count: number, rate: number): number | null {
  const amount = (count / 1_000_000) * rate;
  return Number.isFinite(amount) && !(count > 0 && rate > 0 && amount === 0) ? amount : null;
}

export function calculateCost(usage: NormalizedUsage, rateRevision: FrozenRateRevision): CostEstimate {
  let revision: FrozenRateRevision;
  try { revision = freezeRateRevision(rateRevision); } catch { return unavailable(null, ["invalid_rate_revision"]); }
  if (usage.version !== PRICING_VERSION || !rateMatchesUsage(usage, revision)) return unavailable(revision, ["rate_identity_mismatch"]);
  if (usage.issues.length) return unavailable(revision, usage.issues);
  const context = usage.contextTokens;
  if (revision.bands.length > 1 && (context.state !== "known" || !validTokenCount(context.count))) return unavailable(revision, ["context_usage_unavailable"]);
  if (context.state !== "missing" && (context.state !== "known" || !validTokenCount(context.count))) return unavailable(revision, ["invalid_context_usage"]);
  if (context.count !== null && usage.categories.input.state === "known" && validTokenCount(usage.categories.input.count)) {
    let minimumContext = usage.categories.input.count;
    const additional = INPUT_DETAILS.filter(category => usage.inclusion[category] === "additional" && (usage.categories[category].count ?? 0) > 0);
    if (additional.length <= 1 || usage.inputDetailsDisjoint === true) {
      for (const category of additional) minimumContext += usage.categories[category].count!;
      if (!Number.isSafeInteger(minimumContext) || context.count < minimumContext) return unavailable(revision, ["context_usage_understates_input"]);
    }
  }
  const band = revision.bands.find(item => item.maxContextTokens === null || (context.count !== null && context.count <= item.maxContextTokens))!;
  const reasons = new Set<string>();
  const billed: Partial<Record<TokenCategory, number | null>> = {};
  const categoryReasons: Partial<Record<TokenCategory, string>> = {};
  const fail = (category: TokenCategory, reason: string): void => { billed[category] = null; categoryReasons[category] = reason; reasons.add(`${category}:${reason}`); };

  for (const category of TOKEN_CATEGORIES) {
    const measure = usage.categories[category];
    const rate = band.categories[category];
    if (measure.state === "invalid" || measure.state === "conflicting" || (measure.state === "known" && !validTokenCount(measure.count))) fail(category, "invalid_or_conflicting_usage");
    else if (rate.kind === "unavailable") fail(category, "rate_unavailable");
    else if (rate.kind === "not_applicable") {
      if (measure.count !== null && measure.count !== 0) fail(category, "unexpected_category_usage");
      else billed[category] = 0;
    } else if (rate.kind === "included") {
      if (measure.count !== null && measure.count > 0 && usage.inclusion[category as DetailCategory] !== "included") fail(category, "included_category_relationship_unavailable");
      else billed[category] = 0;
    } else if (measure.state !== "known" || measure.count === null) fail(category, "usage_unavailable");
    else billed[category] = measure.count;
  }

  const genericWrites = usage.categories.cache_write.count;
  if (genericWrites !== null && genericWrites > 0 && ["cache_write_5m", "cache_write_1h"].some(category => (usage.categories[category as TokenCategory].count ?? 0) > 0)) {
    for (const category of ["input", "cache_write", "cache_write_5m", "cache_write_1h"] as const) fail(category, "overlapping_cache_write_categories");
  }

  for (const [parent, details, disjoint] of [["input", INPUT_DETAILS, usage.inputDetailsDisjoint], ["output", OUTPUT_DETAILS, usage.outputDetailsDisjoint]] as const) {
    const parentMeasure = usage.categories[parent];
    const parentCount = parentMeasure.state === "known" && validTokenCount(parentMeasure.count) ? parentMeasure.count : null;
    let includedTotal = 0;
    for (const category of details) {
      const measure = usage.categories[category];
      if (usage.inclusion[category] !== "included" || measure.state !== "known" || !validTokenCount(measure.count)) continue;
      if (parentCount !== null && measure.count > parentCount) fail(parent, "included_categories_exceed_total");
      if (disjoint === true) {
        if (!Number.isSafeInteger(includedTotal + measure.count)) fail(parent, "token_sum_overflow");
        else includedTotal += measure.count;
      }
    }
    if (disjoint === true && parentCount !== null && includedTotal > parentCount) fail(parent, "included_categories_exceed_total");

    const separatelyPriced = details.filter(category => band.categories[category].kind === "priced" && (usage.categories[category].count ?? 0) > 0);
    if (separatelyPriced.length > 1 && disjoint !== true) {
      fail(parent, "category_overlap_unavailable");
      for (const category of separatelyPriced) fail(category, "category_overlap_unavailable");
      continue;
    }
    let deduction = 0;
    for (const category of details) {
      const rate = band.categories[category];
      if (rate.kind !== "priced") continue;
      const count = usage.categories[category].count;
      if (count === 0) continue;
      if (count === null || !validTokenCount(count) || usage.inclusion[category] === "unknown") { fail(parent, "category_inclusion_unavailable"); continue; }
      if (usage.inclusion[category] === "included") deduction += count;
      if (!Number.isSafeInteger(deduction)) fail(parent, "token_sum_overflow");
    }
    const amount = billed[parent];
    if (typeof amount === "number") {
      if (deduction > amount) fail(parent, "included_categories_exceed_total");
      else billed[parent] = amount - deduction;
    }
  }

  const categories: CategoryCost[] = TOKEN_CATEGORIES.map(category => {
    const rate: CategoryRate = band.categories[category];
    const count = billed[category] ?? null;
    const amount = count === null ? null : rate.kind === "priced" ? cost(count, rate.usdPerMillionTokens) : 0;
    if (count !== null && amount === null) { categoryReasons[category] = "amount_overflow_or_underflow"; reasons.add(`${category}:amount_overflow_or_underflow`); }
    return { category, observedTokens: usage.categories[category].count, billedTokens: count, rateUsdPerMillionTokens: rate.kind === "priced" ? rate.usdPerMillionTokens : null, costUsd: amount, reason: categoryReasons[category] ?? null };
  });
  let totalUsd: number | null = reasons.size ? null : categories.reduce((total, category) => total + category.costUsd!, 0);
  if (totalUsd !== null && !Number.isFinite(totalUsd)) { totalUsd = null; reasons.add("total_amount_overflow"); }
  return { version: PRICING_VERSION, kind: "estimated", currency: "USD", rateRevision: revision, contextBandMaximum: band.maxContextTokens, categories, totalUsd, coverage: totalUsd === null ? "unavailable" : "complete", reasons: [...reasons] };
}
