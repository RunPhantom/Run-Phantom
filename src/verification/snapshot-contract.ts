import type { SemanticCoverage } from "./protocol";
import { sanitizeWithReport } from "./serialization";

export const SNAPSHOT_LIMITS = { nodes: 100, regions: 32, text: 240, depth: 64, treeBytes: 16 * 1024, payloadBytes: 32 * 1024, records: 100, transferEntries: 2, transferBytes: 96 * 1024 } as const;
export type TreeParent = { kind: "root" } | { kind: "node"; index: number } | { kind: "unavailable"; reason: "ancestor-not-retained" | "boundary-unavailable" };
export interface TreeNode { kind: "semantic" | "boundary-host"; region: number; parent: TreeParent; tag: string; role: string; name: string; label: string; testId: string; disabled: boolean; readonly: boolean; partial?: true }
export type TreeRegion = { kind: "document"; parentRegion: null; hostIndex: null } | { kind: "open-shadow" | "same-origin-frame"; parentRegion: number; hostIndex: number | null; parentage: "known" | "unavailable" };
export interface SemanticTreeResult { formatVersion: 1; source: "sdk-reported"; nameModel: "partial-aria"; documentGeneration: string; availability: "complete" | "partial"; nodes: TreeNode[]; regions: TreeRegion[]; coverage: SemanticCoverage }
export interface SavedSemanticSnapshot { id: string; runId: string | null; sessionId: string | null; name: string; origin: string; capturedAt: number; storedAt: number; source: "paired-sdk" | "imported-evidence"; connectionGeneration: number | null; tree: SemanticTreeResult; contentDigest: string; coverageDigest: string }
export interface PortableSnapshotEntry { name: string; origin: string; capturedAt: number; tree: SemanticTreeResult; contentDigest: string; coverageDigest: string }
export interface PortableSnapshots { format: "runphantom-semantic-snapshots/v1"; entries: PortableSnapshotEntry[] }
export interface SnapshotDiffResult {
  algorithmVersion: 1; beforeId: string; afterId: string;
  availability: "complete" | "partial" | "unavailable";
  change: "observed-changes" | "no-observed-changes" | "unavailable";
  counts: { additions: number | null; removals: number | null; matched: number | null; incomparableBefore: number | null; incomparableAfter: number | null; exact: boolean };
  orderChanged: boolean | null;
  rows: Array<{ kind: "equal" | "insert" | "delete"; beforeIndex?: number; afterIndex?: number; text: string }>;
  limits: { workUnits: number; workCapped: boolean; outputCapped: boolean; omittedRows: number | null };
  reasons: string[];
}
export class SnapshotInputError extends Error { constructor(message: string, readonly status: 400 | 409 | 413 | 404 = 400) { super(message); } }
const encoder = new TextEncoder();
const coverageReasons = new Set(["node-limit", "depth-limit", "visibility-unavailable", "inaccessible-frame", "role-limit", "name-limit", "tree-node-limit", "tree-region-limit", "tree-byte-limit", "transport-budget-limit", "parentage-unavailable", "summary-truncated-or-redacted"]);
export function jsonBytes(value: unknown): number { return encoder.encode(JSON.stringify(value)).byteLength; }

