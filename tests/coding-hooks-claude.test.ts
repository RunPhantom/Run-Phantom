import { describe, expect, test } from "bun:test";
import { parseClaudeHookInput, HOOK_LIMITS } from "../src/coding-hooks/shared";
import { normalizeClaudeHook, NORMALIZATION_LIMITS } from "../src/coding-hooks/claude";
import { buildRedactionPolicy, resetActiveRedactionPolicy, setActiveRedactionPolicy } from "../src/verification/redaction";
import { hookFixture, hookSourceKey, transcriptRecord, transcriptSnapshot } from "./fixtures/coding-hooks-claude";

const session = "11111111-1111-4111-8111-111111111111";
const base = { session_id: session, hook_event_name: "SessionStart", source: "startup", transcript_path: `/private/fixture/projects/project/${session}.jsonl`, cwd: "/private/fixture/project" };
const parse = (value: unknown) => parseClaudeHookInput(JSON.stringify(value));

describe("Claude hook lexical and typed admission", () => {
  test("admits the documented session start as producer evidence without native authority", () => {
    const result = parse(base);
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.value.sessionId).toBe(session);
    expect(result.value.event).toBe("SessionStart");
    expect(result.value.runtimeVerified).toBe(false);
    expect(result.value.provenance).toBe("producer_reported");
    expect(result.value.coverageReasons).toEqual(["producer_unverified"]);
  });

  test.each(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure", "SessionEnd", "SubagentStart", "SubagentStop"])("preserves the closed %s event identity", event => {
    const value = { ...base, hook_event_name: event, prompt: "hello", tool_name: "Bash", tool_use_id: "toolu_fixture", tool_input: { command: "printf hello" }, tool_response: { stdout: "hello" }, error: "fixture failure", source: "startup", reason: "prompt_input_exit", agent_id: "agent_fixture", agent_type: "Explore", error_type: "server_error" };
    const result = parse(value);
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") expect(result.value.event).toBe(event);
  });

  test.each([
    '{"session_id":"private","session_id":"' + session + '","hook_event_name":"SessionStart","source":"startup"}',
    '{"session_id":"' + session + '","hook_event_name":"SessionStart","source":"startup","tool_input":{"token":"private","tok\\u0065n":"safe"}}',
    '{"session_id":"' + session + '","hook_event_name":"SessionStart","source":"startup","nested":[{"name":"private","name":"safe"}]}',
  ])("refuses lexical duplicate member ambiguity before typed interpretation", raw => {
    expect(parseClaudeHookInput(raw)).toEqual({ status: "unavailable", reason: "duplicate_keys" });
  });

  test("ordered duplicate array entries remain distinct source observations", () => {
    const result = parse({ ...base, tool_input: { attrs: [{ key: "ordinary", value: "first" }, { key: "ordinary", value: "second" }] } });
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") expect(result.value.toolInput).toEqual({ attrs: [{ key: "ordinary", value: "first" }, { key: "ordinary", value: "second" }] });
  });

  test("actual UTF8 bytes are bounded before parsing, independent of UTF16 length", () => {
    expect(parseClaudeHookInput('"' + "🧪".repeat(HOOK_LIMITS.stdinBytes / 4) + '"').reason).toBe("byte_limit");
    expect(parseClaudeHookInput(" ".repeat(HOOK_LIMITS.stdinBytes + 1)).reason).toBe("byte_limit");
  });

  test("depth guards ignore quoted brackets and escaped quotes", () => {
    const quoted = parse({ ...base, tool_input: { text: '\\" [[[[{{{{ ]]]]}}}}' } });
    expect(quoted.status).toBe("accepted");
    let deep: unknown = 1;
    for (let i = 0; i < HOOK_LIMITS.jsonDepth; i++) deep = [deep];
    expect(parse({ ...base, tool_input: deep }).reason).toBe("depth_limit");
  });

  test("one node budget covers all hook bodies rather than each selected field", () => {
    expect(parse({ ...base, tool_input: Array(HOOK_LIMITS.jsonNodes / 2).fill(null), tool_response: Array(HOOK_LIMITS.jsonNodes / 2).fill(null) }).reason).toBe("node_limit");
  });

  test.each(["1e400", "1e-400", "9007199254740993"])("rejects lossy numeric token %s before it changes source evidence", token => {
    expect(parseClaudeHookInput(JSON.stringify(base).replace(/}$/, ',"tool_input":{"count":' + token + '}}')).reason).toBe("invalid_number");
  });

  test.each(["__proto__", "constructor", "prototype"])("unsafe own member %s cannot become a prototype or operational option", key => {
    const raw = JSON.stringify(base).replace(/}$/, ',"tool_input":{"' + key + '":{"secret":"private"}}}');
    expect(parseClaudeHookInput(raw).reason).toBe("unsafe_key");
  });

  test("nonstring input is refused without getters, coercion or serialization", () => {
    let calls = 0;
    const hostile = { get session_id() { calls++; return session; }, toString() { calls++; return JSON.stringify(base); }, toJSON() { calls++; return base; } };
    expect(parseClaudeHookInput(hostile)).toEqual({ status: "unavailable", reason: "invalid_json" });
    expect(calls).toBe(0);
    expect(parseClaudeHookInput(Object.create(base)).status).toBe("unavailable");
  });

  test.each([null, [], {}, { ...base, session_id: "../another" }, { ...base, session_id: "bad\0id" }, { ...base, hook_event_name: "SessionStarted" }, { ...base, hook_event_name: "PreToolUse", tool_name: "Bash" }, { ...base, hook_event_name: "SessionEnd", reason: "invented_success" }, { ...base, cwd: "\ud800" }].map(value => [value]))("malformed required identity and unsupported event data cannot mint valid capture", value => {
    expect(parse(value).status).toBe("unavailable");
  });

  test("a future optional field or absent transcript is explicitly partial", () => {
    const { transcript_path: _transcript, ...without } = base;
    void _transcript;
    const result = parse({ ...without, future_option: "claimed" });
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") expect(result.value.coverageReasons).toEqual(["producer_unverified", "unknown_fields", "transcript_absent"]);
  });
});

