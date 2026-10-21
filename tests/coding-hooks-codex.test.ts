import { expect, test } from "bun:test";
import { codexSnapshotOtlp, decodeCodexRollout, parseCodexHookInput } from "../src/coding-hooks/codex";
import { parseOtlpRequest } from "../src/parse";
import { normalizeStoredSpan } from "../src/spans/normalize";
import { codexHook, codexJsonl, codexRecord, codexRecords, codexSession, codexTurn } from "./fixtures/coding-hooks-codex";
import path from "node:path";
const cwd = path.resolve("synthetic workspace");
const expected = { sessionId: codexSession, cwd };
function snapshot(records: unknown[] = codexRecords(cwd)) {
  const parsed = decodeCodexRollout(codexJsonl(records), expected);
  if (parsed.status !== "accepted") throw new Error(parsed.reason);
  return parsed.value;
}
test("documented hooks distinguish session lifecycle from active turn identity", () => {
  for (const event of ["Stop", "Interrupt", "UserPromptSubmit", "PostToolUse"]) expect(parseCodexHookInput(codexHook(cwd, path.join(cwd, "rollout.jsonl"), event))).toMatchObject({ status: "accepted", value: { sessionId: codexSession, turnId: codexTurn, event } });
  const hook = JSON.parse(codexHook(cwd, "source")); delete hook.turn_id;
  expect(parseCodexHookInput(JSON.stringify(hook)).status).toBe("unavailable");
  hook.hook_event_name = "SessionEnd"; expect(parseCodexHookInput(JSON.stringify(hook))).toMatchObject({ status: "accepted", value: { turnId: null } });
  expect(parseCodexHookInput('{"session_id":"a","session_id":"b"}')).toMatchObject({ status: "unavailable", reason: "duplicate_keys" });
});
test("root, prompt, assistant and once-only tool IDs have truthful typed read projections", () => {
  const s = snapshot(), spans = parseOtlpRequest(codexSnapshotOtlp(s, "fixture-registration"));
  expect(s.entities.map(e => e.kind).sort()).toEqual(["assistant", "prompt", "session", "tool"]);
  expect(spans.map(s => s.spanId)).toEqual(parseOtlpRequest(codexSnapshotOtlp(snapshot(), "fixture-registration")).map(s => s.spanId));
  expect(spans.filter(s => !s.parentSpanId)).toHaveLength(1);
  expect(spans.every(s => s.status === "UNSET")).toBe(true);
  expect(spans.every(s => s.endTimeMs === 0 && s.durationMs === 0)).toBe(true);
  for (const span of spans) {
    const view = normalizeStoredSpan({ name: span.name, span_type: span.spanType, input_payload: span.inputPayload ?? null, output_payload: span.outputPayload ?? null, attributes: JSON.stringify(span.attributes) }).normalized;
    expect(view.capture).toMatchObject({ contract: "runphantom.codex-hook.observation/v1", coverage: "partial", producerVerified: false, runtimeVerified: false, reportedPhase: "unknown" });
    if (view.capture?.entityKind === "assistant") expect(view.capture.assistantText).toBe("Found the café result");
    if (view.capture?.entityKind === "prompt") expect(view.capture.userText).toBe("Find the café result");
  }
});
test("authoritative cumulative totals replace corrected root values without turn or cached/reasoning overlap", () => {
  const spans = parseOtlpRequest(codexSnapshotOtlp(snapshot(), "registration"));
  expect(spans.reduce((n, s) => n + (s.inputTokens ?? 0), 0)).toBe(19);
  expect(spans.reduce((n, s) => n + (s.outputTokens ?? 0), 0)).toBe(5);
  expect(spans.filter(s => s.parentSpanId).every(s => s.inputTokens === undefined && s.outputTokens === undefined)).toBe(true);
  const records = codexRecords(cwd);
  records.push(codexRecord("event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 17, cached_input_tokens: 3, output_tokens: 4, reasoning_output_tokens: 1, total_tokens: 21 } } }, 6));
  expect(snapshot(records).usage).toEqual({ inputTokens: 17, outputTokens: 4, cachedInputTokens: 3, reasoningOutputTokens: 1 });
  expect(snapshot(codexRecords(cwd).slice(0, -1)).usage).toBeNull();
});
test("streamed duplicate tool IDs deduplicate while conflicting identity is refused", () => {
  const records = codexRecords(cwd); records.splice(4, 0, records[3]);
  expect(snapshot(records).entities.filter(e => e.kind === "tool")).toHaveLength(1);
  records.splice(4, 0, codexRecord("response_item", { type: "function_call", call_id: "call_1", name: "lookup", arguments: "changed" }));
  expect(decodeCodexRollout(codexJsonl(records), expected)).toMatchObject({ status: "unavailable", reason: "conflicting_tool_identity" });
});
test("new turns and changed exact prompt or tool bytes create new identities", () => {
  const records = codexRecords(cwd), original = snapshot(records);
  const changed = structuredClone(records); (changed[2].payload as { content: { text: string }[] }).content[0].text += " changed";
  expect(snapshot(changed).entities.find(e => e.kind === "prompt")!.key).not.toBe(original.entities.find(e => e.kind === "prompt")!.key);
  records.push(codexRecord("turn_context", { turn_id: codexTurn + "2", cwd, model: "fixture-model" }, 6), ...codexRecords(cwd).slice(2, 6));
  expect(snapshot(records).entities.filter(e => e.kind === "tool")).toHaveLength(2);
  expect(snapshot(records).entities.filter(e => e.kind === "session")).toHaveLength(1);
});
test("changed vendor version, foreign/forked identities, malformed usage and incomplete tails fail closed", () => {
  for (const patch of [{ cli_version: "future" }, { id: "foreign" }, { parent_thread_id: "parent" }, { forked_from_id: "fork" }]) {
    const records = codexRecords(cwd); Object.assign(records[0].payload as object, patch);
    expect(decodeCodexRollout(codexJsonl(records), expected).status).toBe("unavailable");
  }
  const malformed = codexRecords(cwd); (malformed[6].payload as { info: { total_token_usage: { input_tokens: number } } }).info.total_token_usage.input_tokens = -1;
  expect(decodeCodexRollout(codexJsonl(malformed), expected)).toMatchObject({ status: "unavailable", reason: "invalid_usage" });
  expect(decodeCodexRollout(codexJsonl(codexRecords(cwd)).trimEnd(), expected).status).toBe("unavailable");
  expect(decodeCodexRollout("x".repeat(2097153), expected).status).toBe("unavailable");
});
test("ordinary ended OTLP keeps its existing success semantics", () => {
  const body = codexSnapshotOtlp(snapshot(), "registration") as { resourceSpans: { scopeSpans: { spans: { attributes: { key: string }[]; endTimeUnixNano: string }[] }[] }[] };
  const spans = body.resourceSpans[0].scopeSpans[0].spans;
  for (const span of spans) { span.attributes = span.attributes.filter(a => !["captureContract", "source"].includes(a.key)); span.endTimeUnixNano = "1792317601000000000"; }
  expect(parseOtlpRequest(body).every(s => s.status === "OK" && s.endTimeMs > 0)).toBe(true);
});
