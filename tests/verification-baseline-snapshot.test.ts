import { describe, expect, test } from "bun:test";
import { BaselineInputError, captureBaselineReading, captureBaselineScope, type ReadingMetadata } from "../src/verification/baseline";

const metadata = (overrides: Partial<ReadingMetadata> = {}): ReadingMetadata => ({
  scope: { sessionId: "app-1", generation: 2, kind: "state", target: "cart", path: "items" },
  cursor: 100, fresh: true, complete: true, ...overrides,
});

describe("immutable verification baseline readings", () => {
  test("later app mutations cannot rewrite captured nested values or scope identity", () => {
    const source = { items: [{ count: 1 }], saved: false };
    const meta = metadata();
    const reading = captureBaselineReading(meta, source);
    source.items[0].count = 9;
    source.items.push({ count: 5 });
    (meta.scope as { target: string }).target = "other-store";
    expect(reading.value).toEqual({ items: [{ count: 1 }], saved: false });
    expect(reading.scope.target).toBe("cart");
    expect(Object.isFrozen(reading)).toBe(true);
    expect(Object.isFrozen(reading.scope)).toBe(true);
    expect(Object.isFrozen(reading.value)).toBe(true);
    expect(Object.isFrozen((reading.value as { items: readonly unknown[] }).items[0])).toBe(true);
  });

  test("null, zero, false and empty text remain genuine complete JSON observations", () => {
    for (const value of [null, 0, false, ""]) {
      const reading = captureBaselineReading(metadata(), value);
      expect(reading.availability).toBe("complete");
      expect(reading.value).toBe(value);
    }
  });

  test("application accessors and toJSON methods cannot execute during capture", () => {
    let calls = 0;
    const accessor = { get value() { calls++; return 1; } };
    const coercion = { toJSON() { calls++; return { value: 1 }; } };
    const nested = [accessor];
    for (const value of [accessor, coercion, nested]) expect(captureBaselineReading(metadata(), value).availability).toBe("unavailable");
    expect(calls).toBe(0);
    const hidden = Object.defineProperty({}, "hidden", { get() { calls++; return 1; } });
    expect(captureBaselineReading(metadata(), hidden).availability).toBe("unavailable");
    expect(calls).toBe(0);
  });

  test("cycles, non-JSON collections, non-finite numbers and sparse arrays stay unavailable", () => {
    const cycle: { self?: unknown } = {}; cycle.self = cycle;
    const sparse = new Array(3);
    for (const value of [cycle, new Map([["count", 1]]), new Set([1]), new Date(), new Uint8Array([1]), NaN, Infinity, -Infinity, 1n, undefined, sparse]) {
      const reading = captureBaselineReading(metadata(), value);
      expect(reading.availability).toBe("unavailable");
      expect(reading.value).toBeNull();
      expect(reading.unavailableReason).toBe("non-json");
    }
  });

  test("prototype and inherited fields cannot alter a captured JSON shape", () => {
    const poison = JSON.parse('{"__proto__":{"polluted":true}}') as unknown;
    for (const value of [poison, { constructor: "fake" }, Object.create({ inherited: 1 }) as unknown]) {
      expect(captureBaselineReading(metadata(), value).availability).toBe("unavailable");
    }
    const plain = Object.create(null) as { count: number }; plain.count = 1;
    expect(captureBaselineReading(metadata(), plain).value).toEqual({ count: 1 });
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  test("credential redaction is disclosed and a sanitized partial value cannot become complete", () => {
    const reading = captureBaselineReading(metadata(), { password: "private-fixture", value: "ordinary" });
    expect(reading.availability).toBe("partial");
    expect(reading.redacted).toBe(true);
    expect(JSON.stringify(reading)).not.toContain("private-fixture");
    expect(captureBaselineReading(metadata({ truncated: true }), 1).availability).toBe("partial");
    expect(captureBaselineReading(metadata({ redacted: true }), 1).availability).toBe("partial");
    expect(captureBaselineReading(metadata(), { count: "[REDACTED]" }).availability).toBe("partial");
    expect(captureBaselineReading(metadata({ complete: false }), 1)).toMatchObject({ availability: "unavailable", unavailableReason: "capture-incomplete", value: null });
  });

  test("collection, depth, node and actual UTF-8 limits disclose lost evidence", () => {
    const wide = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`field${i}`, i]));
    let deep: unknown = 1;
    for (let i = 0; i < 10; i++) deep = { child: deep };
    const manyNodes = Array.from({ length: 100 }, () => [1, 2, 3, 4, 5]);
    const utf8 = Array.from({ length: 5 }, () => "界".repeat(1300));
    for (const value of [wide, Array.from({ length: 101 }, () => 1), deep, manyNodes, utf8, "x".repeat(4097)]) {
      expect(captureBaselineReading(metadata(), value)).toMatchObject({ availability: "unavailable", unavailableReason: "limit" });
    }
  });

  test("freshness is retained independently of value completeness", () => {
    const stale = captureBaselineReading(metadata({ fresh: false }), { count: 1 });
    expect(stale.availability).toBe("complete");
    expect(stale.fresh).toBe(false);
  });

  test("scope targets reuse saved-flow credential and own-path validation", () => {
    const scope = { sessionId: "app-1", generation: 0, kind: "state", target: "cart" };
    expect(captureBaselineScope(scope).path).toBe("");
    for (const invalid of [
      { ...scope, generation: NaN }, { ...scope, sessionId: "" }, { ...scope, sessionId: "not a session" },
      { ...scope, path: "__proto__.count" }, { ...scope, target: "passwordStore" }, { ...scope, extra: true },
      { ...scope, kind: "element", target: "#password" }, { ...scope, kind: "element", target: "#cart", path: "" },
    ]) expect(() => captureBaselineScope(invalid)).toThrow();
    const getter = Object.defineProperty({ ...scope }, "generation", { get() { throw new Error("must not run"); } });
    expect(() => captureBaselineScope(getter)).toThrow(BaselineInputError);
  });

  test("action and operation correlation metadata is copied and validated without getters", () => {
    const outcome = { operationId: "save-1", phase: "accepted" as const };
    const reading = captureBaselineReading(metadata({ actionId: "click-1", outcome }), 1);
    expect(reading.outcome).toEqual(outcome);
    expect(Object.isFrozen(reading.outcome)).toBe(true);
    for (const invalid of [metadata({ actionId: "" }), metadata({ cursor: -1 }), metadata({ fresh: "yes" as unknown as boolean }),
      metadata({ outcome: { operationId: "save-1", phase: "pending" as unknown as "accepted" } })]) {
      expect(() => captureBaselineReading(invalid, 1)).toThrow(BaselineInputError);
    }
    let calls = 0;
    const malicious = Object.defineProperty(metadata(), "fresh", { get() { calls++; return true; } });
    expect(() => captureBaselineReading(malicious, 1)).toThrow(BaselineInputError);
    expect(calls).toBe(0);
  });
});
