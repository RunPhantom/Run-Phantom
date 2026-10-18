import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDrizzleDb } from "../db";
import { loadSnapshot } from "../evaluations/loader";
import { parseId, parseVersion } from "../evaluations/validation";
import { REVIEW_LIMITS as L, type ReviewItem, type ReviewQueue, type ReviewCounts, type ReviewItemSummary, type ReviewCursor } from "./protocol";
import { parseQueueCreate, parseQueueInsert, parseReviewSchema, parseReviewJson, parseReviewDraft,
  freezeReviewSource, reviewHash, reviewItemId, reviewCaseId, parsePromotionRequest, parsePromotionReceipt, canonicalReviewJson, ReviewQueueError } from "./validation";
import { applyReviewMutation, assertReviewItemIntegrity } from "./state";

function missing(label: string): never { throw new ReviewQueueError("not_found", `${label} not found`, 404); }
function integrity(): never { throw new ReviewQueueError("integrity_conflict", "Stored review evidence is invalid", 409); }
function finiteCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return integrity();
  return value;
}
export function readReviewQueue(id: string): ReviewQueue {
  parseId(id);
  const row = getDrizzleDb().all<{ id: string; name: string | null; schema_json: string | null; schema_hash: string; created_at: number }>(sql`
    SELECT id,CASE WHEN length(CAST(name AS BLOB))<=512 THEN name END AS name,
      CASE WHEN length(CAST(schema_json AS BLOB))<=${L.MAX_SCHEMA_BYTES} THEN schema_json END AS schema_json,
      schema_hash,created_at FROM review_queues WHERE id=${id}`)[0];
  if (!row) return missing("Queue");
  try {
    if (row.schema_json === null) return integrity();
    const schema = parseReviewSchema(parseReviewJson(row.schema_json));
    if (row.schema_hash !== reviewHash(schema)) return integrity();
    return { id: parseId(row.id), name: parseQueueCreate({ name: row.name, schema }).name, schema, schemaHash: row.schema_hash, createdAt: finiteCount(row.created_at) };
  } catch { return integrity(); }
}
export function reviewCounts(queueId: string): ReviewCounts {
  const row = getDrizzleDb().all<{ total: number; draft: number; approved: number; promoted: number }>(sql`
    SELECT count(*) AS total,coalesce(sum(state='draft'),0) AS draft,
      coalesce(sum(state='approved'),0) AS approved,coalesce(sum(state='promoted'),0) AS promoted
    FROM review_queue_items WHERE queue_id=${queueId}`)[0]!;
  const counts = { total: finiteCount(row.total), draft: finiteCount(row.draft), approved: finiteCount(row.approved), promoted: finiteCount(row.promoted) };
  if (counts.total !== counts.draft + counts.approved + counts.promoted || counts.total > L.MAX_ITEMS_PER_QUEUE) return integrity();
  return counts;
}
/** SQL accounts UTF-8 bytes before any retained source or draft is materialized. */
export function assertReviewRetention(extraBytes = 0, extraItems = 0, extraQueues = 0, extraPromotions = 0): void {
  const db = getDrizzleDb();
  const queues = db.all<{ n: number; bytes: number }>(sql`SELECT count(*) AS n,coalesce(sum(length(CAST(schema_json AS BLOB))),0) AS bytes FROM review_queues`)[0]!;
  const items = db.all<{ n: number; bytes: number }>(sql`SELECT count(*) AS n,coalesce(sum(length(CAST(source_json AS BLOB))+length(CAST(draft_json AS BLOB))),0) AS bytes FROM review_queue_items`)[0]!;
  const promotions = db.all<{ n: number; bytes: number }>(sql`SELECT count(*) AS n,coalesce(sum(length(CAST(request_json AS BLOB))+length(CAST(result_json AS BLOB))),0) AS bytes FROM review_queue_promotions`)[0]!;
  const bytes = finiteCount(queues.bytes) + finiteCount(items.bytes) + finiteCount(promotions.bytes) + Math.max(0, extraBytes);
  if (!Number.isSafeInteger(bytes) || bytes > L.MAX_RETAINED_BYTES || finiteCount(queues.n) + extraQueues > L.MAX_QUEUES
    || finiteCount(items.n) + extraItems > L.MAX_ITEMS || finiteCount(promotions.n) + extraPromotions > L.MAX_PROMOTIONS) {
    throw new ReviewQueueError("retention_full", "Review retention is full; delete retained items or queues before adding more", 409);
  }
}
export function createReviewQueue(body: unknown): ReviewQueue {
  const parsed = parseQueueCreate(body), schemaJson = canonicalReviewJson(parsed.schema);
  return getDrizzleDb().transaction(tx => {
    assertReviewRetention(Buffer.byteLength(schemaJson), 0, 1);
    const queue: ReviewQueue = { id: randomUUID(), name: parsed.name, schema: parsed.schema, schemaHash: reviewHash(parsed.schema), createdAt: Date.now() };
    tx.run(sql`INSERT INTO review_queues(id,name,schema_json,schema_hash,created_at) VALUES(${queue.id},${queue.name},${schemaJson},${queue.schemaHash},${queue.createdAt})`);
    return queue;
  }, { behavior: "immediate" });
}
export function listReviewQueues(): Array<ReviewQueue & { counts: ReviewCounts }> {
  assertReviewRetention();
  const rows = getDrizzleDb().all<{ id: string }>(sql`SELECT id FROM review_queues ORDER BY created_at DESC,id DESC LIMIT ${L.MAX_QUEUES}`);
  return rows.map(row => ({ ...readReviewQueue(row.id), counts: reviewCounts(row.id) }));
}
export function deleteReviewQueue(id: string): void {
  parseId(id);
  if (!getDrizzleDb().all(sql`DELETE FROM review_queues WHERE id=${id} RETURNING id`)[0]) missing("Queue");
}
const itemProjection = sql`id,queue_id,ordinal,
  CASE WHEN length(CAST(source_run_id AS BLOB))<=512 THEN source_run_id END AS source_run_id,
  CASE WHEN length(CAST(source_span_key AS BLOB))<=512 THEN source_span_key END AS source_span_key,
  CASE WHEN length(CAST(source_json AS BLOB))<=${L.MAX_SOURCE_BYTES} THEN source_json END AS source_json,source_hash,
  CASE WHEN length(CAST(draft_json AS BLOB))<=${L.MAX_DRAFT_BYTES} THEN draft_json END AS draft_json,draft_hash,
  revision,state,approved_hash,approved_at,review_source,last_mutation_id,last_mutation_hash,
  CASE WHEN length(CAST(promoted_dataset_id AS BLOB))<=512 THEN promoted_dataset_id END AS promoted_dataset_id,promoted_dataset_version,
  CASE WHEN length(CAST(promoted_case_id AS BLOB))<=64 THEN promoted_case_id END AS promoted_case_id,created_at,updated_at`;
