import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ExecutionStore, EXECUTION_STORAGE_SQL } from "../src/evaluations/execution-store";
import { freezeExecution, parseExecutionDraft } from "../src/evaluations/executor";
import type { DatasetRevision } from "../src/evaluations/protocol";
const databases: Database[] = []; afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = new Database(":memory:"); databases.push(db); db.exec("PRAGMA foreign_keys=ON"); db.exec(EXECUTION_STORAGE_SQL);
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
