export const ELECTRON_CHANNEL = "runphantom:cooperating-electron:v1";
export const ELECTRON_LIMITS = { requestMs: 5000, selector: 1024, text: 4096, calls: 1000, frameBytes: 16384 } as const;
export type ElectronFailure = "INVALID_REQUEST" | "STALE_DOCUMENT" | "CLOSED" | "BUSY" | "TIMEOUT" | "UNAVAILABLE"
  | "TARGET_MISSING" | "TARGET_AMBIGUOUS" | "PRIVATE_TARGET" | "UNSUPPORTED_TARGET" | "CAPTURE_FAILED";
export type ElectronOperation = { type: "read" | "click"; selector: string };
export interface ElectronRequest { token: string; id: number; generation: number; operation: ElectronOperation }
export type ElectronReply = { token: string; id: number; generation: number; ok: false; code: ElectronFailure }
  | { token: string; id: number; generation: number; ok: true; result: { count: number; text: string } | { dispatched: true } };
export class ElectronVerificationError extends Error {
  constructor(readonly code: ElectronFailure) { super(`Cooperating Electron verification: ${code}`); }
}
export function dataObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ElectronVerificationError("INVALID_REQUEST");
  const object = value as Record<string, unknown>, prototype = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null) throw new ElectronVerificationError("INVALID_REQUEST");
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key !== "string" || !keys.includes(key) || !("value" in Object.getOwnPropertyDescriptor(object, key)!)) throw new ElectronVerificationError("INVALID_REQUEST");
  }
  return object;
}
export function parseElectronRequest(value: unknown): ElectronRequest {
  const body = dataObject(value, ["token", "id", "generation", "operation"]);
  if (typeof body.token !== "string" || !/^[a-f0-9]{64}$/.test(body.token) || !Number.isSafeInteger(body.id) || (body.id as number) < 1
    || !Number.isSafeInteger(body.generation) || (body.generation as number) < 1) throw new ElectronVerificationError("INVALID_REQUEST");
  const op = dataObject(body.operation, ["type", "selector"]);
  if (!["read", "click"].includes(op.type as string) || typeof op.selector !== "string" || !op.selector.trim()
    || op.selector.length > ELECTRON_LIMITS.selector || op.selector.includes("\0")) throw new ElectronVerificationError("INVALID_REQUEST");
  const request = { token: body.token, id: body.id as number, generation: body.generation as number, operation: op as unknown as ElectronOperation };
  if (new TextEncoder().encode(JSON.stringify(request)).length > ELECTRON_LIMITS.frameBytes) throw new ElectronVerificationError("INVALID_REQUEST");
  return request;
}
