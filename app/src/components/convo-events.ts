import { isActive } from "../utils/helpers";
import { messagesFromSpan } from "../utils/messageParsing";
import type { Run, Span, SubAgent } from "../utils/types";

/** `owner` maps each of the agent's spans to its root, for the card's focus requests. */
export type ConvoToolItem = { kind: "tool"; span: Span } | { kind: "sub_agent"; agent: SubAgent; owner: Map<string, string> };

/** A single event in the conversation stream */
export type ConvoEvent =
  | { type: "turn_start"; turnIndex: number; run: Run; time: number }
  | { type: "user_msg"; content: string; time: number; turnIndex: number }
  | { type: "tool_group"; spans: Span[]; items: ConvoToolItem[]; turnSpans: Span[]; time: number; turnIndex: number }
  | { type: "llm_out"; content: string; time: number; turnIndex: number }
  | { type: "active"; time: number; turnIndex: number };

/**
 * A sub-agent's own steps belong under its card, not in the parent's
 * transcript. Only outermost agents get a card; a nested agent is part of its
 * parent's work.
 */
function outermostAgents(subAgents: readonly SubAgent[]): { agents: SubAgent[]; members: Set<string> } {
  const inner = new Set<string>();
  for (const agent of subAgents) for (const id of agent.span_ids) if (id !== agent.root_span_id) inner.add(id);
  const agents = subAgents.filter(agent => !inner.has(agent.root_span_id));
  const members = new Set<string>();
  for (const agent of agents) for (const id of agent.span_ids) if (id !== agent.root_span_id) members.add(id);
  return { agents, members };
}

export function buildConvoEvents(turns: { run: Run; spans: Span[]; subAgents?: readonly SubAgent[] }[]): ConvoEvent[] {
  const events: ConvoEvent[] = [];

  for (let i = 0; i < turns.length; i++) {
    const { run, spans: turnSpans, subAgents = [] } = turns[i];
    const { agents, members } = outermostAgents(subAgents);
    const agentRoots = new Map(agents.map(agent => [agent.root_span_id, agent]));
    const subAgentItem = (agent: SubAgent): ConvoToolItem => ({ kind: "sub_agent", agent, owner: new Map(agent.span_ids.map(id => [id, agent.root_span_id])) });
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

    const toolSpans = spans
      .filter(s => s.span_type === "TOOL_CALL")
      .sort((a, b) => a.start_time_ms - b.start_time_ms);

    // The FIRST LLM call of a turn is the one that carries the human's message.
    // Reading the last one instead surfaced whatever prompt the agent had
    // constructed by then — a continuation stub, or a sub-agent's internal
    // instructions — and presented it as something the user had typed.
    let userMsg: string | null = null;
    const inputSpan = llmSpans.find(s => {
      if (s.normalized?.kind === "llm" && s.normalized.userMessage) return true;
      return !!s.input_payload;
    }) ?? traceSpans.find(s => !!s.input_payload);
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

    const items: ConvoToolItem[] = toolSpans.map(span => {
      const agent = agentRoots.get(span.id);
      return agent ? subAgentItem(agent) : { kind: "tool", span };
    });
    for (const agent of agents) {
      if (!toolSpans.some(span => span.id === agent.root_span_id)) items.push(subAgentItem(agent));
    }
    if (items.length > 0) {
      const start = (item: ConvoToolItem) => item.kind === "tool" ? item.span.start_time_ms : item.agent.start_time_ms;
      items.sort((a, b) => start(a) - start(b));
      events.push({ type: "tool_group", spans: toolSpans, items, turnSpans, time: start(items[0]!), turnIndex: i });
    }

    // Mirror image: the LAST LLM call is the one that produced the answer. `.find`
    // over a start-time-ascending list returned the first, so a multi-step turn
    // (llm -> tool -> llm -> tool -> llm) showed the model's opening tool-call
    // decision and never the reply the user actually received.
    const lastWithOutput = <T extends { output_payload?: string | null }>(list: T[]) => {
      for (let k = list.length - 1; k >= 0; k--) if (list[k].output_payload) return list[k];
      return undefined;
    };
    const outputSpan = lastWithOutput(llmSpans)
      ?? lastWithOutput(traceSpans)
      ?? lastWithOutput(spans.filter(s => s.span_type === "INTERNAL"));
    if (outputSpan?.output_payload) {
      events.push({ type: "llm_out", content: outputSpan.output_payload, time: outputSpan.end_time_ms, turnIndex: i });
    } else if (isActive(run)) {
      events.push({ type: "active", time: Date.now(), turnIndex: i });
    }
  }

  return events;
}
