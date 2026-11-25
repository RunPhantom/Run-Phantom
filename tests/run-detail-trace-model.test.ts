import { describe, expect, test } from "bun:test";
import {
  buildTraceModel,
  countedLlmSpans,
  countedToolSpans,
  shortModelName,
  spanErrorText,
  spanMatches,
  distinctModels,
  failureSentence,
  readableError,
  slowestStep,
  traceKind,
  visibleTrace,
  TRACE_KINDS,
  type TraceKind,
} from "../app/src/components/run-detail/trace-model";
import type { Span } from "../app/src/utils/types";

function span(id: string, overrides: Partial<Span> = {}): Span {
  const start = overrides.start_time_ms ?? 0;
  const duration = overrides.duration_ms ?? 10;
  return {
    id, run_id: "run", parent_span_id: null, name: id, span_type: "INTERNAL", status: "OK",
    input_payload: null, output_payload: null, start_time_ms: start, end_time_ms: start + duration,
    duration_ms: duration, model: null, provider: null, input_tokens: null, output_tokens: null, attributes: null,
    ...overrides,
  };
}

// root -> plan (LLM), run_tests (TOOL, error) -> bun (TOOL, error), summarise (LLM)
const trace = [
  span("root", { span_type: "AGENT_ROOT", name: "code_review_agent", start_time_ms: 0, duration_ms: 6200 }),
  span("plan", { parent_span_id: "root", span_type: "LLM_GENERATION", name: "Plan review", start_time_ms: 100, duration_ms: 1300, model: "claude-sonnet-4-5", input_tokens: 2000, output_tokens: 200 }),
  span("tests", { parent_span_id: "root", span_type: "TOOL_CALL", name: "run_tests", status: "ERROR", start_time_ms: 1500, duration_ms: 720, output_payload: "{\"message\":\"Exit code 1. 2 tests failed\"}" }),
  span("bun", { parent_span_id: "tests", span_type: "TOOL_CALL", name: "bun test auth/", status: "ERROR", start_time_ms: 1510, duration_ms: 680, output_payload: "Exit code 1\nstack..." }),
  span("summary", { parent_span_id: "root", span_type: "LLM_GENERATION", name: "Summarise", start_time_ms: 2300, duration_ms: 2000, model: "claude-sonnet-4-5", input_tokens: 2936, output_tokens: 228 }),
  span("nested", { parent_span_id: "summary", span_type: "LLM_GENERATION", name: "doGenerate", start_time_ms: 2310, duration_ms: 1900, model: "claude-sonnet-4-5" }),
];

const all = new Set<TraceKind>(TRACE_KINDS);

describe("trace model", () => {
  test("rows are depth-first with children in start order and nesting depth", () => {
    const shuffled = [trace[4], trace[2], trace[0], trace[5], trace[1], trace[3]];
    const model = buildTraceModel(shuffled);
    expect(model.rows.map(row => [row.span.id, row.depth])).toEqual([
      ["root", 0], ["plan", 1], ["tests", 1], ["bun", 2], ["summary", 1], ["nested", 2],
    ]);
    expect(model.byId.get("bun")!.ancestors).toEqual(["tests", "root"]);
    expect(model.start).toBe(0);
    expect(model.end).toBe(6200);
  });

  test("a parent cycle keeps every span instead of looping or dropping them", () => {
    const cyclic = [span("a", { parent_span_id: "b" }), span("b", { parent_span_id: "a", start_time_ms: 5 })];
    const model = buildTraceModel(cyclic);
    expect(model.rows.map(row => row.span.id).sort()).toEqual(["a", "b"]);
  });

  test("kinds come from the span type, and sub-agent roots are agents", () => {
    expect(traceKind(trace[0]!)).toBe("agent");
    expect(traceKind(trace[1]!)).toBe("llm");
    expect(traceKind(trace[2]!)).toBe("tool");
    expect(traceKind(span("x", { span_type: "TOOL_CALL" }), new Set(["x"]))).toBe("agent");
    expect(traceKind(span("y"))).toBe("other");
  });

  test("collapse hides descendants but search shows matches with their ancestors", () => {
    const model = buildTraceModel(trace);
    const collapsed = visibleTrace(model, { collapsed: new Set(["tests"]), kinds: all, query: "" });
    expect(collapsed.rows.map(row => row.span.id)).toEqual(["root", "plan", "tests", "summary", "nested"]);

    const found = visibleTrace(model, { collapsed: new Set(["tests"]), kinds: all, query: "BUN TEST" });
    expect(found.matches).toEqual(["bun"]);
    expect(found.rows.map(row => row.span.id)).toEqual(["root", "tests", "bun"]);
    expect([...found.context].sort()).toEqual(["root", "tests"]);
  });

  test("search reads payloads, and an error status matches 'error'", () => {
    const model = buildTraceModel(trace);
    expect(visibleTrace(model, { collapsed: new Set(), kinds: all, query: "tests failed" }).matches).toEqual(["tests"]);
    expect(visibleTrace(model, { collapsed: new Set(), kinds: all, query: "error" }).matches).toEqual(["tests", "bun"]);
  });

  test("a kind filter keeps the ancestors of the kept spans as context", () => {
    const model = buildTraceModel(trace);
    const tools = visibleTrace(model, { collapsed: new Set(), kinds: new Set<TraceKind>(["tool"]), query: "" });
    expect(tools.rows.map(row => row.span.id)).toEqual(["root", "tests", "bun"]);
    expect([...tools.context]).toEqual(["root"]);
  });

  test("model calls nested in another model call are counted once", () => {
    expect(countedLlmSpans(trace).map(s => s.id)).toEqual(["plan", "summary"]);
    expect(distinctModels(trace)).toEqual(["claude-sonnet-4-5"]);
  });

  test("the slowest step skips the root", () => {
    expect(slowestStep(buildTraceModel(trace))!.span.id).toBe("summary");
  });
});

