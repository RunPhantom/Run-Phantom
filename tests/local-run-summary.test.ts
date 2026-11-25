import { expect, test } from "bun:test";
import { localRunSummary } from "../app/src/utils/run-summary";

const span = (name: string, span_type: string, status = "OK", model: string | null = null) => ({ name, span_type, status, model });

test("summarizes the question, tools, model calls and failures without any provider", () => {
  expect(localRunSummary({ name: "code_review_agent", userInput: "Review PR #842: refactor auth middleware.", spans: [
    span("code_review_agent", "AGENT_ROOT", "ERROR"), span("ai.generateText", "LLM_GENERATION", "OK", "claude-sonnet-4-5"),
    span("run_tests", "TOOL_CALL", "ERROR"), span("read_file", "TOOL_CALL"), span("read_file", "TOOL_CALL"), span("search_repo", "TOOL_CALL"),
    span("ai.generateText", "LLM_GENERATION", "OK", "claude-sonnet-4-5"),
  ] })).toBe("Asked “Review PR #842: refactor auth middleware.” Used 4 tool calls (run_tests, read_file, search_repo). 2 model calls with claude-sonnet-4-5. Failed: run_tests.");
});

test("is deterministic, bounded and falls back to the run name", () => {
  const input = { name: "triage_agent", userInput: `  ${"very long question ".repeat(20)}\n`, spans: [span("chat", "LLM_GENERATION", "OK", null), span("triage_agent", "AGENT_ROOT", "ERROR")] };
  const first = localRunSummary(input);
  expect(localRunSummary(input)).toBe(first);
  expect(first).toMatch(/^Asked “very long question .{0,80}…” 1 model call\. The run reported an error\.$/);
  expect(localRunSummary({ name: "triage_agent", userInput: null, spans: [] })).toBe("triage_agent run.");
  expect(localRunSummary({ name: "a", userInput: null, spans: ["a", "b", "c", "d", "e"].map(name => span(name, "TOOL_CALL")) })).toBe("a run. Used 5 tool calls (a, b, c and 2 more).");
});
