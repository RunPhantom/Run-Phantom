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
  cost_unknown_calls: number;
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
