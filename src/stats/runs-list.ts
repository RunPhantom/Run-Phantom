import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { queryString, queryTime, roundUsd, runAgent, runUsesModel, StatsRequestError } from "./common";
import { loadRunRows, selectRunAggregates, type CostSource, type RunRow } from "./run-facts";
import { RUN_STATUSES, type RunStatus } from "./run-status";
import { deriveRunStatus as deriveSharedRunStatus, type RunStatus as SharedRunStatus } from "../run-status";

export const RUN_LIST_SORTS = ["last_updated_at", "started_at", "duration", "cost", "tokens", "errors"] as const;
export type RunListSort = typeof RUN_LIST_SORTS[number];
export const RUN_LIST_LIMITS = Object.freeze({ defaultLimit: 5000, maxLimit: 5000, queryChars: 256 });

/** Fields of GET /api/runs before metrics were added; kept identical for existing callers. */
export interface LegacyRunListRow {
  id: string;
  event_id: string | null;
  name: string | null;
  event_name: string | null;
  display_name: string | null;
  user_id: string | null;
  convo_id: string | null;
  started_at: number;
  last_updated_at: number;
  metadata: string | null;
  model: string | null;
  finished: number;
  span_count: number;
  live_event_count: number;
  capture_completion: "unavailable" | null;
  error_count: number;
  tool_error_count: number;
  root_failed: boolean;
  /** The shared deriveRunStatus status (src/run-status.ts); time-dependent, so derived per request. */
  run_status: SharedRunStatus;
}

export interface RunListRow extends LegacyRunListRow {
  status: RunStatus;
  agent: string | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  est_cost_usd: number | null;
  cost_source: CostSource;
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

interface RunListQuery {
  limit: number;
  statuses: RunStatus[] | null;
  agent?: string;
  model?: string;
  q?: string;
  since?: number;
  until?: number;
  sort: RunListSort;
  order: "asc" | "desc";
  cursor?: { value: number | null; id: string };
  filterKey: string;
  envelope: boolean;
}

function parseRunListQuery(query: Record<string, unknown>): RunListQuery {
  const rawLimit = queryString(query, "limit", 16);
  const parsedLimit = Number(rawLimit);
  // Legacy callers sent arbitrary limits and were clamped rather than rejected.
  const limit = rawLimit !== undefined && Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(Math.floor(parsedLimit), RUN_LIST_LIMITS.maxLimit) : RUN_LIST_LIMITS.defaultLimit;
  const rawStatus = queryString(query, "status", 128);
  let statuses: RunStatus[] | null = null;
  if (rawStatus && rawStatus !== "all") {
    statuses = rawStatus.split(",").map(item => item.trim()) as RunStatus[];
    if (statuses.some(item => !RUN_STATUSES.includes(item))) throw new StatsRequestError(`status must be all or a comma-separated list of ${RUN_STATUSES.join(", ")}`);
  }
  const sort = (queryString(query, "sort", 32) || "last_updated_at") as RunListSort;
  if (!RUN_LIST_SORTS.includes(sort)) throw new StatsRequestError(`sort must be one of ${RUN_LIST_SORTS.join(", ")}`);
  const order = queryString(query, "order", 8) || "desc";
  if (order !== "asc" && order !== "desc") throw new StatsRequestError("order must be asc or desc");
  const agent = queryString(query, "agent") || undefined;
  const model = queryString(query, "model") || undefined;
  const q = queryString(query, "q", RUN_LIST_LIMITS.queryChars)?.trim() || undefined;
  const since = queryTime(query, "since");
  const until = queryTime(query, "until");
  if (since !== undefined && until !== undefined && until <= since) throw new StatsRequestError("until must be later than since");
  const rawEnvelope = queryString(query, "envelope", 8);
  if (rawEnvelope !== undefined && rawEnvelope !== "0" && rawEnvelope !== "1") throw new StatsRequestError("envelope must be 0 or 1");
  const filterKey = createHash("sha256").update(JSON.stringify([statuses, agent ?? null, model ?? null, q ?? null, since ?? null, until ?? null, sort, order])).digest("base64url").slice(0, 16);
  const encoded = queryString(query, "cursor", 1024);
  let cursor: RunListQuery["cursor"];
  if (encoded) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("format");
      const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      if (!Array.isArray(parsed) || parsed.length !== 4 || parsed[0] !== 1 || parsed[1] !== filterKey) throw new Error("scope");
      const [, , value, id] = parsed as [number, string, unknown, unknown];
      if ((value !== null && (typeof value !== "number" || !Number.isFinite(value))) || typeof id !== "string" || !id) throw new Error("shape");
      cursor = { value, id };
    } catch { throw new StatsRequestError("cursor is invalid for these filters; request the first page again"); }
  }
  return { limit, statuses, agent, model, q, since, until, sort, order, cursor, filterKey, envelope: rawEnvelope === "1" };
}

