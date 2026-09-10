/**
 * Sub-agent detection from span trees.
 *
 * A sub-agent is detected when a TOOL_CALL span contains an LLM_GENERATION child
 * that itself contains TOOL_CALL children. This means the tool is running its own
 * agentic loop (LLM + tools), not just making a single LLM call.
 *
 * Pattern: TOOL_CALL > LLM_GENERATION > TOOL_CALL
 */

interface SpanRow {
  id: string;
  parent_span_id: string | null;
  name: string;
  span_type: string | null;
  start_time_ms: number;
  end_time_ms: number;
  duration_ms: number;
  model: string | null;
  status: string;
  input_tokens: number | null;
  output_tokens: number | null;
}

export interface SubAgent {
  /** The TOOL_CALL span that triggered this sub-agent */
  root_span_id: string;
  /** Name of the tool / agent */
  name: string;
  /** All span IDs that belong to this sub-agent (including the root) */
  span_ids: string[];
  start_time_ms: number;
  end_time_ms: number;
  duration_ms: number;
  /** Model used (from the first LLM child) */
  model: string | null;
  status: string;
  llm_count: number;
  tool_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
}

export function detectSubAgents(spans: SpanRow[]): SubAgent[] {
  const children = new Map<string, SpanRow[]>();
  const spanMap = new Map<string, SpanRow>();
  for (const s of spans) {
    spanMap.set(s.id, s);
    if (s.parent_span_id) {
      const kids = children.get(s.parent_span_id) ?? [];
      kids.push(s);
      children.set(s.parent_span_id, kids);
    }
  }

  const agents: SubAgent[] = [];

  // Find TOOL_CALL spans that contain an agentic loop.
  // Detection: either strict parent-child (TOOL > LLM > TOOL),
  // or time-overlap (a TOOL_CALL whose time range contains an LLM span with TOOL children).
  for (const span of spans) {
    if (span.span_type !== "TOOL_CALL") continue;

    // Detect sub-agent patterns:
    // 1. Classic agentic loop: TOOL > LLM > TOOL (tool contains LLM that uses tools)
    // 2. Named sub-agent: TOOL > agent.subagent (Claude Agent SDK pattern — may not have tool children)
    const kids = children.get(span.id) ?? [];
    const llmKids = kids.filter(k => k.span_type?.includes("LLM"));
    let hasAgenticLoop = false;
    for (const llm of llmKids) {
      // Pattern 1: LLM child has TOOL grandchildren
      const grandkids = children.get(llm.id) ?? [];
      if (grandkids.some(g => g.span_type === "TOOL_CALL")) {
        hasAgenticLoop = true;
        break;
      }
      // Pattern 2: LLM child is explicitly named as a sub-agent
      if (llm.name === "agent.subagent") {
        hasAgenticLoop = true;
        break;
      }
    }

    if (!hasAgenticLoop) continue;

    // Collect all descendant span IDs — by parent-child AND time overlap
    const allSpanIds: string[] = [];
    const collected = new Set<string>();
    let llmCount = 0;
    let toolCount = 0;
    let totalIn = 0;
    let totalOut = 0;
    let model: string | null = null;

    function collect(id: string) {
      if (collected.has(id)) return;
      collected.add(id);
      allSpanIds.push(id);
      const s = spanMap.get(id);
      if (s) {
        if (s.span_type?.includes("LLM")) {
          llmCount++;
          if (!model && s.model) model = s.model;
          if (s.input_tokens) totalIn += s.input_tokens;
          if (s.output_tokens) totalOut += s.output_tokens;
        }
        if (s.span_type === "TOOL_CALL" && s.id !== span.id) toolCount++;
      }
      for (const kid of children.get(id) ?? []) collect(kid.id);
    }
    collect(span.id);

    agents.push({
      root_span_id: span.id,
      name: span.name,
      span_ids: allSpanIds,
      start_time_ms: span.start_time_ms,
      end_time_ms: span.end_time_ms,
      duration_ms: span.duration_ms,
      model,
      status: span.status,
      llm_count: llmCount,
      tool_count: toolCount,
      total_input_tokens: totalIn,
      total_output_tokens: totalOut,
    });
  }

  return agents;
}
