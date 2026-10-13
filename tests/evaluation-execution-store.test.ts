import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionStore, EXECUTION_STORAGE_SQL } from "../src/evaluations/execution-store";
import { freezeExecution, parseExecutionDraft } from "../src/evaluations/executor";
import type { DatasetRevision } from "../src/evaluations/protocol";
import type { DatasetExecution } from "../src/evaluations/execution-protocol";
import { canonicalCaseDefinitions } from "../src/evaluations/validation";
const databases: Database[] = [], directories: string[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const directory of directories.splice(0)) rmSync(directory,{recursive:true,force:true}); });
function fixture(filename = ":memory:") {
  const db = new Database(filename); databases.push(db); db.exec("PRAGMA foreign_keys=ON"); db.exec(EXECUTION_STORAGE_SQL);
  let live = true;
  const store = new ExecutionStore(db, { assertCurrent: () => { if (!live) throw new Error("Owner lost"); } });
  return { db, store, lose: () => { live = false; } };
}
const source = (): DatasetRevision => ({ datasetId: "dataset", datasetName: "Dataset", version: 1, hash: "a".repeat(64), createdAt: 1,
  cases: [{ id: "case", name: "Case", input: "literal ${value}", sourceRunId: null, sourceSpanId: null, sourceOutput: null, tags: [],
    rules: [{ kind: "output", operation: "equals", value: "ok" }], sourceCapturedAt: null, sourceRedacted: false, sourceTruncated: false, sourceSnapshotVersion: null }] });
const frozen = (key = "operation") => freezeExecution(source(), parseExecutionDraft({ datasetId: "dataset", version: 1, datasetHash: "a".repeat(64), endpointName: "native", operationKey: key,
  allowSideEffects: true, maxCostPerAttemptUsd: 1, maxTotalCostUsd: 1 }));
const policy = { costAccount: "native-account", policyDigest: "b".repeat(64), maximumAttemptMicrousd: 1_000_000, maximumTotalMicrousd: 30_000_000 };

test("SQLite retains immutable owner-local receipt/cost identity and whole case attempts after clear", () => {
  const { db, store } = fixture(), execution = frozen();
  const receipt = store.admit(execution, policy); expect(receipt.reused).toBe(false);
  expect(store.admit(frozen(), policy).execution.id).toBe(execution.id);
  const attempt = execution.cases[0].attempts[0]; store.begin(execution.id, attempt.id, receipt.token);
  expect(db.query("SELECT cost_account FROM dataset_execution_receipts").get()).toEqual({ cost_account: "native-account" });
  store.clear();
  expect(db.query("SELECT charged_or_uncertain_microusd FROM dataset_execution_attempts").get()).toEqual({ charged_or_uncertain_microusd: 1_000_000 });
  expect(db.query("SELECT count(*) n FROM dataset_execution_content").get()).toEqual({ n: 0 });
  expect(() => store.admit(frozen(), policy)).toThrow();
  expect(() => db.exec("DELETE FROM dataset_execution_receipts")).toThrow();
  expect(() => db.exec("UPDATE dataset_execution_receipts SET cost_account='new-account'")).toThrow();
  expect(() => db.exec("UPDATE dataset_execution_attempts SET charged_or_uncertain_microusd=0")).toThrow();
});
test("different operation bytes conflict and cost-account ceiling survives content removal", () => {
  const { store } = fixture(), execution = frozen(), receipt = store.admit(execution, policy);
  const changed = frozen(); changed.request.concurrency = 2; changed.requestDigest = "c".repeat(64);
  expect(() => store.admit(changed, policy)).toThrow();
  store.begin(execution.id, execution.cases[0].attempts[0].id, receipt.token); store.clear();
  expect(() => store.admit(frozen("other"), { ...policy, maximumTotalMicrousd: 1_000_000 })).toThrow();
});
test("owner authority loss forbids recovery/admission and stale completion cannot revive cancelled record", () => {
  const { store, lose } = fixture(), execution = frozen(), receipt = store.admit(execution, policy);
  store.cancel(execution.id);
  execution.status = "completed"; expect(store.publish(execution, receipt.token)).toBe(false);
  lose(); expect(() => store.recover()).toThrow(); expect(() => store.admit(frozen("later"), policy)).toThrow();
});

test("queued publication cannot refund reservations and recovery retains dispatched uncertainty", () => {
  const { db, store } = fixture(), execution = frozen(), receipt = store.admit(execution, policy);
  execution.status = "running"; expect(store.publish(execution, receipt.token)).toBe(true);
  expect(db.query("SELECT hold_microusd FROM dataset_execution_attempts").get()).toEqual({ hold_microusd: 1_000_000 });
  expect(store.begin(execution.id, execution.cases[0].attempts[0].id, receipt.token)).toBe(true);
  store.recover();
  expect(store.get(execution.id).cases[0].attempts[0]).toMatchObject({ status: "interrupted", sideEffects: "may_have_occurred" });
  expect(db.query("SELECT hold_microusd,charged_or_uncertain_microusd FROM dataset_execution_attempts").get()).toEqual({ hold_microusd: 0, charged_or_uncertain_microusd: 1_000_000 });
  expect(store.publish(execution, receipt.token)).toBe(false);
});

