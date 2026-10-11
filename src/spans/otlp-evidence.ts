import { normalizeOtelId } from "../ids";
import { defaultIsSensitiveKey } from "../verification/redaction";
import { redactText } from "../verification/serialization";

export const OTLP_EVIDENCE_LIMITS = { events: 128, links: 128, attributes: 128,
  valueItems: 128, depth: 8, valueNodes: 4096, text: 4096, key: 256, bytes: 256 * 1024 } as const;
// Protobuf canonical mapping defaults missing status codes to zero. Retain the
// source observation separately without allowing JSON to forge this marker.
export const OTLP_SOURCE_STATUS = Symbol("otlp-source-status");

export type EvidenceValue = { stringValue: string } | { boolValue: boolean } | { intValue: string }
  | { doubleValue: number } | { bytesValue: string } | { arrayValue: { values: EvidenceValue[] } }
  | { kvlistValue: { values: EvidenceAttribute[] } };
export interface EvidenceAttribute { key: string; value: EvidenceValue }
interface AttributeSource { attributes: EvidenceAttribute[]; droppedAttributesCount: number | null }
export interface EvidenceEvent extends AttributeSource { name: string; timeUnixNano: string | null }
export interface EvidenceLink extends AttributeSource { traceId: string; spanId: string; traceState: string | null; flags: number | null }
export interface OtlpEvidence extends AttributeSource {
  schemaVersion: 1;
  startTimeUnixNano: string | null; endTimeUnixNano: string | null;
  kind: number | null; flags: number | null; traceState: string | null;
  status: { code: number | null; message: string | null } | null;
  resource: (AttributeSource & { schemaUrl: string | null }) | null;
  scope: (AttributeSource & { name: string | null; version: string | null; schemaUrl: string | null }) | null;
  droppedEventsCount: number | null; droppedLinksCount: number | null;
  events: EvidenceEvent[]; links: EvidenceLink[];
  capture: { sourceCountPolicy: "absent-is-unknown"; droppedEvents: number; droppedLinks: number;
    droppedAttributes: number; truncatedValues: number; invalidValues: number; redactedValues: number };
}

const own = (value: unknown, key: PropertyKey): unknown => {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};
const uint32 = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const int32 = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
const decimal = (value: unknown, signed: boolean): value is string => {
  if (typeof value !== "string" || !(signed ? /^-?\d{1,19}$/ : /^\d{1,20}$/).test(value)) return false;
  const n = BigInt(value);
  return signed ? n >= -(1n << 63n) && n < (1n << 63n) : n >= 0n && n < (1n << 64n);
};
const reservedKey = (key: string) => ["__proto__", "prototype", "constructor"].includes(key);

