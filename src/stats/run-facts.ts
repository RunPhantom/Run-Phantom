import type { Database } from "bun:sqlite";
import { parseJsonEvidence } from "../evaluations/json-evidence";
import { hasDuplicateJsonKeys } from "../json-keys";
import { generationCost, requestModel } from "../pricing/span-cost";
import { normalizeUsage } from "../pricing/usage";
import { normalizeStoredSpan } from "../spans/normalize";
import { captureCompletion } from "../spans/normalized";
import { countedErrors, deriveRunStatus, rootFailed, type RunStatusSummary } from "../run-status";
import { selectRootAgentHints, type RootAgentHints } from "../run-agent";

export type CostSource = "reported" | "estimated" | "unknown";

export interface GenerationFact {
  readonly model: string | null;
  readonly provider: string | null;
  readonly durationMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly costSource: CostSource;
}

export interface ErrorFact {
  readonly spanId: string;
  readonly name: string;
  readonly spanType: string | null;
  readonly startMs: number | null;
  readonly message: string | null;
}

export interface ToolFailureFact {
  readonly failures: number;
  /** The latest failing call by start time; ties go to the later span in start order. */
  readonly last: ErrorFact;
}

/** Everything the overview and run list derive from a run's spans; cached per run. */
export interface RunFacts {
  readonly spanCount: number;
  readonly errorCount: number;
  /** Errored TOOL_CALL spans, as in the run list's legacy `tool_error_count`. */
  readonly toolErrorCount: number;
  readonly rootFailed: boolean;
  readonly toolCount: number;
  readonly finished: number;
  readonly durationMs: number | null;
  /** Null unless every counted model call reports it. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly costSource: CostSource;
  readonly llmCalls: number;
  /** Sums of the calls that report a value; null when none do. */
  readonly knownInputTokens: number | null;
  readonly knownOutputTokens: number | null;
  /** Model calls missing input or output tokens. */
  readonly tokenUnknownCalls: number;
  readonly knownCostUsd: number | null;
  /** Where knownCostUsd came from: every priced call reported it, every one was list-priced, or both; null when none. */
  readonly knownCostSource: "reported" | "estimated" | "mixed" | null;
  readonly costUnknownCalls: number;
  /** Normalized model of the first counted model call, else the first span model column in start order. */
  readonly primaryModel: string | null;
  readonly provider: string | null;
  readonly models: readonly string[];
  readonly inputPreview: string | null;
  readonly captureCompletion: "unavailable" | null;
  readonly generations: readonly GenerationFact[];
  /** The first RUN_FACT_LIMITS.errorsPerRun failing spans in start order; errorCount has the full count. */
  readonly errors: readonly ErrorFact[];
  readonly toolCalls: Readonly<Record<string, number>>;
  readonly toolFailures: Readonly<Record<string, ToolFailureFact>>;
  readonly agentHints: RootAgentHints;
}

export interface RunRow {
  readonly id: string;
  readonly event_id: string | null;
  readonly name: string | null;
  readonly event_name: string | null;
  readonly display_name: string | null;
  readonly user_id: string | null;
  readonly convo_id: string | null;
  readonly started_at: number;
  readonly last_updated_at: number;
  readonly metadata: string | null;
  readonly live_event_count: number;
  /** The legacy runs_with_hints `model`: the first span with a model column, in that view's lookup order. */
  readonly legacy_model: string | null;
  readonly facts: RunFacts;
}

/**
 * The shared `deriveRunStatus` for a loaded run. It depends on the clock (live, quiet, interrupted) and on
 * metadata (replay outcome), so it is derived per request and never cached with the facts.
 */
export function runRowStatus(row: RunRow, now: number): RunStatusSummary {
  const facts = row.facts;
  return deriveRunStatus({ last_updated_at: row.last_updated_at, finished: facts.finished, span_count: facts.spanCount, metadata: row.metadata,
    capture_completion: facts.captureCompletion, error_count: facts.errorCount, tool_error_count: facts.toolErrorCount, root_failed: facts.rootFailed }, now);
}

export const RUN_FACT_LIMITS = Object.freeze({
  previewChars: 140,
  errorMessageChars: 200,
  errorsPerRun: 20,
  cacheEntries: 50_000,
  idsPerQuery: 400,
  ancestryDepth: 256,
  /** pricing/analytics.ts treats attributes longer than this many UTF-16 units as unavailable. */
  attributeChars: 64 * 1024,
  previewSourceBytes: 64 * 1024,
});

