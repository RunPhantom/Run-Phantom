import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { parseRecordingBatch, RecordingInputError, RECORDING_LIMITS as L, type RecordingBatch, type RecordingReason, type RecordingStatus, type RecordingSummary } from "./recording-types";

/** Private inactive fixture only; canonical installation belongs to the native migration owner. */
export const RECORDING_STORAGE_SQL = `-- INACTIVE F37 schema proposal. ROOT assigns the actual canonical prefix/index; never request-time DDL.
CREATE TABLE browser_recording_scopes (
 scope_key TEXT PRIMARY KEY NOT NULL CHECK(length(cast(scope_key AS BLOB)) BETWEEN 1 AND 128),
 generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991)
);
CREATE TABLE browser_recordings (
 scope_key TEXT NOT NULL REFERENCES browser_recording_scopes(scope_key) ON DELETE RESTRICT,
 recording_id TEXT NOT NULL CHECK(length(recording_id)=36),
 run_id TEXT NOT NULL CHECK(length(cast(run_id AS BLOB)) BETWEEN 1 AND 256),
 native_session_id TEXT NOT NULL CHECK(length(native_session_id)=32),
 owner_generation INTEGER NOT NULL CHECK(typeof(owner_generation)='integer' AND owner_generation BETWEEN 1 AND 9007199254740991),
 job_token TEXT NOT NULL CHECK(length(job_token)=64),
 engine TEXT NOT NULL CHECK(engine IN ('chromium','firefox','webkit')),
 engine_version TEXT NOT NULL CHECK(length(cast(engine_version AS BLOB)) BETWEEN 1 AND 64),
 producer_version INTEGER NOT NULL CHECK(producer_version=1),
 mask_policy TEXT NOT NULL CHECK(mask_policy='all-text-inputs-v1'),
 started_at INTEGER NOT NULL CHECK(typeof(started_at)='integer' AND started_at BETWEEN 0 AND 8640000000000000),
 ended_at INTEGER CHECK(ended_at IS NULL OR (typeof(ended_at)='integer' AND ended_at BETWEEN started_at AND 8640000000000000)),
 clock_offset_ms REAL CHECK(clock_offset_ms IS NULL OR clock_offset_ms BETWEEN -60000 AND 60000),
 clock_uncertainty_ms REAL CHECK(clock_uncertainty_ms IS NULL OR clock_uncertainty_ms BETWEEN 0 AND 60000),
 status TEXT NOT NULL CHECK(status IN ('recording','complete','partial','cancelled','interrupted','deleted')),
 loss INTEGER NOT NULL CHECK(typeof(loss)='integer' AND loss IN (0,1)),
 reason_code TEXT NOT NULL CHECK(reason_code IN ('none','node-cap','visit-cap','queue','capacity','document','clock','integrity','sequence','timeout','cancelled','interrupted','authority','unavailable','deleted')),
 next_sequence INTEGER NOT NULL CHECK(typeof(next_sequence)='integer' AND next_sequence BETWEEN 0 AND 128),
 event_count INTEGER NOT NULL CHECK(typeof(event_count)='integer' AND event_count BETWEEN 0 AND 8192),
 retained_bytes INTEGER NOT NULL CHECK(typeof(retained_bytes)='integer' AND retained_bytes BETWEEN 0 AND 4194304),
 dropped_count INTEGER CHECK(dropped_count IS NULL OR (typeof(dropped_count)='integer' AND dropped_count BETWEEN 0 AND 9007199254740991)),
 PRIMARY KEY(scope_key,recording_id)
);
CREATE TABLE browser_recording_batches (
 scope_key TEXT NOT NULL, recording_id TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 0 AND 127),
 data TEXT NOT NULL CHECK(json_valid(data) AND length(cast(data AS BLOB)) BETWEEN 1 AND 49152),
 digest TEXT NOT NULL CHECK(length(digest)=64),
 event_count INTEGER NOT NULL CHECK(typeof(event_count)='integer' AND event_count BETWEEN 1 AND 64),
 first_epoch_ms INTEGER NOT NULL CHECK(typeof(first_epoch_ms)='integer' AND first_epoch_ms BETWEEN 0 AND 8640000000000000),
 last_epoch_ms INTEGER NOT NULL CHECK(typeof(last_epoch_ms)='integer' AND last_epoch_ms BETWEEN first_epoch_ms AND 8640000000000000),
 PRIMARY KEY(scope_key,recording_id,sequence),
 FOREIGN KEY(scope_key,recording_id) REFERENCES browser_recordings(scope_key,recording_id) ON DELETE RESTRICT
);
CREATE INDEX browser_recording_run_window ON browser_recordings(scope_key,run_id,started_at DESC,recording_id);
CREATE TRIGGER browser_recording_head_no_delete BEFORE DELETE ON browser_recordings BEGIN SELECT RAISE(ABORT,'Recording lifetime identity retained'); END;
CREATE TRIGGER browser_recording_head_identity BEFORE UPDATE ON browser_recordings
 WHEN NEW.scope_key<>OLD.scope_key OR NEW.recording_id<>OLD.recording_id OR NEW.run_id<>OLD.run_id OR NEW.native_session_id<>OLD.native_session_id
 OR NEW.owner_generation<>OLD.owner_generation OR NEW.engine<>OLD.engine OR NEW.engine_version<>OLD.engine_version OR NEW.producer_version<>OLD.producer_version
 OR NEW.mask_policy<>OLD.mask_policy OR NEW.started_at<>OLD.started_at
 OR NEW.clock_offset_ms IS NOT OLD.clock_offset_ms OR NEW.clock_uncertainty_ms IS NOT OLD.clock_uncertainty_ms
 OR (NEW.job_token<>OLD.job_token AND NEW.status='recording') OR NEW.loss<OLD.loss
 OR (OLD.status<>'recording' AND NEW.status<>OLD.status AND NEW.status<>'deleted')
 OR (OLD.status='deleted' AND NEW.status<>'deleted')
 BEGIN SELECT RAISE(ABORT,'Immutable recording identity'); END;
CREATE TRIGGER browser_recording_batch_immutable BEFORE UPDATE ON browser_recording_batches BEGIN SELECT RAISE(ABORT,'Immutable recording batch'); END;
-- Native guarded transactions also validate canonical closed numeric DTOs, digest/order/document provenance,
-- exact duplicate acknowledgments, generation/token/current role, <=2 active native recordings, <=1 per browser,
-- <=100 retained heads/16 per run/1000 lifetime heads/32MiB aggregate masked payload. Terminal transitions
-- modify scalar metadata only; no growth batch is needed to stop/cancel/recover at retained payload capacity.
-- Deletion removes actual batch rows and keeps tombstones. No raw/unmasked recording, callback authority or URL is stored.
`;

