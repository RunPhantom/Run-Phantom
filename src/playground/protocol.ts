export type PlaygroundProvider = "openai" | "anthropic" | "gemini";

export const PLAYGROUND_PROVIDERS: readonly PlaygroundProvider[] = Object.freeze(["openai", "anthropic", "gemini"]);

export interface PlaygroundModel {
  provider: PlaygroundProvider;
  model: string;
  label: string;
  /** False where the provider rejects the parameter: OpenAI reasoning models (only the default is allowed) and Claude 5.5 models ("`temperature` is deprecated for this model", HTTP 400). */
  temperature: boolean;
  maxTemperature: number;
  reasoningEffort: boolean;
}

const model = (provider: PlaygroundProvider, id: string, label: string, options: Partial<Pick<PlaygroundModel, "temperature" | "maxTemperature" | "reasoningEffort">> = {}): PlaygroundModel =>
  Object.freeze({ provider, model: id, label, temperature: options.temperature ?? true, maxTemperature: options.maxTemperature ?? 2, reasoningEffort: options.reasoningEffort ?? false });

export const PLAYGROUND_MODELS: readonly PlaygroundModel[] = Object.freeze([
  model("openai", "gpt-5-nano", "GPT-5 nano", { temperature: false, reasoningEffort: true }),
  model("openai", "gpt-5-mini", "GPT-5 mini", { temperature: false, reasoningEffort: true }),
  model("openai", "gpt-4.1-mini", "GPT-4.1 mini"),
  model("openai", "gpt-4o-mini", "GPT-4o mini"),
  model("anthropic", "claude-haiku-4-5-20251001", "Claude Haiku 4.5", { maxTemperature: 1 }),
  model("anthropic", "claude-haiku-5-5", "Claude Haiku 5.5", { temperature: false, maxTemperature: 1 }),
  model("anthropic", "claude-sonnet-5-5", "Claude Sonnet 5.5", { temperature: false, maxTemperature: 1 }),
  model("gemini", "gemini-2.5-flash", "Gemini 2.5 Flash"),
  model("gemini", "gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite"),
]);

export const PLAYGROUND_DEFAULT_MODEL: Readonly<Record<PlaygroundProvider, string>> = Object.freeze({
  openai: "gpt-5-nano",
  anthropic: "claude-haiku-4-5-20251001",
  gemini: "gemini-2.5-flash",
});

export const PLAYGROUND_LIMITS = Object.freeze({
  requestBytes: 512 * 1024,
  targets: 3,
  messages: 100,
  systemChars: 32_000,
  messageChars: 64_000,
  totalTextChars: 200_000,
  tools: 32,
  toolSchemaBytes: 16 * 1024,
  toolDescriptionChars: 2_000,
  toolCallsPerMessage: 32,
  defaultMaxOutputTokens: 1024,
  maxOutputTokens: 8192,
  callTimeoutMs: 120_000,
  providerResponseBytes: 4 * 1024 * 1024,
  outputChars: 200_000,
  providerMessageChars: 600,
});

export function findPlaygroundModel(provider: string, modelId: string): PlaygroundModel | null {
  return PLAYGROUND_MODELS.find(item => item.provider === provider && item.model === modelId) ?? null;
}

export function isPlaygroundProvider(value: unknown): value is PlaygroundProvider {
  return typeof value === "string" && (PLAYGROUND_PROVIDERS as readonly string[]).includes(value);
}

export interface PlaygroundToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Opaque Gemini thought signature. Echo it back unchanged on the next turn; other providers ignore it. */
  signature?: string;
}

export type PlaygroundMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: PlaygroundToolCall[] }
  | { role: "tool"; toolCallId: string; name?: string; content: string };

