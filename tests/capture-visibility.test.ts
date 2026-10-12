import { expect, test } from "bun:test";
import { parseOtlpRequest } from "../src/parse";
import { normalizeStoredSpan } from "../src/spans/normalize";
import { captureTrace, captureAttributes, chunk, terminal, captureInput, captureOutput } from "./fixtures/capture-visibility";

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
