import { describe, expect, test } from "bun:test";
import { buildChatItems, outermostSubAgents, subAgentsWithin, type ChatItem } from "../app/src/components/chat-items";
import type { Span, SubAgent } from "../app/src/utils/types";

function span(o: Partial<Span> & { id: string; start: number; end: number }): Span {
  return {
    run_id: "run", name: o.id, parent_span_id: null, span_type: "TOOL_CALL", status: "OK", model: null, provider: null,
    input_payload: null, output_payload: null, input_tokens: null, output_tokens: null, attributes: null,
    ...o, start_time_ms: o.start, end_time_ms: o.end, duration_ms: o.end - o.start,
  } as Span;
}

const userInput = (text: string) => JSON.stringify([{ role: "user", content: text }]);

function agent(root: string, spanIds: string[], extra: Partial<SubAgent> = {}): SubAgent {
  return { root_span_id: root, name: root, span_ids: [root, ...spanIds], start_time_ms: 0, end_time_ms: 0, duration_ms: 0, model: null, status: "OK", llm_count: 0, tool_count: 0, total_input_tokens: 0, total_output_tokens: 0, ...extra };
}

function describeItems(items: ChatItem[]): string[] {
  return items.map(item => {
    switch (item.type) {
      case "user_msg": return `user: ${item.content}`;
      case "llm_out": return `assistant: ${item.span.output_payload}`;
      case "tool_group": return `tools: ${item.items.map(i => i.type === "tool" ? i.span.name : `agent ${i.agent.name}`).join(", ")}`;
      default: return item.type;
    }
  });
}

describe("conversation order follows causality", () => {
  // Anthropic "Refund stopped by a ledger conflict": each tool starts in the
  // same millisecond the model call that requested it ends.
  const spans = [
    span({ id: "root", span_type: "AGENT_ROOT", start: 0, end: 2616, input_payload: "Please refund me." }),
    span({ id: "chat-1", parent_span_id: "root", span_type: "LLM_GENERATION", start: 0, end: 1290,
      input_payload: userInput("Please refund me."), output_payload: "I'll look up your order." }),
    span({ id: "lookup_order", parent_span_id: "root", start: 1290, end: 1290 }),
    span({ id: "search_kb", parent_span_id: "root", start: 1290, end: 1290 }),
    span({ id: "chat-2", parent_span_id: "root", span_type: "LLM_GENERATION", start: 1290, end: 2616,
      input_payload: userInput("Please refund me."), output_payload: "I'm issuing your refund now." }),
    span({ id: "issue_refund", parent_span_id: "root", status: "ERROR", start: 2616, end: 2616 }),
  ];

  test("each reply comes before the tools it requested and after the tools it read", () => {
    expect(describeItems(buildChatItems({ spans, liveEvents: [], subAgents: [] }))).toEqual([
      "user: Please refund me.",
      "assistant: I'll look up your order.",
      "tools: lookup_order, search_kb",
      "assistant: I'm issuing your refund now.",
      "tools: issue_refund",
    ]);
  });

  test("the order does not depend on the order spans arrive in", () => {
    const reversed = buildChatItems({ spans: [...spans].reverse(), liveEvents: [], subAgents: [] });
    expect(describeItems(reversed).at(-1)).toBe("tools: issue_refund");
  });

  test("a streamed step whose tool starts before the call's span ends still reads text first", () => {
    const streamed = [
      span({ id: "chat", span_type: "LLM_GENERATION", start: 0, end: 500, input_payload: userInput("hi"), output_payload: "Checking." }),
      span({ id: "tool", start: 400, end: 450 }),
    ];
    expect(describeItems(buildChatItems({ spans: streamed, liveEvents: [], subAgents: [] }))).toEqual(["user: hi", "assistant: Checking.", "tools: tool"]);
  });
});

