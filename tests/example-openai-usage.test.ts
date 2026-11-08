import { afterEach, describe, expect, test } from "bun:test";
import { ExampleTrace, openAIUsage } from "../examples/shared/runphantom";
import { normalizeUsage } from "../src/pricing/usage";
import { calculateCost } from "../src/pricing/calculator";
import { freezeRateRevision } from "../src/pricing/rates";
import { PRICING_VERSION } from "../src/pricing/protocol";

// Counts combine two live gpt-6.1-terra responses: a 2,622-token prompt with 2,619
// cache hits, and a reply whose 52 output tokens included 36 reasoning tokens.
const completion = {
  model: "gpt-6.1-terra",
  service_tier: "default",
  usage: {
    prompt_tokens: 2622, completion_tokens: 52, total_tokens: 2674,
    prompt_tokens_details: { cached_tokens: 2619, audio_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 36, audio_tokens: 0 },
  },
};
const notApplicable = { kind: "not_applicable" } as const;
const rate = freezeRateRevision({
  version: PRICING_VERSION, provider: "openai", model: "gpt-6.1-terra", tier: "default", revision: "test", currency: "USD", unit: "usd_per_million_tokens",
  source: { kind: "manual", name: "test", reference: null, observedAt: "2026-11-08T00:00:00.000Z" }, aliases: [],
  bands: [{ maxContextTokens: null, categories: {
    input: { kind: "priced", usdPerMillionTokens: 1 }, output: { kind: "priced", usdPerMillionTokens: 5 }, cache_read: { kind: "priced", usdPerMillionTokens: 0.05 },
    cache_write: notApplicable, cache_write_5m: notApplicable, cache_write_1h: notApplicable, reasoning: { kind: "included" }, audio_input: notApplicable, audio_output: notApplicable,
  } }],
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

async function exportedLlmAttributes(): Promise<Record<string, unknown>> {
  let body = "";
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => { body = String(init?.body); return new Response("{}"); }) as unknown as typeof fetch;
  const trace = new ExampleTrace("openai-chat", []);
  trace.addLlm({ name: "openai.chat.completions", provider: "openai", model: "gpt-6.1-terra", input: [], output: [], startedAtMs: Date.now(), ...openAIUsage(completion) });
  await trace.finish({});
  const span = JSON.parse(body).resourceSpans[0].scopeSpans[0].spans.find((item: { name: string }) => item.name === "openai.chat.completions");
  return Object.fromEntries(span.attributes.map((item: { key: string; value: Record<string, unknown> }) => {
    const value = item.value.intValue ?? item.value.boolValue ?? item.value.stringValue;
    return [item.key, typeof item.value.intValue === "string" ? Number(value) : value];
  }));
}

describe("example OpenAI usage export", () => {
  test("keeps cached and reasoning subsets so the estimate equals the provider bill", async () => {
    const attributes = await exportedLlmAttributes();
    expect(attributes).toMatchObject({
      "gen_ai.usage.input_tokens": 2622, "gen_ai.usage.output_tokens": 52,
      "gen_ai.usage.cache_read.input_tokens": 2619, "runphantom.usage.input_includes_cache": true,
      "gen_ai.usage.output_tokens.reasoning": 36, "runphantom.usage.output_includes_reasoning": true,
      "gen_ai.response.model": "gpt-6.1-terra", "runphantom.usage.tier": "default",
    });
    const estimate = calculateCost(normalizeUsage(attributes, "openai"), rate);
    expect(estimate.reasons).toEqual([]);
    const billed = ((2622 - 2619) * 1 + 2619 * 0.05 + 52 * 5) / 1_000_000;
    expect(estimate.totalUsd).toBeCloseTo(billed, 12);
  });

  test("omits usage detail the provider did not report instead of inventing zeros", () => {
    expect(openAIUsage({ model: "gpt-4.1-2025-04-14", usage: null })).toEqual({
      inputTokens: undefined, outputTokens: undefined, cacheReadTokens: undefined, reasoningTokens: undefined, responseModel: "gpt-4.1-2025-04-14", serviceTier: undefined,
    });
  });
});
