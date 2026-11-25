import { createHash, randomBytes } from "node:crypto";
import {
  PLAYGROUND_LIMITS, emptyUsage, findPlaygroundModel,
  type PlaygroundError, type PlaygroundErrorKind, type PlaygroundFinishReason, type PlaygroundMessage, type PlaygroundProvider,
  type PlaygroundRunRequest, type PlaygroundTarget, type PlaygroundToolCall, type PlaygroundUsage,
} from "./protocol";
import type { SseEvent } from "./sse";

export const PROVIDER_LABEL: Readonly<Record<PlaygroundProvider, string>> = Object.freeze({ openai: "OpenAI", anthropic: "Anthropic", gemini: "Google Gemini" });

/** OpenTelemetry GenAI `gen_ai.provider.name` values. */
export const OTEL_PROVIDER_NAME: Readonly<Record<PlaygroundProvider, string>> = Object.freeze({ openai: "openai", anthropic: "anthropic", gemini: "gcp.gemini" });

export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** The parameters actually sent, after per-model adjustments. */
  sent: { temperature: number | null; maxOutputTokens: number; reasoningEffort: string | null };
  warnings: string[];
}

export class ProviderStreamError extends Error {
  constructor(readonly kind: PlaygroundErrorKind, readonly providerMessage: string | null) { super(providerMessage ?? kind); this.name = "ProviderStreamError"; }
}

function jsonText(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function adjustedParams(request: PlaygroundRunRequest, target: PlaygroundTarget) {
  const spec = findPlaygroundModel(target.provider, target.model);
  const warnings: string[] = [];
  let temperature = request.params.temperature ?? null;
  if (temperature !== null && spec && !spec.temperature) {
    warnings.push(`${target.model} does not accept a temperature setting, so it was sent without one.`);
    temperature = null;
  } else if (temperature !== null && spec && temperature > spec.maxTemperature) {
    warnings.push(`${target.model} accepts a temperature up to ${spec.maxTemperature}, so ${temperature} was sent as ${spec.maxTemperature}.`);
    temperature = spec.maxTemperature;
  }
  let reasoningEffort = request.params.reasoningEffort ?? null;
  if (reasoningEffort !== null && !spec?.reasoningEffort) {
    warnings.push(`${target.model} does not take a reasoning effort setting, so it was ignored.`);
    reasoningEffort = null;
  }
  return { temperature, reasoningEffort, maxOutputTokens: request.params.maxOutputTokens, warnings };
}

function openAiMessages(request: PlaygroundRunRequest): unknown[] {
  const out: unknown[] = request.system ? [{ role: "system", content: request.system }] : [];
  for (const message of request.messages) {
    if (message.role === "user") out.push({ role: "user", content: message.content });
    else if (message.role === "assistant") out.push({
      role: "assistant", content: message.content || null,
      ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: jsonText(call.arguments) } })) } : {}),
    });
    else out.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content });
  }
  return out;
}

// Anthropic tool_use ids must match ^[a-zA-Z0-9_-]+$; drafts opened from other providers may carry ids with . or :.
// The hash suffix keeps ids such as "a.b" and "a:b" distinct after the rewrite.
export function anthropicId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "_");
  return safe === id ? id : `${safe}_${createHash("sha256").update(id).digest("hex").slice(0, 8)}`;
}

/** Prefix of ids invented for Gemini function calls that arrived without one; they are never sent back to Google. */
export const GEMINI_SYNTHETIC_CALL_ID = "gemini_call_";
const geminiCallId = (id: string): { id?: string } => id.startsWith(GEMINI_SYNTHETIC_CALL_ID) ? {} : { id };

function anthropicMessages(messages: PlaygroundMessage[]): unknown[] {
  const out: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];
  const push = (role: "user" | "assistant", blocks: unknown[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const message of messages) {
    if (message.role === "user") push("user", [{ type: "text", text: message.content }]);
    else if (message.role === "assistant") push("assistant", [
      ...(message.content.trim() ? [{ type: "text", text: message.content }] : []),
      ...(message.toolCalls ?? []).map(call => ({ type: "tool_use", id: anthropicId(call.id), name: call.name, input: call.arguments })),
    ]);
    else push("user", [{ type: "tool_result", tool_use_id: anthropicId(message.toolCallId), content: message.content }]);
  }
  return out;
}

