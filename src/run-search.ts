import { Worker } from "node:worker_threads";
import { acquireSearchCapacity, searchCapacity } from "./search-capacity";
import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { getDbPath } from "./db";
import { runSearchWorker, type RunSearchWork } from "./run-search-worker";
import { deriveRunAgent, hintsFromRows, rootAgentHintsSql, type RootAgentHintRow } from "./run-agent";
import { compileSearchFilter, parseSearchFilter, SearchFilterError, type SearchFilter } from "./search-filter";
import { hasDuplicateJsonKeys } from "./json-keys";
import type { RunStatus } from "./run-status";
import { RUN_STATUS_FILTER_VALUES, errorCountSql, runStatusFilterSql, runStatusSql } from "./run-status-sql";
import { redactTeamText } from "./team/ingest";
import type { RunSearchMatch, RunSearchMatchField, SearchSnippet } from "./search-protocol";

export const RUN_SEARCH_LIMITS = { queryChars: 256, pageSize: 100, responseBytes: 120_000, timeoutMs: 5_000, workers: 2 } as const;
/** A shared RunStatus, or the `running` (live or quiet) and `completed` (with or without errors) groups. */
export type RunSearchStatus = RunStatus | "running" | "completed";
export interface RunSearchSummary {
  id: string;
  name: string | null;
  event_name: string | null;
  /** deriveRunAgent (src/run-agent.ts), the rule the run list and overview use. */
  agent: string | null;
  display_name: string | null;
  user_id: string | null;
  convo_id: string | null;
  started_at: number;
  last_updated_at: number;
  metadata: null;
  model: string | null;
  provider: string | null;
  /** The same status deriveRunStatus gives this run, computed in SQL. */
  status: RunStatus;
  replay_outcome: "failed" | "cancelled" | null;
  finished: number;
  error_count: number;
  tool_error_count: number;
  /** 1 when the span standing for the run errored; see rootFailed in run-status.ts. */
  root_failed: number;
  span_count: number;
  live_event_count: number;
  /** Best match for a text query; null without a query. */
  match: RunSearchMatch | null;
  /** Spans whose captured text, name, model, provider or failure matched; null without a query. */
  matched_span_count: number | null;
}
export interface RunSearchResult { runs: RunSearchSummary[]; nextCursor: string | null; hasMore: boolean; elapsedMs: number }
interface SearchCursor { v: 1 | 2; startedAt: number; id: string; key?: string; rank?: number }
interface SearchInput { q: string; status?: RunSearchStatus; model: string; provider: string; limit: number; cursor?: SearchCursor; filter?: SearchFilter; cursorKey?: string }
interface ExecutionOptions { signal?: AbortSignal; dbPath?: string; timeoutMs?: number; maxBytes?: number }

export class RunSearchError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number) { super(message); this.name = "RunSearchError"; }
}
const invalid = (message: string): never => { throw new RunSearchError(message, "invalid_search", 400); };

