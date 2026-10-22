import { describe, expect, test } from "bun:test";
import { buildRedactionPolicy, setActiveRedactionPolicy, resetActiveRedactionPolicy } from "../src/verification/redaction";
import { canonicalQueryKey, piniaStore, shapeStore, readStoreAdapter } from "../src/verification/browser/store-adapters";

describe("explicit state adapter boundaries", () => {
  test("structured keys distinguish delimiter, type and array order while canonicalizing object order", () => {
    expect(canonicalQueryKey(["a/b", "c"])).not.toBe(canonicalQueryKey(["a", "b/c"]));
    expect(canonicalQueryKey([1])).not.toBe(canonicalQueryKey(["1"]));
    expect(canonicalQueryKey([{ b: 2, a: 1 }])).toBe(canonicalQueryKey([{ a: 1, b: 2 }]));
    expect(canonicalQueryKey([1, 2])).not.toBe(canonicalQueryKey([2, 1]));
  });
  test("keys refuse accessors, cycles, coercion and large values without calling application getters", () => {
    let called = 0;
    const value = Object.defineProperty({}, "x", { enumerable: true, get() { called++; return "secret"; } });
    expect(() => canonicalQueryKey([value])).toThrow();
    const cyclic: unknown[] = []; cyclic.push(cyclic);
    expect(() => canonicalQueryKey(cyclic)).toThrow();
    expect(() => canonicalQueryKey(["x".repeat(513)])).toThrow();
    expect(() => canonicalQueryKey([undefined])).toThrow();
    expect(called).toBe(0);
  });
  test("mutable selected Pinia state has a frozen prior value and no unrelated state disclosure", () => {
    const state = { count: 1, nested: { value: 2 }, privateBody: "never expose" };
    const source = { $state: state, $subscribe: () => () => {} };
    const adapter = piniaStore(source, { select: { count: "count", nested: "nested.value" } });
    const first = readStoreAdapter(adapter);
    state.count = 3; state.nested.value = 4;
    expect(first.availability).toBe("complete");
    expect(first.value).toMatchObject({ values: { count: 1, nested: 2 } });
    expect(readStoreAdapter(adapter).value).toMatchObject({ values: { count: 3, nested: 4 } });
    expect(JSON.stringify(first)).not.toContain("never expose");
    expect(Object.isFrozen(first.value)).toBe(true);
  });
  test("selected nested getter is unavailable and never invoked", () => {
    let called = 0;
    const state = Object.defineProperty({}, "count", { enumerable: true, get() { called++; return 1; } });
    const adapter = shapeStore({ getState: () => state, subscribe: () => () => {} }, { select: { count: "count" } });
    expect(readStoreAdapter(adapter).availability).toBe("unavailable");
    expect(called).toBe(0);
  });
  test("one result budget refuses aggregate cross products and never returns live fallback", () => {
    const state: Record<string, unknown> = {};
    for (let n = 0; n < 20; n++) state[`p${n}`] = Array.from({ length: 40 }, (_, i) => i);
    const select = Object.fromEntries(Object.keys(state).map(key => [key, key]));
    const adapter = shapeStore({ getState: () => state, subscribe: () => () => {} }, { select });
    const snapshot = readStoreAdapter(adapter);
    expect(snapshot.availability).toBe("unavailable");
    expect(snapshot.value).toBeNull();
  });
  test("cycles and oversized actual UTF-8 selected snapshots stay unavailable", () => {
    const state: Record<string, unknown> = {}; state.self = state;
    const source = { getState: () => state, subscribe: () => () => {} };
    expect(readStoreAdapter(shapeStore(source, { select: { root: "" } })).availability).toBe("unavailable");
    state.self = "🙂".repeat(4000);
    expect(readStoreAdapter(shapeStore(source, { select: { root: "" } })).availability).not.toBe("complete");
  });
});

import { QueryClient } from "../app/node_modules/@tanstack/react-query";
import { queryStore, storeAdapterDetails } from "../src/verification/browser/store-adapters";

