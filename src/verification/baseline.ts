import { VERIFICATION_LIMITS as L, type RelativeTarget } from "./protocol";
import { sanitizeWithReport } from "./serialization";
import { parseFlowSteps } from "./validation";

export type SnapshotValue = null | boolean | number | string | readonly SnapshotValue[] | { readonly [key: string]: SnapshotValue };

export interface BaselineScope {
  readonly sessionId: string;
  readonly generation: number;
  readonly kind: "state" | "element";
  readonly target: string;
  readonly path?: string;
}

export interface OperationReading {
  readonly operationId: string;
  readonly phase: "accepted" | "final";
}

export interface ReadingMetadata {
  readonly scope: BaselineScope;
  readonly cursor: number;
  readonly fresh: boolean;
  readonly complete: boolean;
  readonly actionId?: string;
  readonly outcome?: OperationReading;
  readonly truncated?: boolean;
  readonly redacted?: boolean;
}

export interface BaselineReading extends ReadingMetadata {
  readonly version: 1;
  readonly availability: "complete" | "partial" | "unavailable";
  readonly value: SnapshotValue;
  readonly unavailableReason?: "capture-incomplete" | "non-json" | "limit" | "invalid-reading";
}

export interface CausalAttribution {
  readonly source: "action-result" | "declared-operation";
  readonly scope: BaselineScope;
  readonly actionId: string;
  readonly cursor: number;
  readonly baseline: BaselineReading;
  readonly reading: BaselineReading;
}

// Process-local classification, not authorization: only the owning dispatcher may supply provenance.
// Persisted/copied records remain inspectable but must be matched to owned capture records before reuse.
const capturedAttributions = new WeakSet<object>();

export class BaselineInputError extends Error {
  constructor(message: string) { super(message); this.name = "BaselineInputError"; }
}

const MAX_DEPTH = 8;
const MAX_ITEMS = 100;
const MAX_NODES = 500;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);

function record(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new BaselineInputError("Baseline metadata must be a plain object");
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) throw new BaselineInputError("Baseline metadata must be a plain object");
  const names = Reflect.ownKeys(raw);
  if (names.length > allowed.length) throw new BaselineInputError("Unsupported baseline metadata");
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of names) {
    if (typeof name !== "string" || !allowed.includes(name)) throw new BaselineInputError("Unsupported baseline metadata");
    const descriptor = Object.getOwnPropertyDescriptor(raw, name);
    if (!descriptor || !("value" in descriptor)) throw new BaselineInputError("Baseline metadata cannot contain accessors");
    out[name] = descriptor.value;
  }
  return out;
}

function identifier(raw: unknown): string {
  if (typeof raw !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(raw)) throw new BaselineInputError("Invalid baseline identity");
  const clean = sanitizeWithReport(raw);
  if (clean.redacted || clean.truncation || clean.value !== raw) throw new BaselineInputError("Baseline identities cannot contain credentials");
  return raw;
}

export function baselineCursor(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) throw new BaselineInputError("Invalid baseline cursor or generation");
  return raw;
}

export function captureBaselineScope(raw: unknown): BaselineScope {
  const scope = record(raw, ["sessionId", "generation", "kind", "target", "path"]);
  const sessionId = identifier(scope.sessionId);
  const generation = baselineCursor(scope.generation);
  if (typeof scope.target !== "string") throw new BaselineInputError("A baseline requires a store or selector");
  const clean = sanitizeWithReport(scope.target);
  if (clean.redacted || clean.truncation || clean.value !== scope.target) throw new BaselineInputError("Baseline targets cannot contain credentials");
  if (scope.kind === "state") {
    const path = scope.path ?? "";
    if (typeof path !== "string") throw new BaselineInputError("Invalid baseline state path");
    parseFlowSteps([{ predicate: { kind: "state", store: scope.target, path, equals: null } }]);
    return Object.freeze({ sessionId, generation, kind: "state", target: scope.target, path });
  }
  if (scope.kind === "element" && !Object.hasOwn(scope, "path")) {
    parseFlowSteps([{ predicate: { kind: "element", selector: scope.target, state: "present" } }]);
    return Object.freeze({ sessionId, generation, kind: "element", target: scope.target });
  }
  throw new BaselineInputError("Unsupported baseline scope");
}

