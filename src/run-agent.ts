/**
 * The agent a run belongs to, used for grouping and filtering in the run list,
 * the overview, search and MCP tools. The run title (`display_name`, else the
 * event name, else the root span name) is a separate field.
 */

/** Attributes that name the agent explicitly: OpenTelemetry GenAI first, then OpenInference. */
export const AGENT_NAME_KEYS = ["gen_ai.agent.name", "agent.name"] as const;
export const SERVICE_NAME_KEY = "service.name";

/**
 * Root attributes larger than this are not parsed for agent hints. It matches
 * the cap run-facts applies before loading a span's attributes, so the SQL and
 * in-memory paths see the same roots.
 */
export const AGENT_HINT_ATTRIBUTE_BYTES = 3 * 64 * 1024;

export interface RootAgentHints {
  /**
   * First non-empty explicit agent attribute among the run's root spans, in
   * start order; failing that, among agent-typed direct children of a root
   * (an HTTP or workflow root wrapping "invoke_agent X"), whose attribute or
   * "invoke_agent X" span name counts. Deeper sub-agents never count.
   */
  readonly agentName: string | null;
  readonly serviceName: string | null;
  readonly agentRootName: string | null;
}

export const NO_AGENT_HINTS: RootAgentHints = Object.freeze({ agentName: null, serviceName: null, agentRootName: null });

export interface RootSpanForAgent {
  readonly name: string | null;
  readonly span_type: string | null;
  readonly attributes: Readonly<Record<string, unknown>> | null;
  /** An AGENT_ROOT span whose parent is a root span, rather than a root itself. */
  readonly child?: boolean;
}

/** Hint values are cut to this many characters, as rootAgentHintsSql cuts them, so every caller sees the same agent. */
export const AGENT_HINT_CHARS = 1024;
/** The longest derived agent in UTF-16 units, which agent filters must accept. */
export const AGENT_FILTER_CHARS = 2 * AGENT_HINT_CHARS;

const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? [...value.trim()].slice(0, AGENT_HINT_CHARS).join("").trim() || null : null;

/** OpenTelemetry GenAI names agent spans "invoke_agent {gen_ai.agent.name}"; a bare "invoke_agent" names no agent. */
function agentSpanName(name: string | null): string | null {
  const trimmed = text(name);
  if (!trimmed) return null;
  const match = /^invoke_agent(?:\s+(.*))?$/.exec(trimmed);
  return match ? text(match[1]) : trimmed;
}

const explicitAgent = (attributes: Readonly<Record<string, unknown>> | null) => AGENT_NAME_KEYS.map(key => text(attributes?.[key])).find(Boolean) ?? null;

/** Spans must be in start order (start time, then id), as the run list reads them. */
export function rootAgentHints(spans: readonly RootSpanForAgent[]): RootAgentHints {
  const roots = spans.filter(span => !span.child);
  let agentName: string | null = null;
  let serviceName: string | null = null;
  for (const root of roots) {
    agentName ??= explicitAgent(root.attributes);
    const service = text(root.attributes?.[SERVICE_NAME_KEY]);
    // OpenTelemetry SDKs fall back to "unknown_service[:process]" when no service is configured.
    if (service && !service.startsWith("unknown_service")) serviceName ??= service;
  }
  for (const child of spans) {
    if (agentName) break;
    if (!child.child || child.span_type !== "AGENT_ROOT") continue;
    agentName = explicitAgent(child.attributes) ?? (/^invoke_agent\s/.test(child.name?.trim() ?? "") ? agentSpanName(child.name) : null);
  }
  const first = roots[0];
  return { agentName, serviceName, agentRootName: first?.span_type === "AGENT_ROOT" ? agentSpanName(first.name) : null };
}

export interface RunAgentEvidence {
  readonly event_name: string | null;
  readonly name: string | null;
  /** Truthy once every root span has ended; before that `name` can be a trace id placeholder. */
  readonly finished: number | boolean | null | undefined;
  readonly hints: RootAgentHints;
}

