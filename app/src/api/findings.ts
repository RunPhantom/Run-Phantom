import { apiJson, jsonInit } from "./request";
import type { EvidenceAttachment } from "../../../src/evaluations/evidence-protocol";
import type { FindingReference, FindingMapping, FindingComparisonPage } from "../../../src/evaluations/finding-protocol";
export type { FindingComparisonPage, FindingReference };
export interface FindingBatchOption {
  reference: FindingReference; createdAt: number; parseState: string; observed: number | null; repositoryId: string | null; sourceSnapshot: string | null;
  checker: { id: string; version: string; rulesSha256: string; configurationSha256: string } | null; reportedExecution: string | null; authentication: "not_authenticated";
}
const root = "/api/evaluations/findings";
const query = (attachment: EvidenceAttachment) => new URLSearchParams({ attachment: JSON.stringify(attachment) });
export const findingsApi = {
  capabilities: (signal?: AbortSignal) => apiJson<{ enabled: boolean; scope: "local"; actor: "local_operator"; authentication: "not_authenticated" }>(root + "/capabilities", { signal, cache: "no-store" }),
  batches: (attachment: EvidenceAttachment, signal?: AbortSignal) => apiJson<{ items: FindingBatchOption[]; truncated: boolean }>(root + `/batches?${query(attachment)}`, { signal, cache: "no-store" }),
  history: (attachment: EvidenceAttachment, signal?: AbortSignal) => apiJson<{ items: { id: string; createdAt: number }[]; truncated: boolean }>(root + `/comparisons?${query(attachment)}`, { signal, cache: "no-store" }),
  authority: (id: string, attachment: EvidenceAttachment, signal: AbortSignal) => apiJson<{ id: string; current: true }>(root + `/comparisons/${encodeURIComponent(id)}/authority?${query(attachment)}`, { signal, cache: "no-store" }),
  compare: (baseline: FindingReference, candidate: FindingReference, mappingId: string | null, signal: AbortSignal) => apiJson<FindingComparisonPage>(root + "/comparisons", jsonInit("POST", { baseline, candidate, mappingId, operationKey: crypto.randomUUID() }, { signal })),
  mapping: (baseline: FindingReference, candidate: FindingReference, paths: { baseline: string; candidate: string }[], reason: string, signal: AbortSignal) => apiJson<FindingMapping>(root + "/mappings", jsonInit("POST", { baseline, candidate, paths, reason }, { signal })),
  get: (id: string, offset: number, signal?: AbortSignal) => apiJson<FindingComparisonPage>(root + `/comparisons/${encodeURIComponent(id)}?offset=${offset}&limit=100`, { signal, cache: "no-store" }),
  export: (id: string, signal: AbortSignal) => apiJson<unknown>(root + `/comparisons/${encodeURIComponent(id)}/export`, { signal, cache: "no-store" }),
};
