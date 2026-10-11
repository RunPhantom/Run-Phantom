import { expect, test } from "bun:test";
import { decodeOtlpProtobuf } from "../src/otlp-protobuf";
import { parseOtlpRequest } from "../src/parse";
import { OTLP_EVIDENCE_LIMITS, captureOtlpEvidence, validateOtlpEvidence } from "../src/spans/otlp-evidence";
import { encodeFidelityRequest, fidelityOutput, fidelityRequest } from "./fixtures/otlp-evidence";

test("JSON and independent protobuf source retain exact nanoseconds, int64 values, links and explicit zero", () => {
  const json = fidelityRequest();
  const binary = decodeOtlpProtobuf(encodeFidelityRequest(json));
  const a = parseOtlpRequest(json)[0], b = parseOtlpRequest(binary)[0];
  expect(b).toEqual(a);
  validateOtlpEvidence(a.otlpEvidence);
  expect(a.otlpEvidence).toMatchObject({ startTimeUnixNano: "1770000000000000001", endTimeUnixNano: "1770000000000123456",
    kind: 3, flags: 2147484417, traceState: "fixture=source", droppedAttributesCount: 0, droppedEventsCount: 3, droppedLinksCount: 4,
    resource: { droppedAttributesCount: 0 }, scope: { droppedAttributesCount: 2 },
    capture: { sourceCountPolicy: "absent-is-unknown", droppedEvents: 0, droppedLinks: 0, droppedAttributes: 0, truncatedValues: 0, invalidValues: 0, redactedValues: 0 } });
  expect(a.otlpEvidence.events[0]).toMatchObject({ timeUnixNano: "1770000000000000002", droppedAttributesCount: 0,
    attributes: [{ key: "exact.order", value: { intValue: "9007199254740993" } }, { key: "confirmed", value: { boolValue: false } }, { key: "retry", value: { intValue: "0" } }] });
  expect(a.otlpEvidence.events[1].droppedAttributesCount).toBeNull();
  expect(a.otlpEvidence.links[0]).toMatchObject({ traceId: "ffeeddccbbaa99887766554433221100", spanId: "ffeeddccbbaa9988", flags: 0,
    droppedAttributesCount: 5, attributes: [{ key: "bytes", value: { bytesValue: "AP8B" } }] });
  expect(a.outputPayload).toBe(fidelityOutput);
  expect(a.normalized).toEqual({ kind: "other" });
});

test("absent protobuf fields remain unavailable instead of becoming captured zero", () => {
  const body = fidelityRequest() as any, span = body.resourceSpans[0].scopeSpans[0].spans[0];
  for (const field of ["kind", "flags", "startTimeUnixNano", "endTimeUnixNano", "droppedAttributesCount", "droppedEventsCount", "droppedLinksCount"]) delete span[field];
  delete body.resourceSpans[0].resource; delete body.resourceSpans[0].scopeSpans[0].scope;
  delete body.resourceSpans[0].schemaUrl; delete body.resourceSpans[0].scopeSpans[0].schemaUrl;
  const json = parseOtlpRequest(body)[0], binary = parseOtlpRequest(decodeOtlpProtobuf(encodeFidelityRequest(body)))[0];
  expect(binary).toEqual(json);
  expect(binary.otlpEvidence).toMatchObject({ startTimeUnixNano: null, endTimeUnixNano: null, kind: null, flags: null,
    droppedAttributesCount: null, droppedEventsCount: null, droppedLinksCount: null, resource: null, scope: null,
    capture: { sourceCountPolicy: "absent-is-unknown" } });
});

test("schema URLs survive even when the resource and instrumentation scope objects are absent", () => {
  const body = fidelityRequest() as any;
  delete body.resourceSpans[0].resource; delete body.resourceSpans[0].scopeSpans[0].scope;
  const a = parseOtlpRequest(body)[0].otlpEvidence;
  expect(parseOtlpRequest(decodeOtlpProtobuf(encodeFidelityRequest(body)))[0].otlpEvidence).toEqual(a);
  expect(a.resource).toEqual({ schemaUrl: "https://schemas.example/resource/1", attributes: [], droppedAttributesCount: null });
  expect(a.scope).toEqual({ name: null, version: null, schemaUrl: "https://schemas.example/scope/1", attributes: [], droppedAttributesCount: null });
});

test("bounded source lists disclose receiver loss independently of exporter drop counts", () => {
  const body = fidelityRequest() as any, span = body.resourceSpans[0].scopeSpans[0].spans[0];
  span.events = Array.from({ length: OTLP_EVIDENCE_LIMITS.events + 2 }, (_, index) => ({ name: `event-${index}`, timeUnixNano: "1", attributes: [] }));
  span.links = Array.from({ length: OTLP_EVIDENCE_LIMITS.links + 3 }, () => ({ traceId: span.traceId, spanId: span.spanId, attributes: [] }));
  span.attributes.push(...Array.from({ length: OTLP_EVIDENCE_LIMITS.attributes }, (_, index) => ({ key: `attribute-${index}`, value: { boolValue: false } })));
  const before = JSON.stringify(body), evidence = parseOtlpRequest(body)[0].otlpEvidence;
  validateOtlpEvidence(evidence);
  expect(evidence.events).toHaveLength(128); expect(evidence.links).toHaveLength(128); expect(evidence.attributes).toHaveLength(128);
  expect(evidence.capture).toMatchObject({ droppedEvents: 2, droppedLinks: 3, droppedAttributes: 3 });
  expect(evidence.droppedEventsCount).toBe(3); expect(evidence.droppedLinksCount).toBe(4);
  expect(JSON.stringify(body)).toBe(before);
});

