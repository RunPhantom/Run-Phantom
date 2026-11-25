import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import type http from "node:http";
import { closeDb, getRunWithSpans, upsertRun, insertSpan } from "../src/db";
import { createServer } from "../src/server";
import { deriveRunStatus } from "../src/run-status";

const envNames = ["RUNPHANTOM_DB_PATH", "RUNPHANTOM_SECRET_STORE_PATH", "OPENAI_API_KEY", "RUNPHANTOM_OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];
const originalEnv = new Map<string, string | undefined>();
const encoder = new TextEncoder();
const KEYS = { openai: "synthetic-openai-playground-key", anthropic: "synthetic-anthropic-playground-key", gemini: "synthetic-gemini-playground-key" };

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
let directory: string, base: string, server: http.Server;
let calls: Captured[] = [];
let upstream: (url: string, body: Record<string, unknown>, init: RequestInit) => Response | Promise<Response>;

function sse(events: Array<{ event?: string; data: unknown }>): Response {
  const text = events.map(item => `${item.event ? `event: ${item.event}\n` : ""}data: ${typeof item.data === "string" ? item.data : JSON.stringify(item.data)}\n\n`).join("");
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      // Split mid-line to prove the parser reassembles events across chunks.
      const bytes = encoder.encode(text);
      const middle = Math.floor(bytes.length / 2);
      controller.enqueue(bytes.slice(0, middle));
      controller.enqueue(bytes.slice(middle));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const openAiText = (text: string, model = "gpt-5-nano-2025-08-07") => sse([
  { data: { id: "chatcmpl-1", model, choices: [{ index: 0, delta: { role: "assistant", content: text.slice(0, 3) }, finish_reason: null }] } },
  { data: { id: "chatcmpl-1", model, choices: [{ index: 0, delta: { content: text.slice(3) }, finish_reason: "stop" }] } },
  { data: { id: "chatcmpl-1", model, choices: [], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 12 } } } },
  { data: "[DONE]" },
]);

const anthropicText = (text: string) => sse([
  { event: "message_start", data: { type: "message_start", message: { id: "msg_1", model: "claude-haiku-4-5-20251001", usage: { input_tokens: 14, cache_read_input_tokens: 6, cache_creation_input_tokens: 2, output_tokens: 1 } } } },
  { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
  { event: "ping", data: { type: "ping" } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9, output_tokens_details: { thinking_tokens: 3 } } } },
  { event: "message_stop", data: { type: "message_stop" } },
]);

