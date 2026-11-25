import { describe, expect, test } from "bun:test";
import { detectSubAgents } from "../src/agents";

type Row = Parameters<typeof detectSubAgents>[0][number];

function row(id: string, parent: string | null, span_type: string, extra: Partial<Row> = {}): Row {
  return { id, parent_span_id: parent, name: id, span_type, start_time_ms: 0, end_time_ms: 10, duration_ms: 10, model: null, status: "OK", input_tokens: null, output_tokens: null, ...extra };
}

describe("detectSubAgents", () => {
  test("recognises the OpenTelemetry GenAI shape: execute_tool > invoke_agent > model and tool spans", () => {
    const spans = [
      row("root", null, "AGENT_ROOT"),
      row("delegate", "root", "TOOL_CALL"),
      row("researcher", "delegate", "AGENT_ROOT", { name: "invoke_agent researcher" }),
      row("chat-1", "researcher", "LLM_GENERATION", { model: "gpt-5-nano", input_tokens: 100, output_tokens: 20 }),
      row("search", "researcher", "TOOL_CALL"),
      row("chat-2", "researcher", "LLM_GENERATION", { model: "gpt-5-nano", input_tokens: 150, output_tokens: 30 }),
    ];
    expect(detectSubAgents(spans)).toEqual([expect.objectContaining({
      root_span_id: "delegate", name: "researcher", span_ids: ["delegate", "researcher", "chat-1", "search", "chat-2"],
      model: "gpt-5-nano", llm_count: 2, tool_count: 1, total_input_tokens: 250, total_output_tokens: 50,
    })]);
  });

  test("falls back to the tool name when the nested invoke_agent span names no agent", () => {
    const spans = [
      row("root", null, "AGENT_ROOT"),
      row("delegate", "root", "TOOL_CALL"),
      row("invoke_agent", "delegate", "AGENT_ROOT"),
      row("chat", "invoke_agent", "LLM_GENERATION"),
    ];
    expect(detectSubAgents(spans)).toEqual([expect.objectContaining({ root_span_id: "delegate", name: "delegate" })]);
  });

  test("does not treat a nested agent span without model calls as a sub-agent", () => {
    const spans = [
      row("root", null, "AGENT_ROOT"),
      row("tool", "root", "TOOL_CALL"),
      row("wrapper", "tool", "AGENT_ROOT"),
      row("inner-tool", "wrapper", "TOOL_CALL"),
    ];
    expect(detectSubAgents(spans)).toEqual([]);
  });
});

describe("detectSubAgents: agent -> agent hand-offs", () => {
  test("reports every nested invoke_agent span, recursively, with its own spans and usage", () => {
    const spans = [
      row("root", null, "AGENT_ROOT", { name: "invoke_agent orchestrator" }),
      row("root-chat", "root", "LLM_GENERATION", { model: "m", input_tokens: 5, output_tokens: 1 }),
      row("planner", "root", "AGENT_ROOT", { name: "invoke_agent planner", start_time_ms: 1, status: "ERROR" }),
      row("planner-chat", "planner", "LLM_GENERATION", { model: "m", input_tokens: 10, output_tokens: 2 }),
      row("list", "planner", "TOOL_CALL"),
      row("reader", "planner", "AGENT_ROOT", { name: "invoke_agent reader", start_time_ms: 2 }),
      row("reader-chat", "reader", "LLM_GENERATION", { model: "m", input_tokens: 20, output_tokens: 4 }),
      row("open", "reader", "TOOL_CALL", { status: "ERROR" }),
    ];
    const agents = detectSubAgents(spans);
    expect(agents.map(agent => agent.root_span_id)).toEqual(["planner", "reader"]);
    expect(agents[0]).toEqual(expect.objectContaining({
      name: "planner", status: "ERROR", span_ids: ["planner", "planner-chat", "list", "reader", "reader-chat", "open"],
      llm_count: 2, tool_count: 2, total_input_tokens: 30, total_output_tokens: 6,
    }));
    expect(agents[1]).toEqual(expect.objectContaining({ name: "reader", span_ids: ["reader", "reader-chat", "open"], llm_count: 1, tool_count: 1 }));
  });

  test("an agent that only delegates is a sub-agent when its descendants call a model", () => {
    const spans = [
      row("root", null, "AGENT_ROOT"),
      row("group", "root", "AGENT_ROOT", { name: "invoke_agent group" }),
      row("leaf", "group", "AGENT_ROOT", { name: "invoke_agent leaf" }),
      row("chat", "leaf", "LLM_GENERATION"),
    ];
    expect(detectSubAgents(spans).map(agent => [agent.root_span_id, agent.name])).toEqual([["group", "group"], ["leaf", "leaf"]]);
  });

  test("the top-level agent and agent spans without model calls are not sub-agents", () => {
    const spans = [
      row("root", null, "AGENT_ROOT"),
      row("chat", "root", "LLM_GENERATION"),
      row("idle", "root", "AGENT_ROOT", { name: "invoke_agent idle" }),
      row("idle-tool", "idle", "TOOL_CALL"),
    ];
    expect(detectSubAgents(spans)).toEqual([]);
  });

  test("an agent under a delegating tool is reported once, under the tool", () => {
    const spans = [
      row("root", null, "AGENT_ROOT"),
      row("delegate", "root", "TOOL_CALL"),
      row("researcher", "delegate", "AGENT_ROOT", { name: "invoke_agent researcher" }),
      row("chat", "researcher", "LLM_GENERATION"),
    ];
    expect(detectSubAgents(spans).map(agent => agent.root_span_id)).toEqual(["delegate"]);
  });

  test("the 321-span orchestrator shape yields 20 sub-agents", () => {
    const spans: Row[] = [row("root", null, "AGENT_ROOT")];
    let t = 0;
    for (let n = 0; n < 5; n++) {
      spans.push(row(`sub-${n}`, "root", "AGENT_ROOT", { name: `invoke_agent sub-${n}`, start_time_ms: t }));
      for (let m = 0; m < 3; m++) {
        spans.push(row(`sub-${n}-${m}`, `sub-${n}`, "AGENT_ROOT", { name: `invoke_agent sub-${n}-${m}`, start_time_ms: t }));
        for (let k = 0; k < 10; k++) {
          spans.push(row(`c-${n}-${m}-${k}`, `sub-${n}-${m}`, "LLM_GENERATION", { start_time_ms: t }));
          spans.push(row(`t-${n}-${m}-${k}`, `sub-${n}-${m}`, "TOOL_CALL", { start_time_ms: t }));
          t++;
        }
      }
    }
    expect(spans).toHaveLength(321);
    const agents = detectSubAgents(spans);
    expect(agents).toHaveLength(20);
    expect(agents.find(agent => agent.root_span_id === "sub-0")).toEqual(expect.objectContaining({ llm_count: 30, tool_count: 30 }));
    expect(agents.find(agent => agent.root_span_id === "sub-0-0")).toEqual(expect.objectContaining({ llm_count: 10, tool_count: 10 }));
  });
});
