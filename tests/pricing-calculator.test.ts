import { describe, expect, test } from "bun:test";
import { calculateCost } from "../src/pricing/calculator";
import { freezeRateRevision } from "../src/pricing/rates";
import type { CategoryRate, TokenCategory } from "../src/pricing/protocol";
import { rateFixture, usageFixture } from "./fixtures/pricing";

const priced = (usdPerMillionTokens: number): CategoryRate => ({ kind: "priced", usdPerMillionTokens });

describe("reproducible categorized cost", () => {
  test.each([ [200, false], [6200, true] ])("same cache request with %i captured input yields $0.01035", (input, includesCache) => {
    const estimate = calculateCost(usageFixture({
      "gen_ai.usage.input_tokens": input, "runphantom.usage.cache_read_tokens": 5000, "runphantom.usage.cache_write_tokens": 1000,
      "runphantom.usage.input_includes_cache": includesCache, "runphantom.usage.input_categories_disjoint": true,
    }), rateFixture({ cache_read: priced(0.3), cache_write: priced(3.75) }));
    expect(estimate.totalUsd).toBeCloseTo(0.01035, 12);
    expect(estimate.coverage).toBe("complete");
    expect(estimate.reasons).toEqual([]);
    expect(estimate.categories.find(item => item.category === "input")!.billedTokens).toBe(200);
    expect(estimate.rateRevision!.revision).toBe("fixture-rate-1");
  });

  test("retains partial known amounts when a required category is missing", () => {
    const estimate = calculateCost(usageFixture(), rateFixture({ cache_read: priced(0.3) }));
    expect(estimate.totalUsd).toBeNull();
    expect(estimate.coverage).toBe("unavailable");
    expect(estimate.reasons).toContain("cache_read:usage_unavailable");
    expect(estimate.categories.find(item => item.category === "output")!.costUsd).toBeCloseTo(0.0045, 12);
  });

  test("zero price is genuinely free, while a missing rate stays unavailable", () => {
    const usage = usageFixture({ "gen_ai.usage.input_tokens": 100, "runphantom.usage.cache_read_tokens": 100, "runphantom.usage.input_includes_cache": true });
    const free = calculateCost(usage, rateFixture({ cache_read: priced(0), output: priced(0) }));
    expect(free.totalUsd).toBe(0);
    expect(free.coverage).toBe("complete");
    expect(free.categories.find(item => item.category === "cache_read")!.rateUsdPerMillionTokens).toBe(0);
    const missing = calculateCost(usage, rateFixture({ cache_read: { kind: "unavailable" }, output: priced(0) }));
    expect(missing.totalUsd).toBeNull();
    expect(missing.reasons).toContain("cache_read:rate_unavailable");
  });

  test("fully measured empty usage costs zero but absent usage never does", () => {
    expect(calculateCost(usageFixture({ "gen_ai.usage.input_tokens": 0, "gen_ai.usage.output_tokens": 0 }), rateFixture()).totalUsd).toBe(0);
    expect(calculateCost(usageFixture({ "gen_ai.usage.input_tokens": undefined }), rateFixture()).totalUsd).toBeNull();
  });

  test.each(["runphantom.usage.cache_read_tokens", "runphantom.usage.audio_input_tokens", "runphantom.usage.reasoning_tokens"])("requires declared inclusion for %s", key => {
    const category = key.includes("cache") ? "cache_read" : key.includes("audio") ? "audio_input" : "reasoning";
    const estimate = calculateCost(usageFixture({ [key]: 10 }), rateFixture({ [category]: priced(1) }));
    expect(estimate.totalUsd).toBeNull();
    expect(estimate.reasons.some(reason => reason.endsWith("category_inclusion_unavailable"))).toBe(true);
  });

  test("never deducts an included detail larger than its measured total", () => {
    const estimate = calculateCost(usageFixture({ "runphantom.usage.cache_read_tokens": 201, "runphantom.usage.input_includes_cache": true }), rateFixture({ cache_read: priced(1) }));
    expect(estimate.totalUsd).toBeNull();
    expect(estimate.reasons).toContain("input:included_categories_exceed_total");
  });

  test.each([ ["cache_write_5m", 3.75], ["cache_write_1h", 6] ] as const)("uses the explicit %s rate without a TTL guess", (category, rate) => {
    const estimate = calculateCost(usageFixture({
      "gen_ai.usage.input_tokens": 1200, [`runphantom.usage.${category}_tokens`]: 1000, "runphantom.usage.input_includes_cache": true,
    }), rateFixture({ [category]: priced(rate) }));
    expect(estimate.totalUsd).toBeCloseTo(0.0051 + rate / 1000, 12);
    expect(estimate.categories.find(item => item.category === category)!.billedTokens).toBe(1000);
  });

  test("mixed cache durations remain separate when their counts are declared disjoint", () => {
    const estimate = calculateCost(usageFixture({
      "gen_ai.usage.input_tokens": 2200, "runphantom.usage.cache_write_5m_tokens": 1000, "runphantom.usage.cache_write_1h_tokens": 1000,
      "runphantom.usage.input_includes_cache": true, "runphantom.usage.input_categories_disjoint": true,
    }), rateFixture({ cache_write_5m: priced(3.75), cache_write_1h: priced(6) }));
    expect(estimate.totalUsd).toBeCloseTo(0.01485, 12);
  });

  test("generic and duration-specific writes cannot be charged twice", () => {
    const estimate = calculateCost(usageFixture({
      "runphantom.usage.cache_write_tokens": 100, "runphantom.usage.cache_write_5m_tokens": 100,
      "runphantom.usage.input_includes_cache": false, "runphantom.usage.input_categories_disjoint": true,
    }), rateFixture({ cache_write: priced(3.75), cache_write_5m: priced(3.75) }));
    expect(estimate.totalUsd).toBeNull();
    expect(estimate.reasons).toContain("input:overlapping_cache_write_categories");
  });

  test("audio/reasoning overlap is unavailable until disjointness is captured", () => {
    const attributes = {
      "gen_ai.usage.output_tokens": 100, "runphantom.usage.reasoning_tokens": 20, "runphantom.usage.audio_output_tokens": 30,
      "runphantom.usage.output_includes_reasoning": true, "runphantom.usage.output_includes_audio": true,
    };
    const rates = rateFixture({ output: priced(10), reasoning: priced(20), audio_output: priced(40) });
    expect(calculateCost(usageFixture(attributes), rates).totalUsd).toBeNull();
    const declared = calculateCost(usageFixture({ ...attributes, "runphantom.usage.output_categories_disjoint": true }), rates);
    expect(declared.totalUsd).toBeCloseTo(0.0027, 12);
    expect(declared.categories.find(item => item.category === "output")!.billedTokens).toBe(50);
  });

  test("reasoning included at output price is not charged a second time", () => {
    const estimate = calculateCost(usageFixture({ "runphantom.usage.reasoning_tokens": 30, "runphantom.usage.output_includes_reasoning": true }), rateFixture({ reasoning: { kind: "included" } }));
    expect(estimate.totalUsd).toBeCloseTo(0.0051, 12);
    expect(estimate.categories.find(item => item.category === "reasoning")!.costUsd).toBe(0);
    expect(estimate.categories.find(item => item.category === "output")!.billedTokens).toBe(300);
  });

  test("an additional detail cannot claim it was billed inside its parent", () => {
    const estimate = calculateCost(usageFixture({ "runphantom.usage.reasoning_tokens": 30, "runphantom.usage.output_includes_reasoning": false }), rateFixture({ reasoning: { kind: "included" } }));
    expect(estimate.totalUsd).toBeNull();
    expect(estimate.reasons).toContain("reasoning:included_category_relationship_unavailable");
  });

  test("audio input is excluded from ordinary input exactly once", () => {
    const estimate = calculateCost(usageFixture({ "gen_ai.usage.input_tokens": 200, "runphantom.usage.audio_input_tokens": 100, "runphantom.usage.input_includes_audio": true }), rateFixture({ audio_input: priced(12) }));
    expect(estimate.totalUsd).toBeCloseTo(0.006, 12);
    expect(estimate.categories.find(item => item.category === "input")!.billedTokens).toBe(100);
  });

  test.each([1000, 1001])("context at %i uses the explicitly selected inclusive band", context => {
    const base = rateFixture();
    const rates = rateFixture({}, { bands: [
      { maxContextTokens: 1000, categories: base.bands[0].categories },
      { maxContextTokens: null, categories: { ...base.bands[0].categories, input: priced(6) } },
    ] });
    const estimate = calculateCost(usageFixture({ "runphantom.usage.context_tokens": context }), rates);
    expect(estimate.totalUsd).toBeCloseTo(context === 1000 ? 0.0051 : 0.0057, 12);
    expect(estimate.contextBandMaximum).toBe(context === 1000 ? 1000 : null);
  });

  test("cached context determines the tier even when uncached input is small", () => {
    const base = rateFixture({ cache_read: priced(0.3) });
    const rates = rateFixture({}, { bands: [
      { maxContextTokens: 1000, categories: base.bands[0].categories },
      { maxContextTokens: null, categories: { ...base.bands[0].categories, input: priced(6) } },
    ] });
    const estimate = calculateCost(usageFixture({
      "runphantom.usage.context_tokens": 1200, "runphantom.usage.cache_read_tokens": 1000, "runphantom.usage.input_includes_cache": false,
    }), rates);
    expect(estimate.totalUsd).toBeCloseTo(0.006, 12);
    expect(estimate.contextBandMaximum).toBeNull();
    expect(calculateCost(usageFixture({ "runphantom.usage.cache_read_tokens": 1000, "runphantom.usage.input_includes_cache": false }), rates).reasons).toContain("context_usage_unavailable");
  });

  test("tier and model mismatch cannot silently use a standard rate", () => {
    for (const attributes of [{ "runphantom.usage.tier": "priority" }, { "runphantom.usage.tier": undefined }, { "gen_ai.response.model": "fixture-model-new" }, { "gen_ai.provider.name": "other" }]) {
      const estimate = calculateCost(usageFixture(attributes), rateFixture());
      expect(estimate.totalUsd).toBeNull();
      expect(estimate.reasons).toEqual(["rate_identity_mismatch"]);
    }
  });

  test.each([-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])("invalid observed count %p cannot produce an estimate", value => {
    const estimate = calculateCost(usageFixture({ "gen_ai.usage.input_tokens": value }), rateFixture());
    expect(estimate.totalUsd).toBeNull();
    expect(estimate.reasons).toContain("input:invalid_or_conflicting_usage");
  });

  test("unexpected detail usage is unavailable under a non-applicable rate policy", () => {
    const estimate = calculateCost(usageFixture({ "runphantom.usage.reasoning_tokens": 10 }), rateFixture());
    expect(estimate.totalUsd).toBeNull();
    expect(estimate.reasons).toContain("reasoning:unexpected_category_usage");
  });

  test("unsafe token subtraction never rounds into a usable estimate", () => {
    const estimate = calculateCost(usageFixture({
      "gen_ai.usage.input_tokens": Number.MAX_SAFE_INTEGER, "runphantom.usage.cache_read_tokens": Number.MAX_SAFE_INTEGER,
      "runphantom.usage.cache_write_tokens": 1, "runphantom.usage.input_includes_cache": true, "runphantom.usage.input_categories_disjoint": true,
    }), rateFixture({ cache_read: priced(1), cache_write: priced(1) }));
    expect(estimate.totalUsd).toBeNull();
    expect(estimate.reasons).toContain("input:token_sum_overflow");
  });

  test.each([Number.MAX_VALUE, Number.MIN_VALUE])("refuses unrepresentable multiplication at rate %p", rate => {
    const count = rate === Number.MAX_VALUE ? Number.MAX_SAFE_INTEGER : 1;
    const estimate = calculateCost(usageFixture({ "gen_ai.usage.input_tokens": count }), rateFixture({ input: priced(rate) }));
    expect(estimate.totalUsd).toBeNull();
    expect(estimate.reasons).toContain("input:amount_overflow_or_underflow");
  });

  test("refuses a nonfinite sum even when individual category costs are finite", () => {
    const estimate = calculateCost(usageFixture({
      "gen_ai.usage.input_tokens": 1_000_000, "gen_ai.usage.output_tokens": 1_000_000,
      "runphantom.usage.cache_read_tokens": 1_000_000, "runphantom.usage.input_includes_cache": false,
    }), rateFixture({ input: priced(Number.MAX_VALUE / 2), output: priced(Number.MAX_VALUE / 2), cache_read: priced(Number.MAX_VALUE / 2) }));
    expect(estimate.categories.every(category => category.costUsd !== null && Number.isFinite(category.costUsd))).toBe(true);
    expect(estimate.totalUsd).toBeNull();
    expect(estimate.reasons).toContain("total_amount_overflow");
  });

  test("an invalid rate DTO yields unavailable rather than a fabricated zero", () => {
    const estimate = calculateCost(usageFixture(), { ...rateFixture(), currency: "EUR" } as unknown as ReturnType<typeof freezeRateRevision>);
    expect(estimate.totalUsd).toBeNull();
    expect(estimate.rateRevision).toBeNull();
    expect(estimate.reasons).toEqual(["invalid_rate_revision"]);
  });

  test("zero observed details do not require a meaningless overlap assertion", () => {
    const overrides: Partial<Record<TokenCategory, CategoryRate>> = { cache_read: priced(1), cache_write: priced(1) };
    const estimate = calculateCost(usageFixture({ "runphantom.usage.cache_read_tokens": 0, "runphantom.usage.cache_write_tokens": 0 }), rateFixture(overrides));
    expect(estimate.totalUsd).toBeCloseTo(0.0051, 12);
    expect(estimate.reasons).toEqual([]);
  });

  test("captured context cannot understate known input plus additional cache", () => {
    const rates = rateFixture({ cache_read: priced(0.3) });
    for (const context of [199, 1199]) {
      const estimate = calculateCost(usageFixture({
        "runphantom.usage.context_tokens": context, "runphantom.usage.cache_read_tokens": 1000, "runphantom.usage.input_includes_cache": false,
      }), rates);
      expect(estimate.totalUsd).toBeNull();
      expect(estimate.reasons).toContain("context_usage_understates_input");
    }
  });
});
