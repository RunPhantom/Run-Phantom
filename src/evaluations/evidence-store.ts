import { randomUUID } from "node:crypto";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { EVIDENCE_LIMITS as L, EVIDENCE_VERSION, EvidenceError, type EvidenceAttachment, type EvidenceCapability,
  type EvidenceExpectedSource, type EvidenceImportRequest, type EvidenceInventoryRevision, type EvidenceJob,
  type EvidencePublicationSource, type EvidenceReason, type EvidenceReportReference, type EvidenceScope, type EvidenceSetRevision, type EvidenceSetView,
  type EvidenceSourceObservation, type NormalizedEvidenceSource } from "./evidence-protocol";
import { canonicalEvidenceJson, evidenceArray, evidenceDigest, evidenceInteger, evidenceObject, evidenceText,
  parseEvidenceExpectedSources, parseEvidenceImportRequest, parseEvidenceScope, parseNormalizedEvidence } from "./evidence-validation";

/** Inactive DDL: only the migration coordinator may install this in an application database. */
export const EVIDENCE_STORAGE_SQL = `
CREATE TABLE evaluation_evidence_scopes (
  scope_key TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK(generation>0), active INTEGER NOT NULL CHECK(active IN (0,1))
);
CREATE TABLE evaluation_evidence_inventory_heads (
  scope_key TEXT NOT NULL REFERENCES evaluation_evidence_scopes(scope_key) ON DELETE CASCADE,
  id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), PRIMARY KEY(scope_key,id)
);
CREATE TABLE evaluation_evidence_inventories (
  scope_key TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
  data TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(scope_key,id,revision),
  FOREIGN KEY(scope_key,id) REFERENCES evaluation_evidence_inventory_heads(scope_key,id) ON DELETE CASCADE
);
CREATE TABLE evaluation_evidence_jobs (
  id TEXT PRIMARY KEY, scope_key TEXT NOT NULL REFERENCES evaluation_evidence_scopes(scope_key) ON DELETE CASCADE,
  scope_generation INTEGER NOT NULL, operation_key TEXT NOT NULL, request_digest TEXT NOT NULL, request_data TEXT NOT NULL,
  inventory_data TEXT, status TEXT NOT NULL CHECK(status IN ('queued','running','completed','cancelled','failed')),
  job_token TEXT NOT NULL, admitted_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL,
  reserved_raw_bytes INTEGER NOT NULL CHECK(reserved_raw_bytes>=0), reserved_normalized_bytes INTEGER NOT NULL CHECK(reserved_normalized_bytes>=0),
  set_id TEXT, failure_code TEXT, UNIQUE(scope_key,scope_generation,operation_key)
);
CREATE INDEX evaluation_evidence_jobs_status ON evaluation_evidence_jobs(status);
CREATE TABLE evaluation_evidence_artifacts (
  scope_key TEXT NOT NULL, id TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES evaluation_evidence_jobs(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL, sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length>=0),
  PRIMARY KEY(scope_key,id), UNIQUE(job_id,source_id)
);
CREATE TABLE evaluation_evidence_blobs (
  scope_key TEXT NOT NULL, artifact_id TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(scope_key,artifact_id),
  FOREIGN KEY(scope_key,artifact_id) REFERENCES evaluation_evidence_artifacts(scope_key,id) ON DELETE CASCADE
);
CREATE TABLE evaluation_evidence_interpretations (
  scope_key TEXT NOT NULL, id TEXT NOT NULL, artifact_id TEXT NOT NULL, normalized_sha256 TEXT NOT NULL,
  parser_version TEXT NOT NULL, policy_version TEXT NOT NULL, configuration_sha256 TEXT NOT NULL, dialect TEXT NOT NULL,
  PRIMARY KEY(scope_key,id), FOREIGN KEY(scope_key,artifact_id) REFERENCES evaluation_evidence_artifacts(scope_key,id) ON DELETE CASCADE
);
CREATE TABLE evaluation_evidence_payloads (
  scope_key TEXT NOT NULL, interpretation_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope_key,interpretation_id),
  FOREIGN KEY(scope_key,interpretation_id) REFERENCES evaluation_evidence_interpretations(scope_key,id) ON DELETE CASCADE
);
CREATE TABLE evaluation_evidence_sets (
  scope_key TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
  job_id TEXT NOT NULL UNIQUE REFERENCES evaluation_evidence_jobs(id) ON DELETE CASCADE,
  data TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(scope_key,id,revision)
);
CREATE TABLE evaluation_evidence_retention_events (
  id TEXT PRIMARY KEY, scope_key TEXT NOT NULL REFERENCES evaluation_evidence_scopes(scope_key) ON DELETE CASCADE,
  set_id TEXT NOT NULL, revision INTEGER NOT NULL, target_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('raw_removed','normalized_removed')), actor_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
${["inventories", "artifacts", "blobs", "interpretations", "payloads", "sets", "retention_events"].map(table =>
  `CREATE TRIGGER evaluation_evidence_${table}_immutable BEFORE UPDATE ON evaluation_evidence_${table} BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;`).join("\n")}
`;

