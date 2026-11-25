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

  test("shows every reply between the tools, ending on the final answer", () => {
    expect(llmOut && "content" in llmOut ? llmOut.content : null).toBe("I'll look at the logs.");
    expect(events.filter(e => e.type !== "turn_start").map(e => e.type === "llm_out" ? e.content : e.type === "tool_group" ? `tools:${e.spans.map(s => s.id).join(",")}` : e.type))
      .toEqual(["user_msg", "I'll look at the logs.", "tools:tool1", "Checking the payment service next.", "tools:tool2", "Checkout fails because the Stripe webhook secret rotated."]);
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

  test("the replies are the parent's, never the sub-agent's", () => {
    expect(events.flatMap(e => e.type === "llm_out" ? [e.content] : [])).toEqual(["Looking it up.", "Yes, it is covered."]);
  });
});

describe("conversation stream for an orchestrator that hands off to nested agents", () => {
  // root invoke_agent -> invoke_agent sub-0 -> invoke_agent sub-0-0 -> chat + tool; the root makes no model call.
  const spans = [
    span({ id: "root", span_type: "AGENT_ROOT", start_time_ms: 1000, input_payload: "Find the needle.", output_payload: "Found it in shard 0-0." }),
    span({ id: "sub-0", span_type: "AGENT_ROOT", start_time_ms: 1010, input_payload: "Search shard group 0" }),
    span({ id: "sub-0-0", span_type: "AGENT_ROOT", start_time_ms: 1020, input_payload: "step 0 depth 2" }),
    span({ id: "chat", span_type: "LLM_GENERATION", start_time_ms: 1030,
      input_payload: JSON.stringify([{ role: "user", content: "step 0 depth 2" }]), output_payload: "Checking item 0." }),
    span({ id: "lookup", span_type: "TOOL_CALL", start_time_ms: 1040 }),
  ];
  const base = { start_time_ms: 1010, end_time_ms: 1100, duration_ms: 90, model: null, status: "OK", llm_count: 1, tool_count: 1, total_input_tokens: 0, total_output_tokens: 0 };
  const subAgents = [
    { ...base, root_span_id: "sub-0", name: "sub-0", span_ids: ["sub-0", "sub-0-0", "chat", "lookup"] },
    { ...base, root_span_id: "sub-0-0", name: "sub-0-0", span_ids: ["sub-0-0", "chat", "lookup"] },
  ];
  const events = buildConvoEvents([{ run, spans, subAgents }]);

  test("the user's message is the run's input, not a sub-agent's prompt", () => {
    const user = events.find(e => e.type === "user_msg");
    expect(user && "content" in user ? user.content : null).toBe("Find the needle.");
  });

  test("only the outermost sub-agent is a card, and it can reach the agents inside it", () => {
    const group = events.find(e => e.type === "tool_group");
    expect(group?.type === "tool_group" ? group.items.map(item => item.kind === "sub_agent" ? item.agent.name : item.span.id) : null).toEqual(["sub-0"]);
    expect(group?.type === "tool_group" && group.items[0].kind === "sub_agent" ? group.items[0].subAgents.length : 0).toBe(2);
  });

  test("the answer is the root agent's output", () => {
    const out = events.find(e => e.type === "llm_out");
    expect(out && "content" in out ? out.content : null).toBe("Found it in shard 0-0.");
  });
});

describe("conversation stream for a run that failed after a reply", () => {
  // Anthropic ledger-conflict shape: each tool starts in the millisecond its requesting call ends.
  const at = (o: Record<string, unknown>, end: number) => ({ ...(span(o) as object), end_time_ms: end, duration_ms: end - (o.start_time_ms as number) }) as never;
  const spans = [
    at({ id: "chat-1", span_type: "LLM_GENERATION", start_time_ms: 1000,
      input_payload: JSON.stringify([{ role: "user", content: "Refund order 42." }]), output_payload: "I'll look up your order." }, 2290),
    at({ id: "lookup_order", span_type: "TOOL_CALL", start_time_ms: 2290 }, 2290),
    at({ id: "chat-2", span_type: "LLM_GENERATION", start_time_ms: 2290, output_payload: "I'm issuing a $249 refund now." }, 3616),
    at({ id: "issue_refund", span_type: "TOOL_CALL", start_time_ms: 3616, status: "ERROR" }, 3616),
  ];
  const events = buildConvoEvents([{ run, spans }]);

  test("ends on the failed tool, not on the reply written before it", () => {
    expect(events.filter(e => e.type !== "turn_start").map(e => e.type === "llm_out" ? e.content : e.type === "tool_group" ? `tools:${e.spans.map(s => s.id).join(",")}` : e.type))
      .toEqual(["user_msg", "I'll look up your order.", "tools:lookup_order", "I'm issuing a $249 refund now.", "tools:issue_refund"]);
  });
});