describe("actual installed QueryClient explicit projections", () => {
  test("selected exact keys retain status and invalidation freshness without default data or message capture", async () => {
    const client = new QueryClient();
    await client.fetchQuery({ queryKey: ["orders", { page: 1 }], queryFn: () => ({ count: 2, privateBody: "unselected business body" }) });
    const adapter = queryStore(client, { keys: [{ queryKey: ["orders", { page: 1 }] }] });
    const first = readStoreAdapter(adapter);
    expect(first.availability).toBe("complete");
    expect(first.value).toMatchObject({ queries: [{ status: "success", fetchStatus: "idle", isStale: false, hasError: false }] });
    expect(JSON.stringify(first)).not.toContain("unselected business body");
    await client.invalidateQueries({ queryKey: ["orders"], refetchType: "none" });
    expect(readStoreAdapter(adapter).value).toMatchObject({ queries: [{ isStale: true }] });
    expect(first.value).toMatchObject({ queries: [{ isStale: false }] });
    client.clear();
  });
  test("explicit selected data observes both old and new frozen values through the actual cache", () => {
    const client = new QueryClient(); const key = ["count"];
    client.setQueryData(key, { count: 1, hidden: "private" });
    const adapter = queryStore(client, { keys: [{ queryKey: key, select: { count: "count" } }] });
    const first = readStoreAdapter(adapter);
    client.setQueryData(key, { count: 2, hidden: "private" });
    expect(first.value).toMatchObject({ queries: [{ values: { count: 1 } }] });
    expect(readStoreAdapter(adapter).value).toMatchObject({ queries: [{ values: { count: 2 } }] });
    expect(JSON.stringify(first)).not.toContain("private"); client.clear();
  });
  test("actual fetch-in-progress, error and explicitly requested error message remain distinct", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let release!: (value: number) => void;
    const pending = client.fetchQuery({ queryKey: ["pending"], queryFn: () => new Promise<number>(resolve => { release = resolve; }) });
    const adapter = queryStore(client, { keys: [{ queryKey: ["pending"] }] });
    expect(readStoreAdapter(adapter).value).toMatchObject({ queries: [{ status: "pending", fetchStatus: "fetching" }] });
    release(1); await pending;
    await client.fetchQuery({ queryKey: ["error"], queryFn: () => Promise.reject(new Error("ordinary app failure")) }).catch(() => {});
    const redacted = queryStore(client, { keys: [{ queryKey: ["error"] }] });
    expect(readStoreAdapter(redacted).value).toMatchObject({ queries: [{ status: "error", hasError: true }] });
    expect(JSON.stringify(readStoreAdapter(redacted))).not.toContain("ordinary app failure");
    const explicit = queryStore(client, { keys: [{ queryKey: ["error"] }], includeErrorMessage: true });
    expect(readStoreAdapter(explicit).value).toMatchObject({ queries: [{ errorMessage: "ordinary app failure" }] }); client.clear();
  });
  test("missing selected query and custom hash collision stay unavailable", () => {
    const client = new QueryClient({ defaultOptions: { queries: { queryKeyHashFn: () => "collision" } } });
    client.setQueryData(["first"], 1);
    const adapter = queryStore(client, { keys: [{ queryKey: ["second"] }] });
    expect(readStoreAdapter(adapter).availability).toBe("partial");
    expect(JSON.stringify(readStoreAdapter(adapter))).not.toContain('"status":"success"'); client.clear();
    const missing = queryStore(new QueryClient(), { keys: [{ queryKey: ["missing"] }] });
    expect(readStoreAdapter(missing).availability).toBe("partial");
  });
  test("cache replacement is refused and a failed exact lookup cannot turn into empty state", () => {
    const client = new QueryClient(); client.setQueryData(["safe"], 1);
    let cache: object = client.getQueryCache();
    const source = { getQueryCache: () => cache, defaultQueryOptions: (options: { queryKey: readonly unknown[] }) => client.defaultQueryOptions(options) };
    const adapter = queryStore(source, { keys: [{ queryKey: ["safe"] }] });
    expect(readStoreAdapter(adapter).availability).toBe("complete");
    cache = new QueryClient().getQueryCache();
    expect(readStoreAdapter(adapter).availability).toBe("unavailable"); client.clear();
  });
  test("query lookup never enumerates whole caches, even when unrelated cache is large", () => {
    const client = new QueryClient(); client.setQueryData(["safe"], 1);
    const cache = client.getQueryCache();
    let enumerations = 0;
    cache.getAll = () => { enumerations++; throw new Error("must not enumerate"); };
    const adapter = queryStore(client, { keys: [{ queryKey: ["safe"] }] });
    expect(readStoreAdapter(adapter).availability).toBe("complete");
    expect(enumerations).toBe(0);
  });
});

