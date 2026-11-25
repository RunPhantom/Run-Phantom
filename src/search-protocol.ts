export const SEARCH_FILTER_LIMITS = { clauses: 12, bytes: 8192, valueChars: 256, valueBytes: 512, attributeBytes: 65536, tags: 64 } as const;
export const SEARCH_FILTER_FIELDS = ["status", "model", "provider", "duration_ms", "captured_cost_usd", "tag"] as const;
export type SearchFilterField = typeof SEARCH_FILTER_FIELDS[number];
export type SearchFilterOperator = "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
export interface SearchFilterClause { field: SearchFilterField; op: SearchFilterOperator; value: string | number }
export interface SearchFilter { version: 1; all: SearchFilterClause[] }
export interface SearchSnippet { state: "available" | "unavailable"; text: string; highlights: Array<{ start: number; end: number }>; truncated: boolean }
export interface SearchSpanHit { runId: string; spanId: string; name: string; input: SearchSnippet; output: SearchSnippet }
export interface SearchHitPage { items: SearchSpanHit[]; nextCursor: string | null; hasMore: boolean; elapsedMs: number }
export interface SearchSuggestionResult { values: string[]; hasMore: boolean }
/** Why a run matched a text query. `error` and `failed_span` come from spans whose status is ERROR. */
export type RunSearchMatchField = "error" | "failed_span" | "span_name" | "model" | "provider" | "output" | "input" | "run" | "metadata";
export interface RunSearchMatch { field: RunSearchMatchField; span_id: string | null; span_name: string | null; snippet: SearchSnippet }
