import { randomUUID } from "node:crypto";
import type { EvidenceOwner } from "../evaluations/evidence-inventory";
import { EvidenceError, type EvidenceAttachment, type EvidenceCapability, type EvidenceSetView } from "../evaluations/evidence-protocol";
import { canonicalEvidenceJson, evidenceDigest, evidenceInteger, evidenceObject, evidenceSha256, evidenceText, parseEvidenceAttachment } from "../evaluations/evidence-validation";
import { strictEvidenceJson } from "../evaluations/evidence-reader/json";
import { readerLimits } from "../evaluations/evidence-reader/limits";
import { completionEnabled, observeCompletion, parseCompletionRequest } from "./report";
import { currentCompletionReport } from "./service";
import { COMPLETION_DETECTOR, type CompletionDisabled, type CompletionHistory, type CompletionReport, type CompletionSavedReport, type CompletionRequest } from "./protocol";
import { COMPLETION_STORAGE_LIMITS as L } from "./storage";

interface CompletionStoreOptions {
  detector?: { version: string; observe(request: CompletionRequest, view: EvidenceSetView): CompletionReport };
  maxBytes?: number;
  maxReports?: number;
  now?: () => number;
}
interface ReportRow { id: string; generation: number; operationKey: string; requestDigest: string; attachmentKind: string; attachmentId: string; setId: string; revision: number; detectorVersion: string; summarySha256: string; digest: string; bytes: number; createdAt: number }
const boundedText = (column: string, alias: string, max: number, min = 1) => `CASE WHEN typeof(${column})='text' AND length(cast(${column} AS BLOB)) BETWEEN ${min} AND ${max} THEN ${column} ELSE NULL END AS ${alias}`;
const columns = [boundedText("id", "id", 128), "scope_generation AS generation", boundedText("operation_key", "operationKey", 128), boundedText("request_digest", "requestDigest", 64, 64),
  boundedText("attachment_kind", "attachmentKind", 10), boundedText("attachment_id", "attachmentId", 128), boundedText("set_id", "setId", 128), "set_revision AS revision",
  boundedText("detector_version", "detectorVersion", 64), boundedText("summary_sha256", "summarySha256", 64, 64), boundedText("payload_digest", "digest", 64, 64), "payload_bytes AS bytes", "created_at AS createdAt"].join(",");