/** Descriptor-only reads refuse executable getters; proxy descriptor traps can still run and throw. */
export function closedRecord(value: unknown, allowed: string[], required = allowed): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SnapshotInputError("Expected a closed snapshot object");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new SnapshotInputError("Snapshot prototypes are forbidden");
  const out: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) throw new SnapshotInputError("Unknown snapshot field");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) throw new SnapshotInputError("Snapshot accessors are forbidden");
    out[key] = descriptor.value;
  }
  if (required.some(key => !Object.prototype.hasOwnProperty.call(out, key))) throw new SnapshotInputError("Missing snapshot field");
  return out;
}
export function snapshotText(value: unknown, max: number = SNAPSHOT_LIMITS.text): string {
  if (typeof value !== "string" || value.length > max || /\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw new SnapshotInputError("Invalid snapshot text");
  return value;
}
export function snapshotInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw new SnapshotInputError("Invalid snapshot integer");
  return value;
}
function bool(value: unknown): boolean { if (typeof value !== "boolean") throw new SnapshotInputError("Invalid snapshot boolean"); return value; }
export function snapshotArray(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new SnapshotInputError("Expected a snapshot array");
  const length = snapshotInteger(Object.getOwnPropertyDescriptor(value, "length")?.value, max);
  if (Reflect.ownKeys(value).length !== length + 1) throw new SnapshotInputError("Sparse or extended snapshot array");
  const out: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !("value" in descriptor)) throw new SnapshotInputError("Snapshot array accessors are forbidden");
    out.push(descriptor.value);
  }
  return out;
}
function coverage(value: unknown): SemanticCoverage {
  const keys = ["scope", "complete", "visitedNodes", "openShadowRoots", "sameOriginFrames", "inaccessibleFrames", "closedShadowRoots", "hiddenSubtrees", "privateSubtrees", "truncated", "reasons", "unread"];
  const raw = closedRecord(value, [...keys, "unreadOverflow"], keys);
  if (raw.scope !== "visible-observable-dom" || raw.closedShadowRoots !== "unobservable" || raw.unreadOverflow !== undefined && raw.unreadOverflow !== true) throw new SnapshotInputError("Invalid snapshot coverage");
  const reason = (value: unknown): string => { const text = snapshotText(value, 128); if (!coverageReasons.has(text)) throw new SnapshotInputError("Unknown tree coverage reason"); return text; };
  return { scope: "visible-observable-dom", complete: bool(raw.complete), visitedNodes: snapshotInteger(raw.visitedNodes, 10_000), openShadowRoots: snapshotInteger(raw.openShadowRoots, 10_000), sameOriginFrames: snapshotInteger(raw.sameOriginFrames, 10_000), inaccessibleFrames: snapshotInteger(raw.inaccessibleFrames, 10_000), closedShadowRoots: "unobservable", hiddenSubtrees: snapshotInteger(raw.hiddenSubtrees, 10_000), privateSubtrees: snapshotInteger(raw.privateSubtrees, 10_000), truncated: bool(raw.truncated), reasons: snapshotArray(raw.reasons, 16).map(reason), unread: snapshotArray(raw.unread, 16).map(item => { const entry = closedRecord(item, ["tag", "reason"]); return { tag: snapshotText(entry.tag), reason: reason(entry.reason) }; }), ...(raw.unreadOverflow ? { unreadOverflow: true } : {}) };
}
export function parseSemanticTree(value: unknown): SemanticTreeResult {
  const raw = closedRecord(value, ["formatVersion", "source", "nameModel", "documentGeneration", "availability", "nodes", "regions", "coverage"]);
  if (raw.formatVersion !== 1 || raw.source !== "sdk-reported" || raw.nameModel !== "partial-aria" || raw.availability !== "complete" && raw.availability !== "partial") throw new SnapshotInputError("Unsupported semantic tree format");
  const documentGeneration = snapshotText(raw.documentGeneration, 32);
  if (!/^[a-f0-9]{32}$/.test(documentGeneration)) throw new SnapshotInputError("Invalid document generation");
  const nodes = snapshotArray(raw.nodes, SNAPSHOT_LIMITS.nodes).map((value, index): TreeNode => {
    const keys = ["kind", "region", "parent", "tag", "role", "name", "label", "testId", "disabled", "readonly"];
    const node = closedRecord(value, [...keys, "partial"], keys);
    if (node.kind !== "semantic" && node.kind !== "boundary-host" || node.partial !== undefined && node.partial !== true) throw new SnapshotInputError("Invalid tree node");
    const parent = closedRecord(node.parent, ["kind", "index", "reason"], ["kind"]);
    let parsedParent: TreeParent;
    if (parent.kind === "root" && Object.keys(parent).length === 1) parsedParent = { kind: "root" };
    else if (parent.kind === "node" && Object.keys(parent).length === 2 && Object.prototype.hasOwnProperty.call(parent, "index")) {
      const parentIndex = snapshotInteger(parent.index, 99);
      if (parentIndex >= index) throw new SnapshotInputError("Tree parents must precede children");
      parsedParent = { kind: "node", index: parentIndex };
    } else if (parent.kind === "unavailable" && Object.keys(parent).length === 2 && (parent.reason === "ancestor-not-retained" || parent.reason === "boundary-unavailable")) parsedParent = { kind: "unavailable", reason: parent.reason };
    else throw new SnapshotInputError("Invalid tree parent");
    return { kind: node.kind, region: snapshotInteger(node.region, 31), parent: parsedParent, tag: snapshotText(node.tag), role: snapshotText(node.role), name: snapshotText(node.name), label: snapshotText(node.label), testId: snapshotText(node.testId), disabled: bool(node.disabled), readonly: bool(node.readonly), ...(node.partial ? { partial: true } : {}) };
  });
  const regions = snapshotArray(raw.regions, SNAPSHOT_LIMITS.regions).map((value, index): TreeRegion => {
    const region = closedRecord(value, ["kind", "parentRegion", "hostIndex", "parentage"], ["kind", "parentRegion", "hostIndex"]);
    if (index === 0 && region.kind === "document" && region.parentRegion === null && region.hostIndex === null && Object.keys(region).length === 3) return { kind: "document", parentRegion: null, hostIndex: null };
    if (!index || region.kind !== "open-shadow" && region.kind !== "same-origin-frame" || region.parentage !== "known" && region.parentage !== "unavailable") throw new SnapshotInputError("Invalid tree region");
    const parentRegion = snapshotInteger(region.parentRegion, 31);
    if (parentRegion >= index) throw new SnapshotInputError("Region parents must precede children");
    const hostIndex = region.hostIndex === null ? null : snapshotInteger(region.hostIndex, 99);
    if (hostIndex === null ? region.parentage !== "unavailable" : !nodes[hostIndex] || nodes[hostIndex].region !== parentRegion || nodes[hostIndex].kind !== "boundary-host") throw new SnapshotInputError("Invalid boundary ownership");
    const firstChild = nodes.findIndex(node => node.region === index);
    if (hostIndex !== null && firstChild !== -1 && hostIndex >= firstChild) throw new SnapshotInputError("Boundary hosts must precede descendants");
    return { kind: region.kind, parentRegion, hostIndex, parentage: region.parentage as "known" | "unavailable" };
  });
  if (!regions.length) throw new SnapshotInputError("A document region is required");
  for (const node of nodes) {
    if (!regions[node.region]) throw new SnapshotInputError("Unknown tree region");
    let parent = node.parent; let depth = 0;
    let regionIndex = node.region;
    for (;;) {
      while (parent.kind === "node") {
        if (++depth > SNAPSHOT_LIMITS.depth || nodes[parent.index].region !== regionIndex) throw new SnapshotInputError("Invalid tree ancestor chain");
        parent = nodes[parent.index].parent;
      }
      const region = regions[regionIndex];
      if (parent.kind === "unavailable" || region.kind === "document" || region.hostIndex === null) break;
      if (++depth > SNAPSHOT_LIMITS.depth) throw new SnapshotInputError("Tree boundary depth exceeds its bound");
      const host = nodes[region.hostIndex]; parent = host.parent; regionIndex = region.parentRegion;
    }
  }
  const result: SemanticTreeResult = { formatVersion: 1, source: "sdk-reported", nameModel: "partial-aria", documentGeneration, availability: raw.availability as "complete" | "partial", nodes, regions, coverage: coverage(raw.coverage) };
  const partial = nodes.some(node => node.partial || node.parent.kind === "unavailable") || regions.some(region => region.kind !== "document" && region.parentage === "unavailable") || !result.coverage.complete || result.coverage.truncated;
  if (partial && result.availability !== "partial" || result.availability === "partial" && result.coverage.complete || result.availability === "complete" && (!result.coverage.complete || result.coverage.truncated)) throw new SnapshotInputError("Inconsistent snapshot availability");
  if (jsonBytes(result) > SNAPSHOT_LIMITS.treeBytes) throw new SnapshotInputError("Semantic tree exceeds its byte budget", 413);
  return result;
}
export function treeIncomplete(tree: SemanticTreeResult, reason: string): void {
  tree.availability = "partial"; tree.coverage.complete = false; tree.coverage.truncated = true;
  if (!tree.coverage.reasons.includes(reason)) {
    if (tree.coverage.reasons.length < 16) tree.coverage.reasons.push(reason);
    else tree.coverage.unreadOverflow = true;
  }
}
/** Probe the shipped serializer, including the loss marker, before keeping a typed tree. */
export function treeFitsTransport(tree: SemanticTreeResult): boolean {
  const probe = { ...tree, availability: "partial", coverage: { ...tree.coverage, complete: false, truncated: true, reasons: [...tree.coverage.reasons.filter(reason => reason !== "transport-budget-limit").slice(0, 15), "transport-budget-limit"] } };
  return jsonBytes(probe) <= SNAPSHOT_LIMITS.treeBytes && !sanitizeWithReport(probe).truncation;
}
export function sanitizeSemanticTree(value: unknown, sanitize: (text: string) => { value: unknown; truncated: boolean }): SemanticTreeResult {
  const tree = parseSemanticTree(value);
  const safeText = (text: string, max: number): { value: string; partial: boolean } => {
    const safe = sanitize(text); const output = typeof safe.value === "string" ? safe.value : "";
    const clipped = output.slice(0, max).replace(/[\uD800-\uDBFF]$/u, "");
    return { value: clipped, partial: safe.truncated || clipped !== text };
  };
  for (const node of tree.nodes) {
    for (const field of ["tag", "role", "name", "label", "testId"] as const) {
      const safe = safeText(node[field], SNAPSHOT_LIMITS.text); node[field] = safe.value;
      if (safe.partial) { node.partial = true; treeIncomplete(tree, "summary-truncated-or-redacted"); }
    }
  }
  tree.coverage.unread = tree.coverage.unread.map(entry => { const safe = safeText(entry.tag, SNAPSHOT_LIMITS.text); if (safe.partial) treeIncomplete(tree, "summary-truncated-or-redacted"); return { ...entry, tag: safe.value }; });
  // Drop a suffix only; graph indexes for retained nodes remain unchanged. Empty child
  // regions are removable only when no retained node/region depends on them.
  while (!treeFitsTransport(tree)) {
    treeIncomplete(tree, "transport-budget-limit");
    if (tree.nodes.length) tree.nodes.pop();
    else if (tree.coverage.unread.length) { tree.coverage.unread.pop(); tree.coverage.unreadOverflow = true; }
    else if (tree.coverage.reasons.length > 1) tree.coverage.reasons.shift();
    else throw new SnapshotInputError("Semantic tree metadata exceeds transport capacity", 413);
    while (tree.regions.length > 1) {
      const index = tree.regions.length - 1;
      if (tree.nodes.some(node => node.region === index) || tree.regions.some(region => region.kind !== "document" && region.parentRegion === index)) break;
      tree.regions.pop();
    }
  }
  return parseSemanticTree(tree);
}
