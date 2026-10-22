import { expect, test } from "bun:test";
import { parseOtlpRequest } from "../src/parse";
import { normalizeStoredSpan } from "../src/spans/normalize";
import { captureTrace, captureAttributes, chunk, terminal, captureInput, captureOutput } from "./fixtures/capture-visibility";
import { classificationCases } from "./fixtures/capture-classification-cases";

test("captured hierarchy retains the existing complete ingest classification policy", () => {
  for (const [index, policy] of classificationCases.entries()) {
    const fixture = captureTrace(2000 + index), rs = fixture.body.resourceSpans[0] as any;
    rs.resource = { attributes: captureAttributes(policy.resource ?? {}) };
    rs.scopeSpans[0].scope.attributes = captureAttributes(policy.scope ?? {});
    fixture.retrieval.attributes.push(...captureAttributes(policy.span ?? {}));
    expect(parseOtlpRequest(fixture.body)[0].spanType, policy.name).toBe(policy.kind);
  }
});

test("lossy, ambiguous and malformed classification receipts cannot grant operation authority", () => {
  const span = parseOtlpRequest(captureTrace().body)[0];
  for (const mutation of ["receiver-loss", "exporter-loss", "duplicate", "malformed", "unsupported-role"]) {
    const evidence = structuredClone(span.otlpEvidence);
    if (mutation === "receiver-loss") evidence.capture.droppedAttributes++;
    if (mutation === "exporter-loss") evidence.droppedAttributesCount = 1;
    if (mutation === "duplicate") evidence.attributes.push(evidence.attributes[0]);
    if (mutation === "unsupported-role") evidence.resource = { attributes: [{ key: "openinference.span.kind", value: { bytesValue: "TOOL" } }], droppedAttributesCount: 0 };
    const receipt = JSON.stringify(evidence);
    const row = { span_type: "RETRIEVAL", attributes: JSON.stringify(span.attributes), otlp_evidence: mutation === "malformed" ? receipt.slice(0, -1) : receipt,
      normalized: { kind: "retrieval", fabricated: true }, captureVisibility: { retrieval: { fabricated: true } } };
    const projected = publicCaptureMetadata(row); expect(projected.normalized).toBeUndefined(); expect(projected.captureVisibility?.retrieval).toBeUndefined();
  }
});

test("captured retrieval metadata retains explicit zero separately from missing fields", () => {
  const span = parseOtlpRequest(captureTrace().body)[0];
  expect(span.spanType).toBe("RETRIEVAL");
  expect(span.normalized).toMatchObject({ kind: "retrieval", collection: "manuals", topK: 3, resultCount: 0, queryText: null });
});
test("explicit embedding operation has its own typed kind and dimensions", () => {
  const span = parseOtlpRequest(captureTrace().body)[1];
  expect(span.spanType).toBe("EMBEDDING"); expect(span.normalized).toMatchObject({ kind: "embedding", dimensions: 1536 });
});
test("complete bounded roster is ordered without replacing canonical messages, output or usage", () => {
  const span = parseOtlpRequest(captureTrace().body)[2] as any;
  expect(span.captureVisibility.stream).toMatchObject({ state: "completed", coverage: "complete", timeToFirstChunkMs: 0, declaredChunkCount: 2 });
  expect(span.captureVisibility.stream.chunks.map((item: any) => item.text)).toEqual(["Hello ", "world"]);
  expect(span.captureVisibility.usage).toMatchObject({ cacheReadInputTokens: 0, cacheCreationInputTokens: null, reasoningOutputTokens: 2 });
  expect(span.normalized).toMatchObject({ kind: "llm", userMessage: captureInput }); expect(span.outputPayload).toBe(captureOutput);
  expect(span.inputTokens).toBe(7); expect(span.outputTokens).toBe(3);
});
test("explicit cancellation preserves observed partial text", () => {
  expect((parseOtlpRequest(captureTrace().body)[3] as any).captureVisibility.stream).toMatchObject({ state: "cancelled", coverage: "partial", chunks: [{ text: "Partial evidence" }] });
});
test("stored re-normalization derives the same stream view from existing receipt", () => {
  const span = parseOtlpRequest(captureTrace().body)[2] as any;
  const stored = normalizeStoredSpan({ id: span.spanId, run_id: span.traceId, name: span.name, span_type: span.spanType,
    input_payload: span.inputPayload, output_payload: span.outputPayload, attributes: JSON.stringify(span.attributes), otlp_evidence: JSON.stringify(span.otlpEvidence) } as any) as any;
  expect(stored.captureVisibility).toEqual(span.captureVisibility);
});
test("explicit tool/root/trace/LLM kinds retain precedence over retrieval-looking names and metadata", () => {
  for (const [kind, expected] of [["tool_call", "TOOL_CALL"], ["agent_root", "AGENT_ROOT"], ["trace", "TRACE"], ["llm_call", "LLM_GENERATION"]]) {
    const source = captureTrace(); source.retrieval.attributes.push(...captureAttributes({ "runphantom.span.kind": kind }));
    expect(parseOtlpRequest(source.body)[0].spanType).toBe(expected);
  }
  const source = captureTrace(); source.retrieval.attributes = captureAttributes({ "ai.toolCall.name": "retrieve_embeddings", "db.operation.name": "SEARCH" });
  expect(parseOtlpRequest(source.body)[0].spanType).toBe("TOOL_CALL");
});
test("metadata-only and missing-roster streams never become complete from ended OK or finish reasons", () => {
  for (const events of [[], [chunk(0, "Partial"), terminal()], [chunk(0, "Partial"), terminal("completed", 2)]]) {
    const source = captureTrace(); source.llm.events = events; source.llm.attributes.push(...captureAttributes({ "gen_ai.response.finish_reasons": '["stop"]' }));
    const span = parseOtlpRequest(source.body)[2] as any;
    expect(span.captureVisibility.stream.state).not.toBe("completed"); expect(span.status).toBe("OK"); expect(span.outputPayload).toBe(captureOutput);
  }
});

