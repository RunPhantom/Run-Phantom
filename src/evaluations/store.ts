import { parseCapturedAgentDefinitions } from "../agent-definitions";
import { randomUUID, createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, notInArray, count, sql } from "drizzle-orm";
import { getDrizzleDb } from "../db";
import { evaluation_datasets as datasets, evaluation_revisions as revisions, evaluation_experiments as experiments, evaluation_reviews as reviews } from "../db/schema";
import { canonicalCaseDefinitions, EvaluationError, parseDatasetExport } from "./validation";
import { EVALUATION_LIMITS as L, type Dataset, type DatasetCase, type DatasetRevision, type Experiment, type ExperimentSummary, type Review } from "./protocol";
import { MAX_TRIAL_ACQUISITION_BYTES, parseTrialSelection } from "./trials";
import { parseDistributionIds } from "./distributions";
import type { PromotionRequest, PromotionReceipt } from "../review-queues/protocol";
import { parsePromotionRequest, canonicalReviewJson, reviewHash, compileReviewCase, ReviewQueueError } from "../review-queues/validation";
import { readReviewQueue, readReviewItem, assertReviewRetention, persistReviewMutation, findReviewPromotion } from "../review-queues/store";
import { markReviewPromoted } from "../review-queues/state";
import { activeLocalEvidenceAttachmentIds } from "./evidence-inventory";

export function listDatasets(): Dataset[] {
  return getDrizzleDb().select().from(datasets).orderBy(desc(datasets.created_at)).all()
    .map((row) => ({ id: row.id, name: row.name, latestVersion: row.latest_version, caseCount: row.case_count, createdAt: row.created_at }));
}

export function getRevision(id: string, version?: number): DatasetRevision {
  const db = getDrizzleDb();
  const dataset = db.select().from(datasets).where(eq(datasets.id, id)).get();
  if (!dataset) throw new EvaluationError("Dataset not found", 404);
  const row = db.select().from(revisions).where(and(eq(revisions.dataset_id, id), eq(revisions.version, version ?? dataset.latest_version))).get();
  if (!row) throw new EvaluationError("Dataset revision not found", 404);
  return { datasetId: id, datasetName: dataset.name, version: row.version, hash: row.hash,
    cases: JSON.parse(row.cases), createdAt: row.created_at };
}

export function createDataset(name: string, cases: DatasetCase[] = []): DatasetRevision {
  const id = randomUUID(), createdAt = Date.now();
  const hash = createHash("sha256").update(canonicalCaseDefinitions(cases)).digest("hex");
  getDrizzleDb().transaction((tx) => {
    if ((tx.select({ n: count() }).from(datasets).get()?.n ?? 0) >= L.MAX_DATASETS) throw new EvaluationError("Dataset limit reached", 409);
    tx.insert(datasets).values({ id, name, latest_version: 1, case_count: cases.length, created_at: createdAt }).run();
    tx.insert(revisions).values({ dataset_id: id, version: 1, hash, cases: JSON.stringify(cases), created_at: createdAt }).run();
  });
  return { datasetId: id, datasetName: name, version: 1, hash, cases, createdAt };
}

type DatasetTransaction = Parameters<Parameters<ReturnType<typeof getDrizzleDb>["transaction"]>[0]>[0];
function appendRevisionInTransaction(tx: DatasetTransaction, id: string, expectedVersion: number, cases: DatasetCase[]): DatasetRevision {
  const dataset = tx.select().from(datasets).where(eq(datasets.id, id)).get();
  if (!dataset) throw new EvaluationError("Dataset not found", 404);
  if (dataset.latest_version !== expectedVersion) throw new EvaluationError("Dataset changed; reload the latest revision before saving", 409);
  if (dataset.latest_version >= L.MAX_REVISIONS) throw new EvaluationError("Dataset revision limit reached", 409);
  const version = dataset.latest_version + 1, createdAt = Date.now();
  const hash = createHash("sha256").update(canonicalCaseDefinitions(cases)).digest("hex");
  tx.insert(revisions).values({ dataset_id: id, version, hash, cases: JSON.stringify(cases), created_at: createdAt }).run();
  tx.update(datasets).set({ latest_version: version, case_count: cases.length }).where(eq(datasets.id, id)).run();
  return { datasetId: id, datasetName: dataset.name, version, hash, cases, createdAt };
}
export function appendRevision(id: string, expectedVersion: number, cases: DatasetCase[]): DatasetRevision {
  return getDrizzleDb().transaction(tx => appendRevisionInTransaction(tx, id, expectedVersion, cases));
}

