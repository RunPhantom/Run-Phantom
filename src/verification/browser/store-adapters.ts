/** Explicit application-owned projections; no store discovery or business verdicts. */
import { captureBaselineReading, type SnapshotValue } from "../baseline.js";
import { sanitizeWithReport } from "../serialization.js";
import { isSensitiveKey } from "../redaction.js";

export interface StoreAdapter { readonly kind: "query" | "pinia" | "shape" }
export interface AdapterSnapshot {
  readonly availability: "complete" | "partial" | "unavailable";
  readonly value: SnapshotValue;
  readonly reason?: "source-unavailable" | "snapshot-unavailable" | "query-unavailable";
}
export interface StateAdapterOptions { select: Readonly<Record<string, string>> }
export interface QueryAdapterOptions {
  keys: readonly { queryKey: readonly unknown[]; select?: Readonly<Record<string, string>> }[];
  includeErrorMessage?: boolean;
}
interface ShapeSource { getState(): unknown; subscribe(listener: () => void): () => void }
interface PiniaSource {
  readonly $state: object;
  $subscribe(callback: (mutation: unknown, state: unknown) => void,
    options?: { detached?: boolean; flush?: "pre" | "post" | "sync" }): () => void;
}
interface QuerySource {
  getQueryCache(): object;
  defaultQueryOptions(options: { queryKey: readonly unknown[] }): { queryHash?: string };
}
export interface StoreAdapterDetails {
  readonly source: object;
  readonly configuration: string;
  read(): AdapterSnapshot;
  subscribe(listener: () => void): () => void;
}
const adapters = new WeakMap<object, StoreAdapterDetails>();
const encoder = new TextEncoder();
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const scope = Object.freeze({ sessionId: "adapter", generation: 0, kind: "state" as const, target: "adapter", path: "" });
class AdapterInputError extends Error {
  constructor() { super("Unsupported or oversized explicit store configuration"); }
}
function invalid(): never { throw new AdapterInputError(); }
function object(raw: unknown): object {
  if (raw === null || (typeof raw !== "object" && typeof raw !== "function")) invalid();
  return raw;
}
function data(raw: unknown, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object(raw), key);
  if (!descriptor || !("value" in descriptor)) invalid();
  return descriptor.value;
}
function fields(raw: unknown, allowed?: readonly string[]): Record<string, unknown> {
  const value = object(raw);
  if (Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const names = Reflect.ownKeys(value);
  if (names.length > 32) invalid();
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of names) {
    if (typeof key !== "string" || forbidden.has(key) || allowed && !allowed.includes(key)) invalid();
    out[key] = data(value, key);
  }
  return out;
}
function list(raw: unknown, max: number): unknown[] {
  if (!Array.isArray(raw)) invalid();
  const length = data(raw, "length");
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > max
    || Reflect.ownKeys(raw).length !== length + 1) invalid();
  const values: unknown[] = [];
  for (let n = 0; n < length; n++) values.push(data(raw, String(n)));
  return values;
}
function method(source: unknown, key: string): (...args: unknown[]) => unknown {
  const receiver = object(source);
  let current: object | null = receiver;
  for (let depth = 0; current && depth < 4; depth++, current = Object.getPrototypeOf(current) as object | null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (!descriptor) continue;
    if (!("value" in descriptor) || typeof descriptor.value !== "function") invalid();
    const call = descriptor.value as (...args: unknown[]) => unknown;
    return (...args) => Reflect.apply(call, receiver, args);
  }
  return invalid();
}
function selections(raw: unknown): Array<readonly [string, string]> {
  const entries = fields(raw);
  const names = Object.keys(entries).sort();
  if (!names.length || names.length > 20) invalid();
  return names.map(name => {
    const path = entries[name];
    if (!/^[A-Za-z0-9_:-]{1,128}$/.test(name) || typeof path !== "string" || path.length > 1024) invalid();
    const parts = path === "" ? [] : path.split(".");
    if (isSensitiveKey(name) || parts.length > 32 || parts.some(part => !part || forbidden.has(part) || isSensitiveKey(part))) invalid();
    return Object.freeze([name, path] as const);
  });
}
function select(raw: unknown, path: string): unknown {
  let value = raw;
  for (const part of path === "" ? [] : path.split(".")) value = data(value, part);
  return value;
}
function project(raw: unknown, selected: Array<readonly [string, string]>): Record<string, unknown> {
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [name, path] of selected) values[name] = select(raw, path);
  return values;
}
function unavailable(reason: AdapterSnapshot["reason"]): AdapterSnapshot {
  return Object.freeze({ availability: "unavailable", value: null, reason });
}
function snapshot(raw: unknown, partial = false): AdapterSnapshot {
  // One clone/redaction/budget for the WHOLE result, never one budget per selected path/query.
  const reading = captureBaselineReading({ scope, cursor: 0, fresh: true, complete: true }, raw);
  if (reading.availability === "unavailable") return unavailable("snapshot-unavailable");
  return Object.freeze({ availability: partial ? "partial" : reading.availability, value: reading.value,
    ...(partial ? { reason: "query-unavailable" as const } : reading.availability === "partial" ? { reason: "snapshot-unavailable" as const } : {}) });
}
function create(kind: StoreAdapter["kind"], details: StoreAdapterDetails): StoreAdapter {
  const adapter = Object.freeze({ kind });
  adapters.set(adapter, Object.freeze(details));
  return adapter;
}
export function storeAdapterDetails(raw: unknown): StoreAdapterDetails | undefined {
  return raw !== null && (typeof raw === "object" || typeof raw === "function") ? adapters.get(raw) : undefined;
}
export function readStoreAdapter(adapter: StoreAdapter): AdapterSnapshot {
  const details = storeAdapterDetails(adapter);
  if (!details) invalid();
  return details.read();
}