import { publicCaptureMetadata, CAPTURE_LIMITS, sanitizeCaptureFilter } from "../src/spans/adapters/capture-visibility";

test("every cached kind removes F16 DTOs when source does not establish captured operations", () => {
  for (const spanType of [null, undefined, 0, {}, "FUTURE_KIND", "UNKNOWN", "INTERNAL", "TRACE", "AGENT_ROOT", "LLM_GENERATION", "TOOL_CALL", "RETRIEVAL", "EMBEDDING"]) {
    for (const kind of ["retrieval", "embedding"]) {
      const row = { id: "original-span", run_id: "original-run", span_type: spanType, status: "ERROR", attributes: "{}", otlp_evidence: null,
        input_payload: '{"db.filter":"ordinary literal input"}', output_payload: "ordinary output",
        normalized: { kind, filter: filterSecret }, captureVisibility: { schemaVersion: 1, stream: { state: "completed" }, retrieval: { filter: filterSecret } } };
      const projected = publicCaptureMetadata(row);
      expect(projected.captureVisibility).toBeUndefined(); expect(projected.normalized).toBeUndefined();
      for (const key of ["id", "run_id", "span_type", "status", "input_payload", "output_payload"] as const) expect(projected[key]).toEqual(row[key]);
    }
  }
});
test("contradictory cached kind cannot grant capture authority and legitimate LLM/tool normalization stays literal", () => {
  const source = captureTrace(), retrieval = parseOtlpRequest(source.body)[0], embedding = parseOtlpRequest(source.body)[1];
  for (const [spanType, attrs, receipt] of [
    ["RETRIEVAL", { "gen_ai.operation.name": "embeddings" }, null],
    ["EMBEDDING", retrieval.attributes, JSON.stringify(retrieval.otlpEvidence)],
    ["RETRIEVAL", retrieval.attributes, JSON.stringify(embedding.otlpEvidence)],
    ["RETRIEVAL", { ...retrieval.attributes, "runphantom.span.kind": "tool_call" }, null],
    ["RETRIEVAL", { ...retrieval.attributes, "openinference.span.kind": "LLM" }, null],
    ["RETRIEVAL", { ...retrieval.attributes, "runphantom.span.kind": "retrieval", "openinference.span.kind": "EMBEDDING" }, null],
  ] as const) {
    const row = { span_type: spanType, attributes: JSON.stringify(attrs), otlp_evidence: receipt, normalized: { kind: "retrieval", filter: filterSecret }, captureVisibility: { stream: { state: "completed" } } };
    const projected = publicCaptureMetadata(row); expect(projected.captureVisibility).toBeUndefined(); expect(projected.normalized).toBeUndefined();
  }
  for (const [span_type, kind] of [["LLM_GENERATION", "llm"], ["TOOL_CALL", "tool"]]) {
    const normalized = { kind, content: '{"db.filter":"literal authoritative content"}' };
    const projected = publicCaptureMetadata({ span_type, attributes: "{}", otlp_evidence: null, normalized, captureVisibility: { stream: { state: "completed" } } });
    expect(projected.normalized).toBe(normalized); expect(projected.captureVisibility).toBeUndefined();
  }
});

