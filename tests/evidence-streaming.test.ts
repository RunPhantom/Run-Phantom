import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, request as httpRequest, type Server } from "node:http";
import { EVIDENCE_FRAME_BYTES, EVIDENCE_HEADER_BYTES, EVIDENCE_IMPORT_CONTENT_TYPE, EvidenceUploadError, readEvidenceImportFrame } from "../src/evaluations/evidence-import";
import { EVIDENCE_LIMITS, EvidenceError, type EvidenceImportRequest } from "../src/evaluations/evidence-protocol";
import { evidenceDigest } from "../src/evaluations/evidence-validation";

const raw = Buffer.from('<testsuite tests="1"><testcase name="actual streamed leaf"/></testsuite>');
function draft(): EvidenceImportRequest {
  return { operationKey: "streamed", attachment: { kind: "run", id: "actual-run" }, target: null, inventory: null,
    sources: [{ sourceId: "unit", kind: "junit", dialect: "junit-xml/v1", shardId: "unit", artifactSha256: evidenceDigest(raw), byteLength: raw.byteLength }],
    parserVersion: "strict-1", policyVersion: "redaction-1", configurationSha256: evidenceDigest("test-config"), retention: "normalized_only" };
}
function frame(request = draft(), metadata = Buffer.from(JSON.stringify({ version: 1, request }))) {
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(metadata.byteLength);
  return Buffer.concat([prefix, metadata, raw]);
}
let server: Server, port: number, admissions: number, deadlineMs: number, deny: boolean;
let outcomes: { code: string; raw?: string; acquiredBytes?: number }[];
let finished: Promise<void>, finish: () => void;
beforeEach(async () => {
  admissions = 0; deadlineMs = 1_000; deny = false; outcomes = [];
  finished = new Promise(resolve => { finish = resolve; });
  server = createServer(async (req, res) => {
    try {
      const captured = await readEvidenceImportFrame(req, () => { admissions++; if (deny) throw new EvidenceError("Current attachment denied", 403); return "authorized"; }, { deadlineAt: performance.now() + deadlineMs });
      outcomes.push({ code: "captured", raw: Buffer.from(captured.sources[0].bytes).toString(), acquiredBytes: captured.acquiredBytes });
      res.end(JSON.stringify({ authorized: captured.admission, sha256: evidenceDigest(captured.sources[0].bytes) }));
    } catch (error) {
      outcomes.push({ code: error instanceof EvidenceUploadError ? error.code : error instanceof EvidenceError ? error.message : "unexpected" });
      res.setHeader("Connection", "close"); res.statusCode = error instanceof EvidenceError ? error.status : 500;
      res.end("refused");
    } finally { finish(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
function send(chunks: Buffer[], headers: Record<string, string> = {}, delayMs = 0): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const client = httpRequest({ host: "127.0.0.1", port, path: "/actual-stream", method: "POST", headers: { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE, ...headers } }, response => {
      let body = ""; response.on("data", chunk => { body += chunk.toString(); }); response.on("end", () => resolve({ status: response.statusCode!, body }));
    });
    client.on("error", reject);
    void (async () => {
      for (const chunk of chunks) {
        if (client.destroyed) return;
        client.write(chunk); if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      client.end();
    })();
  });
}
describe("actual HTTP evidence frame acquisition", () => {
  test("chunked prefix, metadata and source boundaries preserve exact raw bytes after authority", async () => {
    const bytes = frame(), chunks: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; offset += 7) chunks.push(bytes.subarray(offset, offset + 7));
    const response = await send(chunks);
    expect(response.status).toBe(200); expect(JSON.parse(response.body)).toEqual({ authorized: "authorized", sha256: evidenceDigest(raw) });
    expect(admissions).toBe(1); expect(outcomes).toEqual([{ code: "captured", raw: raw.toString(), acquiredBytes: bytes.byteLength }]);
  });
  test("declared HTTP length is only a hint and cannot replace the exact frame length", async () => {
    const bytes = frame();
    const response = await send([bytes], { "Content-Length": String(bytes.length + 1) });
    expect(response.status).toBe(400); expect(outcomes[0].code).toBe("source_integrity"); expect(admissions).toBe(0);
  });
  test("enormous header and HTTP length refuse before metadata authority or source allocation", async () => {
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(EVIDENCE_HEADER_BYTES + 1);
    expect((await send([prefix])).status).toBe(413); expect(admissions).toBe(0);
    expect((await send([], { "Content-Length": String(EVIDENCE_FRAME_BYTES + 1) })).status).toBe(413); expect(admissions).toBe(0);
  });
  test("strict metadata rejects duplicate keys, unknown versions and oversized source declarations", async () => {
    const duplicate = Buffer.from('{"version":1,"version":1,"request":{}}');
    expect((await send([frame(draft(), duplicate)])).status).toBe(400);
    const unsupported = frame(draft(), Buffer.from(JSON.stringify({ version: 2, request: draft() })));
    expect((await send([unsupported])).status).toBe(400);
    const oversized = draft(); oversized.sources[0].byteLength = EVIDENCE_LIMITS.MAX_SOURCE_BYTES + 1;
    expect((await send([frame(oversized)])).status).toBe(400); expect(admissions).toBe(0);
  });
  test("wrong digest, short source and trailing chunk cannot be accepted despite a valid descriptor", async () => {
    const bytes = frame(), wrong = Buffer.from(bytes); wrong[wrong.length - 1] ^= 1;
    for (const body of [wrong, bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.from("extra")])]) {
      expect((await send([body])).status).toBeGreaterThanOrEqual(400);
    }
    expect(outcomes.map(value => value.code)).toEqual(["source_integrity", "source_integrity", "source_integrity"]);
    expect(admissions).toBe(3);
  });
  test("fixed deadline includes slow metadata and never resets when a new chunk arrives", async () => {
    deadlineMs = 35;
    const bytes = frame(); const response = await send([bytes.subarray(0, 1), bytes.subarray(1, 2), bytes.subarray(2)], {}, 25);
    expect(response.status).toBe(409); expect(outcomes[0].code).toBe("upload_timeout"); expect(admissions).toBe(0);
  });
  test("client abort after admitted metadata exposes interruption and retains no completed source", async () => {
    const bytes = frame(), metadataEnd = 4 + bytes.readUInt32BE(0);
    const client = httpRequest({ host: "127.0.0.1", port, method: "POST", headers: { "Content-Type": EVIDENCE_IMPORT_CONTENT_TYPE } });
    client.on("error", () => {}); client.write(bytes.subarray(0, metadataEnd + 1));
    await new Promise(resolve => setTimeout(resolve, 20)); client.destroy(); await finished;
    expect(admissions).toBe(1); expect(outcomes).toEqual([{ code: "upload_aborted" }]);
  });
  test("authority rejection and compressed or JSON transports cannot acquire raw evidence", async () => {
    deny = true; expect((await send([frame()])).status).toBe(403); expect(outcomes[0].code).toBe("Current attachment denied");
    expect((await send([frame()], { "Content-Encoding": "gzip" })).status).toBe(400);
    expect((await send([frame()], { "Content-Type": "application/json" })).status).toBe(400);
    expect(admissions).toBe(1); expect(outcomes.every(value => value.raw === undefined)).toBe(true);
  });
});