test("policy revision cannot remap an endpoint to a fresh account or rewrite terminal accounting", () => {
  const { db, store } = fixture(), execution = frozen(), receipt = store.admit(execution, policy);
  store.begin(execution.id, execution.cases[0].attempts[0].id, receipt.token); store.cancel(execution.id); store.clear();
  expect(() => store.admit(frozen("revised-policy"), { ...policy, costAccount: "new-account", policyDigest: "d".repeat(64) })).toThrow();
  expect(() => db.exec("UPDATE dataset_execution_attempts SET charged_or_uncertain_microusd=1000001")).toThrow();
  expect(() => db.exec("UPDATE dataset_execution_attempts SET status='running'")).toThrow();
  expect(() => db.exec("UPDATE dataset_execution_receipts SET status='queued'")).toThrow();
});

const RETAINED_CAP = 32 * 1024 * 1024;
const retainedBytes = (db: Database) => (db.query("SELECT coalesce(sum(length(cast(data AS BLOB))),0) bytes FROM dataset_execution_content").get() as { bytes: number }).bytes;
const accounting = (db: Database, id: string) => db.query("SELECT attempt_id,case_id,position,status,hold_microusd,charged_or_uncertain_microusd FROM dataset_execution_attempts WHERE execution_id=? ORDER BY position").all(id);
const frozenIdentity = (value: DatasetExecution) => JSON.stringify([value.request,value.requestDigest,value.dataset,value.cases.map(item => [item.case,item.attempts.map(attempt => [attempt.id,attempt.index])])]);
function retainedFrozen(key: string, caseCount = 1) {
  const revision = source();
  if (caseCount > 1) revision.cases = Array.from({length:caseCount},(_,index) => ({...structuredClone(revision.cases[0]),id:`case-${index}`}));
  revision.hash = createHash("sha256").update(canonicalCaseDefinitions(revision.cases)).digest("hex");
  return freezeExecution(revision,parseExecutionDraft({datasetId:revision.datasetId,version:revision.version,datasetHash:revision.hash,endpointName:"native",operationKey:key,
    allowSideEffects:true,maxCostPerAttemptUsd:1,maxTotalCostUsd:caseCount}));
}

/** Native compatibility fixture: old valid frozen rows predate active-record growth reservations. */
function legacyAtCap(started = false, remaining = 1, filename = ":memory:", completedCase = false, minimalMetadata = false) {
  const fixtureValue = fixture(filename), { db, store } = fixtureValue;
  const background: DatasetExecution[] = [];
  for (let index = 0; index < 9; index++) {
    const value = retainedFrozen(`retained-${index}`); store.admit(value, policy); background.push(store.cancel(value.id));
  }
  const execution = retainedFrozen("near-cap",completedCase ? 2 : 1), admission = store.admit(execution, policy);
  if (started) expect(store.begin(execution.id, execution.cases[0].attempts[0].id, admission.token)).toBe(true);
  if (completedCase) {
    const completed = store.get(execution.id);
    completed.cases[0].attempts[0].status = "failed"; completed.cases[0].attempts[0].completedAt = Date.now();
    completed.cases[0].attempts[0].reason = "Retained terminal attempt has no captured completion";
    completed.cases[0].grading.reason = "Retained terminal attempt has no captured grading";
    expect(store.publish(completed,admission.token)).toBe(true);
    expect(store.begin(execution.id,execution.cases[1].attempts[0].id,admission.token)).toBe(true);
  }
  if (minimalMetadata) {
    const minimal = store.get(execution.id); minimal.cases[0].attempts[0].reason = ""; minimal.cases[0].grading.reason = "";
    expect(store.publish(minimal,admission.token)).toBe(true);
  }
  // Stage only mutable old retained metadata, with matching canonical digests. Frozen source and SQL accounting are unchanged.
  let padding = RETAINED_CAP - remaining - retainedBytes(db);
  for (const value of background) {
    const original = JSON.stringify(value), extra = Math.min(padding, 4 * 1024 * 1024 - Buffer.byteLength(original));
    value.cases[0].grading.reason += "x".repeat(extra);
    const data = JSON.stringify(value);
    db.query("UPDATE dataset_execution_content SET data=?,digest=? WHERE execution_id=?").run(data,createHash("sha256").update(data).digest("hex"),value.id);
    padding -= extra;
  }
  expect(padding).toBe(0); expect(retainedBytes(db)).toBe(RETAINED_CAP - remaining);
  for (const value of [...background,execution]) {
    expect(frozenIdentity(store.get(value.id))).toBe(frozenIdentity(value));
    expect(value.dataset.hash).toBe(createHash("sha256").update(canonicalCaseDefinitions(value.cases.map(item => item.case))).digest("hex"));
  }
  return { ...fixtureValue, execution: store.get(execution.id), token: admission.token };
}

