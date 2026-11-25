import { argsPreview, spanErrorReason } from "../utils/helpers";
import { messagesFromSpan } from "../utils/messageParsing";
import { parseSpanAttributes, spanFinishReasons, spanReasoningTokens, stoppedEarlyReason } from "../utils/span-evidence";
import type { LiveEvent, Span, SubAgent } from "../utils/types";
import { extractLiveToolArgs } from "./chat-flow-live";

export type ToolGroupItem = { type: "tool"; span: Span } | { type: "sub_agent"; agent: SubAgent };
export type LiveToolItem =
  | { type: "live_tool_start"; name: string; argsPreview: string | null; time: number }
  | { type: "live_tool_result"; name: string; time: number };

export type ChatItem =
  | { type: "capture"; span: Span; time: number }
  | { type: "tool"; span: Span; time: number }
  | { type: "tool_group"; items: ToolGroupItem[]; time: number; liveTools?: LiveToolItem[] }
  | { type: "sub_agent"; agent: SubAgent; time: number }
  | { type: "user_msg"; content: string; parts?: string[]; images?: string[]; time: number; independentObservation?: boolean; fromAgentInput?: boolean }
  | { type: "system_msg"; content: string; time: number; prevMessages?: { role: string; content: string }[] }
  | { type: "llm_out"; span: Span; time: number }
  | { type: "llm_stop"; span: Span; error: string | null; reason: string | null; reasoningOnly: boolean; time: number }
  | LiveToolItem
  | { type: "reasoning"; content: string; time: number; duringCall?: boolean }
  | { type: "text_delta"; content: string; time: number };

function isSyntheticPartialLlmSpan(span: Span): boolean {
  return span.id.startsWith("evt_") || span.span_type === "LLM";
}

/**
 * detectSubAgents reports nested agents too, and an outer agent's span_ids
 * include every span of the agents inside it. Only the outermost agents get a
 * card in a transcript; the inner ones render inside their parent's card.
 */
export function outermostSubAgents(subAgents: readonly SubAgent[]): SubAgent[] {
  const inner = new Set<string>();
  for (const agent of subAgents) for (const id of agent.span_ids) if (id !== agent.root_span_id) inner.add(id);
  return subAgents.filter(agent => !inner.has(agent.root_span_id));
}

/** The agents nested anywhere inside `agent`, excluding itself. */
export function subAgentsWithin(agent: SubAgent, subAgents: readonly SubAgent[]): SubAgent[] {
  const members = new Set(agent.span_ids);
  return subAgents.filter(other => other.root_span_id !== agent.root_span_id && members.has(other.root_span_id));
}

const PROMPT_SPAN_TYPES = new Set(["AGENT_ROOT", "TRACE", "TOOL_CALL"]);

/**
 * Transcript items for one agent's own spans, in causal order.
 *
 * An assistant reply sits at its LLM span's start, after that call's input and
 * before every tool the call requested: sequential agents start a tool in the
 * same millisecond the requesting call ends, so ordering replies by end time
 * drew each reply after the tools it asked for (and a failed run's last reply
 * under the failure that followed it).
 *
 * `fallbackInput` is the agent's own task (its root span's input) for agents
 * whose model calls carry no user message of their own.
 */
