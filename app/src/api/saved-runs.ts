import { useSyncExternalStore } from "react";
import { z } from "zod";
import { apiJson, apiJsonOrNull, jsonInit } from "./request";
import { PROVIDER_SUMMARY, type ProviderSummaryConsent, type ProviderSummaryResult } from "../../../src/summary-protocol";
import { scrubSecretText } from "../../../src/verification/redaction";
import type { LiveEvent, Run, Span, SubAgent } from "../utils/types";
export const SAVED_RUNS_REFRESH_EVENT = "runphantom:saved-runs:updated";

const optionalStringSchema = z.preprocess(
  value => typeof value === "string" && value.length > 0 ? value : undefined,
  z.string().optional(),
);

const nullableStringSchema = z.preprocess(
  value => typeof value === "string" ? value : null,
  z.string().nullable(),
);

const savedSignalSchema = z.object({
  id: z.string(),
  name: z.string(),
  score: z.number().optional(),
});

type SavedSignal = z.infer<typeof savedSignalSchema>;

const savedSignalsSchema = z.array(
  z.unknown().transform(value => {
    const parsed = savedSignalSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }),
).transform(signals => signals.filter((signal): signal is SavedSignal => signal !== null));

const savedEventSchema = z.object({
  id: z.string(),
  event_name: z.preprocess(value => typeof value === "string" ? value : "", z.string()),
  user_id: nullableStringSchema,
  convo_id: nullableStringSchema,
  timestamp: z.preprocess(value => typeof value === "string" ? value : "", z.string()),
  user_input: nullableStringSchema,
  assistant_output: nullableStringSchema,
  signals: z.preprocess(value => value ?? undefined, savedSignalsSchema.optional()),
  properties: z.preprocess(
    value => value ?? undefined,
    z.record(z.string(), z.unknown()).optional(),
  ),
  saved_at: z.number().catch(() => Date.now()),
  summary: optionalStringSchema,
  folder: optionalStringSchema,
});

export type SavedEvent = z.infer<typeof savedEventSchema>;

const savedAnnotationPreviewSchema = z.object({
  id: z.string(),
  kind: z.enum(["issue", "good", "note"]),
  note: z.string().nullable(),
  source: z.enum(["user", "claude-code", "codex", "opencode"]),
  span_id: z.string().nullable(),
  created_at: z.number(),
});

export type SavedAnnotationPreview = z.infer<typeof savedAnnotationPreviewSchema>;

const folderEntrySchema = z.object({
  name: z.string(),
  color: z.string(),
});

type FolderEntry = z.infer<typeof folderEntrySchema>;

const savedRunsPayloadSchema = z.object({
  events: z.array(z.unknown()).optional(),
  folders: z.array(z.unknown()).optional(),
});

