import { PERFORMANCE_LIMITS as L, PERFORMANCE_METRICS, PERFORMANCE_OBSERVERS, parsePerformanceSnapshot, hasPerformanceControlCharacters, type PerformanceCoverage, type PerformanceFrame, type PerformanceObserverName, type PerformanceResource, type PerformanceSnapshot, type PerformanceUrl } from "../../performance.js";
import { redactUrl } from "../../redaction.js";

export interface PerformanceCollector { read(phase: "begin" | "capture"): PerformanceSnapshot; disconnect(): void }
type NativeRecord = PerformanceEntry & Record<string, unknown>;
const number = (value: unknown, integer = false): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) throw new Error("Invalid native timing");
  return value;
};
const id = (): string => [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, "0")).join("");

/** Opt-in only. No URL/script attribution getters are read in the default numeric mode. */
export function installPerformance(metadata: "none" | "origin-path", scrub: (value: string) => string): PerformanceCollector {
  let active = true, windowId: string | null = null, since: number | null = null, work = 0, exhausted = false;
  const documentId = id();
  const safeClock = (read: () => unknown): number | null => { try { return number(read()); } catch { return null; } };
  const timeOrigin = safeClock(() => performance.timeOrigin), installedAt = safeClock(() => performance.now());
  const coverage = Object.fromEntries(PERFORMANCE_OBSERVERS.map(name => [name, { state: "unsupported", observed: 0, invalid: 0, omitted: 0, nativeDropped: null, overflow: false }])) as Record<PerformanceObserverName, PerformanceCoverage>;
  const metrics = Object.fromEntries(PERFORMANCE_METRICS.map(name => [name, null])) as PerformanceSnapshot["metrics"];
  let diagnostics: PerformanceSnapshot["diagnostics"] = { resources: [], frames: [], resourceOmitted: 0, frameOmitted: 0, scriptOmitted: 0, metadataOmitted: 0 };
  let metadataBytes = 0;
  let clsStart = 0, clsLast = 0, clsScore = 0, clsSeen = false, lcpStart = -1;
  const observers = new Map<PerformanceObserverName, PerformanceObserver>();
  const spend = (): boolean => {
    if (work >= L.LIFETIME_WORK) {
      if (!exhausted) for (const [name, observer] of observers) { try { observer.disconnect(); } catch { /* The lifetime limit remains explicit. */ } coverage[name].state = "disconnected"; }
      exhausted = true; return false;
    }
    work++; return true;
  };
  const metadataUrl = (raw: unknown): PerformanceUrl | undefined => {
    if (typeof raw !== "string" || raw.length > L.URL_INPUT) { diagnostics.metadataOmitted++; return undefined; }
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") { diagnostics.metadataOmitted++; return undefined; }
      // Remove credentials, query and fragment before the existing redactor/exact-fill floor.
      const redacted = redactUrl(`${parsed.origin}${parsed.pathname}`);
      const split = new URL(redacted);
      const origin = scrub(split.origin), path = scrub(split.pathname);
      if (origin.length > L.URL_PART || path.length > L.URL_PART || hasPerformanceControlCharacters(origin + path) || !/^https?:\/\//.test(origin) || !path.startsWith("/") || /[@?#]/.test(origin) || /[?#]/.test(path) || new URL(origin).origin !== origin) { diagnostics.metadataOmitted++; return undefined; }
      const bytes = new TextEncoder().encode(JSON.stringify({ origin, path })).byteLength;
      if (metadataBytes + bytes > 4096) { diagnostics.metadataOmitted++; return undefined; }
      metadataBytes += bytes;
      return { origin, path };
    } catch { diagnostics.metadataOmitted++; return undefined; }
  };
  const top = <T>(items: T[], item: T, rank: (entry: T) => number): boolean => {
    items.push(item); items.sort((a, b) => rank(b) - rank(a));
    if (items.length > L.DIAGNOSTICS) { items.pop(); return true; } return false;
  };
  const entry = (name: PerformanceObserverName, e: NativeRecord): void => {
    const start = number(e.startTime), duration = number(e.duration);
    if (name === "paint") { if (e.name === "first-contentful-paint") metrics.fcpMs = start; return; }
    if (name === "largest-contentful-paint") { if (start >= lcpStart) { lcpStart = start; metrics.lcpMs = start; } return; }
    if (name === "navigation") {
      const response = number(e.responseStart), request = number(e.requestStart);
      metrics.navigationTtfbMs = response > 0 && response >= request ? response - request : null;
      const dom = number(e.domContentLoadedEventEnd), load = number(e.loadEventEnd);
      metrics.navigationDomContentLoadedMs = dom > 0 ? dom : null; metrics.navigationLoadMs = load > 0 ? load : null; return;
    }
    if (since === null || start < since) return;
    if (name === "layout-shift") {
      if (typeof e.hadRecentInput !== "boolean") throw new Error("Invalid shift eligibility");
      if (e.hadRecentInput) return;
      const value = number(e.value);
      if (clsSeen && start < clsLast) throw new Error("Unordered native shift population");
      if (!clsSeen || start - clsLast >= 1000 || start - clsStart >= 5000) { clsStart = start; clsScore = value; }
      else clsScore += value;
      clsLast = start; clsSeen = true;
      if (!Number.isFinite(clsScore)) { coverage[name].overflow = true; metrics.clsMaxSessionScore = null; return; }
      metrics.clsMaxSessionScore = Math.max(metrics.clsMaxSessionScore ?? 0, clsScore); return;
    }
    if (name === "event") {
      // Native Event Timing only reports trusted qualifying events; no DOM target acquisition.
      const interaction = number(e.interactionId, true);
      if (interaction > 0) metrics.qualifyingInteractionMaxMs = Math.max(metrics.qualifyingInteractionMaxMs ?? 0, duration); return;
    }
    if (name === "resource") {
      const bytes = number(e.transferSize, true), count = (metrics.resourceCount ?? 0) + 1, total = (metrics.resourceTransferBytes ?? 0) + bytes;
      if (!Number.isSafeInteger(count) || !Number.isSafeInteger(total)) { coverage[name].overflow = true; metrics.resourceCount = metrics.resourceTransferBytes = null; return; }
      metrics.resourceCount = count; metrics.resourceTransferBytes = total;
      const resource: PerformanceResource = { startMs: start, durationMs: duration, transferBytes: bytes };
      if (metadata === "origin-path") { const url = metadataUrl(e.name); if (url) resource.url = url; }
      if (top(diagnostics.resources, resource, item => item.durationMs)) diagnostics.resourceOmitted++; return;
    }
    const blocking = number(e.blockingDuration);
    metrics.longFrameBlockingMaxMs = Math.max(metrics.longFrameBlockingMaxMs ?? 0, blocking);
    const frame: PerformanceFrame = { startMs: start, durationMs: duration, blockingMs: blocking, scripts: [] };
    if (metadata === "origin-path") {
      // Attribution is explicitly enabled; still never read invoker, function, DOM or body fields.
      const scripts = e.scripts;
      if (!Array.isArray(scripts)) diagnostics.scriptOmitted++;
      else {
        diagnostics.scriptOmitted += Math.max(0, scripts.length - L.SCRIPT_INSPECTIONS);
        for (let i = 0; i < Math.min(scripts.length, L.SCRIPT_INSPECTIONS); i++) {
          if (!spend()) { diagnostics.scriptOmitted += Math.min(scripts.length, L.SCRIPT_INSPECTIONS) - i; break; }
          try {
            const script = scripts[i] as Record<string, unknown>;
            const item = { durationMs: number(script.duration), forcedLayoutMs: number(script.forcedStyleAndLayoutDuration), source: metadataUrl(script.sourceURL) };
            if (top(frame.scripts, { durationMs: item.durationMs, forcedLayoutMs: item.forcedLayoutMs, ...(item.source ? { source: item.source } : {}) }, x => x.durationMs)) diagnostics.scriptOmitted++;
          } catch { diagnostics.scriptOmitted++; }
        }
      }
    }
    if (top(diagnostics.frames, frame, item => item.blockingMs)) diagnostics.frameOmitted++;
  };
  const process = (name: PerformanceObserverName, entries: PerformanceEntry[], dropped: unknown): void => {
    if (!active || exhausted) return;
    const state = coverage[name];
    if (!spend()) return;
    if (!Array.isArray(entries)) { state.invalid++; return; }
    if (entries.length > 0) {
      if (typeof dropped === "number" && Number.isSafeInteger(dropped) && dropped >= 0) state.nativeDropped = Math.max(state.nativeDropped ?? 0, dropped);
      else if (!state.nativeDropped) state.nativeDropped = null;
    }
    state.omitted += Math.max(0, entries.length - L.CALLBACK_ENTRIES);
    for (let i = 0; i < Math.min(entries.length, L.CALLBACK_ENTRIES); i++) {
      if (!spend()) { state.omitted += Math.min(entries.length, L.CALLBACK_ENTRIES) - i; break; }
      state.observed++;
      try { entry(name, entries[i] as NativeRecord); } catch { state.invalid++; }
    }
  };
  let supported: readonly string[] | null = null;
  try { supported = PerformanceObserver.supportedEntryTypes; if (!Array.isArray(supported)) supported = null; } catch { /* Unknown support is recorded as failed below. */ }
  for (const name of PERFORMANCE_OBSERVERS) {
    if (supported === null) { coverage[name].state = "failed"; continue; }
    if (!supported.includes(name)) continue;
    try {
      const observer = new PerformanceObserver((list: PerformanceObserverEntryList, _observer: PerformanceObserver, options?: { droppedEntriesCount?: number }) => {
        if (!active) return;
        try { process(name, list.getEntries(), (options as { droppedEntriesCount?: number } | undefined)?.droppedEntriesCount); }
        catch { coverage[name].state = "failed"; }
      });
      observers.set(name, observer);
      observer.observe({ type: name, buffered: true, ...(name === "event" ? { durationThreshold: 16 } : {}) });
      coverage[name].state = "observing";
    } catch { coverage[name].state = "failed"; }
  }
  const bufferFull = (): void => { if (active) coverage.resource.omitted++; };
  try { performance.addEventListener("resourcetimingbufferfull", bufferFull); } catch { coverage.resource.state = "failed"; }
  const drain = (): void => {
    for (const [name, observer] of observers) {
      try { const pending = observer.takeRecords(); if (pending.length) process(name, pending, undefined); } catch { coverage[name].state = "failed"; }
    }
  };
  const disconnect = (): void => {
    if (!active) return;
    active = false;
    for (const [name, observer] of observers) { try { observer.disconnect(); } catch { /* Already unavailable. */ } coverage[name].state = "disconnected"; }
    try { performance.removeEventListener("resourcetimingbufferfull", bufferFull); window.removeEventListener("pagehide", disconnect); } catch { /* No stale collector callbacks remain active. */ }
  };
  try { window.addEventListener("pagehide", disconnect); } catch { for (const name of PERFORMANCE_OBSERVERS) coverage[name].state = "failed"; }
  return {
    disconnect,
    read(phase) {
      if (!active) throw new Error("Native performance document is disconnected");
      if (phase === "begin") {
        drain(); if (!spend()) throw new Error("Native performance lifetime work limit reached; reconnect");
        windowId = id(); since = safeClock(() => performance.now()); clsStart = clsLast = clsScore = 0; clsSeen = false;
        for (const name of PERFORMANCE_OBSERVERS) {
          const c = coverage[name]; c.observed = c.invalid = c.omitted = 0; c.overflow = false; if (c.nativeDropped === 0) c.nativeDropped = null;
        }
        metrics.clsMaxSessionScore = coverage["layout-shift"].state === "observing" ? 0 : null;
        metrics.resourceCount = metrics.resourceTransferBytes = coverage.resource.state === "observing" ? 0 : null;
        metrics.qualifyingInteractionMaxMs = metrics.longFrameBlockingMaxMs = null;
        diagnostics = { resources: [], frames: [], resourceOmitted: 0, frameOmitted: 0, scriptOmitted: 0, metadataOmitted: 0 };
        metadataBytes = 0;
      } else { if (windowId === null) throw new Error("Begin a native performance lab window first"); drain(); }
      return parsePerformanceSnapshot({ version: 1, source: "sdk-native-observers", phase, documentId, windowId,
        clock: { timeOriginMs: timeOrigin, installedAtMs: installedAt, sinceMs: since, capturedAtMs: safeClock(() => performance.now()) },
        metadata: metadata === "none" ? "none" : "redacted-origin-path", coverage, metrics, diagnostics, lifetimeWork: work, lifetimeExhausted: exhausted });
    },
  };
}
