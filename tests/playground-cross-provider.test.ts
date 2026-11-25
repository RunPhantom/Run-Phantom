import { describe, expect, test } from "bun:test";
import { draftFromSpan, type DraftSpanInput } from "../src/playground/draft";
import { buildProviderRequest, GEMINI_UNSIGNED_CALL_SIGNATURE } from "../src/playground/providers";
import { parsePlaygroundRunRequest, PLAYGROUND_PROVIDERS, type PlaygroundProvider } from "../src/playground/protocol";

type Json = Record<string, any>;

const TOOLS = [
  { type: "function", name: "lookup_order", description: "Look up an order", parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] } },
  { type: "function", name: "check_inventory", description: "Stock for a SKU", parameters: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] } },
];

/** The OTel GenAI shape examples/tool-agent records: a mid-run step after one single and one parallel tool round. */
function toolAgentSpan(provider: PlaygroundProvider, model: string, ids: [string, string, string]): DraftSpanInput {
  const otelProvider = { openai: "openai", anthropic: "anthropic", gemini: "gcp.gemini" }[provider];
  const messages = [
    { role: "user", parts: [{ type: "text", content: "My lamp from order A1002 has not arrived. Is it in stock?" }] },
    { role: "assistant", parts: [{ type: "tool_call", id: ids[0], name: "lookup_order", arguments: { order_id: "A1002" } }] },
    { role: "tool", parts: [{ type: "tool_call_response", id: ids[0], response: JSON.stringify({ status: "in_transit", sku: "LM-040" }) }] },
    { role: "assistant", parts: [
      { type: "text", content: "Checking stock for both items." },
      { type: "tool_call", id: ids[1], name: "check_inventory", arguments: { sku: "LM-040" } },
      { type: "tool_call", id: ids[2], name: "check_inventory", arguments: { sku: "HP-110" } },
    ] },
    { role: "tool", parts: [{ type: "tool_call_response", id: ids[1], response: JSON.stringify({ available: 0 }) }] },
    { role: "tool", parts: [{ type: "tool_call_response", id: ids[2], response: "42 in stock" }] },
  ];
  return {
    id: `span-${provider}`, run_id: `run-${provider}`, name: `chat ${model}`, span_type: "LLM_GENERATION", model, provider: otelProvider, input_payload: null,
    attributes: JSON.stringify({
      "gen_ai.provider.name": otelProvider, "gen_ai.request.model": model, "gen_ai.request.max_tokens": 4096,
      "gen_ai.system_instructions": JSON.stringify([{ type: "text", content: "You are a support agent." }]),
      "gen_ai.input.messages": JSON.stringify(messages), "gen_ai.tool.definitions": JSON.stringify(TOOLS),
    }),
  };
}

/** A raw Gemini request body with Gemini's own thought signature and no call ids. */
const geminiNativeSpan: DraftSpanInput = {
  id: "span-gemini-native", run_id: "run-gemini-native", name: "generateContent", span_type: "LLM_GENERATION", model: "models/gemini-3.8-flash", provider: "gemini", attributes: "{}",
  input_payload: JSON.stringify({
    systemInstruction: { parts: [{ text: "You are a support agent." }] },
    tools: [{ functionDeclarations: TOOLS.map(({ type: _type, ...tool }) => tool) }],
    contents: [
      { role: "user", parts: [{ text: "Where is order A1002?" }] },
      { role: "model", parts: [{ functionCall: { name: "lookup_order", args: { order_id: "A1002" } }, thoughtSignature: "c2lnbmVkLWJ5LWdlbWluaQ==" }] },
      { role: "user", parts: [{ functionResponse: { name: "lookup_order", response: { status: "in_transit" } } }] },
    ],
  }),
};

const CAPTURES: Array<[string, DraftSpanInput]> = [
  ["openai", toolAgentSpan("openai", "gpt-5-nano", ["call_Qm9vYmFyMTIz", "call_UGFyYWxsZWwx", "call_UGFyYWxsZWwy"])],
  ["anthropic", toolAgentSpan("anthropic", "claude-haiku-4-5-20251001", ["toolu_01AbCdEfGh", "toolu_01IjKlMnOp", "toolu_01QrStUvWx"])],
  ["gemini", toolAgentSpan("gemini", "gemini-3.8-flash", ["gemini_call_0_0", "gemini_call_1_0", "gemini_call_1_1"])],
  ["gemini (native body)", geminiNativeSpan],
];

