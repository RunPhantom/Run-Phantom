import type { Span } from "../../utils/types";
import { fmt, spanErrorReason } from "../../utils/helpers";

export type TraceKind = "llm" | "tool" | "agent" | "other";

export const TRACE_KINDS: readonly TraceKind[] = ["llm", "tool", "agent", "other"];

export const TRACE_KIND_LABEL: Record<TraceKind, string> = {
  llm: "MODEL",
  tool: "TOOL",
  agent: "AGENT",
  other: "STEP",
};

export const TRACE_KIND_FILTER_LABEL: Record<TraceKind, string> = {
  llm: "Model calls",
  tool: "Tools",
  agent: "Agents",
  other: "Other",
};

export function isLlmSpan(span: Pick<Span, "span_type">): boolean {
  return !!span.span_type?.includes("LLM");
}

export function traceKind(span: Pick<Span, "id" | "span_type" | "name">, agentRootIds?: ReadonlySet<string>): TraceKind {
  const type = span.span_type ?? "";
  if (type.includes("LLM") || type === "EMBEDDING") return "llm";
  if (agentRootIds?.has(span.id) || type === "AGENT_ROOT" || type === "AGENT" || /^invoke_agent\b/.test(span.name)) return "agent";
  if (type === "TOOL_CALL" || type === "RETRIEVAL") return "tool";
  return "other";
}

export interface TraceRow {
  span: Span;
  depth: number;
  parentId: string | null;
  childIds: string[];
  /** Nearest first. */
  ancestors: string[];
  kind: TraceKind;
}

export interface TraceModel {
  rows: TraceRow[];
  byId: Map<string, TraceRow>;
  start: number;
  end: number;
  /** end - start, never below 1 so positions stay finite. */
  span: number;
}

/**
 * Depth-first rows, children in start order. Spans whose parent is missing are
 * roots; spans caught in a parent cycle are never reachable from a root, so they
 * are appended as roots instead of being dropped.
 */
export function buildTraceModel(spans: readonly Span[], agentRootIds?: ReadonlySet<string>): TraceModel {
  const ids = new Map(spans.map(span => [span.id, span]));
  const children = new Map<string, Span[]>();
  const roots: Span[] = [];
  for (const span of spans) {
    if (!span.parent_span_id || !ids.has(span.parent_span_id) || span.parent_span_id === span.id) roots.push(span);
    else {
      const list = children.get(span.parent_span_id) ?? [];
      list.push(span);
      children.set(span.parent_span_id, list);
    }
  }
  const byStart = (a: Span, b: Span) => a.start_time_ms - b.start_time_ms || a.end_time_ms - b.end_time_ms;
  for (const list of children.values()) list.sort(byStart);
  roots.sort(byStart);

  const rows: TraceRow[] = [];
  const byId = new Map<string, TraceRow>();
  const visit = (root: Span) => {
    const stack: { span: Span; depth: number; ancestors: string[] }[] = [{ span: root, depth: 0, ancestors: [] }];
    while (stack.length) {
      const { span, depth, ancestors } = stack.pop()!;
      if (byId.has(span.id)) continue;
      const kids = (children.get(span.id) ?? []).filter(kid => !byId.has(kid.id));
      const row: TraceRow = {
        span, depth, parentId: ancestors[0] ?? null, childIds: kids.map(kid => kid.id), ancestors,
        kind: traceKind(span, agentRootIds),
      };
      rows.push(row);
      byId.set(span.id, row);
      const next = [span.id, ...ancestors];
      for (let index = kids.length - 1; index >= 0; index--) stack.push({ span: kids[index]!, depth: depth + 1, ancestors: next });
    }
  };
  for (const root of roots) visit(root);
  for (const span of [...spans].sort(byStart)) if (!byId.has(span.id)) visit(span);

  let start = Infinity;
  let end = -Infinity;
  for (const span of spans) {
    if (Number.isFinite(span.start_time_ms)) start = Math.min(start, span.start_time_ms);
    if (Number.isFinite(span.end_time_ms)) end = Math.max(end, span.end_time_ms);
  }
  if (!Number.isFinite(start)) start = 0;
  if (!Number.isFinite(end) || end < start) end = start;
  return { rows, byId, start, end, span: Math.max(1, end - start) };
}

const PAYLOAD_SEARCH_LIMIT = 20_000;

/** Case-insensitive match on the step name, type, model, id and the first 20k characters of each payload. */
export function spanMatches(span: Span, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return false;
  const fields = [span.name, span.span_type, span.model, span.id, span.status === "ERROR" ? "error" : null];
  if (fields.some(field => field?.toLowerCase().includes(needle))) return true;
  for (const payload of [span.input_payload, span.output_payload]) {
    if (payload && payload.slice(0, PAYLOAD_SEARCH_LIMIT).toLowerCase().includes(needle)) return true;
  }
  return false;
}

export interface VisibleTrace {
  rows: TraceRow[];
  /** Ids that matched the query, in row order. */
  matches: string[];
  /** Rows shown only to keep a match or a kept kind in its tree. */
  context: Set<string>;
}

/**
 * Rows to draw. A query keeps matches plus their ancestors and ignores collapse
 * on that path; a kind filter keeps spans of the enabled kinds plus their
 * ancestors, so a nested tool call never loses its parent.
 */
