import type { Database } from "bun:sqlite";
import { EvidenceStore } from "./evidence-store";
import { EVIDENCE_LIMITS as L, EVIDENCE_VERSION, EvidenceError, type EvidenceAttachment, type EvidenceCapability, type EvidenceImportRequest,
  type EvidenceInventoryRevision, type EvidenceScope } from "./evidence-protocol";
import { canonicalEvidenceJson, evidenceDigest, evidenceInteger, evidenceObject, evidenceSha256, evidenceText,
  parseEvidenceAttachment, parseEvidenceExpectedSources, parseEvidenceImportRequest } from "./evidence-validation";
import { strictEvidenceJson } from "./evidence-reader/json";
import { readerLimits } from "./evidence-reader/limits";

export type EvidenceInventoryAnchor = EvidenceAttachment | { kind: "dataset_revision"; id: string; version: number };
export interface EvidenceAnchorIdentity { anchor: EvidenceInventoryAnchor; createdAt: number; dataset?: { id: string; version: number; hash: string } }
/** A private TeamStore must supply all these operations against its own authoritative connection. */
export interface EvidenceOwner {
  readonly database: Database;
  readonly scope: EvidenceScope;
  readonly store: EvidenceStore;
  authorize(capability: EvidenceCapability, attachment: EvidenceAttachment | null): { actorId: string };
  resolveAnchor(anchor: EvidenceInventoryAnchor): EvidenceAnchorIdentity;
}
export function parseEvidenceAnchor(value: unknown): EvidenceInventoryAnchor {
  const anchor = evidenceObject(value, ["kind", "id", "version"], "inventory anchor");
  if (anchor.kind !== "dataset_revision") {
    if (Object.hasOwn(anchor, "version")) throw new EvidenceError("Attachment anchors do not accept a dataset version");
    return parseEvidenceAttachment(anchor);
  }
  return { kind: "dataset_revision", id: evidenceText(anchor.id, "dataset ID"), version: evidenceInteger(anchor.version, "dataset revision", Number.MAX_SAFE_INTEGER, 1) };
}
function identityId(scope: EvidenceScope, identity: EvidenceAnchorIdentity): string {
  return `inv-${evidenceDigest(canonicalEvidenceJson({ scope, anchor: identity.anchor, dataset: identity.dataset ?? null }))}`;
}
function activeEvidenceGeneration(owner: EvidenceOwner): number {
  const row = owner.database.query("SELECT generation,active FROM evaluation_evidence_scopes WHERE scope_key=?").get(`${owner.scope.kind}:${owner.scope.id}`) as { generation: number; active: number } | null;
  if (!row || row.active !== 1) throw new EvidenceError("Evidence scope is unavailable", 404);
  return evidenceInteger(row.generation, "scope generation", Number.MAX_SAFE_INTEGER, 1);
}
export class EvidenceInventories {
  constructor(readonly owner: EvidenceOwner) {}
  #transaction<T>(operation: () => T): T { return this.owner.database.transaction(operation).immediate(); }
  save(value: unknown): EvidenceInventoryRevision {
    const input = evidenceObject(value, ["anchor", "expectedRevision", "expected"], "inventory edit");
    const anchor = parseEvidenceAnchor(input.anchor), expectedRevision = evidenceInteger(input.expectedRevision, "expected inventory revision"), expected = parseEvidenceExpectedSources(input.expected);
    return this.#transaction(() => {
      this.owner.authorize("inventory_edit", anchor.kind === "dataset_revision" ? null : anchor);
      const identity = this.owner.resolveAnchor(anchor);
      return this.owner.store.saveInventory(identityId(this.owner.scope, identity), expectedRevision, expected, anchor.kind === "dataset_revision" ? "prospective" : "retrospective");
    });
  }
  get(anchorValue: unknown, revision?: number): EvidenceInventoryRevision {
    const anchor = parseEvidenceAnchor(anchorValue);
    return this.#transaction(() => {
      this.owner.authorize("normalized_read", null); this.owner.authorize("normalized_read", anchor.kind === "dataset_revision" ? null : anchor);
      const generation = activeEvidenceGeneration(this.owner);
      const id = identityId(this.owner.scope, this.owner.resolveAnchor(anchor));
      const selected = revision ?? (this.owner.database.query("SELECT revision FROM evaluation_evidence_inventory_heads WHERE scope_key=? AND id=?").get(`${this.owner.scope.kind}:${this.owner.scope.id}`, id) as { revision: number } | null)?.revision;
      if (selected === undefined) throw new EvidenceError("Inventory revision not found", 404);
      const inventory = this.owner.store.getInventory(id, selected);
      this.owner.authorize("normalized_read", null); this.owner.authorize("normalized_read", anchor.kind === "dataset_revision" ? null : anchor);
      this.owner.resolveAnchor(anchor);
      if (activeEvidenceGeneration(this.owner) !== generation) throw new EvidenceError("Evidence scope changed", 409);
      return inventory;
    });
  }
  #binding(request: EvidenceImportRequest): EvidenceInventoryRevision | null {
    const identity = this.owner.resolveAnchor(request.attachment);
    if (!request.inventory) return null;
    const inventory = this.owner.store.getInventory(request.inventory.id, request.inventory.revision);
    const candidates = [identityId(this.owner.scope, identity)];
    if (request.attachment.kind === "run" || request.attachment.kind === "inspection") {
      candidates.push(identityId(this.owner.scope, { ...identity, anchor: { ...request.attachment, kind: request.attachment.kind === "run" ? "inspection" : "run" } }));
    }
    if (request.attachment.kind === "experiment" && identity.dataset) {
      const dataset = this.owner.resolveAnchor({ kind: "dataset_revision", id: identity.dataset.id, version: identity.dataset.version });
      if (dataset.dataset?.hash === identity.dataset.hash) candidates.push(identityId(this.owner.scope, dataset));
    }
    if (!candidates.includes(inventory.id) || inventory.declaration === "prospective" && (request.attachment.kind !== "experiment" || inventory.createdAt >= identity.createdAt)) throw new EvidenceError("Inventory does not belong to this current attachment", 409);
    return inventory;
  }
  admit(request: EvidenceImportRequest): ReturnType<EvidenceStore["admit"]> {
    return this.#transaction(() => {
      this.owner.authorize("import", null); this.owner.authorize("import", request.attachment);
      const inventory = this.#binding(request);
      const admitted = this.owner.store.admit(request);
      if (!admitted.reused && inventory) {
        const head = this.owner.database.query("SELECT revision FROM evaluation_evidence_inventory_heads WHERE scope_key=? AND id=?").get(`${this.owner.scope.kind}:${this.owner.scope.id}`, inventory.id) as { revision: number } | null;
        const preserved = request.target && this.owner.store.getSet(request.target.setId, request.target.expectedRevision).revision.inventory;
        if (head?.revision !== inventory.revision && (!preserved || preserved.id !== inventory.id || preserved.revision !== inventory.revision)) throw new EvidenceError("Inventory changed; select the current authorized revision", 409);
      }
      return admitted;
    });
  }
}

