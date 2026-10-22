import { EVIDENCE_WORKER_FAILURE, finishEvidenceWorkerEnvironment, prepareEvidenceWorkerEnvironment } from "./evidence-worker-environment";
import type { NormalizedEvidenceSource } from "./evidence-protocol";
import type { ReaderLimits } from "./evidence-reader/limits";

// Stay below Bun's 4 KiB cache threshold for early refusal.
if (import.meta.main && !prepareEvidenceWorkerEnvironment()) {
  await Bun.write(Bun.stdout, EVIDENCE_WORKER_FAILURE);
  process.exit(1);
}
const [{ EVIDENCE_LIMITS: L }, { evidenceText }, { parseExternalEvidence }, { strictEvidenceJson }, { readerLimits }] = await Promise.all([
  import("./evidence-protocol"), import("./evidence-validation"), import("./external-evidence"),
  import("./evidence-reader/json"), import("./evidence-reader/limits"),
]);

export const EVIDENCE_WORKER_ENTRY = "__runphantom_evidence_worker_v1";
export const EVIDENCE_WORKER_INPUT_BYTES = Math.ceil(L.MAX_SOURCE_BYTES / 3) * 4 + 4096;
export const EVIDENCE_WORKER_OUTPUT_BYTES = L.MAX_NORMALIZED_BYTES + 4096;
export interface EvidenceWorkerRequest { version: 1; id: string; sourceId: string; dialect: string; limits: ReaderLimits; bytes: string }
export type EvidenceWorkerResponse = { version: 1; id: string; normalized: NormalizedEvidenceSource } |
  { version: 1; id: null; error: "protocol_invalid" };

export async function readBoundedStream(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > max) { await reader.cancel(); throw new Error("worker_stream_limit"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return bytes;
}
function decodeRequest(input: Uint8Array): EvidenceWorkerRequest {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(input), raw = strictEvidenceJson(text, readerLimits());
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("protocol_invalid");
  const request = raw as Record<string, unknown>;
  if (Object.keys(request).length !== 6 || Object.keys(request).some(key => !["version", "id", "sourceId", "dialect", "limits", "bytes"].includes(key)) || request.version !== 1) throw new Error("protocol_invalid");
  const limits = readerLimits(request.limits as Partial<ReaderLimits>);
  const id = evidenceText(request.id, "worker request ID"), sourceId = evidenceText(request.sourceId, "source ID"), dialect = evidenceText(request.dialect, "dialect");
  if (typeof request.bytes !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.bytes) || request.bytes.length > Math.ceil(limits.maxSourceBytes / 3) * 4) throw new Error("protocol_invalid");
  return { version: 1, id, sourceId, dialect, limits, bytes: request.bytes };
}

export async function runEvidenceWorker(): Promise<number> {
  try {
    if (!prepareEvidenceWorkerEnvironment() || !finishEvidenceWorkerEnvironment()) throw new Error("protocol_invalid");
    const request = decodeRequest(await readBoundedStream(Bun.stdin.stream(), EVIDENCE_WORKER_INPUT_BYTES));
    const bytes = Buffer.from(request.bytes, "base64");
    if (bytes.byteLength > request.limits.maxSourceBytes || bytes.toString("base64") !== request.bytes) throw new Error("protocol_invalid");
    const response: EvidenceWorkerResponse = { version: 1, id: request.id, normalized: parseExternalEvidence(bytes, request.dialect, request.sourceId, request.limits) };
    const output = JSON.stringify(response);
    if (Buffer.byteLength(output) > EVIDENCE_WORKER_OUTPUT_BYTES) throw new Error("protocol_invalid");
    await Bun.write(Bun.stdout, output);
    return 0;
  } catch {
    await Bun.write(Bun.stdout, EVIDENCE_WORKER_FAILURE);
    return 1;
  }
}

if (import.meta.main) process.exit(await runEvidenceWorker());
