import type { ToolDefinition } from "./tools";

export type Provider = "openai" | "anthropic" | "gemini";

export const PROVIDERS: readonly Provider[] = ["openai", "anthropic", "gemini"];

export const DEFAULT_MODELS: Readonly<Record<Provider, string>> = {
  openai: "gpt-5-nano",
  anthropic: "claude-haiku-4-5-20251001",
  gemini: "gemini-3.8-flash",
};

/** `gen_ai.provider.name` values from the OpenTelemetry GenAI semantic conventions. */
export const OTEL_PROVIDER_NAME: Readonly<Record<Provider, string>> = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "gcp.gemini",
};

export const KEY_VARIABLE: Readonly<Record<Provider, string>> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
};

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Gemini thought signature that must be echoed back with the call. */
  signature?: string;
  /** True when the provider sent no id and this one was made up locally. */
  syntheticId?: boolean;
}

export type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; callId: string; name: string; content: string; isError: boolean };

export interface Usage {
  /** Every prompt token, cached ones included. */
  inputTokens?: number;
  /** Every generated token, reasoning included. */
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string;
  responseModel?: string;
  responseId?: string;
  usage: Usage;
}

export interface ModelRequest {
  provider: Provider;
  model: string;
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
  maxOutputTokens: number;
}

export class ProviderError extends Error {
  constructor(readonly provider: Provider, readonly status: number, message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const str = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;

function parseArguments(raw: unknown): Record<string, unknown> {
  if (record(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (record(parsed)) return parsed as Record<string, unknown>;
  } catch { /* the model sent malformed JSON; keep it visible */ }
  return { _raw: raw };
}

/** Providers whose API key variable is unset, so a caller can stop before exporting runs that cannot succeed. */
export function missingKeys(providers: readonly Provider[]): string[] {
  return [...new Set(providers.filter((provider) => !process.env[KEY_VARIABLE[provider]]).map((provider) => KEY_VARIABLE[provider]))];
}

/** OpenAI echoes a masked key (prefix, asterisks, last four characters) in 401 bodies; keep even that out of traces. */
export function redactMaskedKeys(text: string): string {
  return text.replace(/[\w-]*\*{3,}[\w-]*/g, "[redacted key]");
}

function requireKey(provider: Provider): string {
  const key = process.env[KEY_VARIABLE[provider]];
  if (!key) throw new ProviderError(provider, 0, `${KEY_VARIABLE[provider]} is not set.`);
  return key;
}

async function postJson(provider: Provider, url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await response.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (!response.ok) {
    const error = record(record(parsed)?.error);
    const detail = redactMaskedKeys(str(error?.message) ?? text.slice(0, 300));
    throw new ProviderError(provider, response.status, `${provider} returned HTTP ${response.status}: ${detail}`);
  }
  const value = record(parsed);
  if (!value) throw new ProviderError(provider, response.status, `${provider} returned a response that is not a JSON object.`);
  return value;
}

function openAiMessages(request: ModelRequest): unknown[] {
  const out: unknown[] = [{ role: "system", content: request.system }];
  for (const message of request.messages) {
    if (message.role === "user") out.push({ role: "user", content: message.text });
    else if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: message.text || null,
        ...(message.toolCalls.length
          ? { tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
          : {}),
      });
    } else out.push({ role: "tool", tool_call_id: message.callId, content: message.content });
  }
  return out;
}

async function callOpenAi(request: ModelRequest): Promise<ModelTurn> {
  const data = await postJson("openai", `${process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"}/chat/completions`, { authorization: `Bearer ${requireKey("openai")}` }, {
    model: request.model,
    messages: openAiMessages(request),
    tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters, strict: true } })),
    max_completion_tokens: request.maxOutputTokens,
    store: false,
  });
  const choice = record(Array.isArray(data.choices) ? data.choices[0] : undefined);
  const message = record(choice?.message);
  const usage = record(data.usage);
  const toolCalls = (Array.isArray(message?.tool_calls) ? message.tool_calls : [])
    .map(record)
    .filter((call): call is Record<string, unknown> => !!call)
    .map((call, index) => {
      const fn = record(call.function);
      return { id: str(call.id) ?? `call_${index}`, name: str(fn?.name) ?? "", arguments: parseArguments(fn?.arguments) };
    });
  return {
    text: str(message?.content) ?? str(message?.refusal) ?? "",
    toolCalls,
    finishReason: str(choice?.finish_reason) ?? "unknown",
    responseModel: str(data.model),
    responseId: str(data.id),
    usage: {
      inputTokens: count(usage?.prompt_tokens),
      outputTokens: count(usage?.completion_tokens),
      cacheReadTokens: count(record(usage?.prompt_tokens_details)?.cached_tokens),
      reasoningTokens: count(record(usage?.completion_tokens_details)?.reasoning_tokens),
    },
  };
}

function anthropicMessages(messages: Message[]): unknown[] {
  const out: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];
  const push = (role: "user" | "assistant", blocks: unknown[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const message of messages) {
    if (message.role === "user") push("user", [{ type: "text", text: message.text }]);
    else if (message.role === "assistant") {
      push("assistant", [
        ...(message.text.trim() ? [{ type: "text", text: message.text }] : []),
        ...message.toolCalls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })),
      ]);
    } else push("user", [{ type: "tool_result", tool_use_id: message.callId, content: message.content, ...(message.isError ? { is_error: true } : {}) }]);
  }
  return out;
}

