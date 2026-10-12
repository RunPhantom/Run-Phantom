export const FINDING_DIALECT = "runphantom-findings-json/v1" as const;
export const FINDING_POLICY = "exact-finding-multiset/v1" as const;
export const FINDING_LIMITS = Object.freeze({ MAX_FINDINGS: 50_000, MAX_PAIR: 100_000, MAX_PATHS: 2_048, MAX_RECORD_BYTES: 4 * 1024 * 1024, MAX_RECORDS: 1_000, MAX_PAGE: 100 });
export type FindingExecution = "completed" | "partial" | "not_run";
export type FindingSeverity = "error" | "warning" | "info";
export interface FindingOccurrence {
  id: string; path: string; ruleId: string; message: string; severity: FindingSeverity;
  startLine: number | null; endLine: number | null; identityAvailable: boolean;
}
export interface FindingBatch {
  format: "runphantom-findings/v1"; authentication: "not_authenticated"; identityAvailable: boolean;
  repositoryId: string; sourceSnapshot: string;
  checker: { id: string; version: string; rulesSha256: string; configurationSha256: string };
  declaredScope: string[];
  reportedExecution: { status: FindingExecution; files: { path: string; status: FindingExecution }[] };
  findings: FindingOccurrence[];
}
export interface FindingReference { setId: string; revision: number; sourceId: string }
export interface FindingMapping {
  id: string; actor: "local_operator"; policy: typeof FINDING_POLICY; reviewed: true;
  baseline: FindingReference; candidate: FindingReference; pairDigest: string;
  paths: { baseline: string; candidate: string }[]; reason: string; createdAt: number;
}
export interface FindingDelta {
  baselineId: string | null; candidateId: string | null;
  classification: "retained" | "introduced" | "removed" | "unresolved";
  severityChanged: boolean; locationChanged: boolean;
}
export interface FindingDifference {
  policy: typeof FINDING_POLICY; authentication: "not_authenticated";
  interpretation: "conditional" | "unavailable";
  observed: { baseline: number | null; candidate: number | null };
  counts: { retained: number | null; introduced: number | null; removed: number | null; unresolved: number | null };
  reasons: string[]; occurrences: FindingDelta[];
}

export interface FindingInputIdentity { setDigest: string; interpretationId: string; normalizedSha256: string }
export interface FindingComparisonRecord {
  id: string; operationKey: string; baseline: FindingReference; candidate: FindingReference; mappingId: string | null;
  baselineIdentity: FindingInputIdentity; candidateIdentity: FindingInputIdentity;
  difference: FindingDifference; createdAt: number;
  timing: { sampleId: string; acquisitionWallMs: number; matchingWallMs: number; serializationWallMs: number; cpuMs: null; peakRssBytes: null };
}
export interface FindingComparisonPage {
  comparison: Omit<FindingComparisonRecord, "difference"> & { difference: Omit<FindingDifference, "occurrences"> };
  page: { offset: number; limit: number; total: number; items: (FindingDelta & { baseline: FindingOccurrence | null; candidate: FindingOccurrence | null })[] };
}
