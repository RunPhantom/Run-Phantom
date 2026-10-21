import { expect, test } from "bun:test";
import { randomUUID, createHash } from "node:crypto";
import { COMPARISON_MODELS, freezeComparisonRequest, parseComparisonRequest } from "../src/prompts/comparison-protocol";
import { createComparisonProviderClient } from "../src/prompts/providers";
import { comparisonRate, estimateComparisonUsage } from "../src/prompts/spend-ledger";

const options = { maxOutputTokens: 128, temperature: 0.2 };
test("full-model roster freezes explicit compatible request families and refuses budget-model substitution", () => {
  expect(COMPARISON_MODELS.map(value => value.model)).toEqual(["gpt-5.4", "gpt-4.1", "claude-opus-4-6", "claude-sonnet-4-6"]);
  const template = "Literal {{topic}}", promptId = randomUUID();
  const input = parseComparisonRequest({ operationKey: randomUUID(), promptId, revision: 1, variables: { topic: "$& {{literal}}" }, targets: COMPARISON_MODELS, options, operationBudgetMicrousd: 1000000, expectedGeneration: 1 });
  const frozen = freezeComparisonRequest(input, { id: promptId, revision: 1, name: "Family", template, templateSha256: createHash("sha256").update(template).digest("hex"), variableNames: ["topic"], policy: "literal-v1", createdAt: 1 });
  expect(frozen.families).toMatchObject([{ provider: "openai", model: "gpt-5.4", reasoningEffort: "none", tier: "default" }, { provider: "openai", model: "gpt-4.1", reasoningEffort: null }, { provider: "anthropic", model: "claude-opus-4-6", thinking: "disabled", tier: "standard_only", inferenceGeo: "global" }, { provider: "anthropic", model: "claude-sonnet-4-6", thinking: "disabled", tier: "standard_only", inferenceGeo: "global" }]);
  expect(Object.isFrozen(frozen.families)).toBe(true);
  for (const model of ["gpt-4.1-mini", "claude-haiku-4-5-20251001", "unknown-model"]) expect(() => comparisonRate({ provider: model.startsWith("claude") ? "anthropic" : "openai", model })).toThrow();
});
test("full-model frozen quotes use actual F14 categories and never turn unsupported identity into zero", () => {
  for (const [model, provider, input, output, cached] of [["gpt-5.4", "openai", 2.5, 15, 0.25], ["gpt-4.1", "openai", 2, 8, 0.5], ["claude-opus-4-6", "anthropic", 5, 25, 0.5], ["claude-sonnet-4-6", "anthropic", 3, 15, 0.3]] as const) {
    const target = { model, provider }, rate = comparisonRate(target);
    expect(rate.bands[0].categories).toMatchObject({ input: { kind: "priced", usdPerMillionTokens: input }, output: { kind: "priced", usdPerMillionTokens: output }, cache_read: { kind: "priced", usdPerMillionTokens: cached } });
    expect(estimateComparisonUsage(target, { model: "foreign", inputTokens: 0, outputTokens: 0 }).estimate.totalUsd).toBeNull();
  }
});
test("native OpenAI full-family requests pin tier/storage and apply reasoning only to the compatible model", async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { const body = await request.json() as Record<string, unknown>; bodies.push(body); return Response.json({ model: body.model, choices: [{ message: { content: "Output" }, finish_reason: "stop" }], service_tier: "default", usage: { prompt_tokens: 2, completion_tokens: 1 } }); } });
  try {
    const client = createComparisonProviderClient({ credentials: { openai: "fixture-token" }, transport: (_url, init) => fetch(server.url, init), provenance: "controlled-http-fixture" });
    for (const model of ["gpt-5.4", "gpt-4.1"]) { const result = await client.execute({ target: { provider: "openai", model }, compiled: "$& {{literal}}", options, signal: new AbortController().signal }); expect(result.usage.tier).toBe("standard"); }
    expect(bodies[0]).toMatchObject({ model: "gpt-5.4", reasoning_effort: "none", temperature: 0.2, max_completion_tokens: 128, store: false, service_tier: "default", stream: false });
    expect(bodies[1]).toMatchObject({ model: "gpt-4.1", temperature: 0.2, service_tier: "default", store: false }); expect(bodies[1]).not.toHaveProperty("reasoning_effort");
  } finally { await server.stop(true); }
});
test("native Claude full-family requests disable thinking and pin global standard inference", async () => {
  let body: unknown;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { body = await request.json(); return Response.json({ model: "claude-opus-4-6", content: [{ type: "text", text: "Output" }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 1, inference_geo: "global", service_tier: "standard" } }); } });
  try {
    const client = createComparisonProviderClient({ credentials: { anthropic: "fixture-token" }, transport: (_url, init) => fetch(server.url, init), provenance: "controlled-http-fixture" });
    await client.execute({ target: { provider: "anthropic", model: "claude-opus-4-6" }, compiled: "Frozen", options, signal: new AbortController().signal });
    expect(body).toMatchObject({ thinking: { type: "disabled" }, inference_geo: "global", service_tier: "standard_only", temperature: 0.2, max_tokens: 128 });
  } finally { await server.stop(true); }
});

