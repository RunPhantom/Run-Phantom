import type { EvidenceSetView } from "../evaluations/evidence-protocol";
import { EvidenceError } from "../evaluations/evidence-protocol";
import { canonicalEvidenceJson, evidenceArray, evidenceDigest, evidenceInteger, evidenceObject, evidenceText, parseEvidenceAttachment } from "../evaluations/evidence-validation";
import { COMPLETION_DETECTOR, COMPLETION_LIMITS as L, type CompletionAssertion, type CompletionCategory, type CompletionDisabled, type CompletionObservation, type CompletionReport, type CompletionRequest } from "./protocol";

export function completionEnabled(value: unknown): boolean {
  if (!value || typeof value !== "object") throw new EvidenceError("Completion request must be an object");
  const descriptor = Object.getOwnPropertyDescriptor(value, "enabled");
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "boolean") throw new EvidenceError("Completion observer requires explicit enabled preference");
  return descriptor.value;
}
export function parseCompletionRequest(value: unknown): CompletionRequest {
  const input = evidenceObject(value, ["enabled", "attachment", "setId", "revision", "summary", "assertions"], "completion request");
  if (input.enabled !== true) throw new EvidenceError("Completion observer requires explicit opt-in");
  const seen = new Set<string>();
  const assertions: CompletionAssertion[] = evidenceArray(input.assertions, L.OBSERVATIONS, "completion assertions").map(value => {
    const assertion = evidenceObject(value, ["text", "reference"], "completion assertion"), ref = evidenceObject(assertion.reference, ["setId", "revision", "sourceId"], "completion reference");
    const result = { text: evidenceText(assertion.text, "assertion text", L.SNIPPET_BYTES), reference: { setId: evidenceText(ref.setId, "reference set ID"), revision: evidenceInteger(ref.revision, "reference revision", Number.MAX_SAFE_INTEGER, 1), sourceId: evidenceText(ref.sourceId, "reference source ID") } };
    const key = canonicalEvidenceJson(result);
    if (seen.has(key)) throw new EvidenceError("Completion assertions contain a duplicate");
    seen.add(key); return result;
  });
  return { enabled: true, attachment: parseEvidenceAttachment(input.attachment), setId: evidenceText(input.setId, "selected set ID"), revision: evidenceInteger(input.revision, "selected revision", Number.MAX_SAFE_INTEGER, 1), summary: evidenceText(input.summary, "completion summary", L.INPUT_BYTES, true), assertions };
}
function prefix(text: string, max: number): string {
  let end = 0, bytes = 0;
  for (const character of text) { const next = Buffer.byteLength(character); if (bytes + next > max) break; bytes += next; end += character.length; }
  return text.slice(0, end);
}
const candidate = /\b(?:tests?\s+(?:pass(?:ed|es)?|succeed(?:ed)?|complete(?:d)?)|all\s+tests|pass(?:ed|ing)?\s+tests?|complet(?:e|ed|ion)|finish(?:ed)?|implement(?:ed)?|fix(?:ed)?|updat(?:e|ed)|chang(?:e|ed)|ready|deploy(?:ed)?)\b/i;
function category(text: string, fence: boolean): CompletionCategory {
  if (/^\s*>/.test(text)) return "quoted";
  if (fence || /^ {4}|^\t/.test(text) || text.includes("`")) return "code";
  if (/^\s*(?:[-+*]|\d+[.)])\s+\[ \]/.test(text)) return "unchecked_task";
  if (/^\s*(?:[-+*]|\d+[.)])\s+\[[xX]\]/.test(text)) return "checked_task";
  if (/["“”]|!?\[[^\]]*\]\(|<[^>]*>/.test(text)) return "quoted";
  if (/\b(?:not|no|never|none|without|cannot|can't|didn't|doesn't|isn't|wasn't|haven't|hasn't|don't|won't)\b/i.test(text)) return "negated";
  if (/\b(?:if|unless|once|when|until|will|would|could|might|may|plan|planned|planning|should|assuming|after)\b/i.test(text)) return "conditional";
  if (text.includes("?")) return "question";
  return "prose";
}
function observation(text: string, start: number, end: number, kind: CompletionObservation["origin"]["kind"], sha256: string, category: CompletionCategory, index: number): CompletionObservation {
  const original = text.slice(start, end), snippet = prefix(original, L.SNIPPET_BYTES);
  return { id: `${kind}-${index}`, origin: { kind, sha256, start, end, byteStart: Buffer.byteLength(text.slice(0, start)), byteEnd: Buffer.byteLength(text.slice(0, end)) }, snippet, snippetTruncated: snippet !== original, category,
    state: category === "prose" ? "unsupported_claim" : "ambiguous_text", explanation: category === "prose" ? "No explicit evidence link was supplied for this prose. It does not establish completion." : "This context is ambiguous or qualified. No unconditional completion meaning is inferred.", reference: null, reportedOutcome: null, authentication: "not_authenticated" };
}
export function observeCompletion(value: unknown, view: EvidenceSetView | null): CompletionReport | CompletionDisabled {
  if (!completionEnabled(value)) return { version: 1, detectorVersion: COMPLETION_DETECTOR, state: "disabled" };
  const input = parseCompletionRequest(value), summary = input.summary, sha256 = evidenceDigest(summary), inspected = prefix(summary, L.INSPECT_BYTES);
  const observations: CompletionObservation[] = [];
  for (const assertion of input.assertions) {
    const item = observation(assertion.text, 0, assertion.text.length, "operator_assertion", evidenceDigest(assertion.text), "structured", observations.length);
    item.reference = assertion.reference;
    const ref = assertion.reference;
    const source = ref.setId === input.setId && ref.revision === input.revision ? view?.revision.sources.find(source => source.sourceId === ref.sourceId) : undefined;
    const payload = source && view?.sources.find(payload => payload.sourceId === source.sourceId);
    if (ref.setId !== input.setId || ref.revision !== input.revision) { item.state = "scope_mismatch"; item.explanation = "This reference is outside the explicitly selected set revision; it was not looked up."; }
    else if (!source || !payload?.normalizedAvailable) { item.state = "evidence_missing"; item.explanation = "No retained source with this identity is available in the selected set revision. This does not mean the assertion is false."; }
    else {
      item.state = source.reportOutcome === "unknown" ? "evidence_available" : "reported_outcome";
      item.reportedOutcome = source.reportOutcome;
      item.explanation = "The selected source is available and its producer outcome is reported separately. Authentication has not been checked; this link does not prove execution or full-set completion.";
    }
    observations.push(item);
  }
  let start = 0, fenced: { marker: string; length: number } | null = null, observedBytes = 0, observationLimitReached = false;
  for (const lineWithEnding of inspected.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!lineWithEnding) continue;
    const line = lineWithEnding.replace(/\r?\n$/, ""), delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      if (!fenced) fenced = { marker: delimiter[1][0], length: delimiter[1].length };
      else if (delimiter[1][0] === fenced.marker && delimiter[1].length >= fenced.length && !delimiter[2].trim()) fenced = null;
    } else if (candidate.test(line)) {
      if (observations.length >= L.OBSERVATIONS) { observationLimitReached = true; break; }
      observations.push(observation(summary, start, start + line.length, "operator_summary", sha256, category(line, !!fenced), observations.length));
      observedBytes += Buffer.byteLength(line);
    }
    start += lineWithEnding.length;
  }
  const totalBytes = Buffer.byteLength(summary), inspectedBytes = Buffer.byteLength(inspected);
  return { version: 1, detectorVersion: COMPLETION_DETECTOR, state: "enabled", selected: { attachment: input.attachment, setId: input.setId, revision: input.revision }, source: { kind: "operator_summary", sha256, totalBytes, inspectedBytes, partial: inspectedBytes < totalBytes || observationLimitReached }, coverage: { observed: observations.length, uncoveredBytes: totalBytes - observedBytes, observationLimitReached }, observations, authority: "report_only", authentication: "not_authenticated" };
}