test("native admission reserves future dispatch and terminal metadata before accepting the last retained bytes", () => {
  const candidate = retainedFrozen("capacity-refusal");
  const { db, store } = legacyAtCap(false,Buffer.byteLength(JSON.stringify(candidate))+1);
  const before = retainedBytes(db), receipts = db.query("SELECT count(*) n FROM dataset_execution_receipts").get();
  // An existing active record already consumes the remaining lifecycle capacity.
  expect(() => store.admit(candidate, policy)).toThrow("retention");
  expect(retainedBytes(db)).toBe(before); expect(db.query("SELECT count(*) n FROM dataset_execution_receipts").get()).toEqual(receipts);
});

test("native begin refuses before dispatch charge when an old record cannot retain terminal metadata", () => {
  const { db, store, execution, token } = legacyAtCap();
  const before = accounting(db, execution.id), identity = frozenIdentity(execution);
  expect(() => store.begin(execution.id, execution.cases[0].attempts[0].id, token)).toThrow("retention");
  expect(retainedBytes(db)).toBe(RETAINED_CAP - 1); expect(accounting(db, execution.id)).toEqual(before);
  expect(frozenIdentity(store.get(execution.id))).toBe(identity);
  expect(store.get(execution.id).cases[0].attempts[0].sideEffects).toBe("not_dispatched");
});

