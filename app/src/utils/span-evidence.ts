// Generation evidence that instrumentations report only as span attributes.
// output_payload deliberately holds final text alone (evaluations score it), so
// a tool-call-only turn, a token-limit stop or reasoning usage would otherwise
// leave the span detail with no visible trace of what the model returned.

export interface RequestedToolCall {
  id: string | null;
  name: string;
  arguments: unknown;
}

type Attributes = Record<string, unknown>;

const MAX_TOOL_CALLS = 64;

export function parseSpanAttributes(raw: string | null | undefined): Attributes | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Attributes : null;
  } catch {
    return null;
  }
}

function decoded(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function argumentsValue(value: unknown): unknown {
  return typeof value === "string" ? decoded(value) : value ?? null;
}

function record(value: unknown): Attributes | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Attributes : null;
}

/** Finish reasons as reported, in OpenInference, OpenTelemetry GenAI and AI SDK spellings. */
export function spanFinishReasons(attrs: Attributes | null): string[] {
  if (!attrs) return [];
  const reasons: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value && value !== "unknown" && !reasons.includes(value)) reasons.push(value);
  };
  add(attrs["llm.finish_reason"]);
  add(attrs["ai.response.finishReason"]);
  const genAi = decoded(attrs["gen_ai.response.finish_reasons"]);
  if (Array.isArray(genAi)) genAi.forEach(add);
  else add(genAi);
  return reasons.slice(0, 8);
}

const STOPPED_EARLY = new Set(["length", "max_tokens", "max_output_tokens", "model_context_window_exceeded", "content_filter", "refusal", "safety"]);

/** Reasons that mean the model did not finish its answer on its own terms. */
export function stoppedEarlyReason(reasons: readonly string[]): string | null {
  return reasons.find(reason => STOPPED_EARLY.has(reason.toLowerCase())) ?? null;
}

const REASONING_KEYS = [
  "llm.token_count.completion_details.reasoning",
  "gen_ai.usage.output_tokens.reasoning",
  "gen_ai.usage.reasoning_tokens",
  "gen_ai.usage.completion_tokens_details.reasoning",
  "runphantom.usage.reasoning_tokens",
  "ai.usage.reasoningTokens",
] as const;

/** Reasoning tokens are a subset of reported output tokens; a conflicting report stays unknown. */
export function spanReasoningTokens(attrs: Attributes | null): number | null {
  if (!attrs) return null;
  const values = REASONING_KEYS.map(key => attrs[key]).filter(value => value !== undefined)
    .map(value => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value);
  if (!values.length || !values.every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) return null;
  return values.every(value => value === values[0]) ? values[0] as number : null;
}

function openInferenceToolCalls(attrs: Attributes): RequestedToolCall[] {
  const calls = new Map<string, { message: number; call: number; id: string | null; name: string | null; arguments: unknown }>();
  const pattern = /^llm\.output_messages\.(\d+)\.message\.tool_calls\.(\d+)\.tool_call\.(id|function\.name|function\.arguments)$/;
  for (const [key, value] of Object.entries(attrs)) {
    const match = pattern.exec(key);
    if (!match) continue;
    const slot = `${match[1]}.${match[2]}`;
    const entry = calls.get(slot) ?? { message: Number(match[1]), call: Number(match[2]), id: null, name: null, arguments: null };
    if (match[3] === "id" && typeof value === "string") entry.id = value;
    if (match[3] === "function.name" && typeof value === "string") entry.name = value;
    if (match[3] === "function.arguments") entry.arguments = argumentsValue(value);
    calls.set(slot, entry);
  }
  return [...calls.values()]
    .sort((a, b) => a.message - b.message || a.call - b.call)
    .filter(entry => entry.name)
    .map(entry => ({ id: entry.id, name: entry.name!, arguments: entry.arguments }));
}

function genAiToolCalls(attrs: Attributes): RequestedToolCall[] {
  const messages = decoded(attrs["gen_ai.output.messages"]);
  if (!Array.isArray(messages)) return [];
  const calls: RequestedToolCall[] = [];
  for (const message of messages) {
    const parts = record(message)?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const item = record(part);
      if (item?.type !== "tool_call" || typeof item.name !== "string") continue;
      calls.push({ id: typeof item.id === "string" ? item.id : null, name: item.name, arguments: argumentsValue(item.arguments) });
    }
  }
  return calls;
}

function aiSdkToolCalls(attrs: Attributes): RequestedToolCall[] {
  const calls = decoded(attrs["ai.response.toolCalls"]);
  if (!Array.isArray(calls)) return [];
  return calls.flatMap(call => {
    const item = record(call);
    if (!item || typeof item.toolName !== "string") return [];
    return [{ id: typeof item.toolCallId === "string" ? item.toolCallId : null, name: item.toolName, arguments: argumentsValue(item.input ?? item.args) }];
  });
}

/** Tool calls the model asked for in this generation, as reported by the instrumentation. */
export function requestedToolCalls(attrs: Attributes | null): RequestedToolCall[] {
  if (!attrs) return [];
  for (const read of [openInferenceToolCalls, genAiToolCalls, aiSdkToolCalls]) {
    const calls = read(attrs);
    if (calls.length) return calls.slice(0, MAX_TOOL_CALLS);
  }
  return [];
}
