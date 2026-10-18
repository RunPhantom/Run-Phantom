import { describe, expect, test } from "bun:test";
import { CURSOR_HOOK_EVENTS, normalizeCursorHook, parseCursorHookInput } from "../src/coding-hooks/cursor";
import { validateClaudeBatch } from "../src/coding-hooks/protocol";
import { HOOK_LIMITS } from "../src/coding-hooks/shared";
import { cursorHook } from "./fixtures/coding-hooks-cursor";
const source = "a".repeat(64);
function parsed(event: string, fields: Record<string, unknown> = {}) {
  const result = parseCursorHookInput(cursorHook(event, fields));
  if (result.status !== "accepted") throw new Error(result.reason);
  return result.value;
}
describe("Cursor native observation contract (synthetic vendor fixtures)", () => {
  for (const event of CURSOR_HOOK_EVENTS) test(`admits documented ${event} without claiming producer verification`, () => {
    const hook = parsed(event), batch = normalizeCursorHook(hook, source, "full");
    expect(hook.event).toBe(event); expect(batch.runtimeVerified).toBe(false); expect(batch.producerVerified).toBe(false); expect(batch.coverage).toBe("partial");
    expect(batch.entities[0].name).toBe("Cursor session"); expect(validateClaudeBatch(JSON.stringify(batch), source, "full")).toEqual(batch);
  });
  test("native and compatibility spelling deduplicate the exact same tool identity", () => {
    const native = normalizeCursorHook(parsed("postToolUse"), source, "full");
    const shim = normalizeCursorHook(parsed("postToolUse", { hook_event_name: "PostToolUse" }), source, "full");
    expect(shim.entities).toEqual(native.entities);
    const other = normalizeCursorHook(parsed("postToolUse", { generation_id: "other-generation" }), source, "full");
    expect(other.entities[1].entityKey).not.toBe(native.entities[1].entityKey);
  });
  test("metadata omits prompt, result, error and output while full retains safe original output", () => {
    for (const event of ["beforeSubmitPrompt", "postToolUse", "postToolUseFailure", "afterAgentResponse"]) {
      const hook = parsed(event), meta = normalizeCursorHook(hook, source, "metadata");
      expect(meta.entities.every(e => e.body === null)).toBe(true); expect(meta.unlinkedAssertions).toBeNull();
    }
    const output = normalizeCursorHook(parsed("afterAgentResponse"), source, "full").entities[1];
    expect(output.body?.output).toEqual([{ type: "text", text: "Captured synthetic Cursor answer" }]);
    expect(output.usage).toBeNull(); expect(output.runtimeDurationMs).toBeNull();
  });
  test("fixed redaction floor removes secrets in bodies, labels and serialized URLs", () => {
    const value = normalizeCursorHook(parsed("postToolUse", { tool_name: "token=PRIVATE_CURSOR_CANARY", tool_input: { password: "PRIVATE_CURSOR_CANARY", nested: "https://fixture.invalid/?api_key=PRIVATE_CURSOR_CANARY" }, tool_output: '{"token":"PRIVATE_CURSOR_CANARY","answer":"safe"}' }), source, "full");
    expect(JSON.stringify(value)).not.toContain("PRIVATE_CURSOR_CANARY"); expect(value.coverageReasons).toContain("body_redacted");
  });
  test("missing generation retains an unlinked assertion, not an invented response identity", () => {
    const value = normalizeCursorHook(parsed("afterAgentResponse", { generation_id: undefined }), source, "full");
    expect(value.entities).toHaveLength(1); expect(value.coverageReasons).toContain("unresolved_assistant_identity");
    expect(value.unlinkedAssertions?.assistant).toBe("Captured synthetic Cursor answer");
  });
  test("reported file paths and unknown fields never authorize transcript acquisition", () => {
    const result = parseCursorHookInput(cursorHook("stop", { transcript_path: "/private/DO_NOT_OPEN", user_email: "never retained" }));
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") { const value = normalizeCursorHook(result.value, source, "full"); expect(value.coverageReasons).toContain("unknown_fields"); expect(JSON.stringify(value)).not.toContain("DO_NOT_OPEN"); expect(JSON.stringify(value)).not.toContain("never retained"); expect(value.incarnationKey).toBeNull(); }
  });
  for (const [name, raw] of [
    ["duplicate key", '{"hook_event_name":"stop","hook_event_name":"sessionStart"}'],
    ["unsafe key", '{"constructor":{}}'],
    ["oversized", " ".repeat(HOOK_LIMITS.stdinBytes + 1)],
    ["missing tool identity", cursorHook("postToolUse", { tool_use_id: null })],
    ["ambiguous session", cursorHook("sessionEnd", { session_id: "other" })],
    ["invalid duration", cursorHook("postToolUse", { duration: -1 })],
    ["permission event", cursorHook("preToolUse")],
    ["ambiguous workspace", cursorHook("stop", { workspace_roots: ["/one", "/two"] })],
    ["relative workspace", cursorHook("stop", { workspace_roots: ["relative"] })],
    ["invalid status", cursorHook("stop", { status: "probably-done" })],
    ["selected string bound", cursorHook("afterAgentResponse", { text: "a".repeat(4097) })],
    ["nonfinite precision", cursorHook("postToolUse").replace('"duration":12', '"duration":9007199254740993')],
  ]) test(`refuses ${name} before any IO`, () => expect(parseCursorHookInput(raw).status).toBe("unavailable"));
});