function sortValue(row: RunRow, sort: RunListSort): number | null {
  const facts = row.facts;
  switch (sort) {
    case "last_updated_at": return row.last_updated_at;
    case "started_at": return row.started_at;
    case "duration": return facts.durationMs;
    case "cost": return facts.costUsd;
    case "tokens": return facts.inputTokens === null || facts.outputTokens === null ? null : facts.inputTokens + facts.outputTokens;
    case "errors": return facts.errorCount;
  }
}

/** Total order: known values by direction, unknown values last, then id in the same direction. */
function compare(a: { value: number | null; id: string }, b: { value: number | null; id: string }, order: "asc" | "desc"): number {
  const direction = order === "asc" ? 1 : -1;
  if (a.value !== b.value) {
    if (a.value === null) return 1;
    if (b.value === null) return -1;
    return (a.value - b.value) * direction;
  }
  return a.id === b.id ? 0 : (a.id < b.id ? -1 : 1) * direction;
}

export function toRunListRow(row: RunRow, now: number = Date.now()): RunListRow {
  const facts = row.facts;
  const runStatus = deriveSharedRunStatus({ last_updated_at: row.last_updated_at, finished: facts.finished, span_count: facts.spanCount, metadata: row.metadata,
    capture_completion: facts.captureCompletion, error_count: facts.errorCount, tool_error_count: facts.toolErrorCount, root_failed: facts.rootFailed }, now).status;
  return {
    id: row.id, event_id: row.event_id, name: row.name, event_name: row.event_name, display_name: row.display_name, user_id: row.user_id, convo_id: row.convo_id,
    started_at: row.started_at, last_updated_at: row.last_updated_at, metadata: row.metadata, model: row.legacy_model, finished: facts.finished,
    span_count: facts.spanCount, live_event_count: row.live_event_count, capture_completion: facts.captureCompletion, error_count: facts.errorCount,
    tool_error_count: facts.toolErrorCount, root_failed: facts.rootFailed, run_status: runStatus,
    status: facts.status, agent: runAgent(row), duration_ms: facts.durationMs, input_tokens: facts.inputTokens, output_tokens: facts.outputTokens,
    est_cost_usd: facts.costUsd === null ? null : roundUsd(facts.costUsd), cost_source: facts.costSource, tool_count: facts.toolCount,
    primary_model: facts.primaryModel, provider: facts.provider, models: [...facts.models], input_preview: facts.inputPreview,
    llm_calls: facts.llmCalls, known_input_tokens: facts.knownInputTokens, known_output_tokens: facts.knownOutputTokens, token_unknown_calls: facts.tokenUnknownCalls,
    known_cost_usd: facts.knownCostUsd === null ? null : roundUsd(facts.knownCostUsd), cost_unknown_calls: facts.costUnknownCalls,
  };
}

export function listRuns(db: Database, dbPath: string, rawQuery: Record<string, unknown>): RunListPage & { envelope: boolean } {
  const query = parseRunListQuery(rawQuery);
  const now = Date.now();
  const where: string[] = ["1 = 1"];
  const params: number[] = [];
  if (query.since !== undefined) { where.push("r.started_at >= ?"); params.push(query.since); }
  if (query.until !== undefined) { where.push("r.started_at < ?"); params.push(query.until); }
  const needle = query.q?.toLowerCase();
  const matching = loadRunRows(db, dbPath, selectRunAggregates(db, where.join(" AND "), params)).filter(row =>
    (!query.statuses || query.statuses.includes(row.facts.status))
    && (!query.agent || runAgent(row) === query.agent)
    && (!query.model || runUsesModel(row, query.model))
    && (!needle || [row.id, row.display_name, row.name, row.event_name, row.facts.inputPreview].some(field => field?.toLowerCase().includes(needle))));
  const keyed = matching.map(row => ({ row, value: sortValue(row, query.sort), id: row.id }));
  keyed.sort((a, b) => compare(a, b, query.order));
  const start = query.cursor ? keyed.findIndex(item => compare(item, query.cursor!, query.order) > 0) : 0;
  const remaining = start < 0 ? [] : keyed.slice(start);
  const page = remaining.slice(0, query.limit);
  const hasMore = remaining.length > page.length;
  const last = page[page.length - 1];
  return {
    runs: page.map(item => toRunListRow(item.row, now)),
    total: matching.length,
    hasMore,
    nextCursor: hasMore && last ? Buffer.from(JSON.stringify([1, query.filterKey, last.value, last.id])).toString("base64url") : null,
    envelope: query.envelope,
  };
}
