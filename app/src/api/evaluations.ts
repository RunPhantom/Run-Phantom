import { apiJson, jsonInit } from "./request";
import type { Dataset, DatasetRevision, DatasetCaseDraft, DatasetExport, Snapshot, Experiment, ExperimentSummary, ExperimentDraft, Comparison, Review } from "../../../src/evaluations/protocol";
export type { Rule, RuleResult, Snapshot, Dataset, DatasetRevision, DatasetCase, DatasetCaseDraft, DatasetExport, Assignment, Experiment, ExperimentSummary, ExperimentDraft, Review, Comparison, Status } from "../../../src/evaluations/protocol";
import type { TrialAnalysis } from "../../../src/evaluations/trials-protocol";
export type { TrialAnalysis } from "../../../src/evaluations/trials-protocol";
import type { DistributionRequest, ScoreDistributionAnalysis } from "../../../src/evaluations/aggregation-protocol";
export type { DistributionRequest, ScoreDistributionAnalysis } from "../../../src/evaluations/aggregation-protocol";
const root = "/api/evaluations";
const datasetPath = (id: string) => `${root}/datasets/${encodeURIComponent(id)}`;
const experimentPath = (id: string) => `${root}/experiments/${encodeURIComponent(id)}`;
const versionQuery = (version?: number) => version === undefined ? "" : `?version=${version}`;

export const evaluationsApi = {
  datasets: () => apiJson<Dataset[]>(`${root}/datasets`),
  createDataset: (name: string) => apiJson<DatasetRevision>(`${root}/datasets`, jsonInit("POST", { name })),
  revision: (id: string, version?: number) => apiJson<DatasetRevision>(datasetPath(id) + versionQuery(version)),
  saveRevision: (id: string, expectedVersion: number, cases: DatasetCaseDraft[]) => apiJson<DatasetRevision>(datasetPath(id), jsonInit("PUT", { expectedVersion, cases })),
  deleteDataset: async (id: string) => {
    const response = await fetch(datasetPath(id), { method: "DELETE" });
    if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(typeof body?.error === "string" ? body.error : "Could not delete dataset."); }
  },
  exportDataset: (id: string, version?: number) => apiJson<DatasetExport>(`${datasetPath(id)}/export${versionQuery(version)}`),
  importDataset: (value: unknown) => apiJson<DatasetRevision>(`${root}/datasets/import`, jsonInit("POST", value)),
  snapshot: (id: string, outputSpanId?: string) => apiJson<Snapshot>(`${root}/runs/${encodeURIComponent(id)}/snapshot${outputSpanId ? `?outputSpanId=${encodeURIComponent(outputSpanId)}` : ""}`),
  responseSpans: (runId: string) => apiJson<{ spans: Array<{ id: string; name: string; spanType: string }>; truncated: boolean }>(`${root}/runs/${encodeURIComponent(runId)}/response-spans`),
  analyzeTrials: (experimentIds: string[], signal?: AbortSignal) => apiJson<TrialAnalysis>(`${root}/analyses/repeated-trials`, jsonInit("POST", { experimentIds }, { signal })),
  analyzeDistribution: (selection: DistributionRequest, signal?: AbortSignal) => apiJson<ScoreDistributionAnalysis>(`${root}/analyses/score-distributions`, jsonInit("POST", selection, { signal })),
  experiments: () => apiJson<ExperimentSummary[]>(`${root}/experiments`),
  start: (draft: ExperimentDraft) => apiJson<Experiment>(`${root}/experiments`, jsonInit("POST", draft)),
  experiment: (id: string, signal?: AbortSignal) => apiJson<Experiment>(experimentPath(id), { signal }),
  report: async (id: string, format: "json" | "junit") => {
    const response = await fetch(`${experimentPath(id)}/report?${new URLSearchParams({ format })}`);
    if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(typeof body?.error === "string" ? body.error : "Could not export evaluation report."); }
    return response.blob();
  },
  cancel: (id: string) => apiJson<Experiment>(`${experimentPath(id)}/cancel`, { method: "POST" }),
  compare: (baseline: string, candidate: string) => apiJson<Comparison>(`${root}/compare?${new URLSearchParams({ baseline, candidate })}`),
  reviews: (id: string) => apiJson<Review[]>(`${experimentPath(id)}/reviews`),
  review: (id: string, caseId: string, rating: "pass" | "fail", note: string) => apiJson<Review>(`${experimentPath(id)}/reviews`, jsonInit("POST", { caseId, rating, note })),
};

