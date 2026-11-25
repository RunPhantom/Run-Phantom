import { apiJson, jsonInit } from "./request";
import { getRunDetail, searchRuns, type RunSearchRun } from "./runs";
import { targetIndexOf } from "../components/playground/playground-model";
import type {
  PlaygroundCallResult, PlaygroundMessage, PlaygroundProvider, PlaygroundRunResponse, PlaygroundTool, ReasoningEffort,
} from "../../../src/playground/protocol";

export type {
  PlaygroundCallResult, PlaygroundError, PlaygroundErrorKind, PlaygroundMessage, PlaygroundProvider, PlaygroundRunResponse,
  PlaygroundTool, PlaygroundToolCall, PlaygroundUsage, ReasoningEffort,
} from "../../../src/playground/protocol";

export interface PlaygroundModelInfo {
  id: string;
  label: string;
  temperature: boolean;
  maxTemperature: number;
  reasoningEffort: boolean;
}

export interface PlaygroundProviderInfo {
  id: PlaygroundProvider;
  label: string;
  configured: boolean;
  keySource: "env" | "store" | null;
  defaultModel: string;
  models: PlaygroundModelInfo[];
}

export interface PlaygroundLimits {
  targets: number;
  concurrentCalls: number;
  messages: number;
  systemChars: number;
  messageChars: number;
  totalTextChars: number;
  tools: number;
  defaultMaxOutputTokens: number;
  maxOutputTokens: number;
  callTimeoutMs: number;
  requestBytes: number;
}

export interface PlaygroundModelsResponse {
  providers: PlaygroundProviderInfo[];
  limits: PlaygroundLimits;
}

export type DraftFormat = "otel-genai" | "otel-genai-legacy" | "openinference" | "ai-sdk" | "openai" | "anthropic" | "gemini" | "normalized";

export interface PlaygroundDraft {
  provider: PlaygroundProvider;
  model: string;
  capturedProvider: string | null;
  capturedModel: string | null;
  modelSubstituted: boolean;
  system: string;
  messages: PlaygroundMessage[];
  params: { temperature?: number; maxOutputTokens: number };
  tools: PlaygroundTool[];
  source: { runId: string; spanId: string; runName: string | null; spanName: string; format: DraftFormat };
  warnings: string[];
}

export interface PlaygroundRunBody {
  targets: Array<{ provider: PlaygroundProvider; model: string }>;
  system?: string;
  messages: PlaygroundMessage[];
  params?: { temperature?: number; maxOutputTokens?: number; reasoningEffort?: ReasoningEffort };
  tools?: PlaygroundTool[];
  source?: { runId: string; spanId: string };
}

export function getPlaygroundModels(signal?: AbortSignal): Promise<PlaygroundModelsResponse> {
  return apiJson<PlaygroundModelsResponse>("/api/playground/models", { signal });
}

export function getDraftFromSpan(spanId: string, runId?: string | null, signal?: AbortSignal): Promise<PlaygroundDraft> {
  const query = runId ? `?${new URLSearchParams({ run_id: runId })}` : "";
  return apiJson<PlaygroundDraft>(`/api/playground/draft-from-span/${encodeURIComponent(spanId)}${query}`, { signal });
}

export type PlaygroundStreamEvent =
  | { type: "start"; comparisonId: string; targets: Array<{ index: number; provider: PlaygroundProvider; model: string }> }
  | { type: "delta"; index: number; text: string }
  | { type: "result"; result: PlaygroundCallResult }
  | { type: "done"; comparisonId: string }
  | { type: "error"; error: string };

/**
 * Incremental text/event-stream parser. Feed decoded text with push(); each complete event
 * is returned once. finish() flushes a final event that ended without a blank line.
 */
export function createSseParser(): { push(text: string): Array<{ event: string; data: string }>; finish(): Array<{ event: string; data: string }> } {
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  const line = (value: string, out: Array<{ event: string; data: string }>) => {
    if (value === "") {
      if (data.length) out.push({ event, data: data.join("\n") });
      event = "message"; data = [];
      return;
    }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon === -1 ? value : value.slice(0, colon);
    let rest = colon === -1 ? "" : value.slice(colon + 1);
    if (rest.startsWith(" ")) rest = rest.slice(1);
    if (field === "event") event = rest;
    else if (field === "data") data.push(rest);
  };
  return {
    push(text) {
      buffer += text;
      const out: Array<{ event: string; data: string }> = [];
      for (;;) {
        const match = /\r\n|\r|\n/.exec(buffer);
        if (!match) break;
        // A CR at the very end may be the first half of a CRLF split across chunks.
        if (match[0] === "\r" && match.index + 1 === buffer.length) break;
        const value = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        line(value, out);
      }
      return out;
    },
    finish() {
      const out: Array<{ event: string; data: string }> = [];
      if (buffer) { line(buffer, out); buffer = ""; }
      line("", out);
      return out;
    },
  };
}

