import { describe, expect, test } from "bun:test";
import { parseSpanAttributes, requestedToolCalls, spanFinishReasons, spanReasoningTokens, stoppedEarlyReason } from "../app/src/utils/span-evidence";

// Attribute shapes copied from real captures: openinference-instrumentation-openai
// 0.1.69 on the Responses API with gpt-6.1-terra, and -anthropic 3.3.1.
const openInferenceToolTurn = {
  "openinference.span.kind": "LLM",
  "llm.output_messages.0.message.role": "assistant",
  "llm.output_messages.0.message.contents.0.message_content.type": "reasoning",
  "llm.output_messages.1.message.role": "assistant",
  "llm.output_messages.1.message.tool_calls.0.tool_call.id": "call_weather",
  "llm.output_messages.1.message.tool_calls.0.tool_call.function.name": "get_weather",
  "llm.output_messages.1.message.tool_calls.0.tool_call.function.arguments": "{\"city\":\"Lisbon\"}",
  "llm.output_messages.2.message.role": "assistant",
  "llm.output_messages.2.message.tool_calls.0.tool_call.id": "call_calc",
  "llm.output_messages.2.message.tool_calls.0.tool_call.function.name": "calculate",
  "llm.output_messages.2.message.tool_calls.0.tool_call.function.arguments": "{\"expression\":\"17.5 * 4\"}",
  "llm.token_count.completion": 63,
  "llm.token_count.completion_details.reasoning": 8,
};

describe("generation evidence reported only as attributes", () => {
  test("OpenInference tool-call-only turns expose every requested call in order", () => {
    expect(requestedToolCalls(openInferenceToolTurn)).toEqual([
      { id: "call_weather", name: "get_weather", arguments: { city: "Lisbon" } },
      { id: "call_calc", name: "calculate", arguments: { expression: "17.5 * 4" } },
    ]);
  });

  test("message indices sort numerically, not lexically", () => {
    const attrs: Record<string, unknown> = {};
    for (const index of [10, 2]) {
      attrs[`llm.output_messages.${index}.message.tool_calls.0.tool_call.function.name`] = `tool_${index}`;
      attrs[`llm.output_messages.${index}.message.tool_calls.0.tool_call.function.arguments`] = "not json";
    }
    expect(requestedToolCalls(attrs)).toEqual([
      { id: null, name: "tool_2", arguments: "not json" },
      { id: null, name: "tool_10", arguments: "not json" },
    ]);
  });

  test("OpenTelemetry GenAI and AI SDK tool calls are read from their own conventions", () => {
    expect(requestedToolCalls({ "gen_ai.output.messages": JSON.stringify([{ role: "assistant", parts: [{ type: "text", content: "Checking" }, { type: "tool_call", id: "c1", name: "lookup", arguments: { id: "A-1" } }] }]) }))
      .toEqual([{ id: "c1", name: "lookup", arguments: { id: "A-1" } }]);
    expect(requestedToolCalls({ "ai.response.toolCalls": JSON.stringify([{ toolCallId: "t1", toolName: "search", input: "{\"q\":\"tides\"}" }]) }))
      .toEqual([{ id: "t1", name: "search", arguments: { q: "tides" } }]);
    expect(requestedToolCalls({ "gen_ai.output.messages": "[malformed" })).toEqual([]);
    expect(requestedToolCalls(null)).toEqual([]);
  });

  test("finish reasons merge every convention and flag early stops", () => {
    expect(spanFinishReasons({ "llm.finish_reason": "length" })).toEqual(["length"]);
    expect(spanFinishReasons({ "gen_ai.response.finish_reasons": JSON.stringify(["stop", "tool_calls"]) })).toEqual(["stop", "tool_calls"]);
    expect(spanFinishReasons({ "ai.response.finishReason": "unknown" })).toEqual([]);
    expect(stoppedEarlyReason(["length"])).toBe("length");
    expect(stoppedEarlyReason(["max_tokens"])).toBe("max_tokens");
    expect(stoppedEarlyReason(["refusal"])).toBe("refusal");
    expect(stoppedEarlyReason(["stop", "tool_calls"])).toBeNull();
  });

  test("reasoning tokens are read across conventions and conflicts stay unknown", () => {
    expect(spanReasoningTokens(openInferenceToolTurn)).toBe(8);
    expect(spanReasoningTokens({ "gen_ai.usage.output_tokens.reasoning": 1500 })).toBe(1500);
    expect(spanReasoningTokens({ "llm.token_count.completion_details.reasoning": 0 })).toBe(0);
    expect(spanReasoningTokens({ "llm.token_count.completion_details.reasoning": 3, "gen_ai.usage.output_tokens.reasoning": 4 })).toBeNull();
    expect(spanReasoningTokens({ "llm.token_count.completion_details.reasoning": -1 })).toBeNull();
    expect(spanReasoningTokens({})).toBeNull();
  });

  test("attribute parsing accepts only JSON objects", () => {
    expect(parseSpanAttributes("{\"a\":1}")).toEqual({ a: 1 });
    expect(parseSpanAttributes("[1]")).toBeNull();
    expect(parseSpanAttributes("{")).toBeNull();
    expect(parseSpanAttributes(null)).toBeNull();
  });
});
