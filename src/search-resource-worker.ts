export interface SearchResourceWork {
  dbPath: string; sql: string; params: (string | number)[]; limit: number;
  mode: "hits" | "suggestions"; key: string; deadline: number; cancellation: SharedArrayBuffer;
  project?: { id: string; bytes: number; runs: number; spans: number };
}
export interface RawSearchHit { runId: string; spanId: string; startedAt: number | null; name: string | null; input: string | null; output: string | null }
export interface RawSearchResource { items: RawSearchHit[]; values: string[]; nextCursor: string | null; hasMore: boolean }

// No filesystem imports: this source is embedded in copied executables too.
export async function searchResourceWorker(): Promise<void> {
  const { parentPort, workerData } = await import("node:worker_threads");
  const { Database } = await import("bun:sqlite");
  const work = workerData as SearchResourceWork, cancel = new Int32Array(work.cancellation);
  let db: InstanceType<typeof Database> | undefined;
  let message: { ok: boolean; result?: RawSearchResource; code?: string };
  const check = () => { if (Atomics.load(cancel, 0) || Date.now() >= work.deadline) throw new Error("deadline"); };
  const cursor = (row: RawSearchHit) => {
    const value = Buffer.from(JSON.stringify({ v: 1, k: work.key, a: [row.startedAt, row.runId, row.spanId] })).toString("base64url");
    if (value.length > 4096) throw new Error("size");
    return value;
  };
  try {
    check(); db = new Database(work.dbPath, { readonly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;");
    if (work.project) {
      const p = db.query("SELECT evidence_bytes,run_count,span_count FROM projects WHERE id=?").get(work.project.id) as { evidence_bytes: number; run_count: number; span_count: number } | null;
      if (!p || p.evidence_bytes > work.project.bytes || p.run_count > work.project.runs || p.span_count > work.project.spans) throw new Error("quota");
    }
    const result: RawSearchResource = { items: [], values: [], nextCursor: null, hasMore: false };
    for (const value of db.query(work.sql).iterate(...work.params)) {
      check();
      if (result.items.length + result.values.length === work.limit) { result.hasMore = true; break; }
      if (work.mode === "suggestions") {
        const row = value as { value: string };
        if (typeof row.value !== "string" || Buffer.byteLength(row.value) > 512) throw new Error("size");
        if (Buffer.byteLength(JSON.stringify({ ...result, values: [...result.values, row.value] })) > 16_000) { result.hasMore = true; break; }
        result.values.push(row.value);
      } else {
        const row = value as RawSearchHit;
        if (!row.runId || !row.spanId || Buffer.byteLength(row.runId) > 1024 || Buffer.byteLength(row.spanId) > 1024 || row.runId.includes("\0") || row.spanId.includes("\0") || row.startedAt !== null && !Number.isFinite(row.startedAt)) throw new Error("size");
        const candidate = { ...result, items: [...result.items, row], nextCursor: cursor(row), hasMore: true };
        // Every selected string and envelope byte is accounted before transport.
        if (Buffer.byteLength(JSON.stringify(candidate)) > 119_936) {
          if (!result.items.length) throw new Error("size");
          result.hasMore = true; break;
        }
        result.items.push(row);
      }
    }
    check();
    if (result.hasMore && result.items.length) result.nextCursor = cursor(result.items[result.items.length - 1]);
    message = { ok: true, result };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "query";
    message = { ok: false, code: reason === "quota" ? "quota_exceeded" : reason === "size" ? "too_large" : Atomics.load(cancel, 0) || Date.now() >= work.deadline ? "query_timeout" : "internal_error" };
  } finally { db?.close(); }
  parentPort!.postMessage(message); parentPort!.close();
}
