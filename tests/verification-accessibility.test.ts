import { describe, expect, test } from "bun:test";
import { normalizeAccessibility, parseAccessibilityRequest, parseAccessibilityEvidence } from "../src/verification/accessibility";

const rules = ["button-name", "image-alt", "label", "color-contrast"];
const request = { generation: 3, rules, regions: ["#audit"] };
const identity = { sessionId: "a".repeat(32), generation: 3, capturedAt: 1000 };
const node = (target = "#control") => ({ impact: "serious", target: [target] });
const valid = (change: Record<string, unknown> = {}) => ({
  region: "#audit", rootCoverage: "complete", rootLoss: [],
  result: { testEngine: { name: "axe-core", version: "4.11.0" },
    passes: rules.map(id => ({ id, nodes: [node()] })), violations: [], incomplete: [], inapplicable: [], ...change },
});
const evidence = (results: unknown = [valid()], secrets: readonly string[] = []) => normalizeAccessibility(request, identity, results, secrets);

describe("explicit accessibility request boundary", () => {
  test("preserves the exact generation, finite rules and explicit regions", () => {
    expect(parseAccessibilityRequest(request)).toEqual(request);
  });
  test("refuses missing/default, duplicate, unbounded and executable scope", () => {
    for (const value of [{}, { ...request, generation: -1 }, { ...request, rules: [] }, { ...request, rules: ["all"] },
      { ...request, rules: ["label", "label"] }, { ...request, regions: [] }, { ...request, regions: ["#audit", "#audit"] },
      { ...request, regions: Array(5).fill("body") }, { ...request, regions: ["a".repeat(257)] },
      { ...request, regions: ["iframe >> button"] }, { ...request, regions: ["https://example.com"] },
      { ...request, regions: ["data:text/html,example"] }, { ...request, regions: ["javascript:example"] }, { ...request, html: "<script>throw 1</script>" },
      { ...request, regions: ["<button>"] },
      { ...request, url: "https://example.com" }, { ...request, timeout: 60000 }]) expect(() => parseAccessibilityRequest(value)).toThrow();
  });
  test("never executes accessor or custom array data", () => {
    let reads = 0;
    const value = { generation: 3, rules, get regions() { reads++; return ["body"]; } };
    expect(() => parseAccessibilityRequest(value)).toThrow();
    const regions = ["body"]; Object.defineProperty(regions, "0", { get() { reads++; return "body"; } });
    expect(() => parseAccessibilityRequest({ ...request, regions })).toThrow(); expect(reads).toBe(0);
  });
  test("current identity and secret scope are validated before any audit", () => {
    expect(() => parseAccessibilityRequest({ ...request, regions: ['[data-text="entered-secret"]'] }, ["entered-secret"])).toThrow();
    expect(() => normalizeAccessibility(request, { ...identity, generation: 4 }, [valid()])).toThrow("generation changed");
  });
});

