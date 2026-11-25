import { describe, expect, test } from "bun:test";
import { aggregateCostAnalytics, parseCostAnalyticsRequest, type AnalyticsSpan } from "../src/pricing/analytics";
import { PLAYGROUND_DEFAULT_MODEL, PLAYGROUND_MODELS } from "../src/playground/protocol";
import { OTEL_PROVIDER_NAME } from "../src/playground/providers";
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
    expect(LIST_PRICE_REVISIONS).toHaveLength(LIST_PRICES.length + LIST_PRICES.reduce((sum, entry) => sum + (entry.changes?.length ?? 0), 0));
    for (const revision of LIST_PRICE_REVISIONS) {
      expect(revision.revision).toMatch(/^runphantom-list-prices\/2026-11-25(?:\/from-\d{4}-\d{2}-\d{2})?$/);
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
    expect(lookupListPrice("gemini-4-carbon", { at: Date.parse("2026-11-30T23:59:59Z") })).not.toBeNull();
    expect(lookupListPrice("gemini-4-carbon", { at: Date.parse("2026-12-01T00:00:00Z") })).toBeNull();
  });

  test("prompt-length bands count Anthropic cache tokens and OpenAI long context", () => {
    expect(estimateListPriceCost({ model: "claude-haiku-5-5", inputTokens: 100_000, outputTokens: 0 })).toMatchObject({ inputUsdPerMillion: 0.1 });
    expect(estimateListPriceCost({ model: "claude-haiku-5-5", inputTokens: 90_000, cacheReadTokens: 20_000, inputIncludesCache: false, outputTokens: 1_000 })).toMatchObject({ inputUsdPerMillion: 0.5, outputUsdPerMillion: 2.5 });
    expect(estimateListPriceCost({ model: "gpt-5.5", inputTokens: 272_001, cacheReadTokens: 0, outputTokens: 1 })).toMatchObject({ inputUsdPerMillion: 10, outputUsdPerMillion: 45 });
  });

  test("gpt-5.6 and gpt-6 models price prompts over 272K at the long-context rate", () => {
    const cases: Array<[string, [number, number], [number, number]]> = [
      ["gpt-5.6-sol", [4, 20], [8, 30]], ["gpt-5.6-terra", [2, 12], [4, 18]], ["gpt-5.6-luna", [0.2, 1.2], [0.4, 1.8]],
      ["gpt-6.2-astra", [8, 40], [16, 60]], ["gpt-6.2-sol", [2, 10], [4, 15]], ["gpt-6.1-sol", [2, 10], [4, 15]], ["gpt-6.1-terra", [1, 5], [2, 7.5]],
      ["gpt-6-astra", [10, 50], [20, 75]], ["gpt-6-sol", [2, 10], [4, 15]], ["gpt-6-luna", [0.1, 0.5], [0.2, 0.75]],
    ];
    for (const [model, short, long] of cases) {
      expect(priced(model, "openai", 272_000, 1)).toMatchObject({ inputUsdPerMillion: short[0], outputUsdPerMillion: short[1] });
      expect(priced(`${model}-2026-11-01`, "openai", 272_001, 1)).toMatchObject({ model, inputUsdPerMillion: long[0], outputUsdPerMillion: long[1] });
    }
    expect(priced("o3-pro", "openai", 1_000_000, 1_000_000).totalUsd).toBeCloseTo(20 + 80, 12);
    expect(priced("o3-pro-2025-06-10", "openai", 10, 10).model).toBe("o3-pro");
  });

  test("retired Claude 4 and 4.1 snapshots still listed on the pricing page are priced", () => {
    expect(priced("claude-sonnet-4-20250514", "anthropic", 1_000_000, 1_000_000).totalUsd).toBeCloseTo(3 + 15, 12);
    expect(priced("claude-opus-4-1-20250805", "anthropic", 1_000_000, 1_000_000).totalUsd).toBeCloseTo(15 + 75, 12);
    expect(priced("claude-opus-4-20250514", "anthropic", 1_000_000, 1_000_000).totalUsd).toBeCloseTo(15 + 75, 12);
  });

  test("every Playground model has a list price, including Google's published 2027 Gemini 3.8 Flash price", () => {
    for (const option of PLAYGROUND_MODELS) {
      const provider = OTEL_PROVIDER_NAME[option.provider];
      for (const at of ["2026-11-25T12:00:00Z", "2026-12-02T00:00:00Z", "2027-02-01T00:00:00Z"]) {
        expect({ model: option.model, at, priced: lookupListPrice(option.model, { provider, at: Date.parse(at) }) !== null }).toEqual({ model: option.model, at, priced: true });
      }
    }
    expect(lookupListPrice(PLAYGROUND_DEFAULT_MODEL.gemini, { provider: "google", at: Date.parse("2026-12-31T23:59:59Z") })?.revision.revision).toBe(PRICE_TABLE_REVISION);
    const after = estimateListPriceCost({ model: "gemini-3.8-flash", provider: "google", inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 200_000, inputIncludesCache: true, at: Date.parse("2027-01-01T00:00:00Z") });
    expect(after).toMatchObject({ kind: "estimated", inputUsdPerMillion: 1.5, outputUsdPerMillion: 7.5, revision: { revision: "runphantom-list-prices/2026-11-25/from-2027-01-01" } });
    // 800,000 fresh × $1.50 + 200,000 cached × $0.15 + 1,000,000 × $7.50 per million.
    expect(after.kind === "estimated" && after.totalUsd).toBeCloseTo(1.2 + 0.03 + 7.5, 12);
    expect(estimateListPriceCost({ model: "gemini-3.8-flash", provider: "google", inputTokens: 1_000_000, outputTokens: 1_000_000 })).toMatchObject({ inputUsdPerMillion: 0.75, outputUsdPerMillion: 3.75 });
    expect(lookupListPrice("gemini-3.6-flash", { at: Date.parse("2027-02-01T00:00:00Z") })?.revision.bands[0].categories.input).toEqual({ kind: "priced", usdPerMillionTokens: 1.5 });
  });

  test("gemini-2.5 calls are billed at the routed model's rates from Google's 2026-12-01 routing change", () => {
    const call = (model: string, at: string) => estimateListPriceCost({ model, provider: "gcp.gemini", inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 200_000, inputIncludesCache: true, at: Date.parse(at) });
    // 800,000 fresh × $0.30 + 200,000 cached × $0.03 + 1,000,000 × $2.50 per million, before and after.
    expect(call("gemini-2.5-flash", "2026-11-30T23:59:59Z")).toMatchObject({ kind: "estimated", revision: { revision: "runphantom-list-prices/2026-11-25" } });
    const flash = call("gemini-2.5-flash", "2026-12-02T00:00:00Z");
    expect(flash).toMatchObject({ kind: "estimated", inputUsdPerMillion: 0.3, outputUsdPerMillion: 2.5, revision: { revision: "runphantom-list-prices/2026-11-25/from-2026-12-01" } });
    expect(flash.kind === "estimated" && flash.totalUsd).toBeCloseTo(0.24 + 0.006 + 2.5, 12);
    expect(call("gemini-2.5-pro", "2026-11-30T23:59:59Z")).toMatchObject({ inputUsdPerMillion: 2.5, outputUsdPerMillion: 15 });
    const pro = call("gemini-2.5-pro", "2026-12-02T00:00:00Z");
    expect(pro).toMatchObject({ inputUsdPerMillion: 0.75, outputUsdPerMillion: 3.75 });
    // 800,000 × $0.75 + 200,000 × $0.075 + 1,000,000 × $3.75.
    expect(pro.kind === "estimated" && pro.totalUsd).toBeCloseTo(0.6 + 0.015 + 3.75, 12);
    expect(call("gemini-2.5-pro", "2027-01-01T00:00:00Z")).toMatchObject({ inputUsdPerMillion: 1.5, outputUsdPerMillion: 7.5, revision: { revision: "runphantom-list-prices/2026-11-25/from-2027-01-01" } });
    expect(PRICE_SOURCES.google.url).toBe("https://aistudio.google.com/docs/pricing");
  });
});