function geminiResponse(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* plain text result */ }
  return { result: content };
}

function geminiContents(messages: PlaygroundMessage[]): unknown[] {
  const names = new Map<string, string>();
  const out: Array<{ role: "user" | "model"; parts: unknown[] }> = [];
  const push = (role: "user" | "model", parts: unknown[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else out.push({ role, parts });
  };
  for (const message of messages) {
    if (message.role === "user") push("user", [{ text: message.content }]);
    else if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
      push("model", [
        ...(message.content.trim() ? [{ text: message.content }] : []),
        ...(message.toolCalls ?? []).map(call => ({ functionCall: { ...geminiCallId(call.id), name: call.name, args: call.arguments }, ...(call.signature ? { thoughtSignature: call.signature } : {}) })),
      ]);
    } else push("user", [{ functionResponse: { ...geminiCallId(message.toolCallId), name: message.name ?? names.get(message.toolCallId) ?? "tool", response: geminiResponse(message.content) } }]);
  }
  return out;
}

export function buildProviderRequest(request: PlaygroundRunRequest, target: PlaygroundTarget, key: string): ProviderRequest {
  const params = adjustedParams(request, target);
  const sent = { temperature: params.temperature, maxOutputTokens: params.maxOutputTokens, reasoningEffort: params.reasoningEffort };
  if (target.provider === "openai") {
    return {
      url: "https://api.openai.com/v1/chat/completions",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: {
        model: target.model, messages: openAiMessages(request), stream: true, stream_options: { include_usage: true }, store: false,
        max_completion_tokens: params.maxOutputTokens,
        ...(params.temperature !== null ? { temperature: params.temperature } : {}),
        ...(params.reasoningEffort !== null ? { reasoning_effort: params.reasoningEffort } : {}),
        ...(request.tools.length ? { tools: request.tools.map(tool => ({ type: "function", function: { name: tool.name, ...(tool.description ? { description: tool.description } : {}), parameters: tool.parameters } })) } : {}),
      },
      sent, warnings: params.warnings,
    };
  }
  if (target.provider === "anthropic") {
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: {
        model: target.model, max_tokens: params.maxOutputTokens, stream: true,
        ...(request.system ? { system: request.system } : {}),
        messages: anthropicMessages(request.messages),
        ...(params.temperature !== null ? { temperature: params.temperature } : {}),
        ...(request.tools.length ? { tools: request.tools.map(tool => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}), input_schema: tool.parameters })) } : {}),
      },
      sent, warnings: params.warnings,
    };
  }
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(target.model)}:streamGenerateContent?alt=sse`,
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: {
      contents: geminiContents(request.messages),
      ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
      generationConfig: { maxOutputTokens: params.maxOutputTokens, ...(params.temperature !== null ? { temperature: params.temperature } : {}) },
      ...(request.tools.length ? { tools: [{ functionDeclarations: request.tools.map(tool => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}), parametersJsonSchema: tool.parameters })) }] } : {}),
    },
    sent, warnings: params.warnings,
  };
}

export interface Accumulated {
  text: string;
  toolCalls: PlaygroundToolCall[];
  providerFinishReason: string | null;
  finishReason: PlaygroundFinishReason | null;
  responseModel: string | null;
  responseId: string | null;
  usage: PlaygroundUsage;
  /** True once the provider signalled the end of the response, so a dropped connection is distinguishable from a finished one. */
  complete: boolean;
  /** True once the model began producing output of any kind: text, a tool call or a reasoning block. */
  started: boolean;
}

export interface StreamAccumulator {
  /** Returns the visible text delta carried by this event, if any. Throws ProviderStreamError for in-band errors. */
  push(event: SseEvent): string | undefined;
  hasStarted(): boolean;
  result(): Accumulated;
}

const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const sum = (...values: Array<number | null>): number | null => values.some(value => value === null) ? null : values.reduce<number>((total, value) => total + (value as number), 0);
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const str = (value: unknown): string | null => typeof value === "string" && value ? value : null;

function parseData(event: SseEvent): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(event.data); } catch { throw new ProviderStreamError("invalid_response", null); }
  const value = record(parsed);
  if (!value) throw new ProviderStreamError("invalid_response", null);
  return value;
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (record(parsed)) return parsed as Record<string, unknown>;
  } catch { /* fall through */ }
  return { _raw: raw };
}

function streamedErrorKind(type: unknown): PlaygroundErrorKind {
  if (type === "overloaded_error") return "overloaded";
  if (type === "rate_limit_error" || type === "rate_limit_exceeded") return "rate_limit";
  if (type === "authentication_error" || type === "permission_error") return "auth";
  if (type === "invalid_request_error") return "invalid_request";
  return "provider_error";
}

function openAiAccumulator(): StreamAccumulator {
  const state: Accumulated = { text: "", toolCalls: [], providerFinishReason: null, finishReason: null, responseModel: null, responseId: null, usage: emptyUsage(), complete: false, started: false };
  const calls = new Map<number, { id: string; name: string; args: string }>();
  return {
    push(event) {
      if (event.data.trim() === "[DONE]") { state.complete = true; return undefined; }
      const data = parseData(event);
      const error = record(data.error);
      if (error) throw new ProviderStreamError(streamedErrorKind(error.type ?? error.code), str(error.message));
      state.responseId ??= str(data.id);
      state.responseModel = str(data.model) ?? state.responseModel;
      const usage = record(data.usage);
      if (usage) {
        state.usage = {
          inputTokens: count(usage.prompt_tokens), outputTokens: count(usage.completion_tokens),
          cachedInputTokens: count(record(usage.prompt_tokens_details)?.cached_tokens), cacheWriteInputTokens: null,
          reasoningTokens: count(record(usage.completion_tokens_details)?.reasoning_tokens), totalTokens: count(usage.total_tokens),
        };
      }
      let delta: string | undefined;
      for (const choiceValue of Array.isArray(data.choices) ? data.choices : []) {
        const choice = record(choiceValue);
        if (!choice || (choice.index !== undefined && choice.index !== 0)) continue;
        const message = record(choice.delta);
        const content = typeof message?.content === "string" ? message.content : typeof message?.refusal === "string" ? message.refusal : "";
        if (content) { state.text += content; state.started = true; delta = (delta ?? "") + content; }
        for (const callValue of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
          const call = record(callValue);
          if (!call) continue;
          state.started = true;
          const index = typeof call.index === "number" ? call.index : calls.size;
          const fn = record(call.function);
          const entry = calls.get(index) ?? { id: "", name: "", args: "" };
          entry.id = str(call.id) ?? entry.id;
          entry.name = str(fn?.name) ?? entry.name;
          if (typeof fn?.arguments === "string") entry.args += fn.arguments;
          calls.set(index, entry);
        }
        if (typeof choice.finish_reason === "string") {
          state.providerFinishReason = choice.finish_reason;
          state.finishReason = ({ stop: "stop", length: "length", tool_calls: "tool_calls", function_call: "tool_calls", content_filter: "content_filter" } as Record<string, PlaygroundFinishReason>)[choice.finish_reason] ?? "other";
        }
      }
      return delta;
    },
    hasStarted: () => state.started,
    result() {
      state.toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([index, call]) => ({ id: call.id || `call_${index}`, name: call.name, arguments: parseArguments(call.args) }));
      return state;
    },
  };
}

function anthropicAccumulator(): StreamAccumulator {
  const state: Accumulated = { text: "", toolCalls: [], providerFinishReason: null, finishReason: null, responseModel: null, responseId: null, usage: emptyUsage(), complete: false, started: false };
  const blocks = new Map<number, { type: string; id?: string; name?: string; json: string }>();
  let input: number | null = null, cacheRead: number | null = null, cacheWrite: number | null = null, output: number | null = null, thinking: number | null = null;
  const applyUsage = (usage: Record<string, unknown> | null) => {
    if (!usage) return;
    if (usage.input_tokens !== undefined) input = count(usage.input_tokens);
    if (usage.cache_read_input_tokens !== undefined) cacheRead = count(usage.cache_read_input_tokens);
    if (usage.cache_creation_input_tokens !== undefined) cacheWrite = count(usage.cache_creation_input_tokens);
    if (usage.output_tokens !== undefined) output = count(usage.output_tokens);
    const details = record(usage.output_tokens_details);
    if (details?.thinking_tokens !== undefined) thinking = count(details.thinking_tokens);
  };
  return {
    push(event) {
      const data = parseData(event);
      const type = data.type ?? event.event;
      if (type === "error") {
        const error = record(data.error);
        throw new ProviderStreamError(streamedErrorKind(error?.type), str(error?.message));
      }
      if (type === "message_start") {
        const message = record(data.message);
        state.responseId = str(message?.id);
        state.responseModel = str(message?.model);
        applyUsage(record(message?.usage));
      } else if (type === "content_block_start") {
        const block = record(data.content_block);
        const index = typeof data.index === "number" ? data.index : blocks.size;
        blocks.set(index, { type: String(block?.type ?? "unknown"), id: str(block?.id) ?? undefined, name: str(block?.name) ?? undefined, json: "" });
        state.started = true;
        if (block?.type === "text" && typeof block.text === "string" && block.text) { state.text += block.text; return block.text; }
      } else if (type === "content_block_delta") {
        const delta = record(data.delta);
        const block = blocks.get(typeof data.index === "number" ? data.index : -1);
        if (delta?.type === "text_delta" && typeof delta.text === "string") { state.text += delta.text; return delta.text; }
        if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string" && block) block.json += delta.partial_json;
      } else if (type === "message_delta") {
        const delta = record(data.delta);
        if (typeof delta?.stop_reason === "string") {
          state.providerFinishReason = delta.stop_reason;
          state.finishReason = ({ end_turn: "stop", stop_sequence: "stop", max_tokens: "length", tool_use: "tool_calls", refusal: "content_filter" } as Record<string, PlaygroundFinishReason>)[delta.stop_reason] ?? "other";
        }
        applyUsage(record(data.usage));
      } else if (type === "message_stop") {
        state.complete = true;
      }
      return undefined;
    },
    hasStarted: () => state.started,
    result() {
      state.toolCalls = [...blocks.entries()].sort(([a], [b]) => a - b).filter(([, block]) => block.type === "tool_use")
        .map(([index, block]) => ({ id: block.id ?? `toolu_${index}`, name: block.name ?? "", arguments: parseArguments(block.json) }));
      const totalInput = sum(input, cacheRead ?? 0, cacheWrite ?? 0);
      state.usage = { inputTokens: totalInput, outputTokens: output, cachedInputTokens: cacheRead, cacheWriteInputTokens: cacheWrite, reasoningTokens: thinking, totalTokens: sum(totalInput, output) };
      return state;
    },
  };
}

const GEMINI_FILTERED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "LANGUAGE"]);

function geminiAccumulator(): StreamAccumulator {
  const state: Accumulated = { text: "", toolCalls: [], providerFinishReason: null, finishReason: null, responseModel: null, responseId: null, usage: emptyUsage(), complete: false, started: false };
  return {
    push(event) {
      const data = parseData(event);
      const error = record(data.error);
      if (error) throw new ProviderStreamError(
        error.status === "RESOURCE_EXHAUSTED" ? (quotaExhausted(error) ? "quota" : "rate_limit") : error.status === "UNAVAILABLE" ? "overloaded" : "provider_error",
        str(error.message),
      );
      state.responseId = str(data.responseId) ?? state.responseId;
      state.responseModel = str(data.modelVersion) ?? state.responseModel;
      const usage = record(data.usageMetadata);
      if (usage) {
        const prompt = count(usage.promptTokenCount), candidates = count(usage.candidatesTokenCount) ?? 0, thoughts = count(usage.thoughtsTokenCount), toolPrompt = count(usage.toolUsePromptTokenCount) ?? 0;
        const inputTokens = prompt === null ? null : prompt + toolPrompt;
        state.usage = {
          inputTokens, outputTokens: candidates + (thoughts ?? 0),
          cachedInputTokens: count(usage.cachedContentTokenCount) ?? (inputTokens === null ? null : 0), cacheWriteInputTokens: null,
          reasoningTokens: thoughts ?? 0, totalTokens: count(usage.totalTokenCount),
        };
      }
      const feedback = record(data.promptFeedback);
      if (typeof feedback?.blockReason === "string") {
        state.providerFinishReason = feedback.blockReason;
        state.finishReason = "content_filter";
        state.complete = true;
      }
      let delta: string | undefined;
      const candidate = record(Array.isArray(data.candidates) ? data.candidates[0] : undefined);
      for (const partValue of Array.isArray(record(candidate?.content)?.parts) ? record(candidate?.content)!.parts as unknown[] : []) {
        const part = record(partValue);
        if (!part) continue;
        state.started = true;
        if (part.thought === true) continue;
        if (typeof part.text === "string" && part.text) { state.text += part.text; delta = (delta ?? "") + part.text; }
        const call = record(part.functionCall);
        if (call) state.toolCalls.push({
          id: str(call.id) ?? `${GEMINI_SYNTHETIC_CALL_ID}${randomBytes(6).toString("hex")}`, name: str(call.name) ?? "",
          arguments: record(call.args) ?? {}, ...(str(part.thoughtSignature) ? { signature: part.thoughtSignature as string } : {}),
        });
      }
      if (typeof candidate?.finishReason === "string") {
        state.providerFinishReason = candidate.finishReason;
        state.complete = true;
        state.finishReason = candidate.finishReason === "STOP" ? "stop" : candidate.finishReason === "MAX_TOKENS" ? "length" : GEMINI_FILTERED.has(candidate.finishReason) ? "content_filter" : "other";
      }
      return delta;
    },
    hasStarted: () => state.started,
    result() {
      // Gemini reports STOP even when the turn ends in function calls.
      if (state.finishReason === "stop" && state.toolCalls.length) state.finishReason = "tool_calls";
      return state;
    },
  };
}

export function createAccumulator(provider: PlaygroundProvider): StreamAccumulator {
  return provider === "openai" ? openAiAccumulator() : provider === "anthropic" ? anthropicAccumulator() : geminiAccumulator();
}

const PLAIN_MESSAGES: Record<PlaygroundErrorKind, (label: string, model: string, status: number | null) => string> = {
  missing_key: label => `No ${label} API key is configured. Add one in Settings under API keys.`,
  auth: label => `${label} rejected the API key. Check the key in Settings.`,
  rate_limit: label => `${label} rate-limited this request. Wait a moment and try again.`,
  quota: label => `${label} reports that the account is out of credit or quota.`,
  invalid_model: (label, model) => `${label} does not offer ${model} to this API key.`,
  invalid_request: label => `${label} rejected the request as invalid.`,
  overloaded: label => `${label} is overloaded right now. Try again shortly.`,
  provider_error: (label, _model, status) => status ? `${label} returned an error (HTTP ${status}).` : `${label} returned an error.`,
  timeout: label => `${label} did not finish within ${PLAYGROUND_LIMITS.callTimeoutMs / 1000} seconds.`,
  network: label => `Could not reach ${label}. Check the network connection.`,
  invalid_response: label => `${label} sent a response that could not be read.`,
  response_limit: label => `${label} sent more than ${PLAYGROUND_LIMITS.providerResponseBytes / (1024 * 1024)} MB, so the response was cut off.`,
  cancelled: label => `The request was cancelled before ${label} finished.`,
};

const RETRYABLE: ReadonlySet<PlaygroundErrorKind> = new Set(["rate_limit", "overloaded", "provider_error", "timeout", "network"]);

/** Removes control characters, the configured key and anything shaped like one, then bounds the length. */
export function sanitizeProviderMessage(value: string | null | undefined, key: string | null): string | null {
  if (!value) return null;
  let cleaned = key ? value.split(key).join("[REDACTED]") : value;
  cleaned = cleaned.replace(/(sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,})/g, "[REDACTED]");
  // eslint-disable-next-line no-control-regex
  cleaned = cleaned.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
  if (cleaned.length > PLAYGROUND_LIMITS.providerMessageChars) cleaned = `${cleaned.slice(0, PLAYGROUND_LIMITS.providerMessageChars - 1)}…`;
  return cleaned || null;
}

export function playgroundError(kind: PlaygroundErrorKind, target: PlaygroundTarget, options: { providerMessage?: string | null; httpStatus?: number | null; key?: string | null } = {}): PlaygroundError {
  const status = options.httpStatus ?? null;
  return {
    kind, message: PLAIN_MESSAGES[kind](PROVIDER_LABEL[target.provider], target.model, status),
    providerMessage: sanitizeProviderMessage(options.providerMessage, options.key ?? null), httpStatus: status, retryable: RETRYABLE.has(kind),
  };
}

/**
 * Google answers both per-minute throttling and exhausted daily/free-tier quota with 429 RESOURCE_EXHAUSTED and
 * "You exceeded your current quota". Only a QuotaFailure whose quota ids are all per-minute is a short-lived rate limit.
 */
function quotaExhausted(error: Record<string, unknown>): boolean {
  const details = Array.isArray(error.details) ? (error.details as unknown[]).map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
  const quotaIds = details.filter(item => String(item["@type"] ?? "").endsWith("google.rpc.QuotaFailure"))
    .flatMap(item => Array.isArray(item.violations) ? item.violations as unknown[] : [])
    .map(item => String(record(item)?.quotaId ?? ""));
  if (quotaIds.length && quotaIds.every(id => /PerMinute/i.test(id))) return false;
  return quotaIds.length > 0 || /exceeded your current quota/i.test(String(error.message ?? ""));
}

/** Classifies a non-2xx provider response from its status and documented error envelope. */
export function classifyHttpError(provider: PlaygroundProvider, status: number, bodyText: string): { kind: PlaygroundErrorKind; providerMessage: string | null } {
  let body: Record<string, unknown> | null = null;
  try { body = record(JSON.parse(bodyText)); } catch { /* not JSON */ }
  const error = record(body?.error);
  const providerMessage = str(error?.message) ?? (bodyText.trim() && !body ? bodyText.trim() : null);
  const message = (providerMessage ?? "").toLowerCase();
  const code = String(error?.code ?? "");
  const type = String(error?.type ?? "");
  const googleStatus = String(error?.status ?? "");
  const reasons = Array.isArray(error?.details) ? (error.details as unknown[]).map(item => String(record(item)?.reason ?? "")) : [];

  if (status === 401 || status === 403 || type === "authentication_error" || type === "permission_error" || reasons.includes("API_KEY_INVALID") || /api key not valid|invalid api key|incorrect api key/.test(message)) return { kind: "auth", providerMessage };
  if (status === 402 || code === "insufficient_quota" || type === "insufficient_quota" || /credit balance is too low|insufficient.?quota/.test(message)) return { kind: "quota", providerMessage };
  if (status === 404 || code === "model_not_found" || type === "not_found_error" || (provider === "openai" && /model .*does not exist/.test(message))) return { kind: "invalid_model", providerMessage };
  if (googleStatus === "RESOURCE_EXHAUSTED" && error && quotaExhausted(error)) return { kind: "quota", providerMessage };
  if (status === 429 || googleStatus === "RESOURCE_EXHAUSTED" || type === "rate_limit_error") return { kind: "rate_limit", providerMessage };
  if (status === 529 || status === 503 || type === "overloaded_error" || googleStatus === "UNAVAILABLE") return { kind: "overloaded", providerMessage };
  if (status === 408 || status === 504) return { kind: "timeout", providerMessage };
  if (status >= 400 && status < 500) return { kind: "invalid_request", providerMessage };
  return { kind: "provider_error", providerMessage };
}