const geminiText = (text: string) => sse([
  { data: { candidates: [{ content: { role: "model", parts: [{ text: text.slice(0, 2) }] }, index: 0 }], usageMetadata: { promptTokenCount: 11 }, modelVersion: "gemini-2.5-flash", responseId: "resp-g1" } },
  { data: { candidates: [{ content: { role: "model", parts: [{ text: text.slice(2) }] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 5, thoughtsTokenCount: 7, totalTokenCount: 23 }, modelVersion: "gemini-2.5-flash", responseId: "resp-g1" } },
]);

beforeAll(async () => {
  for (const key of envNames) { originalEnv.set(key, process.env[key]); delete process.env[key]; }
  directory = mkdtempSync(path.join(realpathSync(tmpdir()), "runphantom-playground-api-"));
  closeDb();
  process.env.RUNPHANTOM_DB_PATH = path.join(directory, "traces.db");
  process.env.RUNPHANTOM_SECRET_STORE_PATH = path.join(directory, "secrets.json");
  ({ server } = await createServer(0, {
    playgroundFetch: async (url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ url, headers: init.headers as Record<string, string>, body });
      return upstream(url, body, init);
    },
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

beforeEach(() => {
  calls = [];
  process.env.OPENAI_API_KEY = KEYS.openai;
  process.env.ANTHROPIC_API_KEY = KEYS.anthropic;
  process.env.GEMINI_API_KEY = KEYS.gemini;
  upstream = () => { throw new Error("unexpected provider call"); };
});

afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  closeDb();
  for (const [key, value] of originalEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(directory, { recursive: true, force: true });
});

const post = (body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) => fetch(`${base}/api/playground/runs`, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal,
});

const userTurn = { system: "Answer briefly.", messages: [{ role: "user", content: "Say hello" }] };

function llmSpan(runId: string) {
  const detail = getRunWithSpans(runId);
  const span = detail.spans.find(item => (item as { span_type?: string }).span_type === "LLM_GENERATION") as Record<string, unknown> | undefined;
  return { detail, span: span!, attributes: JSON.parse(String(span?.attributes ?? "{}")) as Record<string, unknown> };
}

describe.serial("POST /api/playground/runs", () => {
  test("calls OpenAI Chat Completions with streaming usage and records a real trace", async () => {
    upstream = () => openAiText("Hello there");
    const response = await post({ ...userTurn, provider: "openai", model: "gpt-5-nano", params: { temperature: 0.4, maxOutputTokens: 300, reasoningEffort: "minimal" } });
    expect(response.status).toBe(200);
    const body = await response.json() as { comparisonId: string; results: Array<Record<string, any>> };
    const [result] = body.results;
    expect(result).toMatchObject({
      index: 0, provider: "openai", model: "gpt-5-nano", status: "ok", output: { text: "Hello there", toolCalls: [] },
      finishReason: "stop", providerFinishReason: "stop", responseModel: "gpt-5-nano-2025-08-07", responseId: "chatcmpl-1",
      usage: { inputTokens: 20, outputTokens: 30, cachedInputTokens: 4, cacheWriteInputTokens: null, reasoningTokens: 12, totalTokens: 50 }, error: null,
    });
    expect(result.warnings).toEqual(["gpt-5-nano does not accept a temperature setting, so it was sent without one."]);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.runId).toMatch(/^[0-9a-f]{32}$/);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0].headers.Authorization).toBe(`Bearer ${KEYS.openai}`);
    expect(calls[0].body).toEqual({
      model: "gpt-5-nano", stream: true, stream_options: { include_usage: true }, store: false, max_completion_tokens: 300, reasoning_effort: "minimal",
      messages: [{ role: "system", content: "Answer briefly." }, { role: "user", content: "Say hello" }],
    });

    const { detail, span, attributes } = llmSpan(result.runId);
    expect(detail.run?.name).toBe("Playground: gpt-5-nano");
    expect(detail.run?.event_name).toBe("Playground: gpt-5-nano");
    expect(detail.run?.convo_id).toBe(body.comparisonId);
    expect(span).toMatchObject({ id: result.spanId, model: "gpt-5-nano-2025-08-07", provider: "openai", input_tokens: 20, output_tokens: 30, status: "OK", output_payload: "Hello there" });
    expect(attributes).toMatchObject({
      "gen_ai.operation.name": "chat", "gen_ai.request.model": "gpt-5-nano", "gen_ai.usage.cache_read.input_tokens": 4, "gen_ai.usage.output_tokens.reasoning": 12,
      "runphantom.usage.input_includes_cache": true, "runphantom.usage.output_includes_reasoning": true, "runphantom.playground": true, "gen_ai.request.max_tokens": 300,
    });
    expect(JSON.parse(String(attributes["gen_ai.input.messages"]))).toEqual([{ role: "user", parts: [{ type: "text", content: "Say hello" }] }]);
    const root = detail.spans.find(item => (item as { span_type?: string }).span_type === "AGENT_ROOT") as Record<string, unknown>;
    expect(JSON.parse(String(root.attributes)).tags).toEqual(["playground"]);
    expect(root.input_payload).toBe("Say hello");
    const serialized = JSON.stringify(detail);
    for (const key of Object.values(KEYS)) expect(serialized).not.toContain(key);

    const runs = await (await fetch(`${base}/api/runs`)).json() as Array<{ id: string; model: string }>;
    expect(runs.some(run => run.id === result.runId && run.model === "gpt-5-nano-2025-08-07")).toBe(true);
  });

  test("calls Anthropic Messages and counts cache reads and writes as input", async () => {
    upstream = () => anthropicText("Hi from Claude");
    const response = await post({ ...userTurn, provider: "anthropic", model: "claude-haiku-4-5-20251001", params: { temperature: 1.5 } });
    const { results: [result] } = await response.json() as { results: Array<Record<string, any>> };
    expect(result).toMatchObject({
      status: "ok", output: { text: "Hi from Claude" }, finishReason: "stop", providerFinishReason: "end_turn", responseId: "msg_1",
      usage: { inputTokens: 22, outputTokens: 9, cachedInputTokens: 6, cacheWriteInputTokens: 2, reasoningTokens: 3, totalTokens: 31 },
    });
    expect(result.warnings).toEqual(["claude-haiku-4-5-20251001 accepts a temperature up to 1, so 1.5 was sent as 1."]);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].headers).toMatchObject({ "x-api-key": KEYS.anthropic, "anthropic-version": "2023-06-01" });
    expect(calls[0].body).toEqual({ model: "claude-haiku-4-5-20251001", max_tokens: 1024, stream: true, system: "Answer briefly.", temperature: 1, messages: [{ role: "user", content: [{ type: "text", text: "Say hello" }] }] });
    const { span, attributes } = llmSpan(result.runId);
    expect(span).toMatchObject({ provider: "anthropic", input_tokens: 22, output_tokens: 9, status: "OK" });
    expect(attributes["gen_ai.usage.cache_creation.input_tokens"]).toBe(2);

    calls = [];
    upstream = () => anthropicText("Sonnet");
    const sonnet = await (await post({ ...userTurn, provider: "anthropic", model: "claude-sonnet-5-5", params: { temperature: 0.5 } })).json() as { results: Array<Record<string, any>> };
    expect(sonnet.results[0].warnings).toEqual(["claude-sonnet-5-5 does not accept a temperature setting, so it was sent without one."]);
    expect(calls[0].body.temperature).toBeUndefined();
  });

  test("calls Gemini generateContent over SSE and counts thinking tokens as output", async () => {
    upstream = () => geminiText("Hello Gemini");
    const response = await post({ ...userTurn, provider: "gemini", model: "gemini-2.5-flash", params: { temperature: 0.3, maxOutputTokens: 256 } });
    const { results: [result] } = await response.json() as { results: Array<Record<string, any>> };
    expect(result).toMatchObject({
      status: "ok", output: { text: "Hello Gemini" }, finishReason: "stop", providerFinishReason: "STOP", responseModel: "gemini-2.5-flash", responseId: "resp-g1",
      usage: { inputTokens: 11, outputTokens: 12, cachedInputTokens: 0, reasoningTokens: 7, totalTokens: 23 },
    });
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse");
    expect(calls[0].headers["x-goog-api-key"]).toBe(KEYS.gemini);
    expect(calls[0].body).toEqual({
      contents: [{ role: "user", parts: [{ text: "Say hello" }] }], systemInstruction: { parts: [{ text: "Answer briefly." }] },
      generationConfig: { maxOutputTokens: 256, temperature: 0.3 },
    });
    const { span, attributes } = llmSpan(result.runId);
    expect(span).toMatchObject({ provider: "gcp.gemini", model: "gemini-2.5-flash", input_tokens: 11, output_tokens: 12, name: "generate_content gemini-2.5-flash" });
    expect(attributes["gen_ai.operation.name"]).toBe("generate_content");
  });

  test("runs one tool-call round trip for every provider with each provider's wire format", async () => {
    const tools = [{ name: "get_weather", description: "Weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }];
    const firstTurn = { system: "Use tools.", messages: [{ role: "user", content: "Weather in Paris?" }], tools };
    upstream = url => url.includes("openai") ? sse([
      { data: { id: "c1", model: "gpt-4.1-mini", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "get_weather", arguments: "" } }] } }] } },
      { data: { id: "c1", model: "gpt-4.1-mini", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"city\":" } }] } }] } },
      { data: { id: "c1", model: "gpt-4.1-mini", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"Paris\"}" } }] }, finish_reason: "tool_calls" }] } },
      { data: { id: "c1", model: "gpt-4.1-mini", choices: [], usage: { prompt_tokens: 50, completion_tokens: 15, total_tokens: 65 } } },
      { data: "[DONE]" },
    ]) : url.includes("anthropic") ? sse([
      { event: "message_start", data: { type: "message_start", message: { id: "msg_t", model: "claude-haiku-4-5-20251001", usage: { input_tokens: 40, output_tokens: 1 } } } },
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"city\": \"Par" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "is\"}" } } },
      { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } } },
      { event: "message_stop", data: { type: "message_stop" } },
    ]) : sse([
      { data: { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "get_weather", args: { city: "Paris" } }, thoughtSignature: "c2lnbmF0dXJl" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 6, totalTokenCount: 36 }, modelVersion: "gemini-2.5-flash" } },
    ]);
    const first = await (await post({ ...firstTurn, targets: [{ provider: "openai", model: "gpt-4.1-mini" }, { provider: "anthropic", model: "claude-haiku-4-5-20251001" }, { provider: "gemini", model: "gemini-2.5-flash" }] })).json() as { comparisonId: string; results: Array<Record<string, any>> };
    expect(first.results.map(result => [result.provider, result.finishReason, result.output.toolCalls[0].name, result.output.toolCalls[0].arguments])).toEqual([
      ["openai", "tool_calls", "get_weather", { city: "Paris" }],
      ["anthropic", "tool_calls", "get_weather", { city: "Paris" }],
      ["gemini", "tool_calls", "get_weather", { city: "Paris" }],
    ]);
    expect(first.results[2].output.toolCalls[0].signature).toBe("c2lnbmF0dXJl");
    expect(first.results.map(result => result.timeToFirstTokenMs)).not.toContain(null);
    const toolBodies = Object.fromEntries(calls.map(call => [call.url.includes("openai") ? "openai" : call.url.includes("anthropic") ? "anthropic" : "gemini", call.body]));
    expect(toolBodies.openai.tools).toEqual([{ type: "function", function: tools[0] }]);
    expect(toolBodies.anthropic.tools).toEqual([{ name: "get_weather", description: "Weather for a city", input_schema: tools[0].parameters }]);
    expect(toolBodies.gemini.tools).toEqual([{ functionDeclarations: [{ name: "get_weather", description: "Weather for a city", parametersJsonSchema: tools[0].parameters }] }]);
    const outputMessages = JSON.parse(String(llmSpan(first.results[0].runId).attributes["gen_ai.output.messages"]));
    expect(outputMessages).toEqual([{ role: "assistant", parts: [{ type: "tool_call", id: "call_abc", name: "get_weather", arguments: { city: "Paris" } }], finish_reason: "tool_calls" }]);
    const runIds = new Set(first.results.map(result => result.runId));
    expect(runIds.size).toBe(3);
    for (const result of first.results) expect(getRunWithSpans(result.runId).run?.convo_id).toBe(first.comparisonId);

    calls = [];
    upstream = url => url.includes("openai") ? openAiText("It is sunny.", "gpt-4.1-mini") : url.includes("anthropic") ? anthropicText("It is sunny.") : geminiText("It is sunny.");
    const second = await (await post({ ...firstTurn, targets: first.results.map(result => ({ provider: result.provider, model: result.model })) , messages: [] })).json() as { error?: string };
    expect(second.error).toContain("messages must list");
    const followUps = await Promise.all(first.results.map(async result => {
      const call = result.output.toolCalls[0];
      return (await post({ ...firstTurn, provider: result.provider, model: result.model, messages: [
        ...firstTurn.messages, { role: "assistant", content: "", toolCalls: [call] }, { role: "tool", toolCallId: call.id, content: "{\"forecast\":\"sunny\"}" },
      ] })).json() as Promise<{ results: Array<Record<string, any>> }>;
    }));
    expect(followUps.map(item => item.results[0].output.text)).toEqual(["It is sunny.", "It is sunny.", "It is sunny."]);
    const followBodies = Object.fromEntries(calls.map(call => [call.url.includes("openai") ? "openai" : call.url.includes("anthropic") ? "anthropic" : "gemini", call.body]));
    expect((followBodies.openai.messages as unknown[]).slice(2)).toEqual([
      { role: "assistant", content: null, tool_calls: [{ id: "call_abc", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }] },
      { role: "tool", tool_call_id: "call_abc", content: "{\"forecast\":\"sunny\"}" },
    ]);
    expect((followBodies.anthropic.messages as unknown[]).slice(1)).toEqual([
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{\"forecast\":\"sunny\"}" }] },
    ]);
    expect((followBodies.gemini.contents as unknown[]).slice(1)).toEqual([
      { role: "model", parts: [{ functionCall: { name: "get_weather", args: { city: "Paris" } }, thoughtSignature: "c2lnbmF0dXJl" }] },
      { role: "user", parts: [{ functionResponse: { name: "get_weather", response: { forecast: "sunny" } } }] },
    ]);
  });

  test("maps provider failures to one error shape and records them as failed runs", async () => {
    const cases: Array<{ provider: string; model: string; response: () => Response; kind: string; status: number | null }> = [
      { provider: "openai", model: "gpt-5-nano", response: () => json(401, { error: { message: "Incorrect API key provided: synthetic-openai-playground-key.", type: "invalid_request_error", code: "invalid_api_key" } }), kind: "auth", status: 401 },
      { provider: "openai", model: "gpt-5-nano", response: () => json(429, { error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" } }), kind: "quota", status: 429 },
      { provider: "openai", model: "gpt-4o-mini", response: () => json(429, { error: { message: "Rate limit reached for requests", type: "requests", code: "rate_limit_exceeded" } }), kind: "rate_limit", status: 429 },
      { provider: "openai", model: "gpt-4o-mini", response: () => json(404, { error: { message: "The model `gpt-4o-mini` does not exist or you do not have access to it.", code: "model_not_found" } }), kind: "invalid_model", status: 404 },
      { provider: "anthropic", model: "claude-haiku-5-5", response: () => json(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }), kind: "quota", status: 400 },
      { provider: "anthropic", model: "claude-haiku-5-5", response: () => json(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), kind: "overloaded", status: 529 },
      { provider: "anthropic", model: "claude-sonnet-5-5", response: () => json(404, { type: "error", error: { type: "not_found_error", message: "model: claude-sonnet-5-5" } }), kind: "invalid_model", status: 404 },
      { provider: "gemini", model: "gemini-2.5-flash", response: () => json(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }), kind: "auth", status: 400 },
      { provider: "gemini", model: "gemini-2.5-flash", response: () => json(404, { error: { code: 404, message: "This model models/gemini-2.5-flash is no longer available to new users.", status: "NOT_FOUND" } }), kind: "invalid_model", status: 404 },
      { provider: "gemini", model: "gemini-2.5-flash-lite", response: () => json(429, { error: { code: 429, message: "Resource has been exhausted.", status: "RESOURCE_EXHAUSTED" } }), kind: "rate_limit", status: 429 },
      { provider: "gemini", model: "gemini-3.8-flash", response: () => json(429, { error: { code: 429, message: "You exceeded your current quota, please check your plan and billing details.", status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } }), kind: "quota", status: 429 },
      { provider: "gemini", model: "gemini-3.8-flash", response: () => json(429, { error: { code: 429, message: "You exceeded your current quota, please check your plan and billing details.", status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }] }] } }), kind: "rate_limit", status: 429 },
      { provider: "gemini", model: "gemini-2.5-flash-lite", response: () => { throw new TypeError("fetch failed"); }, kind: "network", status: null },
    ];
    for (const item of cases) {
      upstream = item.response;
      const { results: [result] } = await (await post({ ...userTurn, provider: item.provider, model: item.model })).json() as { results: Array<Record<string, any>> };
      expect({ provider: item.provider, kind: result.error?.kind, status: result.error?.httpStatus, finish: result.finishReason, state: result.status }).toEqual({ provider: item.provider, kind: item.kind, status: item.status, finish: "error", state: "error" });
      expect(typeof result.error.message).toBe("string");
      expect(JSON.stringify(result)).not.toContain(KEYS.openai);
      const { span, attributes } = llmSpan(result.runId);
      expect(span.status).toBe("ERROR");
      expect(attributes["error.type"]).toBe(item.kind);
      expect(getRunWithSpans(result.runId).spans.filter(entry => (entry as { status?: string }).status === "ERROR")).toHaveLength(2);
      const listed = await (await fetch(`${base}/api/runs?envelope=1&ids=${encodeURIComponent(result.runId)}`)).json() as { runs: Array<Parameters<typeof deriveRunStatus>[0] & { run_status: string; status: string }> };
      expect(listed.runs.map(row => [row.run_status, row.status, row.error_count])).toEqual([["failed", "failed", 1]]);
      expect(deriveRunStatus(listed.runs[0])).toMatchObject({ label: "Run failed", detail: "The run's root span errored.", errorCount: 1 });
      expect(JSON.stringify(getRunWithSpans(result.runId))).not.toContain(KEYS.openai);
    }
  });

  test("a rejected key names where it came from", async () => {
    upstream = () => json(401, { error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" } });
    const rejected = async () => ((await (await post({ ...userTurn, provider: "openai", model: "gpt-5-nano" })).json()) as { results: Array<Record<string, any>> }).results[0].error;
    expect(await rejected()).toMatchObject({ kind: "auth", message: "OpenAI rejected the API key in OPENAI_API_KEY.", key: { source: "env", envVar: "OPENAI_API_KEY" } });
    try {
      expect((await fetch(`${base}/api/secrets/openai`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: "synthetic-saved-openai-key" }) })).status).toBe(200);
      expect(await rejected()).toMatchObject({ kind: "auth", message: "OpenAI rejected the API key saved in Settings.", key: { source: "store", envVar: null } });
    } finally {
      await fetch(`${base}/api/secrets/openai`, { method: "DELETE" });
    }
    upstream = () => json(429, { error: { message: "Rate limit reached for requests", code: "rate_limit_exceeded" } });
    expect((await rejected()).key).toBeUndefined();
  });

  test("reports in-band stream errors and truncated streams instead of a silent success", async () => {
    upstream = () => sse([
      { event: "message_start", data: { type: "message_start", message: { id: "msg_e", model: "claude-haiku-4-5-20251001", usage: { input_tokens: 5, output_tokens: 1 } } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partial" } } },
      { event: "error", data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } },
    ]);
    let { results: [result] } = await (await post({ ...userTurn, provider: "anthropic", model: "claude-haiku-4-5-20251001" })).json() as { results: Array<Record<string, any>> };
    expect(result).toMatchObject({ status: "error", output: { text: "Partial" }, error: { kind: "overloaded", retryable: true }, usage: { inputTokens: 5, outputTokens: null, totalTokens: null } });
    expect(result.warnings).toContain("The response stopped before it finished, so the output token count is unknown.");
    expect(llmSpan(result.runId).span.output_tokens ?? null).toBeNull();

    upstream = () => sse([{ data: { id: "c", model: "gpt-5-nano", choices: [{ index: 0, delta: { content: "Cut" } }] } }]);
    ({ results: [result] } = await (await post({ ...userTurn, provider: "openai", model: "gpt-5-nano" })).json() as { results: Array<Record<string, any>> });
    expect(result).toMatchObject({ status: "error", output: { text: "Cut" }, error: { kind: "invalid_response" } });
  });

  test("returns a missing-key result without calling the provider or recording a run", async () => {
    delete process.env.GEMINI_API_KEY;
    const before = (await (await fetch(`${base}/api/runs`)).json() as unknown[]).length;
    const { results: [result] } = await (await post({ ...userTurn, provider: "gemini", model: "gemini-2.5-flash" })).json() as { results: Array<Record<string, any>> };
    expect(result).toMatchObject({ status: "error", runId: null, spanId: null, error: { kind: "missing_key", message: "No Google Gemini API key is configured. Add one in Settings under API keys." } });
    expect(calls).toHaveLength(0);
    expect((await (await fetch(`${base}/api/runs`)).json() as unknown[]).length).toBe(before);
  });

  test("cancels the provider call when the client disconnects and records the cancellation", async () => {
    let seen: AbortSignal | undefined;
    upstream = (_url, _body, init) => new Promise<Response>((_resolve, reject) => {
      seen = init.signal ?? undefined;
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    const client = new AbortController();
    const pending = post({ ...userTurn, provider: "openai", model: "gpt-4o-mini" }, {}, client.signal).catch(() => null);
    await Bun.sleep(50);
    client.abort();
    await pending;
    await Bun.sleep(50);
    expect(seen?.aborted).toBe(true);
    const runs = await (await fetch(`${base}/api/runs`)).json() as Array<{ id: string; name: string }>;
    const cancelled = runs.map(run => llmSpan(run.id)).find(item => item.attributes["error.type"] === "cancelled");
    expect(cancelled?.span.status).toBe("ERROR");
  });

  test("streams deltas and per-model results as server-sent events", async () => {
    upstream = url => url.includes("openai") ? openAiText("Streaming works") : anthropicText("Also streams");
    const response = await post({ ...userTurn, stream: true, targets: [{ provider: "openai", model: "gpt-5-mini" }, { provider: "anthropic", model: "claude-haiku-4-5-20251001" }] });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = (await response.text()).trim().split("\n\n").map(block => {
      const [eventLine, dataLine] = block.split("\n");
      return { event: eventLine.slice("event: ".length), data: JSON.parse(dataLine.slice("data: ".length)) };
    });
    expect(events[0]).toMatchObject({ event: "start", data: { targets: [{ index: 0, provider: "openai", model: "gpt-5-mini" }, { index: 1, provider: "anthropic", model: "claude-haiku-4-5-20251001" }] } });
    expect(events.filter(item => item.event === "delta" && item.data.index === 0).map(item => item.data.text).join("")).toBe("Streaming works");
    expect(events.filter(item => item.event === "delta" && item.data.index === 1).map(item => item.data.text).join("")).toBe("Also streams");
    const results = events.filter(item => item.event === "result").map(item => item.data);
    expect(results.map(item => [item.index, item.status, item.output.text])).toEqual(expect.arrayContaining([[0, "ok", "Streaming works"], [1, "ok", "Also streams"]]));
    expect(results.every(item => typeof item.runId === "string" && item.timeToFirstTokenMs !== null)).toBe(true);
    expect(events[events.length - 1]).toEqual({ event: "done", data: { comparisonId: events[0].data.comparisonId } });
  });

  test("warns when a reasoning model spends every output token on reasoning", async () => {
    upstream = () => sse([
      { data: { id: "c", model: "gpt-5-nano", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] } },
      { data: { id: "c", model: "gpt-5-nano", choices: [{ index: 0, delta: {}, finish_reason: "length" }] } },
      { data: { id: "c", model: "gpt-5-nano", choices: [], usage: { prompt_tokens: 30, completion_tokens: 512, total_tokens: 542, completion_tokens_details: { reasoning_tokens: 512 } } } },
      { data: "[DONE]" },
    ]);
    const { results: [result] } = await (await post({ ...userTurn, provider: "openai", model: "gpt-5-nano", params: { maxOutputTokens: 512 } })).json() as { results: Array<Record<string, any>> };
    expect(result).toMatchObject({ status: "ok", finishReason: "length", output: { text: "" }, usage: { outputTokens: 512, reasoningTokens: 512 }, timeToFirstTokenMs: null });
    expect(result.warnings).toContain("All output tokens were used for reasoning, so there is no answer. Raise max output tokens or lower the reasoning effort.");
  });

  test("keeps rewritten Anthropic tool ids distinct and sends provider call ids back to Gemini", async () => {
    const turns = (ids: [string, string]) => ({
      ...userTurn, tools: [{ name: "lookup", parameters: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: "Look up both" },
        { role: "assistant", content: "", toolCalls: ids.map(id => ({ id, name: "lookup", arguments: {} })) },
        ...ids.map((id, index) => ({ role: "tool", toolCallId: id, content: `result ${index}` })),
      ],
    });
    upstream = () => anthropicText("ok");
    await post({ ...turns(["a.b", "a:b"]), provider: "anthropic", model: "claude-haiku-4-5-20251001" });
    const [assistant, results] = (calls[0].body.messages as Array<{ content: Array<Record<string, string>> }>).slice(1);
    const useIds = assistant.content.map(block => block.id);
    expect(new Set(useIds).size).toBe(2);
    expect(useIds.every(id => /^[A-Za-z0-9_-]+$/.test(id))).toBe(true);
    expect(results.content.map(block => block.tool_use_id)).toEqual(useIds);

    calls = [];
    upstream = () => geminiText("ok");
    await post({ ...turns(["fc_1", "gemini_call_0a1b2c3d4e5f"]), provider: "gemini", model: "gemini-3.8-flash" });
    const [model, user] = (calls[0].body.contents as Array<{ parts: Array<Record<string, any>> }>).slice(1);
    expect(model.parts.map(part => part.functionCall)).toEqual([{ id: "fc_1", name: "lookup", args: {} }, { name: "lookup", args: {} }]);
    expect(user.parts.map(part => part.functionResponse)).toEqual([
      { id: "fc_1", name: "lookup", response: { result: "result 0" } },
      { name: "lookup", response: { result: "result 1" } },
    ]);
  });

  test("refuses new calls with 429 while too many paid calls are in flight", async () => {
    const releases: Array<() => void> = [];
    upstream = () => new Promise<Response>(resolve => { releases.push(() => resolve(openAiText("late"))); });
    const three = { ...userTurn, targets: [{ provider: "openai", model: "gpt-5-nano" }, { provider: "openai", model: "gpt-5-mini" }, { provider: "openai", model: "gpt-4o-mini" }] };
    const held = [post(three), post(three)];
    while (releases.length < 6) await Bun.sleep(5);
    const refused = await post({ ...userTurn, provider: "openai", model: "gpt-4.1-mini" });
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: string }).error).toContain("already running 6 model calls");
    for (const release of releases) release();
    expect((await Promise.all(held)).map(response => response.status)).toEqual([200, 200]);
    upstream = () => openAiText("free again");
    expect((await post({ ...userTurn, provider: "openai", model: "gpt-4.1-mini" })).status).toBe(200);
  });

  test("refuses invalid requests before contacting any provider", async () => {
    const refusals: Array<[unknown, string]> = [
      [{ ...userTurn, provider: "openai", model: "gpt-6.1-terra" }, "not available in the Playground"],
      [{ ...userTurn, provider: "mistral", model: "x" }, "provider must be one of"],
      [{ ...userTurn, targets: [1, 2, 3, 4] }, "1 to 3 models"],
      [{ ...userTurn, provider: "openai", model: "gpt-5-nano", params: { maxOutputTokens: 100000 } }, "maxOutputTokens"],
      [{ ...userTurn, provider: "openai", model: "gpt-5-nano", params: { temperature: 3 } }, "temperature"],
      [{ provider: "openai", model: "gpt-5-nano", messages: [{ role: "assistant", content: "hi" }] }, "last message"],
      [{ provider: "openai", model: "gpt-5-nano", messages: [{ role: "user", content: "x" }, { role: "tool", toolCallId: "nope", content: "r" }] }, "no earlier assistant message made"],
      [{ ...userTurn, provider: "openai", model: "gpt-5-nano", extra: true }, "unsupported field"],
      [{ ...userTurn, provider: "openai", model: "gpt-5-nano", tools: [{ name: "bad name!" }] }, "tools[0] name"],
    ];
    for (const [body, message] of refusals) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain(message);
    }
    const huge = await post({ provider: "openai", model: "gpt-5-nano", messages: [{ role: "user", content: "x".repeat(600 * 1024) }] });
    expect(huge.status).toBe(413);
    const notJson = await fetch(`${base}/api/playground/runs`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "hi" });
    expect(notJson.status).toBe(415);
    const foreign = await post({ ...userTurn, provider: "openai", model: "gpt-5-nano" }, { Origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: "forbidden" });
    expect(calls).toHaveLength(0);
  });
});

