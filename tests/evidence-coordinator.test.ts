import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import express from "express";
import { createServer, request as httpRequest, type Server } from "node:http";
import { once } from "node:events";
import { EvidenceStore } from "../src/evaluations/evidence-store";
import { createLocalEvidenceOwner, type EvidenceOwner } from "../src/evaluations/evidence-inventory";
import { EVIDENCE_IMPORT_CONTENT_TYPE, EVIDENCE_READER_IDENTITY, EvidenceImportService } from "../src/evaluations/evidence-import";
import { EvidenceSupervisor, spawnEvidenceWorker } from "../src/evaluations/evidence-supervisor";
import { createEvidenceRouter, evidenceBinaryHandler, evidenceJsonBody } from "../src/evaluations/evidence-router";
import { evidenceDigest } from "../src/evaluations/evidence-validation";
import { EvidenceError } from "../src/evaluations/evidence-protocol";

let db: Database, owner: EvidenceOwner, service: EvidenceImportService, server: Server, base: string, pids: number[], hold: boolean;
const raw = Buffer.from('<testsuite tests="1"><testcase name="actual control"/></testsuite>');
function frame(key: string) {
  const metadata = Buffer.from(JSON.stringify({ version: 1, request: { ...EVIDENCE_READER_IDENTITY, operationKey: key, attachment: { kind: "run", id: "run" }, target: null, inventory: null, retention: "raw_and_normalized",
    sources: [{ sourceId: "unit", kind: "junit", dialect: "junit-xml/v1", shardId: "unit", artifactSha256: evidenceDigest(raw), byteLength: raw.length }] } }));
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(metadata.length); return Buffer.concat([prefix, metadata, raw]);
}
async function setup(maxImportMs?: number, defaultQuota = false, currentAuthority = false) {
  db = new Database(":memory:"); db.exec("PRAGMA foreign_keys=ON"); migrate(drizzle(db), { migrationsFolder: `${import.meta.dir}/../drizzle` });
  db.exec("INSERT INTO evaluation_evidence_scopes VALUES('local:local',1,1); INSERT INTO runs(id,started_at,last_updated_at) VALUES('run',1,1)");
  const local = createLocalEvidenceOwner(db);
  if (currentAuthority) db.exec("CREATE TABLE current_authority(allowed INTEGER NOT NULL); INSERT INTO current_authority VALUES(1)");
  const authorize: EvidenceOwner["authorize"] = (capability, attachment) => {
    if (currentAuthority && (db.query("SELECT allowed FROM current_authority").get() as { allowed: number }).allowed !== 1) throw new EvidenceError("Current authority was revoked", 403);
    return local.authorize(capability, attachment);
  };
  owner = { ...local, authorize, store: new EvidenceStore(db, local.scope, { authorize: (capability, _scope, attachment) => authorize(capability, attachment), ...(defaultQuota ? {} : { maxNormalizedBytes: 64 * 1024 * 1024 }) }) };
  pids = []; hold = true;
  const supervisor = new EvidenceSupervisor({ workerFactory: () => {
    const child = hold ? Bun.spawn([process.execPath, "--no-env-file", "--no-install", `${import.meta.dir}/evidence-held-worker.ts`], { env: { LANG: "C.UTF-8", TZ: "UTC", ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "" } : {}) }, stdin: "pipe", stdout: "pipe", stderr: "ignore" }) : spawnEvidenceWorker();
    pids.push(child.pid); return child;
  } });
  service = new EvidenceImportService(supervisor, { maxImportMs }); service.initialize(owner);
  const app = express(); app.post("/imports", evidenceBinaryHandler(service, owner));
  // Hold the response after real service admission/publication; the test interrupts its actual client socket.
  app.post("/lost-response", (req, res) => { void service.receive(owner, req).catch(() => res.destroy()); });
  app.use(evidenceJsonBody()); app.use(createEvidenceRouter(service, owner));
  server = createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening"); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
