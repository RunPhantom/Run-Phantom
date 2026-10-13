import type { ControlSourceObservation, FlowAnchor, FlowDocument, SemanticResult, SemanticSummary } from "./protocol";
import { SEMANTIC_REF_PATTERN, normalizeSemanticText } from "./protocol";
import { parseFlowSteps, parseSemanticQuery, VerificationInputError } from "./validation";
import { parseControlSourceObservation } from "./build/source";
import { sanitizeWithReport } from "./serialization";

export function flowObject(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw new VerificationInputError(`${label} must be a plain object`);
  const fields = Reflect.ownKeys(value);
  if (fields.length > allowed.length) throw new VerificationInputError(`${label} has unsupported fields`);
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !allowed.includes(key) || !descriptor || !("value" in descriptor)) throw new VerificationInputError(`${label} has unsupported fields`);
  }
  return value as Record<string, unknown>;
}
function literal(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || value.length > max || !empty && !value.trim() || value.includes("\0") || [...value].some(char => { const code = char.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; })) throw new VerificationInputError("Invalid durable identity text");
  const safe = sanitizeWithReport(value);
  if (safe.redacted || safe.truncation || /\[(?:REDACTED|TRUNCATED|UNSERIALIZABLE|CIRCULAR)\]/.test(value)) throw new VerificationInputError("Durable identity contains private or incomplete text");
  return value;
}
const signatureFields = ["tag", "role", "name", "label", "testId"] as const;
function instance(value: unknown): Extract<FlowAnchor, { kind: "semantic" }>["instance"] {
  const raw = flowObject(value, signatureFields, "anchor instance");
  return Object.fromEntries(signatureFields.map(key => [key, literal(raw[key], key === "tag" || key === "role" ? 64 : 240, key !== "tag")])) as Extract<FlowAnchor, { kind: "semantic" }>["instance"];
}
export function parseFlowAnchor(value: unknown): FlowAnchor {
  const raw = flowObject(value, ["kind", "selector", "query", "instance", "source"], "flow anchor");
  if (raw.kind === "css") {
    flowObject(raw, ["kind", "selector"], "CSS anchor");
    // Reuse the existing credential-bearing selector floor without changing the selector.
    const selector = literal(raw.selector, 1024);
    parseFlowSteps([{ predicate: { kind: "element", selector, state: "present" } }]);
    return { kind: "css", selector };
  }
  if (raw.kind !== "semantic") throw new VerificationInputError("Unsupported flow anchor version or kind");
  flowObject(raw, ["kind", "query", "instance", "source"], "semantic anchor");
  const query = parseSemanticQuery(raw.query);
  if (query.kind !== "test-id" && query.exact === false) throw new VerificationInputError("Durable anchors require exact semantic queries");
  let source: ControlSourceObservation | undefined;
  if (Object.hasOwn(raw, "source")) {
    try { source = parseControlSourceObservation(raw.source); } catch { throw new VerificationInputError("Invalid anchor source"); }
    if (source.status !== "captured") throw new VerificationInputError("Only captured source identity can be retained in anchors");
    literal(source.file, 512); if (source.component) literal(source.component, 128);
  }
  return { kind: "semantic", query, instance: instance(raw.instance), ...(source ? { source } : {}) };
}

/** Reading a legacy flow is an in-memory projection. It never rewrites stored bytes. */
export function decodeFlowDocument(raw: unknown): FlowDocument {
  let values: unknown = raw;
  if (!Array.isArray(raw)) {
    const document = flowObject(raw, ["version", "steps"], "flow document");
    if (document.version !== 2) throw new VerificationInputError("Unsupported saved flow version");
    values = document.steps;
  }
  return { version: 2, steps: parseFlowSteps(values).map(step => step.command?.type === "click" || step.command?.type === "causal-click"
    ? { ...step, anchor: step.anchor ?? { kind: "css", selector: step.command.selector } } : step) };
}

