import type { EvidenceAttachment, EvidenceDialect, EvidenceImportRequest, EvidenceInventoryRevision, EvidenceKind, EvidenceRetention } from "../../../../src/evaluations/evidence-protocol";

export interface EvidenceCapabilities {
  reader: Pick<EvidenceImportRequest, "parserVersion" | "policyVersion" | "configurationSha256">;
  transport: { version: number; contentType: string; maxHeaderBytes: number; maxFrameBytes: number };
  dialects: EvidenceDialect[];
  limits: { MAX_REPORTS: number; MAX_SOURCE_BYTES: number; MAX_IMPORT_BYTES: number };
}
export interface EvidenceFileDraft { file: File; sourceId: string; dialect: EvidenceDialect; shardId: string }
const kinds: Record<EvidenceDialect, EvidenceKind> = { "junit-xml/v1": "junit", "in-toto-statement/v1": "attestation", "dsse-envelope/v1": "attestation", "dsse-envelope-jsonl/v1": "jsonl" };

export function checkEvidenceFiles(files: readonly File[], capabilities: EvidenceCapabilities): void {
  if (!files.length || files.length > Math.min(32, capabilities.limits.MAX_REPORTS)) throw new Error("Choose between 1 and 32 report files.");
  let total = 0;
  for (const file of files) {
    if (file.size > Math.min(2 * 1024 * 1024, capabilities.limits.MAX_SOURCE_BYTES)) throw new Error("Each report must be at most 2 MiB.");
    total += file.size;
  }
  if (total > Math.min(8 * 1024 * 1024, capabilities.limits.MAX_IMPORT_BYTES)) throw new Error("The selected reports exceed 8 MiB in total.");
}
function cancelled(signal?: AbortSignal): void { signal?.throwIfAborted(); }
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");

/** Validate the entire selection before reading; no filenames or server paths enter the transport. */
export async function prepareEvidenceUpload(drafts: readonly EvidenceFileDraft[], capabilities: EvidenceCapabilities,
  options: { attachment: EvidenceAttachment; inventory: Pick<EvidenceInventoryRevision, "id" | "revision"> | null; retention: EvidenceRetention; operationKey: string; signal?: AbortSignal }): Promise<{ body: Blob; request: EvidenceImportRequest }> {
  checkEvidenceFiles(drafts.map(draft => draft.file), capabilities);
  if (capabilities.transport.version !== 1 || capabilities.transport.contentType !== "application/vnd.runphantom.evidence-import.v1+octet-stream") throw new Error("This daemon does not support the report upload transport.");
  const ids = new Set<string>();
  for (const draft of drafts) {
    if (!capabilities.dialects.includes(draft.dialect) || !Object.prototype.hasOwnProperty.call(kinds, draft.dialect)) throw new Error("Choose a supported report format.");
    if (!draft.sourceId || draft.sourceId.length > 128 || ids.has(draft.sourceId) || draft.shardId.length > 128) throw new Error("Source identities must be distinct and at most 128 characters.");
    ids.add(draft.sourceId);
  }
  const bytes: ArrayBuffer[] = [], sources: EvidenceImportRequest["sources"] = [];
  for (const draft of drafts) {
    cancelled(options.signal);
    const buffer = await draft.file.arrayBuffer();
    cancelled(options.signal);
    if (buffer.byteLength !== draft.file.size) throw new Error("A selected report changed while being read.");
    const digest = hex(await crypto.subtle.digest("SHA-256", buffer));
    cancelled(options.signal);
    bytes.push(buffer);
    sources.push({ sourceId: draft.sourceId, kind: kinds[draft.dialect], dialect: draft.dialect, shardId: draft.shardId.trim() || null, artifactSha256: digest, byteLength: buffer.byteLength });
  }
  const request: EvidenceImportRequest = { ...capabilities.reader, operationKey: options.operationKey, attachment: options.attachment, inventory: options.inventory, retention: options.retention, target: null, sources };
  const metadata = new TextEncoder().encode(JSON.stringify({ version: 1, request }));
  if (metadata.byteLength > Math.min(64 * 1024, capabilities.transport.maxHeaderBytes)) throw new Error("Report metadata exceeds 64 KiB.");
  const prefix = new ArrayBuffer(4); new DataView(prefix).setUint32(0, metadata.byteLength, false);
  const body = new Blob([prefix, metadata, ...bytes], { type: capabilities.transport.contentType });
  if (body.size > capabilities.transport.maxFrameBytes) throw new Error("The report frame exceeds this daemon's limit.");
  return { body, request };
}