describe("bounded Claude producer observations", () => {
  const full = { sourceKey: hookSourceKey, captureMode: "full" as const };
  const metadata = { ...full, captureMode: "metadata" as const };
  const entity = (result: ReturnType<typeof normalizeClaudeHook>, kind: string) => {
    if (result.status !== "accepted") throw new Error("fixture not admitted");
    return result.value.entities.find(value => value.kind === kind)!;
  };

  test("tool output and reported duration are preserved without fabricated runtime proof", () => {
    const result = normalizeClaudeHook(hookFixture("PostToolUse", { tool_name: "Bash", tool_use_id: "tool_exact", tool_input: { command: "printf safe" }, tool_response: { stdout: "safe exact output" }, duration_ms: 12.5 }), full, null);
    const tool = entity(result, "tool");
    expect(tool.phase).toBe("success"); expect(tool.body).toEqual({ input: { command: "printf safe" }, output: { stdout: "safe exact output" }, error: null });
    expect(tool.reportedDurationMs).toBe(12.5); expect(tool.runtimeDurationMs).toBeNull();
    expect(tool.runtimeVerified).toBe(false); expect(tool.producerVerified).toBe(false);
    expect(tool.incarnationKey).toBeNull(); expect(tool.sourceOffset).toBeNull();
    expect(JSON.stringify(result)).not.toContain("tool_exact");
  });

  test("metadata capture omits immediate and transcript business bodies", () => {
    const marker = "PRIVATE_BODY_FIXTURE";
    const snapshot = transcriptSnapshot([transcriptRecord({ message: { id: "msg_1", content: [{ type: "text", text: marker }], stop_reason: "end_turn" } })]);
    const result = normalizeClaudeHook(hookFixture("UserPromptSubmit", { prompt: marker, last_assistant_message: marker, tool_input: { ordinary: marker }, tool_response: marker }), metadata, snapshot);
    expect(result.status).toBe("accepted"); expect(JSON.stringify(result)).not.toContain(marker);
    if (result.status === "accepted") {
      expect(result.value.unlinkedAssertions).toBeNull();
      expect(result.value.entities.every(value => value.body === null)).toBe(true);
      expect(result.value.coverageReasons).toContain("producer_unverified");
    }
  });

  test("unidentified prompt and Stop output stay unlinked rather than becoming invented turns", () => {
    const prompt = normalizeClaudeHook(hookFixture("UserPromptSubmit", { prompt: "ordinary prompt" }), full, null);
    const stop = normalizeClaudeHook(hookFixture("Stop", { last_assistant_message: "ordinary output" }), full, null);
    for (const result of [prompt, stop]) {
      expect(result.status).toBe("accepted");
      if (result.status === "accepted") { expect(result.value.entities).toHaveLength(1); expect(result.value.sessionClosureClaim).toBe(false); }
    }
    if (prompt.status === "accepted") { expect(prompt.value.unlinkedAssertions?.prompt).toBe("ordinary prompt"); expect(prompt.value.coverageReasons).toContain("unresolved_prompt_identity"); }
    if (stop.status === "accepted") expect(stop.value.unlinkedAssertions?.assistant).toBe("ordinary output");
    const end = normalizeClaudeHook(hookFixture("SessionEnd", { reason: "prompt_input_exit" }), full, null);
    if (end.status === "accepted") { expect(end.value.sessionClosureClaim).toBe(true); expect(Object.hasOwn(end.value, "verdict")).toBe(false); }
  });

  test("exact API message ID coalesces last observed standalone usage without concatenating fragments", () => {
    const first = transcriptRecord({ message: { id: "msg_1", model: "fixture-model", content: [{ type: "text", text: "earlier" }], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    const last = transcriptRecord({ uuid: "record_2" });
    const snapshot = transcriptSnapshot([first, last]);
    const result = normalizeClaudeHook(hookFixture("Stop"), full, snapshot);
    const assistant = entity(result, "assistant");
    expect(assistant.body?.output).toEqual([{ type: "text", text: "safe exact business result" }]);
    expect(assistant.usage).toEqual({ freshInputTokens: 10, outputTokens: 4, cacheCreatedInputTokens: 0, cacheReadInputTokens: 2 });
    expect(assistant.coverageReasons).toContain("assistant_fragments_unmerged");
    expect(assistant.sourceOffset).toBe(snapshot.endOffset); expect(assistant.incarnationKey).toBe(snapshot.incarnationKey);
    if (result.status === "accepted") { expect(result.value.entities.filter(value => value.kind === "assistant")).toHaveLength(1); expect(entity(result, "session").usage).toBeNull(); }
  });

  test("shared request ID cannot merge distinct API message IDs", () => {
    const second = transcriptRecord({ uuid: "record_2", message: { id: "msg_2", content: [{ type: "text", text: "separate" }], stop_reason: "end_turn", usage: { input_tokens: 20 } } });
    const result = normalizeClaudeHook(hookFixture("Stop"), full, transcriptSnapshot([transcriptRecord(), second]));
    if (result.status !== "accepted") throw new Error("fixture not admitted");
    const assistants = result.value.entities.filter(value => value.kind === "assistant");
    expect(assistants).toHaveLength(2); expect(assistants[0].entityKey).not.toBe(assistants[1].entityKey);
    expect(assistants[1].usage?.outputTokens).toBeNull();
  });

  test("missing and invalid usage remains null and cannot produce a session rollup", () => {
    const noUsage = transcriptRecord({ message: { id: "msg_1", content: [], stop_reason: "end_turn" } });
    const missing = normalizeClaudeHook(hookFixture("Stop"), full, transcriptSnapshot([noUsage]));
    expect(entity(missing, "assistant").usage).toEqual({ freshInputTokens: null, outputTokens: null, cacheCreatedInputTokens: null, cacheReadInputTokens: null });
    const invalid = transcriptRecord({ message: { id: "msg_1", content: [], stop_reason: "end_turn", usage: { input_tokens: -1, output_tokens: 2.5, cache_creation_input_tokens: "20" } } });
    const result = normalizeClaudeHook(hookFixture("Stop"), full, transcriptSnapshot([invalid]));
    expect(entity(result, "assistant").usage?.freshInputTokens).toBeNull(); expect(entity(result, "assistant").coverageReasons).toContain("invalid_usage");
    expect(entity(result, "session").usage).toBeNull();
  });

  test("contradictory terminal claims become conflict and a later pending fragment cannot erase completion", () => {
    const record = transcriptRecord({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_exact", is_error: true, content: "reported failure" }] } });
    const conflict = normalizeClaudeHook(hookFixture("PostToolUse", { tool_use_id: "tool_exact", tool_name: "Bash", tool_response: "reported success" }), full, transcriptSnapshot([record]));
    expect(entity(conflict, "tool").phase).toBe("conflict"); expect(entity(conflict, "tool").coverageReasons).toContain("contradictory_terminal_claims");
    const pending = transcriptRecord({ uuid: "record_2", message: { id: "msg_1", content: [{ type: "text", text: "later pending" }], stop_reason: null } });
    const result = normalizeClaudeHook(hookFixture("Stop"), full, transcriptSnapshot([transcriptRecord(), pending]));
    expect(entity(result, "assistant").phase).toBe("complete"); expect(entity(result, "assistant").body?.output).toEqual([{ type: "text", text: "safe exact business result" }]);
    expect(entity(result, "assistant").coverageReasons).toContain("terminal_regression");
  });

  test("stable transcript UUID observations distinguish identical prompt bodies", () => {
    const prompt = (uuid: string) => transcriptRecord({ type: "user", uuid, message: { role: "user", content: "same prompt" } });
    const result = normalizeClaudeHook(hookFixture("Stop"), full, transcriptSnapshot([prompt("user_1"), prompt("user_2")]));
    if (result.status !== "accepted") throw new Error("fixture not admitted");
    const prompts = result.value.entities.filter(value => value.kind === "prompt");
    expect(prompts).toHaveLength(2); expect(prompts[0].entityKey).not.toBe(prompts[1].entityKey);
    expect(prompts.map(value => value.body?.input)).toEqual(["same prompt", "same prompt"]);
  });

  test("malformed and unsupported records are disclosed, and incomplete tail does not advance cursor", () => {
    const valid = transcriptRecord();
    const complete = transcriptSnapshot([valid, '{"type":"assistant","type":"user"}', transcriptRecord({ version: "future" })]);
    const snapshot = { ...complete, text: complete.text + '{"type":"assistant"', endOffset: complete.endOffset + 19, fileBytes: complete.fileBytes + 19 };
    const result = normalizeClaudeHook(hookFixture("Stop"), full, snapshot);
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      expect(result.value.transcriptCursor).toBe(complete.endOffset);
      expect(result.value.coverageReasons).toEqual(expect.arrayContaining(["duplicate_keys", "unsupported_version", "incomplete_tail", "producer_unverified"]));
      expect(result.value.entities.filter(value => value.kind === "assistant")).toHaveLength(1);
    }
  });

  test("source timestamps are never guessed from callback wall clock", () => {
    const result = normalizeClaudeHook(hookFixture("Stop"), full, transcriptSnapshot([transcriptRecord({ timestamp: "not a timestamp" })]));
    expect(entity(result, "assistant").reportedAt).toBeNull(); expect(entity(result, "assistant").coverageReasons).toContain("invalid_timestamp");
  });

  test("mandatory source-structure and value floor survives ambient allow exemptions", () => {
    const secret = "sk-ant-fixture-" + "x".repeat(30), marker = "PRIVATE_NESTED_VALUE";
    setActiveRedactionPolicy(buildRedactionPolicy({ allow: ["password", "apiKey", "token"] }));
    try {
      const result = normalizeClaudeHook(hookFixture("PostToolUse", { tool_use_id: "tool_privacy", tool_name: "Bash", tool_input: { password: marker, nested: { apiKey: marker, token: marker }, ordinary: "safe exact business", note: secret, url: "https://fixture.invalid/?token=" + marker }, tool_response: { ordinary: "safe output" } }), full, null);
      const text = JSON.stringify(result);
      expect(text).not.toContain(marker); expect(text).not.toContain(secret); expect(text).not.toContain("/private/fixture");
      expect(entity(result, "tool").body?.input).toEqual({ password: "[REDACTED]", nested: { apiKey: "[REDACTED]", token: "[REDACTED]" }, ordinary: "safe exact business", note: "[REDACTED]", url: "https://fixture.invalid/?token=%5BREDACTED%5D" });
      expect(entity(result, "tool").body?.output).toEqual({ ordinary: "safe output" });
    } finally { resetActiveRedactionPolicy(); }
  });

  test("quoted credential assignments inside selected prose remain private without parsing arbitrary business strings", () => {
    const marker = "PRIVATE_QUOTED_VALUE";
    setActiveRedactionPolicy(buildRedactionPolicy({ allow: ["password", "apiKey", "token"] }));
    try {
      const result = normalizeClaudeHook(hookFixture("PostToolUse", { tool_use_id: "tool_quoted", tool_name: "Bash", tool_response: '{"password":"' + marker + '","ordinary":"safe exact business"}' }), full, null);
      expect(JSON.stringify(result)).not.toContain(marker);
      expect(entity(result, "tool").body?.output).toContain('"ordinary":"safe exact business"');
    } finally { resetActiveRedactionPolicy(); }
  });

  test("assistant tool identities remain hashed and unsupported block fields are not copied", () => {
    const record = transcriptRecord({ message: { id: "msg_1", content: [{ type: "tool_use", id: "tool_PRIVATE_ID", name: "Bash", input: { command: "printf safe" }, unreviewedPrivate: "PRIVATE_FIELD" }, { type: "future_block", privateBody: "PRIVATE_UNSUPPORTED" }], stop_reason: "tool_use" } });
    const result = normalizeClaudeHook(hookFixture("Stop"), full, transcriptSnapshot([record]));
    expect(JSON.stringify(result)).not.toContain("tool_PRIVATE_ID"); expect(JSON.stringify(result)).not.toContain("PRIVATE_FIELD"); expect(JSON.stringify(result)).not.toContain("PRIVATE_UNSUPPORTED");
    const body = entity(result, "assistant").body?.output;
    expect(body).toEqual([{ type: "tool_use", toolIdentity: expect.stringMatching(/^[a-f0-9]{64}$/), name: "Bash", input: { command: "printf safe" } }]);
    expect(entity(result, "assistant").coverageReasons).toContain("unsupported_content");
  });

  test("metadata observes fragment ambiguity and model contradictions without retaining bodies", () => {
    const first = transcriptRecord(), second = transcriptRecord({ uuid: "record_2", message: { id: "msg_1", model: "other-model", content: [{ type: "text", text: "different output" }], stop_reason: "end_turn" } });
    const result = normalizeClaudeHook(hookFixture("Stop"), metadata, transcriptSnapshot([first, second]));
    expect(entity(result, "assistant").body).toBeNull(); expect(entity(result, "assistant").coverageReasons).toContain("assistant_fragments_unmerged");
    expect(entity(result, "assistant").coverageReasons).toContain("inconsistent_model_identity"); expect(entity(result, "assistant").phase).toBe("conflict");
    expect(JSON.stringify(result)).not.toContain("different output");
  });

  test("large selected transcript strings are refused whole before secret scanning or truncation can expose a credential prefix", () => {
    const marker = "PRIVATE_LONG_CREDENTIAL", content = marker + "x".repeat(NORMALIZATION_LIMITS.selectedStringUnits);
    const record = transcriptRecord({ message: { id: "msg_large", content: [{ type: "text", text: content }], stop_reason: "end_turn" } });
    const result = normalizeClaudeHook(hookFixture("Stop"), full, transcriptSnapshot([record]));
    expect(JSON.stringify(result)).not.toContain(marker); expect(entity(result, "assistant").coverageReasons).toContain("body_partial");
    expect(entity(result, "assistant").body?.output).toEqual([{ type: "text", text: "[TRUNCATED]" }]);
  });

  test("line and entity limits stop before skipped source bytes and disclose cumulative body loss", () => {
    const long = transcriptSnapshot([JSON.stringify({ type: "user", body: "x".repeat(NORMALIZATION_LIMITS.lineBytes) })]);
    const line = normalizeClaudeHook(hookFixture("Stop"), full, long);
    if (line.status !== "accepted") throw new Error("fixture not admitted");
    expect(line.value.transcriptCursor).toBe(0); expect(line.value.coverageReasons).toContain("line_limit");
    const many = Array.from({ length: NORMALIZATION_LIMITS.entities }, (_, index) => transcriptRecord({ uuid: `record_${index}`, message: { id: `msg_${index}`, content: [{ type: "text", text: "ordinary" }], stop_reason: "end_turn" } }));
    const limited = normalizeClaudeHook(hookFixture("Stop"), full, transcriptSnapshot(many));
    if (limited.status !== "accepted") throw new Error("fixture not admitted");
    expect(limited.value.entities).toHaveLength(NORMALIZATION_LIMITS.entities); expect(limited.value.coverageReasons).toContain("entity_limit");
    expect(limited.value.transcriptCursor).toBeLessThan(transcriptSnapshot(many).endOffset);
    expect(Buffer.byteLength(JSON.stringify(limited.value))).toBeLessThanOrEqual(NORMALIZATION_LIMITS.transportBytes);
    expect(limited.value.coverageReasons).toContain("body_partial");
  });

  test("malformed trusted snapshot and invalid source identity do not manufacture provenance", () => {
    const snapshot = transcriptSnapshot([transcriptRecord()]);
    expect(normalizeClaudeHook(hookFixture("Stop"), full, { ...snapshot, endOffset: snapshot.endOffset + 1 }).status).toBe("unavailable");
    expect(normalizeClaudeHook(hookFixture("Stop"), { ...full, sourceKey: "untrusted" }, snapshot).status).toBe("unavailable");
  });
});

describe("Claude hook authority and field limits", () => {
  test("payload capture, owner, PID and database claims never enter the admitted operational contract", () => {
    const result = parse({ ...base, captureMode: "full", ownerGeneration: "claimed", policy: { capture: "full" }, database: "/private/another.sqlite", pid: 123, runtimeVerified: true });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.value.runtimeVerified).toBe(false);
    expect(result.value.coverageReasons).toContain("unknown_fields");
    for (const key of ["captureMode", "ownerGeneration", "policy", "database", "pid"]) expect(Object.hasOwn(result.value, key)).toBe(false);
  });

  test("exact error string bounds reject object-valued or oversized bodies without coercion", () => {
    const tool = { ...base, hook_event_name: "PostToolUseFailure", tool_use_id: "toolu_error", tool_name: "Bash" };
    expect(parse({ ...tool, error: { message: "private" } }).reason).toBe("invalid_fields");
    expect(parse({ ...tool, error: "e".repeat(HOOK_LIMITS.errorUnits + 1) }).reason).toBe("field_limit");
    const allowed = parse({ ...tool, error: "e".repeat(HOOK_LIMITS.errorUnits), is_interrupt: true, duration_ms: 12.5 });
    expect(allowed.status).toBe("accepted");
    if (allowed.status === "accepted") {
      expect(allowed.value.error?.length).toBe(HOOK_LIMITS.errorUnits);
      expect(allowed.value.interrupted).toBe(true);
      expect(allowed.value.durationMs).toBe(12.5);
    }
  });

  test.each(["true", -1, {}, Number.MAX_SAFE_INTEGER + 1].map(value => [value]))("invalid producer duration %j is not guessed from other data", duration => {
    expect(parse({ ...base, duration_ms: duration }).status).toBe("unavailable");
  });

  test("Stop and SessionEnd retain different identities without a completed-session verdict", () => {
    const turn = parse({ ...base, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "safe business result" });
    const end = parse({ ...base, hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
    expect(turn.status).toBe("accepted"); expect(end.status).toBe("accepted");
    if (turn.status === "accepted" && end.status === "accepted") {
      expect(turn.value.event).toBe("Stop"); expect(turn.value.endReason).toBeNull();
      expect(turn.value.lastAssistantMessage).toBe("safe business result"); expect(turn.value.stopHookActive).toBe(false);
      expect(end.value.event).toBe("SessionEnd"); expect(end.value.endReason).toBe("prompt_input_exit");
      expect(Object.hasOwn(end.value, "outcome")).toBe(false);
    }
  });

  test("subagent source path and exact ID remain private acquisition data, with no inferred Task linkage", () => {
    const result = parse({ ...base, hook_event_name: "SubagentStop", agent_id: "agent_a", agent_type: "Explore", agent_transcript_path: "/private/fixture/projects/project/subagents/agent-agent_a.jsonl" });
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      expect(result.value.agentId).toBe("agent_a"); expect(result.value.agentTranscriptPath).toEndWith("agent-agent_a.jsonl");
      expect(result.value.toolId).toBeNull();
    }
  });

  test.each(["tool_use_id", "model", "prompt"])("selected %s field cannot multiply the admitted output bound", field => {
    const limit = field === "tool_use_id" ? HOOK_LIMITS.identifierUnits : HOOK_LIMITS.selectedStringUnits;
    expect(parse({ ...base, [field]: "a".repeat(limit + 1) }).reason).toBe("field_limit");
  });
});