export interface PlaygroundTool {
  name: string;
  description?: string;
  /** JSON Schema object describing the arguments. */
  parameters: Record<string, unknown>;
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface PlaygroundParams {
  temperature?: number;
  maxOutputTokens: number;
  reasoningEffort?: ReasoningEffort;
}

export interface PlaygroundTarget {
  provider: PlaygroundProvider;
  model: string;
}

export interface PlaygroundSource {
  runId: string;
  spanId: string;
}

export interface PlaygroundRunRequest {
  targets: PlaygroundTarget[];
  system: string;
  messages: PlaygroundMessage[];
  params: PlaygroundParams;
  tools: PlaygroundTool[];
  stream: boolean;
  source: PlaygroundSource | null;
}

export type PlaygroundFinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "error" | "other";

export interface PlaygroundUsage {
  /** Every input token the provider processed, cache reads and writes included. */
  inputTokens: number | null;
  /** Every output token the provider generated, reasoning included. */
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
}

export type PlaygroundErrorKind =
  | "missing_key" | "auth" | "rate_limit" | "quota" | "invalid_model" | "invalid_request"
  | "overloaded" | "provider_error" | "timeout" | "network" | "invalid_response" | "response_limit" | "cancelled";

export interface PlaygroundError {
  kind: PlaygroundErrorKind;
  message: string;
  providerMessage: string | null;
  httpStatus: number | null;
  retryable: boolean;
}

export interface PlaygroundCallResult {
  index: number;
  provider: PlaygroundProvider;
  model: string;
  status: "ok" | "error";
  output: { text: string; toolCalls: PlaygroundToolCall[] };
  finishReason: PlaygroundFinishReason | null;
  providerFinishReason: string | null;
  responseModel: string | null;
  responseId: string | null;
  usage: PlaygroundUsage;
  latencyMs: number | null;
  timeToFirstTokenMs: number | null;
  warnings: string[];
  error: PlaygroundError | null;
  runId: string | null;
  spanId: string | null;
}

export interface PlaygroundRunResponse {
  comparisonId: string;
  results: PlaygroundCallResult[];
}

export class PlaygroundRequestError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "PlaygroundRequestError"; }
}

export function emptyUsage(): PlaygroundUsage {
  return { inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningTokens: null, totalTokens: null };
}

const fail = (message: string): never => { throw new PlaygroundRequestError(message); };

