import { afterEach, beforeEach, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { closeDb, getDrizzleDb } from "../src/db";
import { createServer } from "../src/server";
import { createDataset, getRevision } from "../src/evaluations/store";
import { REVIEW_LIMITS, type ReviewItem, type ReviewQueue } from "../src/review-queues/protocol";

let server: Server, directory: string, previousDb: string | undefined, base: string;
beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "rq-connected-daemon-")); previousDb = process.env.RUNPHANTOM_DB_PATH;
  closeDb(); process.env.RUNPHANTOM_DB_PATH = path.join(directory, "actual.db"); await start();
  const db = getDrizzleDb().$client;
  db.query("INSERT INTO runs(id,name,started_at,last_updated_at) VALUES('source','Captured response',1,2)").run();
  db.query("INSERT INTO spans(run_id,id,name,span_type,status,input_payload,output_payload,attributes,start_time_ms,end_time_ms) VALUES('source','root','agent','AGENT_ROOT','OK','Original input','Frozen response β','{}',1,2)").run();
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve())); closeDb();
  if (previousDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = previousDb;
  rmSync(directory, { recursive: true, force: true });
});
async function start() {
  ({ server } = await createServer(0)); server.listen(0, "127.0.0.1"); await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function call(route = "", method = "GET", body?: unknown) {
  const response = await fetch(`${base}/api/review-queues${route}`, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); return { status: response.status, value: text ? JSON.parse(text) : null, response };
}
async function captured() {
  const created = await call("", "POST", { name: "Local operator queue" }); expect(created.status).toBe(201);
  const queue = created.value as ReviewQueue;
  const added = await call(`/${queue.id}/items`, "POST", { runId: "source" }); expect(added.status).toBe(201);
  return { queue, item: added.value as ReviewItem };
}
test("actual daemon promotes the newest approved draft once and reopens without reseeding", async () => {
  const { queue, item } = await captured();
  const approved = await call(`/${queue.id}/items/${item.id}/approve`, "POST", { expectedRevision: item.revision, mutationId: "latest-approval", draft: { ...item.draft, target: { expectedOutput: "Latest human target" } } });
  expect(approved.status).toBe(200); expect(approved.value.reviewSource).toBe("localOperator");
  const dataset = createDataset("Curated frozen responses");
  const request = { datasetId: dataset.datasetId, expectedDatasetVersion: 1, idempotencyKey: "receipt-first", items: [{ itemId: item.id, expectedRevision: approved.value.revision }] };
  const promoted = await call(`/${queue.id}/promotions`, "POST", request); expect(promoted.status).toBe(201);
  const revision = getRevision(dataset.datasetId, 2);
  expect(revision.cases).toHaveLength(1); expect(revision.cases[0].sourceOutput).toBe("Frozen response β"); expect(revision.cases[0].rules).toEqual([{ kind: "output", operation: "equals", value: "Latest human target" }]);
  getDrizzleDb().$client.query("UPDATE spans SET output_payload='Changed live response' WHERE run_id='source'").run();
  await new Promise<void>(resolve => server.close(() => resolve())); closeDb(); await start();
  expect((await call(`/${queue.id}/promotions`, "POST", request)).value).toEqual(promoted.value);
  const window = await call(`/${queue.id}/window?centerId=${item.id}`); expect(window.status).toBe(200);
  expect(window.value[0]).toMatchObject({ source: { output: "Frozen response β" }, state: "promoted", promotedDatasetVersion: 2 });
  expect(getDrizzleDb().$client.query("SELECT COUNT(*) AS n FROM evaluation_revisions WHERE dataset_id=?").get(dataset.datasetId)).toEqual({ n: 2 });
  expect(getDrizzleDb().$client.query("SELECT COUNT(*) AS n FROM review_queue_promotions").get()).toEqual({ n: 1 });
  expect(getDrizzleDb().$client.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
test("actual daemon applies strict review parsing before its global 50MiB parser and preserves local guards", async () => {
  const post = (body: string, headers: Record<string, string> = {}) => fetch(`${base}/api/review-queues`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
  const duplicate = await post('{"name":"first","name":"second"}'); expect(duplicate.status).toBe(400); expect(await duplicate.json()).toMatchObject({ error: { code: "invalid_request" } });
  expect((await post(JSON.stringify({ name: "x".repeat(REVIEW_LIMITS.MAX_REQUEST_BYTES) }))).status).toBe(413);
  expect((await post('{"name":'+"[".repeat(30)+'"nested"'+"]".repeat(30)+'}')).status).toBe(400);
  expect((await post('{"name":"blocked"}', { Origin: "https://untrusted.example" })).status).toBe(403);
  expect((await fetch(`${base}/api/review-queues`, { headers: { Host: "untrusted.example" } })).status).toBe(403);
  expect((await post('name=text', { "Content-Type": "text/plain" })).status).toBe(400);
  const listed = await call(); expect(listed.status).toBe(200); expect(listed.value).toEqual([]); expect(listed.response.headers.get("cache-control")).toBe("no-store");
});
test.each([
  { name: "charset", headers: { "Content-Type": "application/json; charset=iso-8859-1" } },
  { name: "content encoding", headers: { "Content-Type": "application/json", "Content-Encoding": "unrecognized" } },
])("actual daemon refuses unsupported $name with sanitized415 and no retention", async ({ headers }) => {
  const db = getDrizzleDb().$client;
  const original = JSON.stringify([db.query("SELECT * FROM runs ORDER BY id").all(), db.query("SELECT * FROM spans ORDER BY run_id,id").all()]);
  const response = await fetch(`${base}/api/review-queues`, { method: "POST", headers, body: '{"name":"REFUSED_BODY_F29_TRANSPORT_SENTINEL"}' });
  expect(response.status).toBe(415);
  expect(await response.json()).toEqual({ error: { code: "unsupported_media_type", message: "Unsupported review request charset or content encoding" } });
  expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.get("content-type")).toContain("application/json");
  expect(JSON.stringify([db.query("SELECT * FROM runs ORDER BY id").all(), db.query("SELECT * FROM spans ORDER BY run_id,id").all()])).toBe(original);
  for (const table of ["review_queues", "review_queue_items", "review_queue_promotions"]) expect(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
test("actual daemon refuses deleted incarnation CAS after fresh intake", async () => {
  const { queue, item } = await captured();
  expect((await call(`/${queue.id}/items/${item.id}`, "DELETE", { expectedRevision: item.revision })).status).toBe(204);
  getDrizzleDb().$client.query("UPDATE spans SET output_payload='New incarnation response' WHERE run_id='source'").run();
  const replacement = await call(`/${queue.id}/items`, "POST", { runId: "source" }); expect(replacement.status).toBe(201);
  expect(replacement.value.id).toBe(item.id); expect(replacement.value.revision).toBeGreaterThan(item.revision);
  const stale = { expectedRevision: item.revision, mutationId: "delayed-old", draft: { ...item.draft, target: { expectedOutput: "Old target" } } };
  expect((await call(`/${queue.id}/items/${item.id}`, "PUT", stale)).status).toBe(409);
  expect((await call(`/${queue.id}/items/${item.id}/approve`, "POST", stale)).status).toBe(409);
  expect((await call(`/${queue.id}/window?centerId=${item.id}`)).value[0]).toEqual(replacement.value);
  const approved = await call(`/${queue.id}/items/${item.id}/approve`, "POST", { expectedRevision: replacement.value.revision, mutationId: "new-incarnation", draft: { ...replacement.value.draft, target: { expectedOutput: "New incarnation target" } } }); expect(approved.status).toBe(200);
  const dataset = createDataset("Stale promotion refusal");
  expect((await call(`/${queue.id}/promotions`, "POST", { datasetId: dataset.datasetId, expectedDatasetVersion: 1, idempotencyKey: "delayed-old-promotion", items: [{ itemId: item.id, expectedRevision: item.revision }] })).status).toBe(409);
  expect(getRevision(dataset.datasetId).version).toBe(1); expect(getRevision(dataset.datasetId).cases).toEqual([]);
  expect((await call(`/${queue.id}/window?centerId=${item.id}`)).value[0]).toEqual(approved.value);
});
test("a hard-killed actual daemon reopens frozen promotion and exact receipt without reseeding", async () => {
  await new Promise<void>(resolve => server.close(() => resolve())); closeDb();
  const script = path.join(directory, "daemon-process.ts");
  writeFileSync(script, `import {once} from "node:events";import {createServer} from ${JSON.stringify(path.resolve(import.meta.dir, "../src/server.ts"))};const {server}=await createServer(0);server.listen(0,"127.0.0.1");await once(server,"listening");console.log(JSON.stringify({pid:process.pid,port:server.address().port}));`);
  async function boot() {
    const child = Bun.spawn([process.execPath, script], { cwd: directory, env: { ...process.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", RUNPHANTOM_OPENAI_API_KEY: "", RUNPHANTOM_CLAUDE_CLI_CHAT: "0" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader(); let output = "";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = await Promise.race([
        (async () => { while (!output.includes("\n")) { const next = await reader.read(); if (next.done) throw new Error("Daemon exited before listening"); output += new TextDecoder().decode(next.value); } return JSON.parse(output.split("\n")[0]) as { pid: number; port: number }; })(),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Daemon startup timed out")), 5000); }),
      ]);
      base = `http://127.0.0.1:${ready.port}`; return { child, ready };
    } catch (error) { child.kill("SIGKILL"); await child.exited; throw error; }
    finally { clearTimeout(timeout); reader.releaseLock(); }
  }
  const first = await boot(); let second: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    const { queue, item } = await captured();
    const approved = await call(`/${queue.id}/items/${item.id}/approve`, "POST", { expectedRevision: item.revision, mutationId: "before-crash", draft: { ...item.draft, target: { expectedOutput: "Frozen crash target" } } }); expect(approved.status).toBe(200);
    const createdDataset = await fetch(`${base}/api/evaluations/datasets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Crash receipt dataset" }) }); expect(createdDataset.status).toBe(201);
    const dataset = await createdDataset.json() as { datasetId: string };
    const request = { datasetId: dataset.datasetId, expectedDatasetVersion: 1, idempotencyKey: "crash-retry", items: [{ itemId: item.id, expectedRevision: approved.value.revision }] };
    const promoted = await call(`/${queue.id}/promotions`, "POST", request); expect(promoted.status).toBe(201);
    first.child.kill("SIGKILL"); await first.child.exited;
    second = await boot(); expect(second.ready.pid).not.toBe(first.ready.pid); expect(second.ready.pid).not.toBe(process.pid);
    expect((await call(`/${queue.id}/promotions`, "POST", request)).value).toEqual(promoted.value);
    const revisionResponse = await fetch(`${base}/api/evaluations/datasets/${dataset.datasetId}?version=2`); expect(revisionResponse.status).toBe(200);
    const revision = await revisionResponse.json() as { cases: Array<{ sourceOutput: string; rules: unknown[] }> };
    expect(revision.cases).toHaveLength(1); expect(revision.cases[0].sourceOutput).toBe("Frozen response β"); expect(revision.cases[0].rules).toEqual([{ kind: "output", operation: "equals", value: "Frozen crash target" }]);
    const reopened = (await call(`/${queue.id}/window?centerId=${item.id}`)).value[0];
    expect(reopened).toMatchObject({ state: "promoted", sourceHash: item.sourceHash, source: item.source, promotedDatasetVersion: 2 });
    if (process.env.REVIEW_QUEUE_NATIVE_EVIDENCE_PATH) writeFileSync(process.env.REVIEW_QUEUE_NATIVE_EVIDENCE_PATH, JSON.stringify({ qualification: "actual source daemon hard-kill and process restart without reseed", firstPid: first.ready.pid, secondPid: second.ready.pid, request, receipt: promoted.value, reopened, revision }, null, 2) + "\n");
  } finally {
    if (first.child.exitCode === null) { first.child.kill("SIGKILL"); await first.child.exited; }
    if (second?.child.exitCode === null) { second.child.kill("SIGKILL"); await second.child.exited; }
    await start();
  }
  expect(getDrizzleDb().$client.query("SELECT COUNT(*) AS n FROM review_queue_promotions").get()).toEqual({ n: 1 });
  expect(getDrizzleDb().$client.query("SELECT COUNT(*) AS n FROM evaluation_revisions").get()).toEqual({ n: 2 });
  expect(getDrizzleDb().$client.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
