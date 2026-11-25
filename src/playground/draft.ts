import { randomBytes } from "node:crypto";
import {
  PLAYGROUND_DEFAULT_MODEL, PLAYGROUND_LIMITS, PLAYGROUND_MODELS,
  type PlaygroundMessage, type PlaygroundProvider, type PlaygroundTool, type PlaygroundToolCall,
} from "./protocol";

export type DraftFormat = "otel-genai" | "otel-genai-legacy" | "openinference" | "ai-sdk" | "openai" | "anthropic" | "gemini" | "normalized";

export interface PlaygroundDraft {
  provider: PlaygroundProvider;
  model: string;
  capturedProvider: string | null;
  capturedModel: string | null;
  /** True when the captured model is not in the Playground list and `model` is a stand-in. */
  modelSubstituted: boolean;
  system: string;
  messages: PlaygroundMessage[];
  params: { temperature?: number; maxOutputTokens: number };
  tools: PlaygroundTool[];
  source: { runId: string; spanId: string; runName: string | null; spanName: string; format: DraftFormat };
  warnings: string[];
}

export interface DraftSpanInput {
  id: string;
  run_id: string;
  name: string;
  span_type: string | null;
  model: string | null;
  provider: string | null;
  input_payload: string | null;
  attributes: string | null;
  normalized?: { kind?: string; messages?: Array<{ role: string; content: string; toolCallId?: string }>; systemPrompt?: string } | null;
}

export class DraftUnavailableError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "DraftUnavailableError"; }
}

type Attrs = Record<string, unknown>;
type Json = Record<string, unknown>;

const record = (value: unknown): Json | null => value && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
const str = (value: unknown): string | null => typeof value === "string" ? value : null;
const parse = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return undefined; }
};
const num = (value: unknown): number | null => {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
};

function detectProvider(...hints: Array<string | null | undefined>): PlaygroundProvider | null {
  for (const hint of hints) {
    const value = (hint ?? "").toLowerCase();
    if (!value) continue;
    if (value.includes("anthropic") || value.includes("claude")) return "anthropic";
    if (value.includes("gemini") || value.includes("google") || value.includes("vertex")) return "gemini";
    if (value.includes("openai") || value.includes("azure") || /^(gpt-|o[1-9]|chatgpt)/.test(value)) return "openai";
  }
  return null;
}

/** Maps a captured (often dated) model id onto the Playground list: exact match, else the longest listed id it extends. */
function matchModel(provider: PlaygroundProvider, captured: string | null): string | null {
  if (!captured) return null;
  const candidates = PLAYGROUND_MODELS.filter(item => item.provider === provider).map(item => item.model);
  if (candidates.includes(captured)) return captured;
  return candidates.filter(id => captured.startsWith(`${id}-`)).sort((a, b) => b.length - a.length)[0] ?? null;
}

interface Converted { system: string[]; messages: PlaygroundMessage[]; warnings: Set<string> }

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("\n");
  const item = record(value);
  if (!item) return value === undefined || value === null ? "" : JSON.stringify(value);
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  if (item.content !== undefined) return textOf(item.content);
  return JSON.stringify(item);
}

function argsOf(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? parse(value) : value;
  return record(parsed) ?? (value === undefined || value === null || value === "" ? {} : { _raw: typeof value === "string" ? value : JSON.stringify(value) });
}

const resultText = (value: unknown): string => typeof value === "string" ? value : value === undefined ? "" : textOf(value);

