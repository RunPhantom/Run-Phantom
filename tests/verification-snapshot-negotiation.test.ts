import { expect, test } from "bun:test";
import { parseBrowserMessage, parseCommand, parseFlowSteps } from "../src/verification/validation";

test("v5 requires distinct tree negotiation while every older capability contract stays closed", () => {
  const coverage = { network: true, console: true, dom: true, state: true, signal: true, route: true };
  const hello = (version: number, capabilities: string[]) => ({ type: "hello", version, capabilities, token: "local-test-credential", coverage });
  for (const capabilities of [["semantic-tree"], ["semantic-tree", "semantic-refs", "causal-readings", "control-source"]]) expect(parseBrowserMessage(hello(5, capabilities))).toEqual(hello(5, capabilities));
  for (const value of [hello(5, []), hello(5, ["semantic-tree", "semantic-tree"]), hello(5, ["semantic-tree", "unknown"]), hello(4, ["control-source", "semantic-tree"]), hello(3, ["semantic-tree"]), hello(2, ["semantic-tree"])]) expect(() => parseBrowserMessage(value)).toThrow();
  expect(parseCommand({ type: "semantic-tree" })).toEqual({ type: "semantic-tree" });
  expect(() => parseCommand({ type: "semantic-tree", selector: "body" })).toThrow();
  expect(() => parseFlowSteps([{ command: { type: "semantic-tree" }, predicate: { kind: "signal", name: "done" } }])).toThrow(/cannot be saved/);
});
