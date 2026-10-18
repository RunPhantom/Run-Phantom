import { describe, expect, test } from "bun:test";
import { normalizeUsage, validTokenCount } from "../src/pricing/usage";

describe("captured token usage", () => {
  test("keeps explicit zero and separates absent from invalid measurements", () => {
    const usage = normalizeUsage({ "gen_ai.usage.input_tokens": 0, "gen_ai.usage.output_tokens": null });
    expect(usage.categories.input).toEqual({ count: 0, state: "known", attributes: ["gen_ai.usage.input_tokens"] });
    expect(usage.categories.output.state).toBe("invalid");
    expect(usage.categories.cache_read.state).toBe("missing");
    expect(usage.categories.cache_read.count).toBeNull();
  });

  test.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "12", true])("refuses unsupported count %p", value => {
    const usage = normalizeUsage({ "gen_ai.usage.input_tokens": value });
    expect(usage.categories.input.state).toBe("invalid");
    expect(usage.categories.input.count).toBeNull();
    expect(validTokenCount(value)).toBe(false);
  });

  test("does not hide conflicting SDK aliases behind precedence", () => {
    const usage = normalizeUsage({ "gen_ai.usage.input_tokens": 12, "ai.usage.inputTokens": 13 });
    expect(usage.categories.input.state).toBe("conflicting");
    expect(usage.categories.input.count).toBeNull();
    expect(normalizeUsage({ "gen_ai.usage.input_tokens": 12, "ai.usage.inputTokens": 12 }).categories.input.count).toBe(12);
  });

  test("requires captured cache/audio/reasoning inclusion rather than provider guessing", () => {
    const usage = normalizeUsage({ "runphantom.usage.cache_read_tokens": 10 }, "provider");
    expect(usage.inclusion.cache_read).toBe("unknown");
    expect(usage.inputDetailsDisjoint).toBeNull();
    const declared = normalizeUsage({
      "runphantom.usage.input_includes_cache": false,
      "runphantom.usage.input_includes_audio": true,
      "runphantom.usage.output_includes_reasoning": true,
      "runphantom.usage.output_includes_audio": false,
      "runphantom.usage.input_categories_disjoint": true,
    });
    expect(declared.inclusion).toMatchObject({ cache_read: "additional", cache_write_1h: "additional", audio_input: "included", reasoning: "included", audio_output: "additional" });
    expect(declared.inputDetailsDisjoint).toBe(true);
  });

  test("binds actual response model, tier and full context independently of uncached input", () => {
    const usage = normalizeUsage({
      "gen_ai.provider.name": "provider", "gen_ai.request.model": "requested-alias", "gen_ai.response.model": "actual-snapshot",
      "gen_ai.request.service_tier": "priority", "gen_ai.usage.input_tokens": 200,
      "runphantom.usage.context_tokens": 6200,
    });
    expect(usage.provider).toBe("provider");
    expect(usage.model).toBe("actual-snapshot");
    expect(usage.tier).toBe("priority");
    expect(usage.contextTokens.count).toBe(6200);
    expect(usage.categories.input.count).toBe(200);
  });

  test("does not substitute request model when captured response identity is invalid", () => {
    const usage = normalizeUsage({ "gen_ai.request.model": "requested", "gen_ai.response.model": "" });
    expect(usage.model).toBeNull();
  });

  test("keeps unknown tier unknown and refuses conflicting provider identity", () => {
    const usage = normalizeUsage({ "gen_ai.provider.name": "captured" }, "different");
    expect(usage.provider).toBeNull();
    expect(usage.tier).toBeNull();
    expect(usage.issues).toContain("conflicting_provider");
    expect(normalizeUsage({ "gen_ai.provider.name": "" }, "valid").issues).toContain("invalid_or_conflicting_provider");
  });

  test("refuses a conflicting or unsupported unit", () => {
    const usage = normalizeUsage({ "runphantom.usage.unit": "seconds", "gen_ai.usage.input_tokens": 12 });
    expect(usage.issues).toEqual(["invalid_usage_unit"]);
    expect(usage.categories.input.count).toBeNull();
  });

  test("ignores inherited counters and never executes counter getters", () => {
    let reads = 0;
    const inherited = Object.create({ "gen_ai.usage.output_tokens": 10 }) as Record<string, unknown>;
    Object.defineProperty(inherited, "gen_ai.usage.input_tokens", { get() { reads++; return 20; } });
    const usage = normalizeUsage(inherited);
    expect(reads).toBe(0);
    expect(usage.categories.input.state).toBe("invalid");
    expect(usage.categories.output.state).toBe("missing");
  });

  test("freezes copied count and relationship metadata against later caller edits", () => {
    const attributes = { "gen_ai.usage.input_tokens": 12 };
    const usage = normalizeUsage(attributes);
    attributes["gen_ai.usage.input_tokens"] = 999;
    expect(usage.categories.input.count).toBe(12);
    expect(Object.isFrozen(usage)).toBe(true);
    expect(Object.isFrozen(usage.categories.input)).toBe(true);
    expect(Object.isFrozen(usage.categories.input.attributes)).toBe(true);
    expect(Object.isFrozen(usage.inclusion)).toBe(true);
  });
});