describe("cached input pricing", () => {
  const estimate = (usage: Parameters<typeof estimateListPriceCost>[0]) => {
    const result = estimateListPriceCost(usage);
    if (result.kind !== "estimated") throw new Error(`not priced: ${result.reason}`);
    return result;
  };
  test("OpenAI and Gemini cached tokens are a discounted part of the prompt", () => {
    const openai = estimate({ model: "gpt-5-nano", provider: "openai", inputTokens: 1_000, cacheReadTokens: 800, outputTokens: 100 });
    expect(openai.totalUsd).toBeCloseTo((200 * 0.05 + 800 * 0.005 + 100 * 0.4) / 1e6, 15);
    expect(openai).toMatchObject({ cacheTokens: 800 });
    expect(openai.cacheUsd).toBeCloseTo(800 * 0.005 / 1e6, 15);
    expect(estimate({ model: "gpt-4o", inputTokens: 1_000, cacheReadTokens: 1_000, outputTokens: 0 }).totalUsd).toBeCloseTo(1_000 * 1.25 / 1e6, 15);
    expect(estimate({ model: "gemini-4-neon", inputTokens: 1_000, cacheReadTokens: 1_000, outputTokens: 0 }).totalUsd).toBeCloseTo(1_000 * 0.15 / 1e6, 15);
  });
  test("Anthropic cache reads and writes are billed on top of input at the listed multipliers", () => {
    const sonnet = estimate({ model: "claude-sonnet-4-6", provider: "anthropic", inputTokens: 50, cacheReadTokens: 9_000, cacheWriteTokens: 1_000, outputTokens: 100 });
    expect(sonnet.totalUsd).toBeCloseTo((50 * 3 + 9_000 * 0.3 + 1_000 * 3.75 + 100 * 15) / 1e6, 15);
    const opus = estimate({ model: "claude-opus-5-5", inputTokens: 10, cacheReadTokens: 1_000, cacheWrite1hTokens: 100, inputIncludesCache: false, outputTokens: 0 });
    expect(opus.totalUsd).toBeCloseTo((10 * 4 + 1_000 * 0.2 + 100 * 8) / 1e6, 15);
  });
  test("undeclared Anthropic cache inclusion that the counts cannot settle stays unavailable", () => {
    expect(estimateListPriceCost({ model: "claude-haiku-4-5", inputTokens: 1_000, cacheReadTokens: 200, outputTokens: 10 })).toEqual({ kind: "unavailable", reason: "cache_usage_ambiguous" });
    expect(estimate({ model: "claude-haiku-4-5", inputTokens: 1_000, cacheReadTokens: 200, inputIncludesCache: true, outputTokens: 10 }).totalUsd).toBeCloseTo((800 * 1 + 200 * 0.1 + 10 * 5) / 1e6, 15);
  });
  test("models without a listed cached-input price refuse cached usage", () => {
    expect(estimateListPriceCost({ model: "gpt-5-pro", inputTokens: 1_000, cacheReadTokens: 10, outputTokens: 1 })).toMatchObject({ kind: "unavailable", reason: "estimate_failed" });
    expect(estimateListPriceCost({ model: "gpt-5-nano", inputTokens: 1_000, cacheWriteTokens: 10, outputTokens: 1 })).toMatchObject({ kind: "unavailable", reason: "estimate_failed" });
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
  test("Claude Code hook spans price their cache reads and writes", () => {
    const attributes = JSON.stringify({ source: "claude_hook", usage: { freshInputTokens: 20, outputTokens: 30, cacheCreatedInputTokens: 2_000, cacheReadInputTokens: 40_000 } });
    const cost = spanCost({ model: "claude-sonnet-4-6", provider: "anthropic", input_tokens: 20, output_tokens: 30, attributes, start_time_ms: span.start_time_ms });
    expect(cost.source).toBe("list-price");
    expect(cost.usd).toBeCloseTo((20 * 3 + 40_000 * 0.3 + 2_000 * 3.75 + 30 * 15) / 1e6, 15);
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