const TARGET_MODEL: Record<PlaygroundProvider, string> = { openai: "gpt-5-nano", anthropic: "claude-haiku-4-5-20251001", gemini: "gemini-3.8-flash" };

/** Checks the conversation rules each provider enforces with HTTP 400 on a replayed tool history. */
function assertValidHistory(provider: PlaygroundProvider, body: Json): number {
  let answered = 0;
  if (provider === "openai") {
    const messages = body.messages as Json[];
    let open: string[] = [];
    for (const message of messages) {
      if (message.role === "tool") {
        expect(open).toContain(message.tool_call_id);
        open = open.filter(id => id !== message.tool_call_id);
        answered++;
        continue;
      }
      expect(open).toEqual([]);
      open = (message.tool_calls ?? []).map((call: Json) => call.id);
      for (const call of message.tool_calls ?? []) expect(typeof call.function.arguments).toBe("string");
    }
    expect(open).toEqual([]);
  } else if (provider === "anthropic") {
    const messages = body.messages as Json[];
    expect(messages[0].role).toBe("user");
    messages.forEach((message, index) => {
      if (index) expect(message.role).not.toBe(messages[index - 1].role);
      const uses = (message.content as Json[]).filter(block => block.type === "tool_use");
      for (const use of uses) expect(use.id).toMatch(/^[A-Za-z0-9_-]+$/);
      if (!uses.length) return;
      const next = messages[index + 1].content as Json[];
      const results = next.filter(block => block.type === "tool_result");
      expect(results.map(block => block.tool_use_id)).toEqual(uses.map(use => use.id));
      expect(next.slice(0, results.length).every(block => block.type === "tool_result")).toBe(true);
      answered += results.length;
    });
  } else {
    const contents = body.contents as Json[];
    expect(contents[0].role).toBe("user");
    contents.forEach((content, index) => {
      if (index) expect(content.role).not.toBe(contents[index - 1].role);
      const calls = (content.parts as Json[]).filter(part => part.functionCall);
      if (!calls.length) return;
      expect(typeof calls[0].thoughtSignature).toBe("string");
      const responses = (contents[index + 1].parts as Json[]).filter(part => part.functionResponse).map(part => part.functionResponse);
      expect(responses.map(response => response.name)).toEqual(calls.map(call => call.functionCall.name));
      responses.forEach((response, position) => {
        expect(response.id).toBe(calls[position].functionCall.id);
        expect(response.response && typeof response.response === "object" && !Array.isArray(response.response)).toBe(true);
      });
      answered += responses.length;
    });
  }
  return answered;
}

describe("Open in Playground across providers", () => {
  for (const [captured, span] of CAPTURES) {
    for (const target of PLAYGROUND_PROVIDERS) {
      test(`a step captured on ${captured} replays as a valid ${target} request`, () => {
        const draft = draftFromSpan(span, "Refund a damaged order");
        const toolResults = draft.messages.filter(message => message.role === "tool").length;
        expect(toolResults).toBeGreaterThan(0);
        expect(draft.warnings.filter(warning => /tool result|tool call/.test(warning))).toEqual([]);
        const request = parsePlaygroundRunRequest({
          targets: [{ provider: target, model: TARGET_MODEL[target] }], system: draft.system, messages: draft.messages, params: draft.params, tools: draft.tools,
          source: { runId: draft.source.runId, spanId: draft.source.spanId },
        });
        const built = buildProviderRequest(request, request.targets[0], "synthetic-key");
        expect(assertValidHistory(target, built.body)).toBe(toolResults);
      });
    }
  }

  test("Gemini keeps its own signatures and marks only the first call of an unsigned turn", () => {
    const nativeDraft = draftFromSpan(geminiNativeSpan, null);
    const nativeRequest = parsePlaygroundRunRequest({ targets: [{ provider: "gemini", model: "gemini-3.8-flash" }], system: nativeDraft.system, messages: nativeDraft.messages, tools: nativeDraft.tools });
    expect((buildProviderRequest(nativeRequest, nativeRequest.targets[0], "k").body.contents as Json[])[1].parts[0].thoughtSignature).toBe("c2lnbmVkLWJ5LWdlbWluaQ==");

    const draft = draftFromSpan(CAPTURES[0][1], null);
    const request = parsePlaygroundRunRequest({ targets: [{ provider: "gemini", model: "gemini-3.8-flash" }], system: draft.system, messages: draft.messages, tools: draft.tools });
    const parallel = (buildProviderRequest(request, request.targets[0], "k").body.contents as Json[])[3].parts as Json[];
    expect(parallel.map(part => part.thoughtSignature)).toEqual([undefined, GEMINI_UNSIGNED_CALL_SIGNATURE, undefined]);
    expect(parallel[0].text).toBe("Checking stock for both items.");
  });
});