export function toStreamEvent(raw: { event: string; data: string }): PlaygroundStreamEvent | null {
  let data: unknown;
  try { data = JSON.parse(raw.data); } catch { return null; }
  if (!data || typeof data !== "object") return null;
  const value = data as Record<string, unknown>;
  switch (raw.event) {
    case "start": return { type: "start", comparisonId: String(value.comparisonId ?? ""), targets: Array.isArray(value.targets) ? value.targets as Array<{ index: number; provider: PlaygroundProvider; model: string }> : [] };
    case "delta": return typeof value.index === "number" && typeof value.text === "string" ? { type: "delta", index: value.index, text: value.text } : null;
    case "result": return typeof value.index === "number" ? { type: "result", result: value as unknown as PlaygroundCallResult } : null;
    case "done": return { type: "done", comparisonId: String(value.comparisonId ?? "") };
    case "error": return { type: "error", error: typeof value.error === "string" ? value.error : "The Playground request failed." };
    default: return null;
  }
}

/**
 * Runs the request with stream: true and reports each event as it arrives. Resolves when the
 * stream ends. Throws with the daemon's sentence for HTTP errors (validation, busy, forbidden).
 */
export async function streamPlaygroundRun(body: PlaygroundRunBody, onEvent: (event: PlaygroundStreamEvent) => void, signal?: AbortSignal): Promise<void> {
  const response = await fetch("/api/playground/runs", { ...jsonInit("POST", { ...body, stream: true }), signal });
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok || !type.includes("text/event-stream")) {
    const payload = type.includes("application/json") ? await response.json().catch(() => null) as { error?: unknown } | null : null;
    if (response.ok && type.includes("application/json") && payload && "results" in payload) {
      const json = payload as unknown as PlaygroundRunResponse;
      onEvent({ type: "start", comparisonId: json.comparisonId, targets: json.results.map(result => ({ index: result.index, provider: result.provider, model: result.model })) });
      for (const result of json.results) onEvent({ type: "result", result });
      onEvent({ type: "done", comparisonId: json.comparisonId });
      return;
    }
    throw new Error(typeof payload?.error === "string" ? payload.error : `The Playground request failed (HTTP ${response.status}).`);
  }
  if (!response.body) throw new Error("The Playground response had no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  const emit = (items: Array<{ event: string; data: string }>) => {
    for (const item of items) {
      const event = toStreamEvent(item);
      if (event) onEvent(event);
    }
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      emit(parser.push(decoder.decode(chunk.value, { stream: true })));
    }
    emit(parser.push(decoder.decode()));
    emit(parser.finish());
  } finally {
    reader.releaseLock();
  }
}

export const PLAYGROUND_TAG_FILTER = JSON.stringify({ version: 1, all: [{ field: "tag", op: "eq", value: "playground" }] });

export type PlaygroundHistoryRun = RunSearchRun & { input_preview?: string | null; est_cost_usd?: number | null; cost_source?: string | null };

/**
 * Recent Playground runs, newest first: real recorded runs carrying the `playground` tag. The tag search
 * decides membership; the run list adds the prompt preview and cost for the same ids.
 */
export async function listPlaygroundHistory(limit = 40, signal?: AbortSignal): Promise<PlaygroundHistoryRun[]> {
  const [page, facts] = await Promise.all([
    searchRuns({ filter: PLAYGROUND_TAG_FILTER, limit }, signal),
    apiJson<{ runs: Array<{ id: string; input_preview?: string | null; est_cost_usd?: number | null; cost_source?: string | null }> }>(
      `/api/runs?${new URLSearchParams({ envelope: "1", q: "Playground:", limit: String(Math.max(limit * 2, 100)) })}`, { signal },
    ).catch(() => ({ runs: [] })),
  ]);
  const byId = new Map(facts.runs.map(run => [run.id, run]));
  return page.runs.map(run => {
    const extra = byId.get(run.id);
    return extra ? { ...run, input_preview: extra.input_preview ?? null, est_cost_usd: extra.est_cost_usd ?? null, cost_source: extra.cost_source ?? null } : run;
  });
}

export interface RecordedColumn {
  runId: string;
  /** The model-call span, the one Open in Playground and the Runs link point at. */
  spanId: string | null;
  /** The compare column the run filled, or null for runs recorded before columns were tagged. */
  index: number | null;
}

export async function recordedColumn(runId: string, signal?: AbortSignal): Promise<RecordedColumn> {
  const detail = await getRunDetail(runId, signal);
  return { runId, spanId: detail.spans.find(span => span.span_type?.includes("LLM"))?.id ?? null, index: targetIndexOf(detail.spans) };
}

/** The runs one Playground request recorded, found by its comparison id (each run's conversation id). */
export async function findComparisonRuns(comparisonId: string, signal?: AbortSignal): Promise<RecordedColumn[]> {
  const page = await searchRuns({ filter: PLAYGROUND_TAG_FILTER, limit: 20 }, signal);
  return Promise.all(page.runs.filter(run => run.convo_id === comparisonId).map(run => recordedColumn(run.id, signal)));
}