function convertMessages(list: unknown[]): Converted {
  const out: Converted = { system: [], messages: [], warnings: new Set() };
  const pendingByName = new Map<string, string[]>();
  const known = new Set<string>();
  const remember = (call: PlaygroundToolCall) => {
    known.add(call.id);
    pendingByName.set(call.name, [...(pendingByName.get(call.name) ?? []), call.id]);
  };
  const callId = (id: unknown) => str(id) && /^[A-Za-z0-9_.:-]{1,128}$/.test(id as string) ? id as string : `call_${randomBytes(6).toString("hex")}`;
  const pushTool = (id: string | null, name: string | null, content: string) => {
    let resolved = id && known.has(id) ? id : null;
    if (!resolved && name) resolved = pendingByName.get(name)?.shift() ?? null;
    if (!resolved) { out.warnings.add("A tool result without a matching tool call was left out."); return; }
    out.messages.push({ role: "tool", toolCallId: resolved, content });
  };

  for (const value of list) {
    const message = record(value);
    if (!message) continue;
    const role = String(message.role ?? "user").toLowerCase();
    const parts: unknown[] = Array.isArray(message.parts) ? message.parts : Array.isArray(message.content) ? message.content : [];
    const plain = typeof message.content === "string" ? message.content : null;

    if (role === "system" || role === "developer") {
      const text = plain ?? textOf(parts);
      if (text) out.system.push(text);
      continue;
    }

    if (role === "tool" || role === "function" || role === "ipython") {
      if (parts.length && parts.some(part => record(part)?.type === "tool_call_response" || record(part)?.type === "tool-result" || record(part)?.functionResponse)) {
        for (const partValue of parts) {
          const part = record(partValue);
          if (!part) continue;
          const response = record(part.functionResponse);
          if (response) pushTool(str(response.id), str(response.name), resultText(response.response));
          else pushTool(str(part.id) ?? str(part.toolCallId), str(part.name) ?? str(part.toolName), resultText(part.response ?? part.result ?? part.output));
        }
      } else {
        pushTool(str(message.tool_call_id) ?? str(message.toolCallId) ?? str(message.id), str(message.name), plain ?? textOf(parts));
      }
      continue;
    }

    const assistant = role === "assistant" || role === "model" || role === "ai";
    const texts: string[] = plain !== null ? [plain] : [];
    const calls: PlaygroundToolCall[] = [];
    const results: Array<{ id: string | null; name: string | null; content: string }> = [];
    for (const partValue of parts) {
      if (typeof partValue === "string") { texts.push(partValue); continue; }
      const part = record(partValue);
      if (!part) continue;
      const type = str(part.type);
      const functionCall = record(part.functionCall);
      const functionResponse = record(part.functionResponse);
      if (functionCall) calls.push({ id: callId(functionCall.id), name: String(functionCall.name ?? ""), arguments: argsOf(functionCall.args), ...(str(part.thoughtSignature) ? { signature: part.thoughtSignature as string } : {}) });
      else if (functionResponse) results.push({ id: str(functionResponse.id), name: str(functionResponse.name), content: resultText(functionResponse.response) });
      else if (type === "tool_use" || type === "tool_call" || type === "tool-call" || type === "function_call") calls.push({ id: callId(part.id ?? part.toolCallId ?? part.call_id), name: String(part.name ?? part.toolName ?? ""), arguments: argsOf(part.input ?? part.arguments ?? part.args) });
      else if (type === "tool_result" || type === "tool_call_response" || type === "tool-result" || type === "function_call_output") results.push({ id: str(part.tool_use_id) ?? str(part.id) ?? str(part.toolCallId) ?? str(part.call_id), name: str(part.name) ?? str(part.toolName), content: resultText(part.content ?? part.response ?? part.result ?? part.output) });
      else if (type === "thinking" || type === "redacted_thinking" || type === "reasoning" || part.thought === true) out.warnings.add("Reasoning blocks from the captured call were left out.");
      else if (type === "text" || type === "input_text" || type === "output_text" || (type === null && typeof part.text === "string")) texts.push(str(part.text) ?? str(part.content) ?? "");
      else out.warnings.add(`Content of type ${type ?? "unknown"} (for example images or files) was left out.`);
    }
    for (const callValue of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      const call = record(callValue);
      const fn = record(call?.function);
      if (call) calls.push({ id: callId(call.id), name: String(fn?.name ?? call.name ?? ""), arguments: argsOf(fn?.arguments ?? call.arguments) });
    }

    if (assistant) {
      const valid = calls.filter(call => /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(call.name));
      if (valid.length !== calls.length) out.warnings.add("A tool call with an unusable name was left out.");
      valid.forEach(remember);
      const text = texts.join("\n");
      if (text.trim() || valid.length) out.messages.push({ role: "assistant", content: text, ...(valid.length ? { toolCalls: valid } : {}) });
    } else {
      for (const result of results) pushTool(result.id, result.name, result.content);
      const text = texts.join("\n");
      if (text.trim()) out.messages.push({ role: "user", content: text });
    }
  }
  return out;
}