export function readReviewItem(queueId: string, itemId: string, schema = readReviewQueue(queueId).schema): ReviewItem {
  parseId(queueId); parseId(itemId);
  assertReviewRetention();
  const row = getDrizzleDb().all<Record<string, unknown>>(sql`SELECT ${itemProjection} FROM review_queue_items WHERE queue_id=${queueId} AND id=${itemId}`)[0];
  if (!row) return missing("Review item");
  try {
    if (typeof row.source_json !== "string" || typeof row.draft_json !== "string") return integrity();
    const item: ReviewItem = { id: row.id as string, queueId: row.queue_id as string, ordinal: row.ordinal as number,
      source: parseReviewJson(row.source_json) as ReviewItem["source"], sourceHash: row.source_hash as string,
      draft: parseReviewJson(row.draft_json) as ReviewItem["draft"], draftHash: row.draft_hash as string,
      revision: row.revision as number, state: row.state as ReviewItem["state"], approvedHash: row.approved_hash as string | null,
      approvedAt: row.approved_at as number | null, reviewSource: row.review_source as ReviewItem["reviewSource"],
      lastMutationId: row.last_mutation_id as string | null, lastMutationHash: row.last_mutation_hash as string | null,
      promotedDatasetId: row.promoted_dataset_id as string | null, promotedDatasetVersion: row.promoted_dataset_version as number | null,
      promotedCaseId: row.promoted_case_id as string | null, createdAt: row.created_at as number, updatedAt: row.updated_at as number };
    assertReviewItemIntegrity(item, schema);
    if (row.source_run_id !== item.source.runId || row.source_span_key !== (item.source.requestedOutputSpanId ?? "")) return integrity();
    return item;
  } catch { return integrity(); }
}
export function insertReviewItem(queueId: string, body: unknown): ReviewItem {
  const selection = parseQueueInsert(body);
  return getDrizzleDb().transaction(tx => {
    const queue = readReviewQueue(queueId), id = reviewItemId(queueId, selection.runId, selection.outputSpanId);
    if (tx.all(sql`SELECT id FROM review_queue_items WHERE id=${id} AND queue_id=${queueId}`)[0]) return readReviewItem(queueId, id, queue.schema);
    assertReviewRetention(0, 1);
    if (reviewCounts(queueId).total >= L.MAX_ITEMS_PER_QUEUE) throw new ReviewQueueError("retention_full", "Queue item limit reached", 409);
    const source = freezeReviewSource(loadSnapshot(selection.runId, selection.outputSpanId ?? undefined), selection.outputSpanId);
    const draft = parseReviewDraft({ name: source.runName, input: source.input, tags: [], target: {}, note: "" }, queue.schema);
    const sourceJson = canonicalReviewJson(source), draftJson = canonicalReviewJson(draft);
    assertReviewRetention(Buffer.byteLength(sourceJson) + Buffer.byteLength(draftJson), 1);
    const ordinal = parseVersion(tx.all<{ next_ordinal: number }>(sql`SELECT next_ordinal FROM review_queues WHERE id=${queueId}`)[0]!.next_ordinal);
    if (ordinal === Number.MAX_SAFE_INTEGER) throw new ReviewQueueError("retention_full", "Queue ordering limit reached", 409);
    const now = Date.now();
    tx.run(sql`INSERT INTO review_queue_items(id,queue_id,ordinal,source_run_id,source_span_key,source_json,source_hash,draft_json,draft_hash,revision,state,created_at,updated_at)
      VALUES(${id},${queueId},${ordinal},${source.runId},${selection.outputSpanId ?? ""},${sourceJson},${reviewHash({ schemaHash: queue.schemaHash, source })},${draftJson},${reviewHash(draft)},${ordinal},'draft',${now},${now})`);
    tx.run(sql`UPDATE review_queues SET next_ordinal=${ordinal + 1} WHERE id=${queueId}`);
    return readReviewItem(queueId, id, queue.schema);
  }, { behavior: "immediate" });
}
export function persistReviewMutation(item: ReviewItem, expectedRevision: number): void {
  if (!Number.isSafeInteger(item.revision) || item.revision >= Number.MAX_SAFE_INTEGER) throw new ReviewQueueError("retention_full", "Review revision allocator limit reached", 409);
  const counter = parseVersion(getDrizzleDb().all<{ next_ordinal: number }>(sql`SELECT next_ordinal FROM review_queues WHERE id=${item.queueId}`)[0]?.next_ordinal);
  const result = getDrizzleDb().all(sql`UPDATE review_queue_items SET draft_json=${canonicalReviewJson(item.draft)},draft_hash=${item.draftHash},
    revision=${item.revision},state=${item.state},approved_hash=${item.approvedHash},approved_at=${item.approvedAt},review_source=${item.reviewSource},
    last_mutation_id=${item.lastMutationId},last_mutation_hash=${item.lastMutationHash},promoted_dataset_id=${item.promotedDatasetId},
    promoted_dataset_version=${item.promotedDatasetVersion},promoted_case_id=${item.promotedCaseId},updated_at=${item.updatedAt}
    WHERE queue_id=${item.queueId} AND id=${item.id} AND revision=${expectedRevision} RETURNING id`)[0];
  if (!result) throw new ReviewQueueError("revision_conflict", "Review item changed before publication", 409);
  getDrizzleDb().run(sql`UPDATE review_queues SET next_ordinal=${Math.max(counter, item.revision + 1)} WHERE id=${item.queueId}`);
}
export function mutateReviewItem(queueId: string, itemId: string, kind: "save" | "approve" | "reopen", body: unknown): ReviewItem {
  return getDrizzleDb().transaction(() => {
    const queue = readReviewQueue(queueId), prior = readReviewItem(queueId, itemId, queue.schema);
    const next = applyReviewMutation(prior, queue.schema, kind, body, Math.max(Date.now(), prior.updatedAt));
    if (next === prior) return prior;
    assertReviewRetention(Buffer.byteLength(canonicalReviewJson(next.draft)) - Buffer.byteLength(canonicalReviewJson(prior.draft)));
    persistReviewMutation(next, prior.revision); return next;
  }, { behavior: "immediate" });
}
export function deleteReviewItem(queueId: string, itemId: string, expectedRevision: number): void {
  parseId(queueId); parseId(itemId); parseVersion(expectedRevision);
  getDrizzleDb().transaction(() => {
    readReviewQueue(queueId); const item = readReviewItem(queueId, itemId);
    if (item.revision !== expectedRevision) throw new ReviewQueueError("revision_conflict", "Review item changed before deletion", 409);
    if (!getDrizzleDb().all(sql`DELETE FROM review_queue_items WHERE queue_id=${queueId} AND id=${itemId} AND revision=${expectedRevision} RETURNING id`)[0]) missing("Review item");
  }, { behavior: "immediate" });
}
function summarizeRows(rows: Array<{ id: string; ordinal: number; name: string | null; revision: number; state: string }>): ReviewItemSummary[] {
  return rows.map(row => {
    const name = row.name === null ? null : sanitizeSummaryName(row.name);
    if (name === null || !["draft", "approved", "promoted"].includes(row.state)) return integrity();
    return { id: parseId(row.id), ordinal: parseVersion(row.ordinal), name, revision: parseVersion(row.revision), state: row.state as ReviewItemSummary["state"] };
  });
}
function sanitizeSummaryName(name: string): string | null {
  try { return parseReviewDraft({ name, input: null, tags: [], target: {}, note: "" }, { fields: [{ key: "value", label: "Value", type: "string", required: false, mapping: { kind: "output" } }] }).name; } catch { return null; }
}
export function listReviewItems(queueId: string, cursor: ReviewCursor): { items: ReviewItemSummary[]; nextCursor: { afterOrdinal: number; afterId: string } | null; counts: ReviewCounts } {
  return getDrizzleDb().transaction(tx => {
    readReviewQueue(queueId); assertReviewRetention();
    const after = cursor.afterOrdinal === undefined ? sql`` : sql`AND (ordinal>${cursor.afterOrdinal} OR (ordinal=${cursor.afterOrdinal} AND id>${cursor.afterId!}))`;
    const rows = tx.all<{ id: string; ordinal: number; name: string | null; revision: number; state: string }>(sql`
      SELECT id,ordinal,CASE WHEN length(CAST(draft_json AS BLOB))<=${L.MAX_DRAFT_BYTES} AND json_valid(draft_json)
        THEN CASE WHEN json_type(draft_json,'$.name')='text' AND length(json_extract(draft_json,'$.name'))<=128
          AND length(CAST(json_extract(draft_json,'$.name') AS BLOB))<=512 THEN json_extract(draft_json,'$.name') END END AS name,revision,state
      FROM review_queue_items WHERE queue_id=${queueId} ${after} ORDER BY ordinal,id LIMIT ${cursor.limit + 1}`);
    const items = summarizeRows(rows.slice(0, cursor.limit)), last = items.at(-1);
    return { items, nextCursor: rows.length > cursor.limit && last ? { afterOrdinal: last.ordinal, afterId: last.id } : null, counts: reviewCounts(queueId) };
  });
}
export function reviewWindow(queueId: string, centerId: string): ReviewItem[] {
  return getDrizzleDb().transaction(tx => {
    const queue = readReviewQueue(queueId), center = readReviewItem(queueId, centerId, queue.schema);
    const before = tx.all<{ id: string }>(sql`SELECT id FROM review_queue_items WHERE queue_id=${queueId} AND ordinal<${center.ordinal} ORDER BY ordinal DESC,id DESC LIMIT 2`).reverse();
    const after = tx.all<{ id: string }>(sql`SELECT id FROM review_queue_items WHERE queue_id=${queueId} AND ordinal>${center.ordinal} ORDER BY ordinal,id LIMIT 2`);
    return [...before.map(row => readReviewItem(queueId, row.id, queue.schema)), center, ...after.map(row => readReviewItem(queueId, row.id, queue.schema))];
  });
}
/** Lookup precedes head-version and quota checks, so an acknowledged operation remains retryable. */
export function findReviewPromotion(queueId: string, key: string): { request: import("./protocol").PromotionRequest; receipt: import("./protocol").PromotionReceipt } | null {
  parseId(queueId); parseId(key);
  const row = getDrizzleDb().all<{ id: string; request_hash: string; request_json: string | null; result_json: string | null; dataset_id: string; dataset_version: number; dataset_hash: string; created_at: number }>(sql`
    SELECT id,request_hash,CASE WHEN length(CAST(request_json AS BLOB))<=${L.MAX_RECEIPT_BYTES} THEN request_json END AS request_json,
      CASE WHEN length(CAST(result_json AS BLOB))<=${L.MAX_RECEIPT_BYTES} THEN result_json END AS result_json,CASE WHEN length(CAST(dataset_id AS BLOB))<=512 THEN dataset_id END AS dataset_id,dataset_version,dataset_hash,created_at
    FROM review_queue_promotions WHERE queue_id=${queueId} AND idempotency_key=${key}`)[0];
  if (!row) return null;
  try {
    if (row.request_json === null || row.result_json === null) return integrity();
    const request = parsePromotionRequest(parseReviewJson(row.request_json)), receipt = parsePromotionReceipt(parseReviewJson(row.result_json));
    if (request.queueId !== queueId || request.idempotencyKey !== key || reviewHash(request) !== row.request_hash
      || receipt.promotionId !== reviewHash([queueId, key]) || receipt.promotionId !== row.id || receipt.datasetId !== request.datasetId
      || receipt.datasetId !== row.dataset_id || receipt.datasetVersion !== row.dataset_version || receipt.datasetVersion !== request.expectedDatasetVersion + 1
      || receipt.datasetHash !== row.dataset_hash || receipt.createdAt !== row.created_at
      || canonicalReviewJson(receipt.itemIds) !== canonicalReviewJson(request.items.map(item => item.itemId))
      || canonicalReviewJson(receipt.caseIds) !== canonicalReviewJson(receipt.itemIds.map(itemId => reviewCaseId(queueId, itemId)))) return integrity();
    const revision = getDrizzleDb().all<{ hash: string }>(sql`SELECT hash FROM evaluation_revisions WHERE dataset_id=${receipt.datasetId} AND version=${receipt.datasetVersion}`)[0];
    if (revision?.hash !== receipt.datasetHash) return integrity();
    return { request, receipt };
  } catch { return integrity(); }
}
