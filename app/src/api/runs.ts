import { apiJson, apiJsonOrNull, jsonInit } from "./request";
import type { LiveEvent, Run, Span, SubAgent } from "../utils/types";
import type { RunSearchMatch, SearchHitPage, SearchSuggestionResult } from "../../../src/search-protocol";
export type { RunSearchMatch, SearchHitPage } from "../../../src/search-protocol";

export interface RunDetailData {
  run: Run;
  spans: Span[];
  liveEvents?: LiveEvent[];
  subAgents?: SubAgent[];
}

export interface NormalizedRunDetailData {
  run: Run;
  spans: Span[];
  liveEvents: LiveEvent[];
  subAgents: SubAgent[];
}

export async function listRuns(): Promise<Run[]> {
  return apiJson<Run[]>("/api/runs");
}

/** A GET /api/runs row with the per-run facts (contract: runs-api.md). Unknown values are null, never 0. */
export interface RunListRow extends Run {
  agent: string | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  est_cost_usd: number | null;
  cost_source: "reported" | "estimated" | "unknown";
  tool_count: number;
  primary_model: string | null;
  provider: string | null;
  models: string[];
  input_preview: string | null;
  llm_calls: number;
  known_input_tokens: number | null;
  known_output_tokens: number | null;
  token_unknown_calls: number;
  known_cost_usd: number | null;
  known_cost_source: "reported" | "estimated" | "mixed" | null;
  cost_unknown_calls: number;
  /** Client-only: the row came from search and its run-list facts could not be loaded, so every fact is unknown. */
  facts_unavailable?: true;
}

export interface RunListPage {
  runs: RunListRow[];
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export async function listRunsPage(query: Record<string, string>, signal?: AbortSignal): Promise<RunListPage> {
  const params = new URLSearchParams(query);
  params.set("envelope", "1");
  const page = await apiJson<RunListPage>(`/api/runs?${params}`, { signal, cache: "no-store" });
  if (!page || !Array.isArray(page.runs)) throw new Error("Run list response was not a page");
  return page;
}

/** GET /api/runs/facets: the Runs table's filter choices over every run. */
export interface RunFacets {
  agents: string[];
  models: string[];
  hasOwnRuns: boolean;
}

export async function getRunFacets(signal?: AbortSignal): Promise<RunFacets> {
  return apiJson<RunFacets>("/api/runs/facets", { signal, cache: "no-store" });
}

/** Encoded `ids=` bytes per request, well under the 16 KiB request-header limit of Node's HTTP server. */
const IDS_URL_BUDGET = 6_000;
const IDS_PER_REQUEST = 100;

/**
 * The run-list rows for exactly these run ids, keyed by id. Ids are sent as repeated `ids` params (they may hold
 * commas) and split across requests to keep each URL short. Runs that no longer exist are absent from the map.
 */
export async function lookupRunFacts(ids: readonly string[], signal?: AbortSignal): Promise<Map<string, RunListRow>> {
  const unique = [...new Set(ids)];
  const batches: string[][] = [];
  let batch: string[] = [], size = 0;
  for (const id of unique) {
    const cost = encodeURIComponent(id).length + 5;
    if (batch.length && (size + cost > IDS_URL_BUDGET || batch.length >= IDS_PER_REQUEST)) { batches.push(batch); batch = []; size = 0; }
    batch.push(id);
    size += cost;
  }
  if (batch.length) batches.push(batch);
  const pages = await Promise.all(batches.map(group => {
    const params = new URLSearchParams([["envelope", "1"], ["limit", String(IDS_PER_REQUEST)], ...group.map(id => ["ids", id] as [string, string])]);
    return apiJson<RunListPage>(`/api/runs?${params}`, { signal, cache: "no-store" });
  }));
  const rows = new Map<string, RunListRow>();
  for (const page of pages) {
    if (!page || !Array.isArray(page.runs)) throw new Error("Run list response was not a page");
    for (const row of page.runs) rows.set(row.id, row);
  }
  return rows;
}

/** A search row whose run-list facts could not be loaded: the run's own fields, every fact unknown. */
export function runWithoutFacts(run: Run): RunListRow {
  return {
    ...run, agent: null, duration_ms: null, input_tokens: null, output_tokens: null, est_cost_usd: null, cost_source: "unknown",
    tool_count: 0, primary_model: null, provider: null, models: [], input_preview: null, llm_calls: 0,
    known_input_tokens: null, known_output_tokens: null, token_unknown_calls: 0, known_cost_usd: null, known_cost_source: null, cost_unknown_calls: 0,
    facts_unavailable: true,
  };
}

export interface RunSearchOptions {
  q?: string;
  status?: string;
  model?: string;
  provider?: string;
  limit?: number;
  cursor?: string;
  filter?: string;
}

export type RunSearchRun = Run & { match?: RunSearchMatch | null; matched_span_count?: number | null };

export interface RunSearchResult {
  runs: RunSearchRun[];
  nextCursor: string | null;
  hasMore: boolean;
  elapsedMs: number;
}

export async function searchRuns(options: RunSearchOptions, signal?: AbortSignal): Promise<RunSearchResult> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  return apiJson<RunSearchResult>(`/api/runs/search?${params}`, { signal });
}
export function searchSpanHits(options:RunSearchOptions,signal?:AbortSignal):Promise<SearchHitPage> {const params=new URLSearchParams();for(const[key,value]of Object.entries(options))if(value!==undefined&&value!=="")params.set(key,String(value));return apiJson(`/api/runs/search-hits?${params}`,{signal});}
export function searchSuggestions(field:"model"|"provider"|"tag",prefix:string,signal:AbortSignal):Promise<SearchSuggestionResult> {return apiJson(`/api/runs/search-suggestions?${new URLSearchParams({field,prefix})}`,{signal});}
export function getSearchScope(resource:"runs"|"span-hits",signal:AbortSignal):Promise<{scope:string}> {return apiJson(`/api/runs/search-scope?${new URLSearchParams({resource})}`,{signal});}