function parseInput(value: unknown, dbPath: string): SearchInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("Search parameters must be an object");
  const input = value as Record<string, unknown>;
  const field = (key: string, max: number = RUN_SEARCH_LIMITS.queryChars): string => {
    const raw = input[key];
    if (raw === undefined) return "";
    if (typeof raw !== "string" || raw.length > max || raw.includes("\0")) return invalid(`${key} must be a string of at most ${max} characters without null bytes`);
    return raw;
  };
  const q = field("q");
  const model = field("model");
  const provider = field("provider");
  const rawStatus = field("status");
  if (rawStatus && rawStatus !== "all" && !RUN_STATUS_FILTER_VALUES.includes(rawStatus)) return invalid(`status must be all or one of ${RUN_STATUS_FILTER_VALUES.join(", ")}`);
  let filter: SearchFilter | undefined, cursorKey: string | undefined;
  if (input.filter !== undefined) {
    try {
      const typed = parseSearchFilter(input.filter);
      const legacy = [
        ...(model ? [{ field: "model", op: "eq", value: model }] : []),
        ...(provider ? [{ field: "provider", op: "eq", value: provider }] : []),
        ...(rawStatus && rawStatus !== "all" ? [{ field: "status", op: "eq", value: rawStatus }] : []),
      ];
      filter = parseSearchFilter({ version: 1, all: [...typed.all, ...legacy] });
      cursorKey = createHash("sha256").update(JSON.stringify([dbPath, "runs", q, filter])).digest("hex");
    } catch (error) { if (error instanceof SearchFilterError) return invalid(error.message); throw error; }
  }
  const rawLimit = input.limit === undefined ? 50 : input.limit;
  if ((typeof rawLimit !== "string" && typeof rawLimit !== "number") || rawLimit === "" || !Number.isInteger(Number(rawLimit)) || Number(rawLimit) < 1 || Number(rawLimit) > RUN_SEARCH_LIMITS.pageSize) return invalid("limit must be an integer from 1 to 100");
  const encoded = field("cursor", 4096);
  let cursor: SearchCursor | undefined;
  if (encoded) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
      const raw = Buffer.from(encoded, "base64url").toString("utf8");
      if (Buffer.from(raw).toString("base64url") !== encoded) throw new Error();
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || hasDuplicateJsonKeys(raw)) throw new Error();
      const c = parsed as Record<string, unknown>;
      const keys = [...(cursorKey ? ["v", "startedAt", "id", "key"] : ["v", "startedAt", "id"]), ...(q ? ["rank"] : [])];
      if (Object.keys(c).length !== keys.length || Object.keys(c).some(key => !keys.includes(key)) || c.v !== (cursorKey ? 2 : 1) || (cursorKey && c.key !== cursorKey) || typeof c.startedAt !== "number" || !Number.isFinite(c.startedAt) || typeof c.id !== "string" || !c.id || c.id.length > 1024 || c.id.includes("\0")) throw new Error();
      if (q && (typeof c.rank !== "number" || !Number.isSafeInteger(c.rank) || c.rank < 0)) throw new Error();
      cursor = { v: cursorKey ? 2 : 1, startedAt: c.startedAt as number, id: c.id, ...(cursorKey ? { key: cursorKey } : {}), ...(q ? { rank: c.rank as number } : {}) };
    } catch { return invalid("Invalid search cursor; refresh the results"); }
  }
  return { q, model, provider, status: rawStatus && rawStatus !== "all" ? rawStatus as RunSearchStatus : undefined, limit: Number(rawLimit), cursor, filter, cursorKey };
}

// Whole-query words that also mean "show me what failed": an errored span
// rarely contains the literal word "error" (demo `run_tests` reports "FAIL …").
const FAILURE_TERMS = new Set(["error", "errors", "errored", "fail", "fails", "failed", "failure", "failures", "failing", "exception", "exceptions"]);
export function isFailureQuery(q: string): boolean { return FAILURE_TERMS.has(q.trim().toLowerCase()); }

// Same keys and precedence as the run outline's error reason (db.ts getRunOutline).
const ERROR_TEXT = `CASE WHEN s.status = 'ERROR' AND json_valid(s.attributes) THEN CAST(COALESCE(
  json_extract(s.attributes, '$."error.message"'), json_extract(s.attributes, '$."ai.response.error"'),
  json_extract(s.attributes, '$."exception.message"'), json_extract(s.attributes, '$."otel.status.message"')) AS TEXT) END`;
// SQL NULL would make the whole rank expression NULL; a missing column simply does not match.
const has = (column: string) => `COALESCE(instr(lower(${column}), n.q), 0) > 0`;
const RUN_TEXT = ["r.id", "r.name", "r.event_id", "r.event_name", "r.display_name", "r.user_id", "r.convo_id", "r.metadata"];
const SPAN_MATCH = `(${["s.name", "s.input_payload", "s.output_payload", "s.model", "s.provider"].map(has).join(" OR ")}
  OR (s.status = 'ERROR' AND (n.failure = 1 OR ${has(ERROR_TEXT)})))`;
