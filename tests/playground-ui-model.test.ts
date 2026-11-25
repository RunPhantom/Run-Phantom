import { describe, expect, test } from "bun:test";
import { createSseParser, toStreamEvent, type PlaygroundCallResult, type PlaygroundDraft } from "../app/src/api/playground";
import {
  appendToolRound, buildRunBody, defaultDraft, errorHelp, estimateResultCost, groupHistory, parseStoredDraft, parseToolsText,
  stateFromDraft, type PlaygroundDraftState,
} from "../app/src/components/playground/playground-model";
import { diffStats, wordDiff } from "../app/src/components/playground/word-diff";
import { playgroundPathForSpan } from "../app/src/components/playground/open-in-playground";
import { parsePlaygroundRunRequest } from "../src/playground/protocol";

function draft(overrides: Partial<PlaygroundDraftState> = {}): PlaygroundDraftState {
  return { ...defaultDraft(), messages: [{ id: "a", role: "user", content: "Hello" }], ...overrides };
}

function result(overrides: Partial<PlaygroundCallResult> = {}): PlaygroundCallResult {
  return {
    index: 0, provider: "openai", model: "gpt-5-nano", status: "ok", output: { text: "Hi", toolCalls: [] }, finishReason: "stop",
    providerFinishReason: "stop", responseModel: "gpt-5-nano-2025-08-07", responseId: "r", latencyMs: 900, timeToFirstTokenMs: 400,
    usage: { inputTokens: 24, outputTokens: 40, cachedInputTokens: 0, cacheWriteInputTokens: null, reasoningTokens: 0, totalTokens: 64 },
    warnings: [], error: null, runId: "4c9d2c3aa8285d2604819421cc5948da", spanId: "1234567890abcdef", ...overrides,
  };
}