/** Additional OTLP evidence is bounded separately from the original replay payloads. */
export function captureOtlpEvidence(span: unknown, resourceSpans: unknown, scopeSpans: unknown): OtlpEvidence {
  const capture: OtlpEvidence["capture"] = { sourceCountPolicy: "absent-is-unknown", droppedEvents: 0,
    droppedLinks: 0, droppedAttributes: 0, truncatedValues: 0, invalidValues: 0, redactedValues: 0 };
  let nodes = 0, attributeBytes = 0;
  const text = (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") { capture.invalidValues++; return null; }
    if (value.length > OTLP_EVIDENCE_LIMITS.text) { capture.truncatedValues++; return "[TRUNCATED]"; }
    const noNul = value.replace(/\0/g, "\uFFFD");
    if (noNul !== value) capture.invalidValues++;
    const safe = redactText(noNul);
    if (safe !== noNul) capture.redactedValues++;
    if (safe.length > OTLP_EVIDENCE_LIMITS.text) { capture.truncatedValues++; return "[TRUNCATED]"; }
    return safe;
  };
  const count = (value: unknown): number | null => {
    if (value === undefined || value === null) return null;
    if (uint32(value)) return value;
    capture.invalidValues++; return null;
  };
  const statusCode = (value: unknown): number | null => {
    if (value === undefined || value === null) return null;
    if (int32(value)) return value;
    capture.invalidValues++; return null;
  };
  const nanos = (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    const exact = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
    if (decimal(exact, false)) return exact;
    capture.invalidValues++; return null;
  };
  const unavailable = (): EvidenceValue => { capture.invalidValues++; return { stringValue: "[UNAVAILABLE]" }; };
  const value = (input: unknown, depth: number): EvidenceValue => {
    if (++nodes > OTLP_EVIDENCE_LIMITS.valueNodes || depth >= OTLP_EVIDENCE_LIMITS.depth) {
      capture.truncatedValues++; return { stringValue: "[TRUNCATED]" };
    }
    const variants = ["stringValue", "boolValue", "intValue", "doubleValue", "bytesValue", "arrayValue", "kvlistValue"]
      .filter(key => own(input, key) !== undefined);
    if (variants.length !== 1) return unavailable();
    const field = variants[0], raw = own(input, field);
    if (field === "stringValue" || field === "bytesValue") {
      const safe = text(raw); return safe === null ? unavailable() : field === "stringValue" ? { stringValue: safe } : { bytesValue: safe };
    }
    if (field === "boolValue") return typeof raw === "boolean" ? { boolValue: raw } : unavailable();
    if (field === "doubleValue") return typeof raw === "number" && Number.isFinite(raw) ? { doubleValue: raw } : unavailable();
    if (field === "intValue") {
      const exact = typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : raw;
      return decimal(exact, true) ? { intValue: exact } : unavailable();
    }
    const entries = own(raw, "values");
    if (!Array.isArray(entries)) return unavailable();
    if (field === "kvlistValue") return { kvlistValue: { values: attributes(entries, depth + 1) } };
    const selected: EvidenceValue[] = [];
    for (let index = 0; index < Math.min(entries.length, OTLP_EVIDENCE_LIMITS.valueItems); index++) {
      if (nodes >= OTLP_EVIDENCE_LIMITS.valueNodes) break;
      selected.push(value(own(entries, String(index)), depth + 1));
    }
    if (entries.length > selected.length) capture.truncatedValues++;
    return { arrayValue: { values: selected } };
  };
  const attributes = (input: unknown, depth = 0): EvidenceAttribute[] => {
    if (input === undefined) return [];
    if (!Array.isArray(input)) { capture.invalidValues++; return []; }
    const out: EvidenceAttribute[] = [];
    const maximum = Math.min(input.length, OTLP_EVIDENCE_LIMITS.attributes);
    capture.droppedAttributes += input.length - maximum;
    for (let index = 0; index < maximum; index++) {
      if (nodes >= OTLP_EVIDENCE_LIMITS.valueNodes || attributeBytes >= OTLP_EVIDENCE_LIMITS.bytes) {
        capture.droppedAttributes += maximum - index; break;
      }
      const entry = own(input, String(index)), key = own(entry, "key");
      if (typeof key !== "string" || key.length > OTLP_EVIDENCE_LIMITS.key || reservedKey(key)) {
        capture.droppedAttributes++; capture.invalidValues++; continue;
      }
      const safeKey = text(key)!;
      if (safeKey.length > OTLP_EVIDENCE_LIMITS.key) { capture.droppedAttributes++; capture.truncatedValues++; continue; }
      let decoded: EvidenceValue;
      if (defaultIsSensitiveKey(key)) { nodes++; capture.redactedValues++; decoded = { stringValue: "[REDACTED]" }; }
      else decoded = value(own(entry, "value"), depth);
      const attribute = { key: safeKey, value: decoded };
      const size = Buffer.byteLength(JSON.stringify(attribute));
      if (attributeBytes + size > OTLP_EVIDENCE_LIMITS.bytes) { capture.droppedAttributes++; continue; }
      attributeBytes += size; out.push(attribute);
    }
    return out;
  };
  const source = (input: unknown): AttributeSource => ({ attributes: attributes(own(input, "attributes")), droppedAttributesCount: count(own(input, "droppedAttributesCount")) });
  const resource = own(resourceSpans, "resource"), scope = own(scopeSpans, "scope");
  const canonicalStatus = own(span, "status"), sourceStatus = own(canonicalStatus, OTLP_SOURCE_STATUS) ?? canonicalStatus;
  const status = (): OtlpEvidence["status"] => {
    if (sourceStatus === undefined || sourceStatus === null) return null;
    if (typeof sourceStatus !== "object" || Array.isArray(sourceStatus)) { capture.invalidValues++; return null; }
    return { code: statusCode(own(sourceStatus, "code")), message: text(own(sourceStatus, "message")) };
  };
  const resourceSchemaUrl = text(own(resourceSpans, "schemaUrl")), scopeSchemaUrl = text(own(scopeSpans, "schemaUrl"));
  const evidence: OtlpEvidence = {
    schemaVersion: 1, startTimeUnixNano: nanos(own(span, "startTimeUnixNano")), endTimeUnixNano: nanos(own(span, "endTimeUnixNano")),
    kind: count(own(span, "kind")), flags: count(own(span, "flags")), traceState: text(own(span, "traceState")),
    status: status(),
    ...source(span), resource: resource || resourceSchemaUrl !== null ? { schemaUrl: resourceSchemaUrl, ...source(resource) } : null,
    scope: scope || scopeSchemaUrl !== null ? { name: text(own(scope, "name")), version: text(own(scope, "version")), schemaUrl: scopeSchemaUrl, ...source(scope) } : null,
    droppedEventsCount: count(own(span, "droppedEventsCount")), droppedLinksCount: count(own(span, "droppedLinksCount")), events: [], links: [], capture,
  };
  const events = own(span, "events"), links = own(span, "links");
  if (events !== undefined && !Array.isArray(events)) capture.invalidValues++;
  if (links !== undefined && !Array.isArray(links)) capture.invalidValues++;
  if (Array.isArray(events)) {
    capture.droppedEvents = Math.max(0, events.length - OTLP_EVIDENCE_LIMITS.events);
    for (let i = 0; i < Math.min(events.length, OTLP_EVIDENCE_LIMITS.events); i++) {
      const event = own(events, String(i)), name = text(own(event, "name"));
      if (!name) { capture.invalidValues++; capture.droppedEvents++; continue; }
      evidence.events.push({ name, timeUnixNano: nanos(own(event, "timeUnixNano")), ...source(event) });
    }
  }
  if (Array.isArray(links)) {
    capture.droppedLinks = Math.max(0, links.length - OTLP_EVIDENCE_LIMITS.links);
    for (let i = 0; i < Math.min(links.length, OTLP_EVIDENCE_LIMITS.links); i++) {
      const link = own(links, String(i)), traceId = own(link, "traceId"), spanId = own(link, "spanId");
      if (typeof traceId !== "string" || typeof spanId !== "string" || !traceId.length || !spanId.length
        || traceId.length > 1024 || spanId.length > 1024 || redactText(traceId) !== traceId || redactText(spanId) !== spanId) {
        capture.invalidValues++; capture.droppedLinks++; continue;
      }
      const normalizedTraceId = normalizeOtelId(traceId, 16) ?? traceId, normalizedSpanId = normalizeOtelId(spanId, 8) ?? spanId;
      if (!normalizedTraceId.length || !normalizedSpanId.length || normalizedTraceId.length > 1024 || normalizedSpanId.length > 1024
        || normalizedTraceId.includes("\0") || normalizedSpanId.includes("\0")
        || redactText(normalizedTraceId) !== normalizedTraceId || redactText(normalizedSpanId) !== normalizedSpanId) {
        capture.invalidValues++; capture.droppedLinks++; continue;
      }
      evidence.links.push({ traceId: normalizedTraceId, spanId: normalizedSpanId,
        traceState: text(own(link, "traceState")), flags: count(own(link, "flags")), ...source(link) });
    }
  }
  // Whole omitted items are reported, rather than exporting a clipped JSON value.
  const oversized = () => Buffer.byteLength(JSON.stringify(evidence)) > OTLP_EVIDENCE_LIMITS.bytes;
  while (oversized() && (evidence.events.length || evidence.links.length)) {
    if (evidence.links.length) { evidence.links.pop(); capture.droppedLinks++; }
    else { evidence.events.pop(); capture.droppedEvents++; }
  }
  for (const source of [evidence.scope, evidence.resource, evidence]) {
    while (oversized() && source?.attributes.length) { source.attributes.pop(); capture.droppedAttributes++; }
  }
  return evidence;
}