/**
 * Priority:
 * 1. an explicit agent attribute on a root span (`gen_ai.agent.name`, `agent.name`),
 *    else on an agent span directly under a root (see RootAgentHints.agentName);
 * 2. `runphantom.event.name` without a `replay:` prefix;
 * 3. once the run has finished, the name of an agent-typed root span;
 * 4. `service.name`, unless it is an SDK default;
 * 5. once the run has finished, the root span name.
 *
 * Explicit agent attributes outrank the event name because exporters, including
 * examples/tool-agent, use `runphantom.event.name` as a per-run title such as
 * "Turn 2 · Order follow-up" while `gen_ai.agent.name` stays "support-agent".
 */
export function deriveRunAgent(run: RunAgentEvidence): string | null {
  if (run.hints.agentName) return run.hints.agentName;
  const eventName = text(run.event_name?.replace(/^replay:/i, ""));
  if (eventName) return eventName;
  if (run.finished && run.hints.agentRootName) return run.hints.agentRootName;
  if (run.hints.serviceName) return run.hints.serviceName;
  return run.finished ? text(run.name) : null;
}

const jsonPath = (key: string) => `'$."${key}"'`;

/**
 * Root spans, and AGENT_ROOT spans directly under a root, with the attributes
 * deriveRunAgent reads, extracted in SQL so callers need not load whole
 * attribute blobs. Only text values count, as in rootAgentHints.
 */
export function rootAgentHintsSql(runIdsPlaceholder: string): string {
  const guard = `octet_length(s.attributes) <= ${AGENT_HINT_ATTRIBUTE_BYTES} AND json_valid(s.attributes)`;
  const extract = (key: string, alias: string) => `CASE WHEN ${guard} AND json_type(s.attributes, ${jsonPath(key)}) = 'text' THEN substr(json_extract(s.attributes, ${jsonPath(key)}), 1, ${AGENT_HINT_CHARS}) END AS ${alias}`;
  return `SELECT s.run_id, substr(s.name, 1, ${AGENT_HINT_CHARS}) AS name, s.span_type, s.parent_span_id IS NOT NULL AS child,
      ${AGENT_NAME_KEYS.map((key, index) => extract(key, `agent_${index}`)).join(", ")}, ${extract(SERVICE_NAME_KEY, "service_name")}
    FROM spans s WHERE s.run_id IN (${runIdsPlaceholder}) AND (s.parent_span_id IS NULL OR (s.span_type = 'AGENT_ROOT'
      AND EXISTS (SELECT 1 FROM spans p WHERE p.run_id = s.run_id AND p.id = s.parent_span_id AND p.parent_span_id IS NULL)))
    ORDER BY s.run_id, s.start_time_ms IS NULL, s.start_time_ms, s.id`;
}

export interface RootAgentHintRow { run_id: string; name: string | null; span_type: string | null; child: number | boolean; service_name: unknown; [key: string]: unknown }

/** Rows of rootAgentHintsSql for one run, in the order the query returns them. */
export function hintsFromRows(rows: readonly RootAgentHintRow[]): RootAgentHints {
  return rootAgentHints(rows.map(row => {
    const attributes: Record<string, unknown> = { [SERVICE_NAME_KEY]: row.service_name };
    AGENT_NAME_KEYS.forEach((key, index) => { attributes[key] = row[`agent_${index}`]; });
    return { name: row.name, span_type: row.span_type, attributes, child: Boolean(row.child) };
  }));
}

interface QueryableDatabase { query(sql: string): { all(...params: string[]): unknown[] } }

/** Batches ids to stay under SQLite's variable limit; runs without a root span get NO_AGENT_HINTS. */
export function selectRootAgentHints(db: QueryableDatabase, runIds: readonly string[]): Map<string, RootAgentHints> {
  const rows = new Map<string, RootAgentHintRow[]>();
  for (let offset = 0; offset < runIds.length; offset += 400) {
    const batch = runIds.slice(offset, offset + 400);
    for (const row of db.query(rootAgentHintsSql(batch.map(() => "?").join(","))).all(...batch) as RootAgentHintRow[]) {
      const list = rows.get(row.run_id);
      if (list) list.push(row); else rows.set(row.run_id, [row]);
    }
  }
  return new Map(runIds.map(id => [id, rows.has(id) ? hintsFromRows(rows.get(id)!) : NO_AGENT_HINTS]));
}
