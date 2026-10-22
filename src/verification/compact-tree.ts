import { parseSemanticTree, type SemanticTreeResult } from "./snapshot-contract";

/** Display projection only: indexes and comparison populations remain untouched. */
export function compactTree(value: SemanticTreeResult, selected?: ReadonlySet<number>): Array<{ index: number; depth: number; boundary: string | null; text: string; partial: boolean }> {
  const tree = parseSemanticTree(value); const retained = new Set<number>();
  const depth: number[] = []; const predecessors: Array<number | null> = [];
  tree.nodes.forEach((node, index) => {
    const region = tree.regions[node.region];
    const parent = node.parent.kind === "node" ? node.parent.index : region.kind !== "document" ? region.hostIndex : null;
    predecessors[index] = parent; depth[index] = parent === null ? 0 : depth[parent] + 1;
  });
  for (let index = tree.nodes.length - 1; index >= 0; index--) {
    if (!selected || selected.has(index) || retained.has(index)) {
      retained.add(index); const parent = predecessors[index]; if (parent !== null) retained.add(parent);
    }
  }
  return tree.nodes.flatMap((node, index) => retained.has(index) ? [{ index, depth: depth[index], boundary: tree.regions[node.region].kind === "document" ? null : tree.regions[node.region].kind, text: `${node.role || node.tag}${node.name ? `: ${node.name}` : ""}`, partial: !!node.partial || node.parent.kind === "unavailable" }] : []);
}
