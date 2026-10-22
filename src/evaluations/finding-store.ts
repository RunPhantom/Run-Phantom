import { randomUUID } from "node:crypto";
import type { EvidenceOwner } from "./evidence-inventory";
import { EvidenceError, type EvidenceAttachment } from "./evidence-protocol";
import { heldNormalizedEvidenceBytes } from "./evidence-store";
import { canonicalEvidenceJson, evidenceArray, evidenceDigest, evidenceInteger, evidenceObject, evidenceSha256, evidenceText, parseEvidenceAttachment } from "./evidence-validation";
import { strictEvidenceJson } from "./evidence-reader/json";
import { readerLimits } from "./evidence-reader/limits";
import { compareFindingBatches, findingPairDigest } from "./finding-diff";
import { FINDING_LIMITS as L, FINDING_POLICY, type FindingBatch, type FindingDelta, type FindingDifference, type FindingMapping, type FindingReference, type FindingComparisonRecord, type FindingComparisonPage } from "./finding-protocol";

import { parseFindingReference } from "./finding-validation";

interface FindingInput { reference: FindingReference; attachment: EvidenceAttachment; identity: { setDigest: string; interpretationId: string; normalizedSha256: string }; batch: FindingBatch | null; retainedUnavailable: boolean }
/** Only a validated frozen source whose retained normalized payload is absent may be omitted from discovery. */
class RetainedFindingUnavailable extends EvidenceError {
  constructor() { super("Current retained finding input is unavailable", 404); }
}
function unavailable(baseline: FindingBatch | null, candidate: FindingBatch | null): FindingDifference {
  const occurrences: FindingDelta[] = [];
  for (const finding of baseline?.findings ?? []) occurrences.push({ baselineId: finding.id, candidateId: null, classification: "unresolved", severityChanged: false, locationChanged: false });
  for (const finding of candidate?.findings ?? []) occurrences.push({ baselineId: null, candidateId: finding.id, classification: "unresolved", severityChanged: false, locationChanged: false });
  return { policy: FINDING_POLICY, authentication: "not_authenticated", interpretation: "unavailable", observed: { baseline: baseline?.findings.length ?? null, candidate: candidate?.findings.length ?? null }, counts: { retained: null, introduced: null, removed: null, unresolved: null }, reasons: ["finding_interpretation_unavailable"], occurrences };
}
type AttemptOutcome = "conditional" | "unavailable" | "invalid_request" | "input_unavailable" | "conflict_or_capacity" | "limit_refused" | "internal_refusal";
interface RuntimeAttempt {
  id: string; outcome: AttemptOutcome;
  stages: { acquisitionWallMs: number | null; matchingWallMs: number | null; serializationWallMs: number | null; persistenceWallMs: number | null; responseWallMs: number | null };
  handlerWallMs: number; cpuMs: null; peakRssBytes: null;
}
/** Local owner only. Every read resolves both immutable inputs through current owner authority in one transaction. */
export class FindingStore {
  #epoch = randomUUID();
  #metricGeneration: number | null = null;
  #attemptCount = 0;
  readonly #outcomes: Record<AttemptOutcome, number> = { conditional: 0, unavailable: 0, invalid_request: 0, input_unavailable: 0, conflict_or_capacity: 0, limit_refused: 0, internal_refusal: 0 };
  readonly #attempts: RuntimeAttempt[] = [];
  constructor(readonly owner: EvidenceOwner) {}
  #key(): string { return `${this.owner.scope.kind}:${this.owner.scope.id}`; }
  #authorize(attachment: EvidenceAttachment | null): void {
    const authority = evidenceObject(this.owner.authorize("compare", attachment), ["actorId"], "finding authority"); evidenceText(authority.actorId, "actor ID");
  }
  #authorized(): number {
    if (this.owner.scope.kind !== "local") throw new EvidenceError("Finding comparison is unavailable for this scope", 403);
    this.#authorize(null);
    const row = this.owner.database.query("SELECT generation,active FROM evaluation_evidence_scopes WHERE scope_key=?").get(this.#key()) as { generation: number; active: number } | null;
    if (!row || row.active !== 1) throw new EvidenceError("Finding scope is unavailable", 404);
    const generation = evidenceInteger(row.generation, "scope generation", Number.MAX_SAFE_INTEGER, 1);
    if (this.#metricGeneration !== generation) {
      this.#metricGeneration = generation; this.#epoch = randomUUID(); this.#attemptCount = 0; this.#attempts.length = 0;
      for (const outcome of Object.keys(this.#outcomes) as AttemptOutcome[]) this.#outcomes[outcome] = 0;
    }
    return generation;
  }
  #transaction<T>(work: (generation: number) => T): T { return this.owner.database.transaction(() => work(this.#authorized())).immediate(); }
  authorizeCurrent(attachment: EvidenceAttachment | null): void { this.#transaction(() => this.#authorize(attachment)); }
  #input(reference: FindingReference, generation: number, discovery = false): FindingInput {
    const view = this.owner.store.getSet(reference.setId, reference.revision);
    this.#authorize(view.revision.attachment);
    if (view.revision.scopeGeneration !== generation || canonicalEvidenceJson(view.revision.scope) !== canonicalEvidenceJson(this.owner.scope)) throw new EvidenceError("Finding input generation changed", 409);
    const source = view.revision.sources.find(item => item.sourceId === reference.sourceId), payload = view.sources.find(item => item.sourceId === reference.sourceId);
    if (!source || source.kind !== "finding") throw new EvidenceError("Current finding input is unavailable", 404);
    if (!payload) throw new EvidenceError("Stored finding source identity changed", 409);
    if (!payload.normalizedAvailable && !discovery) throw new RetainedFindingUnavailable();
    if (payload.normalizedAvailable && !payload.normalized) throw new EvidenceError("Stored finding interpretation is unavailable", 409);
    return { reference, attachment: view.revision.attachment, identity: { setDigest: view.revision.digest, interpretationId: source.interpretationId, normalizedSha256: source.normalizedSha256 }, batch: payload.normalized?.findingBatch ?? null, retainedUnavailable: !payload.normalizedAvailable };
  }
  #stored(table: "evaluation_finding_mappings" | "evaluation_finding_comparisons", id: string, generation: number): unknown {
    const row = this.owner.database.query(`SELECT CASE WHEN typeof(data)='text' AND length(cast(data AS BLOB))<=? THEN data ELSE NULL END AS data,digest FROM ${table} WHERE scope_key=? AND scope_generation=? AND id=?`).get(L.MAX_RECORD_BYTES, this.#key(), generation, evidenceText(id, "finding record ID")) as { data: string | null; digest: string } | null;
    if (!row) throw new EvidenceError("Finding record not found", 404);
    try {
      if (typeof row.data !== "string" || evidenceDigest(row.data) !== evidenceSha256(row.digest)) throw Error("digest");
      const value = strictEvidenceJson(row.data, readerLimits());
      if (canonicalEvidenceJson(value) !== row.data) throw Error("canonical");
      return value;
    } catch { throw new EvidenceError("Stored finding integrity check failed", 409); }
  }
  #mapping(id: string, baseline: FindingInput, candidate: FindingInput, generation: number): FindingMapping {
    const source = evidenceObject(this.#stored("evaluation_finding_mappings", id, generation), ["id", "actor", "policy", "reviewed", "baseline", "candidate", "pairDigest", "paths", "reason", "createdAt"], "reviewed mapping");
    if (source.id !== id || source.actor !== "local_operator" || source.policy !== FINDING_POLICY || source.reviewed !== true || !baseline.batch || !candidate.batch ||
      canonicalEvidenceJson(parseFindingReference(source.baseline)) !== canonicalEvidenceJson(baseline.reference) || canonicalEvidenceJson(parseFindingReference(source.candidate)) !== canonicalEvidenceJson(candidate.reference) ||
      source.pairDigest !== findingPairDigest(baseline.batch, candidate.batch)) throw new EvidenceError("Mapping does not bind these exact immutable inputs", 409);
    return { id, actor: "local_operator", policy: FINDING_POLICY, reviewed: true, baseline: baseline.reference, candidate: candidate.reference, pairDigest: evidenceSha256(source.pairDigest),
      paths: evidenceArray(source.paths, L.MAX_PATHS, "reviewed paths").map(item => { const path = evidenceObject(item, ["baseline", "candidate"], "reviewed path"); return { baseline: evidenceText(path.baseline, "baseline path", 1_024), candidate: evidenceText(path.candidate, "candidate path", 1_024) }; }),
      reason: evidenceText(source.reason, "review reason", 1_024), createdAt: evidenceInteger(source.createdAt, "review time") };
  }
  #capacity(table: "evaluation_finding_mappings" | "evaluation_finding_comparisons", bytes: number): void {
    if (bytes > L.MAX_RECORD_BYTES) throw new EvidenceError("Finding record exceeds 4 MiB", 413);
    const count = (this.owner.database.query(`SELECT count(*) AS n FROM ${table} WHERE scope_key=?`).get(this.#key()) as { n: number }).n;
    if (count >= L.MAX_RECORDS || heldNormalizedEvidenceBytes(this.owner.database, this.#key()) + bytes > this.owner.store.normalizedByteLimit) throw new EvidenceError("Shared evidence normalized storage is full", 409);
  }
  #encode(value: unknown): string {
    const data = canonicalEvidenceJson(value);
    if (Buffer.byteLength(data) > L.MAX_RECORD_BYTES) throw new EvidenceError("Finding record exceeds 4 MiB", 413);
    try { strictEvidenceJson(data, readerLimits()); } catch { throw new EvidenceError("Finding result exceeds its JSON structure budget", 413); }
    return data;
  }
  reviewMapping(value: unknown): FindingMapping {
    return this.#transaction(generation => {
      const input = evidenceObject(value, ["baseline", "candidate", "paths", "reason"], "mapping review"), baseline = this.#input(parseFindingReference(input.baseline), generation), candidate = this.#input(parseFindingReference(input.candidate), generation);
      if (!baseline.batch || !candidate.batch || !baseline.batch.identityAvailable || !candidate.batch.identityAvailable || baseline.batch.repositoryId !== candidate.batch.repositoryId) throw new EvidenceError("Mapping needs available identities from the same declared repository", 409);
      const paths = evidenceArray(input.paths, L.MAX_PATHS, "reviewed paths").map(item => { const path = evidenceObject(item, ["baseline", "candidate"], "reviewed path"); return { baseline: evidenceText(path.baseline, "baseline path", 1_024), candidate: evidenceText(path.candidate, "candidate path", 1_024) }; });
      const mapping: FindingMapping = { id: randomUUID(), actor: "local_operator", policy: FINDING_POLICY, reviewed: true, baseline: baseline.reference, candidate: candidate.reference, pairDigest: findingPairDigest(baseline.batch, candidate.batch), paths, reason: evidenceText(input.reason, "review reason", 1_024), createdAt: Date.now() };
      compareFindingBatches(baseline.batch, candidate.batch, mapping);
      const data = this.#encode(mapping); this.#capacity("evaluation_finding_mappings", Buffer.byteLength(data));
      this.owner.database.query("INSERT INTO evaluation_finding_mappings(scope_key,scope_generation,id,baseline_set,baseline_revision,candidate_set,candidate_revision,data,digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(this.#key(), generation, mapping.id, baseline.reference.setId, baseline.reference.revision, candidate.reference.setId, candidate.reference.revision, data, evidenceDigest(data), mapping.createdAt);
      return mapping;
    });
  }
  compare(value: unknown): FindingComparisonPage { return this.compareWithAttempt(value).page; }
  compareWithAttempt(value: unknown, observeAttempt?: (id: string) => void): { page: FindingComparisonPage; attemptId: string } {
    return this.#transaction(() => {
      if (this.#attemptCount === Number.MAX_SAFE_INTEGER) throw new EvidenceError("Runtime attempt counter is exhausted", 409);
      this.#attemptCount++;
      const started = performance.now(), attempt: RuntimeAttempt = { id: randomUUID(), outcome: "internal_refusal", stages: { acquisitionWallMs: null, matchingWallMs: null, serializationWallMs: null, persistenceWallMs: null, responseWallMs: null }, handlerWallMs: 0, cpuMs: null, peakRssBytes: null };
      try {
        observeAttempt?.(attempt.id);
        const page = this.#compare(value, attempt); attempt.outcome = page.comparison.difference.interpretation;
        return { page, attemptId: attempt.id };
      } catch (error) {
        attempt.outcome = error instanceof EvidenceError ? error.status === 400 ? "invalid_request" : error.status === 404 ? "input_unavailable" : error.status === 413 ? "limit_refused" : error.status === 409 ? "conflict_or_capacity" : "internal_refusal" : "internal_refusal";
        throw error;
      } finally {
        attempt.handlerWallMs = performance.now() - started; this.#outcomes[attempt.outcome]++; this.#attempts.push(attempt); if (this.#attempts.length > 100) this.#attempts.shift();
      }
    });
  }
  metrics(): unknown {
    return this.#transaction(() => ({ epoch: this.#epoch, durability: "process_only_resets_on_restart_or_scope_generation", denominator: "all_attempts_admitted_by_current_compare_authority", admittedAttempts: this.#attemptCount, outcomes: { ...this.#outcomes }, retainedWindow: this.#attempts.length, evictedSamples: this.#attemptCount - this.#attempts.length, attempts: this.#attempts.map(attempt => ({ ...attempt, stages: { ...attempt.stages } })), cpuMs: null, peakRssBytes: null }));
  }
  completeResponse(attemptId: string, wallMs: number): void {
    this.#transaction(() => {
      if (!Number.isFinite(wallMs) || wallMs < 0) throw new EvidenceError("Response duration must be finite");
      const attempt = this.#attempts.find(item => item.id === attemptId); if (attempt) attempt.stages.responseWallMs = wallMs;
    });
  }
  #compare(value: unknown, attempt: RuntimeAttempt): FindingComparisonPage {
    return this.#transaction(generation => {
      const started = performance.now(), input = evidenceObject(value, ["operationKey", "baseline", "candidate", "mappingId"], "finding comparison"), operationKey = evidenceText(input.operationKey, "operation key"), baseline = this.#input(parseFindingReference(input.baseline), generation), candidate = this.#input(parseFindingReference(input.candidate), generation);
      const mappingId = input.mappingId === null || input.mappingId === undefined ? null : evidenceText(input.mappingId, "mapping ID"), mapping = mappingId ? this.#mapping(mappingId, baseline, candidate, generation) : null;
      const requestDigest = evidenceDigest(canonicalEvidenceJson({ generation, baseline: baseline.reference, candidate: candidate.reference, mappingId, policy: FINDING_POLICY }));
      attempt.stages.acquisitionWallMs = performance.now() - started;
      const prior = this.owner.database.query("SELECT id,request_digest FROM evaluation_finding_comparisons WHERE scope_key=? AND scope_generation=? AND operation_key=?").get(this.#key(), generation, operationKey) as { id: string; request_digest: string } | null;
      if (prior) { if (prior.request_digest !== requestDigest) throw new EvidenceError("Comparison operation already identifies different inputs", 409); return this.#page(prior.id, generation, 0, L.MAX_PAGE); }
      const matching = performance.now(), difference = baseline.batch && candidate.batch ? compareFindingBatches(baseline.batch, candidate.batch, mapping) : unavailable(baseline.batch, candidate.batch), serializing = performance.now();
      attempt.stages.matchingWallMs = serializing - matching;
      // Serialize once to measure this real stage; the final bounded record additionally contains these measured timings.
      canonicalEvidenceJson(difference);
      attempt.stages.serializationWallMs = performance.now() - serializing;
      const record: FindingComparisonRecord = { id: randomUUID(), operationKey, baseline: baseline.reference, candidate: candidate.reference, mappingId, baselineIdentity: baseline.identity, candidateIdentity: candidate.identity, difference, createdAt: Date.now(),
        timing: { sampleId: randomUUID(), acquisitionWallMs: matching - started, matchingWallMs: serializing - matching, serializationWallMs: performance.now() - serializing, cpuMs: null, peakRssBytes: null } };
      const data = this.#encode(record); this.#capacity("evaluation_finding_comparisons", Buffer.byteLength(data));
      const persisting = performance.now();
      this.owner.database.query("INSERT INTO evaluation_finding_comparisons(scope_key,scope_generation,id,operation_key,request_digest,baseline_set,baseline_revision,candidate_set,candidate_revision,baseline_attachment_kind,baseline_attachment_id,candidate_attachment_kind,candidate_attachment_id,mapping_id,data,digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(this.#key(), generation, record.id, operationKey, requestDigest, baseline.reference.setId, baseline.reference.revision, candidate.reference.setId, candidate.reference.revision, baseline.attachment.kind, baseline.attachment.id, candidate.attachment.kind, candidate.attachment.id, mappingId, data, evidenceDigest(data), record.createdAt);
      attempt.stages.persistenceWallMs = performance.now() - persisting;
      return this.#page(record.id, generation, 0, L.MAX_PAGE);
    });
  }
  #record(id: string, generation: number): { record: FindingComparisonRecord; baseline: FindingInput; candidate: FindingInput } {
    const source = evidenceObject(this.#stored("evaluation_finding_comparisons", id, generation), ["id", "operationKey", "baseline", "candidate", "mappingId", "baselineIdentity", "candidateIdentity", "difference", "createdAt", "timing"], "stored comparison");
    const baseline = this.#input(parseFindingReference(source.baseline), generation, true), candidate = this.#input(parseFindingReference(source.candidate), generation, true), mappingId = source.mappingId === null ? null : evidenceText(source.mappingId, "mapping ID");
    if (source.id !== id || canonicalEvidenceJson(source.baselineIdentity) !== canonicalEvidenceJson(baseline.identity) || canonicalEvidenceJson(source.candidateIdentity) !== canonicalEvidenceJson(candidate.identity)) throw new EvidenceError("Frozen finding identity changed", 409);
    // Resolve BOTH current inputs before deciding whether this historical entry is unavailable.
    // A retained deletion must never hide a different input's authorization or integrity failure.
    if (baseline.retainedUnavailable || candidate.retainedUnavailable) {
      if (mappingId) this.#stored("evaluation_finding_mappings", mappingId, generation);
      throw new RetainedFindingUnavailable();
    }
    const mapping = mappingId ? this.#mapping(mappingId, baseline, candidate, generation) : null;
    const difference = baseline.batch && candidate.batch ? compareFindingBatches(baseline.batch, candidate.batch, mapping) : unavailable(baseline.batch, candidate.batch);
    if (source.id !== id || canonicalEvidenceJson(source.baselineIdentity) !== canonicalEvidenceJson(baseline.identity) || canonicalEvidenceJson(source.candidateIdentity) !== canonicalEvidenceJson(candidate.identity) || canonicalEvidenceJson(source.difference) !== canonicalEvidenceJson(difference)) throw new EvidenceError("Frozen finding identity or result changed", 409);
    const timing = evidenceObject(source.timing, ["sampleId", "acquisitionWallMs", "matchingWallMs", "serializationWallMs", "cpuMs", "peakRssBytes"], "comparison timings");
    for (const key of ["acquisitionWallMs", "matchingWallMs", "serializationWallMs"]) if (typeof timing[key] !== "number" || !Number.isFinite(timing[key]) || (timing[key] as number) < 0) throw new EvidenceError("Stored timings are unavailable", 409);
    if (timing.cpuMs !== null || timing.peakRssBytes !== null) throw new EvidenceError("Unmeasured CPU and RSS must remain unavailable", 409);
    evidenceText(timing.sampleId, "sample ID");
    return { record: { id, operationKey: evidenceText(source.operationKey, "operation key"), baseline: baseline.reference, candidate: candidate.reference, mappingId, baselineIdentity: baseline.identity, candidateIdentity: candidate.identity, difference, createdAt: evidenceInteger(source.createdAt, "comparison time"), timing: timing as unknown as FindingComparisonRecord["timing"] }, baseline, candidate };
  }
  #page(id: string, generation: number, offset: number, limit: number): FindingComparisonPage {
    const { record, baseline, candidate } = this.#record(id, generation), { occurrences, ...summary } = record.difference;
    const a = new Map(baseline.batch?.findings.map(item => [item.id, item])), b = new Map(candidate.batch?.findings.map(item => [item.id, item]));
    return { comparison: { ...record, difference: summary }, page: { offset, limit, total: occurrences.length, items: occurrences.slice(offset, offset + limit).map(item => ({ ...item, baseline: item.baselineId ? a.get(item.baselineId)! : null, candidate: item.candidateId ? b.get(item.candidateId)! : null })) } };
  }
  get(id: string, offset = 0, limit: number = L.MAX_PAGE): FindingComparisonPage { return this.#transaction(generation => this.#page(id, generation, evidenceInteger(offset, "offset", L.MAX_PAIR), evidenceInteger(limit, "page limit", L.MAX_PAGE, 1))); }
  current(id: string, value: unknown): { id: string; current: true } {
    return this.#transaction(generation => {
      const attachment = parseEvidenceAttachment(value); this.#authorize(attachment);
      const { record, baseline, candidate } = this.#record(id, generation);
      if (![baseline.attachment, candidate.attachment].some(anchor => canonicalEvidenceJson(anchor) === canonicalEvidenceJson(attachment))) throw new EvidenceError("Comparison does not belong to this current attachment", 409);
      return { id: record.id, current: true };
    });
  }
  export(id: string): unknown {
    return this.#transaction(generation => {
      const { record, baseline, candidate } = this.#record(id, generation), value = { format: "runphantom-finding-comparison/v1", comparison: record, baseline: baseline.batch, candidate: candidate.batch };
      if (Buffer.byteLength(canonicalEvidenceJson(value)) > L.MAX_RECORD_BYTES) throw new EvidenceError("Finding export exceeds 4 MiB; use paginated results", 413);
      return value;
    });
  }
  list(value: unknown): { items: { id: string; createdAt: number }[]; truncated: boolean } {
    return this.#transaction(generation => {
      const attachment = parseEvidenceAttachment(value); this.#authorize(attachment);
      const rows = this.owner.database.query("SELECT id FROM evaluation_finding_comparisons WHERE scope_key=? AND scope_generation=? AND ((baseline_attachment_kind=? AND baseline_attachment_id=?) OR (candidate_attachment_kind=? AND candidate_attachment_id=?)) ORDER BY created_at DESC,id LIMIT 51").all(this.#key(), generation, attachment.kind, attachment.id, attachment.kind, attachment.id) as { id: string }[];
      const items: { id: string; createdAt: number }[] = [];
      for (const row of rows) {
        try {
          const { record, baseline, candidate } = this.#record(row.id, generation);
          if ([baseline.attachment, candidate.attachment].some(anchor => canonicalEvidenceJson(anchor) === canonicalEvidenceJson(attachment))) items.push({ id: record.id, createdAt: record.createdAt });
        } catch (error) {
          if (!(error instanceof RetainedFindingUnavailable)) throw error;
        }
      }
      return { items: items.slice(0, 50), truncated: rows.length > 50 };
    });
  }
}
