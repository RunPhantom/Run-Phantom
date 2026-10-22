import type { ReviewQueue, ReviewCounts, ReviewItem, ReviewItemSummary, ReviewCursor, ReviewMutation, PromotionRequest, PromotionReceipt } from "../../../../src/review-queues/protocol";
import { REVIEW_LIMITS as L } from "../../../../src/review-queues/protocol";
export type { ReviewQueue, ReviewItem, ReviewDraft, ReviewField, ReviewSchema, ReviewItemSummary, ReviewCounts, ReviewScalar, PromotionReceipt } from "../../../../src/review-queues/protocol";
export interface ReviewPage { items: ReviewItemSummary[]; nextCursor: { afterOrdinal: number; afterId: string } | null; counts: ReviewCounts }
export class ReviewRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}
const root = "/api/review-queues";
const at = (queueId: string) => `${root}/${encodeURIComponent(queueId)}`;
async function request<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  if (serialized !== undefined && new TextEncoder().encode(serialized).length > L.MAX_REQUEST_BYTES) throw new ReviewRequestError("Review request exceeds its byte limit", 413, "size_limit");
  const response = await fetch(url, { method, headers: serialized === undefined ? {} : { "Content-Type": "application/json" }, body: serialized, cache: "no-store" });
  if (response.status === 204) return undefined as T;
  const reader = response.body?.getReader(); if (!reader) throw new ReviewRequestError("Review response is unavailable", 502, "invalid_response");
  const decoder = new TextDecoder(); let text = "", bytes = 0;
  for (;;) {
    const chunk = await reader.read(); if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > 1024 * 1024) { await reader.cancel(); throw new ReviewRequestError("Review response exceeds its byte limit", 502, "invalid_response"); }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  let value: unknown; try { value = JSON.parse(text); } catch { throw new ReviewRequestError("Review response is invalid", 502, "invalid_response"); }
  if (!response.ok) {
    const error = (value as { error?: { message?: unknown; code?: unknown } })?.error;
    throw new ReviewRequestError(typeof error?.message === "string" ? error.message.slice(0, 500) : "Review request failed", response.status, typeof error?.code === "string" ? error.code.slice(0, 128) : "request_failed");
  }
  return value as T;
}
export const reviewQueuesApi = {
  queues: async () => { const rows = await request<Array<ReviewQueue & { counts: ReviewCounts }>>(root); if (!Array.isArray(rows) || rows.length > L.MAX_QUEUES) throw new Error("Invalid queue list"); return rows; },
  create: (name: string, schema?: ReviewQueue["schema"]) => request<ReviewQueue>(root, "POST", { name, ...(schema ? { schema } : {}) }),
  deleteQueue: (queueId: string) => request<void>(at(queueId), "DELETE"),
  insert: (queueId: string, runId: string, outputSpanId?: string) => request<ReviewItem>(`${at(queueId)}/items`, "POST", { runId, ...(outputSpanId === undefined ? {} : { outputSpanId }) }),
  page: async (queueId: string, cursor: ReviewCursor = { limit: L.MAX_PAGE }) => {
    const query = new URLSearchParams({ limit: String(cursor.limit), ...(cursor.afterOrdinal === undefined ? {} : { afterOrdinal: String(cursor.afterOrdinal), afterId: cursor.afterId! }) });
    const page = await request<ReviewPage>(`${at(queueId)}/items?${query}`);
    if (!Array.isArray(page.items) || page.items.length > L.MAX_PAGE || page.counts.total > L.MAX_ITEMS_PER_QUEUE) throw new Error("Invalid review page"); return page;
  },
  window: async (queueId: string, centerId: string) => { const items = await request<ReviewItem[]>(`${at(queueId)}/window?${new URLSearchParams({ centerId })}`); if (!Array.isArray(items) || items.length > L.MAX_WINDOW) throw new Error("Invalid review window"); return items; },
  mutate: (queueId: string, itemId: string, kind: "save" | "approve" | "reopen", mutation: ReviewMutation) => request<ReviewItem>(`${at(queueId)}/items/${encodeURIComponent(itemId)}${kind === "save" ? "" : `/${kind}`}`, kind === "save" ? "PUT" : "POST", mutation),
  deleteItem: (queueId: string, itemId: string, expectedRevision: number) => request<void>(`${at(queueId)}/items/${encodeURIComponent(itemId)}`, "DELETE", { expectedRevision }),
  promote: (requestBody: PromotionRequest) => { const { queueId, ...body } = requestBody; return request<PromotionReceipt>(`${at(queueId)}/promotions`, "POST", body); },
  receipt: (queueId: string, key: string) => request<PromotionReceipt>(`${at(queueId)}/promotions/${encodeURIComponent(key)}`),
};
export type ReviewQueuesClient = typeof reviewQueuesApi;