export interface RecordingAuthority {
  readonly scopeKey: string;
  readonly generation: number;
  assertCurrent(mode: "read" | "write" | "record"): void;
  assertRun(runId: string): void;
}
type Head = {
  scope_key: string; recording_id: string; run_id: string; native_session_id: string; owner_generation: number; job_token: string;
  engine: RecordingSummary["engine"]; engine_version: string; producer_version: 1; mask_policy: "all-text-inputs-v1";
  started_at: number; ended_at: number | null; clock_offset_ms: number | null; clock_uncertainty_ms: number | null;
  status: RecordingStatus; loss: number; reason_code: RecordingReason; next_sequence: number; event_count: number; retained_bytes: number; dropped_count: number | null;
};
type StoredBatch = { sequence: number; data: string | null; digest: string; event_count: number; first_epoch_ms: number; last_epoch_ms: number };
export type RecordingAdmission = { runId: string; sessionId: string; engine: RecordingSummary["engine"]; engineVersion: string; startedAt: number; clockOffsetMs: number | null; clockUncertaintyMs: number | null };
export type RecordingLease = { summary: RecordingSummary; token: string };
export type RecordingPublication = { accepted: true; duplicate: boolean } | { accepted: false; reason: "stale" | "capacity" };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("hex");
function text(value: string, max: number): string {
  if (typeof value !== "string" || !value.length || value.length > max || Buffer.byteLength(value) > max) throw new RecordingInputError("Invalid recording identity");
  for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) < 32 || value.charCodeAt(index) === 127) throw new RecordingInputError("Invalid recording identity");
  return value;
}
function integer(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RecordingInputError("Invalid recording counter"); return value;
}
function identity(id: string): string { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw new RecordingInputError("Invalid recording identity"); return id; }
function continuity(batch: RecordingBatch, previous: RecordingBatch | null, startedAt: number): void {
  const first = batch.events[0], final = batch.events[batch.events.length - 1], priorEvent = previous?.events[previous.events.length - 1], previousDocument = previous?.document ?? 0;
  if (batch.document < previousDocument || batch.document > previousDocument + 1 || (!previous && batch.document !== 1) || (batch.document > previousDocument && first.kind !== 8) || first.ordinal <= (priorEvent?.ordinal ?? 0) || (first.ordinal !== (priorEvent?.ordinal ?? 0) + 1 && !batch.loss) || first.epochMs < (priorEvent?.epochMs ?? startedAt) || final.epochMs - startedAt > L.durationMs) throw new RecordingInputError("Recording document or event continuity refused", 409);
}
function summary(row: Head): RecordingSummary {
  return { id: row.recording_id, runId: row.run_id, sessionId: row.native_session_id, engine: row.engine, engineVersion: row.engine_version,
    producerVersion: row.producer_version, maskPolicy: row.mask_policy, startedAt: row.started_at, endedAt: row.ended_at,
    clockOffsetMs: row.clock_offset_ms, clockUncertaintyMs: row.clock_uncertainty_ms, status: row.status, loss: Boolean(row.loss), reason: row.reason_code,
    batches: row.next_sequence, events: row.event_count, bytes: row.retained_bytes, dropped: row.dropped_count };
}

