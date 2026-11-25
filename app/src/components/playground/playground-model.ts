import { estimateListPriceCost, PRICE_TABLE_AS_OF, type ListPriceEstimate } from "../../../../src/pricing/list-prices";
import type {
  PlaygroundCallResult, PlaygroundDraft, PlaygroundHistoryRun, PlaygroundErrorKind, PlaygroundKeyOrigin, PlaygroundMessage, PlaygroundProvider, PlaygroundProviderInfo, PlaygroundRunBody, PlaygroundTool,
  PlaygroundToolCall, ReasoningEffort,
} from "../../api/playground";

export const DRAFT_STORAGE_KEY = "runphantom:playground:draft";
export const MAX_COMPARE_COLUMNS = 3;
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const MAX_TOOLS = 32;
const MAX_OUTPUT_TOKENS = 8192;

export type EditorRole = "user" | "assistant" | "tool";

export interface EditorMessage {
  id: string;
  role: EditorRole;
  content: string;
  /** Assistant turns that asked for tools; kept verbatim so the following tool results stay valid. */
  toolCalls?: PlaygroundToolCall[];
  /** Tool results answer an earlier call by id. */
  toolCallId?: string;
  name?: string;
}

export interface PlaygroundTarget {
  provider: PlaygroundProvider;
  model: string;
}

export interface OpenedFrom {
  runId: string;
  spanId: string;
  runName: string | null;
  spanName: string;
  capturedModel: string | null;
  /** The Playground model opened in place of capturedModel, which the Playground does not offer; null when it was the same model. */
  substitutedModel: string | null;
  warnings: string[];
}

export interface PlaygroundDraftState {
  version: 1;
  system: string;
  messages: EditorMessage[];
  /** Kept as typed text so an empty field means "provider default". */
  temperature: string;
  maxOutputTokens: string;
  reasoningEffort: "" | ReasoningEffort;
  toolsEnabled: boolean;
  toolsText: string;
  targets: PlaygroundTarget[];
  openedFrom: OpenedFrom | null;
}