interface Aggregate {
  id: string; event_id: string | null; name: string | null; event_name: string | null; display_name: string | null; user_id: string | null; convo_id: string | null;
  started_at: number; last_updated_at: number; metadata: string | null; live_event_count: number; legacy_model: string | null;
  span_count: number; error_count: number; tool_error_count: number; tool_count: number; root_count: number; ended_root_count: number; root_error_count: number;
  agent_root_count: number; agent_root_error_count: number;
  min_start: number | null; max_end: number | null;
  fp_attributes: number; fp_input: number; fp_output: number; fp_duration: number; fp_tokens: number; fp_ok: number;
  fp_names: number; fp_generations: number; fp_model: number; fp_start: number; fp_end: number; fp_parent: number; fp_rowid: number | null; fp_model_min: string | null; fp_model_max: string | null;
}

interface SpanRow {
  run_id: string; id: string; parent_span_id: string | null; name: string; span_type: string | null; status: string | null;
  start_time_ms: number | null; end_time_ms: number | null; duration_ms: number | null; model: string | null; provider: string | null;
  input_tokens: number | null; output_tokens: number | null; attributes: string | null; attributes_bytes: number | null;
  input_payload: string | null; output_payload: string | null;
}

const AGGREGATE_COLUMNS = `
  COUNT(s.id) AS span_count,
  COALESCE(SUM(s.status = 'ERROR'), 0) AS error_count,
  COALESCE(SUM(s.span_type = 'TOOL_CALL'), 0) AS tool_count,
  COALESCE(SUM(s.id IS NOT NULL AND s.parent_span_id IS NULL), 0) AS root_count,
  COALESCE(SUM(s.parent_span_id IS NULL AND s.status IN ('OK', 'ERROR')), 0) AS ended_root_count,
  COALESCE(SUM(s.parent_span_id IS NULL AND s.status = 'ERROR'), 0) AS root_error_count,
  COALESCE(SUM(s.status = 'ERROR' AND s.span_type = 'TOOL_CALL'), 0) AS tool_error_count,
  COALESCE(SUM(s.parent_span_id IS NULL AND s.span_type = 'AGENT_ROOT'), 0) AS agent_root_count,
  COALESCE(SUM(s.parent_span_id IS NULL AND s.span_type = 'AGENT_ROOT' AND s.status = 'ERROR'), 0) AS agent_root_error_count,
  MIN(s.start_time_ms) AS min_start,
  MAX(s.end_time_ms) AS max_end,
  TOTAL(octet_length(s.attributes)) AS fp_attributes,
  TOTAL(octet_length(s.input_payload)) AS fp_input,
  TOTAL(octet_length(s.output_payload)) AS fp_output,
  TOTAL(s.duration_ms) AS fp_duration,
  TOTAL(s.input_tokens) + TOTAL(s.output_tokens) * 65536 AS fp_tokens,
  COALESCE(SUM(s.status = 'OK'), 0) AS fp_ok,
  TOTAL(length(s.name)) + TOTAL(length(s.span_type)) * 4096 AS fp_names,
  COALESCE(SUM(s.span_type = 'LLM_GENERATION'), 0) AS fp_generations,
  TOTAL(length(s.model)) + TOTAL(length(s.provider)) * 4096 AS fp_model,
  TOTAL(s.start_time_ms) AS fp_start,
  TOTAL(s.end_time_ms) AS fp_end,
  TOTAL(length(s.parent_span_id)) AS fp_parent,
  MAX(s.rowid) AS fp_rowid,
  MIN(s.model) AS fp_model_min,
  MAX(s.model) AS fp_model_max`;

/**
 * One grouped pass over the selected runs' spans. Its totals double as the
 * cache fingerprint, so a new, removed, re-inserted, ended or failed span, a
 * re-typed or re-parented span, a moved start or end time, a changed model, or
 * any change in a name, provider, attribute, payload or token size recomputes
 * that run. Several ingest paths write spans with raw SQL (coding hooks, trace
 * import), so there is no single write hook to invalidate from. An in-place
 * rewrite that keeps every one of these lengths and totals equal, such as a
 * reported cost of 0.0012 becoming 0.0034, is not detected until the run
 * changes again or the daemon restarts.
 */
