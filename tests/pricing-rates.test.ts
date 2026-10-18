import { describe, expect, test } from "bun:test";
import { freezeRateRevision, selectRateRevision } from "../src/pricing/rates";
import { rateFixture, usageFixture } from "./fixtures/pricing";

describe("frozen rate revisions", () => {
  test("preserves explicit free pricing and provenance", () => {
    const rates = freezeRateRevision(rateFixture({ input: { kind: "priced", usdPerMillionTokens: 0 } }));
    expect(rates.bands[0].categories.input).toEqual({ kind: "priced", usdPerMillionTokens: 0 });
    expect(rates.source).toEqual({ kind: "manual", name: "Synthetic qualification rates", reference: null, observedAt: "2026-10-12T00:00:00Z" });
    expect(rates.revision).toBe("fixture-rate-1");
  });

  test.each([-1, NaN, Infinity, -Infinity])("refuses invalid rate %p", value => {
    expect(() => freezeRateRevision(rateFixture({ input: { kind: "priced", usdPerMillionTokens: value } }))).toThrow("Invalid input rate");
  });

  test("refuses missing category policy instead of interpreting it as free", () => {
    const rates = structuredClone(rateFixture());
    delete (rates.bands[0].categories as unknown as Record<string, unknown>).cache_read;
    expect(() => freezeRateRevision(rates)).toThrow("object");
  });

  test.each([ ["currency", "EUR"], ["unit", "usd_per_token"], ["version", "future-version"] ])("rejects unsupported %s", (field, value) => {
    expect(() => freezeRateRevision({ ...rateFixture(), [field]: value })).toThrow("Unsupported");
  });

  test("does not accept an implicit batch discount or unrecognized pricing category", () => {
    expect(() => freezeRateRevision({ ...rateFixture(), batchDiscount: 0.5 })).toThrow("Unsupported rate field");
    const rates = rateFixture();
    expect(() => freezeRateRevision({ ...rates, bands: [{ ...rates.bands[0], categories: { ...rates.bands[0].categories, typo: { kind: "priced", usdPerMillionTokens: 1 } } }] })).toThrow("Unsupported rate field");
  });

  test("bounds, orders, and terminates inclusive context bands", () => {
    const band = rateFixture().bands[0];
    for (const maxima of [[100, 100, null], [200, 100, null], [null, null], [100], [Number.MAX_SAFE_INTEGER + 1, null]]) {
      expect(() => freezeRateRevision(rateFixture({}, { bands: maxima.map(maxContextTokens => ({ ...band, maxContextTokens })) }))).toThrow("Context bands");
    }
    expect(() => freezeRateRevision(rateFixture({}, { bands: Array.from({ length: 9 }, () => band) }))).toThrow("8");
    expect(freezeRateRevision(rateFixture({}, { bands: [{ ...band, maxContextTokens: 100 }, band] })).bands).toHaveLength(2);
  });

  test("copies and deeply freezes every pricing record before caller mutation", () => {
    const supplied = rateFixture();
    const frozen = freezeRateRevision(supplied);
    (supplied.bands[0].categories.input as unknown as { usdPerMillionTokens: number }).usdPerMillionTokens = 999;
    (supplied.source as unknown as { name: string }).name = "later edit";
    expect(frozen.bands[0].categories.input).toEqual({ kind: "priced", usdPerMillionTokens: 3 });
    expect(frozen.source.name).toBe("Synthetic qualification rates");
    for (const value of [frozen, frozen.source, frozen.aliases, frozen.bands, frozen.bands[0], frozen.bands[0].categories, frozen.bands[0].categories.input]) expect(Object.isFrozen(value)).toBe(true);
  });

  test("never executes getters while decoding rates", () => {
    let reads = 0;
    const supplied = { ...rateFixture() };
    Object.defineProperty(supplied, "currency", { get() { reads++; return "USD"; } });
    expect(() => freezeRateRevision(supplied)).toThrow("accessors");
    expect(reads).toBe(0);
  });

  test("inherited rate identity cannot supply missing own data", () => {
    const supplied = Object.assign(Object.create({ provider: "fixture-provider" }), rateFixture()) as Record<string, unknown>;
    delete supplied.provider;
    expect(() => freezeRateRevision(supplied)).toThrow("provider");
  });

  test("refuses sparse or accessor-backed rate lists without executing getters", () => {
    expect(() => freezeRateRevision({ ...rateFixture(), aliases: new Array(1) })).toThrow("holes");
    let reads = 0;
    const bands = [rateFixture().bands[0]];
    Object.defineProperty(bands, "0", { get() { reads++; return rateFixture().bands[0]; } });
    expect(() => freezeRateRevision({ ...rateFixture(), bands })).toThrow("accessors");
    expect(reads).toBe(0);
  });

  test("selects exact declared aliases, never substrings or case-insensitive guesses", () => {
    const rates = freezeRateRevision(rateFixture({}, { aliases: [{ provider: "fixture-provider", model: "explicit-snapshot", tier: "standard" }] }));
    expect(selectRateRevision(usageFixture(), [rates])).toBe(rates);
    expect(selectRateRevision(usageFixture({ "gen_ai.response.model": "explicit-snapshot" }), [rates])).toBe(rates);
    for (const model of ["fixture-model-v2", "FIXTURE-MODEL", "model", "fixture-model/other"]) expect(selectRateRevision(usageFixture({ "gen_ai.response.model": model }), [rates])).toBeNull();
    expect(selectRateRevision(usageFixture({ "gen_ai.provider.name": "other-provider" }), [rates])).toBeNull();
    expect(selectRateRevision(usageFixture({ "runphantom.usage.tier": "priority" }), [rates])).toBeNull();
  });

  test("rejects duplicate alias identities and ambiguous catalogue matches", () => {
    expect(() => freezeRateRevision(rateFixture({}, { aliases: [{ provider: "fixture-provider", model: "fixture-model", tier: "standard" }] }))).toThrow("Duplicate");
    const rates = freezeRateRevision(rateFixture());
    expect(selectRateRevision(usageFixture(), [rates, freezeRateRevision(rateFixture({}, { revision: "second-version" }))])).toBeNull();
  });

  test("accepts a separate explicit batch tier without inventing a discount", () => {
    const batch = freezeRateRevision(rateFixture({ input: { kind: "priced", usdPerMillionTokens: 1.5 } }, { tier: "batch" }));
    expect(selectRateRevision(usageFixture(), [batch])).toBeNull();
    expect(selectRateRevision(usageFixture({ "runphantom.usage.tier": "batch" }), [batch])).toBe(batch);
  });

  test("requires bounded source identity and a real timestamp", () => {
    const source = rateFixture().source;
    for (const observedAt of ["", "yesterday", "2026-10-12", "2026-99-99T00:00:00Z", "2026-02-31T00:00:00Z"]) expect(() => freezeRateRevision(rateFixture({}, { source: { ...source, observedAt } }))).toThrow("timestamp");
    expect(() => freezeRateRevision(rateFixture({}, { source: { ...source, name: "x".repeat(257) } }))).toThrow("source name");
  });
});
