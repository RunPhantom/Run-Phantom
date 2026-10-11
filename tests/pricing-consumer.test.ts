import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { fetchPrices, fmtCost, fmtRate, getCostBreakdown, getPricingSnapshot, getPricingUsageByModel, setModelPricingConsent, subscribePricing } from "../app/src/utils/costs";
import type { Span } from "../app/src/utils/types";

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
const model = (id: string, prompt: unknown = "0.000003", completion: unknown = "0.000015") => ({ id, pricing: { prompt, completion } });

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
  fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [model("fixture/known")] })));
  setModelPricingConsent(false);
});

afterEach(() => {
  setModelPricingConsent(false);
  fetchMock.mockRestore();
  if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("actual app pricing consumer", () => {
  test("enforces consent inside the fetch entrypoint", async () => {
    await fetchPrices();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("preserves a free catalogue quote instead of treating it as unknown", async () => {
    setModelPricingConsent(true);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [model("fixture/free", "0", "0")] })));
    await fetchPrices();
    expect(getCostBreakdown("fixture/free", 100, 100)?.totalCost).toBe(0);
    expect(fmtCost(0)).toBe("$0.00");
  });

  test("refuses malformed numeric strings instead of accepting prefixes", async () => {
    setModelPricingConsent(true);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [model("fixture/bad", "0.000003junk"), model("fixture/control")] })));
    await fetchPrices();
    expect(getCostBreakdown("fixture/bad", 100, 100)).toBeNull();
    expect(getCostBreakdown("fixture/control", 100, 100)?.totalCost).toBeCloseTo(0.0018, 12);
  });

  test("refuses ambiguous short aliases and approximate model identities", async () => {
    setModelPricingConsent(true);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [model("first/shared"), model("second/shared"), model("fixture/known")] })));
    await fetchPrices();
    expect(getCostBreakdown("shared", 100, 100)).toBeNull();
    expect(getCostBreakdown("known-new", 100, 100)).toBeNull();
    expect(getCostBreakdown("first/shared", 100, 100)?.totalCost).toBeCloseTo(0.0018, 12);
  });

  test("revocation immediately removes previously available prices", async () => {
    setModelPricingConsent(true);
    await fetchPrices();
    expect(getCostBreakdown("fixture/known", 100, 100)).not.toBeNull();
    setModelPricingConsent(false);
    expect(getCostBreakdown("fixture/known", 100, 100)).toBeNull();
  });

  test.each([-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])("invalid count %p stays unavailable", async value => {
    setModelPricingConsent(true);
    await fetchPrices();
    expect(getCostBreakdown("fixture/known", value, 100)).toBeNull();
  });

  test("duplicate JSON price keys cannot choose a last-write price", async () => {
    setModelPricingConsent(true);
    fetchMock.mockResolvedValue(new Response('{"data":[{"id":"fixture/known","pricing":{"prompt":"0","prompt":"0.000003","completion":"0.000015"}}]}'));
    await fetchPrices();
    expect(getCostBreakdown("fixture/known", 100, 100)).toBeNull();
  });

  test("listeners observe load and revocation without reopening run detail", async () => {
    const statuses: string[] = [];
    const unsubscribe = subscribePricing(() => statuses.push(getPricingSnapshot().status));
    try {
      setModelPricingConsent(true);
      await fetchPrices();
      const result = getCostBreakdown("fixture/known", 100, 100)!;
      expect(statuses).toEqual(["idle", "loading", "ready"]);
      expect(result.catalogueId).toBe("fixture/known");
      expect(result.rateRevision).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(result.source.reference).toBe("https://openrouter.ai/api/v1/models");
      setModelPricingConsent(false);
      expect(statuses.at(-1)).toBe("disabled");
    } finally { unsubscribe(); }
  });

  test("concurrent consumers share one admitted catalogue request", async () => {
    setModelPricingConsent(true);
    await Promise.all([fetchPrices(), fetchPrices(), fetchPrices()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getPricingSnapshot().status).toBe("ready");
  });

  test("a transport that returns after revocation cannot resurrect prices", async () => {
    let deliver!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { deliver = resolve; }));
    setModelPricingConsent(true);
    const request = fetchPrices();
    setModelPricingConsent(false);
    deliver(new Response(JSON.stringify({ data: [model("fixture/known")] })));
    await request;
    expect(getPricingSnapshot().status).toBe("disabled");
    expect(getCostBreakdown("fixture/known", 100, 100)).toBeNull();
  });

  test("rejects an oversized advertised catalogue and then accepts a valid retry", async () => {
    setModelPricingConsent(true);
    fetchMock.mockResolvedValue(new Response("{}", { headers: { "content-length": "8388609" } }));
    await fetchPrices();
    expect(getPricingSnapshot().status).toBe("error");
    expect(getCostBreakdown("fixture/known", 100, 100)).toBeNull();
    setModelPricingConsent(true);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [model("fixture/known")] })));
    await fetchPrices();
    expect(getPricingSnapshot().status).toBe("ready");
  });

  test("terminates a byte-over-limit stream even without a content-length header", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(pulls++ === 0 ? 8 * 1024 * 1024 : 1)); },
      cancel() { cancelled = true; },
    });
    setModelPricingConsent(true);
    fetchMock.mockResolvedValue(new Response(body));
    await fetchPrices();
    expect(cancelled).toBe(true);
    expect(getPricingSnapshot().status).toBe("error");
    expect(getCostBreakdown("fixture/known", 100, 100)).toBeNull();
  });

  test("rate labels retain tiny rates without floating noise or exponent notation", () => {
    expect(fmtRate(0.000004)).toBe("$0.000004");
    expect(fmtRate(0.39999999999999997)).toBe("$0.4");
    expect(fmtRate(0)).toBe("$0");
    expect(fmtRate(NaN)).toBe("Unavailable");
  });
});

const span = (id: string, model: string | null, input_tokens: number | null, output_tokens: number | null, parent_span_id: string | null = null): Span => ({
  id, run_id: "fixture-run", parent_span_id, model, input_tokens, output_tokens, span_type: "LLM", name: "synthetic generation", status: "OK",
  input_payload: null, output_payload: null, start_time_ms: 0, end_time_ms: 1, duration_ms: 1, provider: null, attributes: null,
});

describe("pricing capture populations", () => {
  test("fully captured zero-token generations remain visible", () => {
    expect(getPricingUsageByModel([span("zero", "fixture/known", 0, 0)]).get("fixture/known")).toEqual({ inTok: 0, outTok: 0 });
  });

  test("missing token capture and model identity remain explicit populations", () => {
    const rows = getPricingUsageByModel([span("one", "fixture/known", null, 100), span("two", "fixture/known", 10, 3), span("missing-model", null, 10, 20)]);
    expect(rows.get("fixture/known")).toEqual({ inTok: null, outTok: 103 });
    expect(rows.get(null)).toEqual({ inTok: 10, outTok: 20 });
  });

  test("nested aggregate LLM token counters cannot be added a second time", () => {
    expect(getPricingUsageByModel([span("root", "fixture/known", 100, 200), span("child", "fixture/known", 100, 200, "root")]).get("fixture/known")).toEqual({ inTok: 100, outTok: 200 });
  });

  test("model totals refuse unsafe accumulation rather than rounding", () => {
    expect(getPricingUsageByModel([span("one", "fixture/known", Number.MAX_SAFE_INTEGER, 1), span("two", "fixture/known", 1, 1)]).get("fixture/known")).toEqual({ inTok: null, outTok: 2 });
  });
});
