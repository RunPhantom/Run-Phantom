import { getDbPath } from "./db";
import { searchSpanHits as sharedSpanHits, searchSuggestions as sharedSuggestions, localSearchScope as sharedScope, type SearchResourceOptions } from "./search-resources";

export { SearchResourceError } from "./search-resources";
export type { SearchSnippet, SearchSpanHit, SearchHitPage, SearchSuggestionResult } from "./search-resources";
export type LocalSearchResourceOptions = Omit<SearchResourceOptions, "dbPath"> & { dbPath?: string };

/** Local defaults remain outside the private Team runtime's import graph. */
export async function searchSpanHits(value: unknown = {}, options: LocalSearchResourceOptions = {}) {
  return sharedSpanHits(value, { ...options, dbPath: options.dbPath ?? getDbPath() });
}
export async function searchSuggestions(value: unknown = {}, options: LocalSearchResourceOptions = {}) {
  return sharedSuggestions(value, { ...options, dbPath: options.dbPath ?? getDbPath() });
}
export function localSearchScope(resource: "runs" | "span-hits", dbPath = getDbPath()): string {
  return sharedScope(resource, dbPath);
}
