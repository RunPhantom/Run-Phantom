/** Bounded serialization for evidence crossing the browser/daemon boundary.
 *
 * Applies redaction, enforces transport limits and discloses truncation
 * explicitly, so a consumer can tell a small value from a clipped one.
 */
import { REDACTED_VALUE, isSensitiveKey, scrubKnownSecrets, redactUrl } from "./redaction";
import { VERIFICATION_LIMITS } from "./protocol";
const TRANSPORT_LIMITS = {
  MAX_MESSAGE_BYTES: VERIFICATION_LIMITS.MAX_EVENT_BYTES,
  MAX_COLLECTION_ITEMS: 100,
  MAX_OBJECT_KEYS: 100,
  MAX_SERIALIZE_DEPTH: 8,
  MAX_ERROR_LENGTH: 1000,
  MAX_STRING_LENGTH: 4096,
} as const;

const TRUNCATED_VALUE = '[TRUNCATED]';
const UNSERIALIZABLE_VALUE = '[UNSERIALIZABLE]';
const OMIT_VALUE = Symbol('omit');
const MAX_KEY_LENGTH = 256;
// UTF-8 encodes at most ~3 bytes per JS (UTF-16) code unit, so /4 is a provably-safe bound that never
// exceeds the byte budget — /8 was ~1/8 of the real 1MiB wire budget and truncated legitimate state.
const MAX_TOTAL_CHARACTERS = Math.floor(TRANSPORT_LIMITS.MAX_MESSAGE_BYTES / 4);
const MAX_TOTAL_NODES = TRANSPORT_LIMITS.MAX_COLLECTION_ITEMS * 5;

// Read collection storage through intrinsics; app-owned iterators, size accessors and
// coercion methods are executable application code, just like ordinary object getters.
const mapEntries = Object.getOwnPropertyDescriptor(Map.prototype, "entries")!.value as typeof Map.prototype.entries;
const mapSize = Reflect.get(Object.getOwnPropertyDescriptor(Map.prototype, "size")!, "get") as (this: Map<unknown, unknown>) => number;
const mapNext = Object.getPrototypeOf(new Map().entries()).next as (this: Iterator<[unknown, unknown]>) => IteratorResult<[unknown, unknown]>;
const setValues = Object.getOwnPropertyDescriptor(Set.prototype, "values")!.value as typeof Set.prototype.values;
const setSize = Reflect.get(Object.getOwnPropertyDescriptor(Set.prototype, "size")!, "get") as (this: Set<unknown>) => number;
const setNext = Object.getPrototypeOf(new Set().values()).next as (this: Iterator<unknown>) => IteratorResult<unknown>;
const typedArrayLength = Reflect.get(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "length")!, "get") as (this: ArrayBufferView) => number;

interface SanitizeState {
  readonly seen: WeakSet<object>;
  remainingCharacters: number;
  nodes: number;
  /** Collection items dropped to stay inside the node budget. */
  droppedItems: number;
  /** Values replaced by a placeholder because a cap was hit mid-value. */
  truncatedValues: number;
  redacted: boolean;
  scrubString?: (text: string) => string;
}

export interface SerializationOptions {
  /** Browser-held fill values must be removed before generic truncation can cut an echo. */
  scrubString?: (text: string) => string;
}

function scrubInput(value: string, state: SanitizeState): string {
  const scrubbed = state.scrubString ? state.scrubString(value) : value;
  if (typeof scrubbed !== "string") throw new TypeError("scrubString must return a string");
  if (scrubbed !== value) state.redacted = true;
  return scrubbed;
}

function boundedString(value: string, state: SanitizeState, max: number): string {
  const allowed = Math.max(0, Math.min(max, state.remainingCharacters));
  if (value.length <= allowed) {
    state.remainingCharacters -= value.length;
    return value;
  }
  // Count the cut. A silently shortened string is the same false green the collection caps were made
  // to report: a caller comparing a 500k-char value against expected data sees 65k and concludes the
  // app dropped the rest, with no marker saying WE did. The report interface exists for exactly this.
  state.truncatedValues += 1;
  const truncated =
    allowed <= TRUNCATED_VALUE.length
      ? TRUNCATED_VALUE.slice(0, allowed)
      : `${value.slice(0, allowed - TRUNCATED_VALUE.length)}${TRUNCATED_VALUE}`;
  state.remainingCharacters -= truncated.length;
  return truncated;
}

