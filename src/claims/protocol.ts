import type { EvidenceAttachment, EvidenceOutcome } from "../evaluations/evidence-protocol";

export const COMPLETION_DETECTOR = "completion-spans/v1";
export const COMPLETION_LIMITS = Object.freeze({ INPUT_BYTES: 48 * 1024, INSPECT_BYTES: 16 * 1024, OBSERVATIONS: 32, SNIPPET_BYTES: 512 });
export type CompletionState = "ambiguous_text" | "unsupported_claim" | "evidence_available" | "evidence_missing" | "scope_mismatch" | "reported_outcome";
export type CompletionCategory = "prose" | "negated" | "conditional" | "quoted" | "code" | "unchecked_task" | "checked_task" | "question" | "structured";
export interface CompletionReference { setId: string; revision: number; sourceId: string }
export interface CompletionAssertion { text: string; reference: CompletionReference }
export interface CompletionRequest {
  enabled: true;
  attachment: EvidenceAttachment;
  setId: string;
  revision: number;
  summary: string;
  assertions: CompletionAssertion[];
}
export interface CompletionObservation {
  id: string;
  origin: { kind: "operator_summary" | "operator_assertion"; sha256: string; start: number; end: number; byteStart: number; byteEnd: number };
  snippet: string;
  snippetTruncated: boolean;
  category: CompletionCategory;
  state: CompletionState;
  explanation: string;
  reference: CompletionReference | null;
  reportedOutcome: EvidenceOutcome | null;
  authentication: "not_authenticated";
}
export interface CompletionReport {
  version: 1;
  detectorVersion: string;
  state: "enabled";
  selected: { attachment: EvidenceAttachment; setId: string; revision: number };
  source: { kind: "operator_summary"; sha256: string; totalBytes: number; inspectedBytes: number; partial: boolean };
  coverage: { observed: number; uncoveredBytes: number; observationLimitReached: boolean };
  observations: CompletionObservation[];
  authority: "report_only";
  authentication: "not_authenticated";
}
export interface CompletionDisabled { version: 1; detectorVersion: typeof COMPLETION_DETECTOR; state: "disabled" }
export interface CompletionSavedReport {
  id: string;
  createdAt: number;
  request: CompletionRequest;
  report: CompletionReport;
}
export interface CompletionHistory {
  items: { id: string; setId: string; revision: number; detectorVersion: string; createdAt: number; payloadAvailable: boolean }[];
  total: number;
  offset: number;
  hasMore: boolean;
}