export function deleteDataset(id: string): void {
  if (!getDrizzleDb().delete(datasets).where(eq(datasets.id, id)).returning({ id: datasets.id }).get()) throw new EvaluationError("Dataset not found", 404);
}

function summarize(experiment: Experiment): ExperimentSummary {
  const { results: _results, ...summary } = experiment;
  return summary;
}
function validateFrozenDefinitions(experiment: Experiment): void {
  for (const result of experiment.results) if (result.snapshot.agentDefinitions !== undefined) {
    try { parseCapturedAgentDefinitions(result.snapshot.agentDefinitions); }
    catch { throw new EvaluationError("Frozen definition provenance is invalid", 409); }
  }
}
function encoded(experiment: Experiment): string {
  validateFrozenDefinitions(experiment);
  const data = JSON.stringify(experiment);
  if (Buffer.byteLength(data) > L.MAX_EXPERIMENT) throw new EvaluationError("Experiment exceeds the retained result size limit", 413);
  return data;
}

export function insertExperiment(experiment: Experiment, token: string): void {
  const data = encoded(experiment);
  getDrizzleDb().transaction((tx) => {
    const active = tx.select({ n: count() }).from(experiments).where(inArray(experiments.status, ["queued", "running"])).get()?.n ?? 0;
    if (active >= L.MAX_ACTIVE_JOBS) throw new EvaluationError("Two experiments are already queued or running", 409);
    const total = tx.select({ n: count() }).from(experiments).get()?.n ?? 0;
    if (total >= L.MAX_EXPERIMENTS) {
      const protectedIds = [...activeLocalEvidenceAttachmentIds(getDrizzleDb().$client, "experiment")];
      const victims = tx.select({ id: experiments.id }).from(experiments).where(and(inArray(experiments.status, ["completed", "cancelled"]), protectedIds.length ? notInArray(experiments.id, protectedIds) : undefined))
        .orderBy(asc(experiments.created_at)).limit(total - L.MAX_EXPERIMENTS + 1).all();
      if (victims.length < total - L.MAX_EXPERIMENTS + 1) throw new EvaluationError("Experiment retention is full", 409);
      tx.delete(experiments).where(inArray(experiments.id, victims.map((row) => row.id))).run();
    }
    tx.insert(experiments).values({ id: experiment.id, status: experiment.status, job_token: token, completed_checks: 0,
      data, summary: JSON.stringify(summarize(experiment)), created_at: experiment.createdAt, completed_at: null }).run();
  });
}

