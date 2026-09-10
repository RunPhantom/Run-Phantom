import { describe, expect, test } from "bun:test";
import { RingBuffer } from "../src/verification/ring-buffer";
import { redactUrl, scrubKnownSecrets, buildRedactionPolicy } from "../src/verification/redaction";
import { redactForPersistence, sanitizeWithReport, safeStringify } from "../src/verification/serialization";
import { selectPath } from "../src/verification/state-select";
import { evaluatePredicate, boundEvidence } from "../src/verification/predicates";
import { parseBrowserMessage, parseCommand, parsePredicate, parseFlowSteps, validateOrigin, VerificationInputError } from "../src/verification/validation";
import { VERIFICATION_LIMITS, type Coverage, type PredicateContext, type RuntimeEvent } from "../src/verification/protocol";

const coverage: Coverage = { network: true, console: true, dom: true, state: true, signal: true, route: true };
const event = (t: number, type: string, data: Record<string, unknown> = {}, actionId?: string): RuntimeEvent =>
  ({ t, type, data, ...(actionId ? { actionId } : {}) });
const context = (events: RuntimeEvent[] = [], overrides: Partial<PredicateContext> = {}): PredicateContext =>
  ({ events, coverage, complete: true, settled: true, ...overrides });

describe("the runtime verification module bounded buffer adaptations", () => {
  test("evicts oldest events and identifies evidence lost from the requested interval", () => {
    const buffer = new RingBuffer({ maxEvents: 2 });
    buffer.push(event(1, "signal"), 1);
    buffer.push(event(2, "signal"), 2);
    buffer.push(event(3, "signal"), 3);
    expect(buffer.since(2).map((e) => e.t)).toEqual([2, 3]);
    expect(buffer.bufferHealth()).toEqual({ total: 2, dropped: 1 });
    expect(buffer.lostSince(1)).toBe(true);
    expect(buffer.lostSince(2)).toBe(false);
  });
  test("age and byte limits bound retention without losing counters", () => {
    const buffer = new RingBuffer({ maxAgeMs: 5, maxBytes: 100 });
    buffer.push(event(1, "signal"), 1, 60);
    buffer.push(event(2, "signal"), 2, 60);
    expect(buffer.since(0).map((e) => e.t)).toEqual([2]);
    buffer.push(event(10, "signal"), 10, 30);
    expect(buffer.since(0).map((e) => e.t)).toEqual([10]);
    expect(buffer.bufferHealth().dropped).toBe(2);
  });
  test("rejects invalid capacities, out-of-order cursors and oversized events before mutation", () => {
    expect(() => new RingBuffer({ maxEvents: 0 })).toThrow();
    expect(() => new RingBuffer({ maxBytes: Infinity })).toThrow();
    const buffer = new RingBuffer();
    buffer.push(event(2, "signal"), 2);
    expect(() => buffer.push(event(1, "signal"), 2)).toThrow();
    expect(() => buffer.push(event(3, "signal"), 3, VERIFICATION_LIMITS.MAX_EVENT_BYTES + 1)).toThrow();
    expect(buffer.bufferHealth()).toEqual({ total: 1, dropped: 0 });
  });
});

