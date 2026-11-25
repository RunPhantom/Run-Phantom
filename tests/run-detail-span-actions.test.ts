import { afterEach, describe, expect, test } from "bun:test";
import { listSpanActions, registerSpanAction, type SpanAction } from "../app/src/components/run-detail/span-actions";

const disposers: (() => void)[] = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); });

function add(action: SpanAction) {
  disposers.push(registerSpanAction(action));
}

describe("span action registry", () => {
  test("actions sort by order then id, and re-registering an id replaces it", () => {
    add({ id: "b", label: "B", run: () => {} });
    add({ id: "a", label: "A", order: 200, run: () => {} });
    add({ id: "c", label: "C", order: 10, run: () => {} });
    add({ id: "b", label: "B2", run: () => {} });
    expect(listSpanActions().map(action => action.label)).toEqual(["C", "B2", "A"]);
  });

  test("disposing a replaced registration leaves the replacement in place", () => {
    const first = registerSpanAction({ id: "x", label: "first", run: () => {} });
    add({ id: "x", label: "second", run: () => {} });
    first();
    expect(listSpanActions().map(action => action.label)).toEqual(["second"]);
  });
});
