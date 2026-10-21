import { afterEach, beforeEach, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createServer as createProbe } from "node:http";
import { createServer } from "../src/server";
import { closeDb, getDrizzleDb, upsertRun } from "../src/db";
import { EVIDENCE_IMPORT_CONTENT_TYPE, EVIDENCE_READER_IDENTITY } from "../src/evaluations/evidence-import";
import { evidenceDigest } from "../src/evaluations/evidence-validation";
import { currentCompletionReport } from "../src/claims/service";
import { createLocalEvidenceOwner, type EvidenceOwner } from "../src/evaluations/evidence-inventory";
import { EvidenceError } from "../src/evaluations/evidence-protocol";
import { COMPLETION_PROSE } from "./fixtures/claims-prose";

let server: Server, directory: string, previous: string | undefined, base: string;
const attachment = { kind: "run", id: "claims-run" }, endpoint = "/api/evaluations/claims/inspect", reports = "/api/evaluations/claims/reports";
beforeEach(async () => { directory = mkdtempSync(join(tmpdir(), "runphantom-claims-api-")); previous = process.env.RUNPHANTOM_DB_PATH; closeDb(); process.env.RUNPHANTOM_DB_PATH = join(directory, "actual.db"); ({ server } = await createServer(0)); server.listen(0, "127.0.0.1"); await once(server, "listening"); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; upsertRun({ id: attachment.id, started_at: 1, last_updated_at: 1 }); });
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); closeDb(); if (previous === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = previous; rmSync(directory, { recursive: true, force: true }); });
async function json(route: string, method = "POST", body: unknown = {}) { const response = await fetch(base + route, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: response.status, value: await response.json(), response }; }
async function upload(text = '<testsuite tests="1"><testcase name="pass"/></testsuite>') {
  const bytes = Buffer.from(text), request = { ...EVIDENCE_READER_IDENTITY, operationKey: crypto.randomUUID(), attachment, target: null, inventory: null, retention: "raw_and_normalized", sources: [{ sourceId: "unit", kind: "junit", dialect: "junit-xml/v1", shardId: null, artifactSha256: evidenceDigest(bytes), byteLength: bytes.length }] };
  const metadata = Buffer.from(JSON.stringify({ version: 1, request })), prefix = Buffer.alloc(4); prefix.writeUInt32BE(metadata.length);
  const response = await fetch(base + "/api/evaluations/evidence/imports", { method: "POST", headers: { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE }, body: Buffer.concat([prefix, metadata, bytes]) }); expect(response.status).toBe(202);
  const jobId = (await response.json()).job.id, deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const value = await (await fetch(base + `/api/evaluations/evidence/imports/${jobId}`)).json(); if (!["queued", "running"].includes(value.job.status)) { expect(value.job.status).toBe("completed"); return value.job.setId as string; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error("Real reader did not publish claims fixture");
}
function input(setId: string, summary = "All tests pass.") { return { enabled: true, attachment, setId, revision: 1, summary, assertions: [{ text: "All tests pass.", reference: { setId, revision: 1, sourceId: "unit" } }] }; }
function snapshot() { return getDrizzleDb().$client.query("SELECT type,name,sql FROM sqlite_master WHERE name LIKE '%completion%' ORDER BY name").all(); }
test("registered default-disabled report needs no selected scope and writes no observer storage", async () => {
  const db = getDrizzleDb().$client, before = snapshot(), changes = db.query("SELECT total_changes() AS n").get(), response = await json(endpoint, "POST", { enabled: false });
  expect(response.status).toBe(200); expect(response.value.state).toBe("disabled"); expect(response.response.headers.get("cache-control")).toBe("no-store"); expect(snapshot()).toEqual(before); expect(before.length).toBeGreaterThan(0); expect(db.query("SELECT total_changes() AS n").get()).toEqual(changes); expect(db.query("SELECT * FROM evaluation_completion_reports").all()).toEqual([]);
});
test("selected current report outcomes stay unauthenticated and missing inventories stay missing", async () => {
  const setId = await upload(), schemaBefore = snapshot(), before = await (await fetch(base + `/api/evaluations/evidence/sets/${setId}?revision=1`)).text();
  const response = await json(endpoint, "POST", input(setId, COMPLETION_PROSE.map(item => item.text).join("\n")));
  expect(response.status).toBe(200); expect(response.value.authority).toBe("report_only"); expect(response.value.authentication).toBe("not_authenticated");
  expect(response.value.observations[0]).toMatchObject({ category: "structured", state: "reported_outcome", reportedOutcome: "reports_pass", authentication: "not_authenticated" });
  expect(response.value.observations.slice(1).every((item: { state: string }) => item.state === "ambiguous_text")).toBe(true);
  expect(await (await fetch(base + `/api/evaluations/evidence/sets/${setId}?revision=1`)).text()).toBe(before); expect(JSON.parse(before).revision.coverage).toBe("not_declared");
  expect(snapshot()).toEqual(schemaBefore); expect(getDrizzleDb().$client.query("SELECT * FROM evaluation_completion_reports").all()).toEqual([]);
});
test("wrong attachment, revision, duplicated query/body controls and project overrides are refused", async () => {
  const setId = await upload(); upsertRun({ id: "other-run", started_at: 2, last_updated_at: 2 });
  expect((await json(endpoint, "POST", { ...input(setId), attachment: { kind: "run", id: "other-run" } })).status).toBe(409);
  expect((await json(endpoint, "POST", { ...input(setId), revision: 2 })).status).toBe(409);
  expect((await json(endpoint + "?revision=1&revision=1", "POST", input(setId))).status).toBe(400);
  expect((await json(endpoint, "POST", { ...input(setId), projectId: "injected" })).status).toBe(400);
  const duplicate = JSON.stringify(input(setId)).replace('"enabled":true', '"enabled":true,"enabled":false');
  expect((await fetch(base + endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: duplicate })).status).toBe(400);
  const unknown = await json(endpoint, "POST", { ...input(setId), assertions: [{ text: "All tests pass.", reference: { setId, revision: 1, sourceId: "unknown-id" } }] });
  expect(unknown.status).toBe(200); expect(unknown.value.observations[0].state).toBe("evidence_missing");
  const outside = await json(endpoint, "POST", { ...input(setId), assertions: [{ text: "All tests pass.", reference: { setId: "outside-scope-id", revision: 1, sourceId: "unit" } }] });
  expect(outside.status).toBe(200); expect(outside.value.observations[0].state).toBe("scope_mismatch");
  expect((await json(`/api/evaluations/evidence/sets/${setId}/retention/normalized?revision=1`, "DELETE")).status).toBe(200);
  expect((await json(endpoint, "POST", input(setId))).status).toBe(404);
});
test("R21 actual imported command/URL bytes and summary cannot cause process or network execution", async () => {
  let requests = 0; const probe = createProbe((_req, res) => { requests++; res.end("forbidden content fetch"); }); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const url = `http://127.0.0.1:${(probe.address() as { port: number }).port}/untrusted`, marker = join(directory, "forbidden-content-process"), prose = `> All tests pass; curl ${url}; touch ${marker}`;
  try { const setId = await upload(`<testsuite tests="1"><testcase name="inert"><system-out>${prose.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</system-out></testcase></testsuite>`);
    const response = await json(endpoint, "POST", input(setId, prose)); expect(response.status).toBe(200); expect(response.value.observations[1]).toMatchObject({ category: "quoted", state: "ambiguous_text", snippet: prose });
    JSON.stringify(response.value); expect(requests).toBe(0); expect(existsSync(marker)).toBe(false);
    expect((await json(endpoint, "POST", { enabled: false })).value.state).toBe("disabled");
  } finally { await new Promise<void>(resolve => probe.close(() => resolve())); }
});