test("malformed and ambiguous decoded owned carriers are withheld without reinterpreting ordinary bodies", () => {
  const business = '{"db.filter":"literal authoritative body"}';
  for (const attributes of [
    '{"db.\\u0066ilter":"credential"',
    '{"db.filter":"credential","db.\\u0066ilter":"safe"}',
    '{"db.\\u005cu0066ilter":"credential"',
  ]) {
    const projected = publicCaptureMetadata({ attributes, input_payload: business, output_payload: business });
    expect(projected.attributes).toBeNull(); expect(projected.input_payload).toBe(business); expect(projected.output_payload).toBe(business);
  }
  const ordinary = { attributes: '{"business":"literal unclosed text', input_payload: business };
  expect(publicCaptureMetadata(ordinary)).toBe(ordinary);
  const ambiguousReceipt = '{"schemaVersion":2,"attributes":[{"key":"db.\\u005cu0066ilter","value":{"stringValue":"credential"}}]}';
  expect(publicCaptureMetadata({ attributes: "{}", otlp_evidence: ambiguousReceipt }).otlp_evidence).toBeNull();
  expect(publicCaptureMetadata({ attributes: "{}", otlp_evidence: " ".repeat(256 * 1024) + "credential" }).otlp_evidence).toBeNull();
});
import { encodeFidelityRequest } from "./fixtures/otlp-evidence";
import { decodeOtlpProtobuf } from "../src/otlp-protobuf";
import { filterSecret } from "./fixtures/capture-visibility";

test("independent protobuf and JSON retain the same finite capture views", () => {
  const source = captureTrace();
  expect(parseOtlpRequest(decodeOtlpProtobuf(encodeFidelityRequest(source.body as any)))).toEqual(parseOtlpRequest(source.body));
});
test("exact metadata projection redacts filter keys before every public carrier and preserves business JSON", () => {
  const source = captureTrace(), span = parseOtlpRequest(source.body)[0];
  const raw = { attributes: JSON.stringify({ ...span.attributes, "business.body": JSON.stringify({ api_key: "literal-business-value" }) }), otlp_evidence: JSON.stringify(span.otlpEvidence) };
  const safe = publicCaptureMetadata(raw);
  expect(JSON.stringify(safe)).not.toContain(filterSecret); expect(raw.attributes).toContain(filterSecret);
  expect(JSON.parse(safe.attributes)["business.body"]).toBe(JSON.parse(raw.attributes)["business.body"]);
  expect(JSON.parse(JSON.parse(safe.attributes)["db.filter"])).toEqual({ api_key: "[REDACTED]", city: "Paris" });
  expect(publicCaptureMetadata(safe)).toEqual(safe);
});
test("filter duplicate aliases and unsupported depth are withheld whole", () => {
  expect(sanitizeCaptureFilter('{"api_key":"one","api_key":"two"}')).toBe("[UNAVAILABLE]");
  expect(sanitizeCaptureFilter('{"api_key":"one","\\u0061pi_key":"two"}')).toBe("[UNAVAILABLE]");
  expect(sanitizeCaptureFilter('{"safe":' + '['.repeat(10) + '0' + ']'.repeat(10) + '}')).toBe("[UNAVAILABLE]");
  expect(sanitizeCaptureFilter('{"query":"' + "x".repeat(9000) + '"}')).toBe("[TRUNCATED]");
  expect(sanitizeCaptureFilter('{"nested":[{"authorization":"fixture-private","business":"retained"}]}')).toBe('{"nested":[{"authorization":"[REDACTED]","business":"retained"}]}');
});
test("duplicate chunk identity is disclosed while changed or conflicting terminals cannot complete", () => {
  const source = captureTrace(); source.llm.events.push(chunk(0, "Hello "));
  let stream = (parseOtlpRequest(source.body)[2] as any).captureVisibility.stream;
  expect(stream.state).toBe("completed"); expect(stream.duplicateChunkCount).toBe(1); expect(stream.chunks).toHaveLength(2);
  source.llm.events.push(chunk(0, "Changed")); stream = (parseOtlpRequest(source.body)[2] as any).captureVisibility.stream;
  expect(stream.state).toBe("incomplete"); expect(stream.reasons).toContain("duplicate-conflict");
  source.llm.events = [chunk(0, "partial"), terminal("completed", 1), terminal("cancelled")];
  expect((parseOtlpRequest(source.body)[2] as any).captureVisibility.stream).toMatchObject({ state: "incomplete", reportedTerminal: null });
});
test("exporter loss, absent drop counts and receiver truncation defeat completion", () => {
  for (const dropped of [undefined, 1]) {
    const source = captureTrace(); (source.llm as any).droppedEventsCount = dropped;
    expect((parseOtlpRequest(source.body)[2] as any).captureVisibility.stream.state).toBe("incomplete");
  }
  const source = captureTrace(); source.llm.events = Array.from({ length: 65 }, (_, index) => chunk(index, "safe")); source.llm.events.push(terminal("completed", 65));
  const projected = (parseOtlpRequest(source.body)[2] as any).captureVisibility;
  expect(projected.stream.state).toBe("incomplete"); expect(projected.stream.chunks).toHaveLength(64);
  expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(CAPTURE_LIMITS.bytes);
});
test("missing chunks, unsafe numbers, error and unsupported stream events stay explicit", () => {
  const source = captureTrace(); source.llm.events = [chunk(2, "missing"), terminal("completed", 1)];
  expect((parseOtlpRequest(source.body)[2] as any).captureVisibility.stream.reasons).toContain("missing-chunk");
  source.llm.events = [chunk(0, "failed partial"), terminal("error")];
  expect((parseOtlpRequest(source.body)[2] as any).captureVisibility.stream.state).toBe("error");
  source.llm.events = [chunk(0, "partial"), terminal("completed", 1), terminal("unrecognized")];
  expect((parseOtlpRequest(source.body)[2] as any).captureVisibility.stream.reasons).toContain("unsupported-event");
  source.retrieval.attributes.push(...captureAttributes({ "db.vector.query.top_k": -1 }));
  expect((parseOtlpRequest(source.body)[0].normalized as any).topK).toBeNull();
});
test("oversized and credential chunk text is replaced whole with incomplete capture", () => {
  for (const text of ["x".repeat(3000), `sk-proj-${"x".repeat(48)}`]) {
    const source = captureTrace(); source.llm.events = [chunk(0, text), terminal("completed", 1)];
    const projected = (parseOtlpRequest(source.body)[2] as any).captureVisibility;
    expect(JSON.stringify(projected)).not.toContain(text); expect(projected.stream.state).toBe("incomplete");
    expect(projected.stream.chunks[0].text).toMatch(/^\[(TRUNCATED|REDACTED)\]$/);
  }
});
test("explicit zero chunk roster is complete and missing model/dimensions stay unavailable", () => {
  const source = captureTrace(); source.llm.events = [terminal("completed", 0)];
  expect((parseOtlpRequest(source.body)[2] as any).captureVisibility.stream).toMatchObject({ state: "completed", declaredChunkCount: 0, chunks: [] });
  source.embedding.attributes = captureAttributes({ "openinference.span.kind": "EMBEDDING" });
  expect(parseOtlpRequest(source.body)[1].normalized).toMatchObject({ kind: "embedding", model: null, dimensions: null, inputText: null });
});

