import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MAX_STEPS, runTurn, type TurnResult } from "../examples/tool-agent/agent";
import { observedOutcome, SCENARIOS } from "../examples/tool-agent/scenarios";
import { checkInventory, FatalToolError, issueRefund, lookupOrder, searchKb, ToolError } from "../examples/tool-agent/tools";
import { detectSubAgents } from "../src/agents";
import { parseOtlpRequest, type ParsedSpan } from "../src/parse";
import { spanCost } from "../src/pricing/span-cost";
import { runErrorEvidenceFromSpans } from "../src/run-status";

const OTLP_URL = "http://127.0.0.1:59999/v1/traces";
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };

type Reply = { status?: number; body: unknown };
let replies: Reply[] = [];
let providerRequests: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
let exports: unknown[] = [];

beforeEach(() => {
  replies = [];
  providerRequests = [];
  exports = [];
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = OTLP_URL;
  process.env.OPENAI_API_KEY = "test-openai";
  process.env.ANTHROPIC_API_KEY = "test-anthropic";
  process.env.GEMINI_API_KEY = "test-gemini";
  delete process.env.OPENAI_BASE_URL;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url === OTLP_URL) {
      exports.push(body);
      return new Response("{}");
    }
    providerRequests.push({ url, headers: init?.headers as Record<string, string>, body });
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected provider call to ${url}`);
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...savedEnv };
});

const openAiToolCall = (calls: { id: string; name: string; args: unknown }[], usage = { prompt_tokens: 400, completion_tokens: 60 }) => ({
  body: {
    id: "chatcmpl-1", model: "gpt-5-nano-2025-08-07",
    choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) } }],
    usage: { ...usage, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 32 } },
  },
});
const openAiText = (text: string) => ({
  body: {
    id: "chatcmpl-2", model: "gpt-5-nano-2025-08-07",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }],
    usage: { prompt_tokens: 700, completion_tokens: 90, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 40 } },
  },
});

function exported(index = 0): ParsedSpan[] {
  return parseOtlpRequest(exports[index]);
}

function byType(spans: ParsedSpan[], type: string): ParsedSpan[] {
  return spans.filter((span) => span.spanType === type);
}

function evidence(spans: ParsedSpan[]) {
  return runErrorEvidenceFromSpans(spans.map((span) => ({ parent_span_id: span.parentSpanId ?? null, span_type: span.spanType, status: span.status })));
}

describe("tool-agent example: deterministic tools", () => {
  test("lookup, inventory, refund and search answer the same way every time", () => {
    expect(lookupOrder({ order_id: "a1001" })).toMatchObject({ found: true, order_id: "A1001", total_usd: 89, status: "delivered" });
    expect(lookupOrder({ order_id: "Z9" })).toMatchObject({ found: false });
    expect(checkInventory({ sku: "hp-110" })).toMatchObject({ known: true, available: 42 });
    expect(issueRefund({ order_id: "A1001", amount_usd: 89, reason: "damaged" })).toEqual({
      refunded: true, refund_id: "rf_A1001_8900", order_id: "A1001", amount_usd: 89, reason: "damaged", arrives_in: "3-5 business days",
    });
    expect(issueRefund({ order_id: "A1003", amount_usd: 132, reason: "changed_mind" })).toMatchObject({ refunded: false, policy: "kb-refunds" });
    expect(issueRefund({ order_id: "A1002", amount_usd: 10, reason: "changed_mind" })).toMatchObject({ refunded: false, policy: "kb-shipping" });
    expect(searchKb({ query: "warranty charging" }).results[0]?.id).toBe("kb-warranty");
  });

  test("fails deterministically for the documented inputs", () => {
    expect(() => checkInventory({ sku: "KB-200" })).toThrow(ToolError);
    expect(() => issueRefund({ order_id: "A1001", amount_usd: 500, reason: "damaged" })).toThrow(/totals \$89.00/);
    let fatal: unknown;
    try { issueRefund({ order_id: "A1005", amount_usd: 249, reason: "lost_in_transit" }); } catch (error) { fatal = error; }
    expect(fatal).toBeInstanceOf(FatalToolError);
    expect((fatal as FatalToolError).type).toBe("ledger_write_conflict");
  });
});

describe("tool-agent example: exported traces", () => {
  test("an OpenAI refund run exports GenAI spans that Run Phantom reads as a complete run with priced usage", async () => {
    replies = [
      openAiToolCall([{ id: "call_a", name: "lookup_order", args: { order_id: "A1001" } }]),
      openAiToolCall([{ id: "call_b", name: "issue_refund", args: { order_id: "A1001", amount_usd: 89, reason: "damaged" } }]),
      openAiText("Refunded $89 for order A1001."),
    ];
    const result = await runTurn("Refund A1001, it arrived cracked.", { provider: "openai", conversationId: "conv_test", eventName: "Refund test" });

    expect(result).toMatchObject({ ok: true, text: "Refunded $89 for order A1001.", steps: 3 });
    expect(result.toolCalls.map((call) => [call.name, call.ok])).toEqual([["lookup_order", true], ["issue_refund", true]]);
    expect(providerRequests[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(providerRequests[0]!.body).toMatchObject({ model: "gpt-5-nano", store: false });
    const secondMessages = providerRequests[1]!.body.messages as Record<string, unknown>[];
    expect(secondMessages.at(-1)).toEqual({ role: "tool", tool_call_id: "call_a", content: JSON.stringify(lookupOrder({ order_id: "A1001" })) });

    const spans = exported();
    const [root] = byType(spans, "AGENT_ROOT");
    expect(root).toMatchObject({ name: "invoke_agent support-agent", eventName: "Refund test", convoId: "conv_test", status: "OK", inputPayload: "Refund A1001, it arrived cracked." });
    expect(root!.parentSpanId).toBeUndefined();

    const llms = byType(spans, "LLM_GENERATION");
    expect(llms).toHaveLength(3);
    for (const llm of llms) {
      expect(llm.parentSpanId).toBe(root!.spanId);
      expect(llm).toMatchObject({ model: "gpt-5-nano-2025-08-07", provider: "openai", status: "OK" });
      expect(llm.attributes["gen_ai.operation.name"]).toBe("chat");
      expect(llm.attributes["gen_ai.request.model"]).toBe("gpt-5-nano");
      expect(spanCost({ model: llm.model ?? null, provider: llm.provider ?? null, input_tokens: llm.inputTokens ?? null, output_tokens: llm.outputTokens ?? null, attributes: JSON.stringify(llm.attributes), start_time_ms: llm.startTimeMs }).source).toBe("list-price");
    }
    expect(llms[0]).toMatchObject({ inputTokens: 400, outputTokens: 60 });
    expect(llms[0]!.attributes["gen_ai.usage.output_tokens.reasoning"]).toBe(32);
    const lastLlm = llms[2]!.normalized;
    expect(lastLlm.kind).toBe("llm");
    if (lastLlm.kind === "llm") {
      expect(lastLlm.systemPrompt).toContain("customer support agent");
      expect(lastLlm.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
    }
    expect(llms[2]!.outputPayload).toBe("Refunded $89 for order A1001.");

    const tools = byType(spans, "TOOL_CALL");
    expect(tools.map((tool) => tool.name)).toEqual(["lookup_order", "issue_refund"]);
    expect(tools[1]!.normalized).toMatchObject({ kind: "tool", name: "issue_refund", args: { order_id: "A1001", amount_usd: 89, reason: "damaged" }, resultIsError: false });
    expect(evidence(spans)).toEqual({ error_count: 0, tool_error_count: 0, root_failed: false });
  });

  test("an Anthropic run recovers from a failing tool, sends is_error back and completes with one tool error", async () => {
    replies = [
      { body: { id: "msg_1", model: "claude-haiku-4-5-20251001", stop_reason: "tool_use", content: [{ type: "text", text: "Checking stock." }, { type: "tool_use", id: "toolu_1", name: "check_inventory", input: { sku: "KB-200" } }], usage: { input_tokens: 900, output_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } },
      { body: { id: "msg_2", model: "claude-haiku-4-5-20251001", stop_reason: "end_turn", content: [{ type: "text", text: "I could not confirm KB-200 stock right now." }], usage: { input_tokens: 1000, output_tokens: 30 } } },
    ];
    const result = await runTurn("Swap for KB-200?", { provider: "anthropic", conversationId: "conv_inv" });

    expect(result.ok).toBe(true);
    expect(result.toolCalls).toEqual([{ name: "check_inventory", arguments: { sku: "KB-200" }, ok: false, error: expect.stringContaining("timed out") }]);
    expect(providerRequests[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(providerRequests[0]!.body).toMatchObject({ model: "claude-haiku-4-5-20251001", system: expect.stringContaining("support agent") });
    const followUp = providerRequests[1]!.body.messages as { role: string; content: Record<string, unknown>[] }[];
    expect(followUp.at(-1)).toMatchObject({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true }] });

    const spans = exported();
    const [tool] = byType(spans, "TOOL_CALL");
    expect(tool).toMatchObject({ name: "check_inventory", status: "ERROR" });
    expect(tool!.attributes["otel.status.message"]).toContain("warehouse eu-west-2");
    expect(tool!.attributes["error.type"]).toBe("upstream_timeout");
    expect(tool!.normalized).toMatchObject({ kind: "tool", resultIsError: true });
    const [firstLlm] = byType(spans, "LLM_GENERATION");
    expect(firstLlm).toMatchObject({ provider: "anthropic", inputTokens: 1000, outputTokens: 50 });
    expect(firstLlm!.attributes["gen_ai.usage.cache_read.input_tokens"]).toBe(100);
    expect(evidence(spans)).toEqual({ error_count: 1, tool_error_count: 1, root_failed: false });
    expect(observedOutcome(result)).toBe("completed_with_errors");
  });

  test("a Gemini run stops on a fatal tool error, echoes thought signatures and fails the run", async () => {
    replies = [
      { body: { modelVersion: "gemini-2.5-flash", responseId: "r1", candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ functionCall: { name: "lookup_order", args: { order_id: "A1005" } }, thoughtSignature: "sig-1" }] } }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 20, thoughtsTokenCount: 80 } } },
      { body: { modelVersion: "gemini-2.5-flash", responseId: "r2", candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ functionCall: { id: "fc-2", name: "issue_refund", args: { order_id: "A1005", amount_usd: 249, reason: "lost_in_transit" } } }] } }], usageMetadata: { promptTokenCount: 650, candidatesTokenCount: 25 } } },
    ];
    const result = await runTurn("Refund A1005, it was lost.", { provider: "gemini", conversationId: "conv_gem" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("issue_refund failed and the run was stopped");
    expect(providerRequests[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(providerRequests[0]!.headers["x-goog-api-key"]).toBe("test-gemini");
    const contents = providerRequests[1]!.body.contents as { role: string; parts: Record<string, unknown>[] }[];
    expect(contents[1]).toEqual({ role: "model", parts: [{ functionCall: { name: "lookup_order", args: { order_id: "A1005" } }, thoughtSignature: "sig-1" }] });
    expect(contents[2]).toMatchObject({ role: "user", parts: [{ functionResponse: { name: "lookup_order", response: { found: true, order_id: "A1005" } } }] });
    expect(contents[2]!.parts[0]!.functionResponse).not.toHaveProperty("id");

    const spans = exported();
    const [root] = byType(spans, "AGENT_ROOT");
    expect(root).toMatchObject({ status: "ERROR" });
    expect(root!.attributes["otel.status.message"]).toContain("ledger rejected refund");
    const [llm] = byType(spans, "LLM_GENERATION");
    expect(llm).toMatchObject({ provider: "gcp.gemini", model: "gemini-2.5-flash", inputTokens: 500, outputTokens: 100 });
    expect(llm!.attributes["gen_ai.operation.name"]).toBe("generate_content");
    expect(byType(spans, "TOOL_CALL").map((tool) => [tool.name, tool.status])).toEqual([["lookup_order", "OK"], ["issue_refund", "ERROR"]]);
    expect(evidence(spans)).toEqual({ error_count: 2, tool_error_count: 1, root_failed: true });
  });

  test("a provider error fails the run with the provider's message on the model span", async () => {
    replies = [{ status: 404, body: { error: { code: 404, message: "This model models/gemini-2.5-flash is no longer available to new users.", status: "NOT_FOUND" } } }];
    const result = await runTurn("Where is A1002?", { provider: "gemini", conversationId: "conv_404" });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("gemini returned HTTP 404: This model models/gemini-2.5-flash is no longer available to new users.");
    const spans = exported();
    const [llm] = byType(spans, "LLM_GENERATION");
    expect(llm).toMatchObject({ status: "ERROR", inputTokens: undefined, outputTokens: undefined });
    expect(llm!.attributes["error.type"]).toBe("404");
    expect(evidence(spans).root_failed).toBe(true);
  });

  test("the subagent mode nests a researcher agent under the delegating tool call", async () => {
    replies = [
      openAiToolCall([{ id: "call_d", name: "delegate_research", args: { question: "Warranty for charging faults?" } }]),
      openAiToolCall([{ id: "call_s", name: "search_kb", args: { query: "warranty charging" } }]),
      openAiText("kb-warranty: 12-month warranty covers charging faults."),
      openAiText("Your headphones are under warranty; we can ship a replacement."),
    ];
    const result = await runTurn("My headphones stopped charging.", { provider: "openai", subagent: true, conversationId: "conv_sub" });

    expect(result.ok).toBe(true);
    expect((providerRequests[0]!.body.tools as { function: { name: string } }[]).map((tool) => tool.function.name)).toContain("delegate_research");
    expect((providerRequests[1]!.body.tools as { function: { name: string } }[]).map((tool) => tool.function.name)).toEqual(["search_kb"]);

    const spans = exported();
    const delegate = spans.find((span) => span.name === "delegate_research")!;
    const researcher = spans.find((span) => span.name === "invoke_agent researcher")!;
    expect(researcher).toMatchObject({ spanType: "AGENT_ROOT", parentSpanId: delegate.spanId, status: "OK" });
    expect(spans.filter((span) => span.parentSpanId === researcher.spanId).map((span) => span.spanType)).toEqual(["LLM_GENERATION", "TOOL_CALL", "LLM_GENERATION"]);
    expect(delegate.normalized).toMatchObject({ kind: "tool", result: { answer: "kb-warranty: 12-month warranty covers charging faults." } });

    const rows = spans.map((span) => ({
      id: span.spanId, parent_span_id: span.parentSpanId ?? null, name: span.name, span_type: span.spanType,
      start_time_ms: span.startTimeMs, end_time_ms: span.endTimeMs, duration_ms: span.durationMs, model: span.model ?? null,
      status: span.status, input_tokens: span.inputTokens ?? null, output_tokens: span.outputTokens ?? null,
    }));
    expect(detectSubAgents(rows)).toEqual([expect.objectContaining({ root_span_id: delegate.spanId, name: "delegate_research", llm_count: 2, tool_count: 1 })]);
    expect(evidence(spans).root_failed).toBe(false);
  });

  test("stops after the step cap instead of looping forever", async () => {
    replies = Array.from({ length: MAX_STEPS }, (_, index) => openAiToolCall([{ id: `call_${index}`, name: "lookup_order", args: { order_id: "A1001" } }]));
    const result = await runTurn("Loop", { provider: "openai", conversationId: "conv_loop" });

    expect(result).toMatchObject({ ok: false, steps: MAX_STEPS, error: `Stopped after ${MAX_STEPS} model steps without a final answer.` });
    expect(providerRequests).toHaveLength(MAX_STEPS);
    expect(byType(exported(), "AGENT_ROOT")[0]!.attributes["error.type"]).toBe("step_limit");
  });

  test("a second turn carries the conversation and shares its id", async () => {
    replies = [openAiText("A1002 is in transit."), openAiText("Yes, within 30 days of delivery.")];
    const first: TurnResult = await runTurn("Where is A1002?", { provider: "openai", conversationId: "conv_multi" });
    const second = await runTurn("Can I return it later?", { provider: "openai", conversationId: "conv_multi", history: first.history });

    expect(second.ok).toBe(true);
    expect((providerRequests[1]!.body.messages as { role: string; content: unknown }[]).map((message) => [message.role, message.content])).toEqual([
      ["system", expect.any(String)],
      ["user", "Where is A1002?"],
      ["assistant", "A1002 is in transit."],
      ["user", "Can I return it later?"],
    ]);
    expect(exports).toHaveLength(2);
    expect(byType(exported(0), "AGENT_ROOT")[0]!.convoId).toBe("conv_multi");
    expect(byType(exported(1), "AGENT_ROOT")[0]!.convoId).toBe("conv_multi");
    expect(byType(exported(0), "AGENT_ROOT")[0]!.traceId).not.toBe(byType(exported(1), "AGENT_ROOT")[0]!.traceId);
  });

  test("a failed turn leaves the conversation history untouched", async () => {
    replies = [{ status: 500, body: { error: { message: "upstream exploded" } } }];
    const history = [{ role: "user" as const, text: "Earlier" }, { role: "assistant" as const, text: "Reply", toolCalls: [] }];
    const result = await runTurn("Now", { provider: "openai", conversationId: "conv_fail", history });
    expect(result.ok).toBe(false);
    expect(result.history).toBe(history);
  });

  test("the scenario batch covers success, recovery, hard failure, delegation and multiple turns", () => {
    expect(new Set(SCENARIOS.map((scenario) => scenario.expected))).toEqual(new Set(["complete", "completed_with_errors", "failed"]));
    expect(SCENARIOS.some((scenario) => scenario.subagent)).toBe(true);
    expect(SCENARIOS.some((scenario) => scenario.turns.length > 1)).toBe(true);
  });
});