// One pass over a run's matching spans: count << 2 | failure hit << 1 | name/tool/model hit.
// Both flags imply SPAN_MATCH, so ranking needs no second scan of the spans. The
// candidates CTE is materialized because SQLite re-evaluates a flattened
// correlated subquery at every reference to its column.
const flag = (condition: string) => `COALESCE(max(CASE WHEN ${condition} THEN 1 ELSE 0 END), 0)`;
const SPAN_FLAGS = `SELECT COUNT(*) * 4 + ${flag(`s.status = 'ERROR' AND (n.failure = 1 OR ${has(ERROR_TEXT)})`)} * 2
  + ${flag(["s.name", "s.model", "s.provider"].map(has).join(" OR "))} FROM spans s WHERE s.run_id = r.id AND ${SPAN_MATCH}`;
// The window keeps 320 characters either side of the snippet so a credential
// cut at the window edge is never inside the final, re-scrubbed excerpt.
export const RUN_MATCH_WINDOW = { before: 400, length: 1200 } as const;
const MATCH_PRIORITY = ["error", "failed_span", "span_name", "model", "provider", "output", "input"] as const satisfies readonly RunSearchMatchField[];
const MATCH_SQL = `(SELECT json_object('field', b.field, 'spanId', b.id, 'spanName', substr(b.name, 1, 256), 'start', b.start,
    'text', substr(b.body, b.start, ${RUN_MATCH_WINDOW.length}), 'total', length(b.body))
  FROM (SELECT f.*, max(1, instr(lower(f.body), n.q) - ${RUN_MATCH_WINDOW.before}) AS start FROM (
    SELECT e.id, e.name, e.start_time_ms, e.field, CASE e.field
      WHEN 'error' THEN e.err WHEN 'failed_span' THEN COALESCE(e.err, e.output_payload, '')
      WHEN 'span_name' THEN e.name WHEN 'model' THEN e.model WHEN 'provider' THEN e.provider
      WHEN 'output' THEN e.output_payload ELSE e.input_payload END AS body
    FROM (SELECT s.id, s.name, s.start_time_ms, s.model, s.provider, s.input_payload, s.output_payload, ${ERROR_TEXT} AS err,
      CASE WHEN s.status = 'ERROR' AND ${has(ERROR_TEXT)} THEN 'error' WHEN s.status = 'ERROR' AND n.failure = 1 THEN 'failed_span'
        WHEN ${has("s.name")} THEN 'span_name' WHEN ${has("s.model")} THEN 'model' WHEN ${has("s.provider")} THEN 'provider'
        WHEN ${has("s.output_payload")} THEN 'output' WHEN ${has("s.input_payload")} THEN 'input' END AS field
      FROM spans s WHERE s.run_id = r.id) e WHERE e.field IS NOT NULL) f) b
  ORDER BY CASE b.field ${MATCH_PRIORITY.map((field, index) => `WHEN '${field}' THEN ${index}`).join(" ")} END, b.start_time_ms, b.id LIMIT 1)`;
const RUN_MATCH_SQL = `CASE ${["r.name", "r.display_name", "r.event_name", "r.user_id", "r.convo_id", "r.event_id", "r.id"].map(column =>
  `WHEN ${has(column)} THEN json_object('field', 'run', 'start', max(1, instr(lower(${column}), n.q) - ${RUN_MATCH_WINDOW.before}), 'text', substr(${column}, max(1, instr(lower(${column}), n.q) - ${RUN_MATCH_WINDOW.before}), ${RUN_MATCH_WINDOW.length}), 'total', length(${column}))`).join(" ")}
  WHEN ${has("r.metadata")} THEN json_object('field', 'metadata') END`;