test("new event evidence redacts credentials, drops prototype keys and never invokes source accessors", () => {
  const body = fidelityRequest() as any, span = body.resourceSpans[0].scopeSpans[0].spans[0];
  const credential = `sk-proj-${"x".repeat(48)}`;
  let accessed = false;
  span.events[0].attributes.push({ key: "api_key", value: { stringValue: credential } },
    { key: "url", value: { stringValue: `https://example.test/check?token=${credential}&order=A-42` } },
    { key: "__proto__", value: { stringValue: "ignored" } });
  const accessor = Object.defineProperty({}, "stringValue", { enumerable: true, get() { accessed = true; return "wrong"; } });
  span.events[0].attributes.push({ key: "inert", value: accessor });
  const evidence = captureOtlpEvidence(span, body.resourceSpans[0], body.resourceSpans[0].scopeSpans[0]);
  expect(accessed).toBe(false); expect(JSON.stringify(evidence)).not.toContain(credential);
  expect(evidence.events[0].attributes).toContainEqual({ key: "api_key", value: { stringValue: "[REDACTED]" } });
  expect(evidence.capture).toMatchObject({ droppedAttributes: 1, invalidValues: 2, redactedValues: 2 });
  expect(({} as Record<string, unknown>).ignored).toBeUndefined();
  validateOtlpEvidence(evidence);
});

test("depth, value-node and byte bounds produce portable explicit loss rather than invalid clipped values", () => {
  for (const pressure of ["depth", "nodes", "bytes"]) {
    const body = fidelityRequest() as any, span = body.resourceSpans[0].scopeSpans[0].spans[0];
    if (pressure === "depth") {
      let nested: any = { stringValue: "deep" };
      for (let i = 0; i < 20; i++) nested = { arrayValue: { values: [nested] } };
      span.events[0].attributes.push({ key: "depth", value: nested });
    } else if (pressure === "nodes") {
      span.events[0].attributes = Array.from({ length: 128 }, (_, index) => ({ key: `wide-${index}`, value: {
        arrayValue: { values: Array.from({ length: 128 }, () => ({ boolValue: false })) } } }));
    } else {
      span.events = Array.from({ length: 128 }, (_, index) => ({ name: `${index}: ${"🧪".repeat(2000)}`, timeUnixNano: "1", attributes: [] }));
    }
    const evidence = parseOtlpRequest(body)[0].otlpEvidence;
    expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThanOrEqual(OTLP_EVIDENCE_LIMITS.bytes);
    expect(evidence.capture.droppedEvents + evidence.capture.droppedAttributes + evidence.capture.truncatedValues).toBeGreaterThan(0);
    validateOtlpEvidence(evidence);
    expect(parseOtlpRequest(body)[0].outputPayload).toBe(fidelityOutput);
  }
});

test("portable validator refuses malformed, unsafe and executable-shaped envelopes without invoking accessors", () => {
  const original = parseOtlpRequest(fidelityRequest())[0].otlpEvidence;
  for (const mutate of [
    (value: any) => { value.flags = -1; },
    (value: any) => { value.events[0].timeUnixNano = 1770000000000000000; },
    (value: any) => { value.events[0].attributes[0].value.intValue = "9223372036854775808"; },
    (value: any) => { value.events[0].attributes.push({ key: "api_key", value: { stringValue: "do-not-persist" } }); },
    (value: any) => { value.capture.unreported = true; },
  ]) { const invalid = structuredClone(original); mutate(invalid); expect(() => validateOtlpEvidence(invalid)).toThrow(); }
  let invoked = false;
  const getter = Object.defineProperty(structuredClone(original), "flags", { enumerable: true, get() { invoked = true; return 0; } });
  expect(() => validateOtlpEvidence(getter)).toThrow(); expect(invoked).toBe(false);
  const coercion = Object.assign(Object.create({ toJSON() { invoked = true; return original; } }), original);
  expect(() => validateOtlpEvidence(coercion)).toThrow(); expect(invoked).toBe(false);
  const sensitive = structuredClone(original);
  sensitive.attributes.push({ key: "api_key", value: Object.defineProperty({}, "stringValue", {
    enumerable: true, get() { invoked = true; return "[REDACTED]"; },
  }) as any });
  expect(() => validateOtlpEvidence(sensitive)).toThrow(); expect(invoked).toBe(false);
});
