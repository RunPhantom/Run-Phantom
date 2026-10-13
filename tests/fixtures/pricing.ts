import { PRICING_VERSION, TOKEN_CATEGORIES, type CategoryRate, type FrozenRateRevision, type TokenCategory } from "../../src/pricing/protocol";
import { normalizeUsage } from "../../src/pricing/usage";

export function rateFixture(categoryOverrides: Partial<Record<TokenCategory, CategoryRate>> = {}, overrides: Partial<FrozenRateRevision> = {}): FrozenRateRevision {
  const categories = Object.fromEntries(TOKEN_CATEGORIES.map(category => [category, { kind: "not_applicable" }])) as Record<TokenCategory, CategoryRate>;
  return {
    version: PRICING_VERSION, revision: "fixture-rate-1", provider: "fixture-provider", model: "fixture-model", tier: "standard", currency: "USD", unit: "usd_per_million_tokens",
    source: { kind: "manual", name: "Synthetic qualification rates", reference: null, observedAt: "2026-10-12T00:00:00Z" },
    aliases: [], bands: [{ maxContextTokens: null, categories: { ...categories, input: { kind: "priced", usdPerMillionTokens: 3 }, output: { kind: "priced", usdPerMillionTokens: 15 }, ...categoryOverrides } }],
    ...overrides,
  };
}

export function usageFixture(attributes: Record<string, unknown> = {}) {
  return normalizeUsage({
    "gen_ai.provider.name": "fixture-provider", "gen_ai.response.model": "fixture-model", "runphantom.usage.tier": "standard",
    "gen_ai.usage.input_tokens": 200, "gen_ai.usage.output_tokens": 300,
    ...attributes,
  });
}