export function selectRunAggregates(db: Database, where: string, params: readonly (string | number)[]): Aggregate[] {
  return db.query(`SELECT r.id, r.event_id, r.name, r.event_name, r.display_name, r.user_id, r.convo_id, r.started_at, r.last_updated_at, r.metadata,
      (SELECT COUNT(*) FROM live_events e WHERE e.trace_id = r.id) AS live_event_count,
      (SELECT s2.model FROM spans s2 WHERE s2.run_id = r.id AND s2.model IS NOT NULL LIMIT 1) AS legacy_model, ${AGGREGATE_COLUMNS}
    FROM runs r LEFT JOIN spans s ON s.run_id = r.id
    WHERE ${where} GROUP BY r.id`).all(...params) as Aggregate[];
}

const cache = new Map<string, { fingerprint: string; facts: RunFacts }>();

export function clearRunFactsCache(): void {
  cache.clear();
}

export function loadRunRows(db: Database, dbPath: string, aggregates: readonly Aggregate[]): RunRow[] {
  const facts = new Map<string, RunFacts>();
  const missing: Aggregate[] = [];
  for (const aggregate of aggregates) {
    const hit = cache.get(cacheKey(dbPath, aggregate.id));
    if (hit && hit.fingerprint === fingerprint(aggregate)) {
      facts.set(aggregate.id, hit.facts);
      remember(cacheKey(dbPath, aggregate.id), hit.fingerprint, hit.facts);
    } else missing.push(aggregate);
  }
  for (let offset = 0; offset < missing.length; offset += RUN_FACT_LIMITS.idsPerQuery) {
    const batch = missing.slice(offset, offset + RUN_FACT_LIMITS.idsPerQuery);
    const ids = batch.map(item => item.id);
    const spans = selectSpans(db, ids);
    const hints = selectRootAgentHints(db, ids);
    for (const aggregate of batch) {
      const computed = computeRunFacts(aggregate, spans.get(aggregate.id) ?? [], hints.get(aggregate.id)!);
      facts.set(aggregate.id, computed);
      remember(cacheKey(dbPath, aggregate.id), fingerprint(aggregate), computed);
    }
  }
  return aggregates.map(aggregate => ({
    id: aggregate.id, event_id: aggregate.event_id, name: aggregate.name, event_name: aggregate.event_name, display_name: aggregate.display_name,
    user_id: aggregate.user_id, convo_id: aggregate.convo_id, started_at: aggregate.started_at, last_updated_at: aggregate.last_updated_at,
    metadata: aggregate.metadata, live_event_count: aggregate.live_event_count, legacy_model: aggregate.legacy_model, facts: facts.get(aggregate.id)!,
  }));
}

const cacheKey = (dbPath: string, runId: string) => `${dbPath}\u0000${runId}`;
const fingerprint = (aggregate: Aggregate) => JSON.stringify([aggregate.span_count, aggregate.error_count, aggregate.tool_count, aggregate.root_count,
  aggregate.ended_root_count, aggregate.root_error_count, aggregate.tool_error_count, aggregate.agent_root_count, aggregate.agent_root_error_count, aggregate.min_start, aggregate.max_end, aggregate.fp_attributes, aggregate.fp_input,
  aggregate.fp_output, aggregate.fp_duration, aggregate.fp_tokens, aggregate.fp_ok, aggregate.fp_names, aggregate.fp_generations, aggregate.fp_model,
  aggregate.fp_start, aggregate.fp_end, aggregate.fp_parent, aggregate.fp_rowid, aggregate.fp_model_min, aggregate.fp_model_max]);

/** Least-recently-used: a hit is re-inserted, so the oldest key in Map order is the coldest entry. */
function remember(key: string, value: string, facts: RunFacts): void {
  cache.delete(key);
  cache.set(key, { fingerprint: value, facts });
  if (cache.size > RUN_FACT_LIMITS.cacheEntries) cache.delete(cache.keys().next().value!);
}

function selectSpans(db: Database, runIds: readonly string[]): Map<string, SpanRow[]> {
  const rows = db.query(`SELECT run_id, id, parent_span_id, name, span_type, status, start_time_ms, end_time_ms, duration_ms, model, provider, input_tokens, output_tokens,
      octet_length(attributes) AS attributes_bytes,
      CASE WHEN (span_type = 'LLM_GENERATION' OR status = 'ERROR' OR (parent_span_id IS NULL AND span_type = 'AGENT_ROOT')) AND octet_length(attributes) <= ${3 * RUN_FACT_LIMITS.attributeChars} THEN attributes END AS attributes,
      CASE WHEN (span_type = 'LLM_GENERATION' OR parent_span_id IS NULL) AND octet_length(input_payload) <= ${RUN_FACT_LIMITS.previewSourceBytes} THEN input_payload END AS input_payload,
      CASE WHEN status = 'ERROR' THEN substr(output_payload, 1, 4000) END AS output_payload
    FROM spans WHERE run_id IN (${runIds.map(() => "?").join(",")})
    ORDER BY run_id, start_time_ms IS NULL, start_time_ms, id`).all(...runIds) as SpanRow[];
  const grouped = new Map<string, SpanRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.run_id);
    if (list) list.push(row); else grouped.set(row.run_id, [row]);
  }
  return grouped;
}

