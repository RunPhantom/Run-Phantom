import type { DatasetCase } from "../evaluations/protocol";

export const REVIEW_QUEUE_VERSION = 1 as const;
export const REVIEW_LIMITS = {
  MAX_QUEUES: 100, MAX_ITEMS_PER_QUEUE: 10_000, MAX_ITEMS: 50_000,
  MAX_RETAINED_BYTES: 256 * 1024 * 1024, MAX_SCHEMA_BYTES: 8 * 1024,
  MAX_SOURCE_BYTES: 48 * 1024, MAX_DRAFT_BYTES: 32 * 1024, MAX_REQUEST_BYTES: 64 * 1024,
  MAX_PAGE: 50, MAX_WINDOW: 5, MAX_DIRTY_DRAFTS: 16, MAX_FIELDS: 8,
  MAX_CHOICES: 16, MAX_ID: 128, MAX_FIELD_KEY: 64, MAX_STRING: 4096,
  MAX_NOTE: 2000, MAX_PROMOTION_ITEMS: 50, MAX_PROMOTIONS: 10_000,
  MAX_RECEIPT_BYTES: 16 * 1024,
} as const;
export type ReviewScalar = string | number | boolean;
export interface ReviewField {
  key: string; label: string; type: "string" | "number" | "boolean" | "enum"; required: boolean;
  mapping: { kind: "output" } | { kind: "jsonPath"; path: string };
  choices?: ReviewScalar[]; minimum?: number; maximum?: number;
}
export interface ReviewSchema { fields: ReviewField[] }
export interface ReviewDraft {
  name: string; input: string | null; tags: string[]; target: Record<string, ReviewScalar>; note: string;
}
export interface ReviewSource {
  version: typeof REVIEW_QUEUE_VERSION; runId: string; requestedOutputSpanId: string | null;
  resolvedOutputSpanId: string | null; runName: string; capturedAt: number;
  input: string | null; output: string | null; sourceSnapshotVersion: 1;
  complete: boolean; outputComplete: boolean; redacted: boolean; truncated: boolean; warnings: string[];
}
export type ReviewState = "draft" | "approved" | "promoted";
export interface ReviewItem {
  id: string; queueId: string; ordinal: number; source: ReviewSource; sourceHash: string;
  draft: ReviewDraft; draftHash: string; revision: number; state: ReviewState;
  approvedHash: string | null; approvedAt: number | null; reviewSource: "localOperator" | null;
  lastMutationId: string | null; lastMutationHash: string | null;
  promotedDatasetId: string | null; promotedDatasetVersion: number | null; promotedCaseId: string | null;
  createdAt: number; updatedAt: number;
}
export interface ReviewQueue {
  id: string; name: string; schema: ReviewSchema; schemaHash: string; createdAt: number;
}
export interface ReviewCounts { total: number; draft: number; approved: number; promoted: number }
export interface ReviewItemSummary {
  id: string; ordinal: number; name: string; revision: number; state: ReviewState;
}
export interface ReviewCursor { limit: number; afterOrdinal?: number; afterId?: string }
export interface ReviewMutation {
  expectedRevision: number; mutationId: string; draft?: ReviewDraft;
}
export interface PromotionRequest {
  queueId: string; datasetId: string; expectedDatasetVersion: number; idempotencyKey: string;
  items: Array<{ itemId: string; expectedRevision: number }>;
}
export interface PromotionReceipt {
  promotionId: string; datasetId: string; datasetVersion: number; datasetHash: string;
  itemIds: string[]; caseIds: string[]; createdAt: number;
}
export type CompiledReviewCase = DatasetCase;
