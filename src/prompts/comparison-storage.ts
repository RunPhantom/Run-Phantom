/** Inactive reviewed suffix: migration coordinators alone may install it after canonical13/Teamv4. */
export const COMPARISON_STORAGE_SQL = `
-- Proposed only: canonical suffix 14 AFTER actual qualified 13; Team v5 AFTER actual qualified v4.
CREATE TABLE comparison_scope_controls (
 scope_key TEXT PRIMARY KEY NOT NULL REFERENCES evaluation_evidence_scopes(scope_key) ON DELETE CASCADE
 CHECK(length(CAST(scope_key AS BLOB)) BETWEEN 1 AND 128),
 generation INTEGER NOT NULL DEFAULT 1 CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991)
);
-- Deliberately no scope/control foreign key: lifetime receipts survive scope destruction.
CREATE TABLE prompt_comparisons (
 scope_key TEXT NOT NULL CHECK(length(CAST(scope_key AS BLOB)) BETWEEN 1 AND 128),
 id TEXT NOT NULL CHECK(length(id)=36), operation_key TEXT NOT NULL CHECK(length(operation_key)=36),
 request_digest TEXT NOT NULL CHECK(length(request_digest)=64), prompt_id TEXT CHECK(prompt_id IS NULL OR length(prompt_id)=36),
 frozen_request TEXT CHECK(frozen_request IS NULL OR length(CAST(frozen_request AS BLOB))<=24576),
 prompt_generation INTEGER NOT NULL CHECK(typeof(prompt_generation)='integer' AND prompt_generation BETWEEN 1 AND 9007199254740991),
 evidence_generation INTEGER NOT NULL CHECK(typeof(evidence_generation)='integer' AND evidence_generation BETWEEN 1 AND 9007199254740991),
 comparison_generation INTEGER NOT NULL CHECK(typeof(comparison_generation)='integer' AND comparison_generation BETWEEN 1 AND 9007199254740991),
 target_count INTEGER NOT NULL CHECK(typeof(target_count)='integer' AND target_count BETWEEN 1 AND 4),
 tombstone INTEGER NOT NULL DEFAULT 0 CHECK(tombstone IN(0,1)),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
 CHECK((tombstone=0 AND frozen_request IS NOT NULL AND prompt_id IS NOT NULL) OR (tombstone=1 AND frozen_request IS NULL AND prompt_id IS NULL)),
 PRIMARY KEY(scope_key,id)
);
CREATE UNIQUE INDEX prompt_comparisons_operation_unique ON prompt_comparisons(scope_key,operation_key);
CREATE INDEX prompt_comparisons_scope ON prompt_comparisons(scope_key,tombstone,created_at DESC,id DESC);
CREATE TABLE prompt_comparison_attempts (
 scope_key TEXT NOT NULL, comparison_id TEXT NOT NULL,
 position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position BETWEEN 0 AND 3),
 provider TEXT NOT NULL CHECK(provider IN('openai','anthropic')), model TEXT NOT NULL CHECK(length(CAST(model AS BLOB)) BETWEEN 1 AND 128),
 status TEXT NOT NULL CHECK(status IN('queued','running','completed','failed','timeout','cancelled','unavailable','budget_refused','interrupted','authority_lost')),
 reason TEXT CHECK(reason IS NULL OR length(CAST(reason AS BLOB))<=64),
 payload TEXT CHECK(payload IS NULL OR length(CAST(payload AS BLOB))<=8192),
 reserve_microusd INTEGER NOT NULL CHECK(typeof(reserve_microusd)='integer' AND reserve_microusd BETWEEN 0 AND 30000000),
 hold_microusd INTEGER NOT NULL CHECK(typeof(hold_microusd)='integer' AND hold_microusd BETWEEN 0 AND 30000000),
 charge_microusd INTEGER NOT NULL CHECK(typeof(charge_microusd)='integer' AND charge_microusd BETWEEN 0 AND 2251799813685),
 accounting_state TEXT NOT NULL CHECK(accounting_state IN('not_started','measured_estimate','conservative','unrepresentable_overage')),
 observed_estimate_usd TEXT CHECK(observed_estimate_usd IS NULL OR length(CAST(observed_estimate_usd AS BLOB))<=64),
 budget_breach INTEGER NOT NULL DEFAULT 0 CHECK(budget_breach IN(0,1)),
 deadline_at INTEGER NOT NULL CHECK(typeof(deadline_at)='integer' AND deadline_at BETWEEN 0 AND 9007199254740991),
 started_at INTEGER CHECK(started_at IS NULL OR typeof(started_at)='integer' AND started_at BETWEEN 0 AND 9007199254740991),
 finished_at INTEGER CHECK(finished_at IS NULL OR typeof(finished_at)='integer' AND finished_at BETWEEN 0 AND 9007199254740991),
 CHECK(hold_microusd=0 OR charge_microusd=0),
 CHECK(status<>'queued' OR charge_microusd=0),
 CHECK(status='queued' OR hold_microusd=0),
 PRIMARY KEY(scope_key,comparison_id,position),
 FOREIGN KEY(scope_key,comparison_id) REFERENCES prompt_comparisons(scope_key,id) ON DELETE RESTRICT
);
CREATE INDEX prompt_comparison_attempts_provider ON prompt_comparison_attempts(provider);
CREATE INDEX prompt_comparison_attempts_status ON prompt_comparison_attempts(status,deadline_at);
CREATE TRIGGER prompt_comparisons_immutable BEFORE UPDATE ON prompt_comparisons
 WHEN NOT(NEW.scope_key=OLD.scope_key AND NEW.id=OLD.id AND NEW.operation_key=OLD.operation_key AND NEW.request_digest=OLD.request_digest
 AND NEW.prompt_generation=OLD.prompt_generation AND NEW.evidence_generation=OLD.evidence_generation AND NEW.comparison_generation=OLD.comparison_generation
 AND NEW.target_count=OLD.target_count AND NEW.created_at=OLD.created_at AND OLD.tombstone=0 AND NEW.tombstone=1 AND NEW.frozen_request IS NULL AND NEW.prompt_id IS NULL)
 BEGIN SELECT RAISE(ABORT,'immutable comparison request'); END;
CREATE TRIGGER prompt_comparisons_no_delete BEFORE DELETE ON prompt_comparisons BEGIN SELECT RAISE(ABORT,'comparison receipt retained'); END;
CREATE TRIGGER prompt_comparison_attempts_no_delete BEFORE DELETE ON prompt_comparison_attempts BEGIN SELECT RAISE(ABORT,'comparison charge retained'); END;
CREATE TRIGGER prompt_comparison_attempt_identity BEFORE UPDATE ON prompt_comparison_attempts
 WHEN NEW.scope_key<>OLD.scope_key OR NEW.comparison_id<>OLD.comparison_id OR NEW.position<>OLD.position OR NEW.provider<>OLD.provider OR NEW.model<>OLD.model OR NEW.reserve_microusd<>OLD.reserve_microusd OR NEW.deadline_at<>OLD.deadline_at OR NEW.budget_breach<OLD.budget_breach
 BEGIN SELECT RAISE(ABORT,'immutable comparison attempt'); END;
-- Final accounting cannot be rewritten by deletion, cancellation, or later provider callbacks.
CREATE TRIGGER prompt_comparison_terminal_accounting BEFORE UPDATE ON prompt_comparison_attempts
 WHEN OLD.status NOT IN('queued','running') AND (NEW.status<>OLD.status OR NEW.hold_microusd<>OLD.hold_microusd OR NEW.charge_microusd<>OLD.charge_microusd OR NEW.accounting_state<>OLD.accounting_state OR NEW.observed_estimate_usd IS NOT OLD.observed_estimate_usd OR NEW.budget_breach<>OLD.budget_breach OR NEW.started_at IS NOT OLD.started_at OR NEW.finished_at IS NOT OLD.finished_at)
 BEGIN SELECT RAISE(ABORT,'terminal comparison accounting'); END;
CREATE TRIGGER prompt_comparison_terminal_content BEFORE UPDATE ON prompt_comparison_attempts
 WHEN OLD.status NOT IN('queued','running') AND (NEW.reason IS NOT OLD.reason OR (NEW.payload IS NOT OLD.payload AND NOT(NEW.payload IS NULL AND EXISTS(SELECT 1 FROM prompt_comparisons WHERE scope_key=OLD.scope_key AND id=OLD.comparison_id AND tombstone=1))))
 BEGIN SELECT RAISE(ABORT,'terminal comparison content'); END;
CREATE TRIGGER prompt_comparison_no_requeue BEFORE UPDATE ON prompt_comparison_attempts WHEN OLD.status='running' AND NEW.status='queued'
 BEGIN SELECT RAISE(ABORT,'comparison attempt already started'); END;
-- All privacy paths share the immutable operation transition; no request callback or raw DB API.
CREATE TRIGGER prompt_comparison_privacy AFTER UPDATE OF tombstone ON prompt_comparisons WHEN OLD.tombstone=0 AND NEW.tombstone=1
 BEGIN
 UPDATE prompt_comparison_attempts SET payload=NULL,reason=CASE WHEN status IN('queued','running') THEN 'privacy_removed' ELSE reason END,
 status=CASE WHEN status IN('queued','running') THEN 'authority_lost' ELSE status END,
 hold_microusd=CASE WHEN status='queued' THEN 0 ELSE hold_microusd END,
 finished_at=CASE WHEN status IN('queued','running') THEN max(NEW.created_at,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) ELSE finished_at END
 WHERE scope_key=NEW.scope_key AND comparison_id=NEW.id;
 END;
CREATE TRIGGER prompt_comparison_prompt_deleted AFTER UPDATE OF deleted ON prompt_heads WHEN OLD.deleted=0 AND NEW.deleted=1
 BEGIN UPDATE prompt_comparisons SET tombstone=1,frozen_request=NULL,prompt_id=NULL WHERE scope_key=NEW.scope_key AND prompt_id=NEW.id AND tombstone=0; END;
CREATE TRIGGER prompt_comparison_prompt_cleared AFTER DELETE ON prompt_heads
 BEGIN UPDATE prompt_comparisons SET tombstone=1,frozen_request=NULL,prompt_id=NULL WHERE scope_key=OLD.scope_key AND prompt_id=OLD.id AND tombstone=0; END;
CREATE TRIGGER prompt_comparison_scope_deleted BEFORE DELETE ON evaluation_evidence_scopes
 BEGIN UPDATE prompt_comparisons SET tombstone=1,frozen_request=NULL,prompt_id=NULL WHERE scope_key=OLD.scope_key AND tombstone=0; END;
`;