/** Inactive component: receives the actual private connection and host authority; never creates a scope or schema. */
export class RecordingStore {
  readonly #db: Database; readonly #authority: RecordingAuthority; readonly #scope: string; readonly #generation: number;
  constructor(database: Database, authority: RecordingAuthority) {
    this.#db = database; this.#authority = authority; this.#scope = text(authority.scopeKey, 128); this.#generation = integer(authority.generation, 1, Number.MAX_SAFE_INTEGER);
  }
  private transaction<T>(mode: "read" | "write" | "record", work: () => T): T {
    this.#authority.assertCurrent(mode);
    return this.#db.transaction(() => {
      this.#authority.assertCurrent(mode);
      const current = this.#db.query("SELECT generation FROM browser_recording_scopes WHERE scope_key=?").get(this.#scope) as { generation: number } | null;
      if (!current || current.generation !== this.#generation) throw new RecordingInputError("Recording authority is no longer current", 409);
      return work();
    }).immediate();
  }
  private head(id: string): Head {
    const row = this.#db.query("SELECT * FROM browser_recordings WHERE scope_key=? AND recording_id=?").get(this.#scope, identity(id)) as Head | null;
    if (!row) throw new RecordingInputError("Masked recording not found", 404);
    return row;
  }
  private rows(id: string): StoredBatch[] {
    return this.#db.query("SELECT sequence,CASE WHEN length(cast(data AS BLOB))<=49152 THEN data END data,digest,event_count,first_epoch_ms,last_epoch_ms FROM browser_recording_batches WHERE scope_key=? AND recording_id=? ORDER BY sequence LIMIT 129").all(this.#scope, id) as StoredBatch[];
  }
  private decode(row: StoredBatch): RecordingBatch {
    if (row.data === null || !/^[a-f0-9]{64}$/.test(row.digest) || hash(row.data) !== row.digest) throw new RecordingInputError("Masked recording integrity is unavailable", 409);
    const parsed = parseRecordingBatch(row.data);
    if (parsed.sequence !== row.sequence || parsed.events.length !== row.event_count || parsed.events[0].epochMs !== row.first_epoch_ms || parsed.events[parsed.events.length - 1].epochMs !== row.last_epoch_ms) throw new RecordingInputError("Masked recording metadata is inconsistent", 409);
    return parsed;
  }
  admit(input: RecordingAdmission): RecordingLease {
    return this.transaction("record", () => {
      const runId = text(input.runId, 256); this.#authority.assertRun(runId);
      if (!/^[a-f0-9]{32}$/.test(input.sessionId) || !["chromium", "firefox", "webkit"].includes(input.engine)) throw new RecordingInputError("Invalid native recording provenance");
      const version = text(input.engineVersion, 64), started = integer(input.startedAt, 0, L.epoch);
      const offset = input.clockOffsetMs, uncertainty = input.clockUncertaintyMs;
      if ((offset === null) !== (uncertainty === null) || (offset !== null && (!Number.isFinite(offset) || Math.abs(offset) > 60_000 || !Number.isFinite(uncertainty) || uncertainty! < 0 || uncertainty! > 60_000))) throw new RecordingInputError("Invalid native recording clock");
      const population = this.#db.query("SELECT count(*) lifetimes,sum(CASE WHEN status<>'deleted' THEN 1 ELSE 0 END) retained,sum(CASE WHEN status='recording' THEN 1 ELSE 0 END) active FROM browser_recordings").get() as { lifetimes: number; retained: number | null; active: number | null };
      const run = this.#db.query("SELECT count(*) n FROM browser_recordings WHERE scope_key=? AND run_id=? AND status<>'deleted'").get(this.#scope, runId) as { n: number };
      const browser = this.#db.query("SELECT count(*) n FROM browser_recordings WHERE native_session_id=? AND status='recording'").get(input.sessionId) as { n: number };
      if (population.lifetimes >= L.lifetimes || (population.retained ?? 0) >= L.records || (population.active ?? 0) >= L.active || run.n >= L.perRun || browser.n) throw new RecordingInputError("Masked recording capacity is full", 409);
      const id = randomUUID(), lease = token(), unknownClock = offset === null;
      this.#db.query("INSERT INTO browser_recordings(scope_key,recording_id,run_id,native_session_id,owner_generation,job_token,engine,engine_version,producer_version,mask_policy,started_at,ended_at,clock_offset_ms,clock_uncertainty_ms,status,loss,reason_code,next_sequence,event_count,retained_bytes,dropped_count) VALUES(?,?,?,?,?,?,?,?,1,'all-text-inputs-v1',?,NULL,?,?,'recording',?,?,0,0,0,0)").run(this.#scope, id, runId, input.sessionId, this.#generation, lease, input.engine, version, started, offset, uncertainty, unknownClock ? 1 : 0, unknownClock ? "clock" : "none");
      return { summary: summary(this.head(id)), token: lease };
    });
  }
  get(id: string): RecordingSummary { return this.transaction("read", () => summary(this.head(id))); }
  list(runId: string): RecordingSummary[] {
    return this.transaction("read", () => { const run = text(runId, 256); this.#authority.assertRun(run); return (this.#db.query("SELECT * FROM browser_recordings WHERE scope_key=? AND run_id=? AND status<>'deleted' ORDER BY started_at DESC,recording_id LIMIT 16").all(this.#scope, run) as Head[]).map(summary); });
  }
  publish(id: string, lease: string, raw: string): RecordingPublication {
    return this.transaction("record", () => {
      const head = this.head(id);
      if (head.status !== "recording" || head.job_token !== lease || head.owner_generation !== this.#generation) return { accepted: false, reason: "stale" };
      this.#authority.assertRun(head.run_id);
      const batch = parseRecordingBatch(raw), digest = hash(raw), bytes = Buffer.byteLength(raw);
      if (batch.sequence < head.next_sequence) {
        const prior = this.#db.query("SELECT digest,data FROM browser_recording_batches WHERE scope_key=? AND recording_id=? AND sequence=?").get(this.#scope, id, batch.sequence) as { digest: string; data: string } | null;
        if (!prior || prior.digest !== digest || prior.data !== raw) throw new RecordingInputError("Changed recording retry refused", 409);
        return { accepted: true, duplicate: true };
      }
      if (batch.sequence !== head.next_sequence) throw new RecordingInputError("Recording sequence gap refused", 409);
      const last = this.#db.query("SELECT sequence,data,digest,event_count,first_epoch_ms,last_epoch_ms FROM browser_recording_batches WHERE scope_key=? AND recording_id=? ORDER BY sequence DESC LIMIT 1").get(this.#scope, id) as StoredBatch | null;
      const previous = last ? this.decode(last) : null, first = batch.events[0], final = batch.events[batch.events.length - 1];
      continuity(batch, previous, head.started_at);
      const total = (this.#db.query("SELECT coalesce(sum(length(cast(data AS BLOB))),0) bytes FROM browser_recording_batches").get() as { bytes: number }).bytes;
      const retained = (this.#db.query("SELECT count(*) n,coalesce(sum(event_count),0) events,coalesce(sum(length(cast(data AS BLOB))),0) bytes FROM browser_recording_batches WHERE scope_key=? AND recording_id=?").get(this.#scope, id) as { n: number; events: number; bytes: number });
      if (retained.n !== head.next_sequence || retained.events !== head.event_count || retained.bytes !== head.retained_bytes) throw new RecordingInputError("Recording accounting is inconsistent", 409);
      if (head.next_sequence >= L.batches || head.event_count + batch.events.length > L.events || retained.bytes + bytes > L.recordingBytes || total + bytes > L.aggregateBytes) {
        this.#db.query("UPDATE browser_recordings SET status='partial',loss=1,reason_code='capacity',job_token=? WHERE scope_key=? AND recording_id=?").run(token(), this.#scope, id);
        return { accepted: false, reason: "capacity" };
      }
      this.#db.query("INSERT INTO browser_recording_batches(scope_key,recording_id,sequence,data,digest,event_count,first_epoch_ms,last_epoch_ms) VALUES(?,?,?,?,?,?,?,?)").run(this.#scope, id, batch.sequence, raw, digest, batch.events.length, first.epochMs, final.epochMs);
      const documentChange = previous !== null && previous.document !== batch.document;
      const lost = Boolean(head.loss) || batch.loss || documentChange;
      const dropped = head.dropped_count === null || batch.dropped === null ? null : Math.max(head.dropped_count, batch.dropped);
      this.#db.query("UPDATE browser_recordings SET next_sequence=next_sequence+1,event_count=event_count+?,retained_bytes=retained_bytes+?,loss=?,reason_code=?,dropped_count=? WHERE scope_key=? AND recording_id=?").run(batch.events.length, bytes, lost ? 1 : 0, documentChange ? "document" : batch.loss && head.reason_code === "none" ? "unavailable" : head.reason_code, dropped, this.#scope, id);
      return { accepted: true, duplicate: false };
    });
  }
  batches(id: string): { summary: RecordingSummary; entries: { batch: RecordingBatch; digest: string }[] } {
    return this.transaction("read", () => {
      const head = this.head(id); if (head.status === "deleted") throw new RecordingInputError("Masked recording content was deleted", 410);
      const footprint = this.#db.query("SELECT count(*) n,coalesce(sum(event_count),0) events,coalesce(sum(length(cast(data AS BLOB))),0) bytes FROM browser_recording_batches WHERE scope_key=? AND recording_id=?").get(this.#scope, id) as { n: number; events: number; bytes: number };
      if (footprint.n > L.batches || footprint.events > L.events || footprint.bytes > L.recordingBytes || footprint.n !== head.next_sequence || footprint.events !== head.event_count || footprint.bytes !== head.retained_bytes) throw new RecordingInputError("Masked recording accounting is inconsistent", 409);
      const rows = this.rows(id); const entries = rows.map(row => ({ batch: this.decode(row), digest: row.digest }));
      if (rows.length !== head.next_sequence || rows.length > L.batches || rows.some((row, index) => row.sequence !== index) || rows.reduce((sum, row) => sum + Buffer.byteLength(row.data!), 0) !== head.retained_bytes || rows.reduce((sum, row) => sum + row.event_count, 0) !== head.event_count) throw new RecordingInputError("Masked recording accounting is inconsistent", 409);
      for (let index = 0; index < entries.length; index++) continuity(entries[index].batch, index === 0 ? null : entries[index - 1].batch, head.started_at);
      return { summary: summary(head), entries };
    });
  }
  finish(id: string, lease: string, status: "complete" | "partial" | "cancelled", reason: RecordingReason, endedAt: number | null): boolean {
    return this.transaction("record", () => {
      const head = this.head(id); if (head.status !== "recording" || head.job_token !== lease || head.owner_generation !== this.#generation) return false;
      if (!["complete", "partial", "cancelled"].includes(status)) throw new RecordingInputError("Invalid recording stop status");
      if (endedAt !== null) integer(endedAt, head.started_at, L.epoch);
      if (!["none", "node-cap", "visit-cap", "queue", "capacity", "document", "clock", "integrity", "sequence", "timeout", "cancelled", "interrupted", "authority", "unavailable", "deleted"].includes(reason)) throw new RecordingInputError("Invalid recording stop reason");
      const empty = head.event_count === 0;
      const lost = Boolean(head.loss) || status !== "complete" || endedAt === null || empty;
      this.#db.query("UPDATE browser_recordings SET status=?,reason_code=?,loss=?,ended_at=?,job_token=? WHERE scope_key=? AND recording_id=?").run(status === "complete" && lost ? "partial" : status, reason === "none" && lost ? empty ? "unavailable" : head.reason_code === "none" ? "clock" : head.reason_code : reason, lost ? 1 : 0, endedAt, token(), this.#scope, id);
      return true;
    });
  }
  recover(): number {
    return this.transaction("write", () => this.#db.query("UPDATE browser_recordings SET status='interrupted',reason_code='interrupted',loss=1,job_token=? WHERE scope_key=? AND status='recording' AND owner_generation<>?").run(token(), this.#scope, this.#generation).changes);
  }
  delete(id: string): void {
    this.transaction("write", () => {
      const head = this.head(id); if (head.status === "deleted") return;
      // Fence the retained lifetime identity BEFORE deleting payload; both steps commit atomically.
      this.#db.query("UPDATE browser_recordings SET status='deleted',reason_code='deleted',job_token=? WHERE scope_key=? AND recording_id=?").run(token(), this.#scope, id);
      this.#db.query("DELETE FROM browser_recording_batches WHERE scope_key=? AND recording_id=?").run(this.#scope, id);
      this.#db.query("UPDATE browser_recordings SET next_sequence=0,event_count=0,retained_bytes=0 WHERE scope_key=? AND recording_id=?").run(this.#scope, id);
    });
  }
}
