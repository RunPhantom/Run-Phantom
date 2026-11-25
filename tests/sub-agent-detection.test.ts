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
      row("researcher", "delegate", "AGENT_ROOT"),
      row("chat-1", "researcher", "LLM_GENERATION", { model: "gpt-5-nano", input_tokens: 100, output_tokens: 20 }),
      row("search", "researcher", "TOOL_CALL"),
      row("chat-2", "researcher", "LLM_GENERATION", { model: "gpt-5-nano", input_tokens: 150, output_tokens: 30 }),
    ];
    expect(detectSubAgents(spans)).toEqual([expect.objectContaining({
      root_span_id: "delegate", name: "delegate", span_ids: ["delegate", "researcher", "chat-1", "search", "chat-2"],
      model: "gpt-5-nano", llm_count: 2, tool_count: 1, total_input_tokens: 250, total_output_tokens: 50,
    })]);
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