function sanitize(value: unknown, state: SanitizeState, depth: number, key?: string): unknown {
  if (key !== undefined && (isSensitiveKey(key) || key === "urlRaw")) {
    state.redacted = true;
    return REDACTED_VALUE;
  }
  if (depth > TRANSPORT_LIMITS.MAX_SERIALIZE_DEPTH || state.nodes >= MAX_TOTAL_NODES) {
    state.truncatedValues += 1;
    return TRUNCATED_VALUE;
  }
  state.nodes += 1;

  if (null === value || 'boolean' === typeof value) return value;
  if ('string' === typeof value) {
    const scrubbed = scrubInput(value, state);
    const scanned = scrubbed.slice(0, TRANSPORT_LIMITS.MAX_STRING_LENGTH * 4);
    if (scanned.length !== scrubbed.length) state.truncatedValues += 1;
    const redacted = redactText(scanned);
    if (redacted !== value) state.redacted = true;
    return boundedString(
      redacted,
      state,
      'error' === key?.toLowerCase()
        ? TRANSPORT_LIMITS.MAX_ERROR_LENGTH
        : TRANSPORT_LIMITS.MAX_STRING_LENGTH,
    );
  }
  if ('number' === typeof value) {
    if (!Number.isFinite(value)) state.truncatedValues += 1;
    return Number.isFinite(value) ? value : null;
  }
  if ('bigint' === typeof value) { state.truncatedValues += 1; return value.toString(); }
  if ('undefined' === typeof value || 'function' === typeof value || 'symbol' === typeof value) {
    state.truncatedValues += 1;
    return OMIT_VALUE;
  }
  // An invalid Date (`new Date(NaN)` / `new Date(undefined)`, easy to land in app state) throws
  // RangeError on toISOString — and only safeStringify catches it, so a direct sanitize caller
  // (readStoresWithTruncation, the state observer) crashed the WHOLE state read over one bad Date.
  // Degrade to null, the same way a non-finite number does two branches up.
  if (value instanceof Date) {
    state.truncatedValues += 1;
    return Number.isNaN(Date.prototype.getTime.call(value)) ? null : Date.prototype.toISOString.call(value);
  }
  // Map and Set are common enough in app state (a normalized store keyed by id, a set of selected
  // ids) that serializing them to `{}` — which is what the plain-object branch below does, since they
  // have no enumerable own keys — is a false green: an agent reads empty and concludes the state is
  // empty, when really it was unrepresentable. Convert to a readable shape, bounded by the same caps.
  if (value instanceof Map) {
    state.truncatedValues += 1;
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const entries = mapEntries.call(value);
    const total = mapSize.call(value) as number;
    let n = 0;
    for (;;) {
      if (state.nodes >= MAX_TOTAL_NODES || n >= TRANSPORT_LIMITS.MAX_COLLECTION_ITEMS) {
        // Budget spent — STOP. `continue` iterated a million-entry Map to the end just to count drops
        // one at a time; size-n records the remainder in one shot (like the typed-array branch).
        state.droppedItems += total - n;
        break;
      }
      const entry = mapNext.call(entries);
      if (entry.done) break;
      const [k, v] = entry.value;
      if (typeof k !== "string") {
        state.truncatedValues += 1;
        state.droppedItems += 1;
        n += 1;
        continue;
      }
      const originalKey = k;
      if (["__proto__", "prototype", "constructor"].includes(originalKey)) {
        state.droppedItems += 1;
        n += 1;
        continue;
      }
      const redactedKey = redactText(scrubInput(originalKey, state).slice(0, 4096));
      if (redactedKey !== originalKey) state.redacted = true;
      const sk = boundedString(redactedKey, state, MAX_KEY_LENGTH);
      const sv = sanitize(v, state, depth + 1, sk);
      if (sv !== OMIT_VALUE) out[sk] = sv;
      n += 1;
    }
    return out;
  }
  if (value instanceof Set) {
    state.truncatedValues += 1;
    const out: unknown[] = [];
    const values = setValues.call(value);
    const total = setSize.call(value) as number;
    let n = 0;
    for (;;) {
      if (state.nodes >= MAX_TOTAL_NODES || n >= TRANSPORT_LIMITS.MAX_COLLECTION_ITEMS) {
        state.droppedItems += total - n; // stop; record the remainder at once, don't walk the rest
        break;
      }
      const entry = setNext.call(values);
      if (entry.done) break;
      const sv = sanitize(entry.value, state, depth + 1);
      out.push(sv === OMIT_VALUE ? null : sv);
      n += 1;
    }
    return out;
  }
  // A typed array (Uint8Array, Float32Array, …) is array-like DATA, not a plain object. The
  // plain-object branch below turned it into index-keyed keys ({"0":1,"1":2,…}) — a shape lie: an
  // agent reading a tensor/binary field saw an object where an array lives, and a big one blew the key
  // cap silently. Emit its numbers as a bounded array like a Set. DataView is opaque bytes — leave it.
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    state.truncatedValues += 1;
    const len = typedArrayLength.call(value) as number;
    const out: number[] = [];
    let n = 0;
    for (; n < len; n += 1) {
      if (state.nodes >= MAX_TOTAL_NODES || n >= TRANSPORT_LIMITS.MAX_COLLECTION_ITEMS) {
        state.droppedItems += len - n;
        break;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(n));
      const item: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
      if (typeof item !== "number" || !Number.isFinite(item)) {
        state.truncatedValues += 1;
        out.push(0);
      } else out.push(item);
      state.nodes += 1;
    }
    return out;
  }
  if (value instanceof Error) {
    state.truncatedValues += 1;
    const name = Object.getOwnPropertyDescriptor(value, "name");
    const message = Object.getOwnPropertyDescriptor(value, "message");
    return {
      name: sanitize(name ? ("value" in name ? name.value : UNSERIALIZABLE_VALUE) : "Error", state, depth + 1, "name"),
      message: sanitize(message && "value" in message ? message.value : UNSERIALIZABLE_VALUE, state, depth + 1, "error"),
    };
  }
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) {
      state.truncatedValues += 1;
      return UNSERIALIZABLE_VALUE;
    }
  }
  if (state.seen.has(value)) { state.truncatedValues += 1; return '[CIRCULAR]'; }

  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      // Truncate by dropping whole ITEMS, never by corrupting them.
      //
      // The node budget used to run out mid-collection, so later items kept their shape while
      // individual fields became the string "[TRUNCATED]" — an array field turned into a string, a
      // boolean into a string. Consumers declare output schemas over these payloads, so that was not
      // a degraded answer: validation rejected the whole message and the caller received NOTHING. On
      // a page with thousands of matches that is a total loss of the query tool, in exactly the
      // conditions where it matters most.
      //
      // Stopping BEFORE an item that will not fit keeps every survivor whole and type-correct. The
      // collection's true size travels separately as a scalar (serialized first), so "how many" stays
      // exact while the sample shrinks.
      const out: unknown[] = [];
      const length = Object.getOwnPropertyDescriptor(value, "length")?.value as number;
      const considered = Math.min(length, TRANSPORT_LIMITS.MAX_COLLECTION_ITEMS);
      // Items beyond the collection cap are dropped before the loop even sees them; count them here
      // so the report covers BOTH reasons a caller is holding a short list.
      state.droppedItems += Math.max(0, length - considered);
      for (let index = 0; index < considered; index += 1) {
        if (state.nodes >= MAX_TOTAL_NODES) {
          state.droppedItems += 1;
          continue;
        }
        // Checking only BEFORE the item is not enough: one that starts under the budget can cross it
        // partway through and come back with its tail replaced by placeholders. Serialize, then keep
        // it only if it fitted — otherwise discard it and stop, so what ships is always whole.
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) {
          state.truncatedValues += 1;
          out.push(UNSERIALIZABLE_VALUE);
          continue;
        }
        const sanitized = sanitize(descriptor.value, state, depth + 1);
        // `>=`, not `>`: sanitize stops AT the ceiling rather than passing it, so the budget never
        // reads as exceeded. Reaching it during this item means some field inside was replaced by a
        // placeholder, which makes the item schema-invalid — drop it and stop.
        if (state.nodes >= MAX_TOTAL_NODES) {
          state.droppedItems += 1;
          continue;
        }
        out.push(sanitized === OMIT_VALUE ? null : sanitized);
      }
      return out;
    }

    const out = Object.create(null) as Record<string, unknown>;
    // Scalars first, collections second. The node budget is spent in iteration order, so a large
    // array sitting earlier in the object would consume the whole budget and turn the scalars after
    // it into "[TRUNCATED]". Those scalars are the summary fields — a match `count`, a `total`, a
    // status — and a summary that degrades to a placeholder while its own sample survives is the
    // worst trade available: the caller keeps a partial list and loses the number that says the list
    // is partial. Ordering by cost makes that impossible regardless of how a producer writes its
    // object literal, so no caller has to know this rule to stay correct.
    const allKeys = Object.keys(value);
    state.droppedItems += Object.getOwnPropertySymbols(value).length;
    const keys = allKeys.slice(0, TRANSPORT_LIMITS.MAX_OBJECT_KEYS);
    // Keys past the cap are dropped — count them, like the array/Map/Set paths do, so a 5,000-key
    // store reported as 200 keys carries a droppedItems marker instead of reading as complete.
    state.droppedItems += Math.max(0, allKeys.length - keys.length);
    // Read each key's value ONCE, inside the guard. A property getter can throw — MobX strict mode,
    // a Vue reactive trap read outside a reactive context, any hostile Proxy — and that throw must
    // cost only its own key, not the whole object read. The earlier code dereferenced the getter in
    // an unguarded `isScalar` (and again in the sanitize call: two invocations, doubling side
    // effects), so one bad property lost the entire STATE_READ — the exact silent-loss shape the Date
    // guard above was written to prevent. Snapshot first, then partition scalars-before-collections.
    const read = keys.map((key) => {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) return { key, value: undefined, scalar: true, ok: false };
        const v: unknown = descriptor.value;
        return { key, value: v, scalar: null === v || typeof v !== 'object', ok: true };
      } catch {
        return { key, value: undefined, scalar: true, ok: false };
      }
    });
    for (const entry of [...read.filter((e) => e.scalar), ...read.filter((e) => !e.scalar)]) {
      if (["__proto__", "prototype", "constructor"].includes(entry.key)) {
        state.droppedItems += 1;
        continue;
      }
      const redactedKey = redactText(scrubInput(entry.key, state).slice(0, 4096));
      if (redactedKey !== entry.key) state.redacted = true;
      const safeKey = boundedString(redactedKey, state, MAX_KEY_LENGTH);
      if (!entry.ok) {
        state.truncatedValues += 1;
        out[safeKey] = UNSERIALIZABLE_VALUE;
        continue;
      }
      try {
        const sanitized = sanitize(entry.value, state, depth + 1, entry.key);
        if (sanitized !== OMIT_VALUE) out[safeKey] = sanitized;
      } catch {
        state.truncatedValues += 1;
        out[safeKey] = UNSERIALIZABLE_VALUE;
      }
    }
    return out;
  } finally {
    state.seen.delete(value);
  }
}