describe("buildRunBody", () => {
  test("builds a request the daemon accepts unchanged", () => {
    const built = buildRunBody(draft({
      system: "Be brief.", temperature: "0.3", maxOutputTokens: "256", reasoningEffort: "low", toolsEnabled: true,
      targets: [{ provider: "openai", model: "gpt-5-nano" }, { provider: "anthropic", model: "claude-haiku-4-5-20251001" }],
      openedFrom: { runId: "run_1", spanId: "span_1", runName: "Triage", spanName: "chat", capturedModel: null, warnings: [] },
    }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body).toEqual({
      targets: [{ provider: "openai", model: "gpt-5-nano" }, { provider: "anthropic", model: "claude-haiku-4-5-20251001" }],
      system: "Be brief.",
      messages: [{ role: "user", content: "Hello" }],
      params: { temperature: 0.3, maxOutputTokens: 256, reasoningEffort: "low" },
      tools: [{ name: "get_weather", description: "Current weather for a city.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
      source: { runId: "run_1", spanId: "span_1" },
    });
    expect(() => parsePlaygroundRunRequest(built.body)).not.toThrow();
  });

  test("leaves out temperature, system and tools when they are empty or off", () => {
    const built = buildRunBody(draft({ toolsEnabled: false }));
    expect(built).toEqual({ ok: true, body: { targets: [{ provider: "openai", model: "gpt-5-nano" }], messages: [{ role: "user", content: "Hello" }], params: { maxOutputTokens: 1024 } } });
  });

  test("names the field and the fix for each invalid input", () => {
    expect(buildRunBody(draft({ messages: [{ id: "a", role: "user", content: "  " }] }))).toEqual({ ok: false, field: "messages", error: "Message 1 is empty. Write a user message or remove it." });
    expect(buildRunBody(draft({ messages: [{ id: "a", role: "assistant", content: "Hi" }] }))).toMatchObject({ ok: false, field: "messages", error: "The first message must come from the user." });
    expect(buildRunBody(draft({ messages: [{ id: "a", role: "user", content: "Hi" }, { id: "b", role: "assistant", content: "Hello" }] }))).toMatchObject({ ok: false, field: "messages", error: expect.stringContaining("last message") });
    expect(buildRunBody(draft({ temperature: "3" }))).toMatchObject({ ok: false, field: "temperature" });
    expect(buildRunBody(draft({ temperature: "warm" }))).toMatchObject({ ok: false, field: "temperature" });
    expect(buildRunBody(draft({ maxOutputTokens: "0" }))).toMatchObject({ ok: false, field: "maxOutputTokens" });
    expect(buildRunBody(draft({ maxOutputTokens: "9000" }))).toMatchObject({ ok: false, field: "maxOutputTokens" });
    expect(buildRunBody(draft({ maxOutputTokens: "1.5" }))).toMatchObject({ ok: false, field: "maxOutputTokens" });
    expect(buildRunBody(draft({ toolsEnabled: true, toolsText: "{" }))).toMatchObject({ ok: false, field: "tools" });
    expect(buildRunBody(draft({ targets: [] }))).toMatchObject({ ok: false, field: "targets" });
  });
});

describe("parseToolsText", () => {
  test("accepts a list of tools and defaults missing parameters to an empty object schema", () => {
    expect(parseToolsText('[{"name":"ping"}]')).toEqual({ ok: true, tools: [{ name: "ping", parameters: { type: "object", properties: {} } }] });
    expect(parseToolsText("  ")).toEqual({ ok: true, tools: [] });
  });

  test("explains what is wrong", () => {
    expect(parseToolsText("{")).toMatchObject({ ok: false, error: expect.stringMatching(/^Tools are not valid JSON/) });
    expect(parseToolsText('{"name":"x"}')).toMatchObject({ ok: false, error: expect.stringContaining("must be a JSON list") });
    expect(parseToolsText('[{"name":"fs.read"}]')).toMatchObject({ ok: false, error: expect.stringContaining("letters, digits, _ and -") });
    expect(parseToolsText('[{"name":"a"},{"name":"a"}]')).toEqual({ ok: false, error: 'Tool "a" is listed twice.' });
    expect(parseToolsText('[{"name":"a","parameters":{"type":"string"}}]')).toMatchObject({ ok: false, error: expect.stringContaining("JSON Schema object") });
    expect(parseToolsText('[{"name":"a","input_schema":{}}]')).toMatchObject({ ok: false, error: expect.stringContaining('unsupported field "input_schema"') });
    expect(parseToolsText(JSON.stringify(Array.from({ length: 33 }, (_, i) => ({ name: `t${i}` }))))).toEqual({ ok: false, error: "Use at most 32 tools." });
  });
});

describe("drafts", () => {
  test("a stored draft round-trips and malformed storage falls back safely", () => {
    const state = draft({ system: "S", temperature: "0.5", targets: [{ provider: "gemini", model: "gemini-3.8-flash" }] });
    expect(parseStoredDraft(JSON.stringify(state))).toEqual(state);
    expect(parseStoredDraft("not json")).toBeNull();
    expect(parseStoredDraft(JSON.stringify({ version: 2 }))).toBeNull();
    const repaired = parseStoredDraft(JSON.stringify({ version: 1, messages: [{ role: "robot" }], targets: [{ provider: "mistral", model: "x" }], reasoningEffort: "max" }))!;
    expect(repaired.messages).toHaveLength(1);
    expect(repaired.messages[0]!.role).toBe("user");
    expect(repaired.targets).toEqual([{ provider: "openai", model: "gpt-5-nano" }]);
    expect(repaired.reasoningEffort).toBe("");
  });

  test("a span draft fills the editor and remembers where it came from", () => {
    const source: PlaygroundDraft = {
      provider: "anthropic", model: "claude-haiku-4-5-20251001", capturedProvider: "anthropic", capturedModel: "claude-sonnet-4-5", modelSubstituted: true,
      system: "Triage tickets.", params: { temperature: 0.2, maxOutputTokens: 200 },
      messages: [
        { role: "user", content: "Weather?" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "get_weather", arguments: { city: "Paris" } }] },
        { role: "tool", toolCallId: "c1", name: "get_weather", content: "{\"temp\":11}" },
      ],
      tools: [{ name: "get_weather", parameters: { type: "object" } }],
      source: { runId: "demo_triage", spanId: "demo_triage_llm-2", runName: "Customer support triage", spanName: "ai.generateText", format: "ai-sdk" },
      warnings: ["claude-sonnet-4-5 is not available in the Playground, so claude-haiku-4-5-20251001 was selected instead."],
    };
    const state = stateFromDraft(source, defaultDraft(), { openedFrom: true });
    expect(state).toMatchObject({ system: "Triage tickets.", temperature: "0.2", maxOutputTokens: "200", toolsEnabled: true, targets: [{ provider: "anthropic", model: "claude-haiku-4-5-20251001" }] });
    expect(state.openedFrom).toEqual({ runId: "demo_triage", spanId: "demo_triage_llm-2", runName: "Customer support triage", spanName: "ai.generateText", capturedModel: "claude-sonnet-4-5", warnings: source.warnings });
    const built = buildRunBody(state);
    expect(built.ok && built.body.messages).toEqual(source.messages);
    expect(built.ok && built.body.source).toEqual({ runId: "demo_triage", spanId: "demo_triage_llm-2" });
    const reloaded = stateFromDraft(source, defaultDraft(), { openedFrom: false, targets: [{ provider: "openai", model: "gpt-5-nano" }, { provider: "anthropic", model: "claude-haiku-4-5-20251001" }] });
    expect(reloaded.openedFrom).toBeNull();
    expect(reloaded.targets).toHaveLength(2);
  });

  test("continuing a tool round appends the calls and one result per call", () => {
    const next = appendToolRound(draft(), { output: { text: "", toolCalls: [{ id: "call_1", name: "get_weather", arguments: { city: "Paris" } }] } });
    expect(next.messages.map(message => [message.role, message.toolCallId ?? null])).toEqual([["user", null], ["assistant", null], ["tool", "call_1"]]);
    const answered = { ...next, messages: next.messages.map(message => message.role === "tool" ? { ...message, content: "{\"temperature_c\":11}" } : message) };
    const built = buildRunBody(answered);
    expect(built.ok).toBe(true);
    if (built.ok) expect(() => parsePlaygroundRunRequest(built.body)).not.toThrow();
  });
});

describe("result facts", () => {
  test("cost uses the list price of the response model, matching the recorded run", () => {
    const estimate = estimateResultCost(result(), Date.parse("2026-11-25T12:00:00Z"));
    expect(estimate.kind).toBe("estimated");
    if (estimate.kind === "estimated") expect(estimate.totalUsd).toBeCloseTo(0.0000172, 10);
    const gemini = estimateResultCost(result({ provider: "gemini", model: "gemini-3.8-flash", responseModel: "gemini-3.8-flash", usage: { inputTokens: 14, outputTokens: 196, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningTokens: 150, totalTokens: 210 } }), Date.parse("2026-11-25T12:00:00Z"));
    expect(gemini.kind === "estimated" && gemini.totalUsd).toBeCloseTo(0.0007455, 10);
  });

  test("unknown token counts give no cost rather than zero", () => {
    expect(estimateResultCost(result({ usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningTokens: null, totalTokens: null } }))).toEqual({ kind: "unavailable", reason: "usage_unavailable" });
  });

  test("every error kind has a heading and a next step", () => {
    for (const kind of ["missing_key", "auth", "rate_limit", "quota", "invalid_model", "invalid_request", "overloaded", "provider_error", "timeout", "network", "invalid_response", "response_limit", "cancelled"] as const) {
      const help = errorHelp(kind);
      expect(help.title.length).toBeGreaterThan(0);
      expect(help.hint).toMatch(/\.$/);
    }
    expect(errorHelp("auth").settings).toBe(true);
    expect(errorHelp("quota").settings).toBe(false);
  });
});

