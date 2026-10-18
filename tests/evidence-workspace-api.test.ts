import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Server } from "node:http";
import { closeDb, getDrizzleDb, upsertRun } from "../src/db";
import { createServer } from "../src/server";
import { EVIDENCE_IMPORT_CONTENT_TYPE, EVIDENCE_READER_IDENTITY } from "../src/evaluations/evidence-import";
import { canonicalEvidenceJson, evidenceDigest } from "../src/evaluations/evidence-validation";
import type { EvidenceImportRequest, EvidenceJob, EvidenceSetView } from "../src/evaluations/evidence-protocol";
import { boundedEvidenceExport, evidenceExport, evidenceExportJUnit } from "../src/evaluations/evidence-export";
import { EvidenceInventories, createLocalEvidenceOwner, listEvidenceSets, type EvidenceOwner } from "../src/evaluations/evidence-inventory";
import { EvidenceError } from "../src/evaluations/evidence-protocol";

let server: Server, directory: string, oldDb: string | undefined, base: string;
const raw = Buffer.from('<testsuite tests="2" failures="1"><testcase name="safe pass"/><testcase name="&lt;script&gt;inert&lt;/script&gt;"><failure>Authorization: Bearer synthetic-token-value</failure></testcase></testsuite>');
const expected = [{ shardId: "unit", kind: "junit", constraints: { runnerId: null, commit: null, sourceSha256: null } }];
beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "runphantom-evidence-workspace-")); oldDb = process.env.RUNPHANTOM_DB_PATH;
  closeDb(); process.env.RUNPHANTOM_DB_PATH = path.join(directory, "actual.db");
  await start(); upsertRun({ id: "actual-run", started_at: 1, last_updated_at: 1 });
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve())); closeDb();
  if (oldDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = oldDb;
  rmSync(directory, { recursive: true, force: true });
});
async function start() {
  ({ server } = await createServer(0)); server.listen(0, "127.0.0.1"); await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function draft(operationKey: string, bytes = raw): EvidenceImportRequest {
  return { ...EVIDENCE_READER_IDENTITY, operationKey, attachment: { kind: "run", id: "actual-run" }, target: null, inventory: null, retention: "raw_and_normalized",
    sources: [{ sourceId: "unit", kind: "junit", dialect: "junit-xml/v1", shardId: "unit", artifactSha256: evidenceDigest(bytes), byteLength: bytes.length }] };
}
function encode(request: EvidenceImportRequest, sources = [raw]) {
  const metadata = Buffer.from(JSON.stringify({ version: 1, request })), prefix = Buffer.alloc(4); prefix.writeUInt32BE(metadata.length);
  return Buffer.concat([prefix, metadata, ...sources]);
}
async function json(route: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}/api/evaluations/evidence${route}`, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, value: await response.json(), response };
}
async function upload(request: EvidenceImportRequest, sources = [raw]) {
  const response = await fetch(`${base}/api/evaluations/evidence/imports`, { method: "POST", headers: { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE }, body: encode(request, sources) });
  return { status: response.status, value: await response.json() as { job: EvidenceJob; reused: boolean } };
}
async function terminal(id: string): Promise<EvidenceJob> {
  const deadline = performance.now() + 4_000;
  while (performance.now() < deadline) {
    const result = await json(`/imports/${id}`); expect(result.status).toBe(200);
    const job = result.value.job as EvidenceJob;
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Actual evidence job did not finish");
}
describe("persisted workspace API projections", () => {
  test("authorized history and current inventory survive reopen without exposing source bodies", async () => {
    const anchor = { kind: "run", id: "actual-run" }, query = new URLSearchParams({ anchor: JSON.stringify(anchor) });
    expect((await json(`/inventories?${query}`)).status).toBe(404);
    const first = await json("/inventories", "POST", { anchor, expectedRevision: 0, expected });
    const second = await json("/inventories", "PUT", { anchor, expectedRevision: 1, expected: [...expected, { ...expected[0], shardId: "integration" }] });
    expect((await json(`/inventories?${query}`)).value).toEqual(second.value);
    expect((await json(`/inventories?${query}&revision=1`)).value).toEqual(first.value);
    expect((await json("/inventories", "PUT", { anchor, expectedRevision: 1, expected })).status).toBe(409);
    const request = draft("history-reopen"); request.inventory = { id: second.value.id, revision: 2 };
    const job = await terminal((await upload(request)).value.job.id), historyQuery = new URLSearchParams({ attachment: JSON.stringify(anchor) });
    const history = await json(`/sets?${historyQuery}`);
    expect(history.status).toBe(200); expect(history.value).toEqual({ items: [{ id: job.setId, revision: 1, createdAt: expect.any(Number) }], truncated: false });
    expect(history.response.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(history.value.items[0])).toEqual(["id", "revision", "createdAt"]);
    expect(JSON.stringify(history.value)).not.toMatch(/safe pass|Bearer|rawAvailable|normalized|sourceId/);
    upsertRun({ id: "unrelated-run", started_at: 2, last_updated_at: 2 });
    expect((await json(`/sets?${new URLSearchParams({ attachment: JSON.stringify({ ...anchor, id: "unrelated-run" }) })}`)).value).toEqual({ items: [], truncated: false });
    expect((await json(`/sets?${new URLSearchParams({ attachment: JSON.stringify({ ...anchor, id: "missing-run" }) })}`)).status).toBe(404);
    expect((await json(`/sets?${historyQuery}&path=secret`)).status).toBe(400);
    expect((await json(`/inventories?${query}&url=https://example.test`)).status).toBe(400);
    await new Promise<void>(resolve => server.close(() => resolve())); closeDb(); await start();
    expect((await json(`/sets?${historyQuery}`)).value).toEqual(history.value);
    expect((await json(`/inventories?${query}`)).value).toEqual(second.value);
  });
  test("history truncates real heads and refuses malformed or oversized stored metadata rather than false empty", async () => {
    for (let i = 0; i < 52; i++) expect((await terminal((await upload(draft(`bounded-history-${i}`))).value.job.id)).status).toBe("completed");
    const route = `/sets?${new URLSearchParams({ attachment: JSON.stringify({ kind: "run", id: "actual-run" }) })}`;
    const history = await json(route); expect(history.status).toBe(200); expect(history.value.items).toHaveLength(50); expect(history.value.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(history.value))).toBeLessThan(128 * 1024);
    const database = getDrizzleDb().$client, row = database.query("SELECT id,data FROM evaluation_evidence_sets LIMIT 1").get() as { id: string; data: string };
    database.exec("DROP TRIGGER evaluation_evidence_sets_immutable");
    database.query("UPDATE evaluation_evidence_sets SET data=? WHERE id=?").run("{malformed", row.id);
    const malformed = await json(route); expect(malformed.status).toBe(409); expect(malformed.value.error).toContain("unavailable");
    database.query("UPDATE evaluation_evidence_sets SET data=? WHERE id=?").run("x".repeat(4 * 1024 * 1024 + 1), row.id);
    expect((await json(route)).status).toBe(409);
    database.query("UPDATE evaluation_evidence_sets SET data=? WHERE id=?").run(row.data, row.id);
    expect((await json(route)).value).toEqual(history.value);
  });
  test("history budgets only matched heads before set JSON, guards candidate job bytes and verifies stored request digests", async () => {
    // Seed at most two actual imports at once; terminal retains its per-job deadline.
    for (let i = 0; i < 52; i += 2) {
      await Promise.all([i, i + 1].map(async index => {
        expect((await terminal((await upload(draft(`budget-history-${index}`))).value.job.id)).status).toBe("completed");
      }));
    }
    upsertRun({ id: "unrelated-run", started_at: 2, last_updated_at: 2 });
    const unrelatedRequest = draft("unrelated-history"); unrelatedRequest.attachment.id = "unrelated-run";
    const unrelated = await terminal((await upload(unrelatedRequest)).value.job.id);
    const route = `/sets?${new URLSearchParams({ attachment: JSON.stringify({ kind: "run", id: "actual-run" }) })}`;
    const history = await json(route); expect(history.status).toBe(200); expect(history.value.items).toHaveLength(50); expect(history.value.truncated).toBe(true);
    const database = getDrizzleDb().$client;
    const rows = database.query("SELECT id,job_id,data FROM evaluation_evidence_sets WHERE id!=?").all(unrelated.setId!) as { id: string; job_id: string; data: string }[];
    const other = database.query("SELECT data FROM evaluation_evidence_sets WHERE id=?").get(unrelated.setId!) as { data: string };
    const otherJob = database.query("SELECT request_data FROM evaluation_evidence_jobs WHERE id=?").get(unrelated.id) as { request_data: string };
    database.exec("DROP TRIGGER evaluation_evidence_sets_immutable");
    database.query("UPDATE evaluation_evidence_sets SET data=? WHERE id=?").run("{invalid".padEnd(33 * 1024 * 1024, "x"), unrelated.setId!);
    expect((await json(route)).value).toEqual(history.value); // Known unrelated attachment does not consume this discovery budget.
    database.query("UPDATE evaluation_evidence_sets SET data=? WHERE id=?").run(other.data, unrelated.setId!);
    for (const bad of [JSON.stringify({ ...JSON.parse(otherJob.request_data), path: "unapproved" }), otherJob.request_data.replace('"attachment":', '"attachment":{"kind":"run","id":"actual-run"},"attachment":')]) {
      database.query("UPDATE evaluation_evidence_jobs SET request_data=? WHERE id=?").run(bad, unrelated.id);
      const refused = await json(route); expect(refused.status).toBe(409); expect(refused.value.error).toContain("job metadata integrity");
    }
    database.query("UPDATE evaluation_evidence_jobs SET request_data=? WHERE id=?").run(otherJob.request_data, unrelated.id);
    expect((await json(route)).value).toEqual(history.value);
    database.transaction(() => { for (const row of rows) database.query("UPDATE evaluation_evidence_sets SET data=? WHERE id=?").run("{invalid".padEnd(700 * 1024, "x"), row.id); }).immediate();
    const aggregate = await json(route); expect(aggregate.status).toBe(409); expect(aggregate.value.error).toContain("discovery metadata budget");
    database.transaction(() => { for (const row of rows) database.query("UPDATE evaluation_evidence_sets SET data=? WHERE id=?").run(row.data, row.id); }).immediate();
    expect((await json(route)).value).toEqual(history.value);
    const job = database.query("SELECT request_data,request_digest FROM evaluation_evidence_jobs WHERE id=?").get(rows[0].job_id) as { request_data: string; request_digest: string };
    for (const bad of ["{invalid", "x".repeat(64 * 1024 + 1)]) {
      database.query("UPDATE evaluation_evidence_jobs SET request_data=? WHERE id=?").run(bad, rows[0].job_id);
      const refused = await json(route); expect(refused.status).toBe(409); expect(refused.value.error).toContain("unavailable");
    }
    database.query("UPDATE evaluation_evidence_jobs SET request_data=?,request_digest=? WHERE id=?").run(job.request_data, "0".repeat(64), rows[0].job_id);
    expect((await json(route)).status).toBe(409);
    database.query("UPDATE evaluation_evidence_jobs SET request_digest=? WHERE id=?").run(job.request_digest, rows[0].job_id);
    expect((await json(route)).value).toEqual(history.value);
    // A corrupt database may bypass admission's 1,000-revision quota. Discovery must refuse before parsing its set payloads.
    const generation = database.query("SELECT scope_generation FROM evaluation_evidence_jobs WHERE id=?").get(rows[0].job_id) as { scope_generation: number };
    database.transaction(() => {
      for (let i = 52; i < 1_001; i++) {
        const id = `corrupt-head-${i}`, request = { ...JSON.parse(job.request_data), operationKey: id };
        const digest = evidenceDigest(canonicalEvidenceJson({ scope: { kind: "local", id: "local" }, generation: generation.scope_generation, request, inventoryDigest: null }));
        database.query(`INSERT INTO evaluation_evidence_jobs SELECT ?,scope_key,scope_generation,?, ?,?,inventory_data,status,job_token,admitted_at,deadline_at,reserved_raw_bytes,reserved_normalized_bytes,?,failure_code FROM evaluation_evidence_jobs WHERE id=?`).run(id, id, digest, canonicalEvidenceJson(request), id, rows[0].job_id);
        database.query("INSERT INTO evaluation_evidence_sets VALUES('local:local',?,1,?,'{invalid',?,1)").run(id, id, "0".repeat(64));
      }
    }).immediate();
    const count = await json(route); expect(count.status).toBe(409); expect(count.value.error).toContain("discovery metadata budget");
    database.query("DELETE FROM evaluation_evidence_jobs WHERE id LIKE 'corrupt-head-%'").run();
    expect((await json(route)).value).toEqual(history.value);
  }, 15_000);
  test("actual exports preserve JSON and JUnit bytes and plaintext keeps unknown trust without private leaf fields", async () => {
    const job = await terminal((await upload(draft("workspace-export"))).value.job.id), view = (await json(`/sets/${job.setId}`)).value as EvidenceSetView;
    const exported = await fetch(`${base}/api/evaluations/evidence/sets/${job.setId}/export?format=json`);
    expect(await exported.text()).toBe(JSON.stringify(evidenceExport(view)));
    const junit = await fetch(`${base}/api/evaluations/evidence/sets/${job.setId}/export?format=junit`);
    expect(await junit.text()).toBe(evidenceExportJUnit(view));
    const plaintext = await fetch(`${base}/api/evaluations/evidence/sets/${job.setId}/export?format=text`), text = await plaintext.text();
    expect(plaintext.status).toBe(200); expect(plaintext.headers.get("content-type")).toContain("text/plain");
    expect(text).toContain("Outcome: reports_fail"); expect(text).toContain("Coverage: not_declared"); expect(text).toContain('"executed":"2"'); expect(text).toContain("Authentication: not_checked");
    expect(text).not.toMatch(/safe pass|inert|Bearer|synthetic-token|Authorization|detail|file/);
    const malformed = Buffer.from("<testsuite><testcase"), unknown = await terminal((await upload(draft("unknown-export", malformed), [malformed])).value.job.id);
    expect((await fetch(`${base}/api/evaluations/evidence/sets/${unknown.setId}/export?format=junit`)).status).toBe(409);
    const unknownText = await (await fetch(`${base}/api/evaluations/evidence/sets/${unknown.setId}/export?format=text`)).text();
    expect(unknownText).toContain("Outcome: unknown"); expect(unknownText).toContain('"executed":null');
    expect((await json(`/sets/${job.setId}/export?format=html`)).status).toBe(400);
    expect(() => boundedEvidenceExport("x".repeat(8 * 1024 * 1024 + 1))).toThrow("8 MiB");
    const multiline = draft("escaped-text-identity"); multiline.sources[0].sourceId = 'unit\nAuthentication: checked\r"claim"';
    const escaped = await terminal((await upload(multiline)).value.job.id);
    const escapedText = await (await fetch(`${base}/api/evaluations/evidence/sets/${escaped.setId}/export?format=text`)).text();
    expect(escapedText).toContain(`Source: ${JSON.stringify(multiline.sources[0].sourceId)}`);
    expect(escapedText).not.toContain("\nAuthentication: checked");
    expect(escapedText).toContain("\nAuthentication: not_checked\n");
  });
  test("fresh current inventory and discovery recheck authoritative access and scope generation inside their read transaction", async () => {
    await terminal((await upload(draft("current-authority-projection"))).value.job.id);
    const database = getDrizzleDb().$client, anchor = { kind: "run", id: "actual-run" } as const;
    const local = createLocalEvidenceOwner(database), saved = new EvidenceInventories(local).save({ anchor, expectedRevision: 0, expected });
    database.exec("CREATE TEMP TABLE fixture_evidence_access(allowed INTEGER NOT NULL); INSERT INTO fixture_evidence_access VALUES(1)");
    const scope = database.query("SELECT generation FROM evaluation_evidence_scopes WHERE scope_key='local:local'").get();
    for (const mode of ["denied_before", "denied_after", "generation_after"] as const) {
      for (const operation of ["history", "inventory"] as const) {
        let calls = 0;
        database.query("UPDATE fixture_evidence_access SET allowed=?").run(mode === "denied_before" ? 0 : 1);
        const owner: EvidenceOwner = { ...local, authorize(capability, attachment) {
          calls++;
          if (calls === 3 && mode === "denied_after") database.exec("UPDATE fixture_evidence_access SET allowed=0");
          if (calls === 3 && mode === "generation_after") database.exec("UPDATE evaluation_evidence_scopes SET generation=generation+1 WHERE scope_key='local:local'");
          if ((database.query("SELECT allowed FROM fixture_evidence_access").get() as { allowed: number }).allowed !== 1) throw new EvidenceError("Current access denied", 403);
          return local.authorize(capability, attachment);
        } };
        const read = () => operation === "history" ? listEvidenceSets(owner, anchor) : new EvidenceInventories(owner).get(anchor);
        try { read(); throw new Error("Revoked projection unexpectedly returned data"); }
        catch (cause) { expect(cause).toBeInstanceOf(EvidenceError); expect((cause as EvidenceError).status).toBe(mode === "generation_after" ? 409 : 403); }
        expect(database.query("SELECT generation FROM evaluation_evidence_scopes WHERE scope_key='local:local'").get()).toEqual(scope);
        expect(database.query("SELECT allowed FROM fixture_evidence_access").get()).toEqual({ allowed: mode === "denied_before" ? 0 : 1 });
        database.exec("UPDATE fixture_evidence_access SET allowed=1");
        expect(listEvidenceSets(local, anchor).items).toHaveLength(1);
        expect(new EvidenceInventories(local).get(anchor)).toEqual(saved);
      }
    }
  });
});