/**
 * What the transport caps removed from a value, if anything.
 *
 * Truncation used to be entirely silent: a 1,000-entity store came back as ~142 entities with no
 * marker and no count, and a caller comparing it against expected data would conclude the app had
 * lost the rest. A partial answer that cannot be distinguished from a complete one is the precise
 * shape of a false green — the failure this project exists to prevent — so the caps now report.
 */
export interface TruncationReport {
  /** Whole collection items not included, either past the item cap or past the node budget. */
  droppedItems: number;
  /** Values replaced by the `[TRUNCATED]` placeholder because a cap was hit inside them. */
  truncatedValues: number;
  /** Human-and-agent readable summary. Present so a consumer never has to compose one. */
  note: string;
}

/** Convert arbitrary app state into a bounded, redacted JSON-compatible value. */
export function sanitizeForTransport(value: unknown, options: SerializationOptions = {}): unknown {
  return sanitizeWithReport(value, options).value;
}

/**
 * As `sanitizeForTransport`, but also reports what the caps removed.
 *
 * Returned as a separate field rather than embedded in the value: the value has to keep the exact
 * shape the consumer's schema declares, so a marker spliced inside it would break validation on the
 * very payloads that are already under pressure.
 */
export function sanitizeWithReport(value: unknown, options: SerializationOptions = {}): {
  value: unknown;
  truncation?: TruncationReport;
  redacted?: true;
} {
  const state: SanitizeState = {
    seen: new WeakSet(),
    remainingCharacters: MAX_TOTAL_CHARACTERS,
    nodes: 0,
    droppedItems: 0,
    truncatedValues: 0,
    redacted: false,
    scrubString: options.scrubString,
  };
  let sanitized: unknown;
  try {
    sanitized = sanitize(value, state, 0);
  } catch {
    sanitized = UNSERIALIZABLE_VALUE;
    state.truncatedValues += 1;
  }
  const out = sanitized === OMIT_VALUE ? null : sanitized;
  const metadata = state.redacted ? { redacted: true as const } : {};
  if (0 === state.droppedItems && 0 === state.truncatedValues) return { value: out, ...metadata };
  const parts: string[] = [];
  if (state.droppedItems > 0) parts.push(`${state.droppedItems} item(s) dropped`);
  if (state.truncatedValues > 0) parts.push(`${state.truncatedValues} value(s) truncated`);
  return {
    value: out,
    ...metadata,
    truncation: {
      droppedItems: state.droppedItems,
      truncatedValues: state.truncatedValues,
      note: `partial — ${parts.join(', ')}; this is NOT the whole value. Scope the read with \`path\`/\`depth\` to see the rest.`,
    },
  };
}