export function getExperimentRecord(id: string) {
  const row = getDrizzleDb().select().from(experiments).where(eq(experiments.id, id)).get();
  if (!row) throw new EvaluationError("Experiment not found", 404);
  const experiment = JSON.parse(row.data) as Experiment; validateFrozenDefinitions(experiment);
  return { experiment, token: row.job_token, completedChecks: row.completed_checks };
}
export function getExperiment(id: string): Experiment { return getExperimentRecord(id).experiment; }
export function readExperimentSelection(ids: string[], consume: (experiment: Experiment) => void): void {
  parseTrialSelection({ experimentIds: ids });
  readFrozenSelection(ids, consume);
}
export function readDistributionSelection(ids: string[], consume: (experiment: Experiment) => void): void {
  readFrozenSelection(parseDistributionIds(ids), consume);
}
function readFrozenSelection(ids: string[], consume: (experiment: Experiment) => void): void {
  getDrizzleDb().transaction(tx => {
    const bound = tx.select({ count: count(), bytes: sql<number>`coalesce(sum(length(cast(${experiments.data} as blob))), 0)`, largest: sql<number>`coalesce(max(length(cast(${experiments.data} as blob))), 0)` })
      .from(experiments).where(inArray(experiments.id, ids)).get()!;
    if (bound.count !== ids.length) throw new EvaluationError("Experiment not found", 404);
    if (bound.bytes > MAX_TRIAL_ACQUISITION_BYTES) throw new EvaluationError("Selected experiment evidence exceeds 8 MiB", 413);
    if (!Number.isSafeInteger(bound.bytes) || bound.largest > L.MAX_EXPERIMENT) throw new EvaluationError("Individual experiment evidence exceeds 4 MiB", 413);
    for (const id of ids) {
      const row = tx.select({ data: experiments.data }).from(experiments).where(eq(experiments.id, id)).get()!;
      let experiment: Experiment;
      try { experiment = JSON.parse(row.data) as Experiment; }
      catch { throw new EvaluationError("Frozen experiment evidence is invalid", 409); }
      validateFrozenDefinitions(experiment);
      consume(experiment);
    }
  });
}
export function listExperiments(): ExperimentSummary[] {
  return getDrizzleDb().select({ summary: experiments.summary }).from(experiments).orderBy(desc(experiments.created_at)).limit(50).all()
    .map((row) => JSON.parse(row.summary));
}
export function activeExperiments() {
  return getDrizzleDb().select({ id: experiments.id }).from(experiments).where(inArray(experiments.status, ["queued", "running"])).all();
}

/** All progress and terminal writes compare the job token and require a nonterminal row. */
export function updateExperiment(experiment: Experiment, token: string, completedChecks: number): boolean {
  const data = encoded(experiment);
  return getDrizzleDb().update(experiments).set({ data, summary: JSON.stringify(summarize(experiment)), status: experiment.status,
    completed_checks: completedChecks, completed_at: experiment.completedAt })
    .where(and(eq(experiments.id, experiment.id), eq(experiments.job_token, token), inArray(experiments.status, ["queued", "running"])))
    .returning({ id: experiments.id }).all().length === 1;
}

export function listReviews(experimentId: string): Review[] {
  getExperiment(experimentId);
  return getDrizzleDb().select().from(reviews).where(eq(reviews.experiment_id, experimentId)).orderBy(desc(reviews.created_at), desc(reviews.id)).all()
    .map((row) => ({ id: row.id, experimentId: row.experiment_id, caseId: row.case_id, rating: row.rating as Review["rating"], note: row.note, createdAt: row.created_at }));
}
export function addReview(experimentId: string, draft: { caseId: string; rating: Review["rating"]; note: string }): Review {
  const experiment = getExperiment(experimentId);
  if (!experiment.results.some((result) => result.caseId === draft.caseId)) throw new EvaluationError("Review case is not part of this experiment", 400);
  return getDrizzleDb().transaction((tx) => {
    const previous = tx.select({ createdAt: reviews.created_at }).from(reviews).orderBy(desc(reviews.created_at)).limit(1).get();
    const review: Review = { id: randomUUID(), experimentId, ...draft, createdAt: Math.max(Date.now(), (previous?.createdAt ?? 0) + 1) };
    tx.insert(reviews).values({ id: review.id, experiment_id: experimentId, case_id: review.caseId, rating: review.rating, note: review.note, created_at: review.createdAt }).run();
    const old = tx.select({ id: reviews.id }).from(reviews).orderBy(desc(reviews.created_at), desc(reviews.id)).limit(L.MAX_REVIEWS).offset(L.MAX_REVIEWS).all();
    if (old.length) tx.delete(reviews).where(inArray(reviews.id, old.map((row) => row.id))).run();
    return review;
  });
}

