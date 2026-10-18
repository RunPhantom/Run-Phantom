import { afterEach, beforeEach, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, deleteRun, getDrizzleDb, insertSpan, upsertRun } from "../src/db";
import { createServer } from "../src/server";
import { promoteLocalReplayRun } from "../src/replay";
import { createLocalEvidenceOwner } from "../src/evaluations/evidence-inventory";
import { EVIDENCE_IMPORT_CONTENT_TYPE, EVIDENCE_READER_IDENTITY } from "../src/evaluations/evidence-import";
import { evidenceDigest } from "../src/evaluations/evidence-validation";
import type { EvidenceAttachment } from "../src/evaluations/evidence-protocol";
import { WebSocket } from "ws";

let directory: string, previous: string | undefined, server: Server | undefined, demoDrainUntil = 0;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "runphantom-f04-delete-")); previous = process.env.RUNPHANTOM_DB_PATH; closeDb(); process.env.RUNPHANTOM_DB_PATH = join(directory, "actual.db");
  getDrizzleDb().$client.exec("INSERT INTO evaluation_evidence_scopes VALUES('local:local',1,1)");
  demoDrainUntil = 0;
});
afterEach(async () => {
  if (demoDrainUntil) {
    while (performance.now() < demoDrainUntil && (getDrizzleDb().$client.query("SELECT count(*) AS n FROM spans WHERE run_id LIKE 'demo_%' AND span_type='AGENT_ROOT' AND status!='UNSET'").get() as { n: number }).n !== 3) await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (server) await new Promise<void>(done => server!.close(() => done())); server = undefined; closeDb();
  if (previous === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = previous; rmSync(directory, { recursive: true, force: true });
});
function seed(id: string) {
  upsertRun({ id, name: `Original ${id}`, metadata: '{"original":true}', started_at: 1, last_updated_at: 1 });
  insertSpan({ id: `${id}-span`, run_id: id, name: "actual original", start_time_ms: 1, end_time_ms: 2, duration_ms: 1 });
}
function admit(attachment: EvidenceAttachment) {
  const store = createLocalEvidenceOwner(getDrizzleDb().$client).store;
  return { store, admission: store.admit({ ...EVIDENCE_READER_IDENTITY, operationKey: `protect-${attachment.kind}-${attachment.id}`, attachment, target: null, inventory: null,
    retention: "normalized_only", sources: [{ sourceId: "unit", kind: "junit", dialect: "junit-xml/v1", shardId: "unit", artifactSha256: evidenceDigest(""), byteLength: 0 }] }) };
}
function snapshot() {
  const db = getDrizzleDb().$client;
  return JSON.stringify({ runs: db.query("SELECT * FROM runs ORDER BY id").all(), spans: db.query("SELECT * FROM spans ORDER BY id").all(), annotations: db.query("SELECT * FROM annotations ORDER BY id").all() });
}
test("central synchronous deletion protects run, inspection and actual check anchors and refuses corrupt active metadata", () => {
  for (const kind of ["run", "inspection", "check"] as const) {
    const id = `original-${kind}`; seed(id);
    if (kind === "check") getDrizzleDb().$client.query("INSERT INTO verification_reports(id,session_id,run_id,name,status,reason,evidence,created_at) VALUES(?,'session',?,'Observed','pass','Observed','[]',1)").run("actual-check", id);
    const { store, admission } = admit({ kind, id: kind === "check" ? "actual-check" : id }), original = snapshot();
    expect(() => deleteRun(id)).toThrow("active evidence import"); expect(snapshot()).toBe(original);
    expect(store.getJob(admission.job.id).status).toBe("queued"); expect(store.cancel(admission.job.id)).toBe(true);
    deleteRun(id); expect(getDrizzleDb().$client.query("SELECT id FROM runs WHERE id=?").get(id)).toBeNull();
  }
  seed("unrelated"); seed("corrupt-anchor"); const { admission, store } = admit({ kind: "run", id: "corrupt-anchor" });
  const db = getDrizzleDb().$client, row = db.query("SELECT request_data FROM evaluation_evidence_jobs WHERE id=?").get(admission.job.id) as { request_data: string };
  db.query("UPDATE evaluation_evidence_jobs SET request_data=? WHERE id=?").run("x".repeat(65_537), admission.job.id);
  const before = snapshot(); expect(() => deleteRun("unrelated")).toThrow("integrity boundary"); expect(snapshot()).toBe(before);
  db.query("UPDATE evaluation_evidence_jobs SET request_data=? WHERE id=?").run(row.request_data, admission.job.id); store.cancel(admission.job.id); deleteRun("unrelated");
  expect(db.query("SELECT id FROM runs WHERE id='unrelated'").get()).toBeNull();
});
test("actual replay promotion rolls back target changes and moved annotations on refusal, then promotes after cancel", () => {
  seed("placeholder"); seed("target"); const db = getDrizzleDb().$client;
  db.exec("INSERT INTO annotations(id,run_id,span_id,kind,note,source,created_at) VALUES('actual-note','placeholder','placeholder-span','note','Keep original','user',1)");
  const { admission, store } = admit({ kind: "run", id: "placeholder" }), before = snapshot();
  const input = { placeholderRunId: "placeholder", otlpRunId: "target", replayMetadata: '{"replay":"promoted"}', replayName: "Promoted target" };
  expect(() => getDrizzleDb().transaction(() => promoteLocalReplayRun(input))).toThrow("active evidence import"); expect(snapshot()).toBe(before);
  expect(store.cancel(admission.job.id)).toBe(true); expect(getDrizzleDb().transaction(() => promoteLocalReplayRun(input))).toBe("target");
  expect(db.query("SELECT id FROM runs WHERE id='placeholder'").get()).toBeNull();
  expect(db.query("SELECT name,metadata FROM runs WHERE id='target'").get()).toEqual({ name: "Promoted target", metadata: input.replayMetadata });
  expect(db.query("SELECT run_id,span_id,note FROM annotations WHERE id='actual-note'").get()).toEqual({ run_id: "target", span_id: null, note: "Keep original" });
});
test("public demo reset refuses atomically before success output, then actual fixture streaming succeeds after cancel", async () => {
  for (const id of ["demo_triage", "demo_review", "demo_research"]) seed(id);
  ({ server } = await createServer(0)); server.listen(0, "127.0.0.1"); await once(server, "listening"); const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { store, admission } = admit({ kind: "run", id: "demo_review" });
  const before = snapshot(), refused = await fetch(`${base}/api/demo-traces/replay`, { method: "POST" });
  expect(refused.status).toBe(409); expect(await refused.json()).not.toHaveProperty("ok", true); expect(snapshot()).toBe(before);
  store.cancel(admission.job.id); demoDrainUntil = performance.now() + 14_000; const response = await fetch(`${base}/api/demo-traces/replay`, { method: "POST" });
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ok: true, runIds: ["demo_triage", "demo_review", "demo_research"] });
  const deadline = performance.now() + 14_000;
  while ((getDrizzleDb().$client.query("SELECT count(*) AS n FROM spans WHERE run_id LIKE 'demo_%' AND span_type='AGENT_ROOT' AND status!='UNSET'").get() as { n: number }).n !== 3) {
    if (performance.now() > deadline) throw new Error("Actual demo stream did not finish"); await new Promise(resolve => setTimeout(resolve, 20));
  }
  expect((getDrizzleDb().$client.query("SELECT count(*) AS n FROM spans WHERE run_id LIKE 'demo_%'").get() as { n: number }).n).toBeGreaterThan(10);
}, 20_000);

