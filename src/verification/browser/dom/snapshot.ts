import type { SemanticQuery, SemanticSummary, SemanticResult, ControlSourceObservation } from "../../protocol.js";
export type { SemanticSummary, SemanticResult } from "../../protocol.js";
import { sourceUnavailable } from "../../build/source.js";
import { sanitizeWithReport } from "../../serialization.js";
import { collectSemanticElements, matchesSemanticQuery, SEMANTIC_LIMITS, type SemanticCoverage, type SemanticElement } from "./query.js";
import { LiveElementRefs, LiveRefError } from "./refs.js";

export const DISCOVERY_SOURCE_LIMITS = { controls: 16, timeMs: 8 } as const;
type SourceReader = (element: Element) => ControlSourceObservation;
type Sanitize = (value: unknown) => { value: unknown; truncated: boolean };

function incomplete(coverage: SemanticCoverage, reason: string): void {
  coverage.complete = false; coverage.truncated = true;
  if (!coverage.reasons.includes(reason)) coverage.reasons.push(reason);
}

function summary(entry: SemanticElement, refs: LiveElementRefs, sanitize: Sanitize, coverage: SemanticCoverage, source?: SourceReader, revalidateSource?: SourceReader): SemanticSummary {
  let truncated = entry.nameTruncated;
  const text = (value: string): string => {
    const safe = sanitize(value);
    truncated ||= safe.truncated || typeof safe.value !== "string";
    const output = typeof safe.value === "string" ? safe.value : "";
    if (output.length > SEMANTIC_LIMITS.name) truncated = true;
    return output.slice(0, SEMANTIC_LIMITS.name);
  };
  const name = text(entry.name); const label = text(entry.label); const testId = text(entry.testId); const role = text(entry.role); const tag = text(entry.element.localName);
  const controlSource = source?.(entry.element);
  let ref: string | undefined;
  try {
    const raw = refs.refFor(entry.element, controlSource && revalidateSource ? { observation: controlSource, read: revalidateSource } : undefined); const safe = sanitize(raw);
    if (!safe.truncated && safe.value === raw) ref = raw;
    else truncated = true;
  } catch (error) { incomplete(coverage, error instanceof LiveRefError && error.code === "capacity" ? "reference-capacity-exhausted" : "reference-unavailable"); }
  if (truncated) incomplete(coverage, "summary-truncated-or-redacted");
  return { ...(ref ? { ref } : {}), tag, role, name, label, testId, depth: entry.depth, disabled: entry.disabled, readonly: entry.readonly, ...(truncated ? { truncated: true } : {}), ...(controlSource ? { controlSource } : {}) };
}

function result(refs: LiveElementRefs, sanitize: Sanitize, query?: SemanticQuery, source?: SourceReader): { result: SemanticResult; truncated?: boolean } {
  const collected = collectSemanticElements(refs.document);
  let probes = 0;
  const sourceStarted = performance.now();
  const boundedSource: SourceReader | undefined = source ? element => {
    if (probes >= DISCOVERY_SOURCE_LIMITS.controls || performance.now() - sourceStarted >= DISCOVERY_SOURCE_LIMITS.timeMs) return sourceUnavailable("probe-limit");
    probes++;
    return source(element);
  } : undefined;
  refs.beginDiscovery(collected);
  const matches = query ? collected.elements.filter(element => matchesSemanticQuery(element, query)) : collected.elements;
  const output: SemanticResult = { source: "sdk-reported", nameModel: "partial-aria", documentGeneration: refs.documentGeneration,
    ...(query ? { query } : {}), count: matches.length, countExact: collected.coverage.complete, elements: [], coverage: collected.coverage };
  if (matches.length > SEMANTIC_LIMITS.summaries) incomplete(output.coverage, "summary-limit");
  for (const entry of matches.slice(0, SEMANTIC_LIMITS.summaries)) {
    const item = summary(entry, refs, sanitize, output.coverage, boundedSource, source);
    output.elements.push(item);
    if (new TextEncoder().encode(JSON.stringify(output)).byteLength > SEMANTIC_LIMITS.bytes - 1024) {
      output.elements.pop(); incomplete(output.coverage, "output-byte-limit"); break;
    }
    // Retain typed coverage even when the existing transport's stricter structured budget binds.
    const probe = { ...output, coverage: { ...output.coverage, reasons: [...output.coverage.reasons, "transport-budget-limit"] } };
    if (sanitizeWithReport(probe).truncation) {
      output.elements.pop(); incomplete(output.coverage, "transport-budget-limit"); break;
    }
  }
  if (query) {
    if (!output.coverage.complete) output.status = "inconclusive";
    else if (!matches.length) output.status = "not-found";
    else if (matches.length > 1) output.status = "ambiguous";
    else if (output.elements[0]?.ref) { output.status = "unique"; output.ref = output.elements[0].ref; }
    else output.status = "inconclusive";
  }
  // Counts describe this visible observable scope. Closed roots are always an explicit blind spot.
  output.countExact = output.coverage.complete;
  return { result: output, ...(output.coverage.truncated ? { truncated: true } : {}) };
}

export function findSemantic(query: SemanticQuery, refs: LiveElementRefs, sanitize: Sanitize, source?: SourceReader) { return result(refs, sanitize, query, source); }
export function snapshotSemantic(refs: LiveElementRefs, sanitize: Sanitize, source?: SourceReader) { return result(refs, sanitize, undefined, source); }
