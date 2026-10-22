export const EVIDENCE_VERSION = 1 as const;
export const EVIDENCE_LIMITS = Object.freeze({
  MAX_REPORTS: 32,
  MAX_SOURCE_BYTES: 2 * 1024 * 1024,
  MAX_IMPORT_BYTES: 8 * 1024 * 1024,
  MAX_LEAVES: 50_000,
  MAX_NORMALIZED_BYTES: 4 * 1024 * 1024,
  MAX_SOURCE_MS: 2_000,
  MAX_IMPORT_MS: 15_000,
  MAX_ACTIVE: 2,
  MAX_QUEUED: 8,
  MAX_COUNT_DIGITS: 128,
  MAX_SUBJECTS: 128,
  MAX_PRODUCER_TEST_NAMES: 256,
  MAX_SUITE_SUMMARIES: 4_096,
  MAX_SUITE_DEPTH: 64,
});
export const EVIDENCE_STATEMENT_TYPE = "https://in-toto.io/Statement/v1" as const;
export const EVIDENCE_PREDICATE_TYPE = "https://in-toto.io/attestation/test-result/v0.1" as const;
export const EVIDENCE_PAYLOAD_TYPES = ["application/vnd.in-toto+json"] as const;

export type EvidenceScope = { kind: "local"; id: "local" } | { kind: "project"; id: string };
export type EvidenceCapability = "normalized_read" | "import" | "inventory_edit" | "raw_export" | "delete" | "compare";
export type EvidenceAttachment = { kind: "inspection" | "experiment" | "check" | "run"; id: string };
export type EvidenceKind = "junit" | "json" | "jsonl" | "attestation" | "finding";
export type EvidenceDialect = "junit-xml/v1" | "in-toto-statement/v1" | "dsse-envelope/v1" | "dsse-envelope-jsonl/v1" | "runphantom-findings-json/v1";
export type EvidenceParseState = "parsed" | "unparsed" | "rejected";
export type EvidenceOutcome = "reports_pass" | "reports_fail" | "no_tests" | "unknown";
export type EvidenceCoverage = "complete" | "incomplete" | "not_declared";
export type EvidenceRetention = "raw_and_normalized" | "normalized_only";
export type EvidenceReason = "source_unparsed" | "source_rejected" | "counts_mismatch" | "unknown_leaves" |
  "no_tests" | "missing_source" | "extra_source" | "duplicate_shard" | "kind_mismatch" |
  "constraint_mismatch" | "inventory_not_declared" | "retrospective_inventory" | "identity_unverified" |
  "raw_removed" | "normalized_removed" | "parse_incomplete" | "attestation_only" |
  "unsupported_schema" | "invalid_json" | "duplicate_key" | "xml_doctype" | "xml_entity" | "unsafe_encoding" |
  "depth_exceeded" | "source_limit" | "worker_timeout" | "import_timeout" | "worker_crashed" | "normalization_limit" |
  "subject_unresolved" | "ambiguous_subject";