describe.serial("GET /api/playground/models", () => {
  test("lists the allow-listed models and key status without exposing keys", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const body = await (await fetch(`${base}/api/playground/models`)).json() as { providers: Array<{ id: string; configured: boolean; keySource: string | null; keyEnvVar: string | null; models: Array<{ id: string }> }>; limits: { maxOutputTokens: number } };
    expect(body.providers.map(item => [item.id, item.configured, item.keySource, item.keyEnvVar, item.models.map(model => model.id)])).toEqual([
      ["openai", true, "env", "OPENAI_API_KEY", ["gpt-5-nano", "gpt-5-mini", "gpt-4.1-mini", "gpt-4o-mini"]],
      ["anthropic", false, null, null, ["claude-haiku-4-5-20251001", "claude-haiku-5-5", "claude-sonnet-5-5"]],
      ["gemini", true, "env", "GEMINI_API_KEY", ["gemini-3.8-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"]],
    ]);
    expect(body.limits.maxOutputTokens).toBe(8192);
    expect(JSON.stringify(body)).not.toContain(KEYS.openai);
  });

  test("reads GOOGLE_API_KEY, and a key saved in Settings wins over the environment", async () => {
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_API_KEY = "synthetic-google-env-key";
    try {
      const models = async () => (await (await fetch(`${base}/api/playground/models`)).json() as { providers: Array<{ id: string; keySource: string | null; keyEnvVar: string | null }> }).providers;
      expect((await models()).find(item => item.id === "gemini")).toMatchObject({ keySource: "env", keyEnvVar: "GOOGLE_API_KEY" });
      const saved = await fetch(`${base}/api/secrets/openai`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: "synthetic-saved-openai-key" }) });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toEqual({ key: "openai", status: { configured: true, source: "store", env_var: "OPENAI_API_KEY", stored: true, env_available: true } });
      expect((await models()).find(item => item.id === "openai")).toMatchObject({ keySource: "store", keyEnvVar: null });

      upstream = () => openAiText("Hello there");
      const response = await post({ ...userTurn, provider: "openai", model: "gpt-5-nano" });
      const [result] = (await response.json() as { results: Array<{ runId: string; status: string }> }).results;
      expect(result.status).toBe("ok");
      expect(calls[0].headers.Authorization).toBe("Bearer synthetic-saved-openai-key");
      const trace = JSON.stringify(getRunWithSpans(result.runId));
      for (const value of ["synthetic-saved-openai-key", KEYS.openai, "synthetic-google-env-key"]) expect(trace).not.toContain(value);
    } finally {
      await fetch(`${base}/api/secrets/openai`, { method: "DELETE" });
      delete process.env.GOOGLE_API_KEY;
    }
  });
});