test("unverified provider tier or inference geography preserves unknown pricing rather than claiming standard zero", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { model: string };
    return body.model.startsWith("gpt") ? Response.json({ model: body.model, choices: [{ message: { content: "Output" }, finish_reason: "stop" }], service_tier: "priority", usage: { prompt_tokens: 0, completion_tokens: 0 } })
      : Response.json({ model: body.model, content: [{ type: "text", text: "Output" }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0, service_tier: "standard", inference_geo: "us" } });
  } });
  try {
    const client = createComparisonProviderClient({ credentials: { openai: "fixture-token", anthropic: "fixture-token" }, transport: (_url, init) => fetch(server.url, init), provenance: "controlled-http-fixture" });
    for (const target of [{ provider: "openai", model: "gpt-5.4" }, { provider: "anthropic", model: "claude-opus-4-6" }] as const) {
      const result = await client.execute({ target, compiled: "Frozen", options, signal: new AbortController().signal });
      expect(estimateComparisonUsage(target, result.usage).estimate.totalUsd).toBeNull();
    }
  } finally { await server.stop(true); }
});

test("native GPT5.4 context threshold and missing/conflicting cache observations never use guessed standard rates", async () => {
  for (const [inputTokens, cacheTokens, expected] of [[272000, 0, "complete"], [272001, 0, "unavailable"], [2, undefined, "unavailable"], [2, 3, "unavailable"], [0, 0, "complete"]] as const) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.json({ model: "gpt-5.4", choices: [{ message: { content: "Output" }, finish_reason: "stop" }], service_tier: "default", usage: { prompt_tokens: inputTokens, completion_tokens: 0, ...(cacheTokens === undefined ? {} : { prompt_tokens_details: { cached_tokens: cacheTokens } }) } }); } });
    try {
      const client = createComparisonProviderClient({ credentials: { openai: "fixture-token" }, transport: (_url, init) => fetch(server.url, init), provenance: "controlled-http-fixture" });
      const result = await client.execute({ target: { provider: "openai", model: "gpt-5.4" }, compiled: "Frozen", options, signal: new AbortController().signal });
      const cost = estimateComparisonUsage({ provider: "openai", model: "gpt-5.4" }, result.usage); expect(cost.estimate.coverage).toBe(expected); expect(cost.invoiceUsd).toBeNull();
      if (inputTokens === 272000) expect(cost.estimate.totalUsd).toBe(0.68); if (inputTokens === 0) expect(cost.estimate.totalUsd).toBe(0);
      if (expected === "unavailable") expect(cost.estimate.totalUsd).toBeNull();
    } finally { await server.stop(true); }
  }
});