test("native publication refuses aggregate growth atomically and cancellation keeps previously dispatched charge after disk reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(),"runphantom-execution-retention-")); directories.push(directory);
  const filename = join(directory,"owned.db"), { db, store, execution, token } = legacyAtCap(true,1,filename);
  let calls = 0;
  const endpoint = Bun.serve({hostname:"127.0.0.1",port:0,fetch(){calls++;return new Response("actual local endpoint completion");}});
  try { expect(await (await fetch(`http://127.0.0.1:${endpoint.port}/`)).text()).toBe("actual local endpoint completion"); }
  finally { await endpoint.stop(true); }
  expect(calls).toBe(1);
  const before = accounting(db, execution.id), identity = frozenIdentity(execution), changed = structuredClone(execution);
  changed.cases[0].attempts[0].reason = "Completed transport with an additional retained observation";
  changed.cases[0].attempts[0].status = "transport_success";
  expect(() => store.publish(changed, token)).toThrow("retention");
  expect(retainedBytes(db)).toBe(RETAINED_CAP - 1); expect(accounting(db, execution.id)).toEqual(before);
  const cancelled = store.cancel(execution.id);
  expect(cancelled.status).toBe("cancelled"); expect(retainedBytes(db)).toBeLessThanOrEqual(RETAINED_CAP);
  expect(frozenIdentity(cancelled)).toBe(identity);
  expect(cancelled.cases[0].attempts[0]).toMatchObject({ status:"cancelled", sideEffects:"may_have_occurred" });
  expect(accounting(db,execution.id)).toMatchObject([{ status:"cancelled",hold_microusd:0,charged_or_uncertain_microusd:1_000_000 }]);
  databases.splice(databases.indexOf(db),1); db.close();
  const reopenedDb = new Database(filename); databases.push(reopenedDb); reopenedDb.exec("PRAGMA foreign_keys=ON");
  const reopened = new ExecutionStore(reopenedDb,{assertCurrent(){}});
  expect(reopened.get(execution.id)).toEqual(cancelled); expect(reopened.publish(changed,token)).toBe(false);
  expect(accounting(reopenedDb,execution.id)).toMatchObject([{status:"cancelled",hold_microusd:0,charged_or_uncertain_microusd:1_000_000}]);
  expect(reopenedDb.query("PRAGMA integrity_check").all()).toEqual([{integrity_check:"ok"}]);
  expect(reopenedDb.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("native cancellation and recovery compact only pending metadata at legitimate retained exhaustion", () => {
  for (const recover of [false,true]) {
    const { db, store, execution } = legacyAtCap(true), identity = frozenIdentity(execution);
    if (recover) store.recover(); else store.cancel(execution.id);
    const stopped = store.get(execution.id), status = recover ? "interrupted" : "cancelled";
    expect(stopped.status).toBe(status); expect(retainedBytes(db)).toBeLessThanOrEqual(RETAINED_CAP);
    expect(frozenIdentity(stopped)).toBe(identity);
    expect(stopped.cases[0].attempts[0]).toMatchObject({status,sideEffects:"may_have_occurred",completedAt:null});
    expect(stopped.cases[0].attempts[0].reason).toContain("retention");
    expect(stopped.cases[0].grading).toMatchObject({status:"inconclusive",checks:[]});
    expect(stopped.cases[0].grading.reason).toMatch(/retention/i);
    expect(accounting(db,execution.id)).toMatchObject([{status,hold_microusd:0,charged_or_uncertain_microusd:1_000_000}]);
    store.clear(); expect(retainedBytes(db)).toBe(0);
    expect(db.query("SELECT count(*) n FROM dataset_execution_receipts").get()).toEqual({n:10});
    expect(db.query("SELECT count(*) n FROM dataset_execution_attempts").get()).toEqual({n:10});
    expect(accounting(db,execution.id)).toMatchObject([{charged_or_uncertain_microusd:1_000_000}]);
  }
});

test("native privacy clear at exhaustion removes content without persisting temporary growth or refunding dispatch", () => {
  const {db,store,execution,token} = legacyAtCap(true);
  store.clear();
  expect(retainedBytes(db)).toBe(0);
  expect(accounting(db,execution.id)).toMatchObject([{status:"cancelled",hold_microusd:0,charged_or_uncertain_microusd:1_000_000}]);
  expect(db.query("SELECT count(*) n FROM dataset_execution_receipts WHERE status='deleted'").get()).toEqual({n:10});
  expect(db.query("SELECT count(*) n FROM dataset_execution_attempts").get()).toEqual({n:10});
  expect(() => store.get(execution.id)).toThrow("removed");
  expect(store.publish(execution,token)).toBe(false);
});

test("native reserved lifecycle keeps full terminal observations where they fit and rejects the per-record boundary before mutation", () => {
  const {db,store,execution,token} = legacyAtCap(true,16*1024), identity = frozenIdentity(execution), before = accounting(db,execution.id);
  const oversized = structuredClone(execution); oversized.cases[0].grading.reason = "x".repeat(4*1024*1024);
  expect(() => store.publish(oversized,token)).toThrow("retained bound");
  expect(accounting(db,execution.id)).toEqual(before); expect(frozenIdentity(store.get(execution.id))).toBe(identity);
  const observed = structuredClone(execution); observed.cases[0].attempts[0].reason = "Real endpoint remains active";
  expect(store.publish(observed,token)).toBe(true);
  const stopped = store.cancel(execution.id);
  expect(stopped.completedAt).not.toBeNull(); expect(stopped.cases[0].attempts[0].completedAt).not.toBeNull();
  expect(stopped.cases[0].attempts[0].reason).toBe("Cancelled; possible external side effects are retained");
  expect(stopped.cases[0].grading).toEqual(execution.cases[0].grading);
  expect(frozenIdentity(stopped)).toBe(identity); expect(retainedBytes(db)).toBeLessThanOrEqual(RETAINED_CAP);
  expect(accounting(db,execution.id)).toMatchObject([{status:"cancelled",charged_or_uncertain_microusd:1_000_000}]);
});

test("native near-cap stop retains completed cases and their grading while only pending metadata is compacted", () => {
  const {db,store,execution} = legacyAtCap(true,1,":memory:",true), terminalCase = structuredClone(execution.cases[0]);
  store.recover(); const stopped = store.get(execution.id);
  expect(stopped.cases[0]).toEqual(terminalCase);
  expect(stopped.cases[1].attempts[0]).toMatchObject({status:"interrupted",sideEffects:"may_have_occurred",completedAt:null});
  expect(stopped.cases[1].grading.reason).toContain("retention");
  expect(frozenIdentity(stopped)).toBe(frozenIdentity(execution)); expect(retainedBytes(db)).toBeLessThanOrEqual(RETAINED_CAP);
  expect(db.query("SELECT sum(charged_or_uncertain_microusd) charged FROM dataset_execution_attempts WHERE execution_id=?").get(execution.id)).toEqual({charged:2_000_000});
});

test("native legacy minimum shape refuses unrepresentable stop metadata atomically and explicit clear retains its charge", () => {
  const {db,store,execution} = legacyAtCap(true,1,":memory:",false,true), before = accounting(db,execution.id);
  // No frozen field may be dropped to make space for truthful stop/omission metadata in this old unreserved shape.
  expect(() => store.cancel(execution.id)).toThrow("cannot represent");
  expect(() => store.recover()).toThrow("cannot represent");
  expect(store.get(execution.id)).toEqual(execution); expect(accounting(db,execution.id)).toEqual(before);
  expect(retainedBytes(db)).toBe(RETAINED_CAP-1);
  store.clear(); expect(retainedBytes(db)).toBe(0);
  expect(accounting(db,execution.id)).toMatchObject([{status:"cancelled",hold_microusd:0,charged_or_uncertain_microusd:1_000_000}]);
});