export interface EvidenceStoreOptions {
  /** Must check the current session, role, attachment and project in THIS injected database transaction.
   * The callback is trusted owner code, never a caller capability or a cached ProjectContext.
   * Team integrations must construct inside their private TeamStore; no local database fallback is allowed.
   * Returning a promise, using network work or retaining this decision outside the transaction is forbidden.
   */
  authorize: (capability: EvidenceCapability, scope: EvidenceScope, attachment: EvidenceAttachment | null) => { actorId: string };
  now?: () => number;
  maxRawBytes?: number;
  maxNormalizedBytes?: number;
  maxRevisions?: number;
}
interface JobRow {
  id: string; scope_generation: number; request_digest: string; request_data: string; inventory_data: string | null;
  status: EvidenceJob["status"]; job_token: string; admitted_at: number; deadline_at: number; set_id: string | null; failure_code: EvidenceJob["failureCode"];
}
export class EvidenceStore {
  readonly #db: Database;
  readonly #scope: EvidenceScope;
  readonly #key: string;
  readonly #options: EvidenceStoreOptions;
  readonly #rawLimit: number;
  readonly #normalizedLimit: number;
  readonly #revisionLimit: number;
  constructor(database: Database, scope: EvidenceScope, options: EvidenceStoreOptions) {
    this.#db = database; this.#scope = parseEvidenceScope(scope); this.#key = `${this.#scope.kind}:${this.#scope.id}`; this.#options = options;
    if (typeof options.authorize !== "function") throw new EvidenceError("A current authoritative store authorization callback is required", 403);
    if (this.#get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys !== 1) throw new EvidenceError("Evidence storage requires foreign key enforcement", 409);
    this.#rawLimit = evidenceInteger(options.maxRawBytes ?? 64 * 1024 * 1024, "raw quota");
    this.#normalizedLimit = evidenceInteger(options.maxNormalizedBytes ?? 32 * 1024 * 1024, "normalized quota");
    this.#revisionLimit = evidenceInteger(options.maxRevisions ?? 1_000, "revision quota", Number.MAX_SAFE_INTEGER, 1);
  }
  #get<T>(sql: string, ...bindings: SQLQueryBindings[]): T | null { return this.#db.query(sql).get(...bindings) as T | null; }
  #all<T>(sql: string, ...bindings: SQLQueryBindings[]): T[] { return this.#db.query(sql).all(...bindings) as T[]; }
  #run(sql: string, ...bindings: SQLQueryBindings[]): number { return this.#db.query(sql).run(...bindings).changes; }
  #transaction<T>(operation: () => T): T { return this.#db.transaction(operation).immediate(); }
  #now(): number { return evidenceInteger((this.#options.now ?? Date.now)(), "clock"); }
  #authorize(capability: EvidenceCapability, attachment: EvidenceAttachment | null): string {
    const authority = evidenceObject(this.#options.authorize(capability, { ...this.#scope }, attachment ? { ...attachment } : null), ["actorId"], "authority");
    return evidenceText(authority.actorId, "actor ID");
  }
  #generation(): number {
    const scope = this.#get<{ generation: number; active: number }>("SELECT generation,active FROM evaluation_evidence_scopes WHERE scope_key=?", this.#key);
    if (!scope || !scope.active) throw new EvidenceError("Evidence scope is unavailable", 404);
    return scope.generation;
  }
  #job(id: string): JobRow {
    const job = this.#get<JobRow>("SELECT * FROM evaluation_evidence_jobs WHERE scope_key=? AND id=?", this.#key, evidenceText(id, "job ID"));
    if (!job) throw new EvidenceError("Evidence job not found", 404);
    return job;
  }
  #jobView(row: JobRow): EvidenceJob {
    return { id: row.id, scopeGeneration: row.scope_generation, requestDigest: row.request_digest, status: row.status,
      admittedAt: row.admitted_at, deadlineAt: row.deadline_at, setId: row.set_id, failureCode: row.failure_code };
  }
  #request(job: JobRow): EvidenceImportRequest { return JSON.parse(job.request_data) as EvidenceImportRequest; }
  #inventory(id: string, revision: number): EvidenceInventoryRevision {
    const row = this.#get<{ data: string }>("SELECT data FROM evaluation_evidence_inventories WHERE scope_key=? AND id=? AND revision=?", this.#key, id, revision);
    if (!row) throw new EvidenceError("Inventory revision not found", 404);
    return JSON.parse(row.data) as EvidenceInventoryRevision;
  }
  #set(id: string, revision?: number): EvidenceSetRevision {
    const row = revision === undefined ? this.#get<{ data: string }>("SELECT data FROM evaluation_evidence_sets WHERE scope_key=? AND id=? ORDER BY revision DESC LIMIT 1", this.#key, id) :
      this.#get<{ data: string }>("SELECT data FROM evaluation_evidence_sets WHERE scope_key=? AND id=? AND revision=?", this.#key, id, revision);
    if (!row) throw new EvidenceError("Evidence revision not found", 404);
    return JSON.parse(row.data) as EvidenceSetRevision;
  }
  saveInventory(id: string, expectedRevision: number, expected: EvidenceExpectedSource[], declaration: "prospective" | "retrospective"): EvidenceInventoryRevision {
    id = evidenceText(id, "inventory ID"); expectedRevision = evidenceInteger(expectedRevision, "expected inventory revision");
    expected = parseEvidenceExpectedSources(expected);
    if (declaration !== "prospective" && declaration !== "retrospective") throw new EvidenceError("Inventory declaration must be explicit");
    return this.#transaction(() => {
      const actorId = this.#authorize("inventory_edit", null); this.#generation();
      const current = this.#get<{ revision: number }>("SELECT revision FROM evaluation_evidence_inventory_heads WHERE scope_key=? AND id=?", this.#key, id)?.revision ?? 0;
      if (current !== expectedRevision) throw new EvidenceError("Inventory changed; reload before editing", 409);
      const count = this.#get<{ n: number }>("SELECT count(*) AS n FROM evaluation_evidence_inventories WHERE scope_key=?", this.#key)!.n;
      if (count >= this.#revisionLimit) throw new EvidenceError("Inventory revision retention is full", 409);
      const data = { id, revision: current + 1, expected, declaration, actorId, createdAt: this.#now() };
      const inventory = { ...data, digest: evidenceDigest(canonicalEvidenceJson(data)) };
      this.#run("INSERT OR IGNORE INTO evaluation_evidence_inventory_heads(scope_key,id,revision) VALUES(?,?,0)", this.#key, id);
      this.#run("INSERT INTO evaluation_evidence_inventories(scope_key,id,revision,data,digest,created_at) VALUES(?,?,?,?,?,?)",
        this.#key, id, inventory.revision, canonicalEvidenceJson(inventory), inventory.digest, inventory.createdAt);
      this.#run("UPDATE evaluation_evidence_inventory_heads SET revision=? WHERE scope_key=? AND id=?", inventory.revision, this.#key, id);
      return inventory;
    });
  }
  getInventory(id: string, revision: number): EvidenceInventoryRevision {
    id = evidenceText(id, "inventory ID"); revision = evidenceInteger(revision, "inventory revision", Number.MAX_SAFE_INTEGER, 1);
    return this.#transaction(() => { this.#authorize("normalized_read", null); this.#generation(); return this.#inventory(id, revision); });
  }
  admit(value: unknown): { job: EvidenceJob; publicationToken: string; reused: boolean } {
    const request = parseEvidenceImportRequest(value);
    return this.#transaction(() => {
      this.#authorize("import", request.attachment); const generation = this.#generation();
      const inventory = request.inventory ? this.#inventory(request.inventory.id, request.inventory.revision) : null;
      const requestDigest = evidenceDigest(canonicalEvidenceJson({ scope: this.#scope, generation, request, inventoryDigest: inventory?.digest ?? null }));
      const existing = this.#get<JobRow>("SELECT * FROM evaluation_evidence_jobs WHERE scope_key=? AND scope_generation=? AND operation_key=?", this.#key, generation, request.operationKey);
      if (existing) {
        if (existing.request_digest !== requestDigest) throw new EvidenceError("Operation key already identifies different bytes or configuration", 409);
        return { job: this.#jobView(existing), publicationToken: existing.job_token, reused: true };
      }
      if (request.target) {
        const previous = this.#set(request.target.setId);
        if (previous.revision !== request.target.expectedRevision || canonicalEvidenceJson(previous.attachment) !== canonicalEvidenceJson(request.attachment)) throw new EvidenceError("Evidence target changed or has a different attachment", 409);
      }
      if (this.#get<{ n: number }>("SELECT count(*) AS n FROM evaluation_evidence_jobs WHERE status='queued'")!.n >= L.MAX_QUEUED) throw new EvidenceError("Evidence queue is full", 409);
      const sets = this.#get<{ n: number }>("SELECT count(*) AS n FROM evaluation_evidence_sets WHERE scope_key=?", this.#key)!.n;
      const pending = this.#get<{ n: number }>("SELECT count(*) AS n FROM evaluation_evidence_jobs WHERE scope_key=? AND status IN ('queued','running')", this.#key)!.n;
      const jobs = this.#get<{ n: number }>("SELECT count(*) AS n FROM evaluation_evidence_jobs WHERE scope_key=?", this.#key)!.n;
      if (sets + pending >= this.#revisionLimit || jobs >= this.#revisionLimit) throw new EvidenceError("Evidence job or revision retention is full", 409);
      const rawBytes = request.retention === "raw_and_normalized" ? request.sources.reduce((sum, source) => sum + source.byteLength, 0) : 0;
      const rawHeld = this.#get<{ n: number }>("SELECT coalesce(sum(length(bytes)),0) AS n FROM evaluation_evidence_blobs WHERE scope_key=?", this.#key)!.n;
      const normalizedHeld = this.#get<{ n: number }>(`SELECT coalesce(sum(n),0) AS n FROM (
        SELECT length(cast(data AS BLOB)) AS n FROM evaluation_evidence_payloads WHERE scope_key=?
        UNION ALL SELECT length(cast(data AS BLOB)) AS n FROM evaluation_evidence_sets WHERE scope_key=?)`, this.#key, this.#key)!.n;
      const reserved = this.#get<{ raw: number; normalized: number }>("SELECT coalesce(sum(reserved_raw_bytes),0) AS raw,coalesce(sum(reserved_normalized_bytes),0) AS normalized FROM evaluation_evidence_jobs WHERE scope_key=?", this.#key)!;
      if (rawHeld + reserved.raw + rawBytes > this.#rawLimit || normalizedHeld + reserved.normalized + L.MAX_NORMALIZED_BYTES > this.#normalizedLimit) throw new EvidenceError("Evidence storage quota is full", 409);
      const id = randomUUID(), token = randomUUID(), now = this.#now();
      if (now > Number.MAX_SAFE_INTEGER - L.MAX_IMPORT_MS) throw new EvidenceError("Clock cannot represent an import deadline");
      this.#run(`INSERT INTO evaluation_evidence_jobs(id,scope_key,scope_generation,operation_key,request_digest,request_data,inventory_data,status,job_token,admitted_at,deadline_at,reserved_raw_bytes,reserved_normalized_bytes)
        VALUES(?,?,?,?,?,?,?,'queued',?,?,?,?,?)`, id, this.#key, generation, request.operationKey, requestDigest, canonicalEvidenceJson(request), inventory ? canonicalEvidenceJson(inventory) : null, token, now, now + L.MAX_IMPORT_MS, rawBytes, L.MAX_NORMALIZED_BYTES);
      return { job: this.#jobView(this.#job(id)), publicationToken: token, reused: false };
    });
  }
  getJob(id: string): EvidenceJob {
    return this.#transaction(() => { this.#authorize("normalized_read", null); const job = this.#job(id); this.#authorize("normalized_read", this.#request(job).attachment); this.#generation(); return this.#jobView(job); });
  }
  #finish(job: JobRow, status: "cancelled" | "failed", code: EvidenceJob["failureCode"]): boolean {
    return this.#run("UPDATE evaluation_evidence_jobs SET status=?,failure_code=?,job_token=?,reserved_raw_bytes=0,reserved_normalized_bytes=0 WHERE scope_key=? AND id=? AND job_token=? AND status IN ('queued','running')",
      status, code, randomUUID(), this.#key, job.id, job.job_token) === 1;
  }
  start(id: string, token: string): boolean {
    token = evidenceText(token, "publication token");
    return this.#transaction(() => {
      this.#authorize("import", null); const job = this.#job(id); this.#authorize("import", this.#request(job).attachment); const generation = this.#generation();
      if (job.job_token !== token || job.status !== "queued" || job.scope_generation !== generation) return false;
      if (this.#now() >= job.deadline_at) { this.#finish(job, "failed", "deadline_exceeded"); return false; }
      if (this.#get<{ n: number }>("SELECT count(*) AS n FROM evaluation_evidence_jobs WHERE status='running'")!.n >= L.MAX_ACTIVE) return false;
      return this.#run("UPDATE evaluation_evidence_jobs SET status='running' WHERE scope_key=? AND id=? AND job_token=? AND status='queued'", this.#key, id, token) === 1;
    });
  }
  cancel(id: string): boolean {
    return this.#transaction(() => { this.#authorize("import", null); const job = this.#job(id); this.#authorize("import", this.#request(job).attachment); this.#generation(); return this.#finish(job, "cancelled", "cancelled"); });
  }
  /** Called once by the database owner on restart, before admitting work; it never reruns reports. */
  recoverUnfinished(): number {
    return this.#transaction(() => { this.#authorize("import", null); this.#generation();
      return this.#run("UPDATE evaluation_evidence_jobs SET status='failed',failure_code='restart_interrupted',job_token=?,reserved_raw_bytes=0,reserved_normalized_bytes=0 WHERE scope_key=? AND status IN ('queued','running')", randomUUID(), this.#key); });
  }
  publish(id: string, token: string, value: EvidencePublicationSource[]): EvidenceSetRevision | null {
    token = evidenceText(token, "publication token");
    return this.#transaction(() => {
      this.#authorize("import", null); const job = this.#job(id), request = this.#request(job); this.#authorize("import", request.attachment); const generation = this.#generation();
      if (job.job_token !== token || job.status !== "running" || job.scope_generation !== generation) return null;
      if (this.#now() >= job.deadline_at) { this.#finish(job, "failed", "deadline_exceeded"); return null; }
      if (request.target && this.#set(request.target.setId).revision !== request.target.expectedRevision) { this.#finish(job, "failed", "revision_conflict"); return null; }
      const supplied = evidenceArray(value, L.MAX_REPORTS, "publication sources", 1);
      if (supplied.length !== request.sources.length) throw new EvidenceError("Publication must account for every admitted source");
      let leaves = 0, normalizedBytes = 0;
      const parsed = request.sources.map((descriptor, index) => {
        const source = evidenceObject(supplied[index], ["sourceId", "raw", "normalized"], "publication source");
        if (source.sourceId !== descriptor.sourceId || !(source.raw instanceof Uint8Array) || source.raw.byteLength !== descriptor.byteLength || evidenceDigest(source.raw) !== descriptor.artifactSha256) throw new EvidenceError("Publication raw bytes do not match the exact admitted roster");
        const normalized = parseNormalizedEvidence(source.normalized, descriptor.kind);
        if (normalized.sourceId !== descriptor.sourceId) throw new EvidenceError("Normalized source identity does not match its admitted source");
        const data = canonicalEvidenceJson(normalized); normalizedBytes += Buffer.byteLength(data); leaves += normalized.leaves.length;
        if (normalizedBytes > L.MAX_NORMALIZED_BYTES || leaves > L.MAX_LEAVES) throw new EvidenceError("Publication exceeds normalized byte or leaf limits", 413);
        return { descriptor, raw: source.raw.slice(), normalized, data, normalizedSha256: evidenceDigest(data), artifactId: randomUUID(), interpretationId: randomUUID() };
      });
      const inventory = job.inventory_data ? JSON.parse(job.inventory_data) as EvidenceInventoryRevision : null;
      const coverage = accountEvidenceInventory(inventory, parsed.map(source => ({ descriptor: source.descriptor, normalized: source.normalized })));
      const references = parsed.map(source => (source.normalized.attestation?.reportReferences ?? []).map(reference => {
        const matching = source.normalized.parseState === "parsed" ? parsed.filter(candidate => candidate.descriptor.kind === "junit" && candidate.descriptor.artifactSha256 === reference.sha256) : [];
        return { ...reference, linkedSourceId: matching.length === 1 ? matching[0].descriptor.sourceId : null,
          resolution: matching.length === 1 ? "matched" : matching.length ? "ambiguous" : "unresolved" } satisfies EvidenceReportReference;
      }));
      const sources: EvidenceSourceObservation[] = parsed.map(({ descriptor, normalized, artifactId, interpretationId, normalizedSha256 }) => ({
        ...descriptor, artifactId, interpretationId, normalizedSha256, parseState: normalized.parseState, interpretationComplete: normalized.interpretationComplete, reportOutcome: normalized.reportOutcome,
        leafCounts: normalized.leafCounts, observedExecutedLowerBound: normalized.observedExecutedLowerBound, countsConsistent: normalized.countsConsistent,
        reportIdentityAsserted: references.some(group => group.some(reference => reference.resolution === "matched" && reference.linkedSourceId === descriptor.sourceId)),
        commitAssertionMatches: (() => {
          const trustedCommit = inventory?.expected.find(source => source.shardId === descriptor.shardId)?.constraints.commit;
          const claims = [...(normalized.assertedIdentity.commit ? [normalized.assertedIdentity.commit] : []), ...(normalized.attestation?.assertedCommits ?? [])];
          parsed.forEach((source, index) => { if (references[index].some(reference => reference.linkedSourceId === descriptor.sourceId)) claims.push(...(source.normalized.attestation?.assertedCommits ?? [])); });
          return trustedCommit && claims.length ? claims.every(commit => commit.toLowerCase() === trustedCommit.toLowerCase()) : null;
        })(),
        reportReferences: references[parsed.findIndex(source => source.descriptor.sourceId === descriptor.sourceId)],
        authentication: "not_checked", reasonCodes: [...new Set([...normalized.reasonCodes, ...references[parsed.findIndex(source => source.descriptor.sourceId === descriptor.sourceId)]
          .filter(reference => reference.resolution !== "matched").map(reference => reference.resolution === "ambiguous" ? "ambiguous_subject" as const : "subject_unresolved" as const)])],
      }));
      const data = { version: EVIDENCE_VERSION, id: request.target?.setId ?? randomUUID(), revision: (request.target?.expectedRevision ?? 0) + 1, jobId: id,
        scope: { ...this.#scope }, scopeGeneration: generation, attachment: request.attachment, inventory, parserVersion: request.parserVersion,
        policyVersion: request.policyVersion, configurationSha256: request.configurationSha256, initialRetention: request.retention, ...coverage, sources, createdAt: this.#now() };
      const set: EvidenceSetRevision = { ...data, digest: evidenceDigest(canonicalEvidenceJson(data)) };
      const setData = canonicalEvidenceJson(set);
      if (normalizedBytes + Buffer.byteLength(setData) > L.MAX_NORMALIZED_BYTES) throw new EvidenceError("Retained normalized payload and revision exceed 4 MiB", 413);
      for (const source of parsed) {
        this.#run("INSERT INTO evaluation_evidence_artifacts(scope_key,id,job_id,source_id,sha256,byte_length) VALUES(?,?,?,?,?,?)", this.#key, source.artifactId, id, source.descriptor.sourceId, source.descriptor.artifactSha256, source.raw.byteLength);
        if (request.retention === "raw_and_normalized") this.#run("INSERT INTO evaluation_evidence_blobs(scope_key,artifact_id,bytes) VALUES(?,?,?)", this.#key, source.artifactId, source.raw);
        this.#run("INSERT INTO evaluation_evidence_interpretations(scope_key,id,artifact_id,normalized_sha256,parser_version,policy_version,configuration_sha256,dialect) VALUES(?,?,?,?,?,?,?,?)", this.#key, source.interpretationId, source.artifactId, source.normalizedSha256, request.parserVersion, request.policyVersion, request.configurationSha256, source.descriptor.dialect);
        this.#run("INSERT INTO evaluation_evidence_payloads(scope_key,interpretation_id,data) VALUES(?,?,?)", this.#key, source.interpretationId, source.data);
      }
      this.#run("INSERT INTO evaluation_evidence_sets(scope_key,id,revision,job_id,data,digest,created_at) VALUES(?,?,?,?,?,?,?)", this.#key, set.id, set.revision, id, setData, set.digest, set.createdAt);
      const changed = this.#run("UPDATE evaluation_evidence_jobs SET status='completed',set_id=?,reserved_raw_bytes=0,reserved_normalized_bytes=0 WHERE scope_key=? AND id=? AND job_token=? AND status='running' AND scope_generation=?", set.id, this.#key, id, token, generation);
      if (changed !== 1) throw new EvidenceError("Publication ownership changed", 409);
      return set;
    });
  }
  getSet(id: string, revision?: number): EvidenceSetView {
    id = evidenceText(id, "set ID"); if (revision !== undefined) revision = evidenceInteger(revision, "set revision", Number.MAX_SAFE_INTEGER, 1);
    return this.#transaction(() => {
      this.#authorize("normalized_read", null); const set = this.#set(id, revision); this.#authorize("normalized_read", set.attachment); this.#generation();
      return { revision: set, sources: set.sources.map(source => {
        const payload = this.#get<{ data: string }>("SELECT data FROM evaluation_evidence_payloads WHERE scope_key=? AND interpretation_id=?", this.#key, source.interpretationId);
        return { sourceId: source.sourceId, rawAvailable: !!this.#get("SELECT 1 FROM evaluation_evidence_blobs WHERE scope_key=? AND artifact_id=?", this.#key, source.artifactId),
          normalizedAvailable: !!payload, normalized: payload ? JSON.parse(payload.data) as NormalizedEvidenceSource : null };
      }) };
    });
  }
  exportRaw(id: string, revision: number, sourceId: string): Uint8Array {
    id = evidenceText(id, "set ID"); revision = evidenceInteger(revision, "set revision", Number.MAX_SAFE_INTEGER, 1); sourceId = evidenceText(sourceId, "source ID");
    return this.#transaction(() => {
      this.#authorize("raw_export", null); const set = this.#set(id, revision); this.#authorize("raw_export", set.attachment); this.#generation();
      const source = set.sources.find(source => source.sourceId === sourceId);
      const blob = source && this.#get<{ bytes: Uint8Array }>("SELECT bytes FROM evaluation_evidence_blobs WHERE scope_key=? AND artifact_id=?", this.#key, source.artifactId);
      if (!blob) throw new EvidenceError("Raw evidence is unavailable", 404);
      if (blob.bytes.byteLength !== source.byteLength || evidenceDigest(blob.bytes) !== source.artifactSha256) throw new EvidenceError("Stored raw evidence integrity check failed", 409);
      return blob.bytes.slice();
    });
  }
  removePayloads(id: string, revision: number, kind: "raw_removed" | "normalized_removed"): number {
    id = evidenceText(id, "set ID"); revision = evidenceInteger(revision, "set revision", Number.MAX_SAFE_INTEGER, 1);
    if (kind !== "raw_removed" && kind !== "normalized_removed") throw new EvidenceError("Unsupported retention event");
    return this.#transaction(() => {
      this.#authorize("delete", null); const set = this.#set(id, revision), actorId = this.#authorize("delete", set.attachment); this.#generation(); let removed = 0;
      for (const job of this.#all<JobRow>("SELECT * FROM evaluation_evidence_jobs WHERE scope_key=? AND status IN ('queued','running')", this.#key)) {
        if (this.#request(job).target?.setId === id) this.#finish(job, "failed", "retention_changed");
      }
      for (const source of set.sources) {
        const count = kind === "raw_removed" ? this.#run("DELETE FROM evaluation_evidence_blobs WHERE scope_key=? AND artifact_id=?", this.#key, source.artifactId) :
          this.#run("DELETE FROM evaluation_evidence_payloads WHERE scope_key=? AND interpretation_id=?", this.#key, source.interpretationId);
        if (count) {
          removed += count;
          this.#run("INSERT INTO evaluation_evidence_retention_events(id,scope_key,set_id,revision,target_id,kind,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?)", randomUUID(), this.#key, id, revision,
            kind === "raw_removed" ? source.artifactId : source.interpretationId, kind, actorId, this.#now());
        }
      }
      return removed;
    });
  }
  /** Owner clear-all keeps only the scope generation; stale workers cannot recreate deleted payloads. */
  purgeScope(): void {
    this.#transaction(() => {
      this.#authorize("delete", null); const generation = this.#generation();
      if (generation === Number.MAX_SAFE_INTEGER) throw new EvidenceError("Scope generation is exhausted", 409);
      this.#run("UPDATE evaluation_evidence_scopes SET generation=generation+1 WHERE scope_key=?", this.#key);
      this.#run("DELETE FROM evaluation_evidence_jobs WHERE scope_key=?", this.#key);
      this.#run("DELETE FROM evaluation_evidence_inventory_heads WHERE scope_key=?", this.#key);
      this.#run("DELETE FROM evaluation_evidence_retention_events WHERE scope_key=?", this.#key);
    });
  }
}

export function accountEvidenceInventory(inventory: EvidenceInventoryRevision | null, sources: {
  descriptor: EvidenceImportRequest["sources"][number]; normalized: NormalizedEvidenceSource;
}[]): Pick<EvidenceSetRevision, "coverage" | "missing" | "extra" | "duplicates" | "rejected" | "reasonCodes"> {
  const missing: string[] = [], extra: string[] = [], duplicates: string[] = [], rejected = sources.filter(source => source.normalized.parseState !== "parsed").map(source => source.descriptor.sourceId);
  const reasonCodes: EvidenceReason[] = [];
  if (!inventory) return { coverage: "not_declared", missing, extra, duplicates, rejected, reasonCodes: ["inventory_not_declared"] };
  for (const expected of inventory.expected) {
    const matches = sources.filter(source => source.descriptor.shardId === expected.shardId);
    if (!matches.length) missing.push(expected.shardId);
    if (matches.length > 1) duplicates.push(expected.shardId);
    for (const match of matches) {
      if (match.descriptor.kind !== expected.kind) reasonCodes.push("kind_mismatch");
      if (Object.entries(expected.constraints).some(([key, value]) => value !== null && match.normalized.assertedIdentity[key as keyof typeof expected.constraints] !== value)) reasonCodes.push("constraint_mismatch");
    }
  }
  for (const source of sources) if (!inventory.expected.some(expected => expected.shardId === source.descriptor.shardId)) extra.push(source.descriptor.sourceId);
  if (missing.length) reasonCodes.push("missing_source"); if (extra.length) reasonCodes.push("extra_source");
  if (duplicates.length) reasonCodes.push("duplicate_shard"); if (rejected.length) reasonCodes.push("source_rejected");
  if (inventory.declaration === "retrospective") reasonCodes.push("retrospective_inventory");
  return { coverage: reasonCodes.length ? "incomplete" : "complete", missing, extra, duplicates, rejected, reasonCodes: [...new Set(reasonCodes)] };
}