describe("closed adapter inputs and aggregate limits", () => {
  test("sparse/extra/prototype/toJSON/non-finite keys refuse with no coercion", () => {
    let calls = 0;
    const poison = { toJSON() { calls++; return "x"; }, toString() { calls++; return "x"; } };
    for (const key of [[NaN], [Infinity], [new Date()], [poison], Array(1), [Symbol("x")], [1n], [() => 1], [Object.create({ count: 1 })]]) {
      expect(() => canonicalQueryKey(key)).toThrow();
    }
    const extra: unknown[] & { extra?: string } = [1]; extra.extra = "bad";
    expect(() => canonicalQueryKey(extra)).toThrow();
    expect(calls).toBe(0);
  });
  test("deep, node, collection and multibyte canonical keys refuse", () => {
    expect(() => canonicalQueryKey([[ [[[1]]] ]])).toThrow();
    expect(() => canonicalQueryKey(Array.from({ length: 33 }, (_, n) => n))).toThrow();
    expect(() => canonicalQueryKey(Array.from({ length: 4 }, () => Array.from({ length: 30 }, () => 1)))).toThrow();
    expect(() => canonicalQueryKey(["🙂".repeat(256), "🙂".repeat(256)])).toThrow();
  });
  test("options and labels are closed, paths are own-data-only and registration inputs do not execute getters", () => {
    const source = { getState: () => ({ count: 1 }), subscribe: () => () => {} };
    let called = 0;
    const options = Object.defineProperty({}, "select", { get() { called++; return { count: "count" }; } });
    expect(() => shapeStore(source, options as { select: Record<string, string> })).toThrow();
    expect(() => shapeStore(source, { select: { inherited: "__proto__.count" } })).toThrow();
    expect(() => shapeStore(source, { select: {} })).toThrow();
    expect(() => shapeStore(source, { select: { "bad.name": "count" } })).toThrow();
    expect(called).toBe(0);
  });
  test("query admission rejects duplicate keys, oversized total key bytes and multiplied path budgets", () => {
    const client = new QueryClient();
    expect(() => queryStore(client, { keys: [{ queryKey: [1] }, { queryKey: [1] }] })).toThrow();
    expect(() => queryStore(client, { keys: Array.from({ length: 21 }, (_, n) => ({ queryKey: [n] })) })).toThrow();
    expect(() => queryStore(client, { keys: Array.from({ length: 12 }, (_, n) => ({ queryKey: [n, "x".repeat(500)] })) })).toThrow();
    const select = Object.fromEntries(Array.from({ length: 11 }, (_, n) => [`n${n}`, `n${n}`]));
    expect(() => queryStore(client, { keys: [{ queryKey: [1], select }, { queryKey: [2], select }] })).toThrow();
  });
  test("configured source operations may throw, while malicious metadata never coerces or invokes accessors", () => {
    let called = 0;
    const state = { status: { toString() { called++; return "success"; } }, fetchStatus: "idle", dataUpdatedAt: 1, error: null };
    const query = { queryKey: ["x"], state, isStale: () => false };
    const cache = { get: () => query, subscribe: () => () => {} };
    const adapter = queryStore({ getQueryCache: () => cache, defaultQueryOptions: () => ({ queryHash: "x" }) }, { keys: [{ queryKey: ["x"] }] });
    expect(readStoreAdapter(adapter).availability).toBe("partial"); expect(called).toBe(0);
    expect(readStoreAdapter(shapeStore({ getState() { throw new Error("private source failure"); }, subscribe: () => () => {} }, { select: { root: "" } })).value).toBeNull();
  });
  test("Pinia uses its single explicit public accessor, sync detached subscription and acquired cleanup", () => {
    let reads = 0, unsubscribed = 0;
    let options: unknown;
    const source = { get $state() { reads++; return { count: 1 }; }, $subscribe(_listener: unknown, opts: unknown) { options = opts; return () => { unsubscribed++; }; } };
    const adapter = piniaStore(source, { select: { count: "count" } });
    expect(readStoreAdapter(adapter).availability).toBe("complete");
    expect(reads).toBe(1);
    storeAdapterDetails(adapter)!.subscribe(() => {})();
    expect(options).toEqual({ detached: true, flush: "sync" }); expect(unsubscribed).toBe(1);
  });
});

test("selected credential paths and renamed credential labels cannot bypass the mandatory redaction floor", () => {
  let reads = 0;
  const source = { getState: () => { reads++; return { password: "arbitrary private value" }; }, subscribe: () => () => {} };
  expect(() => shapeStore(source, { select: { count: "password" } })).toThrow();
  expect(() => shapeStore(source, { select: { count: "account.sessionId" } })).toThrow();
  expect(() => shapeStore(source, { select: { password: "count" } })).toThrow();
  expect(() => queryStore(new QueryClient(), { keys: [{ queryKey: ["account"], select: { ordinary: "password" } }] })).toThrow();
  expect(reads).toBe(0);
});


