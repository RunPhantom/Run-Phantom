/**
 * Sub-agent detection from span trees.
 *
 * A sub-agent is detected when a TOOL_CALL span contains an LLM_GENERATION child
 * that itself contains TOOL_CALL children. This means the tool is running its own
 * agentic loop (LLM + tools), not just making a single LLM call.
 *
 * Pattern: TOOL_CALL > LLM_GENERATION > TOOL_CALL
 *
 * An agent span nested under another agent (agent -> agent hand-off, no tool
 * span between) is also a sub-agent once anything below it calls a model.
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
  /** The TOOL_CALL span that triggered this sub-agent, or the nested agent span itself */
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

/** GenAI names an agent span "invoke_agent {gen_ai.agent.name}"; a bare "invoke_agent" carries no agent name. */
function nestedAgentName(spanName: string): string | null {
  const match = /^invoke_agent(?:\s+(.*))?$/.exec(spanName.trim());
  if (!match) return spanName.trim() || null;
  return match[1]?.trim() || null;
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

  function summarise(root: SpanRow, name: string): SubAgent {
    const allSpanIds: string[] = [];
    const collected = new Set<string>();
    let llmCount = 0;
    let toolCount = 0;
    let totalIn = 0;
    let totalOut = 0;
    let model: string | null = null;
    const stack = [root.id];
    while (stack.length) {
      const id = stack.shift()!;
      if (collected.has(id)) continue;
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
        if (s.span_type === "TOOL_CALL" && s.id !== root.id) toolCount++;
      }
      stack.unshift(...(children.get(id) ?? []).map(kid => kid.id));
    }
    return {
      root_span_id: root.id,
      name,
      span_ids: allSpanIds,
      start_time_ms: root.start_time_ms,
      end_time_ms: root.end_time_ms,
      duration_ms: root.duration_ms,
      model,
      status: root.status,
      llm_count: llmCount,
      tool_count: toolCount,
      total_input_tokens: totalIn,
      total_output_tokens: totalOut,
    };
  }

  // Find TOOL_CALL spans that contain an agentic loop.
  // Detection: either strict parent-child (TOOL > LLM > TOOL),
  // or time-overlap (a TOOL_CALL whose time range contains an LLM span with TOOL children).
  for (const span of spans) {
    if (span.span_type !== "TOOL_CALL") continue;

    // Detect sub-agent patterns:
    // 1. Classic agentic loop: TOOL > LLM > TOOL (tool contains LLM that uses tools)
    // 2. Named sub-agent: TOOL > agent.subagent (Claude Agent SDK pattern — may not have tool children)
    // 3. OpenTelemetry GenAI: TOOL > invoke_agent > LLM, where the agent's model and tool calls are siblings
    const kids = children.get(span.id) ?? [];
    const llmKids = kids.filter(k => k.span_type?.includes("LLM"));
    const nestedAgent = kids.find(kid => kid.span_type === "AGENT_ROOT"
      && (children.get(kid.id) ?? []).some(grandkid => grandkid.span_type?.includes("LLM")));
    let hasAgenticLoop = nestedAgent !== undefined;
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
    agents.push(summarise(span, nestedAgent ? nestedAgentName(nestedAgent.name) ?? span.name : span.name));
  }

  // Pattern 4: agent -> agent hand-off (OpenTelemetry GenAI invoke_agent or
  // OpenInference AGENT nested under another agent, with no tool span between).
  // The span is its own root. One already wrapped by a detected TOOL_CALL is
  // covered by that tool's card.
  const toolRoots = new Set(agents.map(agent => agent.root_span_id));
  const hasAgentAncestor = (span: SpanRow) => {
    const seen = new Set<string>();
    for (let parentId = span.parent_span_id; parentId && !seen.has(parentId); parentId = spanMap.get(parentId)?.parent_span_id ?? null) {
      seen.add(parentId);
      if (spanMap.get(parentId)?.span_type === "AGENT_ROOT") return true;
    }
    return false;
  };
  const hasModelCall = (id: string) => {
    const stack = [...(children.get(id) ?? [])];
    const seen = new Set<string>();
    while (stack.length) {
      const next = stack.pop()!;
      if (seen.has(next.id)) continue;
      seen.add(next.id);
      if (next.span_type?.includes("LLM")) return true;
      stack.push(...(children.get(next.id) ?? []));
    }
    return false;
  };
  for (const span of spans) {
    if (span.span_type !== "AGENT_ROOT" || !span.parent_span_id || toolRoots.has(span.parent_span_id)) continue;
    if (!hasAgentAncestor(span) || !hasModelCall(span.id)) continue;
    agents.push(summarise(span, nestedAgentName(span.name) ?? span.id));
  }

  return agents.sort((a, b) => a.start_time_ms - b.start_time_ms);
}