describe("the runtime verification module redaction and serialization adaptations", () => {
  test("URL redaction covers signed queries, userinfo, path tokens and fragments", () => {
    const input = "https://user:p@ss@local.test/reset/long-secret-token?X-Amz-Signature=hidden#access_token=hidden";
    const redacted = redactUrl(input);
    expect(redacted).not.toContain("p@ss");
    expect(redacted).not.toContain("long-secret-token");
    expect(redacted).not.toContain("hidden");
    expect(redactUrl("https://local.test/reset/form?colorToken=blue")).toBe("https://local.test/reset/form?colorToken=blue");
  });
  test("URL redaction matches percent-encoded credential path and fragment names", () => {
    expect(redactUrl("https://localhost/re%73et/long-secret-token"))
      .toBe("https://localhost/re%73et/[REDACTED]");
    expect(redactUrl("https://localhost/#access%5ftoken=arbitrary-secret"))
      .toBe("https://localhost/#access%5ftoken=[REDACTED]");
    expect(redactUrl("https://localhost/#settings?%61ccess%5Ftoken=arbitrary-secret&tab=profile"))
      .toBe("https://localhost/#settings?%61ccess%5Ftoken=[REDACTED]&tab=profile");
  });
  test("benign encoded names and malformed escapes remain unchanged without throwing", () => {
    for (const url of [
      "https://localhost/re%61d/long-public-value#color%54oken=blue",
      "https://localhost/re%73et/form#section%20one",
      "https://localhost/%E0%A4%A/long-public-value#access%ZZtoken=public",
      "https://localhost/%/long-public-value#name%=public",
    ]) expect(redactUrl(url)).toBe(url);
  });
  test("credential rules do not redact design tokens; global regex policies remain stable", () => {
    const policy = buildRedactionPolicy({ keys: [/custom/g] });
    expect(policy.isSensitiveKey("custom")).toBe(true);
    expect(policy.isSensitiveKey("custom")).toBe(true);
    expect(policy.isSensitiveKey("colorToken")).toBe(false);
    expect(policy.isSensitiveKey("accessToken")).toBe(true);
  });
  test("object and Map keys and values redact high-confidence secrets", () => {
    const secret = `sk-proj-${"A".repeat(32)}`;
    const value = { [secret]: 1, safe: secret, query: "https://localhost/path?password=hunter2", password: "hunter2", urlRaw: "raw-secret", map: new Map([[secret, 2]]) };
    const result = sanitizeWithReport(value);
    const output = JSON.stringify(result.value);
    expect(output).not.toContain(secret);
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("raw-secret");
    expect(result.redacted).toBe(true);
    expect(scrubKnownSecrets(secret)).toBe("[REDACTED]");
  });
  test("plain-text authorization redacts the entire arbitrary scheme credential", () => {
    for (const text of ["Authorization: Bearer short-secret", '"authorization": "Basic c2VjcmV0"']) {
      const result = sanitizeWithReport(text);
      expect(result.redacted).toBe(true);
      expect(String(result.value)).not.toContain("short-secret");
      expect(String(result.value)).not.toContain("c2VjcmV0");
    }
  });
  test("getters cannot execute during state serialization", () => {
    let reads = 0;
    const value = { get explosive() { reads++; throw new Error("must not run"); } };
    const result = sanitizeWithReport(value);
    expect(reads).toBe(0);
    expect(result.truncation).toBeDefined();
    expect(JSON.stringify(result.value)).toContain("UNSERIALIZABLE");
  });
  test("array accessor elements and holes are unavailable without invoking application code", () => {
    let reads = 0;
    const values = new Array(3);
    Object.defineProperty(values, "0", { enumerable: true, get() { reads++; return "side effect"; } });
    values[2] = "safe";
    const result = sanitizeWithReport(values);
    expect(reads).toBe(0);
    expect(result.value).toEqual(["[UNSERIALIZABLE]", "[UNSERIALIZABLE]", "safe"]);
    expect(result.truncation?.truncatedValues).toBe(2);
  });
  test("array slice and iterator overrides are never called", () => {
    let calls = 0;
    const values = [1, 2];
    Object.defineProperty(values, "slice", { get() { calls++; throw new Error("custom slice"); } });
    Object.defineProperty(values, Symbol.iterator, { get() { calls++; throw new Error("custom iterator"); } });
    expect(sanitizeWithReport(values).value).toEqual([1, 2]);
    expect(calls).toBe(0);
  });
  test("Map key coercion and custom collection iterators never run", () => {
    let calls = 0;
    const key = { toString() { calls++; return "coerced"; } };
    const map = new Map<unknown, unknown>([[key, "hidden"], ["safe", 1]]);
    Object.defineProperty(map, Symbol.iterator, { get() { calls++; throw new Error("custom map iterator"); } });
    Object.defineProperty(map, "size", { get() { calls++; throw new Error("custom map size"); } });
    const result = sanitizeWithReport(map);
    expect(result.value).toEqual({ safe: 1 });
    expect(result.truncation?.droppedItems).toBe(1);
    expect(calls).toBe(0);
    const set = new Set([1, 2]);
    Object.defineProperty(set, Symbol.iterator, { get() { calls++; throw new Error("custom set iterator"); } });
    Object.defineProperty(set, "size", { get() { calls++; throw new Error("custom set size"); } });
    expect(sanitizeWithReport(set).value).toEqual([1, 2]);
    expect(calls).toBe(0);
  });
  test("typed-array iterator and length overrides are never called", () => {
    let calls = 0;
    const values = new Uint8Array([1, 2]);
    Object.defineProperty(values, Symbol.iterator, { get() { calls++; throw new Error("custom typed-array iterator"); } });
    Object.defineProperty(values, "length", { get() { calls++; throw new Error("custom length"); } });
    expect(sanitizeWithReport(values).value).toEqual([1, 2]);
    expect(calls).toBe(0);
  });
  test("Date overrides and Error accessors do not execute during observation", () => {
    let calls = 0;
    const date = new Date(0);
    Object.defineProperty(date, "getTime", { get() { calls++; throw new Error("custom date method"); } });
    Object.defineProperty(date, "toISOString", { get() { calls++; throw new Error("custom date formatter"); } });
    expect(sanitizeWithReport(date).value).toBe("1970-01-01T00:00:00.000Z");
    const error = new Error("original");
    Object.defineProperty(error, "name", { get() { calls++; return "custom name"; } });
    Object.defineProperty(error, "message", { get() { calls++; return "custom message"; } });
    const result = sanitizeWithReport(error);
    expect(result.value).toEqual({ name: "[UNSERIALIZABLE]", message: "[UNSERIALIZABLE]" });
    expect(result.truncation).toBeDefined();
    expect(calls).toBe(0);
  });
  test("prototype-shaped application keys are omitted with explicit loss", () => {
    const value = JSON.parse('{"safe":1,"__proto__":{"polluted":true},"constructor":"x"}');
    const result = sanitizeWithReport(value);
    expect(result.value).toEqual({ safe: 1 });
    expect(result.truncation?.droppedItems).toBe(2);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
  test("lossy null conversions, omissions and cycles always carry incompleteness", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [NaN, Infinity, undefined, () => 1, Symbol("x"), new Date(NaN), cyclic, { missing: undefined }]) {
      expect(sanitizeWithReport(value).truncation).toBeDefined();
    }
  });
  test("opaque built-ins cannot silently become an empty observed object", () => {
    for (const value of [/regex/, new URL("https://localhost"), new ArrayBuffer(8), new DataView(new ArrayBuffer(8))]) {
      const result = sanitizeWithReport(value);
      expect(result.truncation).toBeDefined();
      expect(result.value).toBe("[UNSERIALIZABLE]");
      const observed = { ...event(1, "state", { store: "app", value: result.value }), truncated: Boolean(result.truncation) };
      expect(evaluatePredicate({ kind: "state", store: "app", path: "", equals: {} }, context([observed])).status).toBe("inconclusive");
    }
  });
  test("fill scrubbing runs on strings and keys before truncation", () => {
    const secret = "entered text ".repeat(250);
    const value = { [secret]: 1, echo: "a".repeat(3000) + secret + "tail" };
    const result = sanitizeWithReport(value, { scrubString: (text) => text.split(secret).join("[REDACTED]") });
    const encoded = JSON.stringify(result.value);
    expect(encoded).not.toContain("entered text");
    expect(result.redacted).toBe(true);
  });
  test("large strings and collections have explicit bounded output", () => {
    const result = sanitizeWithReport({ values: Array.from({ length: 10000 }, (_, i) => i), text: "x".repeat(100000) });
    expect(result.truncation).toBeDefined();
    expect(new TextEncoder().encode(JSON.stringify(result.value)).byteLength).toBeLessThan(VERIFICATION_LIMITS.MAX_EVENT_BYTES);
    expect(() => safeStringify({ n: 1n })).not.toThrow();
  });
  test("persistence preserves report session identity but redacts observed session credentials", () => {
    const result = redactForPersistence({ id: "report-1", sessionId: "session-1", data: { sessionId: "credential", token: "hidden" } });
    expect(result).toEqual({ id: "report-1", sessionId: "session-1", data: { sessionId: "[REDACTED]", token: "[REDACTED]" } });
  });
});

