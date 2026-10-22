export const W0_LIMITS = Object.freeze({ descriptorBytes: 65536, payloadBytes: 32, childMs: 8000, nativeWaitMs: 600, acquisitionMs: 100, workerMs: 1500 });
export const FILE_ALL_ACCESS = 0x1f01ff;

export function checkedAddress(value: number | bigint | null): bigint {
  if (value === null || typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("invalid_native_address");
  const address = BigInt(value);
  if (address <= 0n || address > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid_native_address");
  return address;
}

export function checkedRange(base: bigint, length: number, address: bigint, bytes: number): void {
  if (!Number.isSafeInteger(length) || length <= 0 || length > W0_LIMITS.descriptorBytes || !Number.isSafeInteger(bytes) || bytes <= 0
    || address < base || address + BigInt(bytes) > base + BigInt(length)) throw new Error("native_range_outside_allocation");
}

export function sidText(bytes: Uint8Array): string {
  const b = Buffer.from(bytes);
  if (b.length < 8 || b[0] !== 1 || b[1] > 15 || b.length !== 8 + 4 * b[1]) throw new Error("invalid_sid_bytes");
  let authority = 0n;
  for (let i = 2; i < 8; i++) authority = authority * 256n + BigInt(b[i]);
  const subAuthorities = Array.from({ length: b[1] }, (_, i) => b.readUInt32LE(8 + i * 4));
  return ["S", b[0], authority, ...subAuthorities].join("-");
}

export interface AllowedAce { type: number; flags: number; mask: number; sid: Uint8Array }
export function ownerOnlyAcl(ownerMatches: boolean, present: boolean, nullDacl: boolean, protectedDacl: boolean, aces: AllowedAce[], ownerSid: Uint8Array, directory: boolean): boolean {
  return ownerMatches && present && !nullDacl && protectedDacl && aces.length === 1 && aces[0].type === 0
    && aces[0].flags === (directory ? 3 : 0) && aces[0].mask === FILE_ALL_ACCESS && Buffer.from(aces[0].sid).equals(Buffer.from(ownerSid));
}

export function securityAttributes(descriptor: bigint): Buffer {
  checkedAddress(descriptor);
  const bytes = Buffer.alloc(24);
  bytes.writeUInt32LE(24, 0);
  bytes.writeBigUInt64LE(descriptor, 8);
  bytes.writeInt32LE(0, 16);
  return bytes;
}

export function wide(value: string): Buffer {
  if (value.includes("\0") || Buffer.byteLength(value, "utf16le") > 8192) throw new Error("invalid_wide_input");
  return Buffer.from(value + "\0", "utf16le");
}

export function nativeSystemModuleMatches(actual: string, system: string, name: "kernel32.dll" | "advapi32.dll"): boolean {
  const normalized = (s: string) => s.replace(/^\\\\\?\\/, "").replaceAll("/", "\\").toLowerCase();
  return normalized(actual) === normalized(system.replace(/[\\/]$/, "") + "\\" + name);
}
