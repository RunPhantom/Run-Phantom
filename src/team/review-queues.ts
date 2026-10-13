import type { DatasetCase, DatasetRevision } from "../evaluations/protocol";
import { EvaluationError, fields, object, parseId, parseVersion } from "../evaluations/validation";
import { applyReviewMutation, assertReviewItemIntegrity, markReviewPromoted } from "../review-queues/state";
import type { PromotionReceipt, ReviewItem, ReviewQueue, ReviewSchema, ReviewSource } from "../review-queues/protocol";
import { canonicalReviewJson, compileReviewCase, parseQueueInsert, parseReviewDraft, parseReviewMutation, parseReviewSchema, parseReviewSource,
  reviewHash, reviewItemId, reviewTimestamp } from "../review-queues/validation";
import { TeamError } from "./errors";
import { redactTeamText } from "./ingest";
import type { Role } from "./protocol";

export interface TeamReviewActor { accountId: string; role: Role }
export interface TeamApprovalWitness extends TeamReviewActor { approvedAt: number; revision: number; approvedHash: string }
export interface TeamReviewQueue extends ReviewQueue { projectId: string }
export interface TeamReviewItem extends Omit<ReviewItem, "reviewSource"> {
  projectId: string; projectSourceHash: string;
  reviewSource: "projectAccount" | null; approvalWitness: TeamApprovalWitness | null;
}
export interface TeamReviewDatasetRevision extends DatasetRevision { projectId: string }
export interface TeamReviewReceipt extends PromotionReceipt { projectId: string; queueId: string; actor: TeamReviewActor }