function normalizeTool(value: unknown): PlaygroundTool | null {
  const raw = record(typeof value === "string" ? parse(value) : value);
  if (!raw) return null;
  const fn = record(raw.function) ?? raw;
  const name = str(fn.name);
  if (!name || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name)) return null;
  const parameters = record(fn.parameters ?? fn.input_schema ?? fn.inputSchema ?? fn.parametersJsonSchema ?? record(fn.jsonSchema)) ?? { type: "object", properties: {} };
  const description = str(fn.description);
  return { name, ...(description ? { description: description.slice(0, PLAYGROUND_LIMITS.toolDescriptionChars) } : {}), parameters: { type: "object", ...parameters } };
}

function toolList(value: unknown): unknown[] {
  const parsed = typeof value === "string" ? parse(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap(item => {
    const entry = record(typeof item === "string" ? parse(item) : item);
    return Array.isArray(entry?.functionDeclarations) ? entry.functionDeclarations as unknown[] : [item];
  });
}

function indexed(attrs: Attrs, prefix: string): Attrs[] {
  const entries = new Map<number, Attrs>();
  for (const [key, value] of Object.entries(attrs)) {
    if (!key.startsWith(prefix)) continue;
    const match = /^(\d+)\.(.+)$/.exec(key.slice(prefix.length));
    if (!match) continue;
    const index = Number(match[1]);
    const item = entries.get(index) ?? {};
    item[match[2]] = value;
    entries.set(index, item);
  }
  return [...entries].sort(([a], [b]) => a - b).map(([, item]) => item);
}

function openInferenceMessages(attrs: Attrs): unknown[] {
  return indexed(attrs, "llm.input_messages.").map(item => {
    const contents = indexed(item, "message.contents.").map(part => ({ type: part["message_content.type"] ?? "text", text: part["message_content.text"] }));
    const calls = indexed(item, "message.tool_calls.").map(call => ({ id: call["tool_call.id"], function: { name: call["tool_call.function.name"], arguments: call["tool_call.function.arguments"] } }));
    return {
      role: item["message.role"], content: item["message.content"] ?? contents,
      ...(calls.length ? { tool_calls: calls } : {}),
      ...(item["message.tool_call_id"] !== undefined ? { tool_call_id: item["message.tool_call_id"] } : {}),
      ...(item["message.name"] !== undefined ? { name: item["message.name"] } : {}),
    };
  });
}

function legacyGenAiMessages(attrs: Attrs): unknown[] {
  return indexed(attrs, "gen_ai.prompt.").map(item => {
    const content = parse(item.content);
    return {
      role: item.role, content: Array.isArray(content) ? content : item.content,
      ...(item.tool_call_id !== undefined ? { tool_call_id: item.tool_call_id } : {}),
      ...(indexed(item, "tool_calls.").length ? { tool_calls: indexed(item, "tool_calls.").map(call => ({ id: call.id, function: { name: call.name, arguments: call.arguments } })) } : {}),
    };
  });
}

interface Extracted { format: DraftFormat; list: unknown[]; system: string[]; tools: unknown[]; params: Json; providerHint: string | null; modelHint: string | null }

function fromRawBody(body: Json): Extracted | null {
  if (Array.isArray(body.contents)) {
    const instruction = record(body.systemInstruction ?? body.system_instruction);
    return { format: "gemini", list: body.contents, system: instruction ? [textOf(instruction.parts)] : [], tools: toolList(body.tools), params: record(body.generationConfig) ?? {}, providerHint: "gemini", modelHint: str(body.model) };
  }
  if (!Array.isArray(body.messages)) return null;
  const messages = body.messages as unknown[];
  const anthropic = body.system !== undefined || messages.some(item => Array.isArray(record(item)?.content) && (record(item)!.content as unknown[]).some(part => ["tool_use", "tool_result"].includes(String(record(part)?.type))))
    || (Array.isArray(body.tools) && body.tools.some(tool => record(tool)?.input_schema !== undefined));
  const system = typeof body.system === "string" ? [body.system] : Array.isArray(body.system) ? [textOf(body.system)] : [];
  return { format: anthropic ? "anthropic" : "openai", list: messages, system, tools: toolList(body.tools), params: body, providerHint: anthropic ? "anthropic" : str(body.model)?.startsWith("claude") ? "anthropic" : "openai", modelHint: str(body.model) };
}

function extract(attrs: Attrs, span: DraftSpanInput): Extracted | null {
  const providerHint = str(attrs["gen_ai.provider.name"]) ?? str(attrs["gen_ai.system"]) ?? str(attrs["llm.provider"]) ?? str(attrs["llm.system"]) ?? str(attrs["ai.model.provider"]);
  const modelHint = str(attrs["gen_ai.request.model"]) ?? str(attrs["llm.model_name"]) ?? str(attrs["llm.request.model"]) ?? str(attrs["ai.model.id"]);
  const genAiInput = parse(attrs["gen_ai.input.messages"]);
  if (Array.isArray(genAiInput)) {
    const instructions = parse(attrs["gen_ai.system_instructions"]);
    return {
      format: "otel-genai", list: genAiInput, system: instructions === undefined ? [] : [typeof instructions === "string" ? instructions : textOf(instructions)],
      tools: toolList(attrs["gen_ai.tool.definitions"]), params: { temperature: attrs["gen_ai.request.temperature"], max_tokens: attrs["gen_ai.request.max_tokens"] }, providerHint, modelHint,
    };
  }
  if (Object.keys(attrs).some(key => key.startsWith("llm.input_messages."))) {
    const invocation = record(parse(attrs["llm.invocation_parameters"])) ?? {};
    return {
      format: "openinference", list: openInferenceMessages(attrs), system: [],
      tools: indexed(attrs, "llm.tools.").map(item => item["tool.json_schema"]), params: invocation, providerHint, modelHint: modelHint ?? str(invocation.model),
    };
  }
  if (Object.keys(attrs).some(key => key.startsWith("gen_ai.prompt."))) {
    return { format: "otel-genai-legacy", list: legacyGenAiMessages(attrs), system: [], tools: [], params: { temperature: attrs["gen_ai.request.temperature"], max_tokens: attrs["gen_ai.request.max_tokens"] }, providerHint, modelHint };
  }
  const aiSdkMessages = parse(attrs["ai.prompt.messages"]);
  const aiSdkPrompt = record(parse(attrs["ai.prompt"]));
  if (Array.isArray(aiSdkMessages) || aiSdkPrompt) {
    const list = Array.isArray(aiSdkMessages) ? aiSdkMessages : Array.isArray(aiSdkPrompt?.messages) ? aiSdkPrompt.messages as unknown[] : typeof aiSdkPrompt?.prompt === "string" ? [{ role: "user", content: aiSdkPrompt.prompt }] : [];
    return {
      format: "ai-sdk", list, system: typeof aiSdkPrompt?.system === "string" ? [aiSdkPrompt.system] : [],
      tools: toolList(attrs["ai.prompt.tools"]),
      params: { temperature: attrs["ai.settings.temperature"], max_tokens: attrs["ai.settings.maxOutputTokens"] ?? attrs["ai.settings.maxTokens"] },
      providerHint, modelHint,
    };
  }
  for (const candidate of [span.input_payload, attrs["traceloop.entity.input"], attrs["input.value"]]) {
    const body = record(parse(candidate));
    const raw = body ? fromRawBody(body) : null;
    if (raw) return { ...raw, providerHint: providerHint ?? raw.providerHint, modelHint: modelHint ?? raw.modelHint };
    const list = parse(candidate);
    if (Array.isArray(list) && list.some(item => record(item)?.role !== undefined)) return { format: "openai", list, system: [], tools: [], params: {}, providerHint, modelHint };
  }
  const normalized = span.normalized;
  if (normalized?.kind === "llm" && (normalized.messages?.length || normalized.systemPrompt)) {
    return {
      format: "normalized", list: (normalized.messages ?? []).map(item => ({ role: item.role, content: item.content, ...(item.toolCallId ? { tool_call_id: item.toolCallId } : {}) })),
      system: normalized.systemPrompt ? [normalized.systemPrompt] : [], tools: [], params: {}, providerHint, modelHint,
    };
  }
  return null;
}

/** Turns a captured LLM span into a Playground request draft that can be sent back to POST /api/playground/runs. */
export function draftFromSpan(span: DraftSpanInput, runName: string | null): PlaygroundDraft {
  if (span.span_type !== "LLM_GENERATION") throw new DraftUnavailableError("Only model call spans can be opened in the Playground.", 422);
  let attrs: Attrs = {};
  try { attrs = record(JSON.parse(span.attributes ?? "{}")) ?? {}; } catch { attrs = {}; }
  const extracted = extract(attrs, span);
  if (!extracted) throw new DraftUnavailableError("This span did not capture its prompt, so there is nothing to open in the Playground.", 422);

  const converted = convertMessages(extracted.list);
  const warnings = converted.warnings;
  const system = [...extracted.system, ...converted.system].filter(text => text.trim()).join("\n\n");
  let messages = converted.messages;
  if (!messages.length) throw new DraftUnavailableError("This span captured no user or assistant messages to open in the Playground.", 422);
  while (messages.length && messages[0].role !== "user") {
    messages = messages.slice(1);
    warnings.add("Messages before the first user message were left out.");
  }
  if (messages.length && messages[messages.length - 1].role === "assistant") {
    messages = messages.slice(0, -1);
    warnings.add("A trailing assistant message (a prefill) was left out so the model answers the last user turn.");
  }
  if (!messages.length) throw new DraftUnavailableError("This span captured no user message to open in the Playground.", 422);
  if (messages.length > PLAYGROUND_LIMITS.messages) {
    warnings.add(`Only the last ${PLAYGROUND_LIMITS.messages} messages were kept.`);
    messages = messages.slice(-PLAYGROUND_LIMITS.messages);
    while (messages.length && messages[0].role !== "user") messages = messages.slice(1);
  }

  const capturedModel = extracted.modelHint ?? span.model;
  const capturedProvider = extracted.providerHint ?? span.provider;
  const provider = detectProvider(capturedProvider, capturedModel, extracted.format === "anthropic" ? "anthropic" : extracted.format === "gemini" ? "gemini" : null) ?? "openai";
  const matched = matchModel(provider, capturedModel) ?? matchModel(provider, span.model);
  const model = matched ?? PLAYGROUND_DEFAULT_MODEL[provider];
  if (!matched) warnings.add(capturedModel
    ? `${capturedModel} is not available in the Playground, so ${model} was selected instead.`
    : `The span did not record its model, so ${model} was selected.`);

  const params = extracted.params;
  const generation = record(params.generationConfig) ?? params;
  const temperature = num(generation.temperature);
  const requestedMax = num(generation.max_completion_tokens ?? generation.max_output_tokens ?? generation.max_tokens ?? generation.maxOutputTokens ?? generation.maxTokens);
  let maxOutputTokens = requestedMax !== null && Number.isSafeInteger(requestedMax) && requestedMax > 0 ? requestedMax : PLAYGROUND_LIMITS.defaultMaxOutputTokens;
  if (maxOutputTokens > PLAYGROUND_LIMITS.maxOutputTokens) {
    warnings.add(`The captured output limit of ${maxOutputTokens} tokens was lowered to the Playground maximum of ${PLAYGROUND_LIMITS.maxOutputTokens}.`);
    maxOutputTokens = PLAYGROUND_LIMITS.maxOutputTokens;
  }

  const tools: PlaygroundTool[] = [];
  for (const value of extracted.tools) {
    const tool = normalizeTool(value);
    if (!tool) { warnings.add("A tool definition that could not be read was left out."); continue; }
    if (tools.length >= PLAYGROUND_LIMITS.tools) { warnings.add(`Only the first ${PLAYGROUND_LIMITS.tools} tools were kept.`); break; }
    if (!tools.some(item => item.name === tool.name)) tools.push(tool);
  }
  const calledTools = new Set(messages.flatMap(item => item.role === "assistant" ? (item.toolCalls ?? []).map(call => call.name) : []));
  const missing = [...calledTools].filter(name => !tools.some(tool => tool.name === name));
  if (missing.length) warnings.add(`The span did not record definitions for ${missing.join(", ")}; add them before running if the model should call them again.`);

  return {
    provider, model, capturedProvider: capturedProvider ?? null, capturedModel: capturedModel ?? null, modelSubstituted: !matched,
    system: system.slice(0, PLAYGROUND_LIMITS.systemChars),
    messages: messages.map(item => ({ ...item, content: item.content.slice(0, PLAYGROUND_LIMITS.messageChars) })),
    params: { ...(temperature !== null && temperature >= 0 && temperature <= 2 ? { temperature } : {}), maxOutputTokens },
    tools,
    source: { runId: span.run_id, spanId: span.id, runName, spanName: span.name, format: extracted.format },
    warnings: [...warnings],
  };
}