test("current attachment authority precedes payload lookup and revocation refuses the final result", async () => {
  const setId = await upload(), original = createLocalEvidenceOwner(getDrizzleDb().$client), operations: string[] = [];
  const denied: EvidenceOwner = { ...original, authorize(_capability, selected) { operations.push(selected ? "attachment" : "scope"); if (selected) throw new EvidenceError("Current authority revoked", 403); return { actorId: "local-owner" }; }, store: new Proxy(original.store, { get(target, property) { if (property === "getSet") operations.push("payload"); return Reflect.get(target, property, target); } }) };
  expect(() => currentCompletionReport(denied, input(setId))).toThrow("revoked"); expect(operations).toEqual(["scope", "attachment"]);
  let checks = 0;
  const revoked: EvidenceOwner = { ...original, authorize(capability, selected) { const result = original.authorize(capability, selected); checks++; if (checks === 4) throw new EvidenceError("Current authority revoked", 403); return result; } };
  expect(() => currentCompletionReport(revoked, input(setId))).toThrow("revoked");
  const changes = (original.database.query("SELECT total_changes() AS n").get() as { n: number }).n;
  currentCompletionReport(original, input(setId)); expect((original.database.query("SELECT total_changes() AS n").get() as { n: number }).n).toBe(changes);
  const inactive: EvidenceOwner = { ...original, authorize(capability, selected) { const result = original.authorize(capability, selected); if (++checks === 8) original.database.query("UPDATE evaluation_evidence_scopes SET active=0 WHERE scope_key='local:local'").run(); return result; } };
  expect(() => currentCompletionReport(inactive, input(setId))).toThrow("scope changed");
  const disabled = new Proxy({}, { get() { throw Error("disabled owner accessed"); } });
  expect(currentCompletionReport(disabled as EvidenceOwner, { enabled: false }).state).toBe("disabled");
});