/** Bounded locators only. A selected revision still requires the canonical digest-checked store read. */
export function listEvidenceSets(owner: EvidenceOwner, value: unknown): { items: { id: string; revision: number; createdAt: number }[]; truncated: boolean } {
  const attachment = parseEvidenceAttachment(value), key = `${owner.scope.kind}:${owner.scope.id}`;
  return owner.database.transaction(() => {
    owner.authorize("normalized_read", null); owner.authorize("normalized_read", attachment); owner.resolveAnchor(attachment);
    const generation = activeEvidenceGeneration(owner);
    // Bounded job metadata establishes attachment identity before inspecting any set payload JSON.
    // Unrelated known anchors do not consume this attachment's head-count or aggregate byte budget.
    const heads = `WITH heads AS (SELECT s.id,s.revision,s.created_at,j.id AS job_id,
      CASE WHEN typeof(j.request_data)='text' AND length(cast(j.request_data AS BLOB))<=65536 THEN j.request_data ELSE NULL END AS request
      FROM evaluation_evidence_sets s JOIN evaluation_evidence_jobs j ON j.id=s.job_id AND j.scope_key=s.scope_key
      WHERE s.scope_key=? AND j.scope_generation=? AND s.revision=(SELECT max(h.revision) FROM evaluation_evidence_sets h WHERE h.scope_key=s.scope_key AND h.id=s.id))`;
    const candidates = owner.database.prepare(`${heads} SELECT request,
      CASE WHEN typeof(job_id)='text' AND length(cast(job_id AS BLOB)) BETWEEN 1 AND 128 THEN job_id ELSE NULL END AS job_id FROM heads`);
    try {
      for (const value of candidates.iterate(key, generation)) {
        const row = value as { request: string | null; job_id: string | null };
        try {
          if (row.request === null || row.job_id === null) throw new Error("Oversized job metadata");
          const request = parseEvidenceImportRequest(strictEvidenceJson(row.request, readerLimits()));
          if (canonicalEvidenceJson(request) !== row.request) throw new Error("Noncanonical job metadata");
        } catch { throw new EvidenceError("Stored evidence history is unavailable: job metadata integrity check failed", 409); }
      }
    } finally { candidates.finalize(); }
    const matched = `${heads}, matched AS (SELECT * FROM heads WHERE json_extract(request,'$.attachment.kind')=? AND json_extract(request,'$.attachment.id')=?)`;
    const budget = owner.database.query(`${matched} SELECT count(*) AS count,
      coalesce(sum(length(cast(s.data AS BLOB))),0) AS bytes,
      coalesce(max(CASE WHEN typeof(s.data)!='text' OR length(cast(s.data AS BLOB))>${L.MAX_NORMALIZED_BYTES} THEN 1 ELSE 0 END),0) AS oversized
      FROM matched m JOIN evaluation_evidence_sets s ON s.scope_key=? AND s.id=m.id AND s.revision=m.revision`).get(key, generation, attachment.kind, attachment.id, key) as { count: number; bytes: number; oversized: number };
    if (budget.count > 1_000 || budget.bytes > 32 * 1024 * 1024) throw new EvidenceError("Stored evidence history is unavailable: discovery metadata budget exceeded", 409);
    if (budget.oversized !== 0) throw new EvidenceError("Stored evidence history is unavailable: set metadata integrity boundary exceeded", 409);
    const jobs = owner.database.query(`${matched} SELECT job_id AS jobId,id FROM matched LIMIT 1001`).all(key, generation, attachment.kind, attachment.id) as { jobId: string; id: string }[];
    for (const row of jobs) {
      // Reuse the frozen canonical request/inventory digest and current attachment authorization checks.
      const job = owner.store.getJob(row.jobId);
      if (job.scopeGeneration !== generation || job.status !== "completed" || job.setId !== row.id) throw new EvidenceError("Stored evidence history is unavailable: published job identity changed", 409);
    }
    const payloads = `${matched}, payloads AS (SELECT m.id,m.revision,m.created_at,
      CASE WHEN typeof(s.data)='text' AND length(cast(s.data AS BLOB))<=${L.MAX_NORMALIZED_BYTES} THEN s.data ELSE NULL END AS data
      FROM matched m JOIN evaluation_evidence_sets s ON s.scope_key=? AND s.id=m.id AND s.revision=m.revision)`;
    const valid = `CASE WHEN data IS NOT NULL AND json_valid(data) THEN
      typeof(id)='text' AND length(cast(id AS BLOB)) BETWEEN 1 AND 128 AND json_extract(data,'$.id')=id
      AND typeof(revision)='integer' AND revision>0 AND json_extract(data,'$.revision')=revision
      AND typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991 AND json_extract(data,'$.createdAt')=created_at
      AND json_extract(data,'$.version')=${EVIDENCE_VERSION} AND json_extract(data,'$.scope.kind')=? AND json_extract(data,'$.scope.id')=?
      AND json_extract(data,'$.scopeGeneration')=? AND json_extract(data,'$.attachment.kind')=? AND json_extract(data,'$.attachment.id')=?
      ELSE 0 END`;
    if (owner.database.query(`${payloads} SELECT 1 FROM payloads WHERE coalesce((${valid}),0)=0 LIMIT 1`).get(key, generation, attachment.kind, attachment.id, key, owner.scope.kind, owner.scope.id, generation, attachment.kind, attachment.id)) {
      throw new EvidenceError("Stored evidence history is unavailable: integrity check failed", 409);
    }
    const rows = owner.database.query(`${payloads} SELECT id,revision,created_at AS createdAt FROM payloads ORDER BY created_at DESC,id ASC LIMIT 51`).all(key, generation, attachment.kind, attachment.id, key) as { id: string; revision: number; createdAt: number }[];
    owner.authorize("normalized_read", null); owner.authorize("normalized_read", attachment); owner.resolveAnchor(attachment);
    if (activeEvidenceGeneration(owner) !== generation) throw new EvidenceError("Evidence scope changed", 409);
    const result = { items: rows.slice(0, 50), truncated: rows.length > 50 };
    if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) throw new EvidenceError("Evidence history exceeds its response boundary", 409);
    return result;
  }).immediate();
}

