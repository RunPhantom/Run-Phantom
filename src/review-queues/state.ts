import { fields, object, parseId, parseVersion } from "../evaluations/validation";
import type { ReviewItem, ReviewSchema } from "./protocol";
import { parseReviewDraft, parseReviewSource, parseReviewSchema, parseReviewMutation, reviewHash,
  reviewDigest, reviewItemId, reviewCaseId, reviewTimestamp, ReviewQueueError } from "./validation";

function conflict(message: string): never { throw new ReviewQueueError("revision_conflict", message, 409); }
export function approvalHash(schema: ReviewSchema, sourceHash: string, draftHash: string): string {
  return reviewHash({ schemaHash: reviewHash(parseReviewSchema(schema)), sourceHash, draftHash });
}
/** Durable reads must check the frozen projection and its state, not recover raw trace data. */
export function assertReviewItemIntegrity(item: ReviewItem, rawSchema: ReviewSchema): void {
  try {
    const row = object(item, "review item");
    fields(row, ["id", "queueId", "ordinal", "source", "sourceHash", "draft", "draftHash", "revision", "state", "approvedHash", "approvedAt", "reviewSource", "lastMutationId", "lastMutationHash", "promotedDatasetId", "promotedDatasetVersion", "promotedCaseId", "createdAt", "updatedAt"], "review item");
    const schema = parseReviewSchema(rawSchema), source = parseReviewSource(item.source);
    parseId(item.queueId); parseVersion(item.ordinal); parseVersion(item.revision);
    reviewDigest(item.id); reviewDigest(item.sourceHash); reviewDigest(item.draftHash);
    if (!["draft", "approved", "promoted"].includes(item.state)) throw new Error("invalid state");
    const draft = parseReviewDraft(item.draft, schema, item.state !== "draft");
    if (item.id !== reviewItemId(item.queueId, source.runId, source.requestedOutputSpanId)
      || item.sourceHash !== reviewHash({ schemaHash: reviewHash(schema), source })
      || item.draftHash !== reviewHash(draft)) throw new Error("invalid content identity");
    const createdAt = reviewTimestamp(item.createdAt), updatedAt = reviewTimestamp(item.updatedAt);
    if (updatedAt < createdAt) throw new Error("invalid item time");
    if ((item.lastMutationId === null) !== (item.lastMutationHash === null)) throw new Error("invalid mutation identity");
    if (item.lastMutationId !== null) { parseId(item.lastMutationId); reviewDigest(item.lastMutationHash); }
    if (item.state === "draft") {
      if (item.approvedHash !== null || item.approvedAt !== null || item.reviewSource !== null) throw new Error("draft has approval");
    } else {
      if (item.reviewSource !== "localOperator" || item.approvedHash !== approvalHash(schema, item.sourceHash, item.draftHash)
        || reviewTimestamp(item.approvedAt) > updatedAt) throw new Error("invalid approval");
    }
    if (item.state === "promoted") {
      parseId(item.promotedDatasetId); parseVersion(item.promotedDatasetVersion);
      if (item.promotedCaseId !== reviewCaseId(item.queueId, item.id)) throw new Error("invalid promoted case identity");
    } else if (item.promotedDatasetId !== null || item.promotedDatasetVersion !== null || item.promotedCaseId !== null) throw new Error("invalid promotion state");
  } catch {
    throw new ReviewQueueError("integrity_conflict", "Frozen review item is invalid; no source fallback is available", 409);
  }
}
function nextRevision(item: ReviewItem): number {
  if (item.revision === Number.MAX_SAFE_INTEGER) conflict("Review revision limit reached");
  return item.revision + 1;
}
export function applyReviewMutation(item: ReviewItem, schema: ReviewSchema, kind: "save" | "approve" | "reopen", body: unknown, now: number): ReviewItem {
  assertReviewItemIntegrity(item, schema);
  const request = parseReviewMutation(body, schema, kind);
  const mutationHash = reviewHash({ queueId: item.queueId, itemId: item.id, kind, request });
  if (item.lastMutationId === request.mutationId) {
    if (item.lastMutationHash !== mutationHash) conflict("Mutation identity changed; reload the current revision");
    return item;
  }
  if (item.revision !== request.expectedRevision) conflict("Review item changed; retain your draft and reload its current revision");
  if (item.state === "promoted") conflict("Promoted review items are immutable");
  if (kind === "reopen" ? item.state !== "approved" : item.state !== "draft") conflict("Review state changed; approval must be reopened explicitly");
  const updatedAt = reviewTimestamp(now);
  if (updatedAt < item.updatedAt) conflict("Review clock moved before the current revision");
  const draft = request.draft ?? item.draft, draftHash = reviewHash(draft);
  const result: ReviewItem = { ...item, draft, draftHash, revision: nextRevision(item), updatedAt,
    state: kind === "approve" ? "approved" : "draft", approvedAt: kind === "approve" ? updatedAt : null,
    reviewSource: kind === "approve" ? "localOperator" : null,
    approvedHash: kind === "approve" ? approvalHash(schema, item.sourceHash, draftHash) : null,
    lastMutationId: request.mutationId, lastMutationHash: mutationHash };
  assertReviewItemIntegrity(result, schema);
  return result;
}
export function markReviewPromoted(item: ReviewItem, schema: ReviewSchema, expectedRevision: number,
  destination: { datasetId: string; datasetVersion: number }, now: number): ReviewItem {
  assertReviewItemIntegrity(item, schema); parseVersion(expectedRevision);
  if (item.revision !== expectedRevision || item.state !== "approved") conflict("Approved review item changed before promotion");
  const updatedAt = reviewTimestamp(now);
  if (updatedAt < item.updatedAt) conflict("Review clock moved before the current revision");
  const result: ReviewItem = { ...item, state: "promoted", revision: nextRevision(item), updatedAt,
    promotedDatasetId: parseId(destination.datasetId), promotedDatasetVersion: parseVersion(destination.datasetVersion),
    promotedCaseId: reviewCaseId(item.queueId, item.id), lastMutationId: null, lastMutationHash: null };
  assertReviewItemIntegrity(result, schema);
  return result;
}