describe.serial("GET /api/playground/draft-from-span/:spanId", () => {
  const seed = (runId: string, spanId: string, fields: { name?: string; attributes?: Record<string, unknown>; input?: string; model?: string; provider?: string; type?: string }) => {
    upsertRun({ id: runId, name: "support_agent", started_at: Date.now(), last_updated_at: Date.now() });
    insertSpan({
      id: spanId, run_id: runId, name: fields.name ?? "llm", span_type: fields.type ?? "LLM_GENERATION", status: "OK",
      start_time_ms: Date.now(), end_time_ms: Date.now(), duration_ms: 1, model: fields.model, provider: fields.provider,
      input_payload: fields.input, attributes: JSON.stringify(fields.attributes ?? {}),
    });
  };
  const draft = async (spanId: string, runId?: string) => {
    const response = await fetch(`${base}/api/playground/draft-from-span/${spanId}${runId ? `?run_id=${runId}` : ""}`);
    return { status: response.status, body: await response.json() as Record<string, any> };
  };

  test("round-trips a recorded Playground span, tools and tool turns included", async () => {
    upstream = () => openAiText("Done");
    const request = {
      system: "Be terse.", provider: "openai", model: "gpt-4.1-mini", params: { temperature: 0.2, maxOutputTokens: 200 },
      tools: [{ name: "lookup", description: "Find a record", parameters: { type: "object", properties: { id: { type: "string" } } } }],
      messages: [
        { role: "user", content: "Find 42" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "lookup", arguments: { id: "42" } }] },
        { role: "tool", toolCallId: "call_1", content: "found" },
      ],
    };
    const { results: [result] } = await (await post(request)).json() as { results: Array<Record<string, any>> };
    const { status, body } = await draft(result.spanId, result.runId);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      provider: "openai", model: "gpt-4.1-mini", modelSubstituted: false, system: "Be terse.", params: { temperature: 0.2, maxOutputTokens: 200 },
      tools: request.tools, source: { runId: result.runId, spanId: result.spanId, runName: "Playground: gpt-4.1-mini", format: "otel-genai" }, warnings: [],
    });
    expect(body.messages).toEqual(request.messages);
    const rerun = await post({ ...body, targets: [{ provider: body.provider, model: body.model }], provider: undefined, model: undefined, capturedProvider: undefined, capturedModel: undefined, modelSubstituted: undefined, warnings: undefined, source: { runId: body.source.runId, spanId: body.source.spanId } });
    expect(rerun.status).toBe(200);
  });

  test("reads Anthropic request bodies, OpenInference and AI SDK captures", async () => {
    seed("draft-anthropic", "span-a", { model: "claude-haiku-4-5-20251001", provider: "anthropic", input: JSON.stringify({
      model: "claude-haiku-4-5-20251001", max_tokens: 20000, temperature: 0.5, system: [{ type: "text", text: "You triage tickets." }],
      tools: [{ name: "route", description: "Route a ticket", input_schema: { type: "object", properties: { team: { type: "string" } } } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "Export times out" }, { type: "image", source: {} }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "tool_use", id: "toolu_9", name: "route", input: { team: "billing" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: [{ type: "text", text: "routed" }] }, { type: "text", text: "Now summarise" }] },
      ],
    }) });
    let { body } = await draft("span-a", "draft-anthropic");
    expect(body).toMatchObject({ provider: "anthropic", model: "claude-haiku-4-5-20251001", system: "You triage tickets.", params: { temperature: 0.5, maxOutputTokens: 8192 }, source: { format: "anthropic", runName: "support_agent" } });
    expect(body.messages).toEqual([
      { role: "user", content: "Export times out" },
      { role: "assistant", content: "", toolCalls: [{ id: "toolu_9", name: "route", arguments: { team: "billing" } }] },
      { role: "tool", toolCallId: "toolu_9", content: "routed" },
      { role: "user", content: "Now summarise" },
    ]);
    expect(body.tools).toEqual([{ name: "route", description: "Route a ticket", parameters: { type: "object", properties: { team: { type: "string" } } } }]);
    expect(body.warnings).toEqual(expect.arrayContaining([expect.stringContaining("image"), expect.stringContaining("Reasoning"), expect.stringContaining("lowered")]));

    seed("draft-openinference", "span-oi", { provider: "openai", attributes: {
      "openinference.span.kind": "LLM", "llm.model_name": "gpt-5-mini-2025-08-07", "llm.provider": "openai",
      "llm.invocation_parameters": JSON.stringify({ temperature: 0.7, max_completion_tokens: 900 }),
      "llm.input_messages.0.message.role": "system", "llm.input_messages.0.message.content": "Plan carefully.",
      "llm.input_messages.1.message.role": "user", "llm.input_messages.1.message.content": "Book a table",
      "llm.tools.0.tool.json_schema": JSON.stringify({ type: "function", function: { name: "book", parameters: { type: "object", properties: {} } } }),
    } });
    ({ body } = await draft("span-oi"));
    expect(body).toMatchObject({ provider: "openai", model: "gpt-5-mini", capturedModel: "gpt-5-mini-2025-08-07", modelSubstituted: false, system: "Plan carefully.", messages: [{ role: "user", content: "Book a table" }], params: { temperature: 0.7, maxOutputTokens: 900 }, tools: [{ name: "book" }], source: { format: "openinference" } });

    seed("draft-aisdk", "span-ai", { attributes: {
      "ai.model.id": "gemini-1.5-pro", "ai.model.provider": "google.generative-ai", "ai.settings.maxOutputTokens": 300,
      "ai.prompt.messages": JSON.stringify([{ role: "system", content: "Stay factual." }, { role: "user", content: [{ type: "text", text: "Summarise M5 news" }] }]),
      "ai.prompt.tools": [JSON.stringify({ type: "function", name: "search", description: "Web search", parameters: { type: "object", properties: { q: { type: "string" } } } })],
    } });
    ({ body } = await draft("span-ai"));
    expect(body).toMatchObject({ provider: "gemini", model: "gemini-3.8-flash", modelSubstituted: true, system: "Stay factual.", messages: [{ role: "user", content: "Summarise M5 news" }], params: { maxOutputTokens: 300 }, tools: [{ name: "search" }], source: { format: "ai-sdk" } });
    expect(body.warnings).toContain("gemini-1.5-pro is not available in the Playground, so gemini-3.8-flash was selected instead.");
  });

  test("keeps unmatched tool results, renames MCP-style tools and fits limits so the draft runs unchanged", async () => {
    seed("draft-orphans", "span-o", { attributes: {
      "ai.model.id": "claude-haiku-4-5-20251001", "ai.model.provider": "anthropic",
      "ai.prompt.messages": JSON.stringify([
        { role: "system", content: "Triage tickets." },
        { role: "user", content: "Export times out at 30s" },
        { role: "assistant", content: "I'll look up the account." },
        { role: "tool", content: "{\"plan\":\"Pro\"}" },
        { role: "tool", content: "{\"limit\":30}" },
      ]),
    } });
    let { body } = await draft("span-o");
    expect(body.messages).toEqual([
      { role: "user", content: "Export times out at 30s" },
      { role: "assistant", content: "I'll look up the account." },
      { role: "user", content: "Tool result:\n{\"plan\":\"Pro\"}\n\nTool result:\n{\"limit\":30}" },
    ]);
    expect(body.warnings).toContain("2 tool results without a matching tool call were kept as user text.");

    seed("draft-mcp", "span-m", { attributes: {
      "gen_ai.provider.name": "openai", "gen_ai.request.model": "gpt-4.1-mini",
      "gen_ai.tool.definitions": JSON.stringify([{ type: "function", name: "fs.read", parameters: { type: "object", properties: { path: { type: "string" } } } }]),
      "gen_ai.input.messages": JSON.stringify([
        { role: "user", parts: [{ type: "text", content: "x".repeat(100_000) }] },
        { role: "assistant", parts: [{ type: "tool_call", id: "call.1", name: "fs.read", arguments: { path: "/a" } }] },
        { role: "tool", parts: [{ type: "tool_call_response", id: "call.1", response: "file body" }] },
        ...Array.from({ length: 4 }, (_, index) => [
          { role: "user", parts: [{ type: "text", content: `${index}`.repeat(60_000) }] },
          { role: "assistant", parts: [{ type: "text", content: "noted" }] },
        ]).flat(),
        { role: "user", parts: [{ type: "text", content: "Summarise" }] },
      ]),
    } });
    ({ body } = await draft("span-m"));
    expect(body.tools).toEqual([{ name: "fs_read", parameters: { type: "object", properties: { path: { type: "string" } } } }]);
    expect(body.warnings).toEqual(expect.arrayContaining([
      'The tool "fs.read" was renamed "fs_read" because providers accept only letters, digits, _ and - in tool names.',
      "1 message was shortened to the Playground limit of 64000 characters.",
      expect.stringMatching(/^The \d+ oldest messages were left out to fit the Playground limits\.$/),
    ]));
    expect(body.messages[body.messages.length - 1]).toEqual({ role: "user", content: "Summarise" });
    expect(body.messages.every((item: { content: string }) => item.content.length <= 64_000)).toBe(true);
    upstream = () => openAiText("Done");
    const rerun = await post({ targets: [{ provider: body.provider, model: body.model }], system: body.system, messages: body.messages, params: body.params, tools: body.tools });
    expect(rerun.status).toBe(200);

    seed("draft-mcp-short", "span-ms", { attributes: {
      "gen_ai.provider.name": "openai", "gen_ai.request.model": "gpt-4.1-mini",
      "gen_ai.input.messages": JSON.stringify([
        { role: "user", parts: [{ type: "text", content: "y".repeat(100_000) }] },
        { role: "assistant", parts: [{ type: "tool_call", id: "call.1", name: "fs.read", arguments: { path: "/a" } }] },
        { role: "tool", parts: [{ type: "tool_call_response", id: "call.1", response: "file body" }] },
      ]),
    } });
    ({ body } = await draft("span-ms"));
    expect(body.messages.slice(1)).toEqual([
      { role: "assistant", content: "", toolCalls: [{ id: "call.1", name: "fs_read", arguments: { path: "/a" } }] },
      { role: "tool", toolCallId: "call.1", content: "file body" },
    ]);
    const shortRun = await post({ targets: [{ provider: body.provider, model: body.model }], system: body.system, messages: body.messages, params: body.params, tools: body.tools });
    expect(shortRun.status).toBe(200);
  });

  test("reads legacy indexed GenAI prompts and refuses spans without a prompt", async () => {
    seed("draft-legacy", "span-l", { model: "gpt-4o-mini-2024-07-18", attributes: {
      "gen_ai.system": "openai", "gen_ai.request.model": "gpt-4o-mini", "gen_ai.request.temperature": 0,
      "gen_ai.prompt.0.role": "system", "gen_ai.prompt.0.content": "Classify.", "gen_ai.prompt.1.role": "user", "gen_ai.prompt.1.content": "I love it",
    } });
    const legacy = await draft("span-l");
    expect(legacy.body).toMatchObject({ provider: "openai", model: "gpt-4o-mini", system: "Classify.", messages: [{ role: "user", content: "I love it" }], params: { temperature: 0 }, source: { format: "otel-genai-legacy" } });

    seed("draft-tool", "span-t", { type: "TOOL_CALL", attributes: { "gen_ai.tool.name": "x" } });
    expect((await draft("span-t")).status).toBe(422);
    seed("draft-empty", "span-e", { attributes: { "gen_ai.request.model": "gpt-4o-mini" } });
    expect((await draft("span-e")).status).toBe(422);
    expect((await draft("no-such-span")).status).toBe(404);
    expect((await draft("bad%20id")).status).toBe(400);
  });
});
