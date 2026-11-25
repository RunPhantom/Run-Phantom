import { describe, expect, test } from "bun:test";
import { aggregateCostAnalytics, parseCostAnalyticsRequest, type AnalyticsSpan } from "../src/pricing/analytics";
import { estimateListPriceCost, LIST_PRICE_REVISIONS, LIST_PRICES, lookupListPrice, PRICE_SOURCES, PRICE_TABLE_AS_OF, PRICE_TABLE_REVISION, resolveModelIdentity } from "../src/pricing/list-prices";
import { parseNominalCatalogue } from "../src/pricing/rates";
import { spanCost } from "../src/pricing/span-cost";
import { buildCostAnalyticsReport } from "../src/team/pricing";

const priced = (model: string, provider: string | null, input: number, output: number) => {
  const estimate = estimateListPriceCost({ model, provider, inputTokens: input, outputTokens: output });
  if (estimate.kind !== "estimated") throw new Error(`${model} was not priced: ${estimate.reason}`);
  return estimate;
};

describe("bundled list price table", () => {
  test("is dated, sourced from each provider's pricing page and freezes as valid rate revisions", () => {
    expect(PRICE_TABLE_AS_OF).toBe("2026-11-25");
    expect(LIST_PRICE_REVISIONS).toHaveLength(LIST_PRICES.length);
    for (const revision of LIST_PRICE_REVISIONS) {
      expect(revision.revision).toBe(PRICE_TABLE_REVISION);
      expect(revision.source.observedAt).toBe("2026-11-25T00:00:00.000Z");
      expect(Object.values(PRICE_SOURCES).map(source => source.url)).toContain(revision.source.reference!);
      expect(revision.source.name).toContain("as of 2026-11-25");
    }
    const ids = LIST_PRICES.flatMap(entry => [entry.model, ...(entry.aliases ?? [])]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("covers the models the launch runs call, with their listed prices", () => {
    expect(priced("gpt-5-nano", "openai", 1_000_000, 1_000_000).totalUsd).toBeCloseTo(0.05 + 0.4, 12);
    expect(priced("gpt-5-mini", "openai", 1_000_000, 1_000_000).totalUsd).toBeCloseTo(0.25 + 2, 12);
    expect(priced("gpt-4.1-mini", "openai", 1_000_000, 1_000_000).totalUsd).toBeCloseTo(0.4 + 1.6, 12);
    expect(priced("gpt-4o-mini", "openai", 1_000_000, 1_000_000).totalUsd).toBeCloseTo(0.15 + 0.6, 12);
    expect(priced("claude-haiku-4-5-20251001", "anthropic", 1_000_000, 1_000_000).totalUsd).toBeCloseTo(1 + 5, 12);
    expect(priced("claude-sonnet-5-5", "anthropic", 1_000_000, 1_000_000).totalUsd).toBeCloseTo(2 + 10, 12);
    expect(priced("gemini-2.5-flash", "gcp.gemini", 1_000_000, 1_000_000).totalUsd).toBeCloseTo(0.3 + 2.5, 12);
    expect(priced("gemini-2.5-flash-lite", null, 1_000_000, 1_000_000).totalUsd).toBeCloseTo(0.1 + 0.4, 12);
    expect(priced("gemini-2.5-pro", "google", 1_000_000, 1_000_000).inputUsdPerMillion).toBe(2.5);
  });

  test("dated provider ids match their listed model; unknown snapshots and misses stay unpriced", () => {
    expect(priced("gpt-5-nano-2025-08-07", "openai", 10, 10).model).toBe("gpt-5-nano");
    expect(priced("claude-haiku-4-5-20251001", "anthropic", 10, 10).model).toBe("claude-haiku-4-5-20251001");
    expect(priced("claude-haiku-4-5", "anthropic", 10, 10).model).toBe("claude-haiku-4-5-20251001");
    expect(priced("gpt-5-mini-2099-01-01", "openai", 10, 10).model).toBe("gpt-5-mini");
    expect(priced("gpt-4.1-mini-latest", "openai", 10, 10).model).toBe("gpt-4.1-mini");
    expect(lookupListPrice("gpt-4o-2024-05-13")).toBeNull();
    expect(lookupListPrice("gpt-5-nano-preview")).toBeNull();
    expect(lookupListPrice("claude-haiku-4-5-2025")).toBeNull();
    expect(lookupListPrice("unknown-model-20250101")).toBeNull();
  });

  test("suffix stripping refuses ambiguous matches", () => {
    const index = new Map([["shared", ["a", "b"]], ["single", ["c"]]]);
    const lookup = (id: string) => index.get(id) ?? [];
    expect(resolveModelIdentity("shared-2025-01-01", lookup)).toBeNull();
    expect(resolveModelIdentity("shared", lookup)).toBeNull();
    expect(resolveModelIdentity("single-20250101", lookup)).toBe("c");
  });

  test("calls through another vendor, or after an announced price change, are unpriced", () => {
    expect(lookupListPrice("claude-haiku-4-5", { provider: "aws.bedrock" })).toBeNull();
    expect(lookupListPrice("gpt-5-nano", { provider: "azure.ai.openai" })).toBeNull();
    expect(lookupListPrice("gpt-5-nano", { provider: "openai.chat" })).not.toBeNull();
    expect(lookupListPrice("gemini-2.5-pro", { at: Date.parse("2026-11-30T23:59:59Z") })).not.toBeNull();
    expect(lookupListPrice("gemini-2.5-pro", { at: Date.parse("2026-12-01T00:00:00Z") })).toBeNull();
  });

  test("prompt-length bands count Anthropic cache tokens and OpenAI long context", () => {
    expect(estimateListPriceCost({ model: "claude-haiku-5-5", inputTokens: 100_000, outputTokens: 0 })).toMatchObject({ inputUsdPerMillion: 0.1 });
    expect(estimateListPriceCost({ model: "claude-haiku-5-5", inputTokens: 90_000, cacheReadTokens: 20_000, outputTokens: 1_000 })).toMatchObject({ inputUsdPerMillion: 0.5, outputUsdPerMillion: 2.5 });
    expect(estimateListPriceCost({ model: "gpt-5.5", inputTokens: 272_001, cacheReadTokens: 0, outputTokens: 1 })).toMatchObject({ inputUsdPerMillion: 10, outputUsdPerMillion: 45 });
  });
});

describe("span cost: reported always wins, estimates fill the rest", () => {
  const span = { model: "gpt-5-nano-2025-08-07", provider: "openai", input_tokens: 1_000, output_tokens: 500, start_time_ms: Date.parse("2026-11-25T10:00:00Z") };
  test("a reported cost is used as is", () => {
    expect(spanCost({ ...span, attributes: JSON.stringify({ "gen_ai.usage.cost_usd": 0.5 }) })).toEqual({ source: "reported", usd: 0.5 });
  });
  test("without a reported cost a dated real model id gets a list-price estimate", () => {
    const cost = spanCost({ ...span, attributes: null });
    expect(cost.source).toBe("list-price");
    expect(cost.usd).toBeCloseTo((1_000 * 0.05 + 500 * 0.4) / 1e6, 15);
  });
  test("falls back to the requested model when the response model has no price", () => {
    const cost = spanCost({ ...span, model: "gpt-5-nano-custom-build", attributes: JSON.stringify({ "gen_ai.request.model": "gpt-5-nano" }) });
    expect(cost.source).toBe("list-price");
  });
  test("an invalid reported cost is never replaced by an estimate", () => {
    expect(spanCost({ ...span, attributes: JSON.stringify({ "gen_ai.usage.cost_usd": -1 }) })).toMatchObject({ source: null, reason: "reported_cost_invalid" });
  });
});

describe("cost analytics list-price mode", () => {
  const generation = (overrides: Partial<AnalyticsSpan>): AnalyticsSpan => ({ projectId: "local", runId: "run", id: "g", parentSpanId: null, kind: "LLM_GENERATION", startedAt: 1_000,
    model: "gpt-5-nano-2025-08-07", provider: "openai", inputTokens: 1_000, outputTokens: 500, attributes: null, ...overrides });
  const request = { from: 0, to: 86_400_000, bucket: "hour" as const, estimateMode: "list-prices" as const, rates: [] };

  test("estimates real dated ids by default and reports the bundled rates it used", () => {
    const result = aggregateCostAnalytics([
      generation({ id: "a" }),
      generation({ id: "b", model: "claude-haiku-4-5-20251001", provider: "anthropic" }),
      generation({ id: "c", model: "in-house-model", provider: "local" }),
    ], request);
    expect(result.estimatedUsd).toMatchObject({ eligibleCount: 3, knownCount: 2, unavailableCount: 1 });
    expect(result.estimatedUsd.knownSum).toBeCloseTo((1_000 * 0.05 + 500 * 0.4 + 1_000 * 1 + 500 * 5) / 1e6, 15);
    expect(result.tokens.input.completeTotal).toBe(3_000);
    expect(result.rateRevisions.map(rate => rate.model)).toEqual(["claude-haiku-4-5-20251001", "gpt-5-nano"]);
    expect(buildCostAnalyticsReport({ kind: "local", projectId: "local" }, [generation({})], request, 1).rateAuthority).toBe("bundled-list-prices");
  });

  test("list-price requests cannot smuggle declared rates", () => {
    expect(() => parseCostAnalyticsRequest({ ...request, rates: [LIST_PRICE_REVISIONS[0]] })).toThrow();
  });

  test("the nominal catalogue mode also matches dated ids", () => {
    const catalogue = parseNominalCatalogue({ data: [{ id: "openai/gpt-5-nano", pricing: { prompt: "0.00000005", completion: "0.0000004" } }] }, "rev", "2026-11-25T00:00:00.000Z");
    const result = aggregateCostAnalytics([generation({})], { ...request, estimateMode: "nominal-input-output", rates: catalogue.rates });
    expect(result.estimatedUsd.knownSum).toBeCloseTo((1_000 * 0.05 + 500 * 0.4) / 1e6, 15);
  });
});
