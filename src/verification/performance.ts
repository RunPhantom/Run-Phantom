/** Closed, numeric browser lab evidence. This is not a general performance verdict. */
export const PERFORMANCE_VERSION = 1 as const;
export const PERFORMANCE_LIMITS = { BYTES: 16 * 1024, CALLBACK_ENTRIES: 1000, LIFETIME_WORK: 50_000, DIAGNOSTICS: 8, SCRIPT_INSPECTIONS: 32, URL_INPUT: 2048, URL_PART: 256 } as const;
export const PERFORMANCE_OBSERVERS = ["paint", "largest-contentful-paint", "navigation", "layout-shift", "event", "long-animation-frame", "resource"] as const;
export type PerformanceObserverName = typeof PERFORMANCE_OBSERVERS[number];
export const PERFORMANCE_METRICS = ["fcpMs", "lcpMs", "navigationTtfbMs", "navigationDomContentLoadedMs", "navigationLoadMs", "clsMaxSessionScore", "qualifyingInteractionMaxMs", "longFrameBlockingMaxMs", "resourceCount", "resourceTransferBytes"] as const;
export type PerformanceMetric = typeof PERFORMANCE_METRICS[number];
export const PERFORMANCE_CHECK_METRICS = ["clsMaxSessionScore", "longFrameBlockingMaxMs", "resourceCount", "resourceTransferBytes"] as const;
export type PerformanceCheckMetric = typeof PERFORMANCE_CHECK_METRICS[number];
export interface PerformancePredicate { kind: "performance"; metric: PerformanceCheckMetric; op: "lte" | "gte"; value: number }
export interface PerformanceCoverage {
  state: "unsupported" | "failed" | "observing" | "disconnected";
  observed: number; invalid: number; omitted: number; nativeDropped: number | null; overflow: boolean;
}
export interface PerformanceUrl { origin: string; path: string }
export interface PerformanceResource { startMs: number; durationMs: number; transferBytes: number; url?: PerformanceUrl }
export interface PerformanceScript { durationMs: number; forcedLayoutMs: number; source?: PerformanceUrl }
export interface PerformanceFrame { startMs: number; durationMs: number; blockingMs: number; scripts: PerformanceScript[] }
export interface PerformanceSnapshot {
  version: 1; source: "sdk-native-observers"; phase: "begin" | "capture";
  documentId: string; windowId: string;
  clock: { timeOriginMs: number | null; installedAtMs: number | null; sinceMs: number | null; capturedAtMs: number | null };
  metadata: "none" | "redacted-origin-path";
  coverage: Record<PerformanceObserverName, PerformanceCoverage>;
  metrics: Record<PerformanceMetric, number | null>;
  diagnostics: { resources: PerformanceResource[]; frames: PerformanceFrame[]; resourceOmitted: number; frameOmitted: number; scriptOmitted: number; metadataOmitted: number };
  lifetimeWork: number; lifetimeExhausted: boolean;
}
export interface RetainedPerformanceEvidence { generation: number; cursor: number; snapshot: PerformanceSnapshot }
export function hasPerformanceControlCharacters(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 32 || text.charCodeAt(i) === 127) return true;
  return false;
}