describe("draft fidelity", () => {
  const aiSdkSpan = (messages: unknown[], model = "gpt-4.1-mini", provider = "openai.chat"): DraftSpanInput => ({
    id: "span-ai", run_id: "run-ai", name: "ai.generateText.doGenerate", span_type: "LLM_GENERATION", model, provider, input_payload: null,
    attributes: JSON.stringify({ "ai.operationId": "ai.generateText.doGenerate", "ai.model.id": model, "ai.model.provider": provider, "ai.prompt.messages": JSON.stringify(messages) }),
  });

  test("AI SDK v5 tool output reaches the model as the value the SDK sent, not its wrapper", () => {
    const draft = draftFromSpan(aiSdkSpan([
      { role: "user", content: [{ type: "text", text: "Add 2 and 2, then greet, then fail" }] },
      { role: "assistant", content: [
        { type: "tool-call", toolCallId: "t1", toolName: "calc", input: { a: 2, b: 2 } },
        { type: "tool-call", toolCallId: "t2", toolName: "greet", input: {} },
        { type: "tool-call", toolCallId: "t3", toolName: "fetch_page", input: {} },
        { type: "tool-call", toolCallId: "t4", toolName: "legacy", input: {} },
      ] },
      { role: "tool", content: [
        { type: "tool-result", toolCallId: "t1", toolName: "calc", output: { type: "json", value: 4 } },
        { type: "tool-result", toolCallId: "t2", toolName: "greet", output: { type: "text", value: "hello" } },
        { type: "tool-result", toolCallId: "t3", toolName: "fetch_page", output: { type: "error-json", value: { status: 503 } } },
        { type: "tool-result", toolCallId: "t4", toolName: "legacy", result: { total: 4 } },
      ] },
    ]), null);
    expect(draft.messages.filter(message => message.role === "tool")).toEqual([
      { role: "tool", toolCallId: "t1", content: "4" },
      { role: "tool", toolCallId: "t2", content: "hello" },
      { role: "tool", toolCallId: "t3", content: "{\"status\":503}" },
      { role: "tool", toolCallId: "t4", content: "{\"total\":4}" },
    ]);
  });

  test("a captured model counts as the Playground model only for the same id, a dated snapshot or an undated alias", () => {
    const opened = (model: string, provider = "openai") => {
      const draft = draftFromSpan(aiSdkSpan([{ role: "user", content: "hi" }], model, provider), null);
      return [draft.model, draft.modelSubstituted, draft.warnings.filter(warning => warning.includes("not available"))];
    };
    expect(opened("gpt-5-mini-2025-08-07")).toEqual(["gpt-5-mini", false, []]);
    expect(opened("gpt-4o-mini-latest")).toEqual(["gpt-4o-mini", false, []]);
    expect(opened("claude-haiku-4-5", "anthropic")).toEqual(["claude-haiku-4-5-20251001", false, []]);
    expect(opened("models/gemini-3.8-flash", "google")).toEqual(["gemini-3.8-flash", false, []]);
    expect(opened("gpt-5-nano-doesnotexist")).toEqual(["gpt-5-nano", true, ["gpt-5-nano-doesnotexist is not available in the Playground, so gpt-5-nano was selected instead."]]);
    expect(opened("gpt-4o-mini-search-preview")).toEqual(["gpt-4o-mini", true, ["gpt-4o-mini-search-preview is not available in the Playground, so gpt-4o-mini was selected instead."]]);
    expect(opened("claude-haiku-4-5-20250101", "anthropic")[1]).toBe(true);
  });
});
