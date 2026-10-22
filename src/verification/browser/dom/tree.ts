import { collectSemanticElements } from "./query";
import { SNAPSHOT_LIMITS, sanitizeSemanticTree, treeFitsTransport, treeIncomplete, type SemanticTreeResult, type TreeParent } from "../../snapshot-contract";

/** Captures projected semantic ancestry from traversal bookkeeping, never depth or live refs. */
export function snapshotSemanticTree(document: Document, documentGeneration: string, sanitize: (text: string) => { value: unknown; truncated: boolean }): { result: SemanticTreeResult; truncated?: boolean } {
  const collection = collectSemanticElements(document, true);
  const tree: SemanticTreeResult = { formatVersion: 1, source: "sdk-reported", nameModel: "partial-aria", documentGeneration, availability: collection.coverage.complete ? "complete" : "partial", nodes: [], regions: [{ kind: "document", parentRegion: null, hostIndex: null }], coverage: collection.coverage };
  tree.coverage.unread = tree.coverage.unread.map(entry => {
    const safe = sanitize(entry.tag); const value = typeof safe.value === "string" ? safe.value : "";
    const tag = value.slice(0, SNAPSHOT_LIMITS.text).replace(/[\uD800-\uDBFF]$/u, "");
    if (safe.truncated || tag !== entry.tag) treeIncomplete(tree, "summary-truncated-or-redacted");
    return { ...entry, tag };
  });
  const metadata = collection.tree!;
  const retained = new Map<Element, number>(); const regionIds = new Map<number, number>([[0, 0]]);
  for (const entry of collection.elements) {
    if (tree.nodes.length >= SNAPSHOT_LIMITS.nodes) { treeIncomplete(tree, "tree-node-limit"); break; }
    const regionIndex = entry.tree!.region;
    let region = regionIds.get(regionIndex);
    if (region === undefined) {
      const source = metadata.regions[regionIndex]; const parentRegion = regionIds.get(source.parentRegion!);
      const hostIndex = source.host ? retained.get(source.host) : undefined;
      if (parentRegion === undefined || hostIndex === undefined) { treeIncomplete(tree, "parentage-unavailable"); continue; }
      region = tree.regions.length;
      tree.regions.push({ kind: source.kind as "open-shadow" | "same-origin-frame", parentRegion, hostIndex, parentage: "known" }); regionIds.set(regionIndex, region);
    }
    let parent: TreeParent = { kind: "root" };
    let ancestor = metadata.ancestry.get(entry.element)?.parent ?? null; let depth = 0;
    while (ancestor) {
      if (++depth > SNAPSHOT_LIMITS.depth) { parent = { kind: "unavailable", reason: "ancestor-not-retained" }; break; }
      const info = metadata.ancestry.get(ancestor);
      if (!info || info.region !== regionIndex) { parent = { kind: "unavailable", reason: "boundary-unavailable" }; break; }
      const index = retained.get(ancestor);
      if (index !== undefined) { parent = { kind: "node", index }; break; }
      ancestor = info.parent;
    }
    if (parent.kind === "unavailable") treeIncomplete(tree, "parentage-unavailable");
    let partial = entry.nameTruncated;
    const text = (value: string): string => {
      const safe = sanitize(value); const result = typeof safe.value === "string" ? safe.value : "";
      const clipped = result.slice(0, SNAPSHOT_LIMITS.text).replace(/[\uD800-\uDBFF]$/u, "");
      partial ||= safe.truncated || clipped !== value; return clipped;
    };
    const node = { kind: entry.tree!.boundaryHost ? "boundary-host" as const : "semantic" as const, region, parent, tag: text(entry.element.localName), role: text(entry.role), name: text(entry.name), label: text(entry.label), testId: text(entry.testId), disabled: entry.disabled, readonly: entry.readonly };
    if (partial) treeIncomplete(tree, "summary-truncated-or-redacted");
    tree.nodes.push({ ...node, ...(partial ? { partial: true as const } : {}) });
    if (!treeFitsTransport(tree)) {
      tree.nodes.pop(); treeIncomplete(tree, "transport-budget-limit");
      if (!tree.nodes.some(node => node.region === region) && region !== 0) { tree.regions.pop(); regionIds.delete(regionIndex); }
      break;
    }
    retained.set(entry.element, tree.nodes.length - 1);
  }
  // An observed empty region still describes a real boundary. Include it only
  // when its host and parent region were retained; inaccessible roots never enter
  // traversal metadata and cannot become invented empty child regions here.
  for (let index = 1; index < metadata.regions.length; index++) {
    if (regionIds.has(index)) continue;
    const source = metadata.regions[index]; const parentRegion = regionIds.get(source.parentRegion!); const hostIndex = source.host ? retained.get(source.host) : undefined;
    if (parentRegion === undefined || hostIndex === undefined) { treeIncomplete(tree, "parentage-unavailable"); continue; }
    const region = tree.regions.length; tree.regions.push({ kind: source.kind as "open-shadow" | "same-origin-frame", parentRegion, hostIndex, parentage: "known" });
    if (!treeFitsTransport(tree)) { tree.regions.pop(); treeIncomplete(tree, "transport-budget-limit"); break; }
    regionIds.set(index, region);
  }
  const result = sanitizeSemanticTree(tree, sanitize);
  return { result, ...(result.availability === "partial" ? { truncated: true } : {}) };
}
