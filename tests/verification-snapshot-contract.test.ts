import { expect, test } from "bun:test";
import { parseSemanticTree, sanitizeSemanticTree } from "../src/verification/snapshot-contract";
import { snapshotDigests, diffSnapshots } from "../src/verification/snapshot-diff";
import { sanitizeWithReport } from "../src/verification/serialization";
import { tree } from "./fixtures/semantic-tree";

test("closed explicit graphs refuse invented parentage and live authority", () => {
  expect(parseSemanticTree(tree()).nodes).toEqual([]);
  const good = tree(["parent", "child"]); good.nodes[1].parent = { kind: "node", index: 0 };
  expect(parseSemanticTree(good)).toEqual(good);
  for (const bad of [ { ...good, ref: `rpref_${"b".repeat(32)}` }, { ...good, nodes: [{ ...good.nodes[0], parent: { kind: "node", index: 0 } }] },
    { ...good, nodes: [{ ...good.nodes[0], parent: { kind: "node", index: 1 } }, good.nodes[1]] },
    { ...good, nodes: [{ ...good.nodes[0], region: 5 }] }, { ...good, regions: [good.regions[0], { kind: "same-origin-frame", parentRegion: 0, hostIndex: null, parentage: "known" }] } ]) expect(() => parseSemanticTree(bad)).toThrow();
  let reads = 0; const accessor = { ...good, get nodes() { reads++; return []; } };
  expect(() => parseSemanticTree(accessor)).toThrow(); expect(reads).toBe(0);
});

test("content identity excludes connection-local generations but preserves multiplicity and topology", () => {
  const a = tree(["Café 東京", "A", "A"]); const b = { ...a, documentGeneration: "b".repeat(32) };
  expect(snapshotDigests(a).contentDigest).toBe(snapshotDigests(b).contentDigest);
  expect(snapshotDigests(a).contentDigest).not.toBe(snapshotDigests(tree(["Café 東京", "A"])).contentDigest);
  const nested = tree(["Café 東京", "A", "A"]); nested.nodes[1].parent = { kind: "node", index: 0 };
  expect(snapshotDigests(nested).contentDigest).not.toBe(snapshotDigests(a).contentDigest);
  expect(diffSnapshots(a, b).counts).toMatchObject({ additions: 0, removals: 0, matched: 3, exact: true });
});

test("duplicate-aware observed counts do not fabricate identity from positions", () => {
  const result = diffSnapshots(tree(["A", "A", "B"]), tree(["A", "B", "B"]));
  expect(result.counts).toMatchObject({ additions: 1, removals: 1, matched: 2, exact: true });
  const reordered = diffSnapshots(tree(["A", "B"]), tree(["B", "A"]));
  expect(reordered.counts).toMatchObject({ additions: 0, removals: 0, matched: 2 }); expect(reordered.orderChanged).toBe(true);
  expect(diffSnapshots(tree(), tree()).counts).toMatchObject({ additions: 0, removals: 0, matched: 0 });
});

test("known-fill expansion is bounded after privacy without rewriting structural discriminants", () => {
  const raw = tree(["node node node", "document"]);
  const safe = sanitizeSemanticTree(raw, value => ({ value: value.replaceAll("node", "[REDACTED]"), truncated: value.includes("node") }));
  expect(safe.nodes[0].kind).toBe("semantic"); expect(safe.nodes[0].parent.kind).toBe("root"); expect(safe.source).toBe("sdk-reported");
  expect(safe.nodes[0].name).toBe("[REDACTED] [REDACTED] [REDACTED]"); expect(safe.nodes[0].partial).toBe(true); expect(safe.availability).toBe("partial");
  expect(diffSnapshots(safe, safe).counts.matched).toBe(1);
  expect(() => parseSemanticTree({ ...raw, nodes: [{ ...raw.nodes[0], name: "汉".repeat(241) }] })).toThrow();
});

test("sparse/prototype/symbol/surrogate and cross-region graphs cannot become portable observations", () => {
  const raw = tree(["A", "B"]);
  const sparse = Array(2); sparse[1] = raw.nodes[1];
  const inherited = Object.create(raw);
  const bads = [inherited, { ...raw, [Symbol("private")]: true }, { ...raw, nodes: sparse }, { ...raw, nodes: [{ ...raw.nodes[0], name: "\ud800" }] }, { ...raw, nodes: [{ ...raw.nodes[0], name: "a\0b" }] }, { ...raw, nodes: [{ ...raw.nodes[0], partial: true }] }];
  for (const bad of bads) expect(() => parseSemanticTree(bad)).toThrow();
  const boundary = tree(["host", "child"]); boundary.nodes[0].kind = "boundary-host";
  boundary.regions.push({ kind: "open-shadow", parentRegion: 0, hostIndex: 0, parentage: "known" }); boundary.nodes[1].region = 1;
  expect(parseSemanticTree(boundary)).toEqual(boundary);
  boundary.nodes[1].parent = { kind: "node", index: 0 }; expect(() => parseSemanticTree(boundary)).toThrow();
});

test("post-redaction expansion stays typed inside cumulative serializer and UTF-8 budgets", () => {
  const raw = tree(Array(50).fill("a".repeat(40)));
  const output = sanitizeSemanticTree(raw, value => ({ value: value.replaceAll("a", "[REDACTED]"), truncated: value.includes("a") }));
  expect(output.nodes.length).toBeLessThan(raw.nodes.length); expect(output.availability).toBe("partial");
  expect(output.coverage.reasons).toContain("transport-budget-limit");
  expect(output.nodes.every(node => node.name.length <= 240 && node.partial === true)).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(output)).length).toBeLessThanOrEqual(16 * 1024);
  expect(sanitizeWithReport(output).truncation).toBeUndefined(); expect(parseSemanticTree(output)).toEqual(output);
  expect(raw.nodes[0].name).toBe("a".repeat(40));
});
