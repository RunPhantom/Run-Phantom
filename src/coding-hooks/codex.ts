import { createHash } from "node:crypto";
import { parseBoundedHookJson, type HookJson } from "./shared";

export const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "Interrupt", "SessionEnd"] as const;
export const CODEX_CAPTURE_CONTRACT = "runphantom.codex-hook.observation/v1";
export const CODEX_ROLLOUT_VERSION = "0.163.0";
export const CODEX_LIMITS = Object.freeze({ bytes: 2 * 1024 * 1024, records: 5000, entities: 1000 });
export const codexDigest = (value: string): string => createHash("sha256").update(value).digest("hex");
export const codexObject = (v: unknown): v is Record<string, HookJson> => !!v && typeof v === "object" && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(v);
export interface CodexHookInput { sessionId: string; event: typeof CODEX_EVENTS[number]; cwd: string; transcriptPath: string | null; turnId: string | null; }
export interface CodexUsage { inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningOutputTokens: number; }
export interface CodexEntity { key: string; kind: "session" | "prompt" | "assistant" | "tool"; turnId: string | null; name: string; input: HookJson; output: HookJson; at: number; model: string | null; }
export interface CodexSnapshot { sessionId: string; cwd: string; usage: CodexUsage | null; entities: CodexEntity[]; }
export type CodexResult<T> = { status: "accepted"; value: T } | { status: "unavailable"; reason: string };
const unavailable = (reason: string): { status: "unavailable"; reason: string } => ({ status: "unavailable", reason });
function validStrings(value: HookJson): boolean {
  if (typeof value === "string") return !value.includes("\0") && Buffer.from(value).toString("utf8") === value;
  if (!value || typeof value !== "object") return true;
  return Object.entries(value).every(([key, next]) => validStrings(key) && validStrings(next));
}

export function parseCodexHookInput(raw: unknown): CodexResult<CodexHookInput> {
  const parsed = parseBoundedHookJson(raw);
  if (parsed.status !== "accepted") return parsed;
  const p = parsed.value;
  if (!validStrings(p) || !codexObject(p) || !identifier(p.session_id) || typeof p.cwd !== "string" || p.cwd.length > 4096 || p.cwd.includes("\0")
    || !CODEX_EVENTS.includes(p.hook_event_name as typeof CODEX_EVENTS[number])
    || !(p.transcript_path === null || typeof p.transcript_path === "string" && p.transcript_path.length <= 4096 && !p.transcript_path.includes("\0"))
    || p.turn_id !== undefined && !identifier(p.turn_id)) return unavailable("invalid_fields");
  const event = p.hook_event_name as typeof CODEX_EVENTS[number];
  if (!["SessionStart", "SessionEnd"].includes(event) && !identifier(p.turn_id)) return unavailable("turn_id_absent");
  return { status: "accepted", value: { sessionId: p.session_id, cwd: p.cwd, transcriptPath: p.transcript_path, turnId: typeof p.turn_id === "string" ? p.turn_id : null, event } };
}

function usage(value: HookJson | undefined): CodexUsage | null {
  if (!codexObject(value)) return null;
  const keys = ["input_tokens", "output_tokens", "cached_input_tokens", "reasoning_output_tokens", "total_tokens"];
  if (keys.some(k => typeof value[k] !== "number" || !Number.isSafeInteger(value[k]) || (value[k] as number) < 0)) return null;
  const n = value as Record<string, number>;
  if (n.cached_input_tokens > n.input_tokens || n.reasoning_output_tokens > n.output_tokens || n.input_tokens + n.output_tokens !== n.total_tokens) return null;
  return { inputTokens: n.input_tokens, outputTokens: n.output_tokens, cachedInputTokens: n.cached_input_tokens, reasoningOutputTokens: n.reasoning_output_tokens };
}
function messageText(value: HookJson | undefined): string | null {
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const p of value) {
    if (!codexObject(p) || !["input_text", "output_text"].includes(String(p.type)) || typeof p.text !== "string") return null;
    parts.push(p.text);
  }
  const text = parts.join("");
  return Buffer.byteLength(text) <= 16384 ? text : null;
}