export function sameBaselineScope(left: BaselineScope, right: BaselineScope): boolean {
  return left.sessionId === right.sessionId && left.generation === right.generation && left.kind === right.kind
    && left.target === right.target && left.path === right.path;
}

/** Dispatchers supply the identity; page events and API bodies never choose it. */
export function baselineScopeForTarget(sessionId: string, generation: number, target: RelativeTarget): BaselineScope {
  return captureBaselineScope(target.kind === "state"
    ? { sessionId, generation, kind: "state", target: target.store, path: target.path }
    : { sessionId, generation, kind: "element", target: target.selector });
}

class SnapshotError extends Error {
  constructor(readonly reason: "non-json" | "limit" | "invalid-reading") { super(reason); }
}

// Inspect data descriptors before redaction: application getters and toJSON are executable code.
function cloneJson(raw: unknown, depth: number, budget: { nodes: number; characters: number }, seen: Set<object>): SnapshotValue {
  if (depth > MAX_DEPTH || ++budget.nodes > MAX_NODES) throw new SnapshotError("limit");
  if (raw === null || typeof raw === "boolean") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    budget.characters += raw.length;
    if (raw.length > L.MAX_TEXT_LENGTH || budget.characters > L.MAX_EVENT_BYTES) throw new SnapshotError("limit");
    return raw;
  }
  if (typeof raw !== "object" || raw === null || seen.has(raw)) throw new SnapshotError("non-json");
  const array = Array.isArray(raw);
  const proto = Object.getPrototypeOf(raw);
  if (!array && proto !== Object.prototype && proto !== null) throw new SnapshotError("non-json");
  const names = Reflect.ownKeys(raw);
  if (names.length > MAX_ITEMS + (array ? 1 : 0)) throw new SnapshotError("limit");
  seen.add(raw);
  try {
    if (array) {
      const length = Object.getOwnPropertyDescriptor(raw, "length")?.value as number;
      if (!Number.isSafeInteger(length) || length < 0) throw new SnapshotError("non-json");
      if (length > MAX_ITEMS) throw new SnapshotError("limit");
      if (names.length !== length + 1) throw new SnapshotError("non-json");
      const out: SnapshotValue[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
        if (!descriptor || !("value" in descriptor)) throw new SnapshotError("non-json");
        out.push(cloneJson(descriptor.value, depth + 1, budget, seen));
      }
      return out;
    }
    const out: { [key: string]: SnapshotValue } = Object.create(null) as { [key: string]: SnapshotValue };
    for (const name of names) {
      if (typeof name !== "string" || forbidden.has(name)) throw new SnapshotError("non-json");
      budget.characters += name.length;
      if (name.length > 256 || budget.characters > L.MAX_EVENT_BYTES) throw new SnapshotError("limit");
      const descriptor = Object.getOwnPropertyDescriptor(raw, name);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new SnapshotError("non-json");
      out[name] = cloneJson(descriptor.value, depth + 1, budget, seen);
    }
    return out;
  } finally { seen.delete(raw); }
}

function freezeSnapshot(value: SnapshotValue): SnapshotValue {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) freezeSnapshot(entry);
    Object.freeze(value);
  }
  return value;
}

function unavailableSnapshot(value: SnapshotValue): boolean {
  if (typeof value === "string") return /\[(?:REDACTED|TRUNCATED|UNSERIALIZABLE|CIRCULAR)\]/.test(value);
  return value !== null && typeof value === "object" && Object.values(value).some(unavailableSnapshot);
}

