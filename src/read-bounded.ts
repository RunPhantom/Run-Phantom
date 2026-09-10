import fs from "fs";

// Claude/Codex session logs are append-only JSONL that grow without bound: an
// active project routinely holds multi-gigabyte transcripts with individual
// files over 64MB. Reading them whole and synchronously inside an HTTP handler
// stalls that request for seconds, which is long enough to exhaust the
// browser's per-origin connection pool and leave the UI stuck on its loading
// state while unrelated requests queue behind it.
//
// Files above this size are skipped rather than truncated: these parsers read
// identity fields (session id, cwd) from a header record at the top of the file
// and the newest records from the bottom, so a partial read would silently
// produce a wrong result instead of an obviously absent one.
export const MAX_SESSION_FILE_BYTES = 8 * 1024 * 1024;

/** Read a session file, or return null if it is missing or too large to parse cheaply. */
export function readSessionFileSync(
  filePath: string,
  maxBytes = MAX_SESSION_FILE_BYTES,
): string | null {
  try {
    if (fs.statSync(filePath).size > maxBytes) return null;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Sort paths newest-first. Callers previously called statSync inside the
 * comparator, which is O(n log n) syscalls — ~10k stats for a 1k-file store.
 */
export function sortByMtimeDesc(files: string[]): string[] {
  const mtimes = new Map<string, number>();
  for (const file of files) {
    try {
      mtimes.set(file, fs.statSync(file).mtimeMs);
    } catch {
      mtimes.set(file, 0);
    }
  }
  return [...files].sort((a, b) => (mtimes.get(b) ?? 0) - (mtimes.get(a) ?? 0));
}
