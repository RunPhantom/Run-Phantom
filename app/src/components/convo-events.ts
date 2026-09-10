import { isActive } from "../utils/helpers";
import { messagesFromSpan } from "../utils/messageParsing";
import type { Run, Span } from "../utils/types";

/** A single event in the conversation stream */
export type ConvoEvent =
  | { type: "turn_start"; turnIndex: number; run: Run; time: number }
  | { type: "user_msg"; content: string; time: number; turnIndex: number }
  | { type: "tool_group"; spans: Span[]; time: number; turnIndex: number }
  | { type: "llm_out"; content: string; time: number; turnIndex: number }
  | { type: "active"; time: number; turnIndex: number };

export function buildConvoEvents(turns: { run: Run; spans: Span[] }[]): ConvoEvent[] {
  const events: ConvoEvent[] = [];

  for (let i = 0; i < turns.length; i++) {
    const { run, spans } = turns[i];

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

    if (toolSpans.length > 0) {
      events.push({ type: "tool_group", spans: toolSpans, time: toolSpans[0].start_time_ms, turnIndex: i });
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
