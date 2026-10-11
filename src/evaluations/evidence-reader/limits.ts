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
const NativeBytes = Uint8Array;
const bytePrototype = Object.getPrototypeOf(NativeBytes.prototype);
const byteLengthGetter = Object.getOwnPropertyDescriptor(bytePrototype, "byteLength")!.get!;
const byteTypeGetter = Object.getOwnPropertyDescriptor(bytePrototype, Symbol.toStringTag)!.get!;
const byteSet = Object.getOwnPropertyDescriptor(bytePrototype, "set")!.value;

/** Read internal slots and copy without caller properties, species or Buffer view semantics. */
export function snapshotEvidenceBytes(value: unknown, sourceLimit: number, remainingBytes: number): Uint8Array {
  let length: number;
  try {
    length = byteLengthGetter.call(value);
    if (byteTypeGetter.call(value) !== "Uint8Array") throw new Error("Not an octet array");
  } catch { throw new ReaderRefusal("source_rejected"); }
  if (!Number.isSafeInteger(sourceLimit) || sourceLimit < 1 || sourceLimit > EVIDENCE_LIMITS.MAX_SOURCE_BYTES ||
    !Number.isSafeInteger(remainingBytes) || remainingBytes < 0 || remainingBytes > EVIDENCE_LIMITS.MAX_IMPORT_BYTES ||
    length > sourceLimit || length > remainingBytes) throw new ReaderRefusal("source_limit");
  try {
    const bytes = new NativeBytes(length);
    byteSet.call(bytes, value);
    return bytes;
  } catch { throw new ReaderRefusal("source_rejected"); }
}
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
  const snapshot = snapshotEvidenceBytes(bytes, limits.maxSourceBytes, limits.maxSourceBytes);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(snapshot); }
  catch { throw new ReaderRefusal("unsafe_encoding"); }
}