async function callAnthropic(request: ModelRequest): Promise<ModelTurn> {
  const data = await postJson("anthropic", "https://api.anthropic.com/v1/messages", { "x-api-key": requireKey("anthropic"), "anthropic-version": "2023-06-01" }, {
    model: request.model,
    max_tokens: request.maxOutputTokens,
    system: request.system,
    messages: anthropicMessages(request.messages),
    tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
  });
  const blocks = (Array.isArray(data.content) ? data.content : []).map(record).filter((block): block is Record<string, unknown> => !!block);
  const usage = record(data.usage);
  const input = count(usage?.input_tokens);
  const cacheRead = count(usage?.cache_read_input_tokens);
  const cacheWrite = count(usage?.cache_creation_input_tokens);
  return {
    text: blocks.filter((block) => block.type === "text").map((block) => str(block.text) ?? "").join("\n"),
    toolCalls: blocks.filter((block) => block.type === "tool_use").map((block, index) => ({
      id: str(block.id) ?? `toolu_${index}`, name: str(block.name) ?? "", arguments: parseArguments(block.input),
    })),
    finishReason: str(data.stop_reason) ?? "unknown",
    responseModel: str(data.model),
    responseId: str(data.id),
    usage: {
      // Anthropic reports cache reads and writes on top of input_tokens; fold them in so inputTokens means every prompt token.
      inputTokens: input === undefined ? undefined : input + (cacheRead ?? 0) + (cacheWrite ?? 0),
      outputTokens: count(usage?.output_tokens),
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    },
  };
}

function geminiResponse(message: Extract<Message, { role: "tool" }>): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(message.content); } catch { parsed = message.content; }
  if (message.isError) return { error: parsed };
  return record(parsed) ?? { result: parsed };
}

function geminiContents(messages: Message[]): unknown[] {
  const out: Array<{ role: "user" | "model"; parts: unknown[] }> = [];
  const push = (role: "user" | "model", parts: unknown[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else out.push({ role, parts });
  };
  const synthetic = new Set<string>();
  for (const message of messages) {
    if (message.role === "user") push("user", [{ text: message.text }]);
    else if (message.role === "assistant") {
      for (const call of message.toolCalls) if (call.syntheticId) synthetic.add(call.id);
      push("model", [
        ...(message.text.trim() ? [{ text: message.text }] : []),
        ...message.toolCalls.map((call) => ({
          functionCall: { ...(call.syntheticId ? {} : { id: call.id }), name: call.name, args: call.arguments },
          ...(call.signature ? { thoughtSignature: call.signature } : {}),
        })),
      ]);
    } else {
      push("user", [{ functionResponse: { ...(synthetic.has(message.callId) ? {} : { id: message.callId }), name: message.name, response: geminiResponse(message) } }]);
    }
  }
  return out;
}

async function callGemini(request: ModelRequest): Promise<ModelTurn> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(request.model)}:generateContent`;
  const data = await postJson("gemini", url, { "x-goog-api-key": requireKey("gemini") }, {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: geminiContents(request.messages),
    tools: [{ functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters })) }],
    generationConfig: { maxOutputTokens: request.maxOutputTokens },
  });
  const candidate = record(Array.isArray(data.candidates) ? data.candidates[0] : undefined);
  const parts = (Array.isArray(record(candidate?.content)?.parts) ? record(candidate?.content)!.parts as unknown[] : [])
    .map(record).filter((part): part is Record<string, unknown> => !!part);
  const usage = record(data.usageMetadata);
  const prompt = count(usage?.promptTokenCount);
  const thoughts = count(usage?.thoughtsTokenCount);
  const candidates = count(usage?.candidatesTokenCount);
  const toolCalls: ToolCall[] = [];
  for (const [index, part] of parts.entries()) {
    const call = record(part.functionCall);
    if (!call) continue;
    const id = str(call.id);
    toolCalls.push({
      id: id ?? `gemini_call_${toolCalls.length}_${index}`,
      ...(id ? {} : { syntheticId: true }),
      name: str(call.name) ?? "",
      arguments: parseArguments(call.args),
      ...(str(part.thoughtSignature) ? { signature: part.thoughtSignature as string } : {}),
    });
  }
  const blockReason = str(record(data.promptFeedback)?.blockReason);
  return {
    text: parts.filter((part) => part.thought !== true).map((part) => str(part.text) ?? "").join(""),
    toolCalls,
    finishReason: blockReason ?? str(candidate?.finishReason) ?? "unknown",
    responseModel: str(data.modelVersion),
    responseId: str(data.responseId),
    usage: {
      inputTokens: prompt === undefined ? undefined : prompt + (count(usage?.toolUsePromptTokenCount) ?? 0),
      outputTokens: candidates === undefined && thoughts === undefined ? undefined : (candidates ?? 0) + (thoughts ?? 0),
      cacheReadTokens: count(usage?.cachedContentTokenCount),
      reasoningTokens: thoughts,
    },
  };
}

export function callModel(request: ModelRequest): Promise<ModelTurn> {
  if (request.provider === "openai") return callOpenAi(request);
  if (request.provider === "anthropic") return callAnthropic(request);
  return callGemini(request);
}