let idCounter = 0;
export function messageId(): string {
  idCounter += 1;
  return `m${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export const EXAMPLE_TOOLS_TEXT = JSON.stringify([
  {
    name: "get_weather",
    description: "Current weather for a city.",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
], null, 2);

export function defaultDraft(): PlaygroundDraftState {
  return {
    version: 1,
    system: "",
    messages: [{ id: messageId(), role: "user", content: "" }],
    temperature: "",
    maxOutputTokens: "1024",
    reasoningEffort: "",
    toolsEnabled: false,
    toolsText: EXAMPLE_TOOLS_TEXT,
    targets: [{ provider: "openai", model: "gpt-5-nano" }],
    openedFrom: null,
  };
}

const PROVIDERS: readonly PlaygroundProvider[] = ["openai", "anthropic", "gemini"];
const EFFORTS: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Reads a stored draft defensively: anything malformed falls back to the default rather than breaking the page. */
export function parseStoredDraft(raw: string | null): PlaygroundDraftState | null {
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!isRecord(value) || value.version !== 1) return null;
  const base = defaultDraft();
  const messages = Array.isArray(value.messages) ? value.messages.flatMap((item): EditorMessage[] => {
    if (!isRecord(item) || !["user", "assistant", "tool"].includes(item.role as string)) return [];
    const message: EditorMessage = { id: str(item.id) || messageId(), role: item.role as EditorRole, content: str(item.content) };
    if (Array.isArray(item.toolCalls)) message.toolCalls = item.toolCalls.filter(isRecord).map(call => ({ id: str(call.id), name: str(call.name), arguments: isRecord(call.arguments) ? call.arguments : {}, ...(typeof call.signature === "string" ? { signature: call.signature } : {}) }));
    if (typeof item.toolCallId === "string") message.toolCallId = item.toolCallId;
    if (typeof item.name === "string") message.name = item.name;
    return [message];
  }) : [];
  const targets = Array.isArray(value.targets) ? value.targets.flatMap((item): PlaygroundTarget[] =>
    isRecord(item) && PROVIDERS.includes(item.provider as PlaygroundProvider) && typeof item.model === "string" && item.model
      ? [{ provider: item.provider as PlaygroundProvider, model: item.model }] : []).slice(0, MAX_COMPARE_COLUMNS) : [];
  const opened = isRecord(value.openedFrom) && typeof value.openedFrom.runId === "string" && typeof value.openedFrom.spanId === "string"
    ? {
      runId: value.openedFrom.runId, spanId: value.openedFrom.spanId,
      runName: typeof value.openedFrom.runName === "string" ? value.openedFrom.runName : null,
      spanName: str(value.openedFrom.spanName),
      capturedModel: typeof value.openedFrom.capturedModel === "string" ? value.openedFrom.capturedModel : null,
      substitutedModel: typeof value.openedFrom.substitutedModel === "string" ? value.openedFrom.substitutedModel : null,
      warnings: Array.isArray(value.openedFrom.warnings) ? value.openedFrom.warnings.filter((item): item is string => typeof item === "string") : [],
    }
    : null;
  return {
    version: 1,
    system: str(value.system),
    messages: messages.length ? messages : base.messages,
    temperature: str(value.temperature),
    maxOutputTokens: str(value.maxOutputTokens, base.maxOutputTokens),
    reasoningEffort: EFFORTS.includes(value.reasoningEffort as ReasoningEffort) ? value.reasoningEffort as ReasoningEffort : "",
    toolsEnabled: value.toolsEnabled === true,
    toolsText: str(value.toolsText, base.toolsText),
    targets: targets.length ? targets : base.targets,
    openedFrom: opened,
  };
}

export function loadDraft(storage: Pick<Storage, "getItem"> | null = safeStorage()): PlaygroundDraftState {
  try { return parseStoredDraft(storage?.getItem(DRAFT_STORAGE_KEY) ?? null) ?? defaultDraft(); } catch { return defaultDraft(); }
}

export function saveDraft(state: PlaygroundDraftState, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try { storage?.setItem(DRAFT_STORAGE_KEY, JSON.stringify(state)); } catch { /* storage full or blocked: the draft lives for this session only */ }
}

function safeStorage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

function editorMessages(messages: readonly PlaygroundMessage[]): EditorMessage[] {
  return messages.map(message => {
    if (message.role === "tool") return { id: messageId(), role: "tool", content: message.content, toolCallId: message.toolCallId, ...(message.name ? { name: message.name } : {}) };
    if (message.role === "assistant") return { id: messageId(), role: "assistant", content: message.content, ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}) };
    return { id: messageId(), role: "user", content: message.content };
  });
}

/** Replaces the editor with a draft read from a captured span (or a recorded Playground run). */
export function stateFromDraft(draft: PlaygroundDraft, current: PlaygroundDraftState, options: { targets?: PlaygroundTarget[]; openedFrom: boolean }): PlaygroundDraftState {
  return {
    ...current,
    system: draft.system,
    messages: draft.messages.length ? editorMessages(draft.messages) : defaultDraft().messages,
    temperature: draft.params.temperature === undefined ? "" : String(draft.params.temperature),
    maxOutputTokens: String(draft.params.maxOutputTokens),
    reasoningEffort: "",
    toolsEnabled: draft.tools.length > 0,
    toolsText: draft.tools.length ? JSON.stringify(draft.tools, null, 2) : current.toolsText,
    targets: options.targets?.length ? options.targets.slice(0, MAX_COMPARE_COLUMNS) : [{ provider: draft.provider, model: draft.model }],
    openedFrom: options.openedFrom ? openedFromDraft(draft) : null,
  };
}

function openedFromDraft(draft: PlaygroundDraft): OpenedFrom {
  const substituted = draft.modelSubstituted && draft.capturedModel ? draft.capturedModel : null;
  // The substitution gets its own notice, so its line in the daemon's warning list would only repeat it.
  const repeat = substituted ? `${substituted} is not available in the Playground` : null;
  return {
    runId: draft.source.runId, spanId: draft.source.spanId, runName: draft.source.runName, spanName: draft.source.spanName,
    capturedModel: draft.capturedModel, substitutedModel: substituted ? draft.model : null,
    warnings: repeat ? draft.warnings.filter(warning => !warning.startsWith(repeat)) : draft.warnings,
  };
}

/**
 * The model a new compare column starts on: another keyed provider's default first, then any other keyed model, and a
 * provider without a key only when every keyed model is already shown.
 */
export function nextTarget(existing: readonly PlaygroundTarget[], providers: readonly PlaygroundProviderInfo[] | undefined): PlaygroundTarget {
  const used = new Set(existing.map(target => `${target.provider}/${target.model}`));
  const free = (provider: PlaygroundProviderInfo, model: string) => !used.has(`${provider.id}/${model}`);
  for (const configured of [true, false]) {
    const group = (providers ?? []).filter(provider => provider.configured === configured);
    const shown = new Set(existing.map(target => target.provider));
    const ordered = [...group.filter(provider => !shown.has(provider.id)), ...group.filter(provider => shown.has(provider.id))];
    for (const provider of ordered) if (free(provider, provider.defaultModel)) return { provider: provider.id, model: provider.defaultModel };
    for (const provider of ordered) for (const model of provider.models) if (free(provider, model.id)) return { provider: provider.id, model: model.id };
  }
  return existing[0] ?? { provider: "openai", model: "gpt-5-nano" };
}

export type ToolsParse = { ok: true; tools: PlaygroundTool[] } | { ok: false; error: string };

/** Mirrors the daemon's tool checks so mistakes show beside the editor instead of after a round trip. */
export function parseToolsText(text: string): ToolsParse {
  if (!text.trim()) return { ok: true, tools: [] };
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) {
    return { ok: false, error: `Tools are not valid JSON: ${error instanceof Error ? error.message : "parse error"}.` };
  }
  if (!Array.isArray(value)) return { ok: false, error: "Tools must be a JSON list, for example [{\"name\": \"get_weather\", ...}]." };
  if (value.length > MAX_TOOLS) return { ok: false, error: `Use at most ${MAX_TOOLS} tools.` };
  const names = new Set<string>();
  const tools: PlaygroundTool[] = [];
  for (const [index, item] of value.entries()) {
    const at = `Tool ${index + 1}`;
    if (!isRecord(item)) return { ok: false, error: `${at} must be an object with a name.` };
    const unknown = Object.keys(item).find(key => !["name", "description", "parameters"].includes(key));
    if (unknown) return { ok: false, error: `${at} has an unsupported field "${unknown}". Use name, description and parameters.` };
    if (typeof item.name !== "string" || !TOOL_NAME.test(item.name)) return { ok: false, error: `${at} needs a name that starts with a letter or underscore and uses only letters, digits, _ and -.` };
    if (names.has(item.name)) return { ok: false, error: `Tool "${item.name}" is listed twice.` };
    names.add(item.name);
    if (item.description !== undefined && typeof item.description !== "string") return { ok: false, error: `${at} description must be text.` };
    if (item.parameters !== undefined && (!isRecord(item.parameters) || (item.parameters.type !== undefined && item.parameters.type !== "object"))) {
      return { ok: false, error: `${at} parameters must be a JSON Schema object ({"type": "object", ...}).` };
    }
    tools.push({ name: item.name, ...(typeof item.description === "string" && item.description ? { description: item.description } : {}), parameters: (item.parameters as Record<string, unknown> | undefined) ?? { type: "object", properties: {} } });
  }
  return { ok: true, tools };
}

export type BuildResult =
  | { ok: true; body: PlaygroundRunBody }
  | { ok: false; error: string; field: "messages" | "temperature" | "maxOutputTokens" | "tools" | "targets"; /** The message at fault, for message errors. */ index?: number };

/** `maxTemperature` is the lowest limit among the selected models, as the editor hint shows it. */
export function buildRunBody(state: PlaygroundDraftState, options: { maxTemperature?: number } = {}): BuildResult {
  const maxTemperature = options.maxTemperature ?? 2;
  if (!state.targets.length) return { ok: false, error: "Choose a model to run.", field: "targets" };
  const messages: PlaygroundMessage[] = [];
  for (const [index, message] of state.messages.entries()) {
    const position = `Message ${index + 1}`;
    if (message.role === "tool") {
      if (!message.toolCallId) return { ok: false, error: `${position} is a tool result without the call it answers. Remove it or open the run again.`, field: "messages", index };
      messages.push({ role: "tool", toolCallId: message.toolCallId, ...(message.name ? { name: message.name } : {}), content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      if (!message.content.trim() && !message.toolCalls?.length) return { ok: false, error: `${position} is empty. Write the assistant reply or remove the message.`, field: "messages", index };
      messages.push({ role: "assistant", content: message.content, ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}) });
      continue;
    }
    if (!message.content.trim()) return { ok: false, error: `${position} is empty. Write a user message or remove it.`, field: "messages", index };
    messages.push({ role: "user", content: message.content });
  }
  if (!messages.length) return { ok: false, error: "Add a user message to run.", field: "messages" };
  if (messages[0]!.role !== "user") return { ok: false, error: "The first message must come from the user.", field: "messages", index: 0 };
  if (messages[messages.length - 1]!.role === "assistant") return { ok: false, error: "The last message must come from the user or a tool so the model has something to answer.", field: "messages", index: state.messages.length - 1 };

  const params: NonNullable<PlaygroundRunBody["params"]> = {};
  if (state.temperature.trim()) {
    const temperature = Number(state.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > maxTemperature) {
      return { ok: false, error: `Temperature must be a number from 0 to ${maxTemperature} for the selected ${state.targets.length === 1 ? "model" : "models"}, or empty for the model default.`, field: "temperature" };
    }
    params.temperature = temperature;
  }
  const maxText = state.maxOutputTokens.trim();
  const maxOutputTokens = Number(maxText);
  if (!maxText || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > MAX_OUTPUT_TOKENS) {
    return { ok: false, error: `Max output tokens must be a whole number from 1 to ${MAX_OUTPUT_TOKENS}.`, field: "maxOutputTokens" };
  }
  params.maxOutputTokens = maxOutputTokens;
  if (state.reasoningEffort) params.reasoningEffort = state.reasoningEffort;

  let tools: PlaygroundTool[] = [];
  if (state.toolsEnabled) {
    const parsed = parseToolsText(state.toolsText);
    if (!parsed.ok) return { ok: false, error: parsed.error, field: "tools" };
    tools = parsed.tools;
  }
  return {
    ok: true,
    body: {
      targets: state.targets.slice(0, MAX_COMPARE_COLUMNS),
      ...(state.system.trim() ? { system: state.system } : {}),
      messages,
      params,
      ...(tools.length ? { tools } : {}),
      ...(state.openedFrom ? { source: { runId: state.openedFrom.runId, spanId: state.openedFrom.spanId } } : {}),
    },
  };
}

/** Appends the model's tool calls and one empty result per call, so the next run continues the tool round. */
export function appendToolRound(state: PlaygroundDraftState, result: Pick<PlaygroundCallResult, "output">): PlaygroundDraftState {
  const calls = result.output.toolCalls;
  if (!calls.length) return state;
  return {
    ...state,
    messages: [
      ...state.messages,
      { id: messageId(), role: "assistant", content: result.output.text, toolCalls: calls },
      ...calls.map((call): EditorMessage => ({ id: messageId(), role: "tool", toolCallId: call.id, name: call.name, content: "" })),
    ],
  };
}

const PRICE_PROVIDER: Record<PlaygroundProvider, string> = { openai: "openai", anthropic: "anthropic", gemini: "gcp.gemini" };

/**
 * The same list-price estimate Runs and Cost & usage apply to the recorded span: usage includes cache
 * reads and writes (runphantom.usage.input_includes_cache), priced at the response model first.
 */
export function estimateResultCost(result: Pick<PlaygroundCallResult, "provider" | "model" | "responseModel" | "usage">, at: number = Date.now()): ListPriceEstimate {
  const base = {
    provider: PRICE_PROVIDER[result.provider], inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
    cacheReadTokens: result.usage.cachedInputTokens, cacheWriteTokens: result.usage.cacheWriteInputTokens, inputIncludesCache: true, at,
  };
  const byResponse = result.responseModel ? estimateListPriceCost({ ...base, model: result.responseModel }) : null;
  if (byResponse && byResponse.kind === "estimated") return byResponse;
  const byRequest = estimateListPriceCost({ ...base, model: result.model });
  return byRequest.kind === "estimated" || !byResponse ? byRequest : byResponse;
}

export const PRICE_LIST_DATE = PRICE_TABLE_AS_OF;

/** Rounds like the daemon's est_cost_usd (src/stats/common.ts roundUsd), so the column, History and Runs print the same digits. */
export function recordedCostUsd(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

export function costUnavailableReason(estimate: ListPriceEstimate): string {
  if (estimate.kind === "estimated") return "";
  switch (estimate.reason) {
    case "usage_unavailable": return "Cost unknown: the provider did not report token counts for this call.";
    case "model_unpriced": return "Cost unknown: this model is not in the bundled price list.";
    default: return "Cost unknown: the token counts could not be priced.";
  }
}

export interface ErrorHelp {
  title: string;
  hint: string;
  settings: boolean;
}

/**
 * A short heading and the next step for each failure kind the daemon reports. A key saved in Settings is used before
 * the environment variable, so saving a working key fixes a rejected key from either source.
 */
export function errorHelp(kind: PlaygroundErrorKind, key?: PlaygroundKeyOrigin | null): ErrorHelp {
  if (kind === "auth" && key?.source === "store") {
    return { title: "Key rejected", hint: "Run Phantom used the key saved in Settings. Replace it there, or check with the provider that it has not been revoked.", settings: true };
  }
  if (kind === "auth" && key?.source === "env") {
    const variable = key.envVar ?? "the provider's API key variable";
    return { title: "Key rejected", hint: `Run Phantom used the key in ${variable} because none is saved in Settings. Save a working key in Settings, which takes priority, or fix ${variable} and restart Run Phantom.`, settings: true };
  }
  switch (kind) {
    case "missing_key": return { title: "No API key", hint: "Add a key for this provider in Settings, or set its API key variable before starting Run Phantom, then run again.", settings: true };
    case "auth": return { title: "Key rejected", hint: "The provider refused the key. Replace it in Settings or check it has not been revoked.", settings: true };
    case "quota": return { title: "Out of quota", hint: "The account has no credit or quota left. Add billing with the provider, or pick another model.", settings: false };
    case "rate_limit": return { title: "Rate limited", hint: "Too many requests in a short time. Wait a minute and run again.", settings: false };
    case "invalid_model": return { title: "Model not available", hint: "This key cannot use the model. Choose another model from the list.", settings: false };
    case "invalid_request": return { title: "Request refused", hint: "The provider rejected the request. Check the messages, tools and parameters.", settings: false };
    case "overloaded": return { title: "Provider busy", hint: "The provider is overloaded. Try again in a moment.", settings: false };
    case "timeout": return { title: "Timed out", hint: "No answer within 2 minutes. Lower max output tokens or try again.", settings: false };
    case "network": return { title: "Network error", hint: "The provider could not be reached. Check your connection and run again.", settings: false };
    case "cancelled": return { title: "Stopped", hint: "The call was stopped before it finished. It is still recorded as a run.", settings: false };
    case "response_limit": return { title: "Response too large", hint: "The answer passed the size limit. Lower max output tokens.", settings: false };
    case "invalid_response": return { title: "Unreadable response", hint: "The provider sent a response Run Phantom could not read. Try again or pick another model.", settings: false };
    default: return { title: "Provider error", hint: "The provider failed to answer. Try again or pick another model.", settings: false };
  }
}

export const FINISH_REASON_LABEL: Record<string, string> = {
  stop: "Finished", length: "Hit max tokens", tool_calls: "Called tools", content_filter: "Filtered", error: "Error", other: "Other",
};

export interface HistoryGroup {
  key: string;
  runs: PlaygroundHistoryRun[];
  startedAt: number;
}

/** The column a recorded Playground run filled: compare runs start together, so start time cannot order them. */
export function targetIndexOf(spans: ReadonlyArray<{ attributes?: string | null }>): number | null {
  for (const span of spans) {
    try {
      const value = (JSON.parse(span.attributes ?? "{}") as Record<string, unknown>)["runphantom.playground.target_index"];
      if (typeof value === "number") return value;
    } catch { /* unreadable attributes carry no index */ }
  }
  return null;
}

/** Orders a compare group's runs by column; runs without a known column keep their start order at the end. */
export function orderByColumn<T extends { id: string }>(runs: readonly T[], columns: ReadonlyMap<string, number | null>): T[] {
  const at = (run: T) => columns.get(run.id) ?? Number.MAX_SAFE_INTEGER;
  return runs.map((run, position) => ({ run, position })).sort((a, b) => at(a.run) - at(b.run) || a.position - b.position).map(item => item.run);
}

/** One entry per Run (a compare run records one run per model under the same conversation id). */
export function groupHistory(runs: readonly PlaygroundHistoryRun[]): HistoryGroup[] {
  const groups = new Map<string, HistoryGroup>();
  for (const run of runs) {
    const key = run.convo_id ?? run.id;
    const group = groups.get(key);
    if (group) { group.runs.push(run); group.startedAt = Math.max(group.startedAt, run.started_at); }
    else groups.set(key, { key, runs: [run], startedAt: run.started_at });
  }
  for (const group of groups.values()) group.runs.sort((a, b) => a.started_at - b.started_at || a.id.localeCompare(b.id));
  return [...groups.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export type LeadMetric = "latency" | "firstToken" | "cost";

/**
 * Which compare columns lead each metric (lowest value wins). A metric leads only when at least two
 * successful columns report it and they differ, so a single run or a tie marks nothing.
 */
export function metricLeaders(results: ReadonlyArray<Pick<PlaygroundCallResult, "status" | "provider" | "model" | "responseModel" | "usage" | "latencyMs" | "timeToFirstTokenMs"> | null>, at: number = Date.now()): LeadMetric[][] {
  const values: Record<LeadMetric, Array<number | null>> = { latency: [], firstToken: [], cost: [] };
  for (const result of results) {
    const ok = result?.status === "ok" ? result : null;
    const cost = ok ? estimateResultCost(ok, at) : null;
    values.latency.push(ok && Number.isFinite(ok.latencyMs) ? ok.latencyMs : null);
    values.firstToken.push(ok?.timeToFirstTokenMs ?? null);
    values.cost.push(cost?.kind === "estimated" ? recordedCostUsd(cost.totalUsd) : null);
  }
  const leaders: LeadMetric[][] = results.map(() => []);
  for (const metric of Object.keys(values) as LeadMetric[]) {
    const known = values[metric].filter((value): value is number => value !== null);
    if (known.length < 2) continue;
    const low = Math.min(...known);
    if (low === Math.max(...known)) continue;
    values[metric].forEach((value, index) => { if (value === low) leaders[index]!.push(metric); });
  }
  return leaders;
}

/** True when the editor holds work worth offering to restore after it is replaced. */
export function draftHasContent(state: PlaygroundDraftState): boolean {
  return !!state.system.trim() || state.targets.length > 1 || state.messages.some(message => message.content.trim() || message.toolCalls?.length);
}
