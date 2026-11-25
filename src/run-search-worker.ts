import type { RunSearchResult, RunSearchSummary } from "./run-search";

export interface RunSearchWork {
  dbPath: string;
  sql: string;
  params: (string | number)[];
  limit: number;
  maxBytes: number;
  started: number;
  deadline: number;
  cancellation: SharedArrayBuffer;
  cursorKey?: string;
  /** Rows carry `match_rank` (kept in the cursor) and a raw `match_json` window replaced by the caller. */
  ranked: boolean;
  matchBytes: number;
  /**
   * rootAgentHintsSql with `agentIdsMarker` for its id list. Each row gains
   * `agent_roots`, which the caller replaces with `agent`: one of those hint
   * values, the event name or the run name.
   */
  agentSql: string;
  agentIdsMarker: string;
}

// Keep this function self-contained: its compiled JavaScript is also the worker
// source in packaged binaries, which have no loose TypeScript worker files.
export async function runSearchWorker(): Promise<void> {
  const { parentPort, workerData } = await import("node:worker_threads");
  const { Database } = await import("bun:sqlite");
  const work = workerData as RunSearchWork;
  const cancellation = new Int32Array(work.cancellation);
  let db: InstanceType<typeof Database> | undefined;
  let response: { ok: true; result: RunSearchResult } | { ok: false; code: string; error: string };
  const checkDeadline = () => {
    if (Atomics.load(cancellation, 0)) throw new Error("Search cancelled");
    if (Date.now() >= work.deadline) throw new Error("Search timed out; narrow the query or filters");
  };
  const ranks = new Map<string, number>();
  const cursorFor = (row: RunSearchSummary) => {
    const cursor = Buffer.from(JSON.stringify({ v: work.cursorKey ? 2 : 1, startedAt: row.started_at, id: row.id, ...(work.cursorKey ? { key: work.cursorKey } : {}), ...(work.ranked ? { rank: ranks.get(row.id) ?? 0 } : {}) })).toString("base64url");
    if (cursor.length > 4096) throw new Error("Run identity exceeds the search cursor byte limit");
    return cursor;
  };
  try {
    checkDeadline();
    db = new Database(work.dbPath);
    db.exec("PRAGMA query_only = ON");
    const runs: RunSearchSummary[] = [];
    const sizes: number[] = [];
    let hasMore = false;
    for (const value of db.query(work.sql).iterate(...work.params)) {
      checkDeadline();
      const { match_rank: rank, ...row } = value as RunSearchSummary & { match_rank?: number; match_json?: string | null };
      if (runs.length === work.limit) { hasMore = true; break; }
      if (!row.id || row.id.length > 1024 || row.id.includes("\0") || !Number.isFinite(row.started_at)) throw new Error("Run identity cannot be represented by a search cursor");
      if (work.ranked) ranks.set(row.id, Number(rank) || 0);
      const candidate: RunSearchResult = { runs: [...runs, row], nextCursor: cursorFor(row), hasMore: true, elapsedMs: Date.now() - work.started };
      // The raw match window is replaced by a match object of at most matchBytes.
      const size = Buffer.byteLength(JSON.stringify(candidate, (key, item) => key === "match_json" ? undefined : item), "utf8") + (work.ranked ? (runs.length + 1) * work.matchBytes : 0);
      if (size > work.maxBytes - 32) {
        if (!runs.length) throw new Error("A run summary exceeds the search response byte limit");
        hasMore = true;
        break;
      }
      runs.push(row);
      sizes.push(size);
    }
    checkDeadline();
    if (runs.length) {
      const roots = new Map<string, Record<string, unknown>[]>(runs.map(run => [run.id, []]));
      for (const hint of db.query(work.agentSql.replace(work.agentIdsMarker, runs.map(() => "?").join(","))).all(...runs.map(run => run.id)) as Record<string, unknown>[]) roots.get(String(hint.run_id))?.push(hint);
      let agentBytes = 0;
      for (const [index, run] of runs.entries()) {
        const hints = roots.get(run.id)!;
        const candidates = [run.event_name, run.name, ...hints.flatMap(hint => Object.entries(hint).filter(([key]) => key !== "run_id").map(([, value]) => value))];
        agentBytes += Math.max(4, ...candidates.map(value => typeof value === "string" ? Buffer.byteLength(JSON.stringify(value), "utf8") : 4)) + 10;
        if (sizes[index] + agentBytes > work.maxBytes - 32) {
          if (!index) throw new Error("A run summary exceeds the search response byte limit");
          runs.length = index;
          hasMore = true;
          break;
        }
        (run as typeof run & { agent_roots?: unknown[] }).agent_roots = hints;
      }
    }
    checkDeadline();
    const result = { runs, nextCursor: hasMore && runs.length ? cursorFor(runs[runs.length - 1]) : null, hasMore, elapsedMs: Date.now() - work.started };
    response = { ok: true, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Search failed";
    const code = Atomics.load(cancellation, 0) ? "cancelled" : Date.now() >= work.deadline ? "timeout" : "query_failed";
    response = { ok: false, code, error: code === "timeout" ? "Search timed out; narrow the query or filters" : message.slice(0, 512) };
  } finally {
    db?.close();
  }
  // Completion is acknowledged only after SQLite releases its handle. Callers
  // that hit their deadline still occupy capacity until this point or exit.
  parentPort!.postMessage(response);
  parentPort!.close();
}