function computeRunFacts(aggregate: Aggregate, spans: readonly SpanRow[], agentHints: RootAgentHints): RunFacts {
  const runRootFailed = rootFailed({ roots: aggregate.root_count, rootErrors: aggregate.root_error_count, agentRoots: aggregate.agent_root_count, agentRootErrors: aggregate.agent_root_error_count });
  const finished = aggregate.root_count > 0 && aggregate.ended_root_count === aggregate.root_count ? 1 : 0;
  const durationMs = finished && aggregate.min_start !== null && aggregate.max_end !== null && aggregate.max_end >= aggregate.min_start
    ? aggregate.max_end - aggregate.min_start : null;
  const byId = new Map(spans.map(span => [span.id, span]));
  const generations: GenerationFact[] = [];
  let firstGeneration: SpanRow | null = null;
  for (const span of spans) {
    if (span.span_type !== "LLM_GENERATION") continue;
    const generation = evaluateGeneration(span, byId);
    if (!generation) continue;
    firstGeneration ??= span;
    generations.push(generation);
  }
  const known = (values: Array<number | null>) => values.length && values.every(value => value !== null) ? (values as number[]).reduce((sum, value) => sum + value, 0) : null;
  const partial = (values: Array<number | null>) => values.some(value => value !== null) ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  const inputTokens = known(generations.map(item => item.inputTokens));
  const outputTokens = known(generations.map(item => item.outputTokens));
  const costUsd = known(generations.map(item => item.costUsd));
  const priced = generations.filter(item => item.costUsd !== null);
  const knownCostSource = !priced.length ? null : priced.every(item => item.costSource === "reported") ? "reported" : priced.some(item => item.costSource === "reported") ? "mixed" : "estimated";
  const costSource: CostSource = costUsd === null ? "unknown" : generations.every(item => item.costSource === "reported") ? "reported" : "estimated";
  const models: string[] = [];
  for (const generation of generations) if (generation.model && !models.includes(generation.model)) models.push(generation.model);
  const lead = generations.find(item => item.model) ?? null;
  const fallbackModel = spans.find(span => span.model)?.model ?? null;
  const errors: ErrorFact[] = [];
  const toolCalls: Record<string, number> = Object.create(null);
  const toolFailureSpans = new Map<string, { failures: number; last: SpanRow }>();
  const errorFact = (span: SpanRow): ErrorFact => ({ spanId: span.id, name: span.name, spanType: span.span_type, startMs: span.start_time_ms, message: errorMessage(span) });
  for (const span of spans) {
    if (span.span_type === "TOOL_CALL") toolCalls[span.name] = (toolCalls[span.name] ?? 0) + 1;
    if (span.status !== "ERROR") continue;
    if (errors.length < RUN_FACT_LIMITS.errorsPerRun) errors.push(errorFact(span));
    if (span.span_type !== "TOOL_CALL") continue;
    const tool = toolFailureSpans.get(span.name);
    if (!tool) toolFailureSpans.set(span.name, { failures: 1, last: span });
    else {
      tool.failures++;
      if ((span.start_time_ms ?? -Infinity) >= (tool.last.start_time_ms ?? -Infinity)) tool.last = span;
    }
  }
  const toolFailures: Record<string, ToolFailureFact> = Object.create(null);
  for (const [name, tool] of toolFailureSpans) toolFailures[name] = Object.freeze({ failures: tool.failures, last: errorFact(tool.last) });
  const root = spans.find(span => span.parent_span_id === null && span.span_type === "AGENT_ROOT") ?? null;
  return Object.freeze({
    spanCount: aggregate.span_count, errorCount: countedErrors(aggregate.error_count, aggregate.agent_root_error_count), toolErrorCount: aggregate.tool_error_count, rootFailed: runRootFailed, toolCount: aggregate.tool_count, finished, durationMs,
    inputTokens, outputTokens, costUsd, costSource,
    llmCalls: generations.length,
    knownInputTokens: partial(generations.map(item => item.inputTokens)), knownOutputTokens: partial(generations.map(item => item.outputTokens)),
    tokenUnknownCalls: generations.filter(item => item.inputTokens === null || item.outputTokens === null).length,
    knownCostUsd: partial(generations.map(item => item.costUsd)), knownCostSource, costUnknownCalls: generations.filter(item => item.costUsd === null).length,
    primaryModel: lead?.model ?? fallbackModel, provider: lead?.provider ?? spans.find(span => span.provider)?.provider ?? null, models: Object.freeze(models),
    inputPreview: inputPreview(firstGeneration, spans.find(span => span.parent_span_id === null) ?? null),
    captureCompletion: rootCaptureCompletion(root),
    generations: Object.freeze(generations), errors: Object.freeze(errors), toolCalls: Object.freeze(toolCalls), toolFailures: Object.freeze(toolFailures),
    agentHints: Object.freeze(agentHints),
  });
}

