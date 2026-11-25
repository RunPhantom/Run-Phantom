const KEY = "runphantom:runs-table:last-search";

/** The table's query string, so the run rail and "Back to runs" keep the reader's filters after opening a run. */
export function rememberRunsSearch(search: string): void {
  try { sessionStorage.setItem(KEY, search.replace(/^\?/, "")); } catch {}
}

export function lastRunsSearch(): string {
  try { return sessionStorage.getItem(KEY) ?? ""; } catch { return ""; }
}

export function runsTablePath(): string {
  const search = lastRunsSearch();
  return search ? `/runs?${search}` : "/runs";
}
