import { describe, expect, test } from "bun:test";
import { buildCondensedTimeline, MAX_TIMELINE_SPANS, MAX_TIMELINE_MEMBERSHIPS, MAX_TIMELINE_WINDOW_MS } from "../app/src/utils/condensed-timeline";
import type { Span } from "../app/src/utils/types";

function span(id: string, start = 0, end = 1, parent: string | null = null): Span {
  return { id, name: "same-name", run_id: "layout-fixture", parent_span_id: parent, span_type: "TOOL_CALL", status: "OK", start_time_ms: start, end_time_ms: end, duration_ms: end - start, model: null, provider: null, input_payload: "same prompt", output_payload: id, input_tokens: null, output_tokens: null, attributes: null };
}
function finite(layout: ReturnType<typeof buildCondensedTimeline>) {
  expect(Number.isFinite(layout.startMs)).toBe(true);
  expect(Number.isFinite(layout.windowMs)).toBe(true);
  expect(layout.entries.every(entry => [entry.left, entry.width, entry.row, entry.depth].every(Number.isFinite)
    && entry.left >= 0 && entry.left + entry.width <= 100
    && (entry.parentIndex === null || entry.row > layout.entries[entry.parentIndex].row))).toBe(true);
}

describe("bounded compact timeline", () => {
  test("100 adjacent distinct siblings pack below their real parent without dropping IDs", () => {
    const spans = [span("root", 0, 102), ...Array.from({ length: 100 }, (_, i) => span(`tool-${i}`, i + 1, i + 2, "root"))];
    const before = JSON.stringify(spans), layout = buildCondensedTimeline(spans);
    expect(layout.entries.map(entry => entry.span.id)).toEqual(spans.map(s => s.id));
    expect(new Set(layout.entries.slice(1).map(entry => entry.row))).toEqual(new Set([1]));
    expect(layout.totalRows).toBe(2); expect(JSON.stringify(spans)).toBe(before); finite(layout);
  });
  test("equal-name concurrent siblings retain different rows and identities", () => {
    const layout = buildCondensedTimeline([span("root", 0, 10), ...Array.from({ length: 8 }, (_, i) => span(`child-${i}`, 1, 9, "root"))]);
    expect(new Set(layout.entries.slice(1).map(entry => entry.row)).size).toBe(8);
    expect(layout.entries.every(entry => entry.identityAvailable)).toBe(true); finite(layout);
  });
  test("orphans, every cycle member, self loops and their real descendants remain explicit", () => {
    const layout = buildCondensedTimeline([span("orphan", 0, 1, "missing"), span("a", 0, 3, "b"), span("b", 0, 3, "a"), span("child", 1, 2, "a"), span("self", 2, 3, "self")]);
    expect(layout.entries).toHaveLength(5); expect(layout.cycleCount).toBe(3); expect(layout.unavailableParentCount).toBe(1);
    expect(layout.entries[3].parentIndex).toBe(1); expect(layout.entries[1].parentIndex).toBeNull(); finite(layout);
  });
  test("duplicate occurrences survive but cannot supply unique parents, actions or invocations", () => {
    const spans = [span("duplicate"), span("duplicate", 2, 3), span("child", 4, 5, "duplicate")];
    const layout = buildCondensedTimeline(spans, [{ root_span_id: "duplicate", name: "Agent", span_ids: ["duplicate", "child"] }]);
    expect(layout.entries).toHaveLength(3); expect(new Set(layout.entries.map(entry => entry.key)).size).toBe(3);
    expect(layout.entries.slice(0, 2).every(entry => !entry.identityAvailable)).toBe(true);
    expect(layout.entries[2].parentState).toBe("ambiguous"); expect(layout.invocations).toEqual([]); finite(layout);
  });
  test("a 10000-deep reversed chain uses finite iterative hierarchy instead of the call stack", () => {
    const spans = Array.from({ length: MAX_TIMELINE_SPANS }, (_, i) => span(`deep-${i}`, 0, 1, i ? `deep-${i - 1}` : null)).reverse();
    const layout = buildCondensedTimeline(spans);
    expect(layout.entries).toHaveLength(MAX_TIMELINE_SPANS); expect(layout.totalRows).toBe(MAX_TIMELINE_SPANS);
    expect(layout.entries[0].depth).toBe(MAX_TIMELINE_SPANS - 1);
    expect(layout.entries[0].row).toBe(MAX_TIMELINE_SPANS - 1); finite(layout);
  });
  test("missing, backwards and subtraction-overflow intervals cannot become measured zero durations", () => {
    const layout = buildCondensedTimeline([span("zero", 0, 0), span("nan", NaN, 1), span("inf", 0, Infinity), span("backwards", 5, 4), span("overflow", -1e308, 1e308)]);
    expect(layout.unavailableTimeCount).toBe(4); expect(layout.entries[0].timingAvailable).toBe(true);
    expect(layout.entries.slice(1).every(entry => !entry.timingAvailable)).toBe(true); expect(layout.elapsedMs).toBe(0); finite(layout);
    const absent = buildCondensedTimeline([span("absent", NaN, NaN)]); expect(absent.elapsedMs).toBeNull(); finite(absent);
  });
  test("finite endpoint population whose total window overflows is capped and disclosed", () => {
    const layout = buildCondensedTimeline([span("early", -1e308, -1e308), span("late", 1e308, 1e308)]);
    expect(layout.windowCapped).toBe(true); expect(layout.elapsedMs).toBeNull(); expect(layout.windowMs).toBe(MAX_TIMELINE_WINDOW_MS); finite(layout);
  });
  test("input over the ceiling discloses omission and refuses unverifiable unique identity", () => {
    const layout = buildCondensedTimeline(Array.from({ length: MAX_TIMELINE_SPANS + 1 }, (_, i) => span(i === MAX_TIMELINE_SPANS ? "s0" : `s${i}`, i, i + 1)));
    expect(layout.omittedCount).toBe(1); expect(layout.entries).toHaveLength(MAX_TIMELINE_SPANS);
    expect(layout.entries.every(entry => !entry.identityAvailable)).toBe(true); expect(layout.groupingUnavailable).toBe(true); finite(layout);
  });
  test("equal prompts and names never join two actual invocation roots or infer a third", () => {
    const spans = [span("main", 0, 20), span("invoke-a", 1, 9, "main"), span("a1", 2, 4, "invoke-a"), span("a2", 5, 8, "invoke-a"), span("invoke-b", 10, 19, "main"), span("b1", 11, 18, "invoke-b"), span("ungrouped", 0, 1)];
    const agents = [{ root_span_id: "invoke-a", name: "same agent", span_ids: ["invoke-a", "a1", "a2"] }, { root_span_id: "invoke-b", name: "same agent", span_ids: ["invoke-b", "b1"] }];
    const layout = buildCondensedTimeline(spans, agents);
    expect(layout.entries.map(entry => entry.invocationRootId)).toEqual([null, "invoke-a", "invoke-a", "invoke-a", "invoke-b", "invoke-b", null]);
    expect(layout.invocations.map(agent => agent.entryKeys.length)).toEqual([3, 2]);
    expect(buildCondensedTimeline(spans).invocations).toEqual([]); finite(layout);
  });
  test("nested explicit membership uses the nearest real root; conflicting orphan claims stay unavailable", () => {
    const spans = [span("outer", 0, 10), span("inner", 1, 9, "outer"), span("child", 2, 8, "inner"), span("orphan", 4, 5, "absent")];
    const layout = buildCondensedTimeline(spans, [{ root_span_id: "outer", name: "agent", span_ids: ["outer", "inner", "child", "orphan"] }, { root_span_id: "inner", name: "agent", span_ids: ["inner", "child", "orphan"] }]);
    expect(layout.entries.map(entry => entry.invocationRootId)).toEqual(["outer", "inner", "inner", null]); expect(layout.unavailableInvocationCount).toBe(1); finite(layout);
  });
  test("absent or duplicate metadata roots and over-budget memberships are not guessed", () => {
    const spans = [span("root"), span("child", 0, 1, "root")];
    const missing = buildCondensedTimeline(spans, [{ root_span_id: "missing", name: "root", span_ids: ["root", "child"] }]);
    expect(missing.invocations).toEqual([]); expect(missing.unavailableInvocationCount).toBe(1);
    const duplicate = buildCondensedTimeline(spans, Array.from({ length: 2 }, () => ({ root_span_id: "root", name: "agent", span_ids: ["root", "child"] })));
    expect(duplicate.invocations).toEqual([]); expect(duplicate.unavailableInvocationCount).toBe(2);
    const capped = buildCondensedTimeline(spans, [{ root_span_id: "root", name: "agent", span_ids: Array(MAX_TIMELINE_MEMBERSHIPS + 1).fill("child") }]);
    expect(capped.groupingUnavailable).toBe(true); expect(capped.invocations).toEqual([]); finite(capped);
  });
  test("zero-length events at the same point retain distinct reachable rows", () => {
    const layout = buildCondensedTimeline([span("a", 0, 0), span("b", 0, 0)]);
    expect(layout.entries[0].row).not.toBe(layout.entries[1].row); finite(layout);
    const empty = buildCondensedTimeline([]); expect(empty.entries).toEqual([]); expect(empty.totalRows).toBe(0); expect(empty.elapsedMs).toBeNull(); finite(empty);
  });
  test("painted minimum widths separate close intervals instead of covering other IDs", () => {
    const spans = [span("root", 0, 1000), span("a", 1, 2, "root"), span("b", 2, 3, "root")];
    // The third argument is the finite minimum interval represented by the UI's 3px bar.
    const layout = buildCondensedTimeline(spans, [], 3);
    expect(layout.entries[1].row).not.toBe(layout.entries[2].row); finite(layout);
  });
  test("capped late points retain separate rows rather than covering other pinned IDs", () => {
    const capped = buildCondensedTimeline([span("first", 0, 1), span("late-a", MAX_TIMELINE_WINDOW_MS + 1, MAX_TIMELINE_WINDOW_MS + 2), span("late-b", MAX_TIMELINE_WINDOW_MS + 3, MAX_TIMELINE_WINDOW_MS + 4)]);
    expect(capped.entries[1].row).not.toBe(capped.entries[2].row); expect(capped.windowCapped).toBe(true); finite(capped);
  });
});
