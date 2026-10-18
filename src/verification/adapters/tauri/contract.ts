/** Host-registered, cooperating IPC. This is not native input automation. */
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
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new TauriError("invalid-reply");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some(d => !Object.hasOwn(d, "value"))) throw new TauriError("invalid-reply");
  return value as Record<string, unknown>;
}
export function authority(value: TauriAuthority): Readonly<TauriAuthority> {
  const object = record(value);
  if (Object.keys(object).sort().join() !== "application,nonce,window" || typeof object.application !== "string" || !/^[a-z][a-z0-9.-]{0,95}$/.test(object.application)
    || typeof object.window !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(object.window) || typeof object.nonce !== "string" || !/^[0-9a-f]{64}$/.test(object.nonce)) throw new TauriError("denied");
  return Object.freeze({ ...value });
}
export function parseReply(value: unknown, request: TauriRequest): TauriReply {
  const b = record(value);
  for (const key of ["version", "id", "generation", "application", "window", "nonce"] as const) if (b[key] !== request[key]) throw new TauriError("invalid-reply");
  const common = ["version", "id", "generation", "application", "window", "nonce", "status"];
  if (["denied", "unavailable", "cancelled"].includes(b.status as string)) {
    if (Object.keys(b).some(k => !common.includes(k))) throw new TauriError("invalid-reply");
    return b as unknown as TauriReply;
  }
  if (b.status !== "ok") throw new TauriError("invalid-reply");
  const payload = request.kind === "capture" ? "png" : request.kind === "cancel" ? "cancelled" : "observation";
  if (Object.keys(b).length !== common.length + 1 || Object.keys(b).some(k => ![...common, payload].includes(k))) throw new TauriError("invalid-reply");
  if (payload === "png" && (!(b.png instanceof Uint8Array) || b.png.byteLength > TAURI_LIMITS.pngBytes)) throw new TauriError("invalid-reply");
  if (payload === "cancelled" && b.cancelled !== true) throw new TauriError("invalid-reply");
  if (payload === "observation") {
    const observation = record(b.observation);
    if (Object.keys(observation).sort().join() !== "sequence,source,value" || observation.source !== "cooperating-tauri" || !Number.isSafeInteger(observation.value)
      || !Number.isSafeInteger(observation.sequence) || (observation.sequence as number) < 0) throw new TauriError("invalid-reply");
  }
  return b as unknown as TauriReply;
}
