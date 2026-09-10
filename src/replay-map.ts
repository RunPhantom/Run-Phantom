// replayRunId -> OTLP traceId. The ingest handler records the mapping when a
// span carries a `replayRunId`; the replay system reads it instead of guessing
// by event-name + timestamp.

// Bounded because nothing ever removed an entry: a long-lived daemon that runs
// replays accumulates one string pair per replay for the life of the process.
// Entries are only read during the stitch poll right after a replay starts, so
// evicting the oldest costs nothing — and a miss still falls back to
// findRunByEventId against the database.
const MAX_ENTRIES = 1000;

const replayRunToTraceId = new Map<string, string>();

export function setReplayTrace(replayRunId: string, traceId: string): void {
  replayRunToTraceId.delete(replayRunId);
  replayRunToTraceId.set(replayRunId, traceId);
  while (replayRunToTraceId.size > MAX_ENTRIES) {
    const oldest = replayRunToTraceId.keys().next();
    if (oldest.done) break;
    replayRunToTraceId.delete(oldest.value);
  }
}

export function getReplayTrace(replayRunId: string): string | undefined {
  return replayRunToTraceId.get(replayRunId);
}

export function _replayTraceMapSize(): number {
  return replayRunToTraceId.size;
}