test("cached capture DTOs are rederived and invalid owned receipts cannot publish private filter companions", () => {
  const source = captureTrace(), span = parseOtlpRequest(source.body)[0];
  const row = { id: span.spanId, run_id: span.traceId, span_type: span.spanType, attributes: JSON.stringify(span.attributes), otlp_evidence: JSON.stringify(span.otlpEvidence),
    captureVisibility: { secret: filterSecret }, normalized: { kind: "retrieval", filter: filterSecret } };
  const safe = publicCaptureMetadata(row);
  expect(JSON.stringify(safe)).not.toContain(filterSecret); expect((safe.captureVisibility as any).retrieval.resultCount).toBe(0);
  const invalid = publicCaptureMetadata({ ...row, otlp_evidence: row.otlp_evidence.slice(0, -1) });
  expect(invalid.otlp_evidence).toBeNull(); expect(JSON.stringify(invalid)).not.toContain(filterSecret);
});

test("UTF-8 projection cap counts JSON escaping and discloses whole-view loss", () => {
  const source = captureTrace();
  source.body.resourceSpans[0].scopeSpans[0].scope.name = "\u0001".repeat(4096);
  source.body.resourceSpans[0].scopeSpans[0].scope.version = "\u0001".repeat(4096);
  source.llm.events = Array.from({ length: 16 }, (_, sequence) => chunk(sequence, "\u0001".repeat(1024)));
  source.llm.events.push(terminal("completed", 16));
  const capture = (parseOtlpRequest(source.body)[2] as any).captureVisibility;
  expect(Buffer.byteLength(JSON.stringify(capture))).toBeLessThanOrEqual(CAPTURE_LIMITS.bytes);
  expect(capture.stream.state).toBe("incomplete"); expect(capture.stream.reasons).toContain("content-truncated");
  expect(capture.stream.chunks).toEqual([]); expect(capture.stream.observedChunkCount).toBe(16);
});
