import { expect, test } from "bun:test";
import { checkEvidenceFiles, prepareEvidenceUpload, type EvidenceCapabilities } from "../app/src/components/evaluations/evidence-upload";
import { EVIDENCE_LIMITS } from "../src/evaluations/evidence-protocol";
import { EVIDENCE_READER_IDENTITY, EVIDENCE_IMPORT_CONTENT_TYPE, EVIDENCE_FRAME_BYTES } from "../src/evaluations/evidence-import";
import { evidenceDigest, parseEvidenceImportRequest } from "../src/evaluations/evidence-validation";
const capabilities: EvidenceCapabilities = { reader: EVIDENCE_READER_IDENTITY, transport: { version: 1, contentType: EVIDENCE_IMPORT_CONTENT_TYPE, maxHeaderBytes: 65536, maxFrameBytes: EVIDENCE_FRAME_BYTES }, dialects: ["junit-xml/v1", "dsse-envelope-jsonl/v1"], limits: EVIDENCE_LIMITS };
async function refuses(promise: Promise<unknown>, message?: string) {
  let failure: unknown; try { await promise; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error); if (message) expect((failure as Error).message).toContain(message);
}
const options = { operationKey: "browser-operation", attachment: { kind: "run" as const, id: "real-run" }, inventory: null, retention: "normalized_only" as const };

test("browser frame preserves exact ordered bytes and hashes without transmitting filenames", async () => {
  const a = new File(['<testsuite><testcase name="one"/></testsuite>'], '<img src=x onerror=alert(1)>.xml'), b = new File(['{"opaque":"bytes"}'], "secret-path/report.jsonl");
  const result = await prepareEvidenceUpload([{ file: a, sourceId: "one", shardId: "unit", dialect: "junit-xml/v1" }, { file: b, sourceId: "two", shardId: "", dialect: "dsse-envelope-jsonl/v1" }], capabilities, options);
  const bytes = new Uint8Array(await result.body.arrayBuffer()), length = new DataView(bytes.buffer).getUint32(0, false), header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)));
  expect(parseEvidenceImportRequest(header.request)).toEqual(result.request);
  expect(header.version).toBe(1); expect(JSON.stringify(header)).not.toContain("secret-path"); expect(JSON.stringify(header)).not.toContain("<img");
  expect(bytes.subarray(4 + length)).toEqual(new Uint8Array(await new Blob([a, b]).arrayBuffer()));
  expect(result.request.sources[0].artifactSha256).toBe(evidenceDigest(new Uint8Array(await a.arrayBuffer())));
  expect(result.request.sources[1].shardId).toBeNull(); expect(result.request.retention).toBe("normalized_only");
});

test("all selection limits and format/identity refusals happen before any file read", async () => {
  const ordinary = new File(["a"], "ordinary.xml"); let reads = 0;
  ordinary.arrayBuffer = async () => { reads++; return new ArrayBuffer(1); };
  const large = new File([new Uint8Array(2 * 1024 * 1024 + 1)], "oversized.xml");
  const draft = { file: ordinary, sourceId: "one", shardId: "unit", dialect: "junit-xml/v1" as const };
  await refuses(prepareEvidenceUpload([draft, { ...draft, file: large, sourceId: "two" }], capabilities, options), "2 MiB");
  expect(() => checkEvidenceFiles(Array.from({ length: 33 }, () => ordinary), capabilities)).toThrow("32");
  expect(() => checkEvidenceFiles(Array.from({ length: 5 }, () => new File([new Uint8Array(2 * 1024 * 1024)], "bounded.xml")), capabilities)).toThrow("8 MiB");
  await refuses(prepareEvidenceUpload([draft, draft], capabilities, options), "distinct");
  await refuses(prepareEvidenceUpload([{ ...draft, dialect: "in-toto-statement/v1" }], capabilities, options), "supported");
  await refuses(prepareEvidenceUpload([{ ...draft, sourceId: "é".repeat(65) }], capabilities, options), "UTF-8");
  expect(reads).toBe(0);
});

test("aborted preparation performs no read and a cancelled read never builds an upload", async () => {
  const controller = new AbortController(); controller.abort(); let reads = 0;
  const file = new File(["one"], "one.xml"); file.arrayBuffer = async () => { reads++; return new ArrayBuffer(3); };
  const draft = { file, sourceId: "one", shardId: "unit", dialect: "junit-xml/v1" as const };
  await refuses(prepareEvidenceUpload([draft], capabilities, { ...options, signal: controller.signal })); expect(reads).toBe(0);
  const during = new AbortController(); file.arrayBuffer = async () => { during.abort(); return new ArrayBuffer(3); };
  await refuses(prepareEvidenceUpload([draft], capabilities, { ...options, signal: during.signal }));
});
