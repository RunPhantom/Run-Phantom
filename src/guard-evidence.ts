import { parseJsonEvidence } from "./evaluations/json-evidence";
import { hasDuplicateJsonKeys } from "./json-keys";
import { validateOtlpEvidence, type EvidenceValue, type OtlpEvidence } from "./spans/otlp-evidence";
import { defaultIsSensitiveKey } from "./verification/redaction";
import { redactText } from "./verification/serialization";
import { GUARD_EVIDENCE_LIMITS as L, type CapturedGuardDecision, type CapturedGuardEvidence, type GuardAction,
  type GuardFieldIssue, type GuardPhase, type GuardReason } from "./guard-evidence-protocol";

const size = (text: string) => Buffer.byteLength(text, "utf8");
const own = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};
function readReceipt(raw: unknown): { receipt: OtlpEvidence | null; reason: GuardReason | null } {
  if (raw == null) return { receipt: null, reason: "source_receipt_missing" };
  if (typeof raw !== "string") return { receipt: null, reason: "source_receipt_invalid" };
  if (raw.length > L.receiptBytes || size(raw) > L.receiptBytes) return { receipt: null, reason: "source_receipt_oversized" };
  try {
    const receipt = parseJsonEvidence(raw);
    if (hasDuplicateJsonKeys(raw)) throw new TypeError("ambiguous receipt");
    validateOtlpEvidence(receipt);
    return { receipt, reason: null };
  } catch { return { receipt: null, reason: "source_receipt_invalid" }; }
}
const empty = (reason: GuardReason): CapturedGuardEvidence => ({ schemaVersion: 1, advisory: true, execution: "unknown", state: "unknown", reasons: [reason],
  counts: { retainedEvents: 0, capturedDecisions: 0, visibleDecisions: 0, omittedDecisions: 0, exporterDroppedEvents: null,
    receiverDroppedEvents: 0, receiverDroppedAttributes: 0, receiverTruncatedValues: 0, receiverInvalidValues: 0, receiverRedactedValues: 0,
    duplicateFields: 0, missingFields: 0, invalidEnumFields: 0, invalidNumericFields: 0, invalidFields: 0 }, decisions: [] });
const unique = <T>(values: T[]): T[] => [...new Set(values)];
const unavailable = /\[(?:TRUNCATED|UNAVAILABLE|UNSERIALIZABLE|CIRCULAR|COMPACTED)\]/i;
const redacted = /\[REDACTED\]|__REDACTED__/i;
function utf8Prefix(text: string, maximum: number): string {
  const marker = " [TRUNCATED]"; let out = "", bytes = size(marker);
  for (const character of text) { const next = size(character); if (bytes + next > maximum) break; out += character; bytes += next; }
  return out + marker;
}

