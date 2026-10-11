import type { Database } from "bun:sqlite";
import { EvidenceStore } from "./evidence-store";
import { EVIDENCE_LIMITS as L, EvidenceError, type EvidenceAttachment, type EvidenceCapability, type EvidenceImportRequest,
  type EvidenceInventoryRevision, type EvidenceScope } from "./evidence-protocol";
import { canonicalEvidenceJson, evidenceDigest, evidenceInteger, evidenceObject, evidenceSha256, evidenceText,
  parseEvidenceAttachment, parseEvidenceExpectedSources } from "./evidence-validation";
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
  get(anchorValue: unknown, revision: number): EvidenceInventoryRevision {
    const anchor = parseEvidenceAnchor(anchorValue);
    return this.#transaction(() => {
      this.owner.authorize("normalized_read", anchor.kind === "dataset_revision" ? null : anchor);
      return this.owner.store.getInventory(identityId(this.owner.scope, this.owner.resolveAnchor(anchor)), revision);
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
