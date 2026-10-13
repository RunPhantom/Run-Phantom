import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { EvaluationError } from "./validation";
import { EXECUTION_LIMITS as L, type DatasetExecution } from "./execution-protocol";

/** Inactive schema fixture. The root coordinator alone installs canonical15 after the real prefix. */
export const EXECUTION_STORAGE_SQL = `-- INACTIVE proposal: canonical15 AFTER actual qualified13+14, no placeholder prefix.
CREATE TABLE dataset_execution_receipts (
 scope_key TEXT NOT NULL CHECK(scope_key='local:local'),
 operation_key TEXT NOT NULL CHECK(length(cast(operation_key AS BLOB)) BETWEEN 1 AND 128),
 execution_id TEXT NOT NULL UNIQUE CHECK(length(execution_id)=36), request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
 cost_account TEXT NOT NULL CHECK(length(cast(cost_account AS BLOB)) BETWEEN 1 AND 128),
 endpoint_name TEXT NOT NULL CHECK(length(cast(endpoint_name AS BLOB)) BETWEEN 1 AND 128),
 endpoint_policy_digest TEXT NOT NULL CHECK(length(endpoint_policy_digest)=64),
 job_token TEXT NOT NULL CHECK(length(job_token)=36),
 status TEXT NOT NULL CHECK(status IN ('queued','running','completed','cancelled','interrupted','deleted')),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(scope_key,operation_key)
);
CREATE TABLE dataset_execution_attempts (
 execution_id TEXT NOT NULL REFERENCES dataset_execution_receipts(execution_id) ON DELETE RESTRICT,
 attempt_id TEXT NOT NULL UNIQUE CHECK(length(attempt_id)=36),
 case_id TEXT NOT NULL CHECK(length(cast(case_id AS BLOB)) BETWEEN 1 AND 128),
 position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position BETWEEN 0 AND 2),
 status TEXT NOT NULL CHECK(status IN ('not_started','running','transport_success','failed','timed_out','cancelled','interrupted','unavailable')),
 reserve_microusd INTEGER NOT NULL CHECK(typeof(reserve_microusd)='integer' AND reserve_microusd BETWEEN 0 AND 30000000),
 hold_microusd INTEGER NOT NULL CHECK(typeof(hold_microusd)='integer' AND hold_microusd BETWEEN 0 AND 30000000),
 charged_or_uncertain_microusd INTEGER NOT NULL CHECK(typeof(charged_or_uncertain_microusd)='integer' AND charged_or_uncertain_microusd BETWEEN 0 AND 30000000),
 deadline_at INTEGER NOT NULL CHECK(typeof(deadline_at)='integer' AND deadline_at BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(execution_id,attempt_id), CHECK(hold_microusd+charged_or_uncertain_microusd<=reserve_microusd)
);
CREATE TABLE dataset_execution_content (
 execution_id TEXT PRIMARY KEY NOT NULL REFERENCES dataset_execution_receipts(execution_id) ON DELETE RESTRICT,
 dataset_id TEXT NOT NULL CHECK(length(cast(dataset_id AS BLOB)) BETWEEN 1 AND 128),
 dataset_version INTEGER NOT NULL CHECK(typeof(dataset_version)='integer' AND dataset_version BETWEEN 1 AND 9007199254740991),
 dataset_hash TEXT NOT NULL CHECK(length(dataset_hash)=64),
 data TEXT NOT NULL CHECK(json_valid(data) AND length(cast(data AS BLOB))<=4194304), digest TEXT NOT NULL CHECK(length(digest)=64),
 completed_at INTEGER CHECK(completed_at IS NULL OR (typeof(completed_at)='integer' AND completed_at BETWEEN 0 AND 9007199254740991))
);
CREATE INDEX dataset_execution_window ON dataset_execution_receipts(created_at DESC,execution_id);
CREATE INDEX dataset_execution_account ON dataset_execution_receipts(cost_account);
CREATE INDEX dataset_execution_running ON dataset_execution_attempts(status);
CREATE TRIGGER dataset_execution_receipt_no_delete BEFORE DELETE ON dataset_execution_receipts BEGIN SELECT RAISE(ABORT,'Execution receipt retained'); END;
CREATE TRIGGER dataset_execution_attempt_no_delete BEFORE DELETE ON dataset_execution_attempts BEGIN SELECT RAISE(ABORT,'Execution charge retained'); END;
CREATE TRIGGER dataset_execution_receipt_identity BEFORE UPDATE ON dataset_execution_receipts
 WHEN NEW.scope_key<>OLD.scope_key OR NEW.operation_key<>OLD.operation_key OR NEW.execution_id<>OLD.execution_id OR NEW.request_digest<>OLD.request_digest
 OR NEW.cost_account<>OLD.cost_account OR NEW.endpoint_name<>OLD.endpoint_name OR NEW.endpoint_policy_digest<>OLD.endpoint_policy_digest OR NEW.created_at<>OLD.created_at
 OR (OLD.status NOT IN ('queued','running') AND NEW.status<>OLD.status AND NEW.status<>'deleted')
 OR (OLD.status='deleted' AND NEW.status<>'deleted')
 BEGIN SELECT RAISE(ABORT,'Immutable execution receipt'); END;
CREATE TRIGGER dataset_execution_attempt_identity BEFORE UPDATE ON dataset_execution_attempts
 WHEN NEW.execution_id<>OLD.execution_id OR NEW.attempt_id<>OLD.attempt_id OR NEW.case_id<>OLD.case_id OR NEW.position<>OLD.position
 OR NEW.reserve_microusd<>OLD.reserve_microusd OR NEW.deadline_at<>OLD.deadline_at
 OR NEW.charged_or_uncertain_microusd<OLD.charged_or_uncertain_microusd OR NEW.hold_microusd>OLD.hold_microusd
 OR (OLD.status NOT IN ('not_started','running') AND (NEW.status<>OLD.status OR NEW.hold_microusd<>OLD.hold_microusd OR NEW.charged_or_uncertain_microusd<>OLD.charged_or_uncertain_microusd))
 OR (OLD.status='running' AND NEW.status='not_started')
 BEGIN SELECT RAISE(ABORT,'Immutable execution attempt accounting'); END;
CREATE TRIGGER dataset_execution_content_identity BEFORE UPDATE ON dataset_execution_content
 WHEN NEW.execution_id<>OLD.execution_id OR NEW.dataset_id<>OLD.dataset_id OR NEW.dataset_version<>OLD.dataset_version OR NEW.dataset_hash<>OLD.dataset_hash
 BEGIN SELECT RAISE(ABORT,'Immutable execution source'); END;
-- Native transactions additionally enforce <=1000 immutable receipts, <=5000 planned attempts,
-- <=200 content rows and <=32MiB total retained content, <=2 active operations and GLOBAL2 actual callbacks.
-- Reserve then conservatively debit before dispatch; unknown charges are never refunded.
-- Content deletion/clear preserves lifetime account/operation key; second owner cannot recover a live first owner.
`;
export interface ExecutionAuthority { assertCurrent(): void }
export interface ExecutionAccountingPolicy { costAccount: string; policyDigest: string; maximumAttemptMicrousd: number; maximumTotalMicrousd: number }
interface Receipt { scope_key: string; operation_key: string; execution_id: string; request_digest: string; cost_account: string; endpoint_name: string;
  endpoint_policy_digest: string; job_token: string; status: string; created_at: number }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function encoded(value: DatasetExecution): string {
  const data = JSON.stringify(value);
  if (Buffer.byteLength(data) > L.MAX_RECORD_BYTES) throw new EvaluationError("Execution exceeds its retained bound", 413);
  return data;
}
/** Connection and native authority stay private; callers cannot choose scope or execution lease. */
export class ExecutionStore {
  readonly #db: Database; readonly #authority: ExecutionAuthority;
  constructor(database: Database, authority: ExecutionAuthority) { this.#db = database; this.#authority = authority; }
  /** Capture helpers use the global native connection; a different profile cannot supply evidence. */
  assertDatabase(database: Database): void {
    this.#authority.assertCurrent();
    if (database !== this.#db) throw new EvaluationError("Execution capture database does not match its owner", 409);
  }
  private transaction<T>(work: () => T): T { return this.#db.transaction(() => { this.#authority.assertCurrent(); return work(); }).immediate(); }
  private receipt(id: string): Receipt {
    const row = this.#db.query("SELECT * FROM dataset_execution_receipts WHERE execution_id=? AND scope_key='local:local'").get(id) as Receipt | null;
    if (!row) throw new EvaluationError("Execution not found", 404); return row;
  }
  private read(id: string): DatasetExecution {
    const row = this.#db.query("SELECT CASE WHEN length(cast(data AS BLOB))<=4194304 THEN data END data,digest FROM dataset_execution_content WHERE execution_id=?").get(id) as { data: string | null; digest: string } | null;
    if (!row) throw new EvaluationError("Execution content was removed; operation identity is retained", 410);
    if (row.data === null || digest(row.data) !== row.digest) throw new EvaluationError("Execution integrity is unavailable", 409);
    return JSON.parse(row.data) as DatasetExecution;
  }
  get(id: string): DatasetExecution { return this.transaction(() => { this.receipt(id); return this.read(id); }); }
  admit(execution: DatasetExecution, policy: ExecutionAccountingPolicy): { execution: DatasetExecution; token: string; reused: boolean } {
    const data = encoded(execution);
    return this.transaction(() => {
      const prior = this.#db.query("SELECT * FROM dataset_execution_receipts WHERE scope_key='local:local' AND operation_key=?").get(execution.request.operationKey) as Receipt | null;
      if (prior) {
        if (prior.request_digest !== execution.requestDigest) throw new EvaluationError("Operation key conflicts with a frozen request", 409);
        return { execution: this.read(prior.execution_id), token: prior.job_token, reused: true };
      }
      const counts = this.#db.query("SELECT count(*) n,sum(status IN ('queued','running')) active FROM dataset_execution_receipts").get() as { n: number; active: number | null };
      const content = this.#db.query("SELECT count(*) n,coalesce(sum(length(cast(data AS BLOB))),0) bytes FROM dataset_execution_content").get() as { n: number; bytes: number };
      const planned = execution.cases.flatMap(item => item.attempts), totalAttempts = (this.#db.query("SELECT count(*) n FROM dataset_execution_attempts").get() as { n: number }).n;
      if (counts.n >= 1000 || (counts.active ?? 0) >= L.MAX_ACTIVE || content.n >= L.MAX_OPERATIONS || content.bytes + Buffer.byteLength(data) > 32 * 1024 * 1024 || totalAttempts + planned.length > 5000) throw new EvaluationError("Execution retention or active capacity is full", 409);
      const reserve = Math.ceil(execution.request.maxCostPerAttemptUsd * 1_000_000);
      if (!policy.costAccount || policy.costAccount.length > 128 || !/^[a-f0-9]{64}$/.test(policy.policyDigest) || reserve !== policy.maximumAttemptMicrousd ||
        !Number.isSafeInteger(policy.maximumTotalMicrousd) || policy.maximumTotalMicrousd < 0 || policy.maximumTotalMicrousd > 30_000_000) throw new EvaluationError("Native cost authority is unavailable", 409);
      const existingAccount = this.#db.query("SELECT cost_account FROM dataset_execution_receipts WHERE endpoint_name=? LIMIT 1").get(execution.request.endpointName) as { cost_account: string } | null;
      if (existingAccount && existingAccount.cost_account !== policy.costAccount) throw new EvaluationError("Native endpoint cost account cannot reset lifetime accounting", 409);
      const used = (this.#db.query("SELECT coalesce(sum(a.hold_microusd+a.charged_or_uncertain_microusd),0) amount FROM dataset_execution_attempts a JOIN dataset_execution_receipts r ON r.execution_id=a.execution_id WHERE r.cost_account=?").get(policy.costAccount) as { amount: number }).amount;
      if (!Number.isSafeInteger(used) || used + reserve * planned.length > policy.maximumTotalMicrousd) throw new EvaluationError("Native cost account admission ceiling reached", 409);
      const token = randomUUID();
      this.#db.query("INSERT INTO dataset_execution_receipts VALUES('local:local',?,?,?,?,?,?,?,'queued',?)").run(execution.request.operationKey, execution.id, execution.requestDigest, policy.costAccount, execution.request.endpointName, policy.policyDigest, token, execution.createdAt);
      for (const item of execution.cases) for (const attempt of item.attempts) this.#db.query("INSERT INTO dataset_execution_attempts VALUES(?,?,?,?, 'not_started',?,?,0,?)").run(execution.id, attempt.id, item.case.id, attempt.index, reserve, reserve, execution.createdAt + execution.request.timeoutMs);
      this.#db.query("INSERT INTO dataset_execution_content VALUES(?,?,?,?,?,?,NULL)").run(execution.id, execution.dataset.id, execution.dataset.version, execution.dataset.hash, data, digest(data));
      return { execution: structuredClone(execution), token, reused: false };
    });
  }
  begin(id: string, attemptId: string, token: string): boolean {
    return this.transaction(() => {
      const receipt = this.receipt(id); if (receipt.job_token !== token || !["queued", "running"].includes(receipt.status)) return false;
      const running = (this.#db.query("SELECT count(*) n FROM dataset_execution_attempts WHERE status='running'").get() as { n: number }).n;
      if (running >= L.MAX_CONCURRENCY) return false;
      const changed = this.#db.query("UPDATE dataset_execution_attempts SET status='running',charged_or_uncertain_microusd=reserve_microusd,hold_microusd=0 WHERE execution_id=? AND attempt_id=? AND status='not_started' AND deadline_at>?").run(id, attemptId, Date.now()).changes;
      if (changed) {
        this.#db.query("UPDATE dataset_execution_receipts SET status='running' WHERE execution_id=?").run(id);
        const content = this.read(id), attempt = content.cases.flatMap(item => item.attempts).find(item => item.id === attemptId);
        if (!attempt) throw new EvaluationError("Attempt identity is unavailable", 409);
        attempt.status = "running"; attempt.startedAt = Date.now(); attempt.sideEffects = "may_have_occurred"; content.status = "running";
        const data = encoded(content); this.#db.query("UPDATE dataset_execution_content SET data=?,digest=? WHERE execution_id=?").run(data,digest(data),id);
      }
      return changed === 1;
    });
  }
  publish(execution: DatasetExecution, token: string): boolean {
    const data = encoded(execution);
    return this.transaction(() => {
      const receipt = this.receipt(execution.id); if (receipt.job_token !== token || !["queued", "running"].includes(receipt.status)) return false;
      const prior = this.read(execution.id);
      const identity = (value: DatasetExecution) => JSON.stringify([value.id,value.requestDigest,value.request,value.dataset,value.createdAt,value.cases.map(item => [item.case,item.attempts.map(attempt => [attempt.id,attempt.index])])]);
      if (identity(prior) !== identity(execution)) throw new EvaluationError("Execution frozen identity changed", 409);
      for (const item of execution.cases) for (const attempt of item.attempts) {
        if (attempt.status === "running" || attempt.status === "not_started") continue; // Only begin() authorizes dispatch; queued work retains its hold.
        this.#db.query("UPDATE dataset_execution_attempts SET status=?,hold_microusd=0 WHERE execution_id=? AND attempt_id=? AND status IN ('not_started','running')").run(attempt.status, execution.id, attempt.id);
      }
      this.#db.query("UPDATE dataset_execution_content SET data=?,digest=?,completed_at=? WHERE execution_id=?").run(data,digest(data),execution.completedAt,execution.id);
      this.#db.query("UPDATE dataset_execution_receipts SET status=? WHERE execution_id=?").run(execution.status,execution.id);
      return true;
    });
  }
  private stop(id: string, status: "cancelled" | "interrupted"): DatasetExecution {
    const receipt = this.receipt(id), execution = this.read(id);
    if (!["queued", "running"].includes(receipt.status)) return execution;
    for (const item of execution.cases) for (const attempt of item.attempts) if (["not_started","running"].includes(attempt.status)) { attempt.status = status; attempt.reason = status === "cancelled" ? "Cancelled; possible external side effects are retained" : "Interrupted; no automatic execution on restart"; attempt.completedAt = Date.now(); }
    execution.status = status; execution.completedAt = Date.now();
    this.#db.query("UPDATE dataset_execution_attempts SET status=?,hold_microusd=0 WHERE execution_id=? AND status IN ('not_started','running')").run(status,id);
    const data = encoded(execution); this.#db.query("UPDATE dataset_execution_content SET data=?,digest=?,completed_at=? WHERE execution_id=?").run(data,digest(data),execution.completedAt,id);
    this.#db.query("UPDATE dataset_execution_receipts SET status=?,job_token=? WHERE execution_id=?").run(status,randomUUID(),id); return execution;
  }
  cancel(id: string): DatasetExecution { return this.transaction(() => this.stop(id,"cancelled")); }
  /** Authority closure must already hold the exclusive kernel owner lease. Never called by construction. */
  recover(): void { this.transaction(() => { for (const row of this.#db.query("SELECT execution_id id FROM dataset_execution_receipts WHERE status IN ('queued','running')").all() as Array<{id:string}>) this.stop(row.id,"interrupted"); }); }
  clear(): void { this.transaction(() => {
    for (const row of this.#db.query("SELECT execution_id id FROM dataset_execution_receipts WHERE status IN ('queued','running')").all() as Array<{id:string}>) this.stop(row.id,"cancelled");
    this.#db.exec("DELETE FROM dataset_execution_content");
    this.#db.exec("UPDATE dataset_execution_receipts SET status='deleted' WHERE status<>'deleted'");
  }); }
}
