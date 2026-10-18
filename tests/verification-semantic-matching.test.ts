import { expect, test } from "bun:test";
import { normalizeSemanticText } from "../src/verification/protocol";
import { matchesSemanticQuery, type SemanticElement } from "../src/verification/browser/dom/query";

const element = { role: "button", name: "Café — 保存", label: "Café — 保存", testId: "save-保存", nameTruncated: false } as SemanticElement;
test("reported Unicode names round-trip through the same literal normalization", () => {
  expect(normalizeSemanticText("  Cafe\u0301\u00a0—\n保存  ")).toBe(element.name);
  expect(matchesSemanticQuery(element, { kind: "role", role: "button", name: "Cafe\u0301 — 保存" })).toBe(true);
  expect(matchesSemanticQuery(element, { kind: "name", name: element.name })).toBe(true);
  expect(matchesSemanticQuery(element, { kind: "label", label: element.label })).toBe(true);
  expect(matchesSemanticQuery(element, { kind: "test-id", testId: element.testId })).toBe(true);
});
test("exact matching defaults true and opt-in partial strings never become regex", () => {
  expect(matchesSemanticQuery(element, { kind: "name", name: "Café" })).toBe(false);
  expect(matchesSemanticQuery(element, { kind: "name", name: "Café", exact: false })).toBe(true);
  expect(matchesSemanticQuery(element, { kind: "name", name: ".*", exact: false })).toBe(false);
  expect(matchesSemanticQuery(element, { kind: "role", role: "link", name: element.name })).toBe(false);
});
test("partial or omitted names cannot be promoted into a match", () => {
  expect(matchesSemanticQuery({ ...element, nameTruncated: true }, { kind: "name", name: element.name })).toBe(false);
  expect(matchesSemanticQuery({ ...element, nameTruncated: true }, { kind: "label", label: element.label })).toBe(false);
  expect(matchesSemanticQuery({ ...element, label: "" }, { kind: "label", label: "" })).toBe(false);
  expect(() => matchesSemanticQuery(element, { kind: "regex" } as never)).toThrow("Unsupported");
});