test("a refused public reset preserves the already streaming demo timers and live output", async () => {
  ({ server } = await createServer(0)); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`, db = getDrizzleDb().$client;
  const roots = () => db.query("SELECT run_id,status,end_time_ms-start_time_ms AS elapsed FROM spans WHERE run_id LIKE 'demo_%' AND span_type='AGENT_ROOT' ORDER BY run_id").all() as { run_id: string; status: string; elapsed: number }[];
  const finished = [ { run_id: "demo_research", status: "OK", elapsed: 7_600 }, { run_id: "demo_review", status: "OK", elapsed: 6_200 }, { run_id: "demo_triage", status: "OK", elapsed: 5_200 } ];
  const until = async (condition: () => boolean, ms: number) => {
    const deadline = performance.now() + ms;
    while (!condition()) { if (performance.now() > deadline) throw new Error("Original live demo did not reach its unchanged fixture deadline"); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  const socket = new WebSocket(`${base.replace("http:", "ws:")}/ws`);
  const delivered: { event: string; data: { traceId?: string; content?: string } }[] = [];
  socket.on("message", data => delivered.push(JSON.parse(data.toString()))); await once(socket, "open");
  let upload: ReturnType<typeof httpRequest> | undefined;
  try {
    demoDrainUntil = performance.now() + 14_000;
    const initial = await fetch(`${base}/api/demo-traces/replay`, { method: "POST" }); expect(initial.status).toBe(200); await initial.json();
    await until(() => roots().length === 2 && roots().every(root => root.status === "UNSET"), 2_000);
    const originalRuns = db.query("SELECT id,started_at FROM runs WHERE id LIKE 'demo_%' ORDER BY id").all() as { id: string; started_at: number }[];
    const originalLive = db.query("SELECT * FROM live_events WHERE trace_id LIKE 'demo_%' ORDER BY id").all() as { id: number }[];
    expect(originalLive.length).toBeGreaterThan(0);
    const raw = Buffer.from('<testsuite tests="1"><testcase name="actual partial stream"/></testsuite>');
    const metadata = Buffer.from(JSON.stringify({ version: 1, request: { ...EVIDENCE_READER_IDENTITY, operationKey: "live-demo-refusal", attachment: { kind: "run", id: "demo_review" },
      target: null, inventory: null, retention: "raw_and_normalized", sources: [{ sourceId: "unit", kind: "junit", dialect: "junit-xml/v1", shardId: "unit", artifactSha256: evidenceDigest(raw), byteLength: raw.length }] } }));
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(metadata.length);
    upload = httpRequest(`${base}/api/evaluations/evidence/imports`, { method: "POST", headers: { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE } }, response => response.resume()); upload.on("error", () => {});
    upload.write(Buffer.concat([prefix, metadata, raw.subarray(0, 1)]));
    await until(() => db.query("SELECT id FROM evaluation_evidence_jobs WHERE operation_key='live-demo-refusal' AND status='running'").get() !== null, 1_000);
    const deliveredBeforeRefusal = delivered.length, refused = await fetch(`${base}/api/demo-traces/replay`, { method: "POST" });
    expect(refused.status).toBe(409); expect(await refused.json()).not.toHaveProperty("ok", true);
    for (const original of originalRuns) expect(db.query("SELECT id,started_at FROM runs WHERE id=?").get(original.id)).toEqual(original);
    upload.destroy();
    await until(() => roots().length === 3 && roots().every(root => root.status === "OK"), 14_000);
    expect(roots()).toEqual(finished);
    for (const original of originalRuns) expect(db.query("SELECT id,started_at FROM runs WHERE id=?").get(original.id)).toEqual(original);
    for (const original of originalLive) expect(db.query("SELECT * FROM live_events WHERE id=?").get(original.id)).toEqual(original);
    expect(delivered.slice(deliveredBeforeRefusal).some(event => event.event === "live" && event.data.traceId === "demo_research" && Boolean(event.data.content))).toBe(true);
    const counts = db.query("SELECT trace_id,count(*) AS n FROM live_events WHERE trace_id LIKE 'demo_%' GROUP BY trace_id ORDER BY trace_id").all() as { trace_id: string; n: number }[];
    expect(counts.map(row => row.trace_id)).toEqual(["demo_research", "demo_review", "demo_triage"]); expect(counts.every(row => row.n > 10)).toBe(true);
    demoDrainUntil = performance.now() + 14_000;
    const control = await fetch(`${base}/api/demo-traces/replay`, { method: "POST" }); expect(control.status).toBe(200); await control.json();
    await until(() => roots().length === 3 && roots().every(root => root.status === "OK"), 14_000); expect(roots()).toEqual(finished);
    expect(db.query("SELECT status,reserved_raw_bytes,reserved_normalized_bytes FROM evaluation_evidence_jobs WHERE operation_key='live-demo-refusal'").get()).toMatchObject({ status: "failed", reserved_raw_bytes: 0, reserved_normalized_bytes: 0 });
  } finally { upload?.destroy(); socket.terminate(); }
}, 35_000);