const itemFields = ["id", "queueId", "ordinal", "source", "sourceHash", "draft", "draftHash", "revision", "state", "approvedHash", "approvedAt", "reviewSource", "lastMutationId", "lastMutationHash", "promotedDatasetId", "promotedDatasetVersion", "promotedCaseId", "createdAt", "updatedAt", "projectId", "projectSourceHash", "approvalWitness"];
const invalid = () => new TeamError("invalid_request", "Project review request is invalid or exceeds its bounds");
const integrity = () => new TeamError("conflict", "Frozen project review evidence is invalid; reload its current revision");
function mapped(error: unknown): never {
  if (error instanceof TeamError) throw error;
  if (error instanceof EvaluationError && error.status === 409) throw new TeamError("conflict", "Project review changed; retain your draft and reload its current revision");
  if (error instanceof EvaluationError && error.status === 413) throw new TeamError("too_large", "Project review exceeds its size limit");
  throw invalid();
}
function projectId(value: unknown): string {
  const id = parseId(value);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw invalid();
  return id;
}
function actor(value: TeamReviewActor): TeamReviewActor {
  const row = object(value, "review actor"); fields(row, ["accountId", "role"], "review actor");
  if (value.role !== "editor" && value.role !== "admin") throw new TeamError("forbidden", "An editor or admin role is required for project review");
  return { accountId: projectId(value.accountId), role: value.role };
}
function safeTeamReview(value: unknown): void {
  const encoded = canonicalReviewJson(value);
  if (redactTeamText(encoded) !== encoded) throw invalid();
}
function sourceIdentity(project: string, queueId: string, schema: ReviewSchema, source: ReviewSource): string {
  return reviewHash({ projectId: project, queueId, schemaHash: reviewHash(schema), source });
}
/** A finite compatibility projection for qualified pure CAS logic; never an authority or database seam. */
export function teamReviewCore(item: TeamReviewItem): ReviewItem {
  const { projectId: _projectId, projectSourceHash: _projectSourceHash, approvalWitness: _approvalWitness, reviewSource, ...core } = item;
  return { ...core, reviewSource: reviewSource === "projectAccount" ? "localOperator" : null };
}
export function assertTeamReviewItem(project: string, item: TeamReviewItem, schema: ReviewSchema): void {
  try {
    fields(object(item, "project review item"), itemFields, "project review item");
    if (projectId(project) !== projectId(item.projectId) || ![null, "projectAccount"].includes(item.reviewSource)) throw integrity();
    const parsed = parseReviewSchema(schema); assertReviewItemIntegrity(teamReviewCore(item), parsed);
    safeTeamReview(parsed); safeTeamReview(item.source); safeTeamReview(item.draft);
    if (item.projectSourceHash !== sourceIdentity(project, item.queueId, parsed, item.source)) throw integrity();
    if (item.state === "draft") {
      if (item.approvalWitness !== null) throw integrity();
    } else {
      const witness = item.approvalWitness;
      if (!witness) throw integrity();
      fields(object(witness, "approval witness"), ["accountId", "role", "approvedAt", "revision", "approvedHash"], "approval witness");
      actor({ accountId: witness.accountId, role: witness.role });
      if (reviewTimestamp(witness.approvedAt) !== item.approvedAt || parseVersion(witness.revision) !== item.revision - (item.state === "promoted" ? 1 : 0)
        || witness.approvedHash !== item.approvedHash) throw integrity();
    }
  } catch { throw integrity(); }
}
export function parseTeamReviewInsert(body: unknown): { runId: string; outputSpanId: string | null } {
  try {
    const selected = parseQueueInsert(body);
    if (!/^[a-f0-9]{32}$/.test(selected.runId) || selected.outputSpanId !== null && !/^[a-f0-9]{16}$/.test(selected.outputSpanId)) throw invalid();
    return selected;
  } catch (error) { return mapped(error); }
}
export function createTeamReviewItem(project: string, queue: string, schema: ReviewSchema, rawSource: ReviewSource, ordinal: number, now: number): TeamReviewItem {
  try {
    project = projectId(project); queue = projectId(queue);
    const parsed = parseReviewSchema(schema), source = parseReviewSource(rawSource);
    safeTeamReview(parsed); safeTeamReview(source);
    parseTeamReviewInsert({ runId: source.runId, ...(source.requestedOutputSpanId === null ? {} : { outputSpanId: source.requestedOutputSpanId }) });
    const revision = parseVersion(ordinal), createdAt = reviewTimestamp(now);
    const draft = parseReviewDraft({ name: source.runName, input: source.input, tags: [], target: {}, note: "" }, parsed);
    const item: TeamReviewItem = { projectId: project, projectSourceHash: sourceIdentity(project, queue, parsed, source),
      id: reviewItemId(queue, source.runId, source.requestedOutputSpanId), queueId: queue, ordinal, source,
      sourceHash: reviewHash({ schemaHash: reviewHash(parsed), source }), draft, draftHash: reviewHash(draft), revision,
      state: "draft", approvedHash: null, approvedAt: null, reviewSource: null, approvalWitness: null,
      lastMutationId: null, lastMutationHash: null, promotedDatasetId: null, promotedDatasetVersion: null,
      promotedCaseId: null, createdAt, updatedAt: createdAt };
    assertTeamReviewItem(project, item, parsed); return item;
  } catch (error) { return mapped(error); }
}
/** Actor is obtained by TeamStore's current transactional membership check, never from the request body. */
export function mutateTeamReviewItem(project: string, item: TeamReviewItem, schema: ReviewSchema,
  kind: "save" | "approve" | "reopen", body: unknown, currentActor: TeamReviewActor, now: number): TeamReviewItem {
  try {
    assertTeamReviewItem(project, item, schema); const current = actor(currentActor), core = teamReviewCore(item);
    const request = parseReviewMutation(body, schema, kind); safeTeamReview(request);
    const changed = applyReviewMutation(core, schema, kind, request, now);
    if (changed === core) return item;
    const result: TeamReviewItem = { ...changed, projectId: item.projectId, projectSourceHash: item.projectSourceHash,
      reviewSource: changed.reviewSource === null ? null : "projectAccount", approvalWitness: kind === "approve"
        ? { ...current, approvedAt: changed.approvedAt!, revision: changed.revision, approvedHash: changed.approvedHash! } : null };
    assertTeamReviewItem(project, result, schema); return result;
  } catch (error) { return mapped(error); }
}
export function promoteTeamReviewItem(project: string, item: TeamReviewItem, schema: ReviewSchema, expectedRevision: number,
  destination: { datasetId: string; datasetVersion: number }, now: number): TeamReviewItem {
  try {
    assertTeamReviewItem(project, item, schema);
    const core = markReviewPromoted(teamReviewCore(item), schema, expectedRevision, destination, now);
    const result: TeamReviewItem = { ...core, projectId: item.projectId, projectSourceHash: item.projectSourceHash,
      reviewSource: "projectAccount", approvalWitness: item.approvalWitness };
    assertTeamReviewItem(project, result, schema); return result;
  } catch (error) { return mapped(error); }
}
export function compileTeamReviewCase(project: string, item: TeamReviewItem, schema: ReviewSchema): DatasetCase {
  try {
    assertTeamReviewItem(project, item, schema);
    if (item.state === "draft") throw new TeamError("conflict", "Approve the project review before promoting its frozen case");
    return compileReviewCase(item.queueId, item.id, schema, item.draft, item.source);
  } catch (error) { return mapped(error); }
}