function buildQuery(input: SearchInput): { sql: string; params: (string | number)[]; ranked: boolean } {
  const params: (string | number)[] = [];
  const where = ["1 = 1"];
  if (input.filter) {
    const typed = compileSearchFilter(input.filter, "local");
    where.push(typed.sql); params.push(...typed.params);
  } else if (input.model || input.provider) {
    const match = [];
    if (input.model) { match.push("s.model = ?"); params.push(input.model); }
    if (input.provider) { match.push("s.provider = ?"); params.push(input.provider); }
    where.push(`EXISTS (SELECT 1 FROM spans s WHERE s.run_id = r.id AND ${match.join(" AND ")})`);
  }
  const derived = runStatusSql("r");
  if (!input.filter && input.status) {
    const match = runStatusFilterSql(derived.status, input.status, "eq");
    where.push(match.sql); params.push(...match.params);
  }
  const summary = (order: string, extra: string, from: string) => `SELECT r.id, ${["name", "event_name", "display_name", "user_id", "convo_id"].map(key => `substr(r.${key}, 1, 512) AS ${key}`).join(", ")},
      r.started_at, r.last_updated_at, NULL AS metadata,
      (SELECT substr(s.model, 1, 512) FROM spans s WHERE s.run_id = r.id AND s.model IS NOT NULL ORDER BY s.start_time_ms, s.id LIMIT 1) AS model,
      (SELECT substr(s.provider, 1, 512) FROM spans s WHERE s.run_id = r.id AND s.provider IS NOT NULL ORDER BY s.start_time_ms, s.id LIMIT 1) AS provider,
      ${derived.status} AS status,
      ${derived.replay} AS replay_outcome,
      ${derived.finished} AS finished,
      ${errorCountSql("r")} AS error_count,
      (SELECT COUNT(*) FROM spans s WHERE s.run_id = r.id AND s.status = 'ERROR' AND s.span_type = 'TOOL_CALL') AS tool_error_count,
      ${derived.rootFailed} AS root_failed,
      (SELECT COUNT(*) FROM spans s WHERE s.run_id = r.id) AS span_count,
      (SELECT COUNT(*) FROM live_events e WHERE e.trace_id = r.id) AS live_event_count${extra}
      FROM ${from} ORDER BY ${order}`;
  if (!input.q) {
    if (input.cursor) {
      where.push("(r.started_at < ? OR (r.started_at = ? AND r.id < ?))");
      params.push(input.cursor.startedAt, input.cursor.startedAt, input.cursor.id);
    }
    params.push(input.limit + 1);
    return { ranked: false, params, sql: `WITH matching AS MATERIALIZED (
      SELECT r.id FROM runs r WHERE ${where.join(" AND ")} ORDER BY r.started_at DESC, r.id DESC LIMIT ?
    ) ${summary("r.started_at DESC, r.id DESC", ", NULL AS match_json, NULL AS matched_span_count", "matching JOIN runs r ON r.id = matching.id")}` };
  }
  // Rank: a failure the query names, then a name/tool/model hit, then how many spans matched (capped at 9).
  const head: (string | number)[] = [input.q, isFailureQuery(input.q) ? 1 : 0];
  const tail: (string | number)[] = [];
  let cursor = "";
  if (input.cursor) {
    cursor = "WHERE (score < ? OR (score = ? AND (started_at < ? OR (started_at = ? AND id < ?))))";
    tail.push(input.cursor.rank!, input.cursor.rank!, input.cursor.startedAt, input.cursor.startedAt, input.cursor.id);
  }
  tail.push(input.limit + 1);
  return { ranked: true, params: [...head, ...params, ...tail], sql: `WITH n(q, failure) AS (SELECT lower(?), ?),
    candidates AS MATERIALIZED (
      SELECT r.id, r.started_at, (${RUN_TEXT.map(has).join(" OR ")}) AS run_hit, (${SPAN_FLAGS}) AS packed
      FROM runs r CROSS JOIN n WHERE ${where.join(" AND ")}
    ),
    hits AS MATERIALIZED (
      SELECT id, started_at, packed >> 2 AS span_hits, (packed >> 1) & 1 AS failure_hit, packed & 1 AS name_hit
      FROM candidates WHERE run_hit OR packed > 0
    ),
    scored AS MATERIALIZED (
      SELECT h.id, h.started_at, h.span_hits,
        (h.failure_hit * 100 + (${["r.name", "r.event_name", "r.display_name"].map(has).join(" OR ")} OR h.name_hit) * 10 + min(h.span_hits, 9)) AS score
      FROM hits h JOIN runs r ON r.id = h.id CROSS JOIN n
    ),
    matching AS MATERIALIZED (SELECT id, started_at, span_hits, score FROM scored ${cursor} ORDER BY score DESC, started_at DESC, id DESC LIMIT ?)
    ${summary("matching.score DESC, r.started_at DESC, r.id DESC", `, matching.score AS match_rank, matching.span_hits AS matched_span_count,
      COALESCE(${MATCH_SQL}, ${RUN_MATCH_SQL}) AS match_json`, "matching JOIN runs r ON r.id = matching.id CROSS JOIN n")}` };
}

