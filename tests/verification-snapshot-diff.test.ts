import { expect, test } from "bun:test";
import { tree } from "./fixtures/semantic-tree";
import { diffSnapshots, snapshotDigests } from "../src/verification/snapshot-diff";
import { compactTree } from "../src/verification/compact-tree";

test("NFC-equivalent content and document replacement preserve represented identity", () => {
  const a = tree(["Café 東京"]); const b = tree(["Cafe\u0301 東京"]); b.documentGeneration = "b".repeat(32);
  expect(snapshotDigests(a).contentDigest).toBe(snapshotDigests(b).contentDigest); expect(diffSnapshots(a, b).change).toBe("no-observed-changes");
  b.coverage.hiddenSubtrees = 1; expect(snapshotDigests(a).coverageDigest).not.toBe(snapshotDigests(b).coverageDigest);
});
test("reparenting changes scoped represented content without claiming a move", () => {
  const a = tree(["A", "B", "child"]); a.nodes[2].parent = { kind: "node", index: 0 };
  const b = structuredClone(a); b.nodes[2].parent = { kind: "node", index: 1 };
  expect(diffSnapshots(a, b).counts).toMatchObject({ matched: 2, additions: 1, removals: 1 });
  expect(compactTree(a, new Set([2])).map(item => item.index)).toEqual([0, 2]);
  expect(snapshotDigests(a).contentDigest).not.toBe(snapshotDigests(b).contentDigest);
});
test("indistinguishable boundary ownership is disclosed instead of fabricated matching", () => {
  const a = tree(["host", "child", "host", "child"]); a.nodes[0].kind = a.nodes[2].kind = "boundary-host";
  a.regions.push({ kind: "open-shadow", parentRegion: 0, hostIndex: 0, parentage: "known" }, { kind: "open-shadow", parentRegion: 0, hostIndex: 2, parentage: "known" }); a.nodes[1].region = 1; a.nodes[3].region = 2;
  const result = diffSnapshots(a, a);
  expect(result.availability).toBe("partial"); expect(result.counts).toMatchObject({ matched: 2, incomparableBefore: 2, incomparableAfter: 2, exact: false });
});
test("bag algebra preserves duplicates over deterministic generated cases", () => {
  for (let n = 0; n < 30; n++) {
    const a = Array.from({ length: n % 9 }, (_, i) => String((i * 7 + n) % 4)); const b = Array.from({ length: n % 11 }, (_, i) => String((i * 3 + n) % 4));
    const ab = diffSnapshots(tree(a), tree(b)); const ba = diffSnapshots(tree(b), tree(a));
    const counts = (values: string[], key: string) => values.filter(value => value === key).length;
    const matched = ["0", "1", "2", "3"].reduce((sum, key) => sum + Math.min(counts(a, key), counts(b, key)), 0);
    expect(ab.counts).toMatchObject({ matched, additions: b.length - matched, removals: a.length - matched, exact: true });
    expect(ba.counts.additions).toBe(ab.counts.removals); expect(ba.counts.removals).toBe(ab.counts.additions);
    expect(diffSnapshots(tree(a), tree(a)).change).toBe("no-observed-changes");
    expect(ab.limits.workUnits).toBeLessThanOrEqual(50_000); expect(ab.rows.length).toBeLessThanOrEqual(200);
  }
});
test("maximum bounded graphs and large UTF-8 rows measure final markers and never fabricate empty success", () => {
  const a = tree(Array.from({ length: 70 }, (_, i) => `before-${i}`)); const b = tree(Array.from({ length: 70 }, (_, i) => `after-${i}`));
  const result = diffSnapshots(a, b); expect(result.counts).toMatchObject({ additions: 70, removals: 70, matched: 0 });
  expect(result.change).toBe("observed-changes"); expect(result.limits.workUnits).toBeLessThanOrEqual(50_000); expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(32 * 1024);
  const unknown = tree(["A"]); unknown.nodes[0].parent = { kind: "unavailable", reason: "ancestor-not-retained" }; unknown.availability = "partial"; unknown.coverage.complete = false;
  expect(diffSnapshots(unknown, unknown).counts).toMatchObject({ incomparableBefore: 1, incomparableAfter: 1, exact: false });
});

test("partial captures with no comparable retained observations cannot establish unchanged content or zero changes", () => {
  const unseen = tree(); unseen.availability = "partial"; unseen.coverage.complete = false; unseen.coverage.truncated = true; unseen.coverage.reasons = ["transport-budget-limit"];
  const result = diffSnapshots(unseen, unseen);
  expect(result.availability).toBe("unavailable"); expect(result.change).toBe("unavailable"); expect(result.counts).toMatchObject({ additions: null, removals: null, matched: null, exact: false });
  expect(diffSnapshots(tree(), tree()).change).toBe("no-observed-changes");
});