describe("wordDiff", () => {
  test("marks only the words that changed", () => {
    expect(wordDiff("the cat sat on the mat", "the dog sat on the mat")).toEqual([
      { kind: "same", text: "the " }, { kind: "removed", text: "cat " }, { kind: "added", text: "dog " }, { kind: "same", text: "sat on the mat" },
    ]);
    expect(diffStats(wordDiff("a b c", "a x y c"))).toEqual({ added: 2, removed: 1 });
    expect(wordDiff("same", "same")).toEqual([{ kind: "same", text: "same" }]);
    expect(wordDiff("", "new text")).toEqual([{ kind: "added", text: "new text" }]);
  });

  test("paraphrases read as a few whole changes, not alternating word pairs", () => {
    const base = "An inference trace is a record of an inference session, typically listing the steps, inputs and outputs the model produced.";
    const other = "An inference trace is a detailed log that records all the steps, inputs and outputs a model produced.";
    const parts = wordDiff(base, other);
    expect(parts).toEqual([
      { kind: "same", text: "An inference trace is a " },
      { kind: "removed", text: "record of an inference session, typically listing " },
      { kind: "added", text: "detailed log that records all " },
      { kind: "same", text: "the steps, inputs and outputs " },
      { kind: "removed", text: "the " },
      { kind: "added", text: "a " },
      { kind: "same", text: "model produced." },
    ]);
    expect(wordDiff("Tracing shows each step.", "Tracing records each tool call.")).toEqual([
      { kind: "same", text: "Tracing " }, { kind: "removed", text: "shows each step." }, { kind: "added", text: "records each tool call." },
    ]);
    for (const [index, part] of parts.entries()) if (part.kind === "removed") expect(parts[index + 1]?.kind).toBe("added");
  });

  test("rebuilds both texts exactly", () => {
    const a = "Tracing shows each step.\n\nIt helps debugging.", b = "Tracing records each tool call.\nIt helps debugging and audits.";
    const parts = wordDiff(a, b);
    expect(parts.filter(part => part.kind !== "added").map(part => part.text).join("")).toBe(a);
    expect(parts.filter(part => part.kind !== "removed").map(part => part.text).join("")).toBe(b);
  });
});

