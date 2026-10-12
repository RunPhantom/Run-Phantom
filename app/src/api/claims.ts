import type { CompletionHistory, CompletionRequest, CompletionSavedReport } from "../../../src/claims/protocol";
import type { EvidenceAttachment } from "../../../src/evaluations/evidence-protocol";

export class CompletionRequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function json<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const response = await fetch(`/api/evaluations/claims${path}`, { signal, cache: "no-store", ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new CompletionRequestError(typeof result?.error === "string" ? result.error : "Completion evidence is unavailable.", response.status);
  return result as T;
}
export const claimsApi = {
  create: (request: CompletionRequest, operationKey: string, signal: AbortSignal) => json<CompletionSavedReport>("/reports", signal, { ...request, operationKey }),
  history: (attachment: EvidenceAttachment, offset: number, signal: AbortSignal) => json<CompletionHistory>(`/reports?${new URLSearchParams({ attachment: JSON.stringify(attachment), offset: String(offset) })}`, signal),
  get: (id: string, attachment: EvidenceAttachment, signal: AbortSignal) => json<CompletionSavedReport>(`/reports/${encodeURIComponent(id)}?${new URLSearchParams({ attachment: JSON.stringify(attachment) })}`, signal),
};