/** Decode only an admitted F10 source receipt; producer actions never prove guard completion. */
export function deriveCapturedGuardEvidence(raw: unknown): CapturedGuardEvidence {
  const parsed = readReceipt(raw);
  if (!parsed.receipt) return empty(parsed.reason!);
  return fromReceipt(parsed.receipt);
}
function fromReceipt(receipt: OtlpEvidence): CapturedGuardEvidence {
  const result = empty("source_receipt_missing"); result.reasons = [];
  const capture = receipt.capture, reasons = result.reasons, counts = result.counts;
  Object.assign(counts, { retainedEvents: receipt.events.length, exporterDroppedEvents: receipt.droppedEventsCount,
    receiverDroppedEvents: capture.droppedEvents, receiverDroppedAttributes: capture.droppedAttributes,
    receiverTruncatedValues: capture.truncatedValues, receiverInvalidValues: capture.invalidValues, receiverRedactedValues: capture.redactedValues });
  if (receipt.droppedEventsCount === null) reasons.push("exporter_loss_unknown");
  else if (receipt.droppedEventsCount > 0) reasons.push("exporter_events_dropped");
  if (capture.droppedEvents > 0) reasons.push("receiver_events_dropped");
  if (capture.droppedAttributes > 0) reasons.push("receiver_attributes_dropped");
  if (capture.truncatedValues > 0) reasons.push("receiver_values_truncated");
  if (capture.invalidValues > 0) reasons.push("receiver_values_invalid");
  if (capture.redactedValues > 0) reasons.push("capture_redacted");
  const sourceAttributes = [receipt, receipt.resource, receipt.scope, ...receipt.events].filter(source => source !== null);
  if (sourceAttributes.some(source => source.droppedAttributesCount === null)) reasons.push("exporter_attributes_unknown");
  if (sourceAttributes.some(source => (source.droppedAttributesCount ?? 0) > 0)) reasons.push("exporter_attributes_dropped");
  receipt.events.forEach((event, receiptEventIndex) => {
    if (event.name !== "guard.evaluation") return;
    counts.capturedDecisions++;
    const issues: GuardFieldIssue[] = [], decisionReasons: GuardReason[] = [];
    const issue = (field: string, reason: GuardFieldIssue["reason"]) => { issues.push({ field, reason }); };
    const value = (field: string, optional = false): EvidenceValue | null => {
      const matches = event.attributes.filter(attribute => attribute.key === field);
      if (matches.length > 1) { issue(field, "field_duplicate"); counts.duplicateFields++; return null; }
      if (matches.length === 0) { if (!optional) { issue(field, "field_missing"); counts.missingFields++; } return null; }
      return matches[0].value;
    };
    const text = (field: string, maximum: number, required = false): string | null => {
      const raw = value(field); if (!raw) return null;
      if (!("stringValue" in raw) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(raw.stringValue)
        || required && !raw.stringValue.trim() || unavailable.test(raw.stringValue)) { issue(field, "field_invalid"); counts.invalidFields++; return null; }
      // The receipt validator has already enforced the floor. Reapply it before
      // the smaller public limits, keeping this boundary independent of ambient exemptions.
      const safe = redactText(raw.stringValue, defaultIsSensitiveKey);
      if (redacted.test(safe)) issue(field, "capture_redacted");
      if (size(safe) > maximum) { issue(field, "field_truncated"); return utf8Prefix(safe, maximum); }
      return safe;
    };
    const enumeration = <T extends string>(field: string, permitted: readonly T[]): T | "unknown" => {
      const raw = value(field); if (!raw) return "unknown";
      if (!("stringValue" in raw) || !permitted.includes(raw.stringValue as T)) { issue(field, "field_invalid"); counts.invalidEnumFields++; return "unknown"; }
      return raw.stringValue as T;
    };
    const number = (field: string, maximum = Infinity): number | null => {
      const raw = value(field); if (!raw) return null;
      const numeric = "doubleValue" in raw ? raw.doubleValue : "intValue" in raw ? Number(raw.intValue) : NaN;
      if (!Number.isFinite(numeric) || numeric < 0 || numeric > maximum || "intValue" in raw && !Number.isSafeInteger(numeric)) {
        issue(field, "field_invalid"); counts.invalidNumericFields++; return null;
      }
      return numeric;
    };
    const name = text("guard.name", L.nameBytes, true), phase: GuardPhase = enumeration("guard.phase", ["preflight", "postflight"]),
      action: GuardAction = enumeration("guard.action", ["allow", "warn", "redact", "deny"]), score = number("guard.score", 1),
      classification = text("guard.classification", L.classificationBytes), explanation = text("guard.explanation", L.explanationBytes), latencyMs = number("guard.latency_ms");
    const errorValue = value("guard.error", true); let error: boolean | null = null;
    if (errorValue) {
      if ("boolValue" in errorValue) error = errorValue.boolValue;
      else { issue("guard.error", "field_invalid"); counts.invalidFields++; }
    }
    if (error === true) decisionReasons.push("producer_error");
    if (capture.droppedEvents > 0) decisionReasons.push("source_index_unknown");
    if (event.timeUnixNano === null) decisionReasons.push("event_time_unknown");
    if (event.droppedAttributesCount === null) decisionReasons.push("exporter_attributes_unknown");
    else if (event.droppedAttributesCount > 0) decisionReasons.push("exporter_attributes_dropped");
    const decision: CapturedGuardDecision = { receiptEventIndex, sourceEventIndex: capture.droppedEvents ? null : receiptEventIndex,
      timeUnixNano: event.timeUnixNano, name, phase, action, score, classification, explanation, latencyMs, error,
      state: action === "unknown" || phase === "unknown" || name === null ? "unknown" : issues.length || decisionReasons.length ? "partial" : "reported",
      reasons: unique([...decisionReasons, ...issues.map(i => i.reason)]), fieldIssues: issues };
    reasons.push(...decision.reasons);
    if (result.decisions.length < L.decisions) result.decisions.push(decision);
  });
  const omitted = () => {
    counts.visibleDecisions = result.decisions.length; counts.omittedDecisions = counts.capturedDecisions - counts.visibleDecisions;
    if (counts.omittedDecisions && !reasons.includes("public_decisions_omitted")) reasons.push("public_decisions_omitted");
    result.reasons = unique(reasons);
    result.state = reasons.length ? "partial" : result.decisions.length ? "captured" : "not-captured";
    if (result.decisions.length && result.decisions.every(d => d.state === "unknown")) result.state = "unknown";
  };
  omitted();
  while (size(JSON.stringify(result)) > L.publicBytes && result.decisions.length) { result.decisions.pop(); omitted(); }
  return result;
}

// Cached rows are client-supplied. Fresh DTOs remove cached guard authority and
// extra fields, while retaining the original replay payload/status columns.
const PUBLIC_SPAN_FIELDS = ["id", "run_id", "parent_span_id", "name", "span_type", "status", "input_payload", "output_payload",
  "start_time_ms", "end_time_ms", "duration_ms", "model", "provider", "input_tokens", "output_tokens", "attributes", "otlp_evidence", "normalized"] as const;
export function projectCapturedGuardSpan(span: unknown): Record<string, unknown> & { guardEvidence: CapturedGuardEvidence } {
  const out: Record<string, unknown> = {};
  for (const field of PUBLIC_SPAN_FIELDS) { const value = own(span, field); if (value !== undefined) out[field] = value; }
  const raw = own(span, "otlp_evidence"), parsed = readReceipt(raw);
  if (raw !== undefined && !parsed.receipt) out.otlp_evidence = null;
  return { ...out, guardEvidence: parsed.receipt ? fromReceipt(parsed.receipt) : empty(parsed.reason!) };
}

/** Persist source columns only, quarantining invalid carriers without retaining their text. */
export function guardSpanForPersistence(span: unknown): Record<string, unknown> {
  const projected = projectCapturedGuardSpan(span);
  const { guardEvidence: _derived, ...out } = projected;
  if (own(span, "otlp_evidence") != null && out.otlp_evidence === null) out.otlp_evidence = "[UNAVAILABLE]";
  return out;
}

/** Portable files carry the validated source; derived decisions are rebuilt on read. */
export function guardSpanForExport(span: unknown): Record<string, unknown> {
  const { guardEvidence: _derived, ...out } = projectCapturedGuardSpan(span);
  return out;
}
