/** Shared inert data only: no captured text, attributes, input values or resource URLs. */
export const RECORDING_LIMITS = Object.freeze({
  active: 2, durationMs: 60_000, nodes: 256, visited: 2_000, framesPerSecond: 2,
  producerBatches: 4, eventsPerBatch: 64, batchBytes: 48 * 1024,
  batches: 128, recordingBytes: 4 * 1024 * 1024, records: 100, perRun: 16,
  aggregateBytes: 32 * 1024 * 1024, lifetimes: 1_000,
  width: 1_920, height: 1_080, events: 8_192, epoch: 8_640_000_000_000_000,
});

// 0 box, 1 text placeholder, 2 input placeholder, 3 media placeholder, 4 inaccessible surface.
export type LayoutNode = { id: number; kind: 0 | 1 | 2 | 3 | 4; rect: [number, number, number, number]; paint: [number, number, number, number] };
export type LayoutFrame = { ordinal: number; epochMs: number; kind: 0; viewport: [number, number]; visited: number; clipped: boolean; nodes: LayoutNode[] };
// 1 pointer, 2 click, 3 input, 4 change, 5 focus, 6 scroll, 7 key, 8 document boundary.
export type LayoutEvent = { ordinal: number; epochMs: number; kind: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8; target: number | null; x: number | null; y: number | null };
export type RecordingEvent = LayoutFrame | LayoutEvent;
export type RecordingBatch = { version: 1; document: number; sequence: number; dropped: number | null; loss: boolean; events: RecordingEvent[] };
export type RecordingStatus = "recording" | "complete" | "partial" | "cancelled" | "interrupted" | "deleted";
export type RecordingReason = "none" | "node-cap" | "visit-cap" | "queue" | "capacity" | "document" | "clock" | "integrity" | "sequence" | "timeout" | "cancelled" | "interrupted" | "authority" | "unavailable" | "deleted";
export type RecordingSummary = {
  id: string; runId: string; sessionId: string; engine: "chromium" | "firefox" | "webkit"; engineVersion: string;
  producerVersion: 1; maskPolicy: "all-text-inputs-v1"; startedAt: number; endedAt: number | null;
  clockOffsetMs: number | null; clockUncertaintyMs: number | null;
  status: RecordingStatus; loss: boolean; reason: RecordingReason; batches: number; events: number; bytes: number; dropped: number | null;
};
export type RecordingLease = { summary: RecordingSummary; token: string };
export class RecordingInputError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "RecordingInputError"; }
}

function refuse(): never { throw new RecordingInputError("Invalid masked layout recording"); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return refuse();
  const entries = Object.keys(value);
  if (entries.length !== keys.length || entries.some(key => !keys.includes(key))) return refuse();
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return refuse();
  return value;
}
function finite(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return refuse();
  return value;
}
function boolean(value: unknown): boolean { if (typeof value !== "boolean") return refuse(); return value; }
function array(value: unknown, min: number, max: number): unknown[] { if (!Array.isArray(value) || value.length < min || value.length > max) return refuse(); return value; }
function node(value: unknown): LayoutNode {
  const record = object(value, ["id", "kind", "rect", "paint"]);
  const rect = array(record.rect, 4, 4), paint = array(record.paint, 4, 4);
  return { id: integer(record.id, 1, RECORDING_LIMITS.visited), kind: integer(record.kind, 0, 4) as LayoutNode["kind"],
    rect: [finite(rect[0], -RECORDING_LIMITS.width, RECORDING_LIMITS.width), finite(rect[1], -RECORDING_LIMITS.height, RECORDING_LIMITS.height), finite(rect[2], 0, RECORDING_LIMITS.width), finite(rect[3], 0, RECORDING_LIMITS.height)],
    paint: [integer(paint[0], 0, 255), integer(paint[1], 0, 255), integer(paint[2], 0, 255), integer(paint[3], 0, 255)] };
}
function event(value: unknown): RecordingEvent {
  const candidate = value as Record<string, unknown> | null;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return refuse();
  if (candidate.kind === 0) {
    const record = object(candidate, ["ordinal", "epochMs", "kind", "viewport", "visited", "clipped", "nodes"]);
    const viewport = array(record.viewport, 2, 2), nodes = array(record.nodes, 0, RECORDING_LIMITS.nodes).map(node);
    const visited = integer(record.visited, 0, RECORDING_LIMITS.visited);
    if (nodes.length > visited || new Set(nodes.map(item => item.id)).size !== nodes.length) return refuse();
    return { ordinal: integer(record.ordinal, 1, RECORDING_LIMITS.events), epochMs: integer(record.epochMs, 0, RECORDING_LIMITS.epoch), kind: 0,
      viewport: [integer(viewport[0], 1, RECORDING_LIMITS.width), integer(viewport[1], 1, RECORDING_LIMITS.height)], visited, clipped: boolean(record.clipped), nodes };
  }
  const record = object(candidate, ["ordinal", "epochMs", "kind", "target", "x", "y"]);
  const x = record.x === null ? null : finite(record.x, 0, RECORDING_LIMITS.width);
  const y = record.y === null ? null : finite(record.y, 0, RECORDING_LIMITS.height);
  if ((x === null) !== (y === null)) return refuse();
  const kind = integer(record.kind, 1, 8) as LayoutEvent["kind"], target = record.target === null ? null : integer(record.target, 1, RECORDING_LIMITS.visited);
  if ((kind >= 3 && x !== null) || (kind === 8 && target !== null)) return refuse();
  return { ordinal: integer(record.ordinal, 1, RECORDING_LIMITS.events), epochMs: integer(record.epochMs, 0, RECORDING_LIMITS.epoch), kind, target, x, y };
}

/** Bytes are bounded before decoding; canonical equality rejects duplicate keys and lossy JSON numbers. */
export function parseRecordingBatch(encoded: string | Uint8Array): RecordingBatch {
  let raw: string;
  if (typeof encoded === "string") {
    if (encoded.length > RECORDING_LIMITS.batchBytes || new TextEncoder().encode(encoded).byteLength > RECORDING_LIMITS.batchBytes) throw new RecordingInputError("Masked recording batch exceeds its byte budget", 413);
    raw = encoded;
  } else {
    if (!(encoded instanceof Uint8Array)) return refuse();
    if (encoded.byteLength > RECORDING_LIMITS.batchBytes) throw new RecordingInputError("Masked recording batch exceeds its byte budget", 413);
    try { raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(encoded); } catch { return refuse(); }
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return refuse(); }
  if (JSON.stringify(parsed) !== raw) return refuse();
  const record = object(parsed, ["version", "document", "sequence", "dropped", "loss", "events"]);
  if (record.version !== 1) return refuse();
  const events = array(record.events, 1, RECORDING_LIMITS.eventsPerBatch).map(event);
  for (let i = 1; i < events.length; i++) if (events[i].ordinal <= events[i - 1].ordinal || events[i].epochMs < events[i - 1].epochMs) return refuse();
  const dropped = record.dropped === null ? null : integer(record.dropped, 0, Number.MAX_SAFE_INTEGER), loss = boolean(record.loss);
  if ((dropped === null || dropped > 0 || events.some(item => item.kind === 0 && item.clipped)) && !loss) return refuse();
  return { version: 1, document: integer(record.document, 1, Number.MAX_SAFE_INTEGER), sequence: integer(record.sequence, 0, RECORDING_LIMITS.batches - 1), dropped, loss, events };
}
