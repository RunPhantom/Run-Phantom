import type { Database } from "bun:sqlite";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { EvidenceImportService, EVIDENCE_FRAME_BYTES, EVIDENCE_HEADER_BYTES, EVIDENCE_IMPORT_CONTENT_TYPE, EVIDENCE_READER_IDENTITY } from "../evaluations/evidence-import";
import { EvidenceSupervisor } from "../evaluations/evidence-supervisor";
import { EvidenceInventories, listEvidenceSets, type EvidenceOwner } from "../evaluations/evidence-inventory";
import { EVIDENCE_LIMITS, EvidenceError, type EvidenceAttachment, type EvidenceCapability, type EvidenceSetView } from "../evaluations/evidence-protocol";
import { evidenceInteger, evidenceObject, evidenceText, parseEvidenceImportRequest } from "../evaluations/evidence-validation";
import { strictEvidenceJson } from "../evaluations/evidence-reader/json";
import { readerLimits } from "../evaluations/evidence-reader/limits";
import { boundedEvidenceExport, evidenceExport, evidenceExportJUnit, evidenceExportText } from "../evaluations/evidence-export";

export const TEAM_EVIDENCE_RESPONSE_BYTES = 8 * 1024 * 1024;
export type TeamEvidenceRead =
  | { kind: "capabilities" }
  | { kind: "inventory"; anchor: unknown; revision?: number }
  | { kind: "job"; id: string }
  | { kind: "operation"; operationKey: string }
  | { kind: "sets"; attachment: unknown }
  | { kind: "set"; id: string; revision?: number }
  | { kind: "export"; id: string; revision: number; format: "json" | "junit" | "text" }
  | { kind: "raw"; id: string; revision: number; sourceId: string };
export type TeamEvidenceWrite =
  | { kind: "inventory"; value: unknown }
  | { kind: "cancel"; id: string; value: unknown }
  | { kind: "reparse"; id: string; value: unknown }
  | { kind: "retention"; id: string; revision: number; target: "raw_removed" | "normalized_removed" }
  | { kind: "clear" };
export interface TeamEvidenceResponse { bytes: Uint8Array; contentType: string; status: number; generation: number }

