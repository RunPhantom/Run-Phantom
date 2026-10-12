import { describe, expect, test } from "bun:test";
import { parseClaudeHookInput, HOOK_LIMITS } from "../src/coding-hooks/shared";

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
