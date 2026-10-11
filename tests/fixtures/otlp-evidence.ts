import * as protobuf from "protobufjs";

export const fidelityTraceId = "102030405060708090a0b0c0d0e0f001";
export const fidelitySpanId = "1020304050607080";
export const fidelityOutput = "Captured checkout result: order A-42 is ready.";

export function fidelityRequest() {
  return { resourceSpans: [{ schemaUrl: "https://schemas.example/resource/1", resource: {
    droppedAttributesCount: 0, attributes: [{ key: "service.name", value: { stringValue: "fidelity-fixture" } }],
  }, scopeSpans: [{ schemaUrl: "https://schemas.example/scope/1", scope: {
    name: "fidelity-fixture", version: "1", droppedAttributesCount: 2,
    attributes: [{ key: "scope.marker", value: { boolValue: false } }],
  }, spans: [{ traceId: fidelityTraceId, spanId: fidelitySpanId, name: "captured-checkout",
    startTimeUnixNano: "1770000000000000001", endTimeUnixNano: "1770000000000123456",
    kind: 3, flags: 2147484417, traceState: "fixture=source", droppedAttributesCount: 0,
    droppedEventsCount: 3, droppedLinksCount: 4, status: { code: 1 },
    attributes: [{ key: "runphantom.span.kind", value: { stringValue: "agent_root" } },
      { key: "runphantom.input", value: { stringValue: '{"prompt":"Inspect checkout A-42"}' } },
      { key: "runphantom.output", value: { stringValue: fidelityOutput } }],
    events: [{ name: "checkout.captured", timeUnixNano: "1770000000000000002", droppedAttributesCount: 0,
      attributes: [{ key: "exact.order", value: { intValue: "9007199254740993" } },
        { key: "confirmed", value: { boolValue: false } }, { key: "retry", value: { intValue: "0" } }] },
      { name: "checkout.finished", timeUnixNano: "1770000000000123455", attributes: [] }],
    links: [{ traceId: "ffeeddccbbaa99887766554433221100", spanId: "ffeeddccbbaa9988", flags: 0,
      traceState: "fixture=linked", droppedAttributesCount: 5,
      attributes: [{ key: "bytes", value: { bytesValue: "AP8B" } }] }],
  }] }] }] };
}

// Independent wire fixture: these field numbers are defined by the OTLP schema.
const wire = protobuf.parse(`syntax = "proto3";
message AnyValue { oneof value { string string_value=1; bool bool_value=2; int64 int_value=3; double double_value=4; ArrayValue array_value=5; KeyValueList kvlist_value=6; bytes bytes_value=7; } }
message ArrayValue { repeated AnyValue values=1; }
message KeyValueList { repeated KeyValue values=1; }
message KeyValue { string key=1; AnyValue value=2; }
message Resource { repeated KeyValue attributes=1; uint32 dropped_attributes_count=2; }
message Scope { string name=1; string version=2; repeated KeyValue attributes=3; uint32 dropped_attributes_count=4; }
message Event { fixed64 time_unix_nano=1; string name=2; repeated KeyValue attributes=3; uint32 dropped_attributes_count=4; }
message Link { bytes trace_id=1; bytes span_id=2; string trace_state=3; repeated KeyValue attributes=4; uint32 dropped_attributes_count=5; fixed32 flags=6; }
message Status { string message=2; int32 code=3; }
message Span { bytes trace_id=1; bytes span_id=2; string trace_state=3; bytes parent_span_id=4; string name=5; int32 kind=6; fixed64 start_time_unix_nano=7; fixed64 end_time_unix_nano=8; repeated KeyValue attributes=9; uint32 dropped_attributes_count=10; repeated Event events=11; uint32 dropped_events_count=12; repeated Link links=13; uint32 dropped_links_count=14; Status status=15; fixed32 flags=16; }
message ScopeSpans { Scope scope=1; repeated Span spans=2; string schema_url=3; }
message ResourceSpans { Resource resource=1; repeated ScopeSpans scope_spans=2; string schema_url=3; }
message Request { repeated ResourceSpans resource_spans=1; }`).root.lookupType("Request");

export function encodeFidelityRequest(request = fidelityRequest()): Uint8Array {
  const body = structuredClone(request);
  for (const resource of body.resourceSpans) for (const scope of resource.scopeSpans) for (const span of scope.spans) {
    const raw = span as unknown as Record<string, any>;
    raw.traceId = Buffer.from(span.traceId, "hex"); raw.spanId = Buffer.from(span.spanId, "hex");
    for (const link of raw.links ?? []) {
      link.traceId = Buffer.from(link.traceId, "hex"); link.spanId = Buffer.from(link.spanId, "hex");
      for (const attribute of link.attributes ?? []) if (attribute.value.bytesValue !== undefined) {
        attribute.value.bytesValue = Buffer.from(attribute.value.bytesValue, "base64");
      }
    }
  }
  return wire.encode(wire.fromObject(body)).finish();
}
