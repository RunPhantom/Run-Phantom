import { expect, test } from "bun:test";
import { normalizeCursorHook, parseCursorHookInput } from "../src/coding-hooks/cursor";
import { claudeEntityProjection } from "../src/coding-hooks/projection";
import { adapterInputFromStoredSpan, normalizeSpan, normalizeStoredSpan } from "../src/spans/normalize";
import { outputCompletionEvidence } from "../src/spans/completion";
import { parseOtlpRequest } from "../src/parse";
import { cursorHook } from "./fixtures/coding-hooks-cursor";
const sourceKey = "a".repeat(64), run = { runId: "a".repeat(32), rootSpanId: "b".repeat(16) };
function projection(event: string, mode: "full" | "metadata" = "full") {
  const hook = parseCursorHookInput(cursorHook(event)); if (hook.status !== "accepted") throw new Error("Invalid fixture");
  const batch = normalizeCursorHook(hook.value, sourceKey, mode), entity = batch.entities.at(-1)!;
  return claudeEntityProjection(entity, run, mode, JSON.stringify(entity), "cursor");
}
for (const [event, kind, text] of [["beforeSubmitPrompt", "other", "Explain the synthetic result"], ["afterAgentResponse", "llm", "Captured synthetic Cursor answer"], ["postToolUse", "tool", null], ["sessionStart", "other", null]] as const) test(`actual ${event} projection has a separate closed Cursor read contract`, () => {
  const p = projection(event), normalized = normalizeStoredSpan(p).normalized;
  expect(normalized.kind).toBe(kind); expect(normalized.capture?.contract).toBe("runphantom.cursor-hook.observation/v1");
  expect(normalized.capture?.coverage).toBe("partial"); expect(normalized.capture?.runtimeVerified).toBe(false); expect(p.provider).toBeNull();
  if (event === "beforeSubmitPrompt") expect(normalized.capture?.userText).toBe(text);
  if (event === "afterAgentResponse") expect(normalized.capture?.assistantText).toBe(text);
  expect(outputCompletionEvidence(p.attributes)).toBe("unconfirmed");
});
test("metadata Cursor output never acquires visible text or a trusted completion claim", () => {
  const p = projection("afterAgentResponse", "metadata"), normalized = normalizeStoredSpan(p).normalized;
  expect(normalized.capture?.assistantText).toBeNull(); expect(p.output_payload).toBeNull(); expect(p.end_time_ms).toBeNull(); expect(p.duration_ms).toBeNull();
});
for (const edit of ["unknown-version", "verified", "shape", "source", "kind", "usage", "duplicate"] as const) test(`malformed Cursor contract ${edit} cannot fall through into a generic SDK interpretation`, () => {
  const p = projection("afterAgentResponse"), a = JSON.parse(p.attributes);
  if (edit === "unknown-version") a.captureContract = "runphantom.cursor-hook.observation/v99";
  if (edit === "verified") a.runtimeVerified = true;
  if (edit === "shape") a.future = true;
  if (edit === "source") a.source = "anthropic";
  if (edit === "kind") a.entityKind = "constructor";
  if (edit === "usage") a.usage = { outputTokens: 999 };
  const raw = edit === "duplicate" ? JSON.stringify(a).replace('"source":', '"source":"cursor_hook","source":') : JSON.stringify(a);
  const normalized = normalizeStoredSpan({ ...p, attributes: raw }).normalized;
  expect(normalized).toEqual({ kind: "other" }); expect(outputCompletionEvidence(raw)).toBe("unconfirmed");
});
function otlp(contract: string | null, code: number) {
  return { resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: run.runId, spanId: run.rootSpanId, name: "root", startTimeUnixNano: "1000000", endTimeUnixNano: "2000000", status: { code }, attributes: contract === null ? [] : [{ key: "captureContract", value: { stringValue: contract } }] }] }] }] };
}
for (const contract of ["runphantom.cursor-hook.observation/v1", "runphantom.cursor-hook.observation/unknown"]) test(`OTLP ${contract} cannot turn unknown runtime completion into successful status`, () => {
  for (const code of [0, 1]) expect(parseOtlpRequest(otlp(contract, code))[0].status).toBe("UNSET");
  expect(parseOtlpRequest(otlp(contract, 2))[0].status).toBe("ERROR");
  expect(outputCompletionEvidence({ captureContract: contract, "gen_ai.is_streaming": false })).toBe("unconfirmed");
  expect(outputCompletionEvidence({ captureContract: contract, "gen_ai.is_streaming": true, "gen_ai.response.finish_reasons": ["stop"] })).toBe("unconfirmed");
});
test("ordinary ended OTLP and existing Claude status/completion semantics remain unchanged", () => {
  expect(parseOtlpRequest(otlp(null, 0))[0].status).toBe("OK"); expect(parseOtlpRequest(otlp(null, 2))[0].status).toBe("ERROR");
  expect(parseOtlpRequest(otlp("runphantom.claude-hook.observation/v1", 0))[0].status).toBe("OK");
  expect(outputCompletionEvidence({ captureContract: "runphantom.claude-hook.observation/v1" })).toBe("not-streaming");
  expect(outputCompletionEvidence({ "gen_ai.is_streaming": true, "gen_ai.response.finish_reasons": ["stop"] })).toBe("confirmed");
});

for (const [name, raw] of [
  ["last null", '{"captureContract":"runphantom.cursor-hook.observation/v1","captureContract":null,"gen_ai.operation.name":"chat"}'],
  ["last unrelated", '{"captureContract":"runphantom.cursor-hook.observation/v1","captureContract":"ordinary","gen_ai.operation.name":"chat"}'],
  ["escaped alias", String.raw`{"captureContract":"runphantom.cursor-hook.observation/v1","cap\u0074ureContract":null,"gen_ai.operation.name":"chat"}`],
  ["ordinary duplicate", '{"gen_ai.operation.name":"chat","gen_ai.operation.name":"chat"}'],
]) test(`stored duplicate ${name} cannot select any generic adapter`, () => {
  for (const span_type of ["LLM_GENERATION", "TOOL_CALL"]) {
    const row = { name: "ai.generateText", span_type, input_payload: '"generic prompt must not recover"', output_payload: '"generic output must not recover"', attributes: raw };
    expect(normalizeStoredSpan(row).normalized).toEqual({ kind: "other" });
    expect(normalizeSpan(adapterInputFromStoredSpan(row)).normalized).toEqual({ kind: "other" });
    expect(outputCompletionEvidence(raw)).toBe("unconfirmed");
  }
});
test("valid ordinary SDK, Claude and Cursor reads retain their interpretations without new ordinary byte limits", () => {
  const row = { name: "generic", span_type: "LLM_GENERATION", input_payload: null, output_payload: null, attributes: JSON.stringify({ "gen_ai.operation.name": "chat", "gen_ai.response.model": "synthetic-model", extra: "x".repeat(20000) }) };
  expect(normalizeStoredSpan(row).normalized).toMatchObject({ kind: "llm", model: "synthetic-model" });
  const cursor = projection("afterAgentResponse"); expect(normalizeStoredSpan(cursor).normalized.capture?.contract).toBe("runphantom.cursor-hook.observation/v1");
  const tool = projection("postToolUse");
  const claude = { ...tool, attributes: tool.attributes.replaceAll("runphantom.cursor-hook", "runphantom.claude-hook").replace('"source":"cursor_hook"', '"source":"claude_hook"') };
  expect(normalizeStoredSpan(claude).normalized.capture?.contract).toBe("runphantom.claude-hook.observation/v1");
});
