import { randomBytes } from "node:crypto";
import { VERSION } from "../version";
import type { ExecutedCall } from "./execute";
import type { PlaygroundCallResult, PlaygroundMessage, PlaygroundRunRequest, PlaygroundTarget } from "./protocol";
import { OTEL_PROVIDER_NAME } from "./providers";

export const PLAYGROUND_TAG = "playground";
/** Per-model so Playground rows in the Runs list (which shows event_name) say which model ran. */
export const playgroundEventName = (model: string) => `Playground: ${model}`;

type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } | { arrayValue: { values: OtlpValue[] } };
type OtlpAttribute = { key: string; value: OtlpValue };

const attr = (key: string, value: string | number | boolean | string[] | null | undefined): OtlpAttribute | null => {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return { key, value: { arrayValue: { values: value.map(item => ({ stringValue: item })) } } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") return { key, value: Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value } };
  return { key, value: { stringValue: value } };
};
const attrs = (...items: Array<OtlpAttribute | null>): OtlpAttribute[] => items.filter((item): item is OtlpAttribute => item !== null);
const nanos = (ms: number) => (BigInt(Math.round(ms)) * 1_000_000n).toString();

export const newTraceId = () => randomBytes(16).toString("hex");
export const newSpanId = () => randomBytes(8).toString("hex");

/** OpenTelemetry GenAI input message shape (role + typed parts). */
export function genAiInputMessages(messages: PlaygroundMessage[]): unknown[] {
  return messages.map(message => {
    if (message.role === "user") return { role: "user", parts: [{ type: "text", content: message.content }] };
    if (message.role === "assistant") return {
      role: "assistant",
      parts: [
        ...(message.content ? [{ type: "text", content: message.content }] : []),
        ...(message.toolCalls ?? []).map(call => ({ type: "tool_call", id: call.id, name: call.name, arguments: call.arguments })),
      ],
    };
    return { role: "tool", parts: [{ type: "tool_call_response", id: message.toolCallId, response: message.content }] };
  });
}

function genAiOutputMessages(result: PlaygroundCallResult | ExecutedCall["result"]): unknown[] {
  const parts = [
    ...(result.output.text ? [{ type: "text", content: result.output.text }] : []),
    ...result.output.toolCalls.map(call => ({ type: "tool_call", id: call.id, name: call.name, arguments: call.arguments })),
  ];
  return parts.length ? [{ role: "assistant", parts, finish_reason: result.finishReason ?? "error" }] : [];
}

function lastUserText(messages: PlaygroundMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "user") return message.content;
    if (message.role === "tool") return message.content;
  }
  return "";
}

export interface PlaygroundTraceIds {
  traceId: string;
  rootSpanId: string;
  llmSpanId: string;
}

/**
 * Builds the OTLP/JSON export a well-instrumented agent would send for this call: an `invoke_agent` root span and one
 * GenAI inference span carrying messages, model, usage, latency, status and error, so it is ingested like any other trace.
 */