describe("streaming", () => {
  test("parses events split across chunks, CRLF line ends and comments", () => {
    const parser = createSseParser();
    const events = [
      ...parser.push('event: start\ndata: {"comparisonId":"c1","targets":[{"index":0,"provider":"openai","model":"gpt-5-nano"}]}\n\n: keep-alive\n\nevent: del'),
      ...parser.push('ta\r\ndata: {"index":0,"text":"Hel"}\r'),
      ...parser.push('\n\r\nevent: delta\ndata: {"index":0,"text":"lo"}\n\nevent: done\ndata: {"comparisonId":"c1"}'),
      ...parser.finish(),
    ].map(toStreamEvent);
    expect(events).toEqual([
      { type: "start", comparisonId: "c1", targets: [{ index: 0, provider: "openai", model: "gpt-5-nano" }] },
      { type: "delta", index: 0, text: "Hel" },
      { type: "delta", index: 0, text: "lo" },
      { type: "done", comparisonId: "c1" },
    ]);
  });

  test("ignores malformed and unknown events", () => {
    expect(toStreamEvent({ event: "delta", data: "{" })).toBeNull();
    expect(toStreamEvent({ event: "ping", data: "{}" })).toBeNull();
    expect(toStreamEvent({ event: "error", data: '{"error":"The Playground request failed."}' })).toEqual({ type: "error", error: "The Playground request failed." });
  });
});

describe("history and links", () => {
  test("groups a compare run into one entry, newest first", () => {
    const row = (id: string, convo: string | null, started: number) => ({ id, convo_id: convo, started_at: started, last_updated_at: started, name: null, event_name: null, display_name: null, user_id: null, metadata: null });
    const groups = groupHistory([row("b", "cmp", 20), row("a", "cmp", 10), row("solo", null, 30), row("c", "cmp", 15)]);
    expect(groups.map(group => [group.key, group.runs.map(run => run.id)])).toEqual([["solo", ["solo"]], ["cmp", ["a", "c", "b"]]]);
  });

  test("Open in Playground links carry the span and its run", () => {
    expect(playgroundPathForSpan("demo_triage_llm-2", "demo_triage")).toBe("/playground?span=demo_triage_llm-2&run=demo_triage");
    expect(playgroundPathForSpan("a b")).toBe("/playground?span=a+b");
  });
});