test("actual QueryClient private keys stay exact while public identities ignore sensitive-field exemptions", () => {
  const client = new QueryClient();
  const firstKey = ["account", { nested: { password: "f23-private-password", apiKey: "f23-private-api-key", token: "f23-private-token" } }];
  const secondKey = ["account", { nested: { password: "f23-second-password", apiKey: "f23-second-api-key", token: "f23-second-token" } }];
  setActiveRedactionPolicy(buildRedactionPolicy({ allow: ["password", "apiKey", "token"] }));
  try {
    client.setQueryData(firstKey, { count: 1 }); client.setQueryData(secondKey, { count: 2 });
    const adapter = queryStore(client, { keys: [{ queryKey: firstKey, select: { count: "count" } }, { queryKey: secondKey, select: { count: "count" } }] });
    expect(canonicalQueryKey(firstKey)).not.toBe(canonicalQueryKey(secondKey));
    const reading = readStoreAdapter(adapter);
    expect(JSON.stringify(reading)).not.toContain("f23-private-password");
    expect(reading.availability).toBe("partial");
    expect(reading.value).toMatchObject({ queries: [{ values: { count: 1 }, key: ["account", { nested: { password: "[REDACTED]", apiKey: "[REDACTED]", token: "[REDACTED]" } }] }, { values: { count: 2 } }] });
    for (const value of ["f23-private-password", "f23-private-api-key", "f23-private-token", "f23-second-password", "f23-second-api-key", "f23-second-token"]) expect(JSON.stringify(reading)).not.toContain(value);
    client.setQueryData(firstKey, { count: 3 });
    expect(readStoreAdapter(adapter).value).toMatchObject({ queries: [{ values: { count: 3 } }, { values: { count: 2 } }] });
  } finally { resetActiveRedactionPolicy(); client.clear(); }
});


test("selection privacy floor cannot be disabled by application exemptions", () => {
  let reads = 0;
  setActiveRedactionPolicy(buildRedactionPolicy({ allow: ["password", "apiKey", "token"] }));
  try {
    const source = { getState: () => { reads++; return { password: "f23-selected-password" }; }, subscribe: () => () => {} };
    expect(() => shapeStore(source, { select: { ordinary: "password" } })).toThrow();
    expect(() => shapeStore(source, { select: { password: "ordinary" } })).toThrow();
    expect(() => queryStore(new QueryClient(), { keys: [{ queryKey: ["profile"], select: { ordinary: "nested.apiKey" } }] })).toThrow();
    expect(reads).toBe(0);
  } finally { resetActiveRedactionPolicy(); }
});

test("known credential values in actual query keys are scrubbed before public identity encoding", () => {
  const client = new QueryClient(); const filler = `sk-proj-${"test".repeat(12)}`;
  const key = ["profile", { ordinary: filler }]; client.setQueryData(key, { count: 1 });
  const adapter = queryStore(client, { keys: [{ queryKey: key, select: { count: "count" } }] });
  expect(canonicalQueryKey(key)).toContain(filler);
  const reading = readStoreAdapter(adapter);
  expect(reading.availability).toBe("partial"); expect(JSON.stringify(reading)).not.toContain(filler);
  expect(reading.value).toMatchObject({ queries: [{ values: { count: 1 }, key: ["profile", { ordinary: "[REDACTED]" }] }] });
  client.clear();
});


test("actual QueryClient message opt-in refuses objects, getters and oversize text without disclosing error bodies", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let getters = 0;
  const errors = [{ message: { ordinary: "private nested message body" }, body: "unselected error body" },
    { message: "x".repeat(1001), body: "unselected error body" },
    Object.defineProperty({}, "message", { get() { getters++; return "private accessor message"; } })];
  try {
    for (let n = 0; n < errors.length; n++) {
      const key = ["invalid-message", n];
      // Negative fixture: the cache must retain an application's malformed non-Error rejection.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      await client.fetchQuery({ queryKey: key, queryFn: () => Promise.reject(errors[n]) }).catch(() => {});
      const defaultReading = readStoreAdapter(queryStore(client, { keys: [{ queryKey: key }] }));
      expect(defaultReading.availability).toBe("complete"); expect(defaultReading.value).toMatchObject({ queries: [{ status: "error", hasError: true }] });
      const explicit = readStoreAdapter(queryStore(client, { keys: [{ queryKey: key }], includeErrorMessage: true }));
      expect(JSON.stringify(explicit)).not.toContain("private nested message body");
      expect(explicit.availability).toBe("partial");
      expect(explicit.value).toMatchObject({ queries: [{ availability: "unavailable", reason: "query-unavailable" }] });
      expect(JSON.stringify(explicit)).not.toContain("private"); expect(JSON.stringify(explicit)).not.toContain("unselected error body");
    }
    expect(getters).toBe(0);
    for (const message of ["", "x".repeat(1000)]) {
      const key = ["bounded-message", message.length];
      // The accepted string field is checked independently of the application's error class.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      await client.fetchQuery({ queryKey: key, queryFn: () => Promise.reject({ message, body: "unselected error body" }) }).catch(() => {});
      const reading = readStoreAdapter(queryStore(client, { keys: [{ queryKey: key }], includeErrorMessage: true }));
      expect(reading.availability).toBe("complete"); expect(reading.value).toMatchObject({ queries: [{ status: "error", errorMessage: message }] });
      expect(JSON.stringify(reading)).not.toContain("unselected error body");
    }
  } finally { client.clear(); }
});