const MODEL_KEYS = ["gen_ai.response.model", "ai.response.model", "llm.response.model_name", "gen_ai.request.model", "ai.model.id", "llm.request.model", "llm.model_name"];
const INPUT_KEYS = ["gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens", "ai.usage.inputTokens", "ai.usage.promptTokens", "ai.usage.prompt_tokens", "llm.token_count.prompt"];
const OUTPUT_KEYS = ["gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens", "ai.usage.outputTokens", "ai.usage.completionTokens", "ai.usage.completion_tokens", "llm.token_count.completion"];
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function parsedAttributes(span: SpanRow): { values: Record<string, unknown>; unavailable: boolean } {
  if (span.attributes_bytes === null) return { values: {}, unavailable: false };
  if (span.attributes === null || span.attributes.length > RUN_FACT_LIMITS.attributeChars) return { values: {}, unavailable: true };
  try {
    if (hasDuplicateJsonKeys(span.attributes)) return { values: {}, unavailable: true };
    const value = parseJsonEvidence(span.attributes);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { values: {}, unavailable: true };
    return { values: { ...(value as Record<string, unknown>) }, unavailable: false };
  } catch { return { values: {}, unavailable: true }; }
}

/**
 * Mirrors aggregateCostAnalytics (pricing/analytics.ts) for one generation so
 * run totals agree with the Cost page: nested generations are counted once
 * through their outermost model call, and a broken ancestry makes the call's
 * usage unknown. tests/run-facts.test.ts pins the two against each other.
 */
function evaluateGeneration(span: SpanRow, byId: ReadonlyMap<string, SpanRow>): GenerationFact | null {
  const structure = ancestry(span, byId);
  if (structure === "nested") return null;
  const captured = parsedAttributes(span);
  const values = captured.values;
  if (!MODEL_KEYS.some(key => hasOwn(values, key)) && span.model !== null) values["gen_ai.response.model"] = span.model;
  if (!INPUT_KEYS.some(key => hasOwn(values, key)) && span.input_tokens !== null) values["gen_ai.usage.input_tokens"] = span.input_tokens;
  if (!OUTPUT_KEYS.some(key => hasOwn(values, key)) && span.output_tokens !== null) values["gen_ai.usage.output_tokens"] = span.output_tokens;
  if (captured.unavailable) values["runphantom.usage.unit"] = "unavailable";
  const usage = normalizeUsage(values, span.provider);
  const model = usage.model ?? span.model;
  const provider = usage.provider ?? span.provider;
  const durationMs = typeof span.duration_ms === "number" && Number.isFinite(span.duration_ms) && span.duration_ms >= 0 ? span.duration_ms : null;
  if (structure === "unavailable") return { model, provider, durationMs, inputTokens: null, outputTokens: null, costUsd: null, costSource: "unknown" };
  const inputTokens = usage.categories.input.count, outputTokens = usage.categories.output.count;
  const cost = generationCost({ values: captured.unavailable ? null : values, models: [model, requestModel(values)], provider: span.provider, inputTokens, outputTokens, at: span.start_time_ms, normalized: captured.unavailable ? undefined : usage });
  return { model, provider, durationMs, inputTokens, outputTokens, costUsd: cost.usd, costSource: cost.source === "reported" ? "reported" : cost.source === "list-price" ? "estimated" : "unknown" };
}

