import { describe, expect, test } from "bun:test";
import { buildConvoEvents } from "../app/src/components/convo-events";

const span = (o: Partial<Record<string, unknown>>) => ({
  id: String(o.id), parent_id: null, name: String(o.name ?? o.id),
  span_type: o.span_type, status: "OK",
  input_payload: o.input_payload ?? null, output_payload: o.output_payload ?? null,
  start_time_ms: o.start_time_ms as number, end_time_ms: (o.start_time_ms as number) + 10,
  duration_ms: 10, tokens: { in: 0, out: 0 },
}) as never;

const run = { id: "r1", name: "agent", started_at: 1000, last_updated_at: 9000, finished: 1 } as never;

describe("conversation stream for a multi-step agent turn", () => {
  // llm -> tool -> llm -> tool -> llm, i.e. the ordinary shape this product exists
  // to debug. The user's message lives on the first call; the answer on the last.
  const spans = [
    span({ id: "llm1", span_type: "LLM", start_time_ms: 1000,
      input_payload: JSON.stringify([{ role: "user", content: "Why is checkout failing?" }]),
      output_payload: "I'll look at the logs." }),
    span({ id: "tool1", span_type: "TOOL_CALL", start_time_ms: 1100 }),
    span({ id: "llm2", span_type: "LLM", start_time_ms: 1200,
      input_payload: JSON.stringify([{ role: "user", content: "continue" }]),
      output_payload: "Checking the payment service next." }),
    span({ id: "tool2", span_type: "TOOL_CALL", start_time_ms: 1300 }),
    span({ id: "llm3", span_type: "LLM", start_time_ms: 1400,
      input_payload: JSON.stringify([{ role: "user", content: "continue" }]),
      output_payload: "Checkout fails because the Stripe webhook secret rotated." }),
  ];

  const events = buildConvoEvents([{ run, spans }]);
  const userMsg = events.find((e) => e.type === "user_msg");
  const llmOut = events.find((e) => e.type === "llm_out");

  test("shows the human's message, not a later continuation stub", () => {
    expect(userMsg && "content" in userMsg ? userMsg.content : null).toBe("Why is checkout failing?");
  });

  test("shows the final answer, not the model's opening tool-call decision", () => {
    expect(llmOut && "content" in llmOut ? llmOut.content : null)
      .toBe("Checkout fails because the Stripe webhook secret rotated.");
  });

  test("a single-step turn is unchanged", () => {
    const one = buildConvoEvents([{ run, spans: [spans[0]] }]);
    const u = one.find((e) => e.type === "user_msg");
    const o = one.find((e) => e.type === "llm_out");
    expect(u && "content" in u ? u.content : null).toBe("Why is checkout failing?");
    expect(o && "content" in o ? o.content : null).toBe("I'll look at the logs.");
  });

  test("falls back to TRACE spans when there is no LLM span", () => {
    const traceOnly = [
      span({ id: "t1", span_type: "TRACE", start_time_ms: 1000, input_payload: "hello", output_payload: "first" }),
      span({ id: "t2", span_type: "TRACE", start_time_ms: 2000, output_payload: "final" }),
    ];
    const ev = buildConvoEvents([{ run, spans: traceOnly }]);
    const o = ev.find((e) => e.type === "llm_out");
    expect(o && "content" in o ? o.content : null).toBe("final");
  });
});

describe("conversation stream for a turn that delegated to a sub-agent", () => {
  const spans = [
    span({ id: "llm1", span_type: "LLM", start_time_ms: 1000,
      input_payload: JSON.stringify([{ role: "user", content: "Is my order under warranty?" }]), output_payload: "Looking it up." }),
    span({ id: "lookup", span_type: "TOOL_CALL", start_time_ms: 1100 }),
    span({ id: "delegate", name: "delegate_research", span_type: "TOOL_CALL", start_time_ms: 1200 }),
    span({ id: "sub-llm", span_type: "LLM", start_time_ms: 1210, output_payload: "Researcher notes." }),
    span({ id: "search", name: "search_kb", span_type: "TOOL_CALL", start_time_ms: 1220 }),
    span({ id: "llm2", span_type: "LLM", start_time_ms: 1400, output_payload: "Yes, it is covered." }),
  ];
  const subAgents = [{ root_span_id: "delegate", name: "researcher", span_ids: ["delegate", "sub-llm", "search"],
    start_time_ms: 1200, end_time_ms: 1300, duration_ms: 100, model: null, status: "OK", llm_count: 1, tool_count: 1,
    total_input_tokens: 0, total_output_tokens: 0 }];
  const events = buildConvoEvents([{ run, spans, subAgents }]);
  const group = events.find(e => e.type === "tool_group");

  test("the sub-agent is one card in reading order and its own tools stay under it", () => {
    expect(group && group.type === "tool_group" ? group.items.map(item => item.kind === "tool" ? item.span.id : `agent:${item.agent.name}`) : null)
      .toEqual(["lookup", "agent:researcher"]);
  });

  test("the answer is the parent's last reply, not the sub-agent's", () => {
    const out = events.find(e => e.type === "llm_out");
    expect(out && "content" in out ? out.content : null).toBe("Yes, it is covered.");
  });
});