/** Closed bounded payload interpretation; SDK observations remain advisory. */
export function parseFlowDiscovery(value: unknown): SemanticResult {
  const raw = flowObject(value, ["source", "nameModel", "documentGeneration", "query", "status", "ref", "count", "countExact", "elements", "coverage"], "flow discovery");
  const whole = (item: unknown, max = 10000) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0 && item <= max;
  const boolean = (item: unknown) => typeof item === "boolean";
  if (raw.source !== "sdk-reported" || raw.nameModel !== "partial-aria" || typeof raw.documentGeneration !== "string" || !/^[a-f0-9]{32}$/.test(raw.documentGeneration)
    || !whole(raw.count) || !boolean(raw.countExact) || !Array.isArray(raw.elements) || raw.elements.length > 100) throw new VerificationInputError("Invalid flow discovery envelope");
  const coverage = flowObject(raw.coverage, ["scope", "complete", "visitedNodes", "openShadowRoots", "sameOriginFrames", "inaccessibleFrames", "closedShadowRoots", "hiddenSubtrees", "privateSubtrees", "truncated", "reasons", "unread", "unreadOverflow"], "flow coverage");
  if (coverage.scope !== "visible-observable-dom" || coverage.closedShadowRoots !== "unobservable" || !boolean(coverage.complete) || !boolean(coverage.truncated)
    || !["visitedNodes", "openShadowRoots", "sameOriginFrames", "inaccessibleFrames", "hiddenSubtrees", "privateSubtrees"].every(key => whole(coverage[key]))
    || !Array.isArray(coverage.reasons) || coverage.reasons.length > 16 || !Array.isArray(coverage.unread) || coverage.unread.length > 32
    || Object.hasOwn(coverage, "unreadOverflow") && coverage.unreadOverflow !== true) throw new VerificationInputError("Invalid flow discovery coverage");
  if (coverage.complete === true && (coverage.truncated === true || coverage.inaccessibleFrames !== 0 || coverage.reasons.length || coverage.unread.length || coverage.unreadOverflow === true || raw.countExact !== true)) throw new VerificationInputError("Contradictory complete flow coverage");
  coverage.reasons.forEach(reason => literal(reason, 128));
  coverage.unread.forEach(item => { const unread = flowObject(item, ["tag", "reason"], "unread region"); literal(unread.tag, 64); literal(unread.reason, 128); });
  const elements = raw.elements.map((item): SemanticSummary => {
    const entry = flowObject(item, [...signatureFields, "ref", "depth", "disabled", "readonly", "truncated", "controlSource"], "flow candidate");
    const identity = instance(Object.fromEntries(signatureFields.map(key => [key, entry[key]])));
    if (!whole(entry.depth, 64) || !boolean(entry.disabled) || !boolean(entry.readonly) || Object.hasOwn(entry, "truncated") && entry.truncated !== true
      || Object.hasOwn(entry, "ref") && (typeof entry.ref !== "string" || !SEMANTIC_REF_PATTERN.test(entry.ref))) throw new VerificationInputError("Invalid flow candidate");
    let controlSource: ControlSourceObservation | undefined;
    if (Object.hasOwn(entry, "controlSource")) { try { controlSource = parseControlSourceObservation(entry.controlSource); } catch { throw new VerificationInputError("Invalid candidate source"); } }
    return { ...identity, depth: entry.depth as number, disabled: entry.disabled as boolean, readonly: entry.readonly as boolean,
      ...(entry.ref ? { ref: entry.ref as string } : {}), ...(entry.truncated ? { truncated: true } : {}), ...(controlSource ? { controlSource } : {}) };
  });
  if (new Set(elements.flatMap(item => item.ref ? [item.ref] : [])).size !== elements.filter(item => item.ref).length || (raw.count as number) < elements.length) throw new VerificationInputError("Inconsistent flow candidate identities");
  if (Object.hasOwn(raw, "query")) parseSemanticQuery(raw.query);
  if (Object.hasOwn(raw, "status") && !["unique", "ambiguous", "not-found", "inconclusive"].includes(String(raw.status))) throw new VerificationInputError("Invalid discovery status");
  if (Object.hasOwn(raw, "ref") && (raw.status !== "unique" || raw.count !== 1 || raw.countExact !== true || coverage.complete !== true || raw.ref !== elements[0]?.ref)) throw new VerificationInputError("Invalid unique discovery reference");
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > 32 * 1024) throw new VerificationInputError("Flow discovery byte limit exceeded");
  return { ...raw, elements, coverage } as unknown as SemanticResult;
}
function sameInstance(anchor: Extract<FlowAnchor, { kind: "semantic" }>, item: SemanticSummary): boolean {
  return signatureFields.every(key => normalizeSemanticText(anchor.instance[key]) === normalizeSemanticText(item[key]));
}
export function anchorForCandidate(item: SemanticSummary): Extract<FlowAnchor, { kind: "semantic" }> {
  const query = item.testId ? { kind: "test-id" as const, testId: item.testId } : item.role && item.name ? { kind: "role" as const, role: item.role, name: item.name, exact: true }
    : item.label ? { kind: "label" as const, label: item.label, exact: true } : { kind: "name" as const, name: item.name, exact: true };
  return parseFlowAnchor({ kind: "semantic", query, instance: Object.fromEntries(signatureFields.map(key => [key, item[key]])),
    ...(item.controlSource?.status === "captured" ? { source: item.controlSource } : {}) }) as Extract<FlowAnchor, { kind: "semantic" }>;
}
export function sourceMatch(anchor: FlowAnchor, item: SemanticSummary): "same" | "changed" | "unavailable" | "unrecorded" {
  if (anchor.kind === "css" || !anchor.source) return "unrecorded";
  if (item.controlSource?.status !== "captured") return "unavailable";
  return JSON.stringify(anchor.source) === JSON.stringify(item.controlSource) ? "same" : "changed";
}
export function resolveFlowAnchor(anchor: FlowAnchor, data: SemanticResult): { ref?: string; reason: string; matches: number } {
  if (anchor.kind === "css") return { reason: "CSS selector requires the existing CSS action path", matches: 0 };
  const query = anchor.query;
  const matches = data.elements.filter(item => {
    const match = query.kind === "test-id" ? item.testId === query.testId : query.kind === "role" ? item.role === query.role && (query.name === undefined || item.name === query.name) : query.kind === "label" ? item.label === query.label : item.name === query.name;
    return match && sameInstance(anchor, item) && ["same", "unrecorded"].includes(sourceMatch(anchor, item));
  });
  if (!data.coverage.complete || data.coverage.truncated || !data.countExact || data.count !== data.elements.length) return { reason: "Discovery coverage is incomplete; no target identity established", matches: matches.length };
  if (matches.length !== 1) return { reason: matches.length ? "Anchor identity is ambiguous; review a narrower instance" : "Anchor identity or source changed; review a repair", matches: matches.length };
  const item = matches[0];
  if (!item.ref || item.truncated || item.disabled || item.readonly) return { reason: "Matched instance is incomplete or unavailable for action", matches: 1 };
  return { ref: item.ref, reason: "One exact observed instance", matches: 1 };
}
