import { describe, expect, test } from "bun:test";
import { mergeRunRows } from "../app/src/api/run-list-merge";
import type { Run } from "../app/src/utils/types";

const run = (id: string, last_updated_at: number): Run => ({ id, last_updated_at, started_at: 0 } as Run);

describe("live run-list merge", () => {
  test("changed rows replace their old copies and move to their new position", () => {
    const list = [run("c", 30), run("b", 20), run("a", 10)];
    const merged = mergeRunRows(list, ["a"], new Map([["a", run("a", 40)]]));
    expect(merged.map(item => [item.id, item.last_updated_at])).toEqual([["a", 40], ["c", 30], ["b", 20]]);
  });

  test("new runs join, deleted runs leave, and untouched rows keep their identity", () => {
    const list = [run("c", 30), run("b", 20), run("a", 10)];
    const merged = mergeRunRows(list, ["d", "b"], new Map([["d", run("d", 25)]]));
    expect(merged.map(item => item.id)).toEqual(["c", "d", "a"]);
    expect(merged[0]).toBe(list[0]);
  });

  test("ties order by id descending, as GET /api/runs does, and the list stays within the cap", () => {
    const merged = mergeRunRows([run("a", 5), run("c", 5)], ["b"], new Map([["b", run("b", 5)]]), 2);
    expect(merged.map(item => item.id)).toEqual(["c", "b"]);
  });
});