export async function getRunDetail(runId: string, signal?: AbortSignal): Promise<RunDetailData> {
  return apiJson<RunDetailData>(`/api/runs/detail/${encodeURIComponent(runId)}`, { signal });
}

/** The run row alone, without span payloads; null when the run does not exist. */
export async function getRunRow(runId: string, signal?: AbortSignal): Promise<Run | null> {
  const outline = await apiJsonOrNull<{ run: Run | null }>(`/api/runs/${encodeURIComponent(runId)}/outline?payload_preview_chars=0`, { signal });
  return outline?.run ?? null;
}

export async function getRunDetailOrNull(runId: string): Promise<RunDetailData | null> {
  return apiJsonOrNull<RunDetailData>(`/api/runs/detail/${encodeURIComponent(runId)}`);
}

export async function listConversationRuns(convoId: string, signal?: AbortSignal): Promise<Run[]> {
  return apiJson<Run[]>(`/api/convo/${encodeURIComponent(convoId)}`, { signal });
}

export async function deleteRun(runId: string): Promise<void> {
  await apiJson(`/api/runs/${encodeURIComponent(runId)}`, jsonInit("DELETE"));
}

export async function renameRun(runId: string, name: string): Promise<void> {
  await apiJson(`/api/runs/${encodeURIComponent(runId)}`, jsonInit("PATCH", { name }));
}

export async function clearRuns(): Promise<void> {
  await apiJson("/api/clear", jsonInit("POST"));
}

export function normalizeRunDetail(detail: RunDetailData): NormalizedRunDetailData {
  return {
    run: detail.run,
    spans: detail.spans,
    liveEvents: detail.liveEvents ?? [],
    subAgents: detail.subAgents ?? [],
  };
}