// Every action returns to the daemon's current attachment authority; report bytes stay out of query keys.
import type { EvidenceAttachment, EvidenceExpectedSource, EvidenceInventoryRevision, EvidenceJob, EvidenceSetView } from "../../../src/evaluations/evidence-protocol";
export type EvidenceInventoryAnchor = EvidenceAttachment | { kind: "dataset_revision"; id: string; version: number };
interface EvidenceOperationTimings { availability: "measured_in_current_daemon" | "unavailable"; acquisitionWallMs: number | null; queueWallMs: number | null; workerLifetimeWallMs: number | null; publicationWallMs: number | null; totalOperationWallMs: number | null; cpuMs: null; rssBytes: null }
interface EvidenceImportReceipt { job: EvidenceJob; reused: boolean; timings: EvidenceOperationTimings }
import type { EvidenceCapabilities } from "../components/evaluations/evidence-upload";
export type { EvidenceAttachment, EvidenceExpectedSource, EvidenceInventoryRevision, EvidenceJob, EvidenceSetView, EvidenceSourceObservation } from "../../../src/evaluations/evidence-protocol";
const evidenceRoot = `${root}/evidence`;
const evidenceSet = (id: string) => `${evidenceRoot}/sets/${encodeURIComponent(id)}`;
async function evidenceBlob(url: string): Promise<Blob> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(typeof body?.error === "string" ? body.error : "Could not export evidence."); }
  return response.blob();
}
export const evidenceApi = {
  capabilities: () => apiJson<EvidenceCapabilities>(`${evidenceRoot}/capabilities`, { cache: "no-store" }),
  sets: (attachment: EvidenceAttachment, signal?: AbortSignal) => apiJson<{ items: { id: string; revision: number; createdAt: number }[]; truncated: boolean }>(`${evidenceRoot}/sets?${new URLSearchParams({ attachment: JSON.stringify(attachment) })}`, { signal, cache: "no-store" }),
  set: (id: string, revision?: number, signal?: AbortSignal) => apiJson<EvidenceSetView>(evidenceSet(id) + (revision === undefined ? "" : `?revision=${revision}`), { signal, cache: "no-store" }),
  inventory: (anchor: EvidenceInventoryAnchor, signal?: AbortSignal) => apiJson<EvidenceInventoryRevision>(`${evidenceRoot}/inventories?${new URLSearchParams({ anchor: JSON.stringify(anchor) })}`, { signal, cache: "no-store" }),
  saveInventory: (anchor: EvidenceInventoryAnchor, expectedRevision: number, expected: EvidenceExpectedSource[]) => apiJson<EvidenceInventoryRevision>(`${evidenceRoot}/inventories`, jsonInit("PUT", { anchor, expectedRevision, expected })),
  upload: (body: Blob, contentType: string, signal: AbortSignal) => apiJson<EvidenceImportReceipt>(`${evidenceRoot}/imports`, { method: "POST", headers: { "Content-Type": contentType }, body, signal }),
  job: (id: string, signal?: AbortSignal) => apiJson<{ job: EvidenceJob; observationsAvailable: boolean; timings: EvidenceOperationTimings }>(`${evidenceRoot}/imports/${encodeURIComponent(id)}`, { signal, cache: "no-store" }),
  recover: (operationKey: string) => apiJson<{ job: EvidenceJob }>(`${evidenceRoot}/imports?${new URLSearchParams({ operationKey })}`, { cache: "no-store" }),
  cancel: (id: string) => apiJson<{ cancelled: boolean }>(`${evidenceRoot}/imports/${encodeURIComponent(id)}/cancel`, jsonInit("POST", {})),
  reparse: (id: string, expectedRevision: number, operationKey: string) => apiJson<EvidenceImportReceipt>(`${evidenceSet(id)}/reparse`, jsonInit("POST", { expectedRevision, operationKey })),
  remove: (id: string, revision: number, kind: "raw" | "normalized") => apiJson<{ removed: number }>(`${evidenceSet(id)}/retention/${kind}?revision=${revision}`, jsonInit("DELETE", {})),
  export: (id: string, revision: number, format: "json" | "junit" | "text") => evidenceBlob(`${evidenceSet(id)}/export?${new URLSearchParams({ revision: String(revision), format })}`),
  raw: (id: string, revision: number, sourceId: string) => evidenceBlob(`${evidenceSet(id)}/raw/${encodeURIComponent(sourceId)}?revision=${revision}`),
};