function refuse(): never { throw new Error("Invalid or oversized native performance evidence"); }
function object(value: unknown, fields: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return refuse();
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return refuse();
  const names = Reflect.ownKeys(value);
  if (names.length > fields.length + optional.length) return refuse();
  for (const key of names) {
    if (typeof key !== "string" || (!fields.includes(key) && !optional.includes(key))) return refuse();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return refuse();
  }
  if (fields.some(key => !Object.prototype.hasOwnProperty.call(value, key))) return refuse();
  return value as Record<string, unknown>;
}
function numeric(value: unknown, integer = false, nullable = false): number | null {
  if (value === null && nullable) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) return refuse();
  return value;
}
function boolean(value: unknown): boolean { if (typeof value !== "boolean") return refuse(); return value; }
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > PERFORMANCE_LIMITS.DIAGNOSTICS) return refuse();
  if (Reflect.ownKeys(value).some(key => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) return refuse();
  for (let i = 0; i < value.length; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d || !("value" in d)) return refuse(); }
  return value;
}
function url(value: unknown): PerformanceUrl {
  const obj = object(value, ["origin", "path"]);
  for (const part of [obj.origin, obj.path]) if (typeof part !== "string" || part.length > PERFORMANCE_LIMITS.URL_PART || hasPerformanceControlCharacters(part)) return refuse();
  const origin = obj.origin as string, path = obj.path as string;
  if (!/^https?:\/\//.test(origin) || /[@?#]/.test(origin) || !path.startsWith("/") || /[?#]/.test(path)) return refuse();
  // Only the collector's canonical origin spelling is admissible, including after redaction.
  try { if (new URL(origin).origin !== origin) return refuse(); }
  catch { return refuse(); }
  return { origin, path };
}
export function parsePerformancePredicate(value: unknown): PerformancePredicate {
  const obj = object(value, ["kind", "metric", "op", "value"]);
  if (obj.kind !== "performance" || !PERFORMANCE_CHECK_METRICS.includes(obj.metric as PerformanceCheckMetric) || (obj.op !== "lte" && obj.op !== "gte")) return refuse();
  const metric = obj.metric as PerformanceCheckMetric;
  return { kind: "performance", metric, op: obj.op, value: numeric(obj.value, metric === "resourceCount" || metric === "resourceTransferBytes") as number };
}
export function parsePerformanceSnapshot(value: unknown): PerformanceSnapshot {
  const obj = object(value, ["version", "source", "phase", "documentId", "windowId", "clock", "metadata", "coverage", "metrics", "diagnostics", "lifetimeWork", "lifetimeExhausted"]);
  if (obj.version !== 1 || obj.source !== "sdk-native-observers" || (obj.phase !== "begin" && obj.phase !== "capture") || (obj.metadata !== "none" && obj.metadata !== "redacted-origin-path")) return refuse();
  for (const id of [obj.documentId, obj.windowId]) if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) return refuse();
  const clock = object(obj.clock, ["timeOriginMs", "installedAtMs", "sinceMs", "capturedAtMs"]);
  for (const key of Object.keys(clock)) numeric(clock[key], false, true);
  const coverage = object(obj.coverage, PERFORMANCE_OBSERVERS);
  for (const name of PERFORMANCE_OBSERVERS) {
    const item = object(coverage[name], ["state", "observed", "invalid", "omitted", "nativeDropped", "overflow"]);
    if (!["unsupported", "failed", "observing", "disconnected"].includes(item.state as string)) return refuse();
    for (const key of ["observed", "invalid", "omitted"]) numeric(item[key], true);
    if ((item.observed as number) > PERFORMANCE_LIMITS.LIFETIME_WORK) return refuse();
    numeric(item.nativeDropped, true, true); boolean(item.overflow);
  }
  const metrics = object(obj.metrics, PERFORMANCE_METRICS);
  for (const metric of PERFORMANCE_METRICS) numeric(metrics[metric], metric === "resourceCount" || metric === "resourceTransferBytes", true);
  const diagnostics = object(obj.diagnostics, ["resources", "frames", "resourceOmitted", "frameOmitted", "scriptOmitted", "metadataOmitted"]);
  for (const key of ["resourceOmitted", "frameOmitted", "scriptOmitted", "metadataOmitted"]) numeric(diagnostics[key], true);
  for (const resource of list(diagnostics.resources)) {
    const item = object(resource, ["startMs", "durationMs", "transferBytes"], ["url"]);
    numeric(item.startMs); numeric(item.durationMs); numeric(item.transferBytes, true);
    if (Object.prototype.hasOwnProperty.call(item, "url")) { if (obj.metadata === "none") return refuse(); url(item.url); }
  }
  for (const frame of list(diagnostics.frames)) {
    const item = object(frame, ["startMs", "durationMs", "blockingMs", "scripts"]);
    numeric(item.startMs); numeric(item.durationMs); numeric(item.blockingMs);
    for (const script of list(item.scripts)) {
      const entry = object(script, ["durationMs", "forcedLayoutMs"], ["source"]);
      numeric(entry.durationMs); numeric(entry.forcedLayoutMs);
      if (Object.prototype.hasOwnProperty.call(entry, "source")) { if (obj.metadata === "none") return refuse(); url(entry.source); }
    }
  }
  numeric(obj.lifetimeWork, true); if ((obj.lifetimeWork as number) > PERFORMANCE_LIMITS.LIFETIME_WORK) return refuse(); boolean(obj.lifetimeExhausted);
  // All schema, scalar, array and string bounds are admitted before allocating JSON/UTF8.
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > PERFORMANCE_LIMITS.BYTES) return refuse();
  return JSON.parse(JSON.stringify(value)) as PerformanceSnapshot;
}
export function performanceClockComplete(snapshot: PerformanceSnapshot): boolean {
  const c = snapshot.clock;
  return c.timeOriginMs !== null && c.timeOriginMs > 0 && c.installedAtMs !== null && c.sinceMs !== null && c.capturedAtMs !== null
    && c.installedAtMs <= c.sinceMs && c.sinceMs <= c.capturedAtMs;
}
export function evaluatePerformancePredicate(predicate: PerformancePredicate, snapshot: PerformanceSnapshot | undefined, fresh: boolean): { status: "pass" | "fail" | "inconclusive"; reason: string; evidence: never[] } {
  const unavailable = (reason: string) => ({ status: "inconclusive" as const, reason, evidence: [] as never[] });
  if (!snapshot || !fresh || snapshot.phase !== "capture" || !performanceClockComplete(snapshot)) return unavailable("A fresh matching native performance lab window is unavailable");
  const observer = predicate.metric === "clsMaxSessionScore" ? "layout-shift" : predicate.metric === "longFrameBlockingMaxMs" ? "long-animation-frame" : "resource";
  const coverage = snapshot.coverage[observer];
  if (coverage.state !== "observing" || coverage.nativeDropped !== 0 || coverage.invalid !== 0 || coverage.omitted !== 0 || coverage.overflow || snapshot.lifetimeExhausted) return unavailable(`${observer} native population is unavailable, incomplete or has unknown loss`);
  const measured = snapshot.metrics[predicate.metric];
  if (measured === null) return unavailable(`No admitted numeric ${predicate.metric} measurement exists in this lab window`);
  const passed = predicate.op === "lte" ? measured <= predicate.value : measured >= predicate.value;
  return { status: passed ? "pass" : "fail", reason: `Admitted native ${predicate.metric} ${measured} ${predicate.op === "lte" ? "≤" : "≥"} ${predicate.value}: ${passed ? "met" : "not met"}; selected lab window only`, evidence: [] };
}
export function performanceMetricUnit(metric: PerformanceMetric): "ms" | "score" | "count" | "bytes" {
  return metric === "clsMaxSessionScore" ? "score" : metric === "resourceCount" ? "count" : metric === "resourceTransferBytes" ? "bytes" : "ms";
}

/** Only explicitly acquired metadata receives business-secret substitutions. Typed identities stay exact. */
export function scrubPerformanceMetadata(input: unknown, scrub: (value: string) => unknown): PerformanceSnapshot {
  const snapshot = parsePerformanceSnapshot(input);
  const clean = (value: PerformanceUrl | undefined): PerformanceUrl | undefined => {
    if (!value) return undefined;
    try { return url({ origin: scrub(value.origin), path: scrub(value.path) }); }
    catch { snapshot.diagnostics.metadataOmitted++; return undefined; }
  };
  for (const item of snapshot.diagnostics.resources) { const safe = clean(item.url); if (safe) item.url = safe; else delete item.url; }
  for (const frame of snapshot.diagnostics.frames) for (const item of frame.scripts) { const safe = clean(item.source); if (safe) item.source = safe; else delete item.source; }
  return parsePerformanceSnapshot(snapshot);
}
