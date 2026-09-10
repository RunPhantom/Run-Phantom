/** Selective own-property path traversal for state projection.
 *
 * Shared by the browser runtime, which applies the projection BEFORE transport
 * so a scoped read of a large store is not truncated, and by the daemon for
 * compatibility with reports captured by older runtimes.
 */
/**
 * state output projection — pure, shared by the browser SDK (which applies them
 * BEFORE the transport so a scoped read of a huge store isn't truncated) and the server (back-compat
 * fallback when an older browser returns the whole store). `selectPath` walks a dot-path (with numeric
 * array indices) and, on a miss, returns the keys that WERE available at the last good level so a wrong
 * path is diagnosable rather than a bare null. `capDepth` prunes deeply-nested values to a budget.
 * `projectComponentState` strips React fiber plumbing (effect chains) from a component hook read.
 */

/** Result of walking a dot-path: the value, or a near-miss with the keys available where it stopped. */
export interface PathSelection {
  found: boolean;
  value: unknown;
  /** On a miss: the keys present at the deepest level reached (so the agent can correct the path). */
  availableKeys?: string[];
  /**
   * On a miss where `availableKeys` is a SAMPLE: how many keys were really there.
   *
   * Present only when the list was cut. `availableKeys` is capped, and without this a 10,000-key
   * store answered a wrong path with 50 names and no sign there were more — so an agent reading it
   * concludes the key it wants does not exist, when it is simply key 51. That reads as the strongest
   * possible negative signal and it is a false one, which is the precise failure this near-miss
   * payload was added to prevent.
   */
  totalKeys?: number;
}

/** Cap on how many near-miss keys travel in a failed selection — a 10k-key store must not return a
 *  10k-entry array in the error payload (that was the token blowup the near-miss exists to avoid). */
const MAX_AVAILABLE_KEYS = 50;

/**
 * The ONLY intrinsic (non-own) property a path segment may select, and only on an array or a string.
 * `todos.length` is the tool's own shipped example, so it has to resolve — but a path walks UNTRUSTED
 * app state, so this stays a closed one-name set rather than a general property read: anything wider
 * puts `constructor`/`__proto__`/`toString` (and every array method) back on the path grammar.
 */
const LENGTH_SEGMENT = 'length';

/** True where `LENGTH_SEGMENT` is a real, meaningful count — arrays and strings, nothing else. */
function hasIntrinsicLength(value: unknown): value is unknown[] | string {
  return Array.isArray(value) || 'string' === typeof value;
}

/** The keys at a level, as a bounded sample plus the true count when the sample is short. */
function keysOf(value: unknown): { keys: string[]; total: number } {
  if (Array.isArray(value)) {
    // `length` is listed because it IS selectable here — answering `["First task"]` with just `["0"]`
    // sent someone who mistyped `length` looking for a key that does not exist.
    const indices = value.slice(0, MAX_AVAILABLE_KEYS - 1).map((_, i) => String(i));
    return { keys: [...indices, LENGTH_SEGMENT], total: value.length + 1 };
  }
  if ('string' === typeof value) return { keys: [LENGTH_SEGMENT], total: 1 };
  if (value instanceof Map) {
    const keys: string[] = [];
    for (const k of value.keys()) {
      if ('string' === typeof k && keys.length < MAX_AVAILABLE_KEYS) keys.push(k);
      if (keys.length >= MAX_AVAILABLE_KEYS) break;
    }
    return { keys, total: value.size };
  }
  if ('object' === typeof value && value !== null) {
    const all = Object.keys(value);
    return { keys: all.slice(0, MAX_AVAILABLE_KEYS), total: all.length };
  }
  return { keys: [], total: 0 };
}

/** A miss, with the sample of keys available where it stopped and the count when that sample is cut. */
function miss(value: unknown): PathSelection {
  const { keys, total } = keysOf(value);
  return {
    found: false,
    value: null,
    availableKeys: keys,
    ...(total > keys.length ? { totalKeys: total } : {}),
  };
}

/**
 * Walk `path` (e.g. "captionCache.v3.0.text") into `root`. Empty path returns root unchanged.
 * Segments are own keys, canonical array indices, Map keys, or `length` on an array/string.
 */
export function selectPath(root: unknown, path: string): PathSelection {
  if (path.length > 1024) return { found: false, value: null };
  const segments = path === "" ? [] : path.split('.');
  if (segments.length > 32 || segments.some((s) => s === "" || ["__proto__", "prototype", "constructor"].includes(s))) {
    return { found: false, value: null };
  }
  let current: unknown = root;
  try {
  for (const segment of segments) {
    if (LENGTH_SEGMENT === segment && hasIntrinsicLength(current)) {
      current = current.length;
      continue;
    }
    if (Array.isArray(current)) {
      // Require a CANONICAL index string. `Number('01')`/`Number('1e0')`/`Number(' 1')` all coerce to 1,
      // so `items.01` silently read index 1 — an assertion on a path that doesn't exist quietly passed.
      // `String(index) === segment` accepts only "0","1","2",… and rejects the coercion aliases.
      const index = Number(segment);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        String(index) !== segment ||
        index >= current.length
      ) {
        return miss(current);
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, segment);
      if (!descriptor || !("value" in descriptor)) return miss(current);
      current = descriptor.value;
      continue;
    }
    if (current instanceof Map) {
      if (current.has(segment)) {
        current = current.get(segment);
        continue;
      }
      return miss(current);
    }
    // `Object.hasOwn`, not `in`: `in` walks the prototype, so a path segment of `constructor`,
    // `__proto__`, or `toString` reported found:true and returned a function from Object.prototype —
    // a state assertion on a typo'd path silently passed against a builtin instead of failing with
    // availableKeys. Only an OWN key is a real state path.
    if ('object' === typeof current && current !== null && Object.hasOwn(current, segment)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, segment);
      if (!descriptor || !("value" in descriptor)) return miss(current);
      current = descriptor.value;
      continue;
    }
    return miss(current);
  }
  return { found: true, value: current };
  } catch {
    return { found: false, value: null };
  }
}