/** Local curation is one publication: dataset revision, terminal items, and retry receipt. */
export function promoteApprovedReviewItems(rawRequest: PromotionRequest): PromotionReceipt {
  const request = parsePromotionRequest(rawRequest);
  return getDrizzleDb().transaction(tx => {
    const previous = findReviewPromotion(request.queueId, request.idempotencyKey);
    if (previous) {
      if (reviewHash(previous.request) !== reviewHash(request)) throw new ReviewQueueError("idempotency_conflict", "Promotion identity changed; use the original request for retry", 409);
      return previous.receipt;
    }
    const queue = readReviewQueue(request.queueId);
    const dataset = tx.select().from(datasets).where(eq(datasets.id, request.datasetId)).get();
    if (!dataset) throw new EvaluationError("Dataset not found", 404);
    if (dataset.latest_version !== request.expectedDatasetVersion) throw new ReviewQueueError("revision_conflict", "Dataset changed; retain selection and reload the latest revision", 409);
    const row = tx.all<{ cases: string | null; hash: string }>(sql`SELECT CASE WHEN length(CAST(cases AS BLOB))<=${L.MAX_REQUEST} THEN cases END AS cases,hash
      FROM evaluation_revisions WHERE dataset_id=${request.datasetId} AND version=${request.expectedDatasetVersion}`)[0];
    if (!row || row.cases === null) throw new ReviewQueueError("integrity_conflict", "Dataset revision is unavailable within its byte limit", 409);
    const priorCases: DatasetCase[] = JSON.parse(row.cases);
    if (!Array.isArray(priorCases) || priorCases.length > L.MAX_CASES || priorCases.length + request.items.length > L.MAX_CASES
      || createHash("sha256").update(canonicalCaseDefinitions(priorCases)).digest("hex") !== row.hash) throw new ReviewQueueError("integrity_conflict", "Dataset revision or case budget is invalid", 409);
    const items = request.items.map(ref => {
      const item = readReviewItem(request.queueId, ref.itemId, queue.schema);
      if (item.revision !== ref.expectedRevision || item.state !== "approved") throw new ReviewQueueError("revision_conflict", "Approved review item changed before promotion", 409);
      return item;
    });
    const additions = items.map(item => compileReviewCase(queue.id, item.id, queue.schema, item.draft, item.source));
    if (additions.some(item => priorCases.some(prior => prior.id === item.id))) throw new ReviewQueueError("revision_conflict", "A curated case already exists in this dataset", 409);
    const cases = [...priorCases, ...additions];
    const portable = { format: "runphantom-evaluations/v1", name: dataset.name,
      cases: cases.map(({ name, input, tags, rules }) => ({ name, ...(input === null ? {} : { input }), tags, rules })) };
    parseDatasetExport(portable);
    if (Buffer.byteLength(JSON.stringify(portable, null, 2)) > L.MAX_REQUEST || Buffer.byteLength(JSON.stringify(cases)) > L.MAX_REQUEST) throw new EvaluationError("Dataset exceeds the portable size limit", 413);
    const requestJson = canonicalReviewJson(request);
    assertReviewRetention(Buffer.byteLength(requestJson), 0, 0, 1);
    const revision = appendRevisionInTransaction(tx, dataset.id, request.expectedDatasetVersion, cases);
    const receipt: PromotionReceipt = { promotionId: reviewHash([queue.id, request.idempotencyKey]), datasetId: dataset.id,
      datasetVersion: revision.version, datasetHash: revision.hash, itemIds: items.map(item => item.id), caseIds: additions.map(item => item.id), createdAt: revision.createdAt };
    const resultJson = canonicalReviewJson(receipt);
    assertReviewRetention(Buffer.byteLength(requestJson) + Buffer.byteLength(resultJson), 0, 0, 1);
    for (const item of items) persistReviewMutation(markReviewPromoted(item, queue.schema, item.revision,
      { datasetId: dataset.id, datasetVersion: revision.version }, Math.max(revision.createdAt, item.updatedAt)), item.revision);
    tx.run(sql`INSERT INTO review_queue_promotions(id,queue_id,idempotency_key,request_hash,request_json,dataset_id,dataset_version,dataset_hash,result_json,created_at)
      VALUES(${receipt.promotionId},${queue.id},${request.idempotencyKey},${reviewHash(request)},${requestJson},${receipt.datasetId},${receipt.datasetVersion},${receipt.datasetHash},${resultJson},${receipt.createdAt})`);
    return receipt;
  }, { behavior: "immediate" });
}