export function buildChatItems({ spans, liveEvents, subAgents, fallbackInput }: {
  spans: Span[]; liveEvents: LiveEvent[]; subAgents: readonly SubAgent[]; fallbackInput?: string | null;
}): ChatItem[] {
  const all: ChatItem[] = [];

  const parentSpanIds = new Set(spans.map(s => s.id));
  const doChildNames = new Set(["ai.streamText.doStream", "ai.streamText.doGenerate", "ai.generateText.doGenerate"]);
  const llmSpans: Span[] = [];
  // doStream/doGenerate children hold the full conversation history (system
  // prompt, previous messages, tool results) that the parent's ai.prompt lacks.
  const doChildrenByParent = new Map<string, Span[]>();

  const outer = outermostSubAgents(subAgents);
  const agentByRoot = new Map(outer.map(agent => [agent.root_span_id, agent]));
  const hidden = new Set(outer.flatMap(agent => agent.span_ids.filter(id => id !== agent.root_span_id)));

  for (const span of spans) {
    if (hidden.has(span.id)) continue;

    if (doChildNames.has(span.name) && span.parent_span_id && parentSpanIds.has(span.parent_span_id)) {
      const siblings = doChildrenByParent.get(span.parent_span_id) ?? [];
      siblings.push(span);
      doChildrenByParent.set(span.parent_span_id, siblings);
      continue;
    }

    const capture = span.normalized?.capture;
    if (capture?.entityKind === "prompt") {
      if (capture.userText !== null) all.push({ type: "user_msg", content: capture.userText, time: span.start_time_ms ?? 0, independentObservation: true });
      continue;
    }
    const agent = agentByRoot.get(span.id);
    if (agent) {
      all.push({ type: "sub_agent", agent, time: span.start_time_ms });
    } else if (span.span_type === "TOOL_CALL") {
      all.push({ type: "tool", span, time: span.start_time_ms });
    } else if (span.span_type?.includes("LLM")) {
      llmSpans.push(span);
      if (span.captureVisibility?.stream) all.push({ type: "capture", span, time: span.start_time_ms });
    } else if (span.span_type === "RETRIEVAL" || span.span_type === "EMBEDDING") {
      all.push({ type: "capture", span, time: span.start_time_ms });
    }
  }

  const spanById = new Map(spans.map(s => [s.id, s]));
  const toolSpans = spans.filter(s => s.span_type === "TOOL_CALL");
  const wrapsToolCalls = (llm: Span) => toolSpans.some(tool => {
    const seen = new Set<string>();
    for (let id = tool.parent_span_id; id && !seen.has(id); id = spanById.get(id)?.parent_span_id ?? null) {
      if (id === llm.id) return true;
      seen.add(id);
    }
    return false;
  });

  const hasRealOtlpLlmSpan = llmSpans.some(span => !isSyntheticPartialLlmSpan(span));
  const visibleLlmSpans = (hasRealOtlpLlmSpan ? llmSpans.filter(span => !isSyntheticPartialLlmSpan(span)) : llmSpans)
    .sort((a, b) => a.start_time_ms - b.start_time_ms);

  let prevMsgCount = 0;
  for (let i = 0; i < visibleLlmSpans.length; i++) {
    const span = visibleLlmSpans[i];
    if (span.normalized?.capture?.entityKind === "assistant") {
      all.push({ type: "llm_out", span, time: span.start_time_ms ?? 0 });
      continue;
    }
    // The last doStream/doGenerate child has the full conversation; the first
    // one carries the initial prompt without later tool-result context.
    const children = doChildrenByParent.get(span.id);
    const richestChild = children?.length ? children[children.length - 1] : null;
    const firstChild = children?.length ? children[0] : null;
    const messages = (richestChild ? messagesFromSpan(richestChild) : null) ?? messagesFromSpan(span);
    const firstMessages = (firstChild ? messagesFromSpan(firstChild) : null) ?? messagesFromSpan(span);
    if (messages && messages.length > 0) {
      const systemMsgs = messages.filter(m => m.role === "system");
      const nonSystem = messages.filter(m => m.role !== "system");
      if (i === 0) {
        const initMsgs = firstMessages ?? messages;
        const initNonSystem = initMsgs.filter(m => m.role !== "system");
        const lastUserIdx = initNonSystem.reduce((acc, m, idx) => m.role === "user" ? idx : acc, -1);
        const prevMessages = lastUserIdx > 0 ? initNonSystem.slice(0, lastUserIdx) : [];
        if (systemMsgs.length > 0 || prevMessages.length > 0) {
          all.push({ type: "system_msg", content: systemMsgs.length > 0 ? systemMsgs.map(m => m.content).join("\n\n") : "", time: span.start_time_ms - 2, prevMessages: prevMessages.length > 0 ? prevMessages : undefined });
        }
      }
      const newMsgs = i === 0 ? nonSystem : nonSystem.slice(Math.max(0, prevMsgCount - systemMsgs.length));
      const lastUser = newMsgs.filter(m => m.role === "user").pop();
      if (lastUser) all.push({ type: "user_msg", content: lastUser.content, parts: lastUser.parts, images: lastUser.images, time: span.start_time_ms });
      prevMsgCount = messages.length;
    } else if (span.input_payload) {
      all.push({ type: "user_msg", content: span.input_payload, time: span.start_time_ms });
    }
    // Each doStream/doGenerate child is a separate model call (before and
    // after tool use); fall back to the parent's output when no child has one.
    const childrenWithOutput = children?.filter(c => c.output_payload) ?? [];
    if (childrenWithOutput.length > 0) {
      for (const child of childrenWithOutput) all.push({ type: "llm_out", span: child, time: child.start_time_ms });
    } else if (span.output_payload) {
      // A span that wraps the whole loop (ai.generateText with tool children
      // and no per-call output) holds the answer written after those tools.
      all.push({ type: "llm_out", span, time: wrapsToolCalls(span) ? span.end_time_ms : span.start_time_ms });
    } else {
      // No answer text: say why when the span reports it.
      const error = span.status === "ERROR" ? spanErrorReason(span) || null : null;
      const attrs = parseSpanAttributes(span.attributes);
      const reason = stoppedEarlyReason(spanFinishReasons(attrs));
      const reasoning = spanReasoningTokens(attrs);
      if (error || reason) {
        all.push({ type: "llm_stop", span, error, reason, time: span.start_time_ms,
          reasoningOnly: reasoning !== null && span.output_tokens != null && span.output_tokens > 0 && reasoning >= span.output_tokens });
      }
    }
  }

  // An agent that hands work to sub-agents without a model call of its own
  // still has a task: its root span's input. Without this the first message a
  // reader saw was a sub-agent's internal prompt, or nothing at all.
  if (all.length > 0 && !all.some(item => item.type === "user_msg")) {
    const roots = spans
      .filter(span => !hidden.has(span.id) && (!span.parent_span_id || !parentSpanIds.has(span.parent_span_id)))
      .sort((a, b) => a.start_time_ms - b.start_time_ms);
    const root = roots.find(span => span.input_payload && PROMPT_SPAN_TYPES.has(span.span_type ?? "") && !agentByRoot.has(span.id));
    const content = root?.input_payload ?? fallbackInput ?? null;
    if (content) {
      const earliest = Math.min(...all.map(item => item.time));
      all.push({ type: "user_msg", content, time: Math.min(root?.start_time_ms ?? earliest, earliest), fromAgentInput: true });
    }
  }

  // A text_delta is superseded only when an llm_out item renders the same text
  // in its place, i.e. the delta arrived before that span ended.
  const renderedLLMEndTimes = all.flatMap(item => item.type === "llm_out" ? [item.span.end_time_ms] : []);
  const replySpans = all.flatMap(item => item.type === "llm_out" || item.type === "llm_stop" ? [item.span] : [])
    .sort((a, b) => (a.end_time_ms - a.start_time_ms) - (b.end_time_ms - b.start_time_ms));

  const completedCounts = new Map<string, number>();
  for (const s of spans) {
    if (s.span_type === "TOOL_CALL" && s.end_time_ms) {
      completedCounts.set(s.name, (completedCounts.get(s.name) ?? 0) + 1);
    }
  }
  const seenStart = new Map<string, number>();
  const seenResult = new Map<string, number>();

  for (const evt of liveEvents) {
    if (evt.type === "tool_start" || evt.type === "tool_result") {
      // tool_start carries the tool name; tool_result carries the result, so the name comes from its span.
      const name = evt.type === "tool_start"
        ? (evt.content ?? "")
        : (evt.span_id ? spanById.get(evt.span_id)?.name : null) ?? "";
      if (!name) continue;
      const map = evt.type === "tool_start" ? seenStart : seenResult;
      const n = (map.get(name) ?? 0) + 1;
      map.set(name, n);
      if (n <= (completedCounts.get(name) ?? 0)) continue;
      if (evt.type === "tool_start") {
        all.push({ type: "live_tool_start", name, argsPreview: argsPreview(extractLiveToolArgs(evt.metadata)), time: evt.timestamp });
      }
      if (evt.type === "tool_result") all.push({ type: "live_tool_result", name, time: evt.timestamp });
    } else if (evt.type === "reasoning" || evt.type === "reasoning-delta" || evt.type === "reasoning_delta") {
      // Reasoning streamed during a model call precedes that call's reply,
      // which is placed at the call's start.
      const call = replySpans.find(span => span.start_time_ms <= evt.timestamp && evt.timestamp <= span.end_time_ms);
      all.push(call
        ? { type: "reasoning", content: evt.content ?? "", time: call.start_time_ms, duringCall: true }
        : { type: "reasoning", content: evt.content ?? "", time: evt.timestamp });
    } else if (evt.type === "text_delta") {
      if (!renderedLLMEndTimes.some(t => evt.timestamp <= t)) {
        all.push({ type: "text_delta", content: evt.content ?? "", time: evt.timestamp });
      }
    }
  }

  // On a tie the input comes first, then the work, then the reply: a reply is
  // timed at its call's start, so a tool starting in that same millisecond was
  // requested by the previous call and belongs before this reply.
  const chatItemPriority = (item: ChatItem): number => {
    if (item.type === "user_msg" || item.type === "system_msg") return 0;
    if (item.type === "reasoning" && item.duringCall) return 1.5;
    if (item.type === "llm_out" || item.type === "llm_stop") return 2;
    return 1;
  };
  all.sort((a, b) => (a.time - b.time) || (chatItemPriority(a) - chatItemPriority(b)));

  const grouped: ChatItem[] = [];
  let tg: { type: "tool_group"; items: ToolGroupItem[]; time: number; liveTools?: LiveToolItem[] } | null = null;
  for (const item of all) {
    if (item.type === "tool" || item.type === "sub_agent" || item.type === "live_tool_start" || item.type === "live_tool_result") {
      if (!tg) tg = { type: "tool_group", items: [], time: item.time };
      if (item.type === "tool") tg.items.push({ type: "tool", span: item.span });
      else if (item.type === "sub_agent") tg.items.push({ type: "sub_agent", agent: item.agent });
      else { if (!tg.liveTools) tg.liveTools = []; tg.liveTools.push(item); }
    } else {
      if (tg) { grouped.push(tg); tg = null; }
      grouped.push(item);
    }
  }
  if (tg) grouped.push(tg);

  const merged: ChatItem[] = [];
  for (const item of grouped) {
    const prev = merged[merged.length - 1];
    if (item.type === "reasoning" && prev?.type === "reasoning") {
      prev.content += item.content;
    } else if (item.type === "text_delta" && prev?.type === "text_delta") {
      prev.content += item.content;
    } else {
      merged.push(item);
    }
  }
  return merged;
}
