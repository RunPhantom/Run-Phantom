import { expect, test } from "bun:test";
import { installPerformance } from "../src/verification/browser/observers/performance";
import { PERFORMANCE_OBSERVERS } from "../src/verification/performance";

// Injected native API faults lock the bounded collector, not native browser measurement truth.
function harness(run: (h: { deliver: (name: string, entries: object[], dropped?: number) => void; pending: (name: string, entries: object[]) => void; full: () => void; setTime: (n: number) => void }) => void) {
  const originals = ["performance", "PerformanceObserver", "window"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  let now = 100, full = () => {}, pagehide = () => {};
  const instances = new Map<string, FakeObserver>();
  class FakeObserver {
    static supportedEntryTypes: string[] = [...PERFORMANCE_OBSERVERS];
    records: object[] = []; ended = false;
    constructor(public callback: (list: unknown, observer: unknown, options: unknown) => void) {}
    observe(options: { type: string }) { instances.set(options.type, this); }
    takeRecords() { const records = this.records; this.records = []; return records; }
    disconnect() { this.ended = true; }
  }
  Object.defineProperty(globalThis, "performance", { configurable: true, value: { timeOrigin: 1, now: () => now, addEventListener: (_: string, f: () => void) => { full = f; }, removeEventListener() {} } });
  Object.defineProperty(globalThis, "PerformanceObserver", { configurable: true, value: FakeObserver });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener: (_: string, f: () => void) => { pagehide = f; }, removeEventListener() {} } });
  try {
    run({ deliver(name, entries, dropped) { const o = instances.get(name)!; o.callback({ getEntries: () => entries }, o, dropped === undefined ? {} : { droppedEntriesCount: dropped }); }, pending(name, entries) { instances.get(name)!.records = entries; }, full: () => full(), setTime: n => { now = n; } });
    pagehide();
  } finally { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } }
}
const resource = (start = 101, bytes = 0, duration = 10) => ({ startTime: start, duration, transferSize: bytes, get name(): never { throw new Error("Numeric mode must not acquire URL"); } });
test("numeric mode never reads resource URLs or script attribution and preserves zero", () => harness(h => {
  const collector = installPerformance("none", s => s); collector.read("begin");
  h.deliver("resource", [resource()], 0);
  h.deliver("long-animation-frame", [{ startTime: 101, duration: 80, blockingDuration: 15, get scripts(): never { throw new Error("No attribution permission"); } }], 0);
  h.setTime(200); const snapshot = collector.read("capture");
  expect(snapshot.metrics.resourceCount).toBe(1); expect(snapshot.metrics.resourceTransferBytes).toBe(0);
  expect(snapshot.metrics.longFrameBlockingMaxMs).toBe(15); expect(snapshot.diagnostics.frames[0]!.scripts).toEqual([]);
  expect(snapshot.coverage.resource.invalid).toBe(0); expect(snapshot.coverage["long-animation-frame"].invalid).toBe(0);
  collector.disconnect(); h.deliver("resource", [resource()], 0); expect(() => collector.read("capture")).toThrow();
}));
test("source loss, drain uncertainty, overflow and window identity stay explicit", () => harness(h => {
  const collector = installPerformance("none", s => s); const first = collector.read("begin");
  h.deliver("resource", [resource()], 3); h.deliver("resource", [resource()], undefined); h.deliver("resource", [resource()], 0);
  expect(collector.read("capture").coverage.resource.nativeDropped).toBe(3);
  const second = collector.read("begin"); expect(second.documentId).toBe(first.documentId); expect(second.windowId).not.toBe(first.windowId);
  h.deliver("layout-shift", [{ startTime: 101, duration: 0, value: 0.1, hadRecentInput: false }], 0);
  h.pending("layout-shift", [{ startTime: 102, duration: 0, value: 0.2, hadRecentInput: false }]);
  expect(collector.read("capture").coverage["layout-shift"].nativeDropped).toBeNull();
  h.full(); expect(collector.read("capture").coverage.resource.omitted).toBe(1);
  h.deliver("resource", [resource(101, Number.MAX_SAFE_INTEGER), resource(102, 1)], 0);
  expect(collector.read("capture").coverage.resource.overflow).toBe(true);
  collector.disconnect();
}));
test("CLS session windows exclude recent input and preserve native precision", () => harness(h => {
  const collector = installPerformance("none", s => s); collector.read("begin");
  h.deliver("layout-shift", [
    { startTime: 110, duration: 0, value: 0.100000001, hadRecentInput: false },
    { startTime: 200, duration: 0, value: 999, hadRecentInput: true },
    { startTime: 300, duration: 0, value: 0.2, hadRecentInput: false },
    { startTime: 1400, duration: 0, value: 0.15, hadRecentInput: false },
  ], 0);
  h.setTime(2000); expect(collector.read("capture").metrics.clsMaxSessionScore).toBe(0.300000001);
  collector.disconnect();
}));
test("entry and lifetime budgets survive resets while diagnostic top-N is distinct", () => harness(h => {
  const collector = installPerformance("none", s => s); collector.read("begin");
  h.deliver("resource", Array.from({ length: 1001 }, (_, i) => resource(101, 1, i)), 0);
  const capture = collector.read("capture"); expect(capture.metrics.resourceCount).toBe(1000); expect(capture.coverage.resource.omitted).toBe(1);
  expect(capture.diagnostics.resources.length).toBe(8); expect(capture.diagnostics.resourceOmitted).toBe(992);
  for (let i = 0; i < 50; i++) { collector.read("begin"); h.deliver("resource", Array.from({ length: 1000 }, () => resource()), 0); if (collector.read("capture").lifetimeExhausted) break; }
  expect(collector.read("capture").lifetimeWork).toBe(50000); expect(collector.read("capture").lifetimeExhausted).toBe(true);
  expect(collector.read("capture").coverage.resource.state).toBe("disconnected");
  expect(() => collector.read("begin")).toThrow(); collector.disconnect();
}));
test("unknown support and malformed native samples cannot turn into zero proof", () => harness(h => {
  Object.defineProperty(PerformanceObserver, "supportedEntryTypes", { configurable: true, get() { throw new Error("Native support probe failed"); } });
  const failed = installPerformance("none", s => s); failed.read("begin");
  expect(failed.read("capture").coverage.resource.state).toBe("failed"); expect(failed.read("capture").metrics.resourceCount).toBeNull(); failed.disconnect();
  Object.defineProperty(PerformanceObserver, "supportedEntryTypes", { configurable: true, value: [...PERFORMANCE_OBSERVERS] });
  const collector = installPerformance("none", s => s); collector.read("begin");
  h.deliver("resource", [{ startTime: 101, duration: NaN, transferSize: 0 }], 0);
  expect(collector.read("capture").coverage.resource.invalid).toBe(1);
  h.deliver("layout-shift", [{ startTime: 200, duration: 0, value: 0.1, hadRecentInput: false }, { startTime: 150, duration: 0, value: 0.2, hadRecentInput: false }], 0);
  expect(collector.read("capture").coverage["layout-shift"].invalid).toBe(1); collector.disconnect();
}));
test("explicit origin/path metadata strips credentials and exact spellings", () => harness(h => {
  const collector = installPerformance("origin-path", s => s.replaceAll("business-secret", "[REDACTED]")); collector.read("begin");
  h.deliver("resource", [{ startTime: 101, duration: 1, transferSize: 1, name: "https://user:password@safe.invalid/business-secret?token=private#fragment" }], 0);
  const text = JSON.stringify(collector.read("capture")); expect(text).not.toContain("password"); expect(text).not.toContain("business-secret"); expect(text).not.toContain("private"); expect(text).not.toContain("fragment"); expect(text).toContain("[REDACTED]");
  collector.disconnect();
}));
test("redaction that removes origin authority omits location without discarding numeric evidence", () => harness(h => {
  const collector = installPerformance("origin-path", s => s.replaceAll("business-secret", "[REDACTED]")); collector.read("begin");
  h.deliver("resource", [{ startTime: 101, duration: 1, transferSize: 1, name: "https://business-secret.invalid/safe" }], 0);
  const snapshot = collector.read("capture");
  expect(snapshot.metrics.resourceCount).toBe(1); expect(snapshot.metrics.resourceTransferBytes).toBe(1);
  expect(snapshot.diagnostics.resources[0]!.url).toBeUndefined(); expect(snapshot.diagnostics.metadataOmitted).toBe(1);
  expect(snapshot.coverage.resource.invalid).toBe(0); expect(JSON.stringify(snapshot)).not.toContain("business-secret");
  collector.disconnect();
}));
