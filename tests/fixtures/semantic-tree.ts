import type { SemanticTreeResult } from "../../src/verification/snapshot-contract";

export function tree(names: string[] = []): SemanticTreeResult {
  return { formatVersion: 1, source: "sdk-reported", nameModel: "partial-aria", documentGeneration: "a".repeat(32), availability: "complete",
    nodes: names.map(name => ({ kind: "semantic", region: 0, parent: { kind: "root" }, tag: "button", role: "button", name, label: "", testId: "", disabled: false, readonly: false })),
    regions: [{ kind: "document", parentRegion: null, hostIndex: null }], coverage: { scope: "visible-observable-dom", complete: true, visitedNodes: names.length, openShadowRoots: 0, sameOriginFrames: 0, inaccessibleFrames: 0, closedShadowRoots: "unobservable", hiddenSubtrees: 0, privateSubtrees: 0, truncated: false, reasons: [], unread: [] } };
}
