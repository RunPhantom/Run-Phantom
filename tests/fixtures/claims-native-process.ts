import { once } from "node:events";
import { closeDb, getDrizzleDb } from "../../src/db";
import { createServer } from "../../src/server";
import { createLocalEvidenceOwner } from "../../src/evaluations/evidence-inventory";
import { EVIDENCE_IMPORT_CONTENT_TYPE, EVIDENCE_READER_IDENTITY } from "../../src/evaluations/evidence-import";
import { evidenceDigest } from "../../src/evaluations/evidence-validation";

const { server } = await createServer(0); server.listen(0, "127.0.0.1"); await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`, db = getDrizzleDb().$client;
const attachment = { kind: "run", id: "observer-run" }, endpoint = "/api/evaluations/claims/reports", query = new URLSearchParams({ attachment: JSON.stringify(attachment) });
async function send(route: string, value: unknown, method = "POST") { return fetch(base + route, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }); }
const proof: Record<string, unknown> = { pid: process.pid, history: db.query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all() };
try {
  if (process.argv[2] === "write") {
    const bytes = Buffer.from('<testsuite tests="1"><testcase name="source"><system-out>SOURCE_BYTES_NOT_COPIED</system-out></testcase></testsuite>');
    const request = { ...EVIDENCE_READER_IDENTITY, operationKey: "native-import", attachment, target: null, inventory: null, retention: "raw_and_normalized", sources: [{ sourceId: "unit", kind: "junit", dialect: "junit-xml/v1", shardId: null, artifactSha256: evidenceDigest(bytes), byteLength: bytes.length }] };
    const metadata = Buffer.from(JSON.stringify({ version: 1, request })), length = Buffer.alloc(4); length.writeUInt32BE(metadata.length);
    const imported = await fetch(base + "/api/evaluations/evidence/imports", { method: "POST", headers: { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE }, body: Buffer.concat([length, metadata, bytes]) });
    if (imported.status !== 202) throw Error("Native import refused"); const jobId = (await imported.json()).job.id;
    let setId = ""; const deadline = performance.now() + 5000;
    while (performance.now() < deadline) { const job = (await (await fetch(base + `/api/evaluations/evidence/imports/${jobId}`)).json()).job; if (job.status === "completed") { setId = job.setId; break; } if (job.status === "failed") throw Error("Native reader failed"); await new Promise(resolve => setTimeout(resolve, 10)); }
    if (!setId) throw Error("Native reader deadline");
    const created = await send(endpoint, { enabled: true, operationKey: "native-observer", attachment, setId, revision: 1, summary: "Original α summary.\nNot all tests pass.", assertions: [{ text: "All tests pass.", reference: { setId, revision: 1, sourceId: "unit" } }] });
    if (created.status !== 201) throw Error(`Native creation refused ${created.status}`); proof.saved = await created.json();
    if ((db.query("SELECT data FROM evaluation_completion_payloads").get() as { data: string }).data.includes("SOURCE_BYTES_NOT_COPIED")) throw Error("Source bytes copied");
  } else {
    const row = db.query("SELECT id,set_id FROM evaluation_completion_reports").get() as { id: string; set_id: string };
    const read = await fetch(`${base}${endpoint}/${row.id}?${query}`); if (read.status !== 200) throw Error("Historical read unavailable"); const saved = await read.json(); proof.saved = saved;
    try { db.exec("UPDATE evaluation_completion_payloads SET data='changed'"); proof.immutableRefused = false; } catch { proof.immutableRefused = true; }
    proof.oversizeStatus = (await send(endpoint, { ...saved.request, operationKey: "native-oversize", summary: "α".repeat(8193) })).status;
    proof.wrongRevisionStatus = (await send(endpoint, { ...saved.request, operationKey: "native-wrong-revision", revision: 2 })).status;
    proof.normalizedDeleteStatus = (await send(`/api/evaluations/evidence/sets/${row.set_id}/retention/normalized?revision=1`, {}, "DELETE")).status;
    proof.deletedReadStatus = (await fetch(`${base}${endpoint}/${row.id}?${query}`)).status;
    proof.tombstone = await (await fetch(`${base}${endpoint}?${query}&offset=0`)).json(); proof.livePayloads = db.query("SELECT data FROM evaluation_completion_payloads").all();
    createLocalEvidenceOwner(db).store.purgeScope(); proof.afterClear = db.query("SELECT * FROM evaluation_completion_reports").all();
  }
  proof.foreignKeys = db.query("PRAGMA foreign_key_check").all(); console.log(JSON.stringify(proof));
} finally { await new Promise<void>(resolve => server.close(() => resolve())); closeDb(); }