export class CompletionStore {
  readonly #key: string;
  readonly #maxBytes: number;
  readonly #maxReports: number;
  readonly #detectorVersion: string;
  constructor(readonly owner: EvidenceOwner, readonly options: CompletionStoreOptions = {}) {
    this.#key = `${owner.scope.kind}:${owner.scope.id}`;
    this.#maxBytes = evidenceInteger(options.maxBytes ?? L.SCOPE_BYTES, "completion byte quota", L.SCOPE_BYTES, 1);
    this.#maxReports = evidenceInteger(options.maxReports ?? L.SCOPE_REPORTS, "completion report quota", L.SCOPE_REPORTS, 1);
    this.#detectorVersion = evidenceText(options.detector?.version ?? COMPLETION_DETECTOR, "detector version", 64);
  }
  #generation(): number {
    const row = this.owner.database.query("SELECT generation,active FROM evaluation_evidence_scopes WHERE scope_key=?").get(this.#key) as { generation: number; active: number } | null;
    if (row?.active !== 1) throw new EvidenceError("Completion scope is unavailable", 404);
    return evidenceInteger(row.generation, "completion scope generation", Number.MAX_SAFE_INTEGER, 1);
  }
  #current<T>(attachmentValue: unknown, work: (attachment: EvidenceAttachment, generation: number) => T, capability: EvidenceCapability = "normalized_read"): T {
    if (this.owner.scope.kind !== "local") throw new EvidenceError("Completion observer is unavailable for this scope", 403);
    const attachment = parseEvidenceAttachment(attachmentValue);
    return this.owner.database.transaction(() => {
      this.owner.authorize(capability, null); this.owner.authorize(capability, attachment); this.owner.resolveAnchor(attachment);
      const generation = this.#generation(), result = work(attachment, generation);
      this.owner.authorize(capability, null); this.owner.authorize(capability, attachment); this.owner.resolveAnchor(attachment);
      if (this.#generation() !== generation) throw new EvidenceError("Completion scope changed", 409);
      return result;
    }).immediate();
  }
  #budget(): { reports: number; bytes: number } {
    const budget = this.owner.database.query(`SELECT count(*) AS reports,
      coalesce(sum(CASE WHEN p.data IS NOT NULL THEN length(cast(p.data AS BLOB)) ELSE 0 END),0) AS bytes,
      coalesce(max(CASE WHEN p.data IS NOT NULL AND (typeof(p.data)!='text' OR length(cast(p.data AS BLOB))!=r.payload_bytes OR length(cast(p.data AS BLOB)) NOT BETWEEN 1 AND ${L.PAYLOAD_BYTES}) THEN 1 ELSE 0 END),0) AS mismatch
      FROM evaluation_completion_reports r LEFT JOIN evaluation_completion_payloads p ON p.scope_key=r.scope_key AND p.report_id=r.id WHERE r.scope_key=?`).get(this.#key) as { reports: number; bytes: number; mismatch: number };
    if (budget.reports > L.SCOPE_REPORTS || budget.bytes > L.SCOPE_BYTES) throw new EvidenceError("Completion retained scope exceeds its bounded quota", 409);
    if (budget.mismatch !== 0) throw new EvidenceError("Stored completion payload size integrity check failed", 409);
    return budget;
  }
  #row(id: string, generation: number): ReportRow {
    this.#budget();
    const row = this.owner.database.query(`SELECT ${columns} FROM evaluation_completion_reports WHERE scope_key=? AND scope_generation=? AND id=?`).get(this.#key, generation, evidenceText(id, "completion report ID")) as ReportRow | null;
    if (!row) throw new EvidenceError("Completion report not found", 404);
    evidenceText(row.id, "stored report ID"); evidenceText(row.operationKey, "stored operation key"); evidenceText(row.setId, "stored set ID"); evidenceText(row.attachmentId, "stored attachment ID"); evidenceText(row.detectorVersion, "stored detector version", 64);
    evidenceSha256(row.requestDigest); evidenceSha256(row.summarySha256); evidenceSha256(row.digest);
    evidenceInteger(row.bytes, "stored report bytes", L.PAYLOAD_BYTES, 1); evidenceInteger(row.createdAt, "stored report time"); evidenceInteger(row.revision, "stored report revision", Number.MAX_SAFE_INTEGER, 1);
    return row;
  }
  #read(row: ReportRow, attachment: EvidenceAttachment): CompletionSavedReport {
    if (row.attachmentKind !== attachment.kind || row.attachmentId !== attachment.id) throw new EvidenceError("Completion report belongs to a different attachment", 409);
    const view = this.owner.store.getSet(row.setId, row.revision);
    if (view.revision.scopeGeneration !== row.generation || canonicalEvidenceJson(view.revision.attachment) !== canonicalEvidenceJson(attachment)) throw new EvidenceError("Completion source identity changed", 409);
    if (!view.sources.some(source => source.normalizedAvailable)) throw new EvidenceError("Completion report source was removed", 404);
    const payload = this.owner.database.query(`SELECT CASE WHEN typeof(data)='text' AND length(cast(data AS BLOB))<=${L.PAYLOAD_BYTES} THEN data ELSE NULL END AS data FROM evaluation_completion_payloads WHERE scope_key=? AND report_id=?`).get(this.#key, row.id) as { data: string | null } | null;
    if (!payload) throw new EvidenceError("Completion report payload was removed", 404);
    try {
      if (payload.data === null || Buffer.byteLength(payload.data) !== row.bytes || evidenceDigest(payload.data) !== row.digest) throw Error("Payload digest mismatch");
      const stored = evidenceObject(strictEvidenceJson(payload.data, readerLimits({ maxDepth: 16 })), ["id", "createdAt", "request", "report"], "stored completion report");
      const request = parseCompletionRequest(stored.request), report = stored.report as CompletionReport;
      if (stored.id !== row.id || stored.createdAt !== row.createdAt || Buffer.byteLength(request.summary) > L.SUMMARY_BYTES || request.setId !== row.setId || request.revision !== row.revision || canonicalEvidenceJson(request.attachment) !== canonicalEvidenceJson(attachment) || evidenceDigest(request.summary) !== row.summarySha256) throw Error("Stored request identity changed");
      if (evidenceDigest(canonicalEvidenceJson({ request, detectorVersion: row.detectorVersion })) !== row.requestDigest) throw Error("Stored request digest changed");
      validateStoredReport(request, report, row.detectorVersion);
      const saved = { id: row.id, createdAt: row.createdAt, request, report };
      if (canonicalEvidenceJson(saved) !== payload.data) throw Error("Noncanonical stored report");
      return saved;
    } catch { throw new EvidenceError("Stored completion report integrity check failed", 409); }
  }
  create(value: { enabled: false }): CompletionDisabled;
  create(value: { enabled: true; [key: string]: unknown }): CompletionSavedReport;
  create(value: unknown): CompletionSavedReport | CompletionDisabled;
  create(value: unknown): CompletionSavedReport | CompletionDisabled {
    if (!completionEnabled(value)) return observeCompletion(value, null) as CompletionDisabled;
    const source = evidenceObject(value, ["enabled", "attachment", "setId", "revision", "summary", "assertions", "operationKey"], "completion creation");
    const operationKey = evidenceText(source.operationKey, "completion operation key"); delete source.operationKey;
    const request = parseCompletionRequest(source);
    if (Buffer.byteLength(request.summary) > L.SUMMARY_BYTES) throw new EvidenceError("Stored completion summaries are limited to 16 KiB of full UTF-8 text", 413);
    return this.#current(request.attachment, (attachment, generation) => {
      const quota = this.#budget();
      const observed = currentCompletionReport(this.owner, request);
      if (observed.state !== "enabled") throw new EvidenceError("Completion observer was disabled", 409);
      const requestDigest = evidenceDigest(canonicalEvidenceJson({ request, detectorVersion: this.#detectorVersion }));
      const prior = this.owner.database.query("SELECT id,request_digest AS digest FROM evaluation_completion_reports WHERE scope_key=? AND scope_generation=? AND operation_key=?").get(this.#key, generation, operationKey) as { id: string; digest: string } | null;
      if (prior) {
        if (prior.digest !== requestDigest) throw new EvidenceError("Completion operation key is already bound to another request or detector", 409);
        return this.#read(this.#row(prior.id, generation), attachment);
      }
      const report = this.options.detector?.observe(request, this.owner.store.getSet(request.setId, request.revision)) ?? observed;
      validateStoredReport(request, report, this.#detectorVersion);
      const saved = { id: randomUUID(), createdAt: evidenceInteger((this.options.now ?? Date.now)(), "completion creation time"), request, report }, data = canonicalEvidenceJson(saved), bytes = Buffer.byteLength(data);
      if (bytes > L.PAYLOAD_BYTES) throw new EvidenceError("Completion report exceeds its retained payload boundary", 413);

      if (quota.reports >= this.#maxReports || quota.bytes + bytes > this.#maxBytes) throw new EvidenceError("Completion report retention quota is full", 409);
      this.owner.database.query("INSERT INTO evaluation_completion_reports(scope_key,scope_generation,id,operation_key,request_digest,attachment_kind,attachment_id,set_id,set_revision,detector_version,summary_sha256,payload_digest,payload_bytes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(this.#key, generation, saved.id, operationKey, requestDigest, attachment.kind, attachment.id, request.setId, request.revision, this.#detectorVersion, report.source.sha256, evidenceDigest(data), bytes, saved.createdAt);
      this.owner.database.query("INSERT INTO evaluation_completion_payloads(scope_key,report_id,data) VALUES(?,?,?)").run(this.#key, saved.id, data);
      return saved;
    }, "import");
  }
  get(id: string, attachment: unknown): CompletionSavedReport { return this.#current(attachment, (selected, generation) => this.#read(this.#row(id, generation), selected)); }
  list(attachment: unknown, offset = 0): CompletionHistory {
    offset = evidenceInteger(offset, "completion history offset", L.SCOPE_REPORTS);
    return this.#current(attachment, (selected, generation) => {
      this.#budget();
      const where = "r.scope_key=? AND r.scope_generation=? AND r.attachment_kind=? AND r.attachment_id=?", bindings = [this.#key, generation, selected.kind, selected.id] as const;
      const total = (this.owner.database.query(`SELECT count(*) AS n FROM evaluation_completion_reports r WHERE ${where}`).get(...bindings) as { n: number }).n;
      if (total > L.SCOPE_REPORTS) throw new EvidenceError("Completion history metadata exceeds its boundary", 409);
      const rows = this.owner.database.query(`SELECT ${boundedText("r.id", "id", 128)},${boundedText("r.set_id", "setId", 128)},r.set_revision AS revision,${boundedText("r.detector_version", "detectorVersion", 64)},r.created_at AS createdAt,EXISTS(SELECT 1 FROM evaluation_completion_payloads p WHERE p.scope_key=r.scope_key AND p.report_id=r.id) AS available FROM evaluation_completion_reports r WHERE ${where} ORDER BY r.created_at DESC,r.id ASC LIMIT ? OFFSET ?`).all(...bindings, L.PAGE_REPORTS, offset) as { id: string; setId: string; revision: number; detectorVersion: string; createdAt: number; available: number }[];
      const items = rows.map(row => ({ id: evidenceText(row.id, "stored report ID"), setId: evidenceText(row.setId, "stored set ID"), revision: evidenceInteger(row.revision, "stored source revision", Number.MAX_SAFE_INTEGER, 1), detectorVersion: evidenceText(row.detectorVersion, "stored detector", 64), createdAt: evidenceInteger(row.createdAt, "stored report time"), payloadAvailable: row.available === 1 }));
      return { items, total, offset, hasMore: offset + items.length < total };
    });
  }
}

function validateStoredReport(request: CompletionRequest, value: unknown, detectorVersion: string): asserts value is CompletionReport {
  const report = evidenceObject(value, ["version", "detectorVersion", "state", "selected", "source", "coverage", "observations", "authority", "authentication"], "stored observer report");
  if (report.version !== 1 || report.detectorVersion !== detectorVersion || report.state !== "enabled" || report.authority !== "report_only" || report.authentication !== "not_authenticated") throw new EvidenceError("Stored observer version is incompatible", 409);
  if (canonicalEvidenceJson(report.selected) !== canonicalEvidenceJson({ attachment: request.attachment, setId: request.setId, revision: request.revision })) throw new EvidenceError("Stored observer selection changed", 409);
  const source = evidenceObject(report.source, ["kind", "sha256", "totalBytes", "inspectedBytes", "partial"], "stored summary provenance"), totalBytes = Buffer.byteLength(request.summary);
  if (source.kind !== "operator_summary" || source.sha256 !== evidenceDigest(request.summary) || source.totalBytes !== totalBytes || typeof source.partial !== "boolean") throw new EvidenceError("Stored summary identity changed", 409);
  evidenceInteger(source.inspectedBytes, "inspected summary bytes", Math.min(totalBytes, L.SUMMARY_BYTES));
  const observations = report.observations;
  if (!Array.isArray(observations) || observations.length > 32) throw new EvidenceError("Stored observations exceed their boundary", 409);
  for (const raw of observations) {
    const item = evidenceObject(raw, ["id", "origin", "snippet", "snippetTruncated", "category", "state", "explanation", "reference", "reportedOutcome", "authentication"], "stored observation");
    evidenceText(item.id, "observation ID"); const snippet = evidenceText(item.snippet, "observation snippet", 512, true); evidenceText(item.explanation, "observation explanation", 512);
    if (!["prose", "negated", "conditional", "quoted", "code", "unchecked_task", "checked_task", "question", "structured"].includes(String(item.category)) || !["ambiguous_text", "unsupported_claim", "evidence_available", "evidence_missing", "scope_mismatch", "reported_outcome"].includes(String(item.state)) || item.authentication !== "not_authenticated" || typeof item.snippetTruncated !== "boolean" || ![null, "reports_pass", "reports_fail", "no_tests", "unknown"].includes(item.reportedOutcome as null)) throw new EvidenceError("Stored observation state is incompatible", 409);
    const origin = evidenceObject(item.origin, ["kind", "sha256", "start", "end", "byteStart", "byteEnd"], "stored source interval");
    const text = origin.kind === "operator_summary" ? request.summary : origin.kind === "operator_assertion" ? request.assertions.find(assertion => evidenceDigest(assertion.text) === origin.sha256)?.text : undefined;
    if (text === undefined || evidenceDigest(text) !== origin.sha256) throw new EvidenceError("Stored observation origin changed", 409);
    const start = evidenceInteger(origin.start, "source start", text.length), end = evidenceInteger(origin.end, "source end", text.length, start);
    if (!text.slice(start, end).startsWith(snippet) || origin.byteStart !== Buffer.byteLength(text.slice(0, start)) || origin.byteEnd !== Buffer.byteLength(text.slice(0, end)) || item.snippetTruncated !== (snippet !== text.slice(start, end))) throw new EvidenceError("Stored source offsets changed", 409);
    if (item.reference !== null) { const ref = evidenceObject(item.reference, ["setId", "revision", "sourceId"], "stored reference"); evidenceText(ref.setId, "reference set"); evidenceText(ref.sourceId, "reference source"); evidenceInteger(ref.revision, "reference revision", Number.MAX_SAFE_INTEGER, 1); }
  }
  const coverage = evidenceObject(report.coverage, ["observed", "uncoveredBytes", "observationLimitReached"], "stored observer coverage");
  if (coverage.observed !== observations.length || typeof coverage.observationLimitReached !== "boolean") throw new EvidenceError("Stored coverage changed", 409);
  evidenceInteger(coverage.uncoveredBytes, "uncovered summary bytes", totalBytes);
}