/** Portable v2 is an exact evidence transfer; reject defects instead of silently repairing it. */
export function validateOtlpEvidence(input: unknown): asserts input is OtlpEvidence {
  const fail = (): never => { throw new TypeError("invalid bounded OTLP evidence"); };
  const record = (value: unknown, keys: string[]): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).length !== keys.length || keys.some(key => !descriptors[key] || !("value" in descriptors[key]))) fail();
    return value as Record<string, unknown>;
  };
  const text = (value: unknown, nullable = false, maximum: number = OTLP_EVIDENCE_LIMITS.text) => {
    if (nullable && value === null) return;
    if (typeof value !== "string" || value.length > maximum || value.includes("\0") || redactText(value) !== value) fail();
  };
  const count = (value: unknown, nullable = true) => { if ((!nullable || value !== null) && !uint32(value)) fail(); };
  const nanos = (value: unknown) => { if (value !== null && !decimal(value, false)) fail(); };
  const list = (value: unknown, maximum: number): unknown[] => {
    if (!Array.isArray(value) || value.length > maximum) fail();
    const entries = value as unknown[];
    if (Object.getPrototypeOf(value) !== Array.prototype) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).length !== entries.length + 1) fail();
    for (let index = 0; index < entries.length; index++) if (!descriptors[index] || !("value" in descriptors[index])) fail();
    return entries;
  };
  let nodes = 0;
  const value = (input: unknown, depth: number) => {
    if (++nodes > OTLP_EVIDENCE_LIMITS.valueNodes || depth > OTLP_EVIDENCE_LIMITS.depth) fail();
    if (!input || typeof input !== "object" || Array.isArray(input)) fail();
    const keys = Object.keys(input as object), field = keys[0];
    if (keys.length !== 1) fail();
    const raw = record(input, [field])[field];
    if (field === "stringValue" || field === "bytesValue") text(raw);
    else if (field === "intValue") { if (!decimal(raw, true)) fail(); }
    else if (field === "boolValue") { if (typeof raw !== "boolean") fail(); }
    else if (field === "doubleValue") { if (typeof raw !== "number" || !Number.isFinite(raw)) fail(); }
    else if (field === "arrayValue") for (const entry of list(record(raw, ["values"]).values, OTLP_EVIDENCE_LIMITS.valueItems)) value(entry, depth + 1);
    else if (field === "kvlistValue") attributes(record(raw, ["values"]).values, depth + 1);
    else fail();
  };
  const attributes = (input: unknown, depth = 0) => {
    for (const item of list(input, OTLP_EVIDENCE_LIMITS.attributes)) {
      const entry = record(item, ["key", "value"]);
      text(entry.key, false, OTLP_EVIDENCE_LIMITS.key);
      if (reservedKey(entry.key as string)) fail();
      if (defaultIsSensitiveKey(entry.key as string)
        && record(entry.value, ["stringValue"]).stringValue !== "[REDACTED]") fail();
      value(entry.value, depth);
    }
  };
  const source = (entry: Record<string, unknown>) => { attributes(entry.attributes); count(entry.droppedAttributesCount); };
  const evidence = record(input, ["schemaVersion", "startTimeUnixNano", "endTimeUnixNano", "kind", "flags", "traceState", "status", "attributes", "droppedAttributesCount", "resource", "scope", "droppedEventsCount", "droppedLinksCount", "events", "links", "capture"]);
  if (evidence.schemaVersion !== 1) fail();
  nanos(evidence.startTimeUnixNano); nanos(evidence.endTimeUnixNano); count(evidence.kind); count(evidence.flags); text(evidence.traceState, true); source(evidence);
  if (evidence.status !== null) {
    const status = record(evidence.status, ["code", "message"]);
    if (status.code !== null && !int32(status.code)) fail();
    text(status.message, true);
  }
  count(evidence.droppedEventsCount); count(evidence.droppedLinksCount);
  if (evidence.resource !== null) { const resource = record(evidence.resource, ["schemaUrl", "attributes", "droppedAttributesCount"]); text(resource.schemaUrl, true); source(resource); }
  if (evidence.scope !== null) { const scope = record(evidence.scope, ["name", "version", "schemaUrl", "attributes", "droppedAttributesCount"]); text(scope.name, true); text(scope.version, true); text(scope.schemaUrl, true); source(scope); }
  for (const item of list(evidence.events, OTLP_EVIDENCE_LIMITS.events)) {
    const event = record(item, ["name", "timeUnixNano", "attributes", "droppedAttributesCount"]);
    text(event.name); if (!event.name) fail(); nanos(event.timeUnixNano); source(event);
  }
  for (const item of list(evidence.links, OTLP_EVIDENCE_LIMITS.links)) {
    const link = record(item, ["traceId", "spanId", "traceState", "flags", "attributes", "droppedAttributesCount"]);
    text(link.traceId, false, 1024); text(link.spanId, false, 1024); if (!(link.traceId as string).trim() || !(link.spanId as string).trim()) fail();
    text(link.traceState, true); count(link.flags); source(link);
  }
  const capture = record(evidence.capture, ["sourceCountPolicy", "droppedEvents", "droppedLinks", "droppedAttributes", "truncatedValues", "invalidValues", "redactedValues"]);
  if (capture.sourceCountPolicy !== "absent-is-unknown") fail();
  for (const key of Object.keys(capture)) if (key !== "sourceCountPolicy") count(capture[key], false);
  if (Buffer.byteLength(JSON.stringify(input)) > OTLP_EVIDENCE_LIMITS.bytes) fail();
}