export function visibleTrace(model: TraceModel, options: { collapsed: ReadonlySet<string>; kinds: ReadonlySet<TraceKind>; query: string }): VisibleTrace {
  const { collapsed, kinds, query } = options;
  const allKinds = TRACE_KINDS.every(kind => kinds.has(kind));
  const searching = query.trim().length > 0;
  const own = new Set<string>();
  const keep = new Set<string>();
  const matches: string[] = [];

  for (const row of model.rows) {
    const kindOk = allKinds || kinds.has(row.kind);
    const hit = searching && kindOk && spanMatches(row.span, query);
    if (hit) matches.push(row.span.id);
    if (searching ? hit : kindOk) {
      own.add(row.span.id);
      keep.add(row.span.id);
      for (const ancestor of row.ancestors) keep.add(ancestor);
    }
  }
  const context = new Set([...keep].filter(id => !own.has(id)));

  const rows = model.rows.filter(row => {
    if (!keep.has(row.span.id)) return false;
    if (searching) return true;
    return !row.ancestors.some(ancestor => collapsed.has(ancestor));
  });
  return { rows, matches, context };
}

/** Top-level model calls; a model call nested in another one is the same request seen twice. */
export function countedLlmSpans(spans: readonly Span[]): Span[] {
  const llmIds = new Set(spans.filter(isLlmSpan).map(span => span.id));
  return spans.filter(span => isLlmSpan(span) && !(span.parent_span_id && llmIds.has(span.parent_span_id)));
}

export function distinctModels(spans: readonly Span[]): string[] {
  const models: string[] = [];
  for (const span of [...countedLlmSpans(spans)].sort((a, b) => a.start_time_ms - b.start_time_ms)) {
    if (span.model && !models.includes(span.model)) models.push(span.model);
  }
  if (!models.length) for (const span of spans) if (span.model && !models.includes(span.model)) models.push(span.model);
  return models;
}

/** The longest non-root step, which is where a run's time actually went. */
export function slowestStep(model: TraceModel): TraceRow | null {
  let best: TraceRow | null = null;
  for (const row of model.rows) {
    if (row.depth === 0 && model.rows.length > 1) continue;
    if (!best || row.span.duration_ms > best.span.duration_ms) best = row;
  }
  return best;
}

function firstLine(text: string, limit = 120): string {
  const line = text.split(/\r?\n/).map(part => part.trim()).find(Boolean) ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

/** Error text a person can read: a JSON `{message}` or `{error}` payload is unwrapped. */
export function readableError(span: Span): string {
  const raw = spanErrorReason(span);
  if (!raw) return "";
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      for (const key of ["message", "error", "reason", "detail"]) {
        if (typeof record[key] === "string" && record[key]) return firstLine(record[key] as string);
      }
    }
    if (typeof value === "string") return firstLine(value);
  } catch { /* plain text */ }
  return firstLine(raw);
}

export interface FailureSentence {
  tone: "danger" | "warning";
  text: string;
  spanId: string;
}

/**
 * The computed headline for a run that went wrong, built from the spans alone:
 * "Failed at step 3 of 7 — run_tests: Exit code 1 after 720ms" or
 * "Completed · 1 tool error in lookup_account". Null when nothing errored.
 * Steps count non-root spans in start order, which is how the timeline reads.
 */
export function failureSentence(spans: readonly Span[], outcome: "failed" | "completed" | "running" | "other"): FailureSentence | null {
  const errored = spans.filter(span => span.status === "ERROR");
  if (!errored.length) return null;
  const model = buildTraceModel(spans);
  const steps = model.rows.filter(row => row.depth > 0 || model.rows.length === 1).map(row => row.span)
    .sort((a, b) => a.start_time_ms - b.start_time_ms || a.end_time_ms - b.end_time_ms);
  const erroredSteps = steps.filter(span => span.status === "ERROR");
  const leafFirst = (list: Span[]) => list.find(span => !(model.byId.get(span.id)?.childIds.some(id => model.byId.get(id)?.span.status === "ERROR"))) ?? list[0];
  const culprit = leafFirst(erroredSteps.length ? erroredSteps : errored)!;
  const reason = readableError(culprit);
  const where = culprit.name;
  const after = Number.isFinite(culprit.duration_ms) && culprit.duration_ms >= 0 ? ` after ${fmt(culprit.duration_ms)}` : "";

  if (outcome === "failed") {
    const index = steps.findIndex(span => span.id === culprit.id);
    const position = index >= 0 ? `step ${index + 1} of ${steps.length}` : where;
    const detail = reason ? `${where}: ${reason}` : `${where} returned an error`;
    return { tone: "danger", text: `Failed at ${position} — ${detail}${after}`, spanId: culprit.id };
  }
  const toolErrors = errored.filter(span => span.span_type === "TOOL_CALL");
  const allTools = toolErrors.length === errored.length;
  const names = [...new Set(errored.map(span => span.name))];
  const noun = allTools ? (errored.length === 1 ? "tool error" : "tool errors") : (errored.length === 1 ? "error" : "errors");
  const place = names.length === 1 ? ` in ${names[0]}` : names.length === 2 ? ` in ${names[0]} and ${names[1]}` : ` in ${names[0]} and ${names.length - 1} other steps`;
  const prefix = outcome === "completed" ? "Completed · " : outcome === "running" ? "Running · " : "";
  const why = errored.length === 1 && reason ? `: ${reason}` : "";
  return { tone: "warning", text: `${prefix}${errored.length} ${noun}${place}${why}`, spanId: culprit.id };
}
