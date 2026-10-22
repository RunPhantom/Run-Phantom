import { describe, expect, test } from "bun:test";
import { parseBrowserMessage, parseCommand, parseFlowSteps, parseSemanticQuery } from "../src/verification/validation";
const coverage = { network: true, console: true, dom: true, state: true, signal: true, route: true };
const hello = (version: number, capabilities?: unknown) => ({ type: "hello", version, token: "local-unit-credential", coverage, ...(capabilities === undefined ? {} : { capabilities }) });
const ref = `rpref_${"a".repeat(32)}`;
describe("semantic v3 contracts preserve closed legacy negotiation", () => {
  test("v1/v2 remain exact while v3 admits only distinct negotiated capabilities", () => {
    expect(parseBrowserMessage(hello(1))).toEqual(hello(1));
    expect(parseBrowserMessage(hello(2, ["causal-readings"]))).toEqual(hello(2, ["causal-readings"]));
    for (const capabilities of [[], ["semantic-refs"], ["causal-readings"], ["semantic-refs", "causal-readings"]]) expect(parseBrowserMessage(hello(3, capabilities))).toEqual(hello(3, capabilities));
    for (const bad of [hello(1, []), hello(2, ["semantic-refs"]), hello(2, ["causal-readings", "semantic-refs"]), hello(3), hello(3, ["semantic-refs", "semantic-refs"]), hello(3, ["unknown"]), { ...hello(3, []), trusted: true }]) expect(() => parseBrowserMessage(bad)).toThrow();
  });
  test("NFC whitespace normalization and literal matching defaults are explicit", () => {
    expect(parseCommand({ type: "find", query: { kind: "role", role: "BUTTON", name: "  Cafe\u0301\u00a0\n東京 " } })).toEqual({ type: "find", query: { kind: "role", role: "button", name: "Café 東京", exact: true } });
    expect(parseSemanticQuery({ kind: "name", name: ".*", exact: false })).toEqual({ kind: "name", name: ".*", exact: false });
    expect(parseSemanticQuery({ kind: "test-id", testId: "élément" })).toEqual({ kind: "test-id", testId: "élément" });
  });
  test("unknown fields, regex flags, accessors, credentials and oversized strings refuse", () => {
    let reads = 0;
    const getter = { kind: "name", get name() { reads++; return "x"; } };
    for (const query of [getter, { kind: "name", name: "x", regex: true }, { kind: "role", role: "button.*" }, { kind: "test-id", testId: "x", exact: false }, { kind: "label", label: "\ud800" }, { kind: "name", name: "a".repeat(257) }, { kind: "name", name: `sk-proj-${"A".repeat(32)}` }, { kind: "name", name: "x", exact: "yes" }]) expect(() => parseSemanticQuery(query)).toThrow();
    expect(reads).toBe(0);
  });
  test("live references have one opaque grammar and cannot enter saved flows", () => {
    expect(parseCommand({ type: "ref-click", ref })).toEqual({ type: "ref-click", ref });
    expect(parseCommand({ type: "ref-fill", ref, value: "" })).toEqual({ type: "ref-fill", ref, value: "" });
    for (const command of [{ type: "ref-click", ref: "#button" }, { type: "ref-click", ref, selector: "#button" }, { type: "semantic-snapshot", selector: "*" }, { type: "find", query: { kind: "name", name: "x" } }, { type: "semantic-snapshot" }, { type: "ref-click", ref }, { type: "ref-fill", ref, value: "private" }]) {
      if ("selector" in command || command.ref === "#button") expect(() => parseCommand(command)).toThrow();
      else expect(() => parseFlowSteps([{ command, predicate: { kind: "signal", name: "done" } }])).toThrow(/cannot be saved/);
    }
  });
});