/** Count trusted plain DTO JSON before allocating its complete string or byte buffer. */
function boundedJson(value: unknown): Uint8Array {
  let bytes = 0;
  const add = (count: number) => {
    bytes += count;
    if (bytes > TEAM_EVIDENCE_RESPONSE_BYTES) throw new EvidenceError("Evidence response exceeds its byte boundary", 413);
  };
  const string = (text: string) => {
    add(2);
    for (let index = 0; index < text.length; index++) {
      const unit = text.charCodeAt(index);
      if (unit === 34 || unit === 92 || [8, 9, 10, 12, 13].includes(unit)) add(2);
      else if (unit < 32) add(6);
      else if (unit < 128) add(1);
      else if (unit < 2048) add(2);
      else if (unit >= 0xd800 && unit <= 0xdbff && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { add(4); index++; }
      else if (unit >= 0xd800 && unit <= 0xdfff) add(6);
      else add(3);
    }
  };
  const visit = (item: unknown): void => {
    if (typeof item === "string") { string(item); return; }
    if (item === null || typeof item !== "object") { add(JSON.stringify(item)?.length ?? 4); return; }
    add(2);
    if (Array.isArray(item)) item.forEach((child, index) => { if (index) add(1); visit(child); });
    else {
      let count = 0;
      for (const [key, child] of Object.entries(item)) {
        if (child === undefined) continue;
        if (count++) add(1);
        string(key); add(1); visit(child);
      }
    }
  };
  visit(value);
  return Buffer.from(JSON.stringify(value), "utf8");
}

function boundedJUnit(view: EvidenceSetView): string {
  const empty = { ...view, sources: view.sources.map(source => ({ ...source, normalized: source.normalized ? { ...source.normalized, leaves: [] } : null })) };
  // The existing exporter validates classification and supplies the exact fixed header.
  let bytes = Buffer.byteLength(evidenceExportJUnit(empty));
  const counts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  const escapedBytes = (text: string) => {
    let size = Buffer.byteLength(text);
    for (const char of text) size += char === "&" ? 4 : char === "<" || char === ">" ? 3 : char === '"' || char === "'" ? 5 : 0;
    return size;
  };
  for (const source of view.sources) for (const leaf of source.normalized!.leaves) {
    counts.tests++;
    const status = leaf.status === "failed" ? '<failure message="Observed failure"/>' : leaf.status === "errored" ? '<error message="Observed error"/>' :
      ["skipped", "disabled"].includes(leaf.status) ? `<skipped message="${leaf.status}"/>` : "";
    if (leaf.status === "failed") counts.failures++;
    if (leaf.status === "errored") counts.errors++;
    if (["skipped", "disabled"].includes(leaf.status)) counts.skipped++;
    if (leaf.status === "unknown") throw new EvidenceError("JUnit export requires complete classified observations; use JSON for unavailable evidence", 409);
    bytes += Buffer.byteLength(`<testcase classname="" name=""${leaf.durationMs === null ? "" : ` time="${leaf.durationMs / 1000}"`}>${status}</testcase>`) + escapedBytes(source.sourceId) + escapedBytes(leaf.id);
    if (bytes > TEAM_EVIDENCE_RESPONSE_BYTES) throw new EvidenceError("Evidence response exceeds its byte boundary", 413);
  }
  for (const count of Object.values(counts)) bytes += String(count).length - 1;
  if (bytes > TEAM_EVIDENCE_RESPONSE_BYTES) throw new EvidenceError("Evidence response exceeds its byte boundary", 413);
  return boundedEvidenceExport(evidenceExportJUnit(view));
}
export function teamEvidenceAccess(role: "viewer" | "editor" | "admin"): EvidenceCapability[] {
  return role === "admin" ? ["normalized_read", "import", "inventory_edit", "raw_export", "delete"] : role === "editor" ? ["normalized_read", "import"] : ["normalized_read"];
}

/** Internal composition only. TeamStore keeps this connection and every owner private. */
export class TeamEvidence {
  readonly #db: Database;
  readonly #imports = new EvidenceImportService(new EvidenceSupervisor());
  #closing?: Promise<void>;
  constructor(database: Database) { this.#db = database; this.#recover("restart_interrupted"); }
  get state() { return this.#imports.state; }
  #recover(code: "restart_interrupted" | "shutdown"): void {
    this.#db.transaction(() => {
      const count = this.#db.query("SELECT count(*) AS n FROM evaluation_evidence_jobs WHERE status IN ('queued','running')").get() as { n: number };
      if (!Number.isSafeInteger(count.n) || count.n > EVIDENCE_LIMITS.MAX_ACTIVE + EVIDENCE_LIMITS.MAX_QUEUED) throw new EvidenceError("Active evidence metadata exceeds its lifecycle boundary", 409);
      // Fixed application lifecycle maintenance, never a synthetic session or a report read.
      this.#db.query(`UPDATE evaluation_evidence_jobs SET status='failed',failure_code=?,job_token=?,reserved_raw_bytes=0,reserved_normalized_bytes=0
        WHERE status IN ('queued','running') AND scope_key IN (SELECT scope_key FROM team_evidence_scopes)`).run(code, randomUUID());
    }).immediate();
  }
  generation(owner: EvidenceOwner): number {
    owner.authorize("normalized_read", null);
    const row = this.#db.query("SELECT s.generation,s.active FROM evaluation_evidence_scopes s JOIN team_evidence_scopes t ON t.scope_key=s.scope_key WHERE t.project_id=? AND s.scope_key=?")
      .get(owner.scope.id, `project:${owner.scope.id}`) as { generation: number; active: number } | null;
    if (!row || row.active !== 1) throw new EvidenceError("Evidence scope is unavailable", 404);
    return evidenceInteger(row.generation, "scope generation", Number.MAX_SAFE_INTEGER, 1);
  }
  assertCurrent(owner: EvidenceOwner, generation: number): void {
    this.#db.transaction(() => { if (this.generation(owner) !== generation) throw new EvidenceError("Evidence scope changed", 409); }).immediate();
  }
  #response(owner: EvidenceOwner, value: unknown, status = 200, contentType = "application/json; charset=utf-8"): TeamEvidenceResponse {
    return this.#db.transaction(() => {
      const bytes = value instanceof Uint8Array ? value : contentType.startsWith("application/json") ? boundedJson(value) : Buffer.from(String(value), "utf8");
      const max = contentType === "application/octet-stream" ? EVIDENCE_LIMITS.MAX_SOURCE_BYTES : TEAM_EVIDENCE_RESPONSE_BYTES;
      if (bytes.byteLength > max) throw new EvidenceError("Evidence response exceeds its byte boundary", 413);
      return { bytes, status, contentType, generation: this.generation(owner) };
    }).immediate();
  }
  #setView(owner: EvidenceOwner, id: string, revision?: number): EvidenceSetView {
    id = evidenceText(id, "set ID");
    if (revision !== undefined) revision = evidenceInteger(revision, "revision", Number.MAX_SAFE_INTEGER, 1);
    const key = `project:${owner.scope.id}`;
    const where = "scope_key=? AND id=? AND revision=" + (revision === undefined ? "(SELECT max(revision) FROM evaluation_evidence_sets WHERE scope_key=? AND id=?)" : "?");
    const bindings = revision === undefined ? [key, id, key, id] : [key, id, revision];
    const metadata = this.#db.query(`SELECT revision,length(cast(data AS BLOB)) AS bytes,
      CASE WHEN typeof(data)='text' AND json_valid(data) THEN CASE WHEN json_type(data,'$.sources')='array' THEN json_array_length(data,'$.sources') ELSE NULL END ELSE NULL END AS sources
      FROM evaluation_evidence_sets WHERE ${where}`).get(...bindings) as { revision: number; bytes: number; sources: number | null } | null;
    if (!metadata) throw new EvidenceError("Evidence revision not found", 404);
    if (!Number.isSafeInteger(metadata.bytes) || metadata.bytes > EVIDENCE_LIMITS.MAX_NORMALIZED_BYTES || !Number.isSafeInteger(metadata.sources) || metadata.sources! < 1 || metadata.sources! > EVIDENCE_LIMITS.MAX_REPORTS) throw new EvidenceError("Stored evidence population exceeds its integrity boundary", 409);
    // Bound the complete selected payload population before the core materializes any source JSON.
    const budget = this.#db.query(`SELECT count(p.interpretation_id) AS count,coalesce(sum(length(cast(p.data AS BLOB))),0) AS bytes
      FROM evaluation_evidence_sets s JOIN json_each(s.data,'$.sources') r
      LEFT JOIN evaluation_evidence_payloads p ON p.scope_key=s.scope_key AND p.interpretation_id=json_extract(r.value,'$.interpretationId')
      WHERE s.scope_key=? AND s.id=? AND s.revision=?`).get(key, id, metadata.revision) as { count: number; bytes: number };
    if (!Number.isSafeInteger(budget.count) || budget.count > EVIDENCE_LIMITS.MAX_REPORTS || !Number.isSafeInteger(budget.bytes) || metadata.bytes + budget.bytes > EVIDENCE_LIMITS.MAX_NORMALIZED_BYTES) throw new EvidenceError("Stored evidence population exceeds its integrity boundary", 409);
    return owner.store.getSet(id, revision);
  }
  read(owner: EvidenceOwner, input: TeamEvidenceRead, access: EvidenceCapability[]): TeamEvidenceResponse {
    return this.#db.transaction(() => {
      this.generation(owner);
      switch (input.kind) {
        case "capabilities": return this.#response(owner, { transport: { version: 1, contentType: EVIDENCE_IMPORT_CONTENT_TYPE, maxHeaderBytes: EVIDENCE_HEADER_BYTES, maxFrameBytes: EVIDENCE_FRAME_BYTES }, reader: EVIDENCE_READER_IDENTITY,
          dialects: ["junit-xml/v1", "in-toto-statement/v1", "dsse-envelope/v1", "dsse-envelope-jsonl/v1"], limits: EVIDENCE_LIMITS, access });
        case "inventory": return this.#response(owner, new EvidenceInventories(owner).get(input.anchor, input.revision));
        case "job": {
          const id = evidenceText(input.id, "job ID");
          const row = this.#db.query("SELECT CASE WHEN typeof(request_data)='text' AND length(cast(request_data AS BLOB))<=65536 THEN request_data ELSE NULL END AS request FROM evaluation_evidence_jobs WHERE scope_key=? AND id=?")
            .get(`project:${owner.scope.id}`, id) as { request: string | null } | null;
          if (!row) throw new EvidenceError("Evidence job not found", 404);
          if (!row.request) throw new EvidenceError("Stored evidence integrity check failed", 409);
          const job = owner.store.getJob(id), request = parseEvidenceImportRequest(strictEvidenceJson(row.request, readerLimits()));
          return this.#response(owner, { job, declaredSources: request.sources, observationsAvailable: job.status === "completed", timings: this.#imports.timings(owner, id) });
        }
        case "operation": {
          const row = this.#db.query("SELECT CASE WHEN typeof(id)='text' AND length(cast(id AS BLOB))<=128 THEN id ELSE NULL END AS id FROM evaluation_evidence_jobs WHERE scope_key=? AND scope_generation=? AND operation_key=?")
            .get(`project:${owner.scope.id}`, this.generation(owner), evidenceText(input.operationKey, "operation key")) as { id: string | null } | null;
          if (!row) throw new EvidenceError("Evidence job not found", 404);
          if (!row.id) throw new EvidenceError("Stored evidence integrity check failed", 409);
          return this.#response(owner, { job: owner.store.getJob(row.id) });
        }
        case "sets": return this.#response(owner, listEvidenceSets(owner, input.attachment));
        case "set": return this.#response(owner, this.#setView(owner, input.id, input.revision));
        case "raw": return this.#response(owner, owner.store.exportRaw(input.id, input.revision, input.sourceId), 200, "application/octet-stream");
        case "export": {
          const view = this.#setView(owner, input.id, input.revision);
          if (input.format === "json") return this.#response(owner, evidenceExport(view));
          if (input.format === "junit") return this.#response(owner, boundedJUnit(view), 200, "application/xml; charset=utf-8");
          if (input.format === "text") return this.#response(owner, boundedEvidenceExport(evidenceExportText(view)), 200, "text/plain; charset=utf-8");
          throw new EvidenceError("Unsupported evidence export");
        }
      }
    }).immediate();
  }
  async receive(owner: EvidenceOwner, request: IncomingMessage): Promise<TeamEvidenceResponse> {
    const generation = this.#db.transaction(() => this.generation(owner)).immediate();
    const receipt = await this.#imports.receive(owner, request);
    this.assertCurrent(owner, generation);
    return this.#response(owner, receipt, 202);
  }
  async write(owner: EvidenceOwner, input: TeamEvidenceWrite): Promise<TeamEvidenceResponse> {
    const generation = this.#db.transaction(() => {
      owner.authorize(input.kind === "inventory" ? "inventory_edit" : input.kind === "clear" || input.kind === "retention" ? "delete" : "import", null);
      return this.generation(owner);
    }).immediate();
    let value: unknown, status = 200;
    switch (input.kind) {
      case "inventory": value = new EvidenceInventories(owner).save(input.value); status = 201; break;
      case "cancel": evidenceObject(input.value, [], "cancellation"); value = { cancelled: await this.#imports.cancel(owner, input.id) }; break;
      case "reparse": value = await this.#imports.reparse(owner, input.id, input.value); status = 202; break;
      case "retention": value = { removed: await this.#imports.removePayloads(owner, input.id, input.revision, input.target) }; break;
      case "clear": await this.#imports.clear(owner); value = { cleared: true }; break;
      default: throw new EvidenceError("Unsupported evidence operation");
    }
    if (input.kind !== "clear") this.assertCurrent(owner, generation);
    return this.#response(owner, value, status);
  }
  async invalidateRun(owner: EvidenceOwner, id: string): Promise<void> {
    const attachments: EvidenceAttachment[] = [{ kind: "run", id }, { kind: "inspection", id }];
    await this.#imports.invalidateAttachments(owner, attachments);
  }
  assertRunInactive(owner: EvidenceOwner, id: string): void {
    const count = this.#db.query("SELECT count(*) AS n FROM evaluation_evidence_jobs WHERE scope_key=? AND status IN ('queued','running')").get(`project:${owner.scope.id}`) as { n: number };
    if (count.n > EVIDENCE_LIMITS.MAX_ACTIVE + EVIDENCE_LIMITS.MAX_QUEUED) throw new EvidenceError("Active attachment metadata exceeds its boundary", 409);
    const rows = this.#db.query("SELECT CASE WHEN typeof(id)='text' AND length(cast(id AS BLOB)) BETWEEN 1 AND 128 THEN id ELSE NULL END AS id,CASE WHEN typeof(request_data)='text' AND length(cast(request_data AS BLOB))<=65536 THEN request_data ELSE NULL END AS request FROM evaluation_evidence_jobs WHERE scope_key=? AND status IN ('queued','running')")
      .all(`project:${owner.scope.id}`) as { id: string | null; request: string | null }[];
    for (const row of rows) {
      if (!row.request || !row.id) throw new EvidenceError("Active attachment metadata is unavailable", 409);
      owner.store.getJob(row.id);
      const request = parseEvidenceImportRequest(strictEvidenceJson(row.request, readerLimits()));
      if ((request.attachment.kind === "run" || request.attachment.kind === "inspection") && request.attachment.id === id) throw new EvidenceError("Run has an active external report import", 409);
    }
  }
  close(): Promise<void> {
    this.#closing ??= (async () => {
      let failure: unknown;
      try { this.#recover("shutdown"); } catch (error) { failure = error; }
      await this.#imports.shutdown();
      if (failure) throw failure instanceof Error ? failure : new EvidenceError("Evidence lifecycle failed", 409);
    })();
    return this.#closing;
  }
}