beforeEach(async () => setup());
afterEach(async () => { await service.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
async function upload(key: string) {
  const response = await fetch(`${base}/imports`, { method: "POST", headers: { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE }, body: frame(key) });
  return { status: response.status, value: await response.json() };
}
async function until(condition: () => boolean, ms = 3_000) {
  const deadline = performance.now() + ms;
  while (!condition()) { if (performance.now() > deadline) throw new Error("Live condition deadline exceeded"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function reaped(pid: number) { try { process.kill(pid, 0); return false; } catch { return true; } }
async function cancel(id: string) { const response = await fetch(`${base}/imports/${id}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); return { status: response.status, value: await response.json() }; }
describe("one actual daemon evidence coordinator", () => {
  test("actual retention deletion fences an in-flight reparse and awaits its owned worker before responding", async () => {
    hold = false; const receipt = await upload("before-retention"); await until(() => owner.store.getJob(receipt.value.job.id).status === "completed");
    const setId = owner.store.getJob(receipt.value.job.id).setId!, before = owner.store.getSet(setId).revision;
    hold = true;
    const response = await fetch(`${base}/sets/${setId}/reparse`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operationKey: "retention-reparse", expectedRevision: 1 }) });
    expect(response.status).toBe(202); const reparse = (await response.json()).job; await until(() => pids.length === 2);
    const deletion = await fetch(`${base}/sets/${setId}/retention/raw?revision=1`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(deletion.status).toBe(200); expect((await deletion.json()).removed).toBe(1); expect(pids.every(reaped)).toBe(true);
    expect(owner.store.getJob(reparse.id)).toMatchObject({ status: "failed", failureCode: "retention_changed", setId: null });
    expect(owner.store.getSet(setId)).toMatchObject({ revision: before, sources: [{ rawAvailable: false, normalizedAvailable: true }] });
    expect(db.query("SELECT sum(reserved_normalized_bytes) AS bytes FROM evaluation_evidence_jobs").get()).toEqual({ bytes: 0 });
    hold = false; const control = await upload("after-retention-stop"); await until(() => owner.store.getJob(control.value.job.id).status === "completed");
  });
  test("transport interruption after actual publication COMMIT reuses one operation and revision", async () => {
    hold = false;
    let request!: ReturnType<typeof httpRequest>;
    const transport = new Promise<string>((resolve, reject) => {
      request = httpRequest(`${base}/lost-response`, { method: "POST", headers: { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE } }, () => reject(new Error("Fixture unexpectedly acknowledged publication")));
      request.once("error", () => resolve("interrupted")); request.end(frame("lost-ack"));
    });
    await until(() => (db.query("SELECT status FROM evaluation_evidence_jobs WHERE operation_key='lost-ack'").get() as { status: string } | null)?.status === "completed");
    request.destroy(new Error("synthetic lost acknowledgement")); expect(await transport).toBe("interrupted");
    const stored = db.query("SELECT id,set_id,status FROM evaluation_evidence_jobs WHERE operation_key='lost-ack'").get() as { id: string; set_id: string; status: string };
    expect(stored.status).toBe("completed"); const retry = await upload("lost-ack");
    expect(retry).toMatchObject({ status: 202, value: { reused: true, job: { id: stored.id, setId: stored.set_id } } });
    expect(db.query("SELECT count(*) AS n FROM evaluation_evidence_jobs").get()).toEqual({ n: 1 });
    expect(db.query("SELECT count(*) AS n FROM evaluation_evidence_sets").get()).toEqual({ n: 1 });
    expect(pids).toHaveLength(1); expect(pids.every(reaped)).toBe(true);
  });
  test("the actual owner invalidates and reaps before authority revocation, and current SQL authority fences every later request", async () => {
    await service.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); await setup(undefined, false, true);
    const receipt = await upload("revoked-active"); await until(() => pids.length === 1);
    await service.invalidateAttachments(owner, [{ kind: "run", id: "run" }]); expect(pids.every(reaped)).toBe(true);
    expect(owner.store.getJob(receipt.value.job.id)).toMatchObject({ status: "failed", failureCode: "attachment_unavailable", setId: null });
    expect(db.query("SELECT reserved_raw_bytes,reserved_normalized_bytes FROM evaluation_evidence_jobs").get()).toEqual({ reserved_raw_bytes: 0, reserved_normalized_bytes: 0 });
    db.exec("UPDATE current_authority SET allowed=0");
    expect((await upload("after-revocation")).status).toBe(403);
    expect((await fetch(`${base}/imports/${receipt.value.job.id}`)).status).toBe(403);
    expect((await cancel(receipt.value.job.id)).status).toBe(403);
    expect(db.query("SELECT count(*) AS n FROM evaluation_evidence_blobs").get()).toEqual({ n: 0 });
    db.exec("UPDATE current_authority SET allowed=1"); hold = false;
    const control = await upload("restored-authority"); await until(() => owner.store.getJob(control.value.job.id).status === "completed");
  });
  test("the default 32 MiB normalized quota refuses a ninth reservation and permits real work after release", async () => {
    await service.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); await setup(undefined, true);
    const active = await Promise.all([upload("default-active-a"), upload("default-active-b")]);
    const pending = Array.from({ length: 6 }, (_, index) => upload(`default-queued-${index}`)); await until(() => service.state.queued === 6);
    expect((await upload("default-refused")).status).toBe(409);
    expect(db.query("SELECT count(*) AS n,sum(reserved_normalized_bytes) AS bytes FROM evaluation_evidence_jobs").get()).toEqual({ n: 8, bytes: 32 * 1024 * 1024 });
    const queued = db.query("SELECT id FROM evaluation_evidence_jobs WHERE operation_key='default-queued-0'").get() as { id: string };
    expect((await cancel(queued.id)).value.cancelled).toBe(true);
    expect(db.query("SELECT sum(reserved_normalized_bytes) AS bytes FROM evaluation_evidence_jobs").get()).toEqual({ bytes: 28 * 1024 * 1024 });
    const later = upload("default-after-release"); await until(() => service.state.queued === 6);
    hold = false; await Promise.all(active.map(receipt => cancel(receipt.value.job.id)));
    const responses = await Promise.all(pending); expect(responses[0].status).toBe(409);
    const control = await later; expect(control.status).toBe(202); await until(() => owner.store.getJob(control.value.job.id).status === "completed");
    expect(owner.store.getSet(owner.store.getJob(control.value.job.id).setId!).revision.sources[0].reportOutcome).toBe("reports_pass");
    await until(() => service.state.active === 0 && service.state.queued === 0);
    expect(db.query("SELECT sum(reserved_raw_bytes) AS raw,sum(reserved_normalized_bytes) AS normalized FROM evaluation_evidence_jobs").get()).toEqual({ raw: 0, normalized: 0 });
    expect(pids.every(reaped)).toBe(true);
  });
  test("cancellation stops the original worker and an actual partial retry of the same durable operation", async () => {
    const receipt = await upload("retry-cancel"), bytes = frame("retry-cancel"), metadataEnd = 4 + bytes.readUInt32BE(0);
    const retry = new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${base}/imports`, { method: "POST", headers: { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE } }, response => { response.resume(); response.once("end", () => resolve(response.statusCode!)); });
      request.on("error", reject); request.write(bytes.subarray(0, metadataEnd + 1));
    });
    await until(() => service.state.active === 2 && pids.length === 1);
    expect((await cancel(receipt.value.job.id)).value.cancelled).toBe(true); expect(await retry).toBe(409);
    expect(service.state).toMatchObject({ active: 0, queued: 0 }); expect(pids.every(reaped)).toBe(true);
    expect(db.query("SELECT count(*) AS n,sum(reserved_normalized_bytes) AS bytes FROM evaluation_evidence_jobs").get()).toEqual({ n: 1, bytes: 0 });
  });
  test("two active and eight queued actual HTTP clients share capacity; cancellation reaps workers and releases quota", async () => {
    const active = await Promise.all([upload("active-a"), upload("active-b")]); await until(() => pids.length === 2);
    expect(service.state.active).toBe(2);
    const pending = Array.from({ length: 8 }, (_, index) => upload(`queued-${index}`)); await until(() => service.state.queued === 8);
    expect((await upload("eleventh")).status).toBe(409);
    const queued = db.query("SELECT id FROM evaluation_evidence_jobs WHERE operation_key='queued-0'").get() as { id: string };
    expect((await cancel(queued.id)).value.cancelled).toBe(true);
    expect(owner.store.getJob(queued.id)).toMatchObject({ status: "cancelled", failureCode: "cancelled" });
    const initialWorkers = [...pids];
    expect((await cancel(active[0].value.job.id)).value.cancelled).toBe(true); expect(initialWorkers.filter(reaped)).toHaveLength(1);
    await service.shutdown(); const responses = await Promise.all(pending);
    expect(responses.every(response => response.status >= 400 || response.status === 202 && ["failed", "cancelled"].includes(owner.store.getJob(response.value.job.id).status))).toBe(true);
    expect(pids.every(reaped)).toBe(true); expect(service.state).toMatchObject({ active: 0, queued: 0, closed: true });
    expect(db.query("SELECT sum(reserved_raw_bytes) AS raw,sum(reserved_normalized_bytes) AS normalized FROM evaluation_evidence_jobs").get()).toEqual({ raw: 0, normalized: 0 });
    expect(db.query("SELECT count(*) AS n FROM evaluation_evidence_blobs").get()).toEqual({ n: 0 });
  });
  test("actual production source timeout terminates the held process with truthful unavailable observations", async () => {
    const receipt = await upload("source-timeout"); await until(() => pids.length === 1);
    await until(() => owner.store.getJob(receipt.value.job.id).status === "failed");
    expect(owner.store.getJob(receipt.value.job.id)).toMatchObject({ failureCode: "worker_timeout", setId: null });
    expect(pids.every(reaped)).toBe(true); expect(service.state.active).toBe(0);
    hold = false; const control = await upload("after-timeout"); await until(() => owner.store.getJob(control.value.job.id).status === "completed");
    expect(owner.store.getSet(owner.store.getJob(control.value.job.id).setId!).revision.sources[0].reportOutcome).toBe("reports_pass");
  });
  test("queued expiry includes acquisition and queue time and does not orphan a later positive control", async () => {
    await service.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); await setup(120);
    const active = await Promise.all([upload("expiring-a"), upload("expiring-b")]); const pending = Array.from({ length: 4 }, (_, index) => upload(`expiring-queue-${index}`));
    await Promise.all(pending); await until(() => service.state.active === 0 && service.state.queued === 0);
    expect(active.every(receipt => owner.store.getJob(receipt.value.job.id).failureCode === "import_timeout")).toBe(true);
    const queued = db.query("SELECT status,failure_code FROM evaluation_evidence_jobs WHERE operation_key LIKE 'expiring-queue-%'").all();
    expect(queued).toHaveLength(4); expect(queued.every(value => (value as { status: string; failure_code: string }).status === "failed" && ["upload_timeout", "import_timeout"].includes((value as { failure_code: string }).failure_code))).toBe(true);
    expect(pids.every(reaped)).toBe(true); hold = false;
    const control = await upload("positive-after-expiry"); await until(() => owner.store.getJob(control.value.job.id).status === "completed");
  });
  test("explicit owner clear kills and waits before scope purge, and stale work cannot resurrect", async () => {
    const receipt = await upload("clear-active"); await until(() => pids.length === 1);
    await service.clear(owner); expect(pids.every(reaped)).toBe(true);
    expect(db.query("SELECT count(*) AS n FROM evaluation_evidence_jobs").get()).toEqual({ n: 0 });
    expect(db.query("SELECT generation FROM evaluation_evidence_scopes").get()).toEqual({ generation: 2 });
    expect(() => owner.store.getJob(receipt.value.job.id)).toThrow("not found");
    hold = false; const control = await upload("after-clear"); await until(() => owner.store.getJob(control.value.job.id).status === "completed");
    expect(owner.store.getJob(control.value.job.id).scopeGeneration).toBe(2);
  });
  test("partial live upload expiry retains only a failed declaration and releases its reservation", async () => {
    await service.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); await setup(70);
    const bytes = frame("partial"), metadataEnd = 4 + bytes.readUInt32BE(0);
    const result = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${base}/imports`, { method: "POST", headers: { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE } }, response => { response.resume(); response.once("end", () => resolve(response.statusCode!)); });
      request.on("error", reject); request.write(bytes.subarray(0, metadataEnd + 1));
    });
    expect(result).toBe(409);
    expect(db.query("SELECT status,failure_code,reserved_raw_bytes,reserved_normalized_bytes FROM evaluation_evidence_jobs WHERE operation_key='partial'").get()).toEqual({ status: "failed", failure_code: "upload_timeout", reserved_raw_bytes: 0, reserved_normalized_bytes: 0 });
    expect(db.query("SELECT count(*) AS n FROM evaluation_evidence_blobs").get()).toEqual({ n: 0 }); expect(pids).toHaveLength(0);
  });
});