function plainObject(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${what} must be a JSON object.`);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) fail(`${what} has unsupported field ${JSON.stringify(unknown[0])}.`);
}

function text(value: unknown, what: string, max: number, options: { allowEmpty?: boolean } = {}): string {
  if (typeof value !== "string") fail(`${what} must be text.`);
  const result = value as string;
  if (!options.allowEmpty && !result.trim()) fail(`${what} must not be empty.`);
  if (result.length > max) fail(`${what} must be at most ${max} characters.`);
  if (result.includes("\0")) fail(`${what} must not contain NUL characters.`);
  return result;
}

const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const TOOL_CALL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SPAN_REF = /^[A-Za-z0-9_.:-]{1,128}$/;

function toolCall(value: unknown, what: string): PlaygroundToolCall {
  const item = plainObject(value, what);
  onlyKeys(item, ["id", "name", "arguments", "signature"], what);
  const id = text(item.id, `${what} id`, 128);
  if (!TOOL_CALL_ID.test(id)) fail(`${what} id may contain only letters, digits, and _ . : -`);
  const name = text(item.name, `${what} name`, 64);
  if (!TOOL_NAME.test(name)) fail(`${what} name must start with a letter or underscore and use only letters, digits, _ and -.`);
  const args = item.arguments === undefined ? {} : plainObject(item.arguments, `${what} arguments`);
  const signature = item.signature === undefined ? undefined : text(item.signature, `${what} signature`, 64_000);
  return { id, name, arguments: args, ...(signature !== undefined ? { signature } : {}) };
}

function message(value: unknown, index: number): PlaygroundMessage {
  const what = `messages[${index}]`;
  const item = plainObject(value, what);
  if (item.role === "user") {
    onlyKeys(item, ["role", "content"], what);
    return { role: "user", content: text(item.content, `${what} content`, PLAYGROUND_LIMITS.messageChars) };
  }
  if (item.role === "assistant") {
    onlyKeys(item, ["role", "content", "toolCalls"], what);
    const content = text(item.content ?? "", `${what} content`, PLAYGROUND_LIMITS.messageChars, { allowEmpty: true });
    let toolCalls: PlaygroundToolCall[] | undefined;
    if (item.toolCalls !== undefined) {
      if (!Array.isArray(item.toolCalls) || item.toolCalls.length > PLAYGROUND_LIMITS.toolCallsPerMessage) fail(`${what} toolCalls must be a list of at most ${PLAYGROUND_LIMITS.toolCallsPerMessage} calls.`);
      toolCalls = (item.toolCalls as unknown[]).map((call, callIndex) => toolCall(call, `${what} toolCalls[${callIndex}]`));
    }
    if (!content.trim() && !toolCalls?.length) fail(`${what} needs text or at least one tool call.`);
    return { role: "assistant", content, ...(toolCalls?.length ? { toolCalls } : {}) };
  }
  if (item.role === "tool") {
    onlyKeys(item, ["role", "toolCallId", "name", "content"], what);
    const toolCallId = text(item.toolCallId, `${what} toolCallId`, 128);
    const name = item.name === undefined ? undefined : text(item.name, `${what} name`, 64);
    return { role: "tool", toolCallId, ...(name !== undefined ? { name } : {}), content: text(item.content, `${what} content`, PLAYGROUND_LIMITS.messageChars, { allowEmpty: true }) };
  }
  return fail(`${what} role must be user, assistant or tool.`);
}

function tool(value: unknown, index: number): PlaygroundTool {
  const what = `tools[${index}]`;
  const item = plainObject(value, what);
  onlyKeys(item, ["name", "description", "parameters"], what);
  const name = text(item.name, `${what} name`, 64);
  if (!TOOL_NAME.test(name)) fail(`${what} name must start with a letter or underscore and use only letters, digits, _ and -.`);
  const description = item.description === undefined ? undefined : text(item.description, `${what} description`, PLAYGROUND_LIMITS.toolDescriptionChars, { allowEmpty: true });
  const parameters = item.parameters === undefined ? { type: "object", properties: {} } : plainObject(item.parameters, `${what} parameters`);
  if (parameters.type !== undefined && parameters.type !== "object") fail(`${what} parameters must describe an object.`);
  if (Buffer.byteLength(JSON.stringify(parameters)) > PLAYGROUND_LIMITS.toolSchemaBytes) fail(`${what} parameters must be at most ${PLAYGROUND_LIMITS.toolSchemaBytes} bytes.`);
  return { name, ...(description ? { description } : {}), parameters: { type: "object", ...parameters } };
}

function target(value: unknown, index: number): PlaygroundTarget {
  const what = `targets[${index}]`;
  const item = plainObject(value, what);
  onlyKeys(item, ["provider", "model"], what);
  if (!isPlaygroundProvider(item.provider)) fail(`${what} provider must be one of ${PLAYGROUND_PROVIDERS.join(", ")}.`);
  const provider = item.provider as PlaygroundProvider;
  if (typeof item.model !== "string" || !findPlaygroundModel(provider, item.model)) {
    const allowed = PLAYGROUND_MODELS.filter(entry => entry.provider === provider).map(entry => entry.model).join(", ");
    fail(`${what} model is not available in the Playground. Choose one of: ${allowed}.`);
  }
  return { provider, model: item.model as string };
}

/** Validates the whole request before any provider is contacted, so a refusal never costs money. */
export function parsePlaygroundRunRequest(body: unknown): PlaygroundRunRequest {
  const input = plainObject(body, "Request body");
  onlyKeys(input, ["targets", "provider", "model", "system", "messages", "params", "tools", "stream", "source"], "Request body");
  let targets: PlaygroundTarget[];
  if (input.targets !== undefined) {
    if (input.provider !== undefined || input.model !== undefined) fail("Send either targets or provider and model, not both.");
    if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > PLAYGROUND_LIMITS.targets) fail(`targets must list 1 to ${PLAYGROUND_LIMITS.targets} models.`);
    targets = (input.targets as unknown[]).map(target);
  } else {
    targets = [target({ provider: input.provider, model: input.model }, 0)];
  }

  const system = input.system === undefined || input.system === null ? "" : text(input.system, "system", PLAYGROUND_LIMITS.systemChars, { allowEmpty: true });
  if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > PLAYGROUND_LIMITS.messages) fail(`messages must list 1 to ${PLAYGROUND_LIMITS.messages} messages.`);
  const messages = (input.messages as unknown[]).map(message);
  const last = messages[messages.length - 1];
  if (last.role === "assistant") fail("The last message must come from the user or a tool so the model has something to answer.");
  if (messages[0].role !== "user") fail("The first message must come from the user.");
  const knownCalls = new Map<string, string>();
  for (const [index, item] of messages.entries()) {
    if (item.role === "assistant") for (const call of item.toolCalls ?? []) {
      if (knownCalls.has(call.id)) fail(`messages[${index}] repeats tool call id ${JSON.stringify(call.id)}.`);
      knownCalls.set(call.id, call.name);
    }
    if (item.role === "tool") {
      const name = knownCalls.get(item.toolCallId);
      if (!name) fail(`messages[${index}] answers tool call ${JSON.stringify(item.toolCallId)}, which no earlier assistant message made.`);
      if (item.name !== undefined && item.name !== name) fail(`messages[${index}] names tool ${JSON.stringify(item.name)} but call ${JSON.stringify(item.toolCallId)} was for ${JSON.stringify(name)}.`);
    }
  }
  const totalText = system.length + messages.reduce((sum, item) => sum + item.content.length + (item.role === "assistant" ? JSON.stringify(item.toolCalls ?? []).length : 0), 0);
  if (totalText > PLAYGROUND_LIMITS.totalTextChars) fail(`The prompt must be at most ${PLAYGROUND_LIMITS.totalTextChars} characters in total.`);

  const params = input.params === undefined ? {} : plainObject(input.params, "params");
  onlyKeys(params, ["temperature", "maxOutputTokens", "reasoningEffort"], "params");
  let temperature: number | undefined;
  if (params.temperature !== undefined && params.temperature !== null) {
    if (typeof params.temperature !== "number" || !Number.isFinite(params.temperature) || params.temperature < 0 || params.temperature > 2) fail("params.temperature must be a number from 0 to 2.");
    temperature = params.temperature as number;
  }
  let maxOutputTokens: number = PLAYGROUND_LIMITS.defaultMaxOutputTokens;
  if (params.maxOutputTokens !== undefined && params.maxOutputTokens !== null) {
    if (typeof params.maxOutputTokens !== "number" || !Number.isSafeInteger(params.maxOutputTokens) || params.maxOutputTokens < 1 || params.maxOutputTokens > PLAYGROUND_LIMITS.maxOutputTokens) fail(`params.maxOutputTokens must be a whole number from 1 to ${PLAYGROUND_LIMITS.maxOutputTokens}.`);
    maxOutputTokens = params.maxOutputTokens as number;
  }
  let reasoningEffort: ReasoningEffort | undefined;
  if (params.reasoningEffort !== undefined && params.reasoningEffort !== null) {
    if (!["minimal", "low", "medium", "high"].includes(params.reasoningEffort as string)) fail("params.reasoningEffort must be minimal, low, medium or high.");
    reasoningEffort = params.reasoningEffort as ReasoningEffort;
  }

  if (input.tools !== undefined && (!Array.isArray(input.tools) || input.tools.length > PLAYGROUND_LIMITS.tools)) fail(`tools must be a list of at most ${PLAYGROUND_LIMITS.tools} tools.`);
  const tools = ((input.tools as unknown[] | undefined) ?? []).map(tool);
  const toolNames = new Set<string>();
  for (const item of tools) {
    if (toolNames.has(item.name)) fail(`tools lists ${JSON.stringify(item.name)} more than once.`);
    toolNames.add(item.name);
  }
  if (input.stream !== undefined && typeof input.stream !== "boolean") fail("stream must be true or false.");

  let source: PlaygroundSource | null = null;
  if (input.source !== undefined && input.source !== null) {
    const item = plainObject(input.source, "source");
    onlyKeys(item, ["runId", "spanId"], "source");
    if (typeof item.runId !== "string" || !SPAN_REF.test(item.runId) || typeof item.spanId !== "string" || !SPAN_REF.test(item.spanId)) fail("source must name the runId and spanId it was opened from.");
    source = { runId: item.runId as string, spanId: item.spanId as string };
  }

  return {
    targets, system, messages, tools, stream: input.stream === true, source,
    params: { maxOutputTokens, ...(temperature !== undefined ? { temperature } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) },
  };
}
