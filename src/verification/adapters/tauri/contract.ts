/** Host-registered, cooperating IPC. This is not native input automation. */
import { types } from "node:util";

export const TAURI_LIMITS = Object.freeze({ operationMs: 5000, pngBytes: 8 * 1024 * 1024, width: 1920, height: 1080, artifacts: 16, totalBytes: 32 * 1024 * 1024 });
export type TauriFailure = "unavailable" | "denied" | "cancelled" | "busy" | "closed" | "invalid-reply" | "deadline" | "capacity" | "cleanup-unconfirmed";
export class TauriError extends Error {
  constructor(readonly code: TauriFailure) { super(`Cooperating Tauri verification: ${code}`); this.name = "TauriError"; }
}
export interface TauriAuthority { application: string; window: string; nonce: string }
export type TauriOperation = { kind: "observe" } | { kind: "action"; action: string } | { kind: "capture"; mode: "private-raw"; consent: true } | { kind: "cancel" };
export type TauriRequest = TauriAuthority & TauriOperation & { version: 1; id: string; generation: number };
export interface TauriObservation { source: "cooperating-tauri"; value: number; sequence: number }
export type TauriReply = TauriAuthority & { version: 1; id: string; generation: number } & (
  { status: "ok"; observation: TauriObservation } | { status: "ok"; png: Uint8Array } | { status: "ok"; cancelled: true }
  | { status: "denied" | "unavailable" | "cancelled" }
);
export interface TauriTransport {
  exchange(request: TauriRequest, signal: AbortSignal): Promise<unknown>;
  /** Resolve true only after the owned process has actually exited. */
  close(): Promise<boolean>;
}
export function record(value: unknown): Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TauriError("invalid-reply");
    const snapshot: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new TauriError("invalid-reply");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TauriError("invalid-reply");
      Object.defineProperty(snapshot, key, { value: descriptor.value, enumerable: true, configurable: true, writable: true });
    }
    return snapshot;
  } catch { throw new TauriError("invalid-reply"); }
}
export function authority(value: unknown): Readonly<TauriAuthority> {
  const object = record(value);
  if (Object.keys(object).sort().join() !== "application,nonce,window" || typeof object.application !== "string" || !/^[a-z][a-z0-9.-]{0,95}$/.test(object.application)
    || typeof object.window !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(object.window) || typeof object.nonce !== "string" || !/^[0-9a-f]{64}$/.test(object.nonce)) throw new TauriError("denied");
  return Object.freeze({ application: object.application, window: object.window, nonce: object.nonce });
}
export function registeredActions(value: unknown): string[] {
  try {
    if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TauriError("denied");
    const descriptors = Object.getOwnPropertyDescriptors(value as object), length = descriptors.length.value as unknown;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > 16 || Reflect.ownKeys(descriptors).length !== length + 1) throw new TauriError("denied");
    const actions: string[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(descriptor.value)) throw new TauriError("denied");
      actions.push(descriptor.value);
    }
    return actions;
  } catch { throw new TauriError("denied"); }
}
/** Transport rejections are unknown values too; never inspect a Proxy or reuse its error. */
export function tauriError(value: unknown): TauriError {
  let code: TauriFailure = "unavailable";
  try {
    if (value && typeof value === "object" && !types.isProxy(value) && Object.getPrototypeOf(value) === TauriError.prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(value, "code");
      if (descriptor && Object.hasOwn(descriptor, "value") && ["unavailable", "denied", "cancelled", "busy", "closed", "invalid-reply", "deadline", "capacity", "cleanup-unconfirmed"].includes(descriptor.value as string)) code = descriptor.value as TauriFailure;
    }
  } catch { /* Reflection failures retain the fixed unavailable projection. */ }
  return new TauriError(code);
}
const typedArrayByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")!;
export function parseReply(value: unknown, request: TauriRequest): TauriReply {
  try {
  const b = record(value);
  for (const key of ["version", "id", "generation", "application", "window", "nonce"] as const) if (b[key] !== request[key]) throw new TauriError("invalid-reply");
  const common = ["version", "id", "generation", "application", "window", "nonce", "status"];
  const identity = { version: 1 as const, id: request.id, generation: request.generation, application: request.application, window: request.window, nonce: request.nonce };
  if (b.status === "denied" || b.status === "unavailable" || b.status === "cancelled") {
    if (Object.keys(b).length !== common.length || Object.keys(b).some(k => !common.includes(k))) throw new TauriError("invalid-reply");
    return { ...identity, status: b.status };
  }
  if (b.status !== "ok") throw new TauriError("invalid-reply");
  const payload = request.kind === "capture" ? "png" : request.kind === "cancel" ? "cancelled" : "observation";
  if (Object.keys(b).length !== common.length + 1 || Object.keys(b).some(k => ![...common, payload].includes(k))) throw new TauriError("invalid-reply");
  if (payload === "png") {
    if (types.isProxy(b.png) || !types.isUint8Array(b.png)) throw new TauriError("invalid-reply");
    const length = typedArrayByteLength.get!.call(b.png) as number;
    if (length > TAURI_LIMITS.pngBytes) throw new TauriError("invalid-reply");
    const png = new Uint8Array(length); Uint8Array.prototype.set.call(png, b.png as Uint8Array);
    return { ...identity, status: "ok", png };
  }
  if (payload === "cancelled") {
    if (b.cancelled !== true) throw new TauriError("invalid-reply");
    return { ...identity, status: "ok", cancelled: true };
  }
  if (payload === "observation") {
    const observation = record(b.observation);
    if (Object.keys(observation).sort().join() !== "sequence,source,value" || observation.source !== "cooperating-tauri" || typeof observation.value !== "number" || !Number.isSafeInteger(observation.value)
      || typeof observation.sequence !== "number" || !Number.isSafeInteger(observation.sequence) || observation.sequence < 0) throw new TauriError("invalid-reply");
    return { ...identity, status: "ok", observation: { source: "cooperating-tauri", value: observation.value, sequence: observation.sequence } };
  }
  throw new TauriError("invalid-reply");
  } catch { throw new TauriError("invalid-reply"); }
}
