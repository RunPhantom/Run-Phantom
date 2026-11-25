import { isActive } from "../utils/helpers";
import { messagesFromSpan } from "../utils/messageParsing";
import type { Run, Span, SubAgent } from "../utils/types";
import { buildChatItems, outermostSubAgents, type ToolGroupItem } from "./chat-items";

/** `subAgents` is every agent of the turn, so the card can nest the agents inside it. */
export type ConvoToolItem = { kind: "tool"; span: Span } | { kind: "sub_agent"; agent: SubAgent; subAgents: readonly SubAgent[] };

/** A single event in the conversation stream */
export type ConvoEvent =
  | { type: "turn_start"; turnIndex: number; run: Run; time: number }
  | { type: "user_msg"; content: string; time: number; turnIndex: number }
  | { type: "tool_group"; spans: Span[]; items: ConvoToolItem[]; turnSpans: Span[]; time: number; turnIndex: number }
  | { type: "llm_out"; content: string; time: number; turnIndex: number }
  | { type: "active"; time: number; turnIndex: number };

export function buildConvoEvents(turns: { run: Run; spans: Span[]; subAgents?: readonly SubAgent[] }[]): ConvoEvent[] {
  const events: ConvoEvent[] = [];

  for (let i = 0; i < turns.length; i++) {
    const { run, spans: turnSpans, subAgents = [] } = turns[i];
    // A sub-agent's own steps belong under its card, not in the parent's transcript.
    const agents = outermostSubAgents(subAgents);
    const members = new Set(agents.flatMap(agent => agent.span_ids.filter(id => id !== agent.root_span_id)));
    const agentRoots = new Map(agents.map(agent => [agent.root_span_id, agent]));
    const subAgentItem = (agent: SubAgent): ConvoToolItem => ({ kind: "sub_agent", agent, subAgents });
    const spans = members.size ? turnSpans.filter(span => !members.has(span.id)) : turnSpans;

    events.push({ type: "turn_start", turnIndex: i, run, time: run.started_at });

    // AI SDK runs usually have LLM spans; raw manual SDK runs may only have
    // the begin/finish TRACE span plus an INTERNAL withSpan wrapper.
    const llmSpans = spans
      .filter(s => s.span_type?.includes("LLM"))
      .sort((a, b) => a.start_time_ms - b.start_time_ms);
    const traceSpans = spans
      .filter(s => s.span_type === "TRACE")
      .sort((a, b) => a.start_time_ms - b.start_time_ms);
    // An orchestrator that only delegates makes no model call of its own; its
    // task is the input on its root agent span.
    const spanIds = new Set(spans.map(s => s.id));
    const rootAgentSpans = spans
      .filter(s => s.span_type === "AGENT_ROOT" && !agentRoots.has(s.id) && (!s.parent_span_id || !spanIds.has(s.parent_span_id)))
      .sort((a, b) => a.start_time_ms - b.start_time_ms);

    // The FIRST LLM call of a turn is the one that carries the human's message.
    // Reading the last one instead surfaced whatever prompt the agent had
    // constructed by then — a continuation stub, or a sub-agent's internal
    // instructions — and presented it as something the user had typed.
    let userMsg: string | null = null;
    const inputSpan = llmSpans.find(s => {
      if (s.normalized?.kind === "llm" && s.normalized.userMessage) return true;
      return !!s.input_payload;
    }) ?? traceSpans.find(s => !!s.input_payload) ?? rootAgentSpans.find(s => !!s.input_payload);
    if (inputSpan?.normalized?.kind === "llm" && inputSpan.normalized.userMessage) {
      userMsg = inputSpan.normalized.userMessage;
    } else if (inputSpan?.input_payload) {
      const messages = messagesFromSpan(inputSpan);
      if (messages) {
        const lastUser = [...messages].reverse().find(m => m.role === "user");
        if (lastUser) userMsg = lastUser.content;
      } else {
        userMsg = inputSpan.input_payload;
      }
    }

    if (userMsg) {
      events.push({ type: "user_msg", content: userMsg, time: run.started_at + 1, turnIndex: i });
    }

    // Replies and tool calls in causal order, the same order the Overview
    // uses: a reply sits before the tools it requested, so a failed run ends
    // on its failure rather than on a reply written before it.
    const toItem = (item: ToolGroupItem): ConvoToolItem => item.type === "tool"
      ? { kind: "tool", span: item.span }
      : subAgentItem(item.agent);
    let replied = false;
    for (const item of buildChatItems({ spans: turnSpans, liveEvents: [], subAgents })) {
      if (item.type === "tool_group" && item.items.length > 0) {
        const items = item.items.map(toItem);
        const groupSpans = items.flatMap(entry => entry.kind === "tool" ? [entry.span] : []);
        events.push({ type: "tool_group", spans: groupSpans, items, turnSpans, time: item.time, turnIndex: i });
      } else if (item.type === "llm_out" && item.span.output_payload) {
        replied = true;
        events.push({ type: "llm_out", content: item.span.output_payload, time: item.time, turnIndex: i });
      }
    }

    // A turn with no per-call reply (a raw SDK run with only a TRACE span, or
    // an orchestrator that only delegates) answers through its outer span.
    if (!replied) {
      const lastWithOutput = <T extends { output_payload?: string | null }>(list: T[]) => {
        for (let k = list.length - 1; k >= 0; k--) if (list[k].output_payload) return list[k];
        return undefined;
      };
      const outputSpan = lastWithOutput(traceSpans)
        ?? lastWithOutput(rootAgentSpans)
        ?? lastWithOutput(spans.filter(s => s.span_type === "INTERNAL"));
      if (outputSpan?.output_payload) {
        events.push({ type: "llm_out", content: outputSpan.output_payload, time: outputSpan.end_time_ms, turnIndex: i });
        continue;
      }
    }
    if (!replied && isActive(run)) events.push({ type: "active", time: Date.now(), turnIndex: i });
  }

  return events;
}