/** Collision-free identity for the admitted finite JSON key subset; no caller coercion. */
export function canonicalQueryKey(raw: unknown): string {
  if (!Array.isArray(raw)) invalid();
  let nodes = 0;
  const seen = new Set<object>();
  const clone = (value: unknown, depth: number): unknown => {
    if (++nodes > 100 || depth > 4) invalid();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.length <= 512) return value;
    const source = object(value);
    if (seen.has(source)) invalid();
    seen.add(source);
    try {
      if (Array.isArray(source)) return list(source, 32).map(item => clone(item, depth + 1));
      const props = fields(source);
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const name of Object.keys(props).sort()) {
        if (name.length > 128) invalid();
        result[name] = clone(props[name], depth + 1);
      }
      return result;
    } finally { seen.delete(source); }
  };
  const value = clone(raw, 0);
  const identity = JSON.stringify(value);
  if (encoder.encode(identity).byteLength > 2048) invalid();
  const clean = sanitizeWithReport(value);
  if (clean.redacted || clean.truncation || JSON.stringify(clean.value) !== identity) invalid();
  return identity;
}

export function shapeStore(source: ShapeSource, options: StateAdapterOptions): StoreAdapter {
  const selected = selections(fields(options, ["select"]).select);
  const getState = method(source, "getState");
  const subscribe = method(source, "subscribe");
  return create("shape", { source, configuration: JSON.stringify(["shape", selected]),
    read: () => { try { return snapshot({ adapter: "shape", values: project(getState(), selected) }); }
      catch { return unavailable("source-unavailable"); } },
    subscribe: listener => {
      const release = subscribe(listener);
      if (typeof release !== "function") invalid();
      return release as () => void;
    } });
}
export function piniaStore(source: PiniaSource, options: StateAdapterOptions): StoreAdapter {
  const selected = selections(fields(options, ["select"]).select);
  const subscribe = method(source, "$subscribe");
  object(source);
  const getState = (): unknown => {
    // Pinia's documented public $state accessor is explicitly opted in; nested getters are not.
    const descriptor = Object.getOwnPropertyDescriptor(source, "$state");
    if (!descriptor) invalid();
    if ("value" in descriptor) return descriptor.value;
    const get = Reflect.get(descriptor, "get") as unknown;
    return typeof get === "function" ? Reflect.apply(get, source, []) : invalid();
  };
  return create("pinia", { source, configuration: JSON.stringify(["pinia", selected]),
    read: () => { try { return snapshot({ adapter: "pinia", values: project(getState(), selected) }); }
      catch { return unavailable("source-unavailable"); } },
    subscribe: listener => {
      const release = subscribe(() => listener(), { detached: true, flush: "sync" });
      if (typeof release !== "function") invalid();
      return release as () => void;
    } });
}

