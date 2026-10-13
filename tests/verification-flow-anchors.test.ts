import { describe, expect, test } from "bun:test";
import { parseFlowSteps } from "../src/verification/validation";
import { decodeFlowDocument, parseFlowAnchor, anchorForCandidate, resolveFlowAnchor, parseFlowDiscovery } from "../src/verification/flow-anchors";
const source = { source: "sdk-reported", framework: "react", status: "captured", mechanism: "dev-stamp", scope: "control", file: "src/Checkout.tsx", line: 12 } as const;
const item = { ref: "rpref_" + "1".repeat(32), tag: "button", role: "button", name: "Payer 日本語", label: "", testId: "checkout-42", depth: 1, disabled: false, readonly: false, controlSource: source };
const coverage = { scope: "visible-observable-dom", complete: true, visitedNodes: 3, openShadowRoots: 0, sameOriginFrames: 0, inaccessibleFrames: 0, closedShadowRoots: "unobservable", hiddenSubtrees: 0, privateSubtrees: 0, truncated: false, reasons: [], unread: [] } as const;
const snapshot = () => ({ source: "sdk-reported", nameModel: "partial-aria", documentGeneration: "2".repeat(32), count: 1, countExact: true, elements: [item], coverage });
const step = { command: { type: "click", selector: 'button[data-key="original"]' }, predicate: { kind: "signal", name: "finished" } };
describe("durable flow metadata never grants live authority", () => {
  test("CSS migration preserves exact selector and predicate and does not modify input bytes", () => {
    const bytes = JSON.stringify([step]); const decoded = decodeFlowDocument(JSON.parse(bytes));
    expect(decoded.version).toBe(2); expect(decoded.steps[0]).toEqual({ ...step, anchor: { kind: "css", selector: step.command.selector } });
    expect(JSON.stringify([step])).toBe(bytes); expect(decodeFlowDocument(decoded)).toEqual(decoded);
  });
  test("semantic instance survives Unicode while live refs never persist", () => {
    const anchor = anchorForCandidate(item); expect(JSON.stringify(anchor)).not.toContain("rpref_");
    expect(parseFlowAnchor(anchor)).toEqual(anchor); expect(resolveFlowAnchor(anchor, parseFlowDiscovery(snapshot())).ref).toBe(item.ref);
    expect(parseFlowSteps([{ ...step, anchor }])[0].anchor).toEqual(anchor);
  });
  test("duplicate identity, incomplete scope, changed source or instance produce no selectable ref", () => {
    const anchor = anchorForCandidate(item);
    for (const data of [ { ...snapshot(), count: 2, elements: [item, { ...item, ref: "rpref_" + "3".repeat(32) }] }, { ...snapshot(), countExact: false, coverage: { ...coverage, complete: false, truncated: true } }, { ...snapshot(), elements: [{ ...item, controlSource: { ...source, file: "src/Other.tsx" } }] }, { ...snapshot(), elements: [{ ...item, testId: "checkout-43" }] } ]) {
      expect(resolveFlowAnchor(anchor, parseFlowDiscovery(data)).ref).toBeUndefined();
    }
  });
  test("closed anchors reject refs, ordinals, secrets and unbounded source locations", () => {
    const anchor = anchorForCandidate(item);
    for (const invalid of [{ ...anchor, ref: item.ref }, { ...anchor, ordinal: 2 }, { ...anchor, instance: { ...anchor.instance, name: 'Bearer sk-secret-should-not-save' } }, { ...anchor, source: { ...source, line: Infinity } }]) expect(() => parseFlowAnchor(invalid)).toThrow();
    expect(() => parseFlowSteps([{ ...step, command: { type: "fill", selector: "#name", value: "entered" }, anchor }])).toThrow();
  });
  test("strict snapshot rejects malformed candidate, unread coverage and byte/node overflow", () => {
    for (const invalid of [{ ...snapshot(), count: NaN }, { ...snapshot(), elements: [{ ...item, extra: true }] }, { ...snapshot(), coverage: { ...coverage, visitedNodes: 10001 } }, { ...snapshot(), elements: [{ ...item, name: "x".repeat(241) }] }, { ...snapshot(), coverage: { ...coverage, unread: [{ tag: "iframe", reason: "x".repeat(129) }] } }]) expect(() => parseFlowDiscovery(invalid)).toThrow();
  });
});