export function buildPlaygroundOtlp(input: {
  request: PlaygroundRunRequest;
  target: PlaygroundTarget;
  call: ExecutedCall;
  comparisonId: string;
  ids: PlaygroundTraceIds;
}): Record<string, unknown> {
  const { request, target, call, comparisonId, ids } = input;
  const result = call.result;
  const sent = call.sent;
  const failed = result.status === "error";
  const errorStatus = failed ? { code: 2, message: result.error?.message ?? "Provider call failed" } : { code: 1 };
  const operation = target.provider === "gemini" ? "generate_content" : "chat";
  const usage = result.usage;
  const tokens = (value: number | null) => value ?? undefined;

  const root = {
    traceId: ids.traceId, spanId: ids.rootSpanId, name: `Playground: ${target.model}`, kind: 1,
    startTimeUnixNano: nanos(call.startedAt), endTimeUnixNano: nanos(Math.max(call.endedAt, call.startedAt)),
    // The root stands for the whole run (rootFailed in src/run-status.ts): a rejected call produced no output, so the run failed.
    status: errorStatus,
    attributes: attrs(
      attr("runphantom.span.kind", "agent_root"),
      attr("gen_ai.operation.name", "invoke_agent"),
      attr("gen_ai.agent.name", "playground"),
      attr("gen_ai.conversation.id", comparisonId),
      attr("runphantom.event.name", playgroundEventName(target.model)),
      attr("runphantom.playground.status", result.status),
      attr("runphantom.playground", true),
      attr("runphantom.playground.comparison_id", comparisonId),
      attr("runphantom.playground.target_index", result.index),
      attr("runphantom.playground.source.run_id", request.source?.runId),
      attr("runphantom.playground.source.span_id", request.source?.spanId),
      attr("tags", [PLAYGROUND_TAG]),
      attr("runphantom.input", lastUserText(request.messages)),
      attr("runphantom.output", result.output.text || (result.output.toolCalls.length ? JSON.stringify(result.output.toolCalls.map(({ name, arguments: args }) => ({ name, arguments: args }))) : result.error?.message)),
    ),
  };

  const llm = {
    traceId: ids.traceId, spanId: ids.llmSpanId, parentSpanId: ids.rootSpanId, name: `${operation} ${target.model}`, kind: 3,
    startTimeUnixNano: nanos(call.startedAt), endTimeUnixNano: nanos(Math.max(call.endedAt, call.startedAt)),
    status: errorStatus,
    attributes: attrs(
      attr("runphantom.span.kind", "llm_call"),
      attr("gen_ai.operation.name", operation),
      attr("gen_ai.provider.name", OTEL_PROVIDER_NAME[target.provider]),
      attr("gen_ai.request.model", target.model),
      attr("gen_ai.response.model", result.responseModel),
      attr("gen_ai.response.id", result.responseId),
      attr("gen_ai.request.max_tokens", sent?.maxOutputTokens),
      attr("gen_ai.request.temperature", sent?.temperature),
      attr("gen_ai.request.reasoning_effort", sent?.reasoningEffort),
      attr("gen_ai.response.finish_reasons", result.providerFinishReason ? [result.providerFinishReason] : undefined),
      attr("gen_ai.system_instructions", request.system ? JSON.stringify([{ type: "text", content: request.system }]) : undefined),
      attr("gen_ai.input.messages", JSON.stringify(genAiInputMessages(request.messages))),
      attr("gen_ai.output.messages", failed && !result.output.text && !result.output.toolCalls.length
        ? JSON.stringify({ error: result.error?.message ?? "Provider call failed" })
        : JSON.stringify(genAiOutputMessages(result))),
      attr("gen_ai.tool.definitions", request.tools.length ? JSON.stringify(request.tools.map(tool => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters }))) : undefined),
      attr("gen_ai.usage.input_tokens", tokens(usage.inputTokens)),
      attr("gen_ai.usage.output_tokens", tokens(usage.outputTokens)),
      attr("gen_ai.usage.cache_read.input_tokens", tokens(usage.cachedInputTokens)),
      attr("gen_ai.usage.cache_creation.input_tokens", tokens(usage.cacheWriteInputTokens)),
      attr("gen_ai.usage.output_tokens.reasoning", tokens(usage.reasoningTokens)),
      attr("runphantom.usage.input_includes_cache", usage.inputTokens !== null ? true : undefined),
      attr("runphantom.usage.output_includes_reasoning", usage.outputTokens !== null ? true : undefined),
      attr("runphantom.playground", true),
      attr("runphantom.playground.latency_ms", result.latencyMs),
      attr("runphantom.playground.time_to_first_token_ms", result.timeToFirstTokenMs),
      attr("runphantom.playground.finish_reason", result.finishReason),
      attr("runphantom.playground.warnings", result.warnings.length ? result.warnings : undefined),
      attr("error.type", failed ? result.error?.kind : undefined),
      attr("http.response.status_code", result.error?.httpStatus),
      attr("runphantom.playground.provider_message", result.error?.providerMessage),
    ),
  };

  return {
    resourceSpans: [{
      resource: { attributes: attrs(attr("service.name", "runphantom-playground"), attr("service.version", VERSION)) },
      scopeSpans: [{ scope: { name: "runphantom.playground", version: VERSION }, spans: [root, llm] }],
    }],
  };
}
