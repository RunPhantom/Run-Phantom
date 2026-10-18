import { expect, test } from "bun:test";
import { parseBrowserMessage, parseCommand, parsePredicate } from "../src/verification/validation";

const coverage = { network: true, console: true, dom: true, state: true, signal: true, route: true };
const hello = (version: number, capabilities?: string[]) => ({ type: "hello", version, token: "synthetic-performance-token", coverage,
  ...(capabilities === undefined ? {} : { capabilities }) });

test("read-only performance commands admit only explicit begin and capture phases", () => {
  for (const phase of ["begin", "capture"]) expect(parseCommand({ type: "performance", phase })).toEqual({ type: "performance", phase });
  for (const value of [{ type: "performance" }, { type: "performance", phase: "reset" }, { type: "performance", phase: "capture", url: "https://business.invalid" }, { type: "performance", phase: true }]) {
    expect(() => parseCommand(value)).toThrow();
  }
});

test("numeric lab predicates keep a closed metric unit and finite unrounded limit", () => {
  for (const metric of ["clsMaxSessionScore", "longFrameBlockingMaxMs", "resourceCount", "resourceTransferBytes"]) for (const op of ["lte", "gte"]) {
    const value = metric === "clsMaxSessionScore" ? 0.10000001 : 0;
    expect(parsePredicate({ kind: "performance", metric, op, value })).toEqual({ kind: "performance", metric, op, value });
  }
  for (const metric of ["fcpMs", "lcpMs", "navigationTtfbMs", "qualifyingInteractionMaxMs", "INP", "unknown"]) {
    expect(() => parsePredicate({ kind: "performance", metric, op: "lte", value: 100 })).toThrow();
  }
  for (const value of [NaN, Infinity, -1, "1", null]) expect(() => parsePredicate({ kind: "performance", metric: "clsMaxSessionScore", op: "lte", value })).toThrow();
  for (const value of [0.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => parsePredicate({ kind: "performance", metric: "resourceCount", op: "lte", value })).toThrow();
  expect(() => parsePredicate({ kind: "performance", metric: "clsMaxSessionScore", op: "lte", value: 0.1, unit: "ms" })).toThrow();
});

test("performance version6 requires its capability and preserves strict existing version boundaries", () => {
  expect(parseBrowserMessage(hello(6, ["performance-evidence"]))).toEqual(hello(6, ["performance-evidence"]));
  expect(parseBrowserMessage(hello(6, ["causal-readings", "semantic-refs", "control-source", "performance-evidence"]))).toEqual(hello(6, ["causal-readings", "semantic-refs", "control-source", "performance-evidence"]));
  for (const capabilities of [[], ["causal-readings"], ["performance-evidence", "performance-evidence"], ["performance-evidence", "unknown"]]) expect(() => parseBrowserMessage(hello(6, capabilities))).toThrow();
  expect(() => parseBrowserMessage(hello(5, ["performance-evidence"]))).toThrow();
  for (const version of [2, 3, 4]) expect(() => parseBrowserMessage(hello(version, ["performance-evidence"]))).toThrow();
  for (const [version, capabilities] of [[1, undefined], [2, ["causal-readings"]], [3, ["semantic-refs"]], [4, ["control-source"]]] as const) {
    expect(parseBrowserMessage(hello(version, capabilities ? [...capabilities] : undefined))).toEqual(hello(version, capabilities ? [...capabilities] : undefined));
  }
});
