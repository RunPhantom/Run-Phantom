import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import express from "express";
import { clearAll, closeDb, getDrizzleDb, deleteRun } from "../src/db";
import { createLocalOriginGuard } from "../src/local-origin-guard";
import { createReviewQueueRouter } from "../src/review-queues/router";
import * as queueStore from "../src/review-queues/store";
import * as datasets from "../src/evaluations/store";
import { REVIEW_QUEUE_FIXTURE_DDL } from "./review-queue-fixture-ddl";
import { REVIEW_LIMITS } from "../src/review-queues/protocol";
import { canonicalReviewJson, reviewHash, reviewItemId } from "../src/review-queues/validation";
import type { ReviewItem, ReviewQueue, PromotionReceipt } from "../src/review-queues/protocol";

let directory: string, oldDb: string | undefined, server: http.Server, base: string;
beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "rq-component-unactivated-")); oldDb = process.env.RUNPHANTOM_DB_PATH;
  closeDb(); process.env.RUNPHANTOM_DB_PATH = path.join(directory, "fixture.db");
  getDrizzleDb().$client.exec(REVIEW_QUEUE_FIXTURE_DDL);
  const app = express(); server = http.createServer(app);
  app.use("/api", createLocalOriginGuard({ daemonPort: () => (server.address() as { port: number }).port }));
  app.use((req, res, next) => {
    if (req.headers["x-fixture-delay-ack"] === "1") {
      const json = res.json.bind(res); res.json = body => { setTimeout(() => json(body), 150); return res; };
    }
    next();
  });
  app.use("/api/review-queues", createReviewQueueRouter());
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/review-queues`;
});
beforeEach(() => { getDrizzleDb().$client.exec("DELETE FROM review_queues"); clearAll(); });
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve())); closeDb();
  if (oldDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = oldDb;
  rmSync(directory, { recursive: true, force: true });
});
function source(id = "run-source", output = "Frozen actual output") {
  const db = getDrizzleDb().$client;
  db.query("INSERT INTO runs(id,name,started_at,last_updated_at) VALUES(?,?,1,2)").run(id, "Captured source");
  db.query("INSERT INTO spans(run_id,id,name,span_type,status,input_payload,output_payload,attributes,start_time_ms,end_time_ms) VALUES(?,'root','agent','AGENT_ROOT','OK','Input',?,'{}',1,2)").run(id, output);
}
async function call(url = "", method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(base + url, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}
async function created(output = "Frozen actual output") {
  source("run-source", output); const madeQueue = await call("", "POST", { name: "Local review" });
  expect(madeQueue).toMatchObject({ status: 201, body: { name: "Local review" } });
  const queue = madeQueue.body as ReviewQueue;
  const madeItem = await call(`/${queue.id}/items`, "POST", { runId: "run-source" });
  expect(madeItem).toMatchObject({ status: 201, body: { state: "draft" } });
  const item = madeItem.body as ReviewItem;
  return { queue, item };
}
function draft(item: ReviewItem, expected = "Newest expected target") { return { ...item.draft, target: { expectedOutput: expected } }; }
async function approved(output = "Frozen actual output") {
  const { queue, item } = await created(output);
  const value = await call(`/${queue.id}/items/${item.id}/approve`, "POST", { expectedRevision: item.revision, mutationId: "approve", draft: draft(item) });
  expect(value.status).toBe(200); return { queue, item: value.body as ReviewItem };
}
function promoteBody(item: ReviewItem, datasetId: string, version = 1, key = "promotion-1") {
  return { datasetId, expectedDatasetVersion: version, idempotencyKey: key, items: [{ itemId: item.id, expectedRevision: item.revision }] };
}

describe("unactivated local review real SQLite and HTTP component", () => {
  test("atomic latest-draft approval, real counts, frozen insertion retry and delayed acknowledgment", async () => {
    const { queue, item } = await created();
    const pending = call(`/${queue.id}/items/${item.id}/approve`, "POST", { expectedRevision: item.revision, mutationId: "approve-delayed", draft: draft(item, "Immediate latest edit") }, { "x-fixture-delay-ack": "1" });
    for (let n = 0; n < 100 && queueStore.readReviewItem(queue.id, item.id).state === "draft"; n++) await new Promise(resolve => setTimeout(resolve, 2));
    const stored = queueStore.readReviewItem(queue.id, item.id);
    expect(stored).toMatchObject({ state: "approved", draft: { target: { expectedOutput: "Immediate latest edit" } }, reviewSource: "localOperator" });
    const late = await call(`/${queue.id}/items/${item.id}`, "PUT", { expectedRevision: item.revision, mutationId: "late-save", draft: draft(item, "Old target") });
    expect(late.status).toBe(409); expect((await pending).status).toBe(200);
    getDrizzleDb().$client.query("UPDATE spans SET output_payload='Changed live source' WHERE run_id='run-source'").run();
    const retried = await call(`/${queue.id}/items`, "POST", { runId: "run-source" });
    expect(retried.body).toEqual(stored); expect(queueStore.reviewCounts(queue.id)).toEqual({ total: 1, draft: 0, approved: 1, promoted: 0 });
  });
  test("same-revision concurrent HTTP edits admit one winner and retain the loser conflict", async () => {
    const { queue, item } = await created();
    const results = await Promise.all(["A", "B"].map(value => call(`/${queue.id}/items/${item.id}`, "PUT", { expectedRevision: item.revision, mutationId: value, draft: draft(item, value) })));
    expect(results.map(value => value.status).sort()).toEqual([200, 409]);
    expect(queueStore.readReviewItem(queue.id, item.id).revision).toBe(item.revision + 1);
  });
  test("promotion writes one actual frozen dataset revision; exact retry survives head advance and DB restart", async () => {
    const { queue, item } = await approved(), dataset = datasets.createDataset("Curated dataset");
    const historical = JSON.stringify(datasets.getRevision(dataset.datasetId));
    const body = promoteBody(item, dataset.datasetId), first = await call(`/${queue.id}/promotions`, "POST", body);
    expect(first.status).toBe(201); const receipt = first.body as PromotionReceipt;
    expect(receipt.datasetVersion).toBe(2);
    expect(datasets.getRevision(dataset.datasetId).cases).toMatchObject([{ id: receipt.caseIds[0], sourceOutput: "Frozen actual output", rules: [{ kind: "output", operation: "equals", value: "Newest expected target" }] }]);
    expect(JSON.stringify(datasets.getRevision(dataset.datasetId, 1))).toBe(historical);
    datasets.appendRevision(dataset.datasetId, 2, datasets.getRevision(dataset.datasetId).cases);
    closeDb(); getDrizzleDb();
    const retry = await call(`/${queue.id}/promotions`, "POST", body); expect(retry.status).toBe(201); expect(retry.body).toEqual(receipt);
    expect(datasets.getRevision(dataset.datasetId).version).toBe(3); expect(datasets.getRevision(dataset.datasetId).cases).toHaveLength(1);
    const changed = await call(`/${queue.id}/promotions`, "POST", { ...body, expectedDatasetVersion: 3 }); expect(changed.status).toBe(409);
    expect(queueStore.readReviewItem(queue.id, item.id).state).toBe("promoted");
  });
  test("native receipt-insert SQL fault rolls back dataset, item, counter and receipt together", async () => {
    const { queue, item } = await approved(), dataset = datasets.createDataset("Rollback dataset"), db = getDrizzleDb().$client;
    const counter = db.query("SELECT next_ordinal FROM review_queues WHERE id=?").get(queue.id);
    db.exec("CREATE TRIGGER reject_review_receipt BEFORE INSERT ON review_queue_promotions BEGIN SELECT RAISE(ABORT,'fixture receipt rejection'); END;");
    try {
      const failed = await call(`/${queue.id}/promotions`, "POST", promoteBody(item, dataset.datasetId)); expect(failed.status).toBe(500);
      expect(failed.body.error.message).not.toContain("fixture"); expect(datasets.getRevision(dataset.datasetId).version).toBe(1);
      expect(queueStore.readReviewItem(queue.id, item.id)).toEqual(item);
      expect(db.query("SELECT next_ordinal FROM review_queues WHERE id=?").get(queue.id)).toEqual(counter);
      expect(db.query("SELECT count(*) AS n FROM review_queue_promotions").get()).toEqual({ n: 0 });
    } finally { db.exec("DROP TRIGGER reject_review_receipt"); }
    expect((await call(`/${queue.id}/promotions`, "POST", promoteBody(item, dataset.datasetId))).status).toBe(201);
  });
  test("deleted deterministic membership re-intake cannot bind delayed old saves, approvals or promotion", async () => {
    const { queue, item } = await created(), dataset = datasets.createDataset("Reintake dataset");
    expect((await call(`/${queue.id}/items/${item.id}`, "DELETE", { expectedRevision: item.revision })).status).toBe(204);
    getDrizzleDb().$client.query("UPDATE spans SET output_payload='New incarnation source' WHERE run_id='run-source'").run();
    const fresh = (await call(`/${queue.id}/items`, "POST", { runId: "run-source" })).body as ReviewItem;
    expect(fresh.id).toBe(item.id);
    const bytes = JSON.stringify(fresh);
    expect((await call(`/${queue.id}/items/${item.id}`, "PUT", { expectedRevision: item.revision, mutationId: "old-put", draft: draft(item) })).status).toBe(409);
    expect((await call(`/${queue.id}/items/${item.id}/approve`, "POST", { expectedRevision: item.revision, mutationId: "old-approve", draft: draft(item) })).status).toBe(409);
    expect((await call(`/${queue.id}/promotions`, "POST", promoteBody(item, dataset.datasetId))).status).toBe(409);
    expect(fresh.revision).toBeGreaterThan(item.revision);
    expect(JSON.stringify(queueStore.readReviewItem(queue.id, fresh.id))).toBe(bytes); expect(datasets.getRevision(dataset.datasetId).version).toBe(1);
  });
  test("queue counter survives another item high revision, concurrent intake, restart and overflow refusal", async () => {
    const { queue, item } = await created(); let current = item;
    for (let n = 0; n < 5; n++) current = (await call(`/${queue.id}/items/${item.id}`, "PUT", { expectedRevision: current.revision, mutationId: `edit-${n}`, draft: draft(current) })).body;
    source("run-b"); source("run-c");
    const inserted = await Promise.all(["run-b", "run-c"].map(runId => call(`/${queue.id}/items`, "POST", { runId })));
    expect(inserted.every(result => result.status === 201)).toBe(true);
    expect(inserted[0].body.ordinal).not.toBe(inserted[1].body.ordinal);
    expect(inserted.every(result => result.body.revision > current.revision)).toBe(true);
    closeDb(); getDrizzleDb(); source("run-d");
    const next = await call(`/${queue.id}/items`, "POST", { runId: "run-d" }); expect(next.body.revision).toBeGreaterThan(Math.max(...inserted.map(result => result.body.revision)));
    getDrizzleDb().$client.query("UPDATE review_queues SET next_ordinal=? WHERE id=?").run(Number.MAX_SAFE_INTEGER, queue.id);
    source("run-overflow"); expect((await call(`/${queue.id}/items`, "POST", { runId: "run-overflow" })).status).toBe(409);
    expect(queueStore.reviewCounts(queue.id).total).toBe(4);
  });
  test("10,000 stored items retain stable 50-row keyset pages and a five-source window", async () => {
    const { queue, item } = await created(), db = getDrizzleDb().$client;
    const run = db.query("INSERT INTO runs(id,name,started_at,last_updated_at) VALUES(?,?,1,2)");
    const insert = db.query("INSERT INTO review_queue_items(id,queue_id,ordinal,source_run_id,source_span_key,source_json,source_hash,draft_json,draft_hash,revision,state,created_at,updated_at) VALUES(?,?,?,?,'',?,?,?,?,?,'draft',1,2)");
    db.transaction(() => {
      for (let ordinal = 2; ordinal <= 10000; ordinal++) {
        const runId = `bounded-run-${ordinal}`, frozen = { ...item.source, runId }, id = reviewItemId(queue.id, runId, null);
        run.run(runId, "Bounded fixture");
        insert.run(id, queue.id, ordinal, runId, canonicalReviewJson(frozen), reviewHash({ schemaHash: queue.schemaHash, source: frozen }), canonicalReviewJson(item.draft), item.draftHash, ordinal);
      }
      db.query("UPDATE review_queues SET next_ordinal=10001 WHERE id=?").run(queue.id);
    })();
    const first = await call(`/${queue.id}/items?limit=50`);
    expect(first.status).toBe(200); expect(first.body.items).toHaveLength(50); expect(first.body.counts.total).toBe(10000);
    expect(first.body.items.every((row: object) => !("source" in row) && !("draft" in row))).toBe(true);
    const query = new URLSearchParams({ limit: "50", afterOrdinal: String(first.body.nextCursor.afterOrdinal), afterId: first.body.nextCursor.afterId });
    const second = await call(`/${queue.id}/items?${query}`);
    expect(second.body.items).toHaveLength(50); expect(second.body.items[0].ordinal).toBe(51);
    expect(new Set([...first.body.items, ...second.body.items].map((row: ReviewItem) => row.id)).size).toBe(100);
    const window = await call(`/${queue.id}/window?centerId=${second.body.items[24].id}`);
    expect(window.status).toBe(200); expect(window.body).toHaveLength(5); expect(window.body.map((row: ReviewItem) => row.ordinal)).toEqual([73,74,75,76,77]);
    expect((await call(`/${queue.id}/items?limit=51`)).status).toBe(400);
    source("over-queue-cap"); expect((await call(`/${queue.id}/items`, "POST", { runId: "over-queue-cap" })).status).toBe(409);
    expect(queueStore.reviewCounts(queue.id).total).toBe(10000);
  });
  test("schema/secret/corruption/body/origin errors are explicit and never expose prefixes or raw sources", async () => {
    expect((await call("", "POST", { name: "Queue", schema: null })).status).toBe(400);
    const { queue, item } = await created();
    const duplicate = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"A","na\\u006de":"B"}' }); expect(duplicate.status).toBe(400);
    expect((await call("", "POST", { name: "Forbidden" }, { origin: "https://outside.invalid" })).status).toBe(403);
    expect((await call("", "POST", { name: "x".repeat(65536) })).status).toBe(413);
    const credential = JSON.stringify({ safe: "prefix", api_key: "fixture-private-value" });
    const rejected = await call(`/${queue.id}/items/${item.id}/approve`, "POST", { expectedRevision: item.revision, mutationId: "secret", draft: draft(item, credential) }); expect(rejected.status).toBe(400);
    expect(JSON.stringify(rejected.body)).not.toContain("fixture-private-value");
    getDrizzleDb().$client.query("UPDATE review_queue_items SET source_json='{}' WHERE id=?").run(item.id);
    expect((await call(`/${queue.id}/window?centerId=${item.id}`)).status).toBe(409);
  });
  test("UTF-8 quota admission uses native byte sums and refuses duplicate curated case replacement", async () => {
    const { queue, item } = await approved("Frozen Unicode 💙 漢字"), dataset = datasets.createDataset("Immutable duplicate guard");
    const sums = getDrizzleDb().$client.query("SELECT (SELECT coalesce(sum(length(CAST(schema_json AS BLOB))),0) FROM review_queues)+(SELECT coalesce(sum(length(CAST(source_json AS BLOB))+length(CAST(draft_json AS BLOB))),0) FROM review_queue_items) AS bytes").get() as { bytes:number };
    expect(sums.bytes).toBeGreaterThan(canonicalReviewJson(queue.schema).length+canonicalReviewJson(item.source).length+canonicalReviewJson(item.draft).length);
    expect(() => queueStore.assertReviewRetention(REVIEW_LIMITS.MAX_RETAINED_BYTES-sums.bytes)).not.toThrow();
    expect(() => queueStore.assertReviewRetention(REVIEW_LIMITS.MAX_RETAINED_BYTES-sums.bytes+1)).toThrow("retention is full");
    const first = await call(`/${queue.id}/promotions`,"POST",promoteBody(item,dataset.datasetId)); expect(first.status).toBe(201);
    const promoted = queueStore.readReviewItem(queue.id,item.id);
    await call(`/${queue.id}/items/${item.id}`,"DELETE",{ expectedRevision:promoted.revision });
    const fresh = (await call(`/${queue.id}/items`,"POST",{ runId:"run-source" })).body as ReviewItem;
    const next = (await call(`/${queue.id}/items/${item.id}/approve`,"POST",{ expectedRevision:fresh.revision,mutationId:"next-incarnation",draft:draft(fresh,"Replacement target") })).body as ReviewItem;
    expect((await call(`/${queue.id}/promotions`,"POST",promoteBody(next,dataset.datasetId,2,"replacement"))).status).toBe(409);
    expect(datasets.getRevision(dataset.datasetId).version).toBe(2); expect(datasets.getRevision(dataset.datasetId).cases[0].rules).toEqual([{ kind:"output",operation:"equals",value:"Newest expected target" }]);
    expect(queueStore.readReviewItem(queue.id,item.id)).toEqual(next);
  });
  test("dataset deletion remains terminal and queue/source deletion purges retained payloads", async () => {
    const { queue, item } = await approved(), dataset = datasets.createDataset("Delete destination"), body = promoteBody(item, dataset.datasetId);
    expect((await call(`/${queue.id}/promotions`, "POST", body)).status).toBe(201);
    datasets.deleteDataset(dataset.datasetId);
    expect(queueStore.readReviewItem(queue.id, item.id).state).toBe("promoted");
    expect((await call(`/${queue.id}/promotions`, "POST", body)).status).toBe(404);
    deleteRun("run-source"); expect(queueStore.reviewCounts(queue.id).total).toBe(0);
    expect((await call(`/${queue.id}`, "DELETE")).status).toBe(204);
    expect((await call(`/${queue.id}/items`, "POST", { runId: "run-source" })).status).toBe(404);
  });
});