export function captureBaselineReading(metadata: ReadingMetadata, value: unknown): BaselineReading {
  const raw = record(metadata, ["scope", "cursor", "fresh", "complete", "actionId", "outcome", "truncated", "redacted"]);
  const scope = captureBaselineScope(raw.scope);
  const cursor = baselineCursor(raw.cursor);
  for (const key of ["fresh", "complete", "truncated", "redacted"]) {
    if ((key === "fresh" || key === "complete" || Object.hasOwn(raw, key)) && typeof raw[key] !== "boolean") throw new BaselineInputError("Baseline coverage flags must be boolean");
  }
  const actionId = Object.hasOwn(raw, "actionId") ? identifier(raw.actionId) : undefined;
  let outcome: OperationReading | undefined;
  if (Object.hasOwn(raw, "outcome")) {
    const operation = record(raw.outcome, ["operationId", "phase"]);
    if (operation.phase !== "accepted" && operation.phase !== "final") throw new BaselineInputError("Unsupported operation outcome phase");
    outcome = Object.freeze({ operationId: identifier(operation.operationId), phase: operation.phase });
  }
  const base = { version: 1 as const, scope, cursor, fresh: raw.fresh as boolean, complete: raw.complete as boolean,
    ...(actionId === undefined ? {} : { actionId }), ...(outcome === undefined ? {} : { outcome }),
    ...(raw.truncated === true ? { truncated: true } : {}), ...(raw.redacted === true ? { redacted: true } : {}) };
  if (!base.complete) return Object.freeze({ ...base, availability: "unavailable", value: null, unavailableReason: "capture-incomplete" });
  try {
    if (scope.kind === "element" && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) throw new SnapshotError("invalid-reading");
    const cloned = cloneJson(value, 0, { nodes: 0, characters: 0 }, new Set());
    if (new TextEncoder().encode(JSON.stringify(cloned)).byteLength > L.MAX_EVENT_BYTES) throw new SnapshotError("limit");
    const clean = sanitizeWithReport(cloned);
    if (new TextEncoder().encode(JSON.stringify(clean.value)).byteLength > L.MAX_EVENT_BYTES) throw new SnapshotError("limit");
    const partial = raw.truncated === true || raw.redacted === true || clean.truncation || clean.redacted
      || unavailableSnapshot(clean.value as SnapshotValue);
    return Object.freeze({ ...base, availability: partial ? "partial" : "complete", value: freezeSnapshot(clean.value as SnapshotValue),
      ...(clean.redacted ? { redacted: true } : {}), ...(clean.truncation ? { truncated: true } : {}) });
  } catch (error) {
    return Object.freeze({ ...base, availability: "unavailable", value: null,
      unavailableReason: error instanceof SnapshotError ? error.reason : "non-json" });
  }
}

/** Call only with a dispatcher-owned result or an operation matched by its declared contract.
 * A later ordinary DOM/state event is not an action result. Request payloads cannot supply this proof.
 * This validates the result shape; it cannot authenticate the source of a supplied record.
 */
export function captureCausalAttribution(raw: unknown): CausalAttribution {
  const event = record(raw, ["t", "type", "actionId", "data", "truncated"]);
  const source = event.type === "action.result" ? "action-result" : event.type === "operation.result" ? "declared-operation" : undefined;
  if (!source || event.truncated !== undefined && event.truncated !== false) throw new BaselineInputError("A complete captured result is required for attribution");
  const cursor = baselineCursor(event.t);
  const actionId = identifier(event.actionId);
  const data = record(event.data, ["scope", "baselineCursor", "baselineValue", "readingCursor", "value", "operationId", "phase"]);
  const scope = captureBaselineScope(data.scope);
  const baselineCursor_ = baselineCursor(data.baselineCursor);
  const readingCursor = baselineCursor(data.readingCursor);
  if (baselineCursor_ >= readingCursor || readingCursor > cursor || !Object.hasOwn(data, "value") || !Object.hasOwn(data, "baselineValue")) throw new BaselineInputError("The captured result must include its own ordered pre/post scoped readings");
  let outcome: OperationReading | undefined;
  if (source === "declared-operation") {
    if (data.phase !== "accepted" && data.phase !== "final") throw new BaselineInputError("An operation result requires its declared phase");
    outcome = { operationId: identifier(data.operationId), phase: data.phase };
  } else if (Object.hasOwn(data, "phase") || Object.hasOwn(data, "operationId")) {
    throw new BaselineInputError("Operation attribution requires an operation result");
  }
  const baseline = captureBaselineReading({ scope, cursor: baselineCursor_, fresh: true, complete: true }, data.baselineValue);
  const reading = captureBaselineReading({ scope, cursor: readingCursor, fresh: true, complete: true, actionId,
    ...(outcome === undefined ? {} : { outcome }) }, data.value);
  if (baseline.availability !== "complete" || reading.availability !== "complete") throw new BaselineInputError("Partial baseline or result readings cannot establish attribution");
  const attribution = Object.freeze({ source, scope, actionId, cursor, baseline, reading });
  capturedAttributions.add(attribution);
  return attribution;
}

export function isCapturedAttribution(value: unknown): value is CausalAttribution {
  return typeof value === "object" && value !== null && capturedAttributions.has(value);
}
