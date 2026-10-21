import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer as createEndpoint, type ServerResponse } from "node:http";
import { Database } from "bun:sqlite";
import { createServer } from "../../src/server";
import { closeDb, getDrizzleDb } from "../../src/db";
import { setReplayTrace } from "../../src/replay-map";
import { loadSnapshot } from "../../src/evaluations/loader";
import { freezeExecution, parseExecutionDraft } from "../../src/evaluations/executor";
import { registeredExecutionDispatcher } from "../../src/evaluations/execution-endpoint";
import { EXECUTION_STORAGE_SQL, ExecutionStore } from "../../src/evaluations/execution-store";
import type { DatasetCase } from "../../src/evaluations/protocol";

const scenario = Bun.argv[2], literal = "$& ${literal} <img src=x>";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const daemon = await createServer(0); daemon.server.listen(0, "127.0.0.1"); await once(daemon.server, "listening");
const base = `http://127.0.0.1:${daemon.port}`, db = getDrizzleDb().$client;
const traceId = (index: number) => index.toString(16).padStart(32, "0");
let held: ServerResponse | null = null, observed!: () => void;
const received = new Promise<void>(resolve => { observed = resolve; });
const requests: Array<{ replayRunId: string; executionId: string; caseId: string; userMessage: string }> = [];
async function ingest(index: number, event: string | null, input = literal, output = "ok", mode = "complete") {
  const started = mode === "stale" ? 1 : Date.now(), ended = mode === "future" ? Date.now() + 60_000 : Date.now();
  const attrs = { "ai.operationId": "ai.generateText.doGenerate", "ai.model.id": "controlled-local-fixture",
    "ai.prompt.messages": JSON.stringify([{ role: "user", content: input }]), "ai.response.text": output,
    ...(event ? { "runphantom.event.id": event, "runphantom.replay.run_id": event } : {}),
    ...(mode === "stream-open" ? { "gen_ai.is_streaming": "true" } : {}) };
  const span = { traceId: traceId(index), spanId: index.toString(16).padStart(16, "0"), name: "Controlled native grading",
    startTimeUnixNano: String(BigInt(started) * 1_000_000n), ...(mode === "partial" ? {} : { endTimeUnixNano: String(BigInt(ended) * 1_000_000n) }),
    status: { code: 1 }, attributes: Object.entries(attrs).map(([key, value]) => ({ key, value: { stringValue: value } })) };
  const response = await fetch(base + "/v1/traces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] }) });
  assert.equal(response.status, 200);
}
const endpoint = createEndpoint((incoming, response) => { void (async () => {
  let text = ""; for await (const chunk of incoming) text += chunk.toString();
  const body = JSON.parse(text); requests.push(body); assert.equal(body.userMessage, literal); assert.equal(body.messages[0].content, literal);
  const content = db.query("SELECT data FROM dataset_execution_content WHERE execution_id=?").get(body.executionId) as { data: string };
  assert.equal(JSON.parse(content.data).cases.some((item: { grading: { status: string } }) => item.grading.status === "pass"), false, "No partial roster publishes a captured PASS");
  if (scenario !== "population") { held = response; observed(); return; }
  const index = Number(body.caseId.split("-")[0]);
  if (body.caseId.endsWith("reused")) setReplayTrace(body.replayRunId, traceId(99));
  else if (!body.caseId.endsWith("missing")) {
    await ingest(body.caseId.endsWith("shared") ? 13 : index, body.replayRunId, body.caseId.endsWith("mismatch") ? "Different literal" : literal,
      body.caseId.endsWith("fail") ? "no" : body.caseId.endsWith("oversize") ? "x".repeat(65_537) : "ok",
      body.caseId.endsWith("partial") ? "partial" : body.caseId.endsWith("stale") ? "stale" : body.caseId.endsWith("future") ? "future" : body.caseId.endsWith("stream-open") ? "stream-open" : "complete");
    if (body.caseId.endsWith("duplicate")) await ingest(index + 100, body.replayRunId);
    if (body.caseId.endsWith("fallback")) for (let i = 0; i < 1001; i++) setReplayTrace(`bounded-eviction-${i}`, `metadata-${i}`);
  }
  response.setHeader("content-type", "application/json"); response.end('{"status":"completed","runId":"forged-body-run","actualCostUsd":0}');
})().catch(error => { response.statusCode = 500; response.end(String(error)); }); });
endpoint.listen(0, "127.0.0.1"); await once(endpoint, "listening");
try {
  await ingest(99, null, "Original source input", "Original exact output <img src=x>");
  const original = await (await fetch(base + `/api/runs/${traceId(99)}/export`)).text();
  const originalSql = JSON.stringify(db.query("SELECT * FROM spans WHERE run_id=? ORDER BY id").all(traceId(99)));
  const originalRunSql = JSON.stringify(db.query("SELECT * FROM runs WHERE id=?").get(traceId(99)));
  assert.equal(loadSnapshot(traceId(99)).output.value, "Original exact output <img src=x>");
  console.log(JSON.stringify({ baseline: "actual OTLP/SQLite and original export acquired before coordinator import", scenario }));
  const { coordinateExecution } = await import("../../src/evaluations/execution-coordinator");
  const state = path.join(os.homedir(), ".runphantom"); fs.mkdirSync(state, { mode: 0o700, recursive: true });
  fs.writeFileSync(path.join(state, "agents.json"), JSON.stringify({ native: { url: `http://127.0.0.1:${(endpoint.address() as { port: number }).port}/replay` } }), { mode: 0o600 });
  fs.writeFileSync(path.join(state, "dataset-execution-policy.json"), JSON.stringify({ version: 1, enabled: true, endpoints: [{ endpointName: "native", revision: "1", enabled: true, costAccount: "free-fixture", costMode: "free_local", maximumAttemptMicrousd: 0, maximumTotalMicrousd: 0, maximumOutputTokens: 256, maximumIterations: 1 }] }), { mode: 0o600 });
  const names = scenario === "population" ? ["1-pass", "2-fail", "3-missing", "4-partial", "5-mismatch", "6-duplicate", "7-reused", "8-oversize", "9-stale", "10-future", "11-stream-open", "12-rubric", "13-shared", "14-shared", "15-preexisting", "16-fallback"] : ["1-pass", "2-missing"];
  const cases: DatasetCase[] = names.map(id => ({ id, name: id, input: literal, sourceRunId: id.endsWith("reused") ? traceId(99) : null,
    sourceSpanId: null, sourceOutput: null, tags: [], rules: id.endsWith("rubric") ? [{ kind: "rubric", provider: "openai", model: "unavailable-model", rubric: "Correct answer", threshold: 1 }] : [{ kind: "output", operation: "equals", value: "ok" }], sourceCapturedAt: null, sourceRedacted: false, sourceTruncated: false, sourceSnapshotVersion: null }));
  const frozen = freezeExecution({ datasetId: "fixture", datasetName: "Native fixture only", version: 1, hash: "a".repeat(64), createdAt: 1, cases }, parseExecutionDraft({ datasetId: "fixture", version: 1, datasetHash: "a".repeat(64), endpointName: "native", operationKey: scenario, allowSideEffects: true, timeoutMs: 5000, maxAttempts: scenario === "population" ? 1 : 2 }));
  const native = registeredExecutionDispatcher("native", frozen.id);
  db.exec(EXECUTION_STORAGE_SQL);
  let current = true;
  // Isolated authority control, not a qualified production kernel owner or migration.
  const authority = { assertCurrent() { if (!current) throw new Error("Fixture owner revoked"); } }, store = new ExecutionStore(db, authority);
  const foreignDb = new Database(path.join(os.homedir(), "foreign.db")); foreignDb.exec(EXECUTION_STORAGE_SQL);
  const foreign = new ExecutionStore(foreignDb, authority);
  const policy = { costAccount: native.policy.costAccount, policyDigest: native.policyDigest, maximumAttemptMicrousd: 0, maximumTotalMicrousd: 0 };
  const foreignReceipt = foreign.admit(frozen, policy);
  await assert.rejects(coordinateExecution(frozen.id, foreignReceipt.token, foreign, authority), /database does not match/);
  assert.equal(requests.length, 0); foreignDb.close();
  if (scenario === "population") await ingest(30, frozen.cases.find(item => item.case.id === "15-preexisting")!.attempts[0].id);
  const admitted = store.admit(frozen, { costAccount: native.policy.costAccount, policyDigest: native.policyDigest, maximumAttemptMicrousd: 0, maximumTotalMicrousd: 0 });
  const controller = new AbortController();
  const running = coordinateExecution(frozen.id, admitted.token, store, authority, { signal: controller.signal });
  if (scenario !== "population") {
    await received;
    if (scenario === "stale-owner") current = false; else { store.cancel(frozen.id); controller.abort(); }
    await ingest(1, requests[0].replayRunId);
    held!.end('{"status":"completed"}');
  }
  let result;
  if (scenario === "stale-owner") { await assert.rejects(running, /owner revoked/); current = true; result = store.get(frozen.id); assert.equal(result.status, "running"); }
  else result = await running;
  assert.equal(result.cases.length, cases.length);
  assert.equal(result.cases.reduce((count, item) => count + item.attempts.length, 0), cases.length * frozen.request.maxAttempts);
  if (scenario === "population") {
    assert.equal(result.cases[0].attempts[0].status, "transport_success"); assert.equal(result.cases[0].grading.status, "pass");
    assert.equal(result.cases[1].grading.status, "fail");
    for (const item of result.cases.slice(2, -1)) { assert.equal(item.grading.status, "inconclusive", item.case.id); assert.equal(item.grading.checks.length, 1, item.case.id); }
    assert.equal(result.cases.at(-1)!.grading.status, "pass", "Unique persisted event survives bounded replay-map eviction");
    assert.equal(result.cases[0].grading.runId, traceId(1));
    const before = JSON.stringify(store.get(frozen.id));
    await ingest(1, result.cases[0].attempts[0].id, literal, "Different later captured output");
    assert.equal(loadSnapshot(traceId(1)).output.value, "Different later captured output");
    await coordinateExecution(frozen.id, admitted.token, store, authority); assert.equal(JSON.stringify(store.get(frozen.id)), before); assert.equal(requests.length, cases.length);
  } else { assert.equal(result.cases[0].grading.status, "inconclusive"); assert.equal(result.cases[1].attempts[0].sideEffects, "not_dispatched"); assert.equal(requests.length, 1); }
  assert.equal(JSON.stringify(result).includes("forged-body-run"), false);
  assert.equal(await (await fetch(base + `/api/runs/${traceId(99)}/export`)).text(), original);
  assert.equal(JSON.stringify(db.query("SELECT * FROM spans WHERE run_id=? ORDER BY id").all(traceId(99))), originalSql);
  assert.equal(JSON.stringify(db.query("SELECT * FROM runs WHERE id=?").get(traceId(99))), originalRunSql);
  const physical = fs.statSync(process.env.RUNPHANTOM_DB_PATH!);
  const accounting = db.query("SELECT attempt_id,status,hold_microusd,charged_or_uncertain_microusd FROM dataset_execution_attempts WHERE execution_id=? ORDER BY case_id,position").all(frozen.id);
  assert.equal(accounting.length, cases.length * frozen.request.maxAttempts);
  console.log(JSON.stringify({ scenario, sourceNativePid: process.pid, providerCalls: 0, nativeDb: { dev: physical.dev, ino: physical.ino, samePrivateConnection: true, foreignSameExecutionRefused: true }, capturedGrades: result.cases.map(item => [item.case.id, item.grading.status]), accounting, requests: requests.map(body => ({ eventUUID: body.replayRunId, executionId: body.executionId, caseId: body.caseId })), originalExportAndSqlUnchanged: true, originalHashes: { export: sha(original), spansSql: sha(originalSql), runSql: sha(originalRunSql) }, authority: "isolated fixture, kernel owner qualification pending" }));
} finally {
  endpoint.closeAllConnections(); daemon.server.closeAllConnections();
  await Promise.all([new Promise<void>(resolve => endpoint.close(() => resolve())), new Promise<void>(resolve => daemon.server.close(() => resolve()))]);
  if (process.env.F46_NATIVE_EVIDENCE_PATH) {
    const checkpoint = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
    assert.equal(checkpoint.busy, 0, "Private recorded database must include its committed WAL contents");
  }
  closeDb();
  if (process.env.F46_NATIVE_EVIDENCE_PATH) fs.copyFileSync(process.env.RUNPHANTOM_DB_PATH!, path.join(process.env.F46_NATIVE_EVIDENCE_PATH, `${scenario}.db`));
}