/** Local construction is explicit; generic services never select a singleton or reuse this owner for a team. */
export function createLocalEvidenceOwner(database: Database): EvidenceOwner {
  const scope = { kind: "local", id: "local" } as const;
  const resolveAnchor = (anchor: EvidenceInventoryAnchor): EvidenceAnchorIdentity => {
    if (anchor.kind === "dataset_revision") {
      const row = database.query("SELECT hash,created_at FROM evaluation_revisions WHERE dataset_id=? AND version=?").get(anchor.id, anchor.version) as { hash: string; created_at: number } | null;
      if (!row) throw new EvidenceError("Dataset revision not found", 404);
      return { anchor, createdAt: evidenceInteger(row.created_at, "dataset creation time"), dataset: { id: anchor.id, version: anchor.version, hash: evidenceSha256(row.hash) } };
    }
    if (anchor.kind === "experiment") {
      const row = database.query("SELECT CASE WHEN typeof(data)='text' AND length(cast(data AS BLOB))<=? THEN data ELSE NULL END AS data,created_at FROM evaluation_experiments WHERE id=?").get(L.MAX_NORMALIZED_BYTES, anchor.id) as { data: string | null; created_at: number } | null;
      if (!row) throw new EvidenceError("Experiment not found", 404);
      if (row.data === null) throw new EvidenceError("Stored attachment exceeds its integrity boundary", 409);
      let value: Record<string, unknown>;
      try {
        const parsed = strictEvidenceJson(row.data, readerLimits());
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid experiment");
        value = parsed as Record<string, unknown>;
      } catch { throw new EvidenceError("Stored attachment integrity check failed", 409); }
      if (value.id !== anchor.id || value.createdAt !== row.created_at) throw new EvidenceError("Stored attachment identity changed", 409);
      return { anchor, createdAt: evidenceInteger(row.created_at, "experiment creation time"), dataset: { id: evidenceText(value.datasetId, "frozen dataset ID"),
        version: evidenceInteger(value.datasetVersion, "frozen dataset version", Number.MAX_SAFE_INTEGER, 1), hash: evidenceSha256(value.datasetHash) } };
    }
    const row = anchor.kind === "check" ? database.query("SELECT created_at AS createdAt FROM verification_reports WHERE id=?").get(anchor.id) :
      database.query("SELECT started_at AS createdAt FROM runs WHERE id=?").get(anchor.id);
    if (!row) throw new EvidenceError("Evidence attachment not found", 404);
    return { anchor, createdAt: evidenceInteger((row as { createdAt: number }).createdAt, "attachment creation time") };
  };
  const authorize = (_capability: EvidenceCapability, attachment: EvidenceAttachment | null) => {
    // Socket/host/origin checks establish the local daemon owner; row existence is checked afresh in the store transaction.
    if (attachment) resolveAnchor(attachment);
    return { actorId: "local-owner" };
  };
  return { database, scope, resolveAnchor, authorize, store: new EvidenceStore(database, scope, { authorize: (capability, _scope, attachment) => authorize(capability, attachment) }) };
}