/** Serialize without allowing cycles, BigInt, getters, or secrets to break the transport. */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(sanitizeForTransport(value));
  } catch {
    return JSON.stringify(UNSERIALIZABLE_VALUE);
  }
}

// Re-exported here: these are wire rules, not DOM rules, so they belong with
// transport rather than with the browser runtime that calls them.
// Kept on this module's surface so every existing importer inside the SDK is unaffected.
export { isSensitiveKey, scrubKnownSecrets };

/** Secret scrubbing runs before truncation, so cutting a token never defeats its recognizer. */
export function redactText(text: string): string {
  return scrubKnownSecrets(text)
    // Redact the complete scheme credential before the generic key/value pass, which
    // would otherwise remove only "Bearer" and leave an arbitrary token behind.
    .replace(/\bauthorization["']?\s*[:=]\s*["']?(?:bearer|basic)\s+[^\s"'&,;}]+/gi, `authorization: ${REDACTED_VALUE}`)
    .replace(/\b(Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=-]{16,})(?=[A-Za-z0-9._~+/=-]*[\d._~+/=-])[A-Za-z0-9._~+/=-]+/gi,
      (_match, scheme: string) => `${scheme} ${REDACTED_VALUE}`)
    .replace(/https?:\/\/[^\s<>"']+/gi, (url) => redactUrl(url))
    .replace(/(^|[\s?&#,;{"'])([A-Za-z][A-Za-z0-9_.-]{0,127})(\s*[=:]\s*["']?)([^&\s,;"'}]+)/g,
      (match, prefix: string, key: string, separator: string) =>
        isSensitiveKey(key) ? `${prefix}${key}${separator}${REDACTED_VALUE}` : match);
}

/** Apply the same wire redaction again immediately before report/flow persistence. */
export function redactForPersistence(value: unknown): unknown {
  const out = sanitizeForTransport(value);
  // The report envelope's sessionId is a generated identity. Nested sessionId fields in
  // observed application values remain credentials under the default redaction rule.
  if (typeof value === "object" && value !== null && typeof out === "object" && out !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(value, "sessionId");
    const id: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) && scrubKnownSecrets(id) === id) {
      (out as Record<string, unknown>).sessionId = id;
    }
  }
  return out;
}