describe("failure sentence", () => {
  test("a failed run names the innermost failing step, its position, reason and duration", () => {
    expect(failureSentence(trace, "failed")).toEqual({
      tone: "danger",
      text: "Failed at step 3 of 5 — bun test auth/ (680ms): Exit code 1",
      fullText: "Failed at step 3 of 5 — bun test auth/ (680ms): Exit code 1",
      spanId: "bun",
    });
  });

  test("a completed run with tool errors says where they happened", () => {
    expect(failureSentence(trace, "completed")).toEqual({
      tone: "warning",
      text: "Completed · 2 tool errors in run_tests and bun test auth/",
      fullText: "Completed · 2 tool errors in run_tests and bun test auth/",
      spanId: "bun",
    });
    const one = [trace[0]!, { ...trace[2]!, output_payload: "timeout" }];
    expect(failureSentence(one, "completed")!.text).toBe("Completed · 1 tool error in run_tests: timeout");
    expect(failureSentence(one, "other")!.text).toBe("1 tool error in run_tests: timeout");
  });

  test("a run without errors has no sentence", () => {
    expect(failureSentence(trace.map(s => ({ ...s, status: "OK" })), "failed")).toBeNull();
  });

  test("errors read from JSON messages or the first line of text", () => {
    expect(readableError(trace[2]!)).toBe("Exit code 1. 2 tests failed");
    expect(readableError(trace[3]!)).toBe("Exit code 1");
    expect(readableError(span("attr", { status: "ERROR", attributes: JSON.stringify({ "error.message": "boom" }) }))).toBe("boom");
  });
});

describe("shared counts and labels", () => {
  test("a tool call that started a sub-agent counts as the agent, not also as a tool", () => {
    const spans = [
      span("root", { span_type: "AGENT_ROOT" }),
      span("lookup", { parent_span_id: "root", span_type: "TOOL_CALL" }),
      span("delegate", { parent_span_id: "root", span_type: "TOOL_CALL", name: "delegate_research" }),
      span("search", { parent_span_id: "delegate", span_type: "TOOL_CALL" }),
    ];
    const roots = new Set(["delegate"]);
    expect(countedToolSpans(spans, roots).map(s => s.id)).toEqual(["lookup", "search"]);
    const kinds = buildTraceModel(spans, roots).rows.filter(row => row.kind === "tool").map(row => row.span.id);
    expect(kinds).toEqual(countedToolSpans(spans, roots).map(s => s.id));
  });

  test("model names drop a provider prefix and a date stamp", () => {
    expect(shortModelName("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(shortModelName("openai/gpt-4o-mini-2024-07-18")).toBe("gpt-4o-mini");
    expect(shortModelName("gemini-3.8-flash")).toBe("gemini-3.8-flash");
  });

  test("search matches payload text and sees a replaced span's new payload", () => {
    const first = span("s", { input_payload: "Find the Refund ledger" });
    expect(spanMatches(first, "refund")).toBe(true);
    expect(spanMatches({ ...first, input_payload: "nothing" }, "refund")).toBe(false);
  });
});

describe("error text", () => {
  test("the status message wins over ordinary output content", () => {
    const failed = span("evil", { status: "ERROR", output_payload: "# Heading\n\nbody", attributes: JSON.stringify({ "otel.status.message": "renderer failed hard" }) });
    expect(spanErrorText(failed)).toBe("renderer failed hard");
    expect(readableError(failed)).toBe("renderer failed hard");
    expect(failureSentence([failed], "completed")!.text).toBe("Completed · 1 error in evil: renderer failed hard");
  });

  test("the output is the reason when the span carries no status message", () => {
    expect(spanErrorText(span("x", { status: "ERROR", output_payload: "Exit code 2" }))).toBe("Exit code 2");
  });

  test("a long reason is cut in the sentence but kept whole in fullText, with the duration before it", () => {
    const reason = "Payments ledger rejected the refund because ".repeat(6).trim();
    const failed = span("refund", { name: "issue_refund", status: "ERROR", duration_ms: 1, output_payload: reason });
    const sentence = failureSentence([span("root", { span_type: "AGENT_ROOT" }), { ...failed, parent_span_id: "root" }], "failed")!;
    expect(sentence.text.startsWith("Failed at step 1 of 1 — issue_refund (1ms): Payments ledger")).toBe(true);
    expect(sentence.text.length).toBeLessThan(sentence.fullText.length);
    expect(sentence.fullText.endsWith(reason)).toBe(true);
  });
});
