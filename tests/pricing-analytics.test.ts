import { describe, expect, test } from "bun:test";
import { aggregateCostAnalytics, ANALYTICS_LIMITS, parseCostAnalyticsRequest, type AnalyticsSpan, type CostAnalyticsRequest } from "../src/pricing/analytics";
import { parseNominalCatalogue } from "../src/pricing/rates";
import { TOKEN_CATEGORIES } from "../src/pricing/protocol";
import { rateFixture } from "./fixtures/pricing";

const request = (overrides: Partial<CostAnalyticsRequest> = {}): CostAnalyticsRequest => ({ from: 0, to: 86_400_000, bucket: "hour", estimateMode: "captured", rates: [rateFixture()], ...overrides });
const span = (overrides: Partial<AnalyticsSpan> = {}, attrs: Record<string, unknown> = {}): AnalyticsSpan => ({ projectId: "project-a", runId: "run-a", id: "generation-a", parentSpanId: null, kind: "LLM_GENERATION", startedAt: 1_000,
  model: "fixture-model", provider: "fixture-provider", inputTokens: 200, outputTokens: 300,
  attributes: JSON.stringify({ "runphantom.usage.tier": "standard", "gen_ai.usage.cost_usd": .123, ...attrs }), ...overrides });

describe("complete captured cost and usage populations", () => {
  test("keeps known amounts, unavailable rows, and reported money separate", () => {
    const result = aggregateCostAnalytics([span(), span({ id: "missing", model: "missing-model", outputTokens: null, attributes: null }), span({ id: "free", inputTokens: 0, outputTokens: 0 }, { "gen_ai.usage.cost_usd": 0 })], request());
    expect(result.reportedUsd).toMatchObject({ eligibleCount: 3, knownCount: 2, unavailableCount: 1, zeroCount: 1, knownSum: .123, completeTotal: null });
    expect(result.estimatedUsd).toMatchObject({ eligibleCount: 3, knownCount: 2, unavailableCount: 1, zeroCount: 1, completeTotal: null });
    expect(result.estimatedUsd.knownSum).toBeCloseTo(.0051, 12);
    expect(result.tokens.input.completeTotal).toBe(400);
    expect(result.tokens.output).toMatchObject({ knownCount: 2, unavailableCount: 1, knownSum: 300, completeTotal: null });
    expect(result.byModel.find(row => row.identity === "missing-model")!.estimatedUsd.unavailableCount).toBe(1);
    expect(result.rateRevisions[0].source.name).toBe("Synthetic qualification rates");
  });
  test("all nine observed categories keep missing detail unavailable", () => {
    const result = aggregateCostAnalytics([span()], request());
    expect(Object.keys(result.tokens)).toEqual([...TOKEN_CATEGORIES]);
    for (const category of TOKEN_CATEGORIES.filter(category => category !== "input" && category !== "output")) {
      expect(result.tokens[category]).toMatchObject({ knownCount: 0, unavailableCount: 1, knownSum: null, completeTotal: null });
    }
    expect(result.estimatedUsd.completeTotal).toBeCloseTo(.0051, 12);
  });
  test("fully observed free usage differs from an empty population", () => {
    const free = aggregateCostAnalytics([span({ inputTokens: 0, outputTokens: 0 }, { "gen_ai.usage.cost_usd": 0 })], request());
    expect(free.estimatedUsd).toMatchObject({ knownCount: 1, zeroCount: 1, knownSum: 0, completeTotal: 0 });
    const empty = aggregateCostAnalytics([], request());
    expect(empty.estimatedUsd).toMatchObject({ knownCount: 0, zeroCount: 0, knownSum: null, completeTotal: null, sumState: "empty" });
  });
  test("deduplicates ancestry through a tool and outside the selected window", () => {
    const rows = [span({ id: "parent", startedAt: 100 }), span({ id: "tool", parentSpanId: "parent", kind: "TOOL_CALL", startedAt: 200 }), span({ id: "child", parentSpanId: "tool", startedAt: 1_000, inputTokens: 9_000 })];
    const result = aggregateCostAnalytics(rows, request({ from: 500 }));
    expect(result.population).toMatchObject({ nestedExcluded: 1, outsideWindow: 1, selectedGenerations: 0, acquiredSpans: 3 });
    expect(result.estimatedUsd.completeTotal).toBeNull();
    const inclusive = aggregateCostAnalytics(rows, request());
    expect(inclusive.tokens.input.completeTotal).toBe(200);
    expect(inclusive.population.nestedExcluded).toBe(1);
  });
  test("IDs never deduplicate across projects or runs", () => {
    const result = aggregateCostAnalytics([span(), span({ projectId: "project-b" }), span({ runId: "run-b" })], request());
    expect(result.tokens.input.completeTotal).toBe(600);
    expect(result.byProject.map(row => [row.identity, row.reportedUsd.eligibleCount])).toEqual([["project-a", 2], ["project-b", 1]]);
  });
  test.each(["missing", "cycle", "duplicate"])("%s ancestry stays unavailable", problem => {
    const rows = problem === "duplicate" ? [span(), span()] : problem === "cycle" ? [span({ parentSpanId: "generation-a" })] : [span({ parentSpanId: "uncaptured" })];
    const result = aggregateCostAnalytics(rows, request());
    expect(result.estimatedUsd.knownCount).toBe(0);
    expect(result.estimatedUsd.unavailableCount).toBe(rows.length);
    expect(result.population.ancestryUnavailable).toBe(rows.length);
    expect(result.tokens.input.completeTotal).toBeNull();
  });
  test("includes an unknown model/provider group instead of dropping it", () => {
    const result = aggregateCostAnalytics([span({ model: null, provider: null })], request());
    expect(result.byModel[0].identity).toBeNull();
    expect(result.byProvider[0].identity).toBeNull();
    expect(result.reportedUsd.completeTotal).toBe(.123);
    expect(result.estimatedUsd.unavailableCount).toBe(1);
  });
  test("UTC window bounds are inclusive/exclusive and untimed rows are disclosed", () => {
    const result = aggregateCostAnalytics([span({ id: "first", startedAt: 3_600_000 }), span({ id: "last", startedAt: 7_200_000 }), span({ id: "untimed", startedAt: null })], request({ from: 3_600_000, to: 7_200_000 }));
    expect(result.window).toMatchObject({ timezone: "UTC", field: "generationStartedAt" });
    expect(result.reportedUsd.eligibleCount).toBe(2);
    expect(result.reportedUsd.completeTotal).toBeNull();
    expect(result.reportedUsd.knownSum).toBe(.123);
    expect(result.population).toMatchObject({ outsideWindow: 1, untimedGenerations: 1, selectedGenerations: 1 });
    expect(result.untimed.reportedUsd.unavailableReasons.timestamp_unavailable).toBe(1);
    expect(result.byTime.map(row => row.identity)).toEqual(["1970-01-01T01:00:00.000Z", null]);
  });
  test.each([-1, .5, Number.MAX_SAFE_INTEGER + 1])("invalid observed count %p does not fall back to a valid column", value => {
    const result = aggregateCostAnalytics([span({}, { "gen_ai.usage.input_tokens": value })], request());
    expect(result.tokens.input.knownCount).toBe(0);
    expect(result.estimatedUsd.completeTotal).toBeNull();
  });
  test.each(["null", "[]", "{broken", '{"gen_ai.usage.input_tokens":0,"gen_ai.usage.input_tokens":1}'])("invalid attributes %s do not invent observed zero", attributes => {
    const result = aggregateCostAnalytics([span({ attributes })], request());
    expect(result.reportedUsd.knownCount).toBe(0);
    expect(result.tokens.input.knownCount).toBe(0);
    expect(result.estimatedUsd.completeTotal).toBeNull();
  });
  test("conflicting cost aliases and foreign currency are unavailable", () => {
    const result = aggregateCostAnalytics([span({}, { "runphantom.cost.usd": 999 }), span({ id: "foreign" }, { "runphantom.cost.currency": "EUR" })], request());
    expect(result.reportedUsd).toMatchObject({ knownCount: 0, unavailableCount: 2, completeTotal: null });
    expect(result.reportedUsd.unavailableReasons).toEqual({ reported_cost_conflicting: 1, reported_currency_unavailable: 1 });
    expect(result.estimatedUsd.completeTotal).toBeCloseTo(.0102, 12);
  });
  test("invalid unit refuses every category and aggregate overflow remains explicit", () => {
    const invalid = aggregateCostAnalytics([span({}, { "runphantom.usage.unit": "characters" })], request());
    for (const category of TOKEN_CATEGORIES) expect(invalid.tokens[category].knownCount).toBe(0);
    const overflow = aggregateCostAnalytics([span({ inputTokens: Number.MAX_SAFE_INTEGER }), span({ id: "other", inputTokens: 1 })], request());
    expect(overflow.tokens.input).toMatchObject({ knownCount: 2, knownSum: null, completeTotal: null, sumState: "overflow" });
  });
  test("nominal estimates retain actual provider grouping and exact catalogue provenance", () => {
    const rates = parseNominalCatalogue({ data: [{ id: "fixture/fixture-model", pricing: { prompt: "0.000003", completion: "0.000015" } }] }, "sha256:" + "1".repeat(64), "2026-10-12T00:00:00Z").rates;
    const result = aggregateCostAnalytics([span({}, { "runphantom.usage.tier": "unpriced-actual-tier" })], request({ estimateMode: "nominal-input-output", rates }));
    expect(result.estimatedUsd.completeTotal).toBeCloseTo(.0051, 12);
    expect(result.byProvider[0].identity).toBe("fixture-provider");
    expect(result.rateRevisions[0].provider).toBe("openrouter-catalogue");
    expect(result.reportedUsd.completeTotal).toBe(.123);
  });
  test("unambiguous exact identity is mandatory for captured pricing", () => {
    const result = aggregateCostAnalytics([span()], request({ rates: [rateFixture(), rateFixture({}, { revision: "other-revision" })] }));
    expect(result.estimatedUsd.knownCount).toBe(0);
    expect(result.estimatedUsd.unavailableReasons.rate_identity_unavailable).toBe(1);
  });
  test("frozen result cannot follow caller edits to rates", () => {
    const rates = [rateFixture()];
    const result = aggregateCostAnalytics([span()], request({ rates }));
    Reflect.set(rates[0].bands[0].categories, "input", { kind: "priced", usdPerMillionTokens: 999 });
    expect(result.rateRevisions[0].bands[0].categories.input).toEqual({ kind: "priced", usdPerMillionTokens: 3 });
    expect(Object.isFrozen(result.byModel[0].tokens.input)).toBe(true);
  });
  test("resource limits refuse a population rather than returning a sample", () => {
    expect(() => aggregateCostAnalytics(Array.from({ length: ANALYTICS_LIMITS.spans + 1 }, () => span()), request())).toThrow("complete-population limit");
  });
});

describe("strict request-scoped rates", () => {
  test.each([{ extra: true }, { from: "0" }, { to: 0 }, { to: 31 * 86_400_000 + 1 }, { bucket: "week" }, { estimateMode: "actual-billing" }, { rates: [rateFixture({}, { currency: "EUR" as "USD" })] }, { rates: [rateFixture(), rateFixture()] }])("rejects invalid request %p atomically", overrides => {
    expect(() => parseCostAnalyticsRequest({ ...request(), ...overrides })).toThrow("Invalid cost analytics request");
  });
  test("rejects accessors without executing them", () => {
    let touched = false;
    expect(() => parseCostAnalyticsRequest({ ...request(), get bucket() { touched = true; return "hour"; } })).toThrow();
    expect(touched).toBe(false);
  });
  test("nominal mode refuses a manual actual-provider rate", () => {
    expect(() => parseCostAnalyticsRequest(request({ estimateMode: "nominal-input-output" }))).toThrow();
  });
});