const spanCacheSchema: z.ZodType<Span> = z.object({
  id: z.string(),
  run_id: z.string(),
  parent_span_id: z.string().nullable(),
  name: z.string(),
  span_type: z.string().nullable(),
  status: z.string(),
  input_payload: z.string().nullable(),
  output_payload: z.string().nullable(),
  start_time_ms: z.number(),
  end_time_ms: z.number(),
  duration_ms: z.number(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  attributes: z.string().nullable(),
  normalized: z.custom<Span["normalized"]>().optional(),
});

interface CacheState {
  loaded: boolean;
  version: number;
  events: SavedEvent[];
  folders: FolderEntry[];
}

const state: CacheState = { loaded: false, version: 0, events: [], folders: [] };
let loadPromise: Promise<void> | null = null;

function emitSavedRunsChanged() {
  state.version += 1;
  window.dispatchEvent(new Event(SAVED_RUNS_REFRESH_EVENT));
}

export function subscribeSavedRuns(listener: () => void): () => void {
  const handler = () => listener();
  window.addEventListener(SAVED_RUNS_REFRESH_EVENT, handler);
  return () => {
    window.removeEventListener(SAVED_RUNS_REFRESH_EVENT, handler);
  };
}

function getSnapshot() {
  if (!state.loaded) ensureSavedRunsLoaded().catch(() => {});
  return state.version;
}

function getServerSnapshot() {
  return state.version;
}

function parseSavedEvent(value: unknown): SavedEvent | null {
  const parsed = savedEventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseFolderEntry(value: unknown): FolderEntry | null {
  const parsed = folderEntrySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function applyServerPayload(payload: unknown) {
  const parsed = savedRunsPayloadSchema.safeParse(payload);
  if (!parsed.success) return;
  if (parsed.data.events) {
    state.events = parsed.data.events
      .map(parseSavedEvent)
      .filter((event): event is SavedEvent => event !== null)
      .sort((a, b) => b.saved_at - a.saved_at);
  }
  if (parsed.data.folders) {
    state.folders = parsed.data.folders
      .map(parseFolderEntry)
      .filter((folder): folder is FolderEntry => folder !== null);
  }
}

async function loadFromServer(): Promise<void> {
  try {
    const data = await apiJson<unknown>("/api/saved-runs");
    applyServerPayload(data);
  } catch {
    // Server unreachable; leave current cache in place.
  } finally {
    state.loaded = true;
  }
}

export async function ensureSavedRunsLoaded(): Promise<void> {
  if (state.loaded) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    await loadFromServer();
    emitSavedRunsChanged();
  })();
  return loadPromise;
}

export function useSavedRuns() {
  useSyncExternalStore(subscribeSavedRuns, getSnapshot, getServerSnapshot);
  return {
    events: getSavedEvents(),
    folders: getFolders(),
    folderColors: getFolderColors(),
  };
}

export function useSavedEvent(id: string | null | undefined) {
  useSyncExternalStore(subscribeSavedRuns, getSnapshot, getServerSnapshot);
  if (!id) return null;
  return state.events.find(event => event.id === id) ?? null;
}

export function getSavedEvents(): SavedEvent[] {
  if (!state.loaded) ensureSavedRunsLoaded().catch(() => {});
  return state.events.slice();
}

export function getFolders(): string[] {
  if (!state.loaded) ensureSavedRunsLoaded().catch(() => {});
  return state.folders.map(f => f.name);
}

export function getFolderColors(): Record<string, string> {
  return Object.fromEntries(state.folders.map(f => [f.name, f.color]));
}

export function getFolderColor(folder: string): string {
  const existing = state.folders.find(f => f.name === folder);
  return existing?.color ?? "#746A75";
}

export function addFolder(name: string) {
  if (!name) return;
  if (!state.folders.some(f => f.name === name)) {
    state.folders = [...state.folders, { name, color: "#746A75" }];
    emitSavedRunsChanged();
  }
  apiJsonOrNull<{ folder?: FolderEntry }>("/api/saved-runs/folders", jsonInit("POST", { name }))
    .then(data => {
      if (data?.folder) {
        state.folders = state.folders.map(f => f.name === data.folder!.name ? { name: data.folder!.name, color: data.folder!.color } : f);
        emitSavedRunsChanged();
      }
    })
    .catch(() => {});
}

export function removeFolder(name: string) {
  state.folders = state.folders.filter(f => f.name !== name);
  state.events = state.events.map(e => e.folder === name ? { ...e, folder: undefined } : e);
  emitSavedRunsChanged();
  apiJsonOrNull(`/api/saved-runs/folders/${encodeURIComponent(name)}`, jsonInit("DELETE")).catch(() => {});
}

export function saveEvent(event: SavedEvent) {
  if (state.events.some(e => e.id === event.id)) return;
  state.events = [event, ...state.events];
  if (event.folder && !state.folders.some(f => f.name === event.folder)) {
    state.folders = [...state.folders, { name: event.folder, color: "#746A75" }];
  }
  emitSavedRunsChanged();
  apiJsonOrNull(`/api/saved-runs/events/${encodeURIComponent(event.id)}`, jsonInit("PUT", event))
    .then(() => loadFromServer().then(emitSavedRunsChanged))
    .catch(() => {});
}

export function removeSavedEvent(id: string) {
  state.events = state.events.filter(e => e.id !== id);
  emitSavedRunsChanged();
  apiJsonOrNull(`/api/saved-runs/events/${encodeURIComponent(id)}`, jsonInit("DELETE")).catch(() => {});
  apiJsonOrNull(`/api/saved-runs/cache/${encodeURIComponent(id)}`, jsonInit("DELETE")).catch(() => {});
}

/** Runs `work` over `items` with at most `limit` in flight, keeping results in input order. */
export async function mapLimited<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      signal?.throwIfAborted();
      const index = next++;
      results[index] = await work(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Removes each bookmark on the server and only then locally; throws with a count when any removal fails. */
export async function removeSavedEvents(ids: readonly string[]): Promise<void> {
  const outcomes = await mapLimited(ids, 4, id =>
    apiJson(`/api/saved-runs/events/${encodeURIComponent(id)}`, jsonInit("DELETE")).then(() => true, () => false));
  const removed = new Set(ids.filter((_, index) => outcomes[index]));
  state.events = state.events.filter(event => !removed.has(event.id));
  emitSavedRunsChanged();
  await loadFromServer();
  emitSavedRunsChanged();
  const failed = ids.length - removed.size;
  if (failed > 0) {
    throw new Error(`${failed} of ${ids.length} saved ${ids.length === 1 ? "run" : "runs"} could not be removed. They are still saved; try again.`);
  }
}

export function updateSavedEvent(id: string, patch: Partial<SavedEvent>) {
  const idx = state.events.findIndex(e => e.id === id);
  if (idx === -1) return;
  state.events = state.events.map((event, index) => index === idx ? { ...event, ...patch } : event);
  if (patch.folder && !state.folders.some(f => f.name === patch.folder)) {
    state.folders = [...state.folders, { name: patch.folder, color: "#746A75" }];
  }
  emitSavedRunsChanged();
  const serverPatch: Record<string, unknown> = { ...patch };
  if (Object.prototype.hasOwnProperty.call(patch, "folder") && patch.folder == null) {
    serverPatch.folder = null;
  }
  apiJsonOrNull(`/api/saved-runs/events/${encodeURIComponent(id)}`, jsonInit("PATCH", serverPatch))
    .then(() => loadFromServer().then(emitSavedRunsChanged))
    .catch(() => {});
}

export function moveSavedEventToFolder(id: string, folder: string | undefined) {
  updateSavedEvent(id, { folder });
}

export function isEventSaved(id: string): boolean {
  if (!state.loaded) ensureSavedRunsLoaded().catch(() => {});
  return state.events.some(e => e.id === id);
}

export type SummarySource = "local" | "provider";
export function savedSummarySource(event: SavedEvent): SummarySource | null {
  const source = event.properties?.summary_source;
  return source === "local" || source === "provider" ? source : null;
}

/** The deterministic summary written on this machine, kept after a provider summary replaces it. */
export function savedLocalSummary(event: SavedEvent): string | null {
  const kept = event.properties?.local_summary;
  if (typeof kept === "string" && kept.trim()) return kept;
  return savedSummarySource(event) === "local" && event.summary ? event.summary : null;
}

/** Exactly what a provider summary sends, after the same scrub and cap the daemon applies; shown before the user confirms. */
export function providerSummaryContent(event: SavedEvent): string {
  const max = PROVIDER_SUMMARY.maxFieldChars;
  const steps = savedLocalSummary(event);
  const content = [
    `Event: ${event.event_name}`,
    steps ? `Recorded steps: ${steps}` : null,
    event.user_input ? `User: ${event.user_input.slice(0, max)}` : null,
    event.assistant_output ? `Assistant: ${event.assistant_output.slice(0, max)}` : null,
    event.signals?.length ? `Signals: ${event.signals.map(s => s.name).join(", ")}` : null,
  ].filter(Boolean).join("\n\n");
  return scrubSecretText(content).slice(0, PROVIDER_SUMMARY.maxContentChars);
}

/** Sends the run excerpt to the provider only after the user confirmed in the UI. */
export async function requestProviderSummary(event: SavedEvent): Promise<ProviderSummaryResult> {
  const content = providerSummaryContent(event);
  const consent: ProviderSummaryConsent = { provider: PROVIDER_SUMMARY.provider, model: PROVIDER_SUMMARY.model };
  const result = await apiJson<ProviderSummaryResult>("/api/summarize", jsonInit("POST", { content, consent }));
  if (result.summary) {
    const localSummary = savedLocalSummary(event);
    updateSavedEvent(event.id, { summary: result.summary, properties: { ...event.properties, summary_source: "provider", ...(localSummary ? { local_summary: localSummary } : {}) } });
  }
  return result;
}

export async function setLocalRunCache(id: string, data: {
  run: Run;
  spans: Span[];
  liveEvents?: LiveEvent[];
  subAgents?: SubAgent[];
}): Promise<void> {
  await apiJsonOrNull(`/api/saved-runs/cache/${encodeURIComponent(id)}`, jsonInit("PUT", {
    type: "local",
    run: data.run,
    spans: data.spans,
    liveEvents: data.liveEvents,
    subAgents: data.subAgents,
  })).catch(() => null);
}

export function getSavedAnnotationPreview(event: SavedEvent): SavedAnnotationPreview | null {
  const parsed = savedAnnotationPreviewSchema.safeParse(event.properties?.annotation_preview);
  return parsed.success ? parsed.data : null;
}

export function annotationKindLabel(kind: SavedAnnotationPreview["kind"]): string {
  if (kind === "issue") return "Issue";
  if (kind === "good") return "Good";
  return "Note";
}

ensureSavedRunsLoaded().catch(() => {});
