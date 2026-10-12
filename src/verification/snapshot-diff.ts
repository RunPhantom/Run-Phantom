import { createHash } from "node:crypto";
import { normalizeSemanticText } from "./protocol";
import { jsonBytes, parseSemanticTree, SNAPSHOT_LIMITS, type SemanticTreeResult, type TreeNode, type SnapshotDiffResult } from "./snapshot-contract";

const DIFF_LIMITS = { work: 50_000, cells: 10_000, rows: 200, bytes: 32 * 1024 } as const;
function hash(domain: string, value: unknown): string { return createHash("sha256").update(`${domain}\0${JSON.stringify(value)}`).digest("hex"); }
function content(node: TreeNode): unknown[] { return [node.kind, node.tag, node.role, normalizeSemanticText(node.name), normalizeSemanticText(node.label), normalizeSemanticText(node.testId), node.disabled, node.readonly, !!node.partial]; }
export function nodeContentId(node: TreeNode): string { return hash("runphantom-semantic-node/v1", content(node)); }
export function snapshotDigests(value: unknown): { contentDigest: string; coverageDigest: string } {
  const tree = parseSemanticTree(value);
  const regionIds = new Map<number, number>();
  const regions: unknown[] = [];
  const regionId = (index: number): number => {
    const prior = regionIds.get(index); if (prior !== undefined) return prior;
    const region = tree.regions[index];
    const parent = region.kind === "document" ? null : regionId(region.parentRegion);
    const id = regionIds.size; regionIds.set(index, id);
    regions.push(region.kind === "document" ? [region.kind] : [region.kind, parent, region.hostIndex, region.parentage]);
    return id;
  };
  regionId(0);
  const nodes = tree.nodes.map(node => [content(node), regionId(node.region), node.parent]);
  // Empty observed regions still describe topology and must not vanish from identity.
  for (let i = 0; i < tree.regions.length; i++) regionId(i);
  return { contentDigest: hash("runphantom-semantic-tree/v1", [nodes, regions]), coverageDigest: hash("runphantom-semantic-coverage/v1", [tree.availability, tree.coverage]) };
}
class WorkCap extends Error {}
/** Counts compare represented content as a multiset; the bounded LCS is display only. */
export function diffSnapshots(beforeValue: unknown, afterValue: unknown, beforeId = "", afterId = ""): SnapshotDiffResult {
  const before = parseSemanticTree(beforeValue); const after = parseSemanticTree(afterValue);
  let work = 0;
  const charge = (units = 1): void => { if (work + units > DIFF_LIMITS.work) throw new WorkCap(); work += units; };
  const result: SnapshotDiffResult = { algorithmVersion: 1, beforeId, afterId, availability: "unavailable", change: "unavailable", counts: { additions: null, removals: null, matched: null, incomparableBefore: null, incomparableAfter: null, exact: false }, orderChanged: null, rows: [], limits: { workUnits: 0, workCapped: false, outputCapped: false, omittedRows: null }, reasons: [] };
  const finish = (): SnapshotDiffResult => {
    result.limits.workUnits = work;
    if (jsonBytes(result) > DIFF_LIMITS.bytes) throw new Error("Snapshot diff metadata exceeds its output budget");
    return result;
  };
  const keys = (tree: SemanticTreeResult): Array<{ key: string; index: number }> => {
    const ids = tree.nodes.map(node => { charge(10 + [node.tag, node.role, node.name, node.label, node.testId].reduce((sum, text) => sum + text.length, 0)); return nodeContentId(node); });
    const ancestor = (index: number): string[] | null => {
      const path: string[] = []; let depth = 0;
      for (;;) {
        charge(); if (depth++ > SNAPSHOT_LIMITS.depth) return null;
        const node = tree.nodes[index];
        if (node.partial || node.parent.kind === "unavailable") return null;
        if (node.parent.kind === "node") { path.push(ids[node.parent.index]); index = node.parent.index; continue; }
        const region = tree.regions[node.region];
        if (region.kind === "document") { charge(path.length); return path.reverse(); }
        if (region.parentage !== "known" || region.hostIndex === null) return null;
        path.push(region.kind, ids[region.hostIndex]); index = region.hostIndex;
      }
    };
    const regionOwners = new Map<string, number>(); const regionKeys = new Map<number, string>();
    for (let i = 1; i < tree.regions.length; i++) {
      charge(); const region = tree.regions[i];
      if (region.kind === "document" || region.hostIndex === null || region.parentage !== "known") continue;
      const prefix = ancestor(region.hostIndex); if (!prefix) continue;
      charge(prefix.length + 2); const key = JSON.stringify([...prefix, ids[region.hostIndex], region.kind]);
      regionKeys.set(i, key); regionOwners.set(key, (regionOwners.get(key) ?? 0) + 1);
    }
    const out: Array<{ key: string; index: number }> = [];
    for (let index = 0; index < tree.nodes.length; index++) {
      charge(); const node = tree.nodes[index]; const prefix = ancestor(index);
      if (!prefix) continue;
      let regionIndex = node.region; let ambiguous = false;
      while (regionIndex) {
        charge(); const key = regionKeys.get(regionIndex); const region = tree.regions[regionIndex];
        if (!key || regionOwners.get(key) !== 1 || region.kind === "document") { ambiguous = true; break; }
        regionIndex = region.parentRegion;
      }
      if (!ambiguous) { charge(prefix.length + 1); out.push({ key: hash("runphantom-semantic-scoped/v1", [prefix, ids[index]]), index }); }
    }
    return out;
  };
  try {
    const a = keys(before); const b = keys(after);
    const counts = (values: typeof a): Map<string, number> => { const out = new Map<string, number>(); for (const item of values) { charge(); out.set(item.key, (out.get(item.key) ?? 0) + 1); } return out; };
    const ac = counts(a); const bc = counts(b); let matched = 0;
    for (const [key, count] of ac) { charge(); matched += Math.min(count, bc.get(key) ?? 0); }
    const partial = before.availability !== "complete" || after.availability !== "complete" || a.length !== before.nodes.length || b.length !== after.nodes.length;
    result.counts = { additions: b.length - matched, removals: a.length - matched, matched, incomparableBefore: before.nodes.length - a.length, incomparableAfter: after.nodes.length - b.length, exact: !partial };
    result.availability = partial ? "partial" : "complete";
    if (partial) result.reasons.push("Captured scope or ancestry is partial; counts describe comparable represented content only");
    if (partial && !a.length && !b.length) {
      result.availability = "unavailable";
      result.counts.additions = null; result.counts.removals = null; result.counts.matched = null;
      result.reasons.push("No comparable observations were retained; absence or unchanged content cannot be established");
      return finish();
    }
    result.orderChanged = a.length !== b.length || a.some((item, index) => { charge(); return item.key !== b[index]?.key; });
    result.change = result.counts.additions || result.counts.removals || result.orderChanged ? "observed-changes" : "no-observed-changes";
    if (a.length * b.length > DIFF_LIMITS.cells) throw new WorkCap();
    const columns = b.length + 1; charge((a.length + 1) * columns);
    const lcs = new Uint16Array((a.length + 1) * columns);
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
      charge(); lcs[i * columns + j] = a[i].key === b[j].key ? 1 + lcs[(i + 1) * columns + j + 1] : Math.max(lcs[(i + 1) * columns + j], lcs[i * columns + j + 1]);
    }
    const display = (node: TreeNode): string => `${node.kind === "boundary-host" ? "Boundary " : ""}${node.role || node.tag}${node.name ? `: ${node.name}` : ""}${node.testId ? ` [${node.testId}]` : ""}`;
    let i = 0; let j = 0; const rows: SnapshotDiffResult["rows"] = [];
    while (i < a.length || j < b.length) {
      charge();
      if (i < a.length && j < b.length && a[i].key === b[j].key) { rows.push({ kind: "equal", beforeIndex: a[i].index, afterIndex: b[j].index, text: display(after.nodes[b[j].index]) }); i++; j++; }
      // Deterministic ties remove before inserting; this never determines multiset counts.
      else if (i < a.length && (j === b.length || lcs[(i + 1) * columns + j] >= lcs[i * columns + j + 1])) { rows.push({ kind: "delete", beforeIndex: a[i].index, text: display(before.nodes[a[i].index]) }); i++; }
      else { rows.push({ kind: "insert", afterIndex: b[j].index, text: display(after.nodes[b[j].index]) }); j++; }
    }
    result.limits.workUnits = work;
    result.rows = rows.slice(0, DIFF_LIMITS.rows); result.limits.omittedRows = rows.length - result.rows.length;
    while (jsonBytes(result) > DIFF_LIMITS.bytes && result.rows.length) { result.rows.pop(); result.limits.omittedRows++; result.limits.outputCapped = true; }
    if (result.limits.omittedRows) { result.limits.outputCapped = true; result.availability = "partial"; result.reasons.push("Ordered display rows exceeded their output budget"); }
    while (jsonBytes(result) > DIFF_LIMITS.bytes && result.rows.length) { result.rows.pop(); result.limits.omittedRows!++; }
  } catch (error) {
    if (!(error instanceof WorkCap)) throw error;
    result.availability = "unavailable"; result.change = "unavailable"; result.counts.exact = false; result.orderChanged = null; result.rows = []; result.limits.workCapped = true; result.reasons.push("Comparison work budget exhausted");
  }
  return finish();
}
