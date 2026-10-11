import { EVIDENCE_LIMITS, type EvidenceReason } from "../evidence-protocol";

export interface ReaderLimits {
  maxSourceBytes: number;
  maxLeaves: number;
  maxNormalizedBytes: number;
  maxDepth: number;
}
export const DEFAULT_READER_LIMITS: Readonly<ReaderLimits> = Object.freeze({
  maxSourceBytes: EVIDENCE_LIMITS.MAX_SOURCE_BYTES, maxLeaves: EVIDENCE_LIMITS.MAX_LEAVES,
  maxNormalizedBytes: EVIDENCE_LIMITS.MAX_NORMALIZED_BYTES, maxDepth: EVIDENCE_LIMITS.MAX_SUITE_DEPTH,
});
export function readerLimits(overrides: Partial<ReaderLimits> = {}): ReaderLimits {
  const result = { ...DEFAULT_READER_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in result) || !Number.isSafeInteger(value) || value! < 1 || value! > result[key as keyof ReaderLimits]) throw new TypeError("Reader limits can only narrow the fixed parser budget");
    result[key as keyof ReaderLimits] = value!;
  }
  return result;
}
export class ReaderRefusal extends Error {
  constructor(public readonly code: EvidenceReason, public readonly rejected = true) { super(code); }
}
export function decodeEvidence(bytes: Uint8Array, limits: ReaderLimits): string {
  if (bytes.byteLength > limits.maxSourceBytes) throw new ReaderRefusal("source_limit");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ReaderRefusal("unsafe_encoding"); }
}