describe("accessibility engine source and coverage", () => {
  test("only complete applicable current engine coverage permits scoped no-findings", () => {
    const result = evidence();
    expect(result.status).toBe("no-findings"); expect(result.coverage).toBe("complete");
    expect(result.source).toBe("host-run-native-engine"); expect(result.engine.name).toBe("axe-core");
    expect(result.engine.version).toBe("4.11.0"); expect(result.sessionId).toBe(identity.sessionId);
    expect(result.generation).toBe(3); expect(result.selectedRegions).toEqual(["#audit"]);
    expect(result.requestedRules).toEqual(rules); expect(result.population).toEqual({ total: 0, retained: 0, dropped: 0 });
    expect(result.regions[0].rules).toHaveLength(4);
  });
  test("missing or failed engine never becomes an empty clean result", () => {
    for (const results of [undefined, null, [], [{ region: "#audit", rootCoverage: "complete", rootLoss: [], result: undefined }]]) {
      const result = normalizeAccessibility(request, identity, results); expect(result.status).toBe("inconclusive"); expect(result.coverage).toBe("unavailable");
      expect(result.population.total).toBeNull(); expect(result.loss).toContain("engine-unavailable");
    }
  });
  test("wrong version or engine identity cannot bless findings or absence", () => {
    for (const testEngine of [{ name: "axe-core", version: "4.10.0" }, { name: "page-supplied", version: "4.11.0" }]) {
      const result = evidence([valid({ testEngine })]); expect(result.status).toBe("inconclusive"); expect(result.coverage).toBe("unavailable");
      expect(result.loss).toContain("engine-identity");
    }
  });
  test("an all-inapplicable population has no absence verdict", () => {
    const result = evidence([valid({ passes: [], inapplicable: rules.map(id => ({ id, nodes: [] })) })]);
    expect(result.status).toBe("inconclusive"); expect(result.loss).toContain("no-applicable-nodes");
  });
  test("missing rules and incomplete review items disclose partial coverage", () => {
    for (const result of [evidence([valid({ passes: [{ id: "label", nodes: [node()] }] })]),
      evidence([valid({ passes: rules.slice(1).map(id => ({ id, nodes: [node()] })), incomplete: [{ id: "button-name", nodes: [node()] }] })])]) {
      expect(result.status).toBe("inconclusive"); expect(result.coverage).toBe("partial");
    }
  });
  test("closed roots, frames and unknown native inventory never produce clean", () => {
    for (const reason of ["closed-shadow-root", "iframe-excluded", "root-inventory-limit", "root-inventory-unavailable"]) {
      const result = evidence([{ ...valid(), rootCoverage: "partial", rootLoss: [reason] }]);
      expect(result.status).toBe("inconclusive"); expect(result.coverage).toBe("partial"); expect(result.loss).toContain(reason);
    }
  });
  test("retains full finding population and rule/region attribution without semantic dedup", () => {
    const result = evidence([valid({ violations: [{ id: "label", nodes: [node("#a"), node("#b")] }],
      passes: rules.map(id => ({ id, nodes: [node()] })) })]);
    expect(result.status).toBe("findings"); expect(result.coverage).toBe("complete");
    expect(result.population).toEqual({ total: 2, retained: 2, dropped: 0 });
    expect(result.findings.map((item: any) => [item.rule, item.region, item.target])).toEqual([["label", "#audit", ["#a"]], ["label", "#audit", ["#b"]]]);
    expect(result.regions[0].rules.find((item: any) => item.rule === "label")).toMatchObject({ passed: 1, violations: 2 });
  });
  test("finding caps disclose omitted population and never silently bless absence", () => {
    const result = evidence([valid({ violations: [{ id: "label", nodes: Array.from({ length: 101 }, (_, i) => node(`#n${i}`)) }] })]);
    expect(result.status).toBe("findings"); expect(result.coverage).toBe("partial");
    expect(result.population).toEqual({ total: 101, retained: 100, dropped: 1 }); expect(result.loss).toContain("finding-limit");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(65536);
  });
  test("omits HTML, raw check messages, URLs and known entered secret selectors", () => {
    const secret = "entered-private-value";
    const result = evidence([valid({ violations: [{ id: "label", helpUrl: "https://secret.example.com", nodes: [{ ...node(`[data-text="${secret}"]`), html: `<input value="${secret}">`, any: [{ message: secret, data: secret }] }] }] })], [secret]);
    const output = JSON.stringify(result); expect(output).not.toContain(secret); expect(output).not.toContain("<input");
    expect(output).not.toContain("secret.example"); expect(output).not.toContain('"html"');
    expect(result.coverage).toBe("partial"); expect(result.loss).toContain("target-redacted");
  });
  test("does not read hostile engine getters and degrades malformed result arrays", () => {
    let reads = 0;
    const hostile = valid(); Object.defineProperty(hostile.result, "violations", { get() { reads++; throw new Error("private body"); } });
    const result = evidence([hostile]);
    expect(result.status).toBe("inconclusive"); expect(reads).toBe(0); expect(result.loss).toContain("engine-result-invalid");
  });
  test("separate selected regions must each contribute an actual matched engine result", () => {
    const result = normalizeAccessibility({ ...request, regions: ["#audit", "#other"] }, identity, [valid()]);
    expect(result.status).toBe("inconclusive"); expect(result.coverage).toBe("partial");
    expect(result.regions).toHaveLength(2); expect(result.loss).toContain("region-unavailable");
  });
  test("host admission independently binds exact source, current scope and actual population", () => {
    const result = evidence(); expect(parseAccessibilityEvidence(result, request, identity)).toEqual(result);
    const bad = evidence([valid({ violations: [{ id: "label", nodes: [node()] }] })]);
    expect(parseAccessibilityEvidence(bad, request, identity)).toEqual(bad);
    for (const change of [{ sessionId: "b".repeat(32) }, { generation: 4 }, { requestedRules: ["label"] }, { status: "findings" },
      { engine: { ...result.engine, bundleSha256: "0".repeat(64) } }, { population: { total: 0, retained: 0, dropped: 1 } }, { html: "private" }])
      expect(() => parseAccessibilityEvidence({ ...result, ...change }, request, identity)).toThrow();
    const partial = evidence([{ ...valid(), rootCoverage: "partial", rootLoss: ["closed-shadow-root"] }]);
    expect(parseAccessibilityEvidence(partial, request, identity)).toEqual(partial);
    expect(() => parseAccessibilityEvidence({ ...partial, coverage: "complete", status: "no-findings" }, request, identity)).toThrow();
  });
});