function ancestry(span: SpanRow, byId: ReadonlyMap<string, SpanRow>): "root" | "nested" | "unavailable" {
  const seen = new Set<string>();
  let current: SpanRow | undefined = span;
  let nested = false;
  while (current) {
    if (seen.size >= RUN_FACT_LIMITS.ancestryDepth || seen.has(current.id)) return "unavailable";
    seen.add(current.id);
    if (current !== span && current.span_type === "LLM_GENERATION") nested = true;
    if (!current.parent_span_id) return nested ? "nested" : "root";
    current = byId.get(current.parent_span_id);
  }
  return "unavailable";
}

function rootCaptureCompletion(root: SpanRow | null): "unavailable" | null {
  if (!root?.attributes || root.attributes_bytes === null || root.attributes_bytes > 16384) return null;
  try {
    return captureCompletion(normalizeStoredSpan({ name: "", span_type: "AGENT_ROOT", input_payload: null, output_payload: null, attributes: root.attributes }).normalized.capture);
  } catch { return null; }
}

/** Collapse whitespace and cut at a word boundary so previews never end mid-word when avoidable. */
export function clip(text: string, max: number): string | null {
  const flat = text.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, /[\uD800-\uDBFF]/.test(flat[max - 2]) ? max - 2 : max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function messageText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content.map(part => typeof part === "string" ? part : part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "").join(" ");
  return text.trim() ? text : null;
}

/** Plain text, a JSON string, `{prompt|input|...}`, or a `messages` array (bare or wrapped). */
function payloadPrompt(raw: string): string | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return raw; }
  if (typeof value === "string") return value;
  const messages = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { messages?: unknown }).messages) ? (value as { messages: unknown[] }).messages : null;
  if (messages) {
    for (const message of messages) {
      if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "user") continue;
      const text = messageText((message as { content?: unknown }).content);
      if (text) return text;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const key of ["prompt", "input", "message", "query", "question", "task"]) {
      const field = (value as Record<string, unknown>)[key];
      if (typeof field === "string") return field;
    }
  }
  return null;
}

function inputPreview(generation: SpanRow | null, root: SpanRow | null): string | null {
  if (generation) {
    try {
      const normalized = normalizeStoredSpan({ name: generation.name, span_type: generation.span_type, input_payload: generation.input_payload, output_payload: null, attributes: generation.attributes }).normalized;
      const user = normalized.kind === "llm" ? normalized.messages.find(message => message.role === "user" && message.content.trim()) : undefined;
      if (user) return clip(user.content, RUN_FACT_LIMITS.previewChars);
    } catch { /* An unrecognised model input falls back to the raw payloads below. */ }
    const prompt = generation.input_payload ? payloadPrompt(generation.input_payload) : null;
    if (prompt) return clip(prompt, RUN_FACT_LIMITS.previewChars);
  }
  const prompt = root?.input_payload ? payloadPrompt(root.input_payload) : null;
  return prompt ? clip(prompt, RUN_FACT_LIMITS.previewChars) : null;
}

const ERROR_KEYS = ["error.message", "exception.message", "ai.response.error", "otel.status.message"] as const;

export function firstSentence(text: string, max: number = RUN_FACT_LIMITS.errorMessageChars): string | null {
  const line = text.split(/\r?\n/).map(part => part.trim()).find(Boolean);
  if (!line) return null;
  const end = /[.!?](?=\s|$)/.exec(line);
  return clip(end ? line.slice(0, end.index + 1) : line, max);
}

function errorMessage(span: SpanRow): string | null {
  let attributes: Record<string, unknown> | null = null;
  if (span.attributes) { try { const parsed = JSON.parse(span.attributes); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) attributes = parsed; } catch { attributes = null; } }
  for (const key of ERROR_KEYS) {
    const value = attributes?.[key];
    if (typeof value === "string" && value.trim()) return firstSentence(value);
  }
  if (span.output_payload) {
    let value: unknown = span.output_payload;
    try { value = JSON.parse(span.output_payload); } catch { /* Plain-text output is the message itself. */ }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const nested = record.error && typeof record.error === "object" ? (record.error as Record<string, unknown>).message : record.error;
      value = typeof nested === "string" ? nested : typeof record.message === "string" ? record.message : null;
    }
    if (typeof value === "string" && value.trim()) return firstSentence(value);
  }
  const result = attributes?.["ai.toolCall.result"];
  return typeof result === "string" && result.trim() ? firstSentence(result) : null;
}