describe("causal order across provider shapes", () => {
  test("OpenAI: text alongside tool_calls reads before the tools, and the failed tool ends the turn", () => {
    const spans = [
      span({ id: "chat-1", span_type: "LLM_GENERATION", start: 0, end: 800, input_payload: userInput("Refund order 42."), output_payload: "Let me check order 42." }),
      span({ id: "lookup_order", start: 800, end: 820 }),
      span({ id: "chat-2", span_type: "LLM_GENERATION", start: 820, end: 1500, input_payload: userInput("Refund order 42."), output_payload: "Issuing the refund." }),
      span({ id: "issue_refund", status: "ERROR", start: 1500, end: 1500 }),
    ];
    expect(describeItems(buildChatItems({ spans, liveEvents: [], subAgents: [] }))).toEqual([
      "user: Refund order 42.",
      "assistant: Let me check order 42.",
      "tools: lookup_order",
      "assistant: Issuing the refund.",
      "tools: issue_refund",
    ]);
  });

  test("Gemini: tool-only calls carry no reply text, so the failed tool is the last thing shown", () => {
    const spans = [
      span({ id: "chat-1", span_type: "LLM_GENERATION", start: 0, end: 600, input_payload: userInput("Refund order 42.") }),
      span({ id: "lookup_order", start: 600, end: 610 }),
      span({ id: "chat-2", span_type: "LLM_GENERATION", start: 610, end: 1200, input_payload: userInput("Refund order 42.") }),
      span({ id: "issue_refund", status: "ERROR", start: 1200, end: 1200 }),
    ];
    expect(describeItems(buildChatItems({ spans, liveEvents: [], subAgents: [] }))).toEqual([
      "user: Refund order 42.",
      "tools: lookup_order, issue_refund",
    ]);
  });

  test("a model span that wraps the whole loop places its answer after the tools it consumed", () => {
    const spans = [
      span({ id: "generate", name: "ai.generateText", span_type: "LLM_GENERATION", start: 0, end: 1000,
        input_payload: userInput("Refund order 42."), output_payload: "Final answer: refund issued" }),
      span({ id: "issue_refund", parent_span_id: "generate", status: "ERROR", start: 300, end: 300 }),
    ];
    expect(describeItems(buildChatItems({ spans, liveEvents: [], subAgents: [] }))).toEqual([
      "user: Refund order 42.",
      "tools: issue_refund",
      "assistant: Final answer: refund issued",
    ]);
  });
});

describe("sub-agents in a transcript", () => {
  // orchestrator (no model call) -> planner -> reader
  const spans = [
    span({ id: "root", span_type: "AGENT_ROOT", start: 0, end: 100, input_payload: "Draft the release notes." }),
    span({ id: "planner", parent_span_id: "root", span_type: "AGENT_ROOT", start: 1, end: 90, input_payload: "Outline the notes." }),
    span({ id: "planner-chat", parent_span_id: "planner", span_type: "LLM_GENERATION", start: 2, end: 10,
      input_payload: userInput("Outline the notes."), output_payload: "Asking the reader." }),
    span({ id: "reader", parent_span_id: "planner", span_type: "AGENT_ROOT", start: 10, end: 80, input_payload: "Read CHANGELOG.md." }),
    span({ id: "reader-chat", parent_span_id: "reader", span_type: "LLM_GENERATION", start: 11, end: 20,
      input_payload: userInput("Read CHANGELOG.md."), output_payload: "Opening it." }),
    span({ id: "open_file", parent_span_id: "reader", status: "ERROR", start: 20, end: 20 }),
  ];
  const planner = agent("planner", ["planner-chat", "reader", "reader-chat", "open_file"], { name: "planner" });
  const reader = agent("reader", ["reader-chat", "open_file"], { name: "reader" });

  test("only the outermost agent gets a card and none of its prompts reach the user's bubble", () => {
    const items = buildChatItems({ spans, liveEvents: [], subAgents: [planner, reader] });
    expect(describeItems(items)).toEqual(["user: Draft the release notes.", "tools: agent planner"]);
    expect(items.find(item => item.type === "user_msg")).toEqual(expect.objectContaining({ fromAgentInput: true }));
  });

  test("a card's transcript holds its own prompt, reply and the next agent down", () => {
    expect(outermostSubAgents([reader, planner])).toEqual([planner]);
    expect(subAgentsWithin(planner, [planner, reader])).toEqual([reader]);
    const own = spans.filter(s => planner.span_ids.includes(s.id) && s.id !== "planner");
    expect(describeItems(buildChatItems({ spans: own, liveEvents: [], subAgents: subAgentsWithin(planner, [planner, reader]) })))
      .toEqual(["user: Outline the notes.", "assistant: Asking the reader.", "tools: agent reader"]);
  });

  test("an agent with no model call and no input shows no invented prompt", () => {
    const bare = spans.map(s => s.id === "root" ? { ...s, input_payload: null } : s);
    expect(describeItems(buildChatItems({ spans: bare, liveEvents: [], subAgents: [planner, reader] }))).toEqual(["tools: agent planner"]);
  });
});

describe("live reasoning", () => {
  test("reasoning streamed during a call reads before that call's reply and after the tools before it", () => {
    const spans = [
      span({ id: "chat-1", span_type: "LLM_GENERATION", start: 0, end: 100, input_payload: userInput("q"), output_payload: "Searching." }),
      span({ id: "search", start: 100, end: 150 }),
      span({ id: "chat-2", span_type: "LLM_GENERATION", start: 150, end: 300, input_payload: userInput("q"), output_payload: "Done." }),
    ];
    const liveEvents = [
      { type: "reasoning", content: "think first", timestamp: 40 },
      { type: "reasoning", content: "think again", timestamp: 200 },
    ] as never;
    const items = buildChatItems({ spans, liveEvents, subAgents: [] });
    expect(items.map(item => item.type === "reasoning" ? `reasoning: ${item.content}` : describeItems([item])[0])).toEqual([
      "user: q", "reasoning: think first", "assistant: Searching.", "tools: search", "reasoning: think again", "assistant: Done.",
    ]);
  });
});