export function queryStore(source: QuerySource, options: QueryAdapterOptions): StoreAdapter {
  const opts = fields(options, ["keys", "includeErrorMessage"]);
  if (opts.includeErrorMessage !== undefined && typeof opts.includeErrorMessage !== "boolean") invalid();
  let selectedCount = 0, keyBytes = 0;
  const keys = list(opts.keys, 20).map(item => {
    const entry = fields(item, ["queryKey", "select"]);
    const id = canonicalQueryKey(entry.queryKey);
    keyBytes += encoder.encode(id).byteLength;
    const selected = entry.select === undefined ? [] : selections(entry.select);
    selectedCount += selected.length;
    if (selectedCount > 20 || keyBytes > 4096) invalid();
    return { id, key: JSON.parse(id) as unknown[], selected };
  });
  if (!keys.length || new Set(keys.map(key => key.id)).size !== keys.length) invalid();
  const getCache = method(source, "getQueryCache"), defaults = method(source, "defaultQueryOptions");
  const cache = object(getCache()), get = method(cache, "get"), subscribe = method(cache, "subscribe");
  return create("query", { source, configuration: JSON.stringify(["query", keys.map(({ id, selected }) => [id, selected]), opts.includeErrorMessage === true]),
    read: () => {
      try {
        if (getCache() !== cache) return unavailable("query-unavailable");
        let partial = false;
        const queries = keys.map(({ id, key, selected }) => {
          try {
            const hash = data(defaults({ queryKey: JSON.parse(id) as unknown[] }), "queryHash");
            if (typeof hash !== "string" || !hash || hash.length > 4096) invalid();
            const query = get(hash);
            if (canonicalQueryKey(data(query, "queryKey")) !== id) invalid();
            const state = data(query, "state"), status = data(state, "status"), fetchStatus = data(state, "fetchStatus");
            const dataUpdatedAt = data(state, "dataUpdatedAt"), isStale = method(query, "isStale")();
            if (typeof status !== "string" || typeof fetchStatus !== "string" || typeof isStale !== "boolean"
              || !["pending", "error", "success"].includes(status) || !["idle", "fetching", "paused"].includes(fetchStatus)
              || typeof dataUpdatedAt !== "number" || !Number.isSafeInteger(dataUpdatedAt) || dataUpdatedAt < 0) invalid();
            const error = data(state, "error");
            return { keyId: id, key, availability: "complete", status, fetchStatus, dataUpdatedAt, isStale,
              hasError: error !== null && error !== undefined,
              ...(opts.includeErrorMessage === true && error !== null && error !== undefined ? { errorMessage: data(error, "message") } : {}),
              ...(selected.length ? { values: project(data(state, "data"), selected) } : {}) };
          } catch {
            partial = true;
            return { keyId: id, key, availability: "unavailable", reason: "query-unavailable" };
          }
        });
        return snapshot({ adapter: "query", queries }, partial);
      } catch { return unavailable("query-unavailable"); }
    },
    subscribe: listener => {
      if (getCache() !== cache) invalid();
      const release = subscribe(listener);
      if (typeof release !== "function") invalid();
      return release as () => void;
    } });
}