describe("own-property state selection", () => {
  test("allows canonical array indices and length but rejects inherited/prototype paths", () => {
    const value = Object.assign(Object.create({ inherited: 1 }), { todos: ["first", "second"] });
    expect(selectPath(value, "todos.1")).toEqual({ found: true, value: "second" });
    expect(selectPath(value, "todos.length")).toEqual({ found: true, value: 2 });
    for (const path of ["inherited", "constructor", "__proto__", "todos.01", "todos.1e0", "todos..1"]) {
      expect(selectPath(value, path).found).toBe(false);
    }
  });
  test("does not invoke getters or treat an array hole as an observed value", () => {
    let reads = 0;
    expect(selectPath({ get value() { reads++; return true; } }, "value").found).toBe(false);
    expect(reads).toBe(0);
    expect(selectPath(new Array(3), "1").found).toBe(false);
  });
});

describe("strict verification input contracts", () => {
  test("accepts live fill while refusing every saved fill command", () => {
    expect(parseCommand({ type: "fill", selector: "#name", value: "Ada" })).toEqual({ type: "fill", selector: "#name", value: "Ada" });
    expect(() => parseFlowSteps([{ command: { type: "fill", selector: "#name", value: "Ada" }, predicate: { kind: "signal", name: "saved" } }])).toThrow("fill");
  });
  test("rejects credential selectors, state paths and value-shaped credentials in saved flows", () => {
    for (const predicate of [
      { kind: "element", selector: 'input[type="password"]', state: "present" },
      { kind: "state", store: "auth", path: "accessToken", equals: "abc" },
      { kind: "state", store: "app", path: "value", equals: `sk-proj-${"A".repeat(32)}` },
    ]) expect(() => parseFlowSteps([{ predicate }])).toThrow(VerificationInputError);
  });
  test("saved selectors cannot hide credential fields behind CSS escapes", () => {
    for (const selector of ["#pass\\77ord", 'input[name="pass\\77ord"]', '[data-pass\\77ord="arbitrary-value"]']) {
      expect(() => parseFlowSteps([{ predicate: { kind: "element", selector, state: "present" } }])).toThrow("escaped selectors");
    }
    const steps = [{ command: { type: "click", selector: '[data-testid="checkout"]' }, predicate: { kind: "signal", name: "saved" } }];
    expect(parseFlowSteps(steps)).toEqual(steps);
  });
  test("rejects vacuous composites, typo fields, unsupported methods and prototype paths", () => {
    for (const predicate of [
      { kind: "allOf", predicates: [] },
      { kind: "signal", name: "saved", typo: true },
      { kind: "network", urlContains: "/save", status: NaN },
      { kind: "state", store: "app", path: "constructor.name", equals: "Object" },
      JSON.parse('{"kind":"signal","name":"saved","__proto__":{}}'),
    ]) expect(() => parsePredicate(predicate)).toThrow(VerificationInputError);
    expect(() => parseCommand({ type: "eval", expression: "1+1" })).toThrow(VerificationInputError);
  });
  test("deep predicates and non-JSON expectations cannot consume unbounded work", () => {
    let predicate: unknown = { kind: "signal", name: "ok" };
    for (let i = 0; i < 20; i++) predicate = { kind: "allOf", predicates: [predicate] };
    expect(() => parsePredicate(predicate)).toThrow("complexity");
    expect(() => parsePredicate({ kind: "state", store: "app", path: "", equals: { fn() {} } })).toThrow();
  });
  test("browser event schemas refuse forged clocks and require request-start identity", () => {
    const request = { type: "network.start", data: { requestId: "req-1", url: "/api", method: "GET", initiator: "fetch" }, actionId: "action-1" };
    expect(parseBrowserMessage({ type: "event", event: request }).type).toBe("event");
    expect(() => parseBrowserMessage({ type: "event", event: { ...request, t: 100 } })).toThrow();
    expect(() => parseBrowserMessage({ type: "event", event: { type: "network.start", data: { url: "/api" } } })).toThrow();
    expect(() => parseBrowserMessage({ type: "event", event: { type: "action.boundary", data: {} } })).toThrow();
  });
  test("hello coverage is exhaustive and loopback origins reject credentials and suffix lookalikes", () => {
    expect(parseBrowserMessage({ type: "hello", version: 1, token: "session-token", coverage }).type).toBe("hello");
    expect(() => parseBrowserMessage({ type: "hello", version: 1, token: "session-token", coverage: { network: true } })).toThrow();
    expect(validateOrigin("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(validateOrigin("http://[::1]:3000")).toBe("http://[::1]:3000");
    for (const origin of ["http://localhost.evil.test", "https://user:pass@localhost", "http://localhost/app", "file:///app"]) expect(() => validateOrigin(origin)).toThrow();
  });
});

describe("tri-state application assertions", () => {
  const network = { kind: "network", urlContains: "/checkout", method: "POST", status: 200 } as const;
  const requestData = { requestId: "req-1", url: "/checkout", method: "POST", status: 200, ok: true };
  test("requires fresh start and completion identity within the current action", () => {
    const start = event(1, "network.start", requestData, "old");
    const complete = event(2, "network", requestData, "old");
    expect(evaluatePredicate(network, context([complete])).status).toBe("fail");
    expect(evaluatePredicate(network, context([start, complete], { actionId: "new" })).status).toBe("fail");
    expect(evaluatePredicate(network, context([start, complete], { actionId: "old" })).status).toBe("pass");
    expect(evaluatePredicate(network, context([start, event(3, "network", { ...requestData, requestId: "different" }, "old")])).status).toBe("fail");
  });
  test("network outcomes fail for observed HTTP errors but remain inconclusive while pending", () => {
    const events = [event(1, "network.start", requestData), event(2, "network", { ...requestData, status: 500, ok: false })];
    expect(evaluatePredicate(network, context(events)).status).toBe("fail");
    expect(evaluatePredicate(network, context(events, { settled: false })).status).toBe("inconclusive");
  });
  test("negative console assertions wait for quiet and retain fail evidence", () => {
    const predicate = { kind: "console", level: "error", absent: true } as const;
    expect(evaluatePredicate(predicate, context([], { settled: false })).status).toBe("inconclusive");
    expect(evaluatePredicate(predicate, context([], { coverage: { ...coverage, network: false } })).status).toBe("inconclusive");
    expect(evaluatePredicate(predicate, context()).status).toBe("pass");
    expect(evaluatePredicate(predicate, context([event(1, "console", { level: "error", message: "boom" })])).status).toBe("fail");
  });
  test("missing coverage and lost evidence cannot become passing assertions", () => {
    const predicate = { kind: "signal", name: "done" } as const;
    const events = [event(1, "signal", { name: "done" })];
    expect(evaluatePredicate(predicate, context(events, { complete: false })).status).toBe("inconclusive");
    expect(evaluatePredicate(predicate, context(events, { coverage: { ...coverage, signal: false } })).status).toBe("inconclusive");
    expect(evaluatePredicate(predicate, context([...events, event(2, "observer.error", { observer: "signal", message: "broken" })])).status).toBe("inconclusive");
  });
  test("redacted, missing, truncated and prototype state values are inconclusive", () => {
    for (const value of [{ secret: "[REDACTED]" }, {}, { secret: "[TRUNCATED]" }]) {
      const predicate = { kind: "state", store: "app", path: "secret", equals: "[REDACTED]" } as const;
      expect(evaluatePredicate(predicate, context([event(1, "state", { store: "app", value })])).status).toBe("inconclusive");
    }
    const predicate = { kind: "state", store: "app", path: "value", equals: null } as const;
    const observed = event(1, "state", { store: "app", value: { value: null } });
    expect(evaluatePredicate(predicate, context([{ ...observed, truncated: true }])).status).toBe("inconclusive");
    expect(evaluatePredicate(predicate, context([observed])).status).toBe("pass");
  });
  test("state equality is strict and only the latest store read decides", () => {
    const predicate = { kind: "state", store: "app", path: "cart", equals: { count: 1 } } as const;
    const events = [event(1, "state", { store: "app", value: { cart: { count: 1 } } }), event(2, "state", { store: "app", value: { cart: { count: 2 } } })];
    expect(evaluatePredicate(predicate, context(events)).status).toBe("fail");
    const extraFields = [event(1, "state", { store: "app", value: { cart: { count: 1, extra: true } } })];
    expect(evaluatePredicate(predicate, context(extraFields)).status).toBe("fail");
  });
  test("element absence needs an exact selector read and a quiet interval", () => {
    const predicate = { kind: "element", selector: "#toast", state: "absent" } as const;
    expect(evaluatePredicate(predicate, context()).status).toBe("inconclusive");
    const events = [event(1, "dom", { selector: "#toast", count: 0 })];
    expect(evaluatePredicate(predicate, context(events, { settled: false })).status).toBe("inconclusive");
    expect(evaluatePredicate(predicate, context(events)).status).toBe("pass");
  });
  test("composites preserve unknown branches without hiding decisive alternatives", () => {
    const yes = { kind: "signal", name: "done" } as const;
    const unknown = { kind: "state", store: "missing", path: "x", equals: 1 } as const;
    const events = [event(1, "signal", { name: "done" })];
    expect(evaluatePredicate({ kind: "allOf", predicates: [yes, unknown] }, context(events)).status).toBe("inconclusive");
    expect(evaluatePredicate({ kind: "anyOf", predicates: [yes, unknown] }, context(events)).status).toBe("pass");
    expect(evaluatePredicate({ kind: "anyOf", predicates: [{ kind: "signal", name: "absent" }, unknown] }, context(events)).status).toBe("inconclusive");
  });
  test("report evidence remains bounded and redacted", () => {
    const secret = `sk-proj-${"B".repeat(32)}`;
    const events = Array.from({ length: 100 }, (_, i) => event(i, "console", { level: "error", message: secret }));
    const evidence = boundEvidence(events);
    expect(evidence.length).toBeLessThanOrEqual(30);
    expect(new TextEncoder().encode(JSON.stringify(evidence)).byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(JSON.stringify(evidence)).not.toContain(secret);
  });
});
