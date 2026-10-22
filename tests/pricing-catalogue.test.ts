import { describe, expect, test } from "bun:test";
import { calculateCost } from "../src/pricing/calculator";
import { NOMINAL_CATALOGUE_PROVIDER, NOMINAL_CATALOGUE_TIER, parseNominalCatalogue, selectRateRevision } from "../src/pricing/rates";
import { normalizeUsage } from "../src/pricing/usage";

const timestamp = "2026-10-12T00:00:00Z";
const model = (id = "fixture/known", prompt: unknown = "0.000003", completion: unknown = "0.000015") => ({ id, pricing: { prompt, completion } });
const usage = (name: string) => normalizeUsage({ "gen_ai.response.model": name, "runphantom.usage.tier": NOMINAL_CATALOGUE_TIER, "gen_ai.usage.input_tokens": 200, "gen_ai.usage.output_tokens": 300 }, NOMINAL_CATALOGUE_PROVIDER);

describe("nominal public catalogue admission", () => {
  test("normalizes explicit token prices with frozen source, identity and units", () => {
    const catalogue = parseNominalCatalogue({ data: [model()] }, "catalogue-byte-digest", timestamp);
    const rate = catalogue.rates[0];
    expect(rate.bands[0].categories.input).toEqual({ kind: "priced", usdPerMillionTokens: 3 });
    expect(rate.bands[0].categories.output).toEqual({ kind: "priced", usdPerMillionTokens: 15 });
    expect(rate.provider).toBe("openrouter-catalogue");
    expect(rate.tier).toBe("nominal-input-output");
    expect(rate.revision).toBe("catalogue-byte-digest");
    expect(rate.source.observedAt).toBe(timestamp);
    expect(calculateCost(usage("fixture/known"), rate).totalUsd).toBeCloseTo(0.0051, 12);
  });

  test("preserves a fully free quote", () => {
    const catalogue = parseNominalCatalogue({ data: [model("fixture/free", "0", "0")] }, "revision", timestamp);
    expect(catalogue.rates).toHaveLength(1);
    expect(calculateCost(usage("fixture/free"), catalogue.rates[0]).totalUsd).toBe(0);
  });

  test("malformed model paths cannot turn a valid catalogue into a failed alias decode", () => {
    const catalogue = parseNominalCatalogue({ data: [model("fixture/"), model("/fixture"), model()] }, "revision", timestamp);
    expect(catalogue.rejectedModels).toBe(2);
    expect(catalogue.rates.map(rate => rate.model)).toEqual(["fixture/known"]);
  });

  test.each([undefined, null, "", " 0.01", "0.01USD", "-0.01", "Infinity", "NaN", "1e999", "1e-999", 0.01])("rejects incomplete or invalid quote %p", prompt => {
    const catalogue = parseNominalCatalogue({ data: [{ ...model("fixture/bad"), pricing: { prompt, completion: "0.000015" } }, model()] }, "revision", timestamp);
    expect(catalogue.rejectedModels).toBe(1);
    expect(catalogue.rates.map(rate => rate.model)).toEqual(["fixture/known"]);
  });

  test("accepts a complete finite exponent rather than parseFloat prefixes", () => {
    const catalogue = parseNominalCatalogue({ data: [model("fixture/exponent", "3e-6", "15e-6")] }, "revision", timestamp);
    expect(catalogue.rates[0].bands[0].categories.input).toEqual({ kind: "priced", usdPerMillionTokens: 3 });
  });

  test("admits only unique exact short aliases and keeps canonical IDs available", () => {
    const catalogue = parseNominalCatalogue({ data: [model("first/shared"), model("second/shared"), model("first/unique")] }, "revision", timestamp);
    expect(catalogue.ambiguousAliases).toEqual(["shared"]);
    expect(selectRateRevision(usage("shared"), catalogue.rates)).toBeNull();
    expect(selectRateRevision(usage("first/shared"), catalogue.rates)?.model).toBe("first/shared");
    expect(selectRateRevision(usage("unique"), catalogue.rates)?.model).toBe("first/unique");
    expect(selectRateRevision(usage("UNIQUE"), catalogue.rates)).toBeNull();
    expect(selectRateRevision(usage("uni"), catalogue.rates)).toBeNull();
  });

  test("duplicate canonical IDs cannot make catalogue order choose a price", () => {
    const catalogue = parseNominalCatalogue({ data: [model(), model("fixture/known", "0.01"), model("fixture/control")] }, "revision", timestamp);
    expect(catalogue.rejectedModels).toBe(2);
    expect(catalogue.rates.map(rate => rate.model)).toEqual(["fixture/control"]);
    expect(selectRateRevision(usage("known"), catalogue.rates)).toBeNull();
  });

  test("invalid duplicate quotes cannot grant a different row authoritative identity", () => {
    const catalogue = parseNominalCatalogue({ data: [model(), model("fixture/known", "invalid"), model("fixture/control")] }, "revision", timestamp);
    expect(catalogue.rejectedModels).toBe(2);
    expect(catalogue.rates.map(rate => rate.model)).toEqual(["fixture/control"]);
    const aliases = parseNominalCatalogue({ data: [model("first/shared"), model("second/shared", "invalid")] }, "revision", timestamp);
    expect(selectRateRevision(usage("shared"), aliases.rates)).toBeNull();
  });

  test("a source refresh never mutates an earlier nominal rate revision", () => {
    const first = parseNominalCatalogue({ data: [model()] }, "first-bytes", timestamp);
    const later = parseNominalCatalogue({ data: [model("fixture/known", "0.01")] }, "later-bytes", timestamp);
    expect(calculateCost(usage("fixture/known"), first.rates[0]).totalUsd).toBeCloseTo(0.0051, 12);
    expect(calculateCost(usage("fixture/known"), later.rates[0]).totalUsd).toBeCloseTo(2.0045, 12);
    expect(first.rates[0].revision).toBe("first-bytes");
  });

  test("bounded malformed or empty envelopes cannot bypass source identity validation", () => {
    expect(() => parseNominalCatalogue({}, "revision", timestamp)).toThrow();
    expect(() => parseNominalCatalogue({ data: new Array(1) }, "revision", timestamp)).toThrow("holes");
    expect(() => parseNominalCatalogue({ data: new Array(5001) }, "revision", timestamp)).toThrow("5000");
    expect(() => parseNominalCatalogue({ data: [] }, "", timestamp)).toThrow("revision");
    expect(() => parseNominalCatalogue({ data: [] }, "revision", "not-a-date")).toThrow("timestamp");
    expect(parseNominalCatalogue({ data: [] }, "revision", timestamp).rates).toEqual([]);
  });
});
