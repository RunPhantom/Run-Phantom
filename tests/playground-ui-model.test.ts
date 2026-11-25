import { describe, expect, test } from "bun:test";
import { createSseParser, toStreamEvent, type PlaygroundCallResult, type PlaygroundDraft, type PlaygroundProviderInfo } from "../app/src/api/playground";
import {
  appendToolRound, buildRunBody, defaultDraft, draftHasContent, errorHelp, estimateResultCost, groupHistory, metricLeaders, nextTarget, orderByColumn,
  parseStoredDraft, parseToolsText, recordedCostUsd, stateFromDraft, targetIndexOf, type PlaygroundDraftState,
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
      openedFrom: { runId: "run_1", spanId: "span_1", runName: "Triage", spanName: "chat", capturedModel: null, substitutedModel: null, warnings: [] },
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
    expect(buildRunBody(draft({ messages: [{ id: "a", role: "user", content: "  " }] }))).toEqual({ ok: false, field: "messages", index: 0, error: "Message 1 is empty. Write a user message or remove it." });
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

  test("temperature is checked against the tightest limit among the selected models", () => {
    const claude = draft({ temperature: "1.5", targets: [{ provider: "anthropic", model: "claude-haiku-4-5-20251001" }] });
    expect(buildRunBody(claude, { maxTemperature: 1 })).toEqual({ ok: false, field: "temperature", error: "Temperature must be a number from 0 to 1 for the selected model, or empty for the model default." });
    expect(buildRunBody(claude, { maxTemperature: 2 }).ok).toBe(true);
    expect(buildRunBody(draft({ temperature: "1" }), { maxTemperature: 1 }).ok).toBe(true);
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
      provider: "openai", model: "gpt-5-nano", capturedProvider: "openai", capturedModel: "gpt-4-0613", modelSubstituted: true,
      system: "Triage tickets.", params: { temperature: 0.2, maxOutputTokens: 200 },
      messages: [
        { role: "user", content: "Weather?" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "get_weather", arguments: { city: "Paris" } }] },
        { role: "tool", toolCallId: "c1", name: "get_weather", content: "{\"temp\":11}" },
      ],
      tools: [{ name: "get_weather", parameters: { type: "object" } }],
      source: { runId: "support_triage_0613", spanId: "support_triage_0613_llm-2", runName: "Customer support triage", spanName: "ai.generateText", format: "ai-sdk" },
      warnings: ["gpt-4-0613 is not available in the Playground, so gpt-5-nano was selected instead."],
    };
    const state = stateFromDraft(source, defaultDraft(), { openedFrom: true });
    expect(state).toMatchObject({ system: "Triage tickets.", temperature: "0.2", maxOutputTokens: "200", toolsEnabled: true, targets: [{ provider: "openai", model: "gpt-5-nano" }] });
    expect(state.openedFrom).toEqual({ runId: "support_triage_0613", spanId: "support_triage_0613_llm-2", runName: "Customer support triage", spanName: "ai.generateText", capturedModel: "gpt-4-0613", substitutedModel: "gpt-5-nano", warnings: [] });
    expect(stateFromDraft({ ...source, model: "gpt-4.1-mini", capturedModel: "gpt-4.1-mini-2025-04-14", modelSubstituted: false, warnings: ["Reasoning blocks from the captured call were left out."] }, defaultDraft(), { openedFrom: true }).openedFrom)
      .toMatchObject({ capturedModel: "gpt-4.1-mini-2025-04-14", substitutedModel: null, warnings: ["Reasoning blocks from the captured call were left out."] });
    const built = buildRunBody(state);
    expect(built.ok && built.body.messages).toEqual(source.messages);
    expect(built.ok && built.body.source).toEqual({ runId: "support_triage_0613", spanId: "support_triage_0613_llm-2" });
    const reloaded = stateFromDraft(source, defaultDraft(), { openedFrom: false, targets: [{ provider: "openai", model: "gpt-5-nano" }, { provider: "anthropic", model: "claude-haiku-4-5-20251001" }] });
    expect(reloaded.openedFrom).toBeNull();
    expect(reloaded.targets).toHaveLength(2);
    expect(stateFromDraft(source, draft({ reasoningEffort: "high" }), { openedFrom: false }).reasoningEffort).toBe("");
  });

  test("only a draft with real work is offered back after Open in Playground replaces it", () => {
    expect(draftHasContent(defaultDraft())).toBe(false);
    expect(draftHasContent(draft())).toBe(true);
    expect(draftHasContent({ ...defaultDraft(), system: "Be brief." })).toBe(true);
    expect(draftHasContent({ ...defaultDraft(), targets: [{ provider: "openai", model: "gpt-5-nano" }, { provider: "gemini", model: "gemini-3.8-flash" }] })).toBe(true);
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

  test("the column prints the same cost digits as the recorded run", () => {
    const estimate = estimateResultCost(result({ provider: "anthropic", model: "claude-haiku-4-5-20251001", responseModel: "claude-haiku-4-5-20251001", usage: { inputTokens: 650, outputTokens: 61, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: null, totalTokens: 711 } }), Date.parse("2026-11-25T12:00:00Z"));
    expect(estimate.kind === "estimated" && recordedCostUsd(estimate.totalUsd)).toBe(0.000955);
  });

  test("compare columns mark the fastest and cheapest successful result", () => {
    const at = Date.parse("2026-11-25T12:00:00Z");
    const fast = result({ latencyMs: 700, timeToFirstTokenMs: 500 });
    const cheap = result({ index: 1, provider: "gemini", model: "gemini-3.5-flash-lite", responseModel: "gemini-3.5-flash-lite", latencyMs: 900, timeToFirstTokenMs: 300, usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningTokens: null, totalTokens: 15 } });
    const failed = result({ index: 2, status: "error", latencyMs: 10, timeToFirstTokenMs: null });
    expect(metricLeaders([fast, cheap, failed], at)).toEqual([["latency"], ["firstToken", "cost"], []]);
    expect(metricLeaders([fast, null], at)).toEqual([[], []]);
    expect(metricLeaders([fast, { ...fast, index: 1 }], at)).toEqual([[], []]);
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

  test("a rejected key says which key was used and how to fix that source", () => {
    expect(errorHelp("auth", { source: "store", envVar: null }).hint).toBe("Replace the key saved in Settings, or check with the provider that it has not been revoked.");
    expect(errorHelp("auth", { source: "env", envVar: "OPENAI_API_KEY" })).toEqual({
      title: "Key rejected", settings: true,
      hint: "No key is saved in Settings, so this one was used. Save a working key in Settings, which takes priority, or fix OPENAI_API_KEY and restart Run Phantom.",
    });
    expect(errorHelp("quota", { source: "env", envVar: "OPENAI_API_KEY" }).title).toBe("Out of quota");
  });
});

describe("nextTarget", () => {
  const provider = (id: PlaygroundProviderInfo["id"], configured: boolean, models: string[]): PlaygroundProviderInfo => ({
    id, label: id, configured, keySource: configured ? "store" : null, defaultModel: models[0]!,
    models: models.map(model => ({ id: model, label: model, temperature: true, maxTemperature: 2, reasoningEffort: false })),
  });
  const openai = (configured: boolean) => provider("openai", configured, ["gpt-5-nano", "gpt-5-mini", "gpt-4.1-mini"]);
  const anthropic = (configured: boolean) => provider("anthropic", configured, ["claude-haiku-4-5-20251001", "claude-haiku-5-5"]);
  const gemini = (configured: boolean) => provider("gemini", configured, ["gemini-3.8-flash"]);

  test("stays on keyed models before offering a provider without a key", () => {
    const providers = [openai(true), anthropic(false), gemini(false)];
    expect(nextTarget([{ provider: "openai", model: "gpt-5-nano" }], providers)).toEqual({ provider: "openai", model: "gpt-5-mini" });
    expect(nextTarget([{ provider: "openai", model: "gpt-5-nano" }, { provider: "openai", model: "gpt-5-mini" }], providers)).toEqual({ provider: "openai", model: "gpt-4.1-mini" });
    expect(nextTarget([{ provider: "openai", model: "gpt-5-nano" }, { provider: "openai", model: "gpt-5-mini" }, { provider: "openai", model: "gpt-4.1-mini" }], providers))
      .toEqual({ provider: "anthropic", model: "claude-haiku-4-5-20251001" });
  });

  test("prefers another keyed provider's default for a cross-provider compare", () => {
    const providers = [openai(true), anthropic(true), gemini(true)];
    expect(nextTarget([{ provider: "openai", model: "gpt-5-nano" }], providers)).toEqual({ provider: "anthropic", model: "claude-haiku-4-5-20251001" });
    expect(nextTarget([{ provider: "openai", model: "gpt-5-nano" }, { provider: "anthropic", model: "claude-haiku-4-5-20251001" }], providers)).toEqual({ provider: "gemini", model: "gemini-3.8-flash" });
    expect(nextTarget([{ provider: "anthropic", model: "claude-haiku-5-5" }], [openai(false), anthropic(true), gemini(true)])).toEqual({ provider: "gemini", model: "gemini-3.8-flash" });
    expect(nextTarget([{ provider: "openai", model: "gpt-5-nano" }], undefined)).toEqual({ provider: "openai", model: "gpt-5-nano" });
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

  test("compare runs are ordered by the column they filled", () => {
    expect(targetIndexOf([{ attributes: "{\"gen_ai.agent.name\":\"playground\"}" }, { attributes: "{\"runphantom.playground.target_index\":2}" }])).toBe(2);
    expect(targetIndexOf([{ attributes: "not json" }, { attributes: null }])).toBeNull();
    const runs = [{ id: "gemini" }, { id: "nano" }, { id: "old" }, { id: "haiku" }];
    expect(orderByColumn(runs, new Map([["gemini", 2], ["nano", 0], ["old", null], ["haiku", 1]])).map(run => run.id)).toEqual(["nano", "haiku", "gemini", "old"]);
  });

  test("Open in Playground links carry the span and its run", () => {
    expect(playgroundPathForSpan("demo_triage_llm-2", "demo_triage")).toBe("/playground?span=demo_triage_llm-2&run=demo_triage");
    expect(playgroundPathForSpan("a b")).toBe("/playground?span=a+b");
  });
});