const MATCH_FIELDS = new Set<RunSearchMatchField>([...MATCH_PRIORITY, "run", "metadata"]);
const unavailableSnippet = (): SearchSnippet => ({ state: "unavailable", text: "", highlights: [], truncated: false });
const asciiLower = (value: string) => value.replace(/[A-Z]/g, character => character.toLowerCase());
/** Byte budget reserved per ranked row for the public match object. */
export const RUN_MATCH_BYTES = 1536;
const AGENT_IDS_MARKER = "/*run ids*/";

function windowSnippet(window: string, cutLeft: boolean, cutRight: boolean, q: string, maxChars: number): SearchSnippet {
  // A window that starts with "{" or "[" but was cut is not JSON. The prefix
  // keeps the scrubber on its plain-text path instead of rejecting the window.
  const guarded = cutLeft || cutRight;
  const scrubbed = redactTeamText(guarded ? `…${window}` : window);
  const clean = guarded ? scrubbed.slice(1) : scrubbed;
  if (!guarded && ["[UNAVAILABLE]", "[TRUNCATED]", "[UNSERIALIZABLE]"].includes(clean)) return unavailableSnippet();
  const needle = asciiLower(q), folded = asciiLower(clean);
  const at = folded.indexOf(needle);
  let start = at < 0 ? 0 : Math.max(0, at - Math.floor(maxChars / 3));
  if (start && /[\uDC00-\uDFFF]/.test(clean[start]) && /[\uD800-\uDBFF]/.test(clean[start - 1])) start--;
  let end = Math.min(clean.length, start + maxChars);
  if (end < clean.length && /[\uD800-\uDBFF]/.test(clean[end - 1]) && /[\uDC00-\uDFFF]/.test(clean[end])) end--;
  const leading = cutLeft || start > 0, trailing = cutRight || end < clean.length;
  const text = (leading ? "…" : "") + clean.slice(start, end).replace(/\s+/g, " ") + (trailing ? "…" : "");
  const highlights: SearchSnippet["highlights"] = [];
  const lower = asciiLower(text);
  if (needle) for (let from = 0; highlights.length < 8;) {
    const found = lower.indexOf(needle, from); if (found < 0) break;
    highlights.push({ start: found, end: found + needle.length }); from = found + needle.length;
  }
  return { state: "available", text, highlights, truncated: leading || trailing };
}

/** Builds the public match from the SQL window; never larger than RUN_MATCH_BYTES. */
export function runSearchMatch(raw: unknown, q: string): RunSearchMatch | null {
  if (typeof raw !== "string") return null;
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  const field = value.field as RunSearchMatchField;
  if (!MATCH_FIELDS.has(field)) return null;
  const spanId = typeof value.spanId === "string" && value.spanId.length <= 256 ? value.spanId : null;
  const spanName = typeof value.spanName === "string" ? redactTeamText(value.spanName).slice(0, 128) : null;
  const text = typeof value.text === "string" ? value.text : null;
  const start = typeof value.start === "number" ? value.start : 1, total = typeof value.total === "number" ? value.total : 0;
  for (let cap = 240; cap >= 30; cap = Math.floor(cap / 2)) {
    const snippet = text === null || field === "metadata" ? unavailableSnippet() : windowSnippet(text, start > 1, start - 1 + text.length < total, q, cap);
    const match: RunSearchMatch = { field, span_id: spanId, span_name: spanName, snippet };
    if (Buffer.byteLength(JSON.stringify(match)) <= RUN_MATCH_BYTES) return match;
  }
  return { field, span_id: null, span_name: null, snippet: unavailableSnippet() };
}