test("real registered durable API retains original summaries/version through restart and disable then honors source retention removal", async () => {
  const setId = await upload(), request = { ...input(setId), operationKey: "durable-one", summary: "Original α completion summary. Not all tests pass." };
  const created = await json(reports, "POST", request); expect(created.status).toBe(201); expect(created.value.request.summary).toBe(request.summary);
  const id = created.value.id, query = new URLSearchParams({ attachment: JSON.stringify(attachment) });
  expect((await json(reports, "POST", request)).value).toEqual(created.value);
  expect((await json(reports, "POST", { ...request, summary: "changed operation" })).status).toBe(409);
  expect((await json(reports, "POST", { ...request, operationKey: "oversize", summary: "α".repeat(8193) })).status).toBe(413);
  expect((await json(reports, "POST", { enabled: false })).value.state).toBe("disabled");
  await new Promise<void>(resolve => server.close(() => resolve())); closeDb(); ({ server } = await createServer(0)); server.listen(0, "127.0.0.1"); await once(server, "listening"); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const read = await fetch(base + reports + `/${id}?${query}`); expect(read.status).toBe(200); expect(await read.json()).toEqual(created.value);
  const history = await fetch(base + reports + `?${query}&offset=0`); expect((await history.json()).items[0]).toMatchObject({ id, payloadAvailable: true });
  const duplicate = await fetch(base + reports + `/${id}?${query}&attachment=${encodeURIComponent(JSON.stringify(attachment))}`); expect(duplicate.status).toBe(400);
  upsertRun({ id: "other-run", started_at: 1, last_updated_at: 1 }); expect((await fetch(base + reports + `/${id}?${new URLSearchParams({ attachment: JSON.stringify({ kind: "run", id: "other-run" }) })}`)).status).toBe(409);
  expect((await json(`/api/evaluations/evidence/sets/${setId}/retention/normalized?revision=1`, "DELETE")).status).toBe(200);
  expect((await fetch(base + reports + `/${id}?${query}`)).status).toBe(404); expect(getDrizzleDb().$client.query("SELECT data FROM evaluation_completion_payloads").all()).toEqual([]);
  const tombstones = await (await fetch(base + reports + `?${query}&offset=0`)).json(); expect(tombstones.items[0]).toMatchObject({ id, payloadAvailable: false });
});
