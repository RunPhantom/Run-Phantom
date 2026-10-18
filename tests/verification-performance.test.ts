import { expect, test } from "bun:test";
import { evaluatePerformancePredicate, parsePerformanceSnapshot, PERFORMANCE_METRICS, PERFORMANCE_OBSERVERS, type PerformanceSnapshot } from "../src/verification/performance";

export function performanceFixture(): PerformanceSnapshot {
  return { version: 1, source: "sdk-native-observers", phase: "capture", documentId: "a".repeat(32), windowId: "b".repeat(32),
    clock: { timeOriginMs: 1, installedAtMs: 2, sinceMs: 3, capturedAtMs: 4 }, metadata: "none",
    coverage: Object.fromEntries(PERFORMANCE_OBSERVERS.map(name => [name, { state: "observing", observed: 0, invalid: 0, omitted: 0, nativeDropped: 0, overflow: false }])) as PerformanceSnapshot["coverage"],
    metrics: Object.fromEntries(PERFORMANCE_METRICS.map(name => [name, null])) as PerformanceSnapshot["metrics"],
    diagnostics: { resources: [], frames: [], resourceOmitted: 0, frameOmitted: 0, scriptOmitted: 0, metadataOmitted: 0 }, lifetimeWork: 0, lifetimeExhausted: false };
}
test("native evidence keeps exact finite zero and precision with detached output", () => {
  const fixture = performanceFixture(); fixture.metrics.resourceCount = 0; fixture.metrics.clsMaxSessionScore = 0.100000001;
  const parsed = parsePerformanceSnapshot(fixture); expect(parsed).toEqual(fixture); expect(parsed).not.toBe(fixture);
  expect(evaluatePerformancePredicate({ kind: "performance", metric: "resourceCount", op: "lte", value: 0 }, parsed, true).status).toBe("pass");
  expect(evaluatePerformancePredicate({ kind: "performance", metric: "clsMaxSessionScore", op: "lte", value: 0.1 }, parsed, true).status).toBe("fail");
  expect(evaluatePerformancePredicate({ kind: "performance", metric: "clsMaxSessionScore", op: "gte", value: 0.100000001 }, parsed, true).status).toBe("pass");
});
test("unknown loss and every incomplete state prevent a numeric certification", () => {
  const p = { kind: "performance", metric: "resourceTransferBytes", op: "lte", value: 0 } as const;
  for (const change of [{ nativeDropped: null }, { nativeDropped: 1 }, { invalid: 1 }, { omitted: 1 }, { overflow: true }, { state: "unsupported" }, { state: "failed" }, { state: "disconnected" }]) {
    const fixture = performanceFixture(); fixture.metrics.resourceTransferBytes = 0; Object.assign(fixture.coverage.resource, change);
    expect(evaluatePerformancePredicate(p, parsePerformanceSnapshot(fixture), true).status).toBe("inconclusive");
  }
  for (const change of [{ phase: "begin" }, { lifetimeExhausted: true }, { clock: { timeOriginMs: 0, installedAtMs: 2, sinceMs: 3, capturedAtMs: 4 } }, { clock: { timeOriginMs: 1, installedAtMs: 4, sinceMs: 3, capturedAtMs: 2 } }]) {
    const fixture = performanceFixture(); fixture.metrics.resourceTransferBytes = 0; Object.assign(fixture, change);
    expect(evaluatePerformancePredicate(p, parsePerformanceSnapshot(fixture), true).status).toBe("inconclusive");
  }
  expect(evaluatePerformancePredicate(p, performanceFixture(), false).status).toBe("inconclusive");
  expect(evaluatePerformancePredicate(p, undefined, true).status).toBe("inconclusive");
});
test("top-N diagnostics omission does not invent numeric population loss", () => {
  const fixture = performanceFixture(); fixture.metrics.resourceCount = 12; fixture.diagnostics.resourceOmitted = 4;
  expect(evaluatePerformancePredicate({ kind: "performance", metric: "resourceCount", op: "gte", value: 12 }, parsePerformanceSnapshot(fixture), true).status).toBe("pass");
});
test("closed numeric schema refuses unsafe counts, unbounded arrays, metadata and accessors before allocation", () => {
  for (const value of [NaN, Infinity, -1, "0", {}, Number.MAX_SAFE_INTEGER + 1, 0.5]) {
    const fixture = performanceFixture(); (fixture.metrics as Record<string, unknown>).resourceCount = value; expect(() => parsePerformanceSnapshot(fixture)).toThrow();
  }
  for (const field of ["clock", "coverage", "metrics", "diagnostics"]) {
    const fixture = performanceFixture(); let read = false;
    Object.defineProperty(fixture, field, { enumerable: true, get() { read = true; throw new Error("must not read"); } });
    expect(() => parsePerformanceSnapshot(fixture)).toThrow(); expect(read).toBe(false);
  }
  const fixture = performanceFixture(); fixture.diagnostics.resources = Array(9).fill({ startMs: 0, durationMs: 0, transferBytes: 0 }); expect(() => parsePerformanceSnapshot(fixture)).toThrow();
  fixture.diagnostics.resources = [{ startMs: 0, durationMs: 0, transferBytes: 0, url: { origin: "https://safe.invalid", path: "/safe" } }]; expect(() => parsePerformanceSnapshot(fixture)).toThrow();
  fixture.metadata = "redacted-origin-path"; expect(parsePerformanceSnapshot(fixture).diagnostics.resources[0]!.url?.path).toBe("/safe");
  fixture.diagnostics.resources[0]!.url!.path = "/private?credential=secret"; expect(() => parsePerformanceSnapshot(fixture)).toThrow();
  expect(() => parsePerformanceSnapshot({ ...performanceFixture(), rawBody: "private" })).toThrow();
});
test("metadata origin remains an exact origin and bounded UTF8 diagnostics cannot exceed16KiB", () => {
  for (const origin of ["https://safe.invalid/private/path", "https://safe.invalid/", "https://safe.invalid:443", "https://SAFE.invalid", "https://user:password@safe.invalid"]) {
    const fixture = performanceFixture(); fixture.metadata = "redacted-origin-path"; fixture.diagnostics.resources = [{ startMs: 0, durationMs: 0, transferBytes: 0, url: { origin, path: "/safe" } }];
    expect(() => parsePerformanceSnapshot(fixture)).toThrow();
  }
  const fixture = performanceFixture(); fixture.metadata = "redacted-origin-path";
  fixture.diagnostics.frames = Array.from({ length: 8 }, () => ({ startMs: 0, durationMs: 50, blockingMs: 1, scripts: Array.from({ length: 8 }, () => ({ durationMs: 1, forcedLayoutMs: 0, source: { origin: "https://safe.invalid", path: "/" + "界".repeat(230) } })) }));
  expect(() => parsePerformanceSnapshot(fixture)).toThrow();
});
