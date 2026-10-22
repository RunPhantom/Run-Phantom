/** Captured producer decisions are advisory evidence; execution coverage is unknown. */
export const GUARD_EVIDENCE_LIMITS = { receiptBytes: 256 * 1024, events: 128, decisions: 32,
  publicBytes: 32 * 1024, nameBytes: 128, classificationBytes: 256, explanationBytes: 2048 } as const;
export type GuardAction = "allow" | "warn" | "redact" | "deny" | "unknown";
export type GuardPhase = "preflight" | "postflight" | "unknown";
export type GuardReason = "source_receipt_missing" | "source_receipt_invalid" | "source_receipt_oversized"
  | "exporter_loss_unknown" | "exporter_events_dropped" | "exporter_attributes_unknown" | "exporter_attributes_dropped"
  | "receiver_events_dropped" | "receiver_attributes_dropped" | "receiver_values_truncated" | "receiver_values_invalid"
  | "capture_redacted" | "source_index_unknown" | "event_time_unknown" | "field_missing" | "field_duplicate"
  | "field_invalid" | "field_truncated" | "producer_error" | "public_decisions_omitted";
export interface GuardFieldIssue { field: string; reason: "field_missing" | "field_duplicate" | "field_invalid" | "field_truncated" | "capture_redacted" }
export interface CapturedGuardDecision {
  receiptEventIndex: number;
  sourceEventIndex: number | null;
  timeUnixNano: string | null;
  name: string | null;
  phase: GuardPhase;
  action: GuardAction;
  score: number | null;
  classification: string | null;
  explanation: string | null;
  latencyMs: number | null;
  error: boolean | null;
  state: "reported" | "partial" | "unknown";
  reasons: GuardReason[];
  fieldIssues: GuardFieldIssue[];
}
export interface CapturedGuardEvidence {
  schemaVersion: 1;
  advisory: true;
  execution: "unknown";
  state: "captured" | "partial" | "unknown" | "not-captured";
  reasons: GuardReason[];
  counts: { retainedEvents: number; capturedDecisions: number; visibleDecisions: number; omittedDecisions: number;
    exporterDroppedEvents: number | null; receiverDroppedEvents: number; receiverDroppedAttributes: number;
    receiverTruncatedValues: number; receiverInvalidValues: number; receiverRedactedValues: number;
    duplicateFields: number; missingFields: number; invalidEnumFields: number; invalidNumericFields: number; invalidFields: number };
  decisions: CapturedGuardDecision[];
}