/** Producer counts use exact decimal strings; leaf-derived counts remain separately identified. */
export type EvidenceCounts = Record<"executed" | "passed" | "failed" | "errored" | "skipped" | "disabled" | "unknown", string | null>;
export type EvidenceProducerCounts = Partial<Record<"tests" | "executed" | "passed" | "failures" | "errors" | "skipped" | "disabled" | "unknown", string>>;
export interface EvidenceProducerSummary {
  suiteId: string;
  parentSuiteId: string | null;
  name: string;
  counts: EvidenceProducerCounts;
  countsConsistent: boolean | null;
}
export interface EvidenceSourceDescriptor {
  sourceId: string;
  kind: EvidenceKind;
  dialect: EvidenceDialect;
  shardId: string | null;
  artifactSha256: string;
  byteLength: number;
}
export interface EvidenceExpectedSource {
  shardId: string;
  kind: EvidenceKind;
  constraints: { runnerId: string | null; commit: string | null; sourceSha256: string | null };
}
export interface EvidenceInventoryRevision {
  id: string;
  revision: number;
  declaration: "prospective" | "retrospective";
  expected: EvidenceExpectedSource[];
  actorId: string;
  createdAt: number;
  digest: string;
}
export interface EvidenceImportRequest {
  operationKey: string;
  target: { setId: string; expectedRevision: number } | null;
  attachment: EvidenceAttachment;
  sources: EvidenceSourceDescriptor[];
  inventory: { id: string; revision: number } | null;
  parserVersion: string;
  policyVersion: string;
  configurationSha256: string;
  retention: EvidenceRetention;
}
export interface EvidenceLeaf {
  id: string;
  name: string;
  status: "passed" | "failed" | "errored" | "skipped" | "disabled" | "unknown";
  file: string | null;
  durationMs: number | null;
  detail: string | null;
}
export interface EvidenceAttestationSummary {
  statementType: string;
  predicateType: string;
  payloadType: string | null;
  signatureCount: string | null;
  signaturesChecked: false;
  producerResult: "PASSED" | "WARNED" | "FAILED" | null;
  producerTests: { passed: string[] | null; warned: string[] | null; failed: string[] | null };
  subjects: { name: string; digests: { algorithm: "sha256" | "gitCommit" | "sha1" | "gitTree"; value: string }[] }[];
  /** Every distinct subject gitCommit digest; sha1, gitTree and generic text cannot establish this list. */
  assertedCommits: string[];
  reportReferences: { subjectName: string; sha256: string }[];
}
export interface EvidenceReportReference {
  subjectName: string;
  sha256: string;
  linkedSourceId: string | null;
  resolution: "matched" | "unresolved" | "ambiguous";
}
export interface NormalizedEvidenceSource {
  version: typeof EVIDENCE_VERSION;
  sourceId: string;
  parseState: EvidenceParseState;
  interpretationComplete: boolean;
  reportOutcome: EvidenceOutcome;
  leafCounts: EvidenceCounts;
  observedExecutedLowerBound: string | null;
  producerCounts: EvidenceProducerCounts | null;
  producerSummaries: EvidenceProducerSummary[];
  countsConsistent: boolean | null;
  assertedIdentity: { runnerId: string | null; commit: string | null; sourceSha256: string | null };
  attestation: EvidenceAttestationSummary | null;
  reasonCodes: EvidenceReason[];
  leaves: EvidenceLeaf[];
  findingBatch?: import("./finding-protocol").FindingBatch;
}
export interface EvidenceSourceObservation {
  sourceId: string;
  artifactId: string;
  interpretationId: string;
  artifactSha256: string;
  normalizedSha256: string;
  kind: EvidenceKind;
  dialect: EvidenceDialect;
  shardId: string | null;
  byteLength: number;
  parseState: EvidenceParseState;
  interpretationComplete: boolean;
  reportOutcome: EvidenceOutcome;
  leafCounts: EvidenceCounts;
  observedExecutedLowerBound: string | null;
  countsConsistent: boolean | null;
  reportIdentityAsserted: boolean;
  commitAssertionMatches: boolean | null;
  reportReferences: EvidenceReportReference[];
  /** A parser can never claim that bytes authenticate execution. */
  authentication: "not_checked";
  reasonCodes: EvidenceReason[];
}
export interface EvidenceSetRevision {
  version: typeof EVIDENCE_VERSION;
  id: string;
  revision: number;
  jobId: string;
  scope: EvidenceScope;
  scopeGeneration: number;
  attachment: EvidenceAttachment;
  inventory: EvidenceInventoryRevision | null;
  parserVersion: string;
  policyVersion: string;
  configurationSha256: string;
  initialRetention: EvidenceRetention;
  coverage: EvidenceCoverage;
  missing: string[];
  extra: string[];
  duplicates: string[];
  rejected: string[];
  reasonCodes: EvidenceReason[];
  sources: EvidenceSourceObservation[];
  createdAt: number;
  digest: string;
}
export interface EvidenceSetView {
  revision: EvidenceSetRevision;
  sources: { sourceId: string; rawAvailable: boolean; normalizedAvailable: boolean; normalized: NormalizedEvidenceSource | null }[];
}
export type EvidenceJobStatus = "queued" | "running" | "completed" | "cancelled" | "failed";
/** Owner-selected codes only: request content and worker diagnostics never become durable failure text. */
export const EVIDENCE_IMPORT_FAILURE_CODES = ["upload_aborted", "upload_timeout", "source_integrity", "worker_unavailable",
  "worker_failed", "worker_protocol", "worker_timeout", "import_timeout", "queue_full", "shutdown", "attachment_unavailable"] as const;
export type EvidenceImportFailureCode = typeof EVIDENCE_IMPORT_FAILURE_CODES[number];
export type EvidenceJobFailureCode = EvidenceImportFailureCode | "deadline_exceeded" | "restart_interrupted" |
  "scope_invalidated" | "revision_conflict" | "retention_changed" | "cancelled";
export interface EvidenceJob {
  id: string;
  scopeGeneration: number;
  requestDigest: string;
  status: EvidenceJobStatus;
  admittedAt: number;
  deadlineAt: number;
  setId: string | null;
  failureCode: EvidenceJobFailureCode | null;
}
export interface EvidencePublicationSource { sourceId: string; raw: Uint8Array; normalized: unknown }
export class EvidenceError extends Error {
  constructor(message: string, public readonly status: 400 | 403 | 404 | 409 | 413 = 400) {
    super(message); this.name = "EvidenceError";
  }
}