/** Called inside the existing owner's insertion/eviction transaction; corruption blocks eviction. */
export function activeLocalEvidenceAttachmentIds(database: Database, kind: EvidenceAttachment["kind"]): Set<string> {
  const count = database.query("SELECT count(*) AS n FROM evaluation_evidence_jobs WHERE scope_key='local:local' AND status IN ('queued','running')").get() as { n: number };
  if (count.n > 1_000) throw new EvidenceError("Active evidence retention metadata exceeds its integrity boundary", 409);
  const rows = database.query("SELECT CASE WHEN typeof(id)='text' AND length(cast(id AS BLOB))<=128 THEN id ELSE NULL END AS id, CASE WHEN typeof(request_data)='text' AND length(cast(request_data AS BLOB))<=65536 THEN request_data ELSE NULL END AS request FROM evaluation_evidence_jobs WHERE scope_key='local:local' AND status IN ('queued','running')").all() as { id: string | null; request: string | null }[];
  const owner = createLocalEvidenceOwner(database), result = new Set<string>();
  for (const row of rows) {
    if (row.id === null || row.request === null) throw new EvidenceError("Active evidence retention metadata exceeds its integrity boundary", 409);
    owner.store.getJob(row.id); // Reuses the exact frozen request digest and current attachment integrity check.
    const request = parseEvidenceImportRequest(strictEvidenceJson(row.request, readerLimits()));
    if (request.attachment.kind === kind) result.add(request.attachment.id);
  }
  return result;
}
