import { describe, expect, test } from "bun:test";
import { buildPredicate, describePredicate, emptyCheck } from "../app/src/components/verification/PredicateEditor";
import { parsePredicate } from "../src/verification/validation";

describe("user-authored transition expectations", () => {
  test("numeric DOM counts preserve zero and cannot silently become text comparisons", () => {
    const predicate = buildPredicate({ ...emptyCheck(), kind: "relative", relativeTarget: "element", selector: "#result",
      relation: "becomes", valueType: "number", value: "0" });
    expect(parsePredicate(predicate)).toEqual({ kind: "relative", target: { kind: "element", selector: "#result" }, relation: "becomes", equals: 0 });
    expect(describePredicate(predicate)).toContain("Matching elements for #result");
    expect(() => buildPredicate({ ...emptyCheck(), kind: "relative", relativeTarget: "element", selector: "#result", relation: "becomes", valueType: "number", value: "" })).toThrow("finite number");
    expect(() => buildPredicate({ ...emptyCheck(), kind: "relative", relativeTarget: "element", selector: "#result", relation: "becomes", valueType: "string", value: "1" })).toThrow("whole number");
  });
  test("relative comparisons need no unused expected value and retain exact state paths", () => {
    const predicate = buildPredicate({ ...emptyCheck(), kind: "relative", store: "cart", path: "items.length",
      relation: "increased", valueType: "json", value: "unfinished" });
    expect(parsePredicate(predicate)).toEqual({ kind: "relative", target: { kind: "state", store: "cart", path: "items.length" }, relation: "increased" });
    expect(describePredicate(predicate)).toContain("cart.items.length increased during the click");
    expect(() => buildPredicate({ ...emptyCheck(), kind: "relative" })).toThrow("Registered store");
  });
  test("switching back to current state ignores hidden relative controls and retains typed equality", () => {
    const current = buildPredicate({ ...emptyCheck(), kind: "state", relativeTarget: "element", selector: "",
      store: "cart", path: "ready", valueType: "boolean", value: "false" });
    expect(parsePredicate(current)).toEqual({ kind: "state", store: "cart", path: "ready", equals: false });
    const expected = buildPredicate({ ...emptyCheck(), kind: "relative", store: "cart", path: "result", relation: "becomes", valueType: "null" });
    expect(parsePredicate(expected)).toMatchObject({ kind: "relative", relation: "becomes", equals: null });
  });
});