/** Rollouts are an unstable vendor interface: only this explicitly qualified version is decoded. */
export function decodeCodexRollout(raw: string, expected: Pick<CodexHookInput, "sessionId" | "cwd">): CodexResult<CodexSnapshot> {
  if (Buffer.byteLength(raw) > CODEX_LIMITS.bytes || !raw.endsWith("\n")) return unavailable("incomplete_or_large_source");
  const lines = raw.slice(0, -1).split("\n");
  if (!lines.length || lines.length > CODEX_LIMITS.records) return unavailable("record_limit");
  let turnId: string | null = null, model: string | null = null, totals: CodexUsage | null = null, meta = false;
  const entities = new Map<string, CodexEntity>(), calls = new Map<string, string>(), outputs = new Map<string, HookJson>();
  for (let index = 0; index < lines.length; index++) {
    const decoded = parseBoundedHookJson(lines[index]);
    if (decoded.status !== "accepted" || !codexObject(decoded.value) || !validStrings(decoded.value)) return unavailable("invalid_record");
    const r = decoded.value, p = r.payload;
    if (!codexObject(p) || typeof r.type !== "string" || typeof r.timestamp !== "string" || !Number.isFinite(Date.parse(r.timestamp))) return unavailable("invalid_record");
    const at = Date.parse(r.timestamp);
    if (r.type === "session_meta") {
      if (index !== 0 || p.id !== expected.sessionId || p.cwd !== expected.cwd || p.cli_version !== CODEX_ROLLOUT_VERSION || p.parent_thread_id != null || p.forked_from_id != null) return unavailable("unsupported_source_identity");
      meta = true;
      entities.set("session", { key: "session", kind: "session", turnId: null, name: "Codex session", input: null, output: null, at, model: null });
    } else if (!meta) return unavailable("session_meta_absent");
    else if (r.type === "turn_context") {
      if (!identifier(p.turn_id) || typeof p.model !== "string" || p.model.length > 256 || p.cwd !== expected.cwd) return unavailable("invalid_turn");
      turnId = p.turn_id; model = p.model;
    } else if (r.type === "event_msg" && p.type === "token_count") {
      if (p.info === null) continue;
      if (!codexObject(p.info) || !(totals = usage(p.info.total_token_usage))) return unavailable("invalid_usage");
    } else if (r.type === "response_item") {
      if (!turnId) return unavailable("turn_context_absent");
      if (p.type === "message" && ["user", "assistant"].includes(String(p.role))) {
        const body = messageText(p.content);
        if (body === null) return unavailable("unsupported_message");
        const kind = p.role === "user" ? "prompt" : "assistant";
        const key = codexDigest(JSON.stringify([turnId, model, kind, p.id ?? index, body]));
        entities.set(key, { key, kind, turnId, name: kind === "prompt" ? "User prompt" : "Assistant observation", input: kind === "prompt" ? body : null, output: kind === "assistant" ? body : null, at, model });
      } else if (["function_call", "custom_tool_call"].includes(String(p.type))) {
        if (!identifier(p.call_id) || typeof p.name !== "string" || !p.name || p.name.length > 256) return unavailable("invalid_tool");
        const input = p.type === "function_call" ? p.arguments : p.input;
        if (typeof input !== "string" || Buffer.byteLength(input) > 16384) return unavailable("invalid_tool");
        const key = codexDigest(JSON.stringify([turnId, model, p.type, p.call_id, p.name, input]));
        const call = turnId + ":" + p.call_id;
        if (calls.has(call) && calls.get(call) !== key) return unavailable("conflicting_tool_identity");
        calls.set(call, key);
        if (!entities.has(key)) entities.set(key, { key, kind: "tool", turnId, name: p.name, input, output: null, at, model: null });
      } else if (["function_call_output", "custom_tool_call_output"].includes(String(p.type))) {
        if (!identifier(p.call_id) || p.output === undefined || Buffer.byteLength(JSON.stringify(p.output)) > 16384) return unavailable("invalid_tool_output");
        const call = turnId + ":" + p.call_id;
        if (outputs.has(call) && JSON.stringify(outputs.get(call)) !== JSON.stringify(p.output)) return unavailable("conflicting_tool_output");
        outputs.set(call, p.output);
      }
    }
    if (entities.size > CODEX_LIMITS.entities) return unavailable("entity_limit");
  }
  if (!meta) return unavailable("session_meta_absent");
  for (const [call, output] of outputs) {
    const key = calls.get(call);
    if (!key) return unavailable("orphan_tool_output");
    entities.get(key)!.output = output;
  }
  return { status: "accepted", value: { sessionId: expected.sessionId, cwd: expected.cwd, usage: totals, entities: [...entities.values()] } };
}

function anyValue(v: unknown): unknown {
  if (v === null) return { stringValue: "null" };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "number") return { intValue: String(v) };
  if (typeof v === "boolean") return { boolValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(anyValue) } };
  return { kvlistValue: { values: Object.entries(v as Record<string, unknown>).map(([key, value]) => ({ key, value: anyValue(value) })) } };
}
/** Only the session root carries the cumulative provider totals; turns and tools never repeat them. */
export function codexSnapshotOtlp(snapshot: CodexSnapshot, registrationKey: string): unknown {
  const traceId = codexDigest(JSON.stringify(["codex", registrationKey, snapshot.sessionId])).slice(0, 32);
  const rootId = codexDigest(traceId + ":session").slice(0, 16);
  const spans = snapshot.entities.map(e => {
    const attrs: Record<string, unknown> = { captureContract: CODEX_CAPTURE_CONTRACT, source: "codex_hook", entityKind: e.kind, coverage: "partial", producerVerified: false, runtimeVerified: false, reportedPhase: "unknown", "runphantom.span.kind": e.kind === "session" ? "agent_root" : e.kind === "tool" ? "tool_call" : e.kind === "assistant" ? "llm_call" : "internal", "gen_ai.provider.name": "openai", "runphantom.conversation.id": snapshot.sessionId };
    if (e.turnId) attrs.turnId = e.turnId;
    if (e.model) attrs["gen_ai.request.model"] = e.model;
    if (e.input !== null) attrs["runphantom.input"] = JSON.stringify(e.input);
    if (e.output !== null) attrs["runphantom.output"] = JSON.stringify(e.output);
    if (e.kind === "session" && snapshot.usage) {
      attrs["gen_ai.usage.input_tokens"] = snapshot.usage.inputTokens;
      attrs["gen_ai.usage.output_tokens"] = snapshot.usage.outputTokens;
      attrs.cachedInputTokens = snapshot.usage.cachedInputTokens;
      attrs.reasoningOutputTokens = snapshot.usage.reasoningOutputTokens;
      attrs.usageAccounting = "authoritative_session_total_inclusive";
    }
    return { traceId, spanId: e.kind === "session" ? rootId : codexDigest(traceId + ":" + e.key).slice(0, 16), ...(e.kind === "session" ? {} : { parentSpanId: rootId }), name: e.name, startTimeUnixNano: String(BigInt(e.at) * 1000000n), endTimeUnixNano: "0", status: { code: 0 }, attributes: Object.entries(attrs).map(([key, value]) => ({ key, value: anyValue(value) })) };
  });
  return { resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: "runphantom.codex-hooks", version: "1" }, spans }] }] };
}