/** Keyset pages are stable for a static store; refresh after new or updated runs.
 * Deadlines are checked between rows; an executing SQLite step may finish later.
 * Capacity stays occupied after callers leave until the read actually finishes. */
export async function searchRuns(value: unknown = {}, options: ExecutionOptions = {}): Promise<RunSearchResult> {
  const dbPath = resolvePath(options.dbPath ?? getDbPath());
  const input = parseInput(value, dbPath);
  if (options.signal?.aborted) throw new RunSearchError("Search cancelled", "cancelled", 499);
  const release = acquireSearchCapacity("local", RUN_SEARCH_LIMITS.workers);
  if (!release) throw new RunSearchError("Search is busy; retry shortly", "search_busy", 503);
  const started = Date.now();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(RUN_SEARCH_LIMITS.timeoutMs, options.timeoutMs!)) : RUN_SEARCH_LIMITS.timeoutMs;
  const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(1024, Math.min(RUN_SEARCH_LIMITS.responseBytes, options.maxBytes!)) : RUN_SEARCH_LIMITS.responseBytes;
  const cancellation = new SharedArrayBuffer(4);
  const workerData: RunSearchWork = { ...buildQuery(input), matchBytes: RUN_MATCH_BYTES, agentSql: rootAgentHintsSql(AGENT_IDS_MARKER), agentIdsMarker: AGENT_IDS_MARKER, dbPath, cursorKey: input.cursorKey, limit: input.limit, maxBytes, started, deadline: started + timeoutMs, cancellation };
  let worker: Worker;
  try { worker = new Worker(`(${runSearchWorker.toString()})()`, { eval: true, workerData }); }
  catch (error) { release(); throw error; }
  return new Promise<RunSearchResult>((resolve, reject) => {
    let settled = false;
    let response: { ok: boolean; result?: RunSearchResult; error?: string; code?: string } | undefined;
    let workerError: Error | undefined;
    const settle = (error?: Error, result?: RunSearchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => { Atomics.store(new Int32Array(cancellation), 0, 1); settle(new RunSearchError("Search cancelled", "cancelled", 499)); };
    const timer = setTimeout(() => settle(new RunSearchError("Search timed out; narrow the query or filters", "timeout", 504)), timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (message: { ok: boolean; result?: RunSearchResult; error?: string; code?: string }) => {
      response = message;
    });
    worker.once("error", error => { workerError = new RunSearchError(error.message, "worker_failed", 500); });
    worker.once("exit", () => {
      release();
      if (response?.ok && response.result) {
        const result = response.result;
        result.runs = result.runs.map(row => {
          const { match_json: raw, agent_roots: roots, ...summary } = row as RunSearchSummary & { match_json?: unknown; agent_roots?: RootAgentHintRow[] };
          const agent = deriveRunAgent({ event_name: summary.event_name, name: summary.name, finished: summary.finished, hints: hintsFromRows(roots ?? []) });
          return { ...summary, agent, match: input.q ? runSearchMatch(raw, input.q) : null, matched_span_count: input.q ? summary.matched_span_count : null };
        });
        settle(undefined, result);
      } else if (response) settle(new RunSearchError(response.error ?? "Search failed", response.code ?? "query_failed", response.code === "timeout" ? 504 : 500));
      else settle(workerError ?? new RunSearchError("Search worker exited before completing", "worker_failed", 500));
    });
    if (options.signal?.aborted) abort();
  });
}

export const _runSearchInternal = { activeWorkers: () => searchCapacity("local") };
