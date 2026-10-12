import { LossyJsonNumberError, parseJsonEvidence } from "../evaluations/json-evidence";
import { hasDuplicateJsonKeys } from "../json-keys";

export const HOOK_LIMITS = Object.freeze({
  stdinBytes: 262144,
  jsonDepth: 16,
  jsonNodes: 5000,
  selectedStringUnits: 4096,
  identifierUnits: 256,
  errorUnits: 1000,
});
export const CLAUDE_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure", "SessionEnd", "SubagentStart", "SubagentStop"] as const;
export type ClaudeHookEvent = typeof CLAUDE_HOOK_EVENTS[number];
export type HookFailure = "invalid_json" | "byte_limit" | "depth_limit" | "node_limit" | "duplicate_keys" | "invalid_number" | "unsafe_key" | "invalid_fields" | "field_limit" | "unsupported_event";
export type HookCoverageReason = "producer_unverified" | "unknown_fields" | "transcript_absent";
export type HookJson = null | boolean | number | string | HookJson[] | { [key: string]: HookJson };
export type HookResult<T> = { status: "accepted"; value: T; reason?: never } | { status: "unavailable"; reason: HookFailure };
export interface ClaudeHookInput {
  sessionId: string;
  event: ClaudeHookEvent;
  provenance: "producer_reported";
  runtimeVerified: false;
  coverageReasons: HookCoverageReason[];
  transcriptPath: string | null;
  cwd: string | null;
  agentId: string | null;
  agentType: string | null;
  agentTranscriptPath: string | null;
  stopHookActive: boolean | null;
  model: string | null;
  permissionMode: string | null;
  source: string | null;
  endReason: string | null;
  prompt: string | null;
  toolId: string | null;
  toolName: string | null;
  toolInput: HookJson | null;
  toolResponse: HookJson | null;
  error: string | null;
  errorType: string | null;
  interrupted: boolean | null;
  durationMs: number | null;
  lastAssistantMessage: string | null;
}
export type HookAdmission = HookResult<ClaudeHookInput>;

function refusal<T>(reason: HookFailure): HookResult<T> { return { status: "unavailable", reason }; }

/** The lexical limit runs before JSON.parse, which would otherwise erase duplicate members. */
export function parseBoundedHookJson(input: unknown, byteLimit = HOOK_LIMITS.stdinBytes): HookResult<HookJson> {
  if (typeof input !== "string") return refusal("invalid_json");
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > HOOK_LIMITS.stdinBytes || Buffer.byteLength(input, "utf8") > byteLimit) return refusal("byte_limit");
  let depth = 0, quoted = false;
  for (let i = 0; i < input.length; i++) {
    const character = input[i];
    if (quoted) {
      if (character === "\\") i++;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") { if (++depth > HOOK_LIMITS.jsonDepth) return refusal("depth_limit"); }
    else if (character === "}" || character === "]") depth--;
  }
  try {
    const value = parseJsonEvidence(input) as HookJson;
    if (hasDuplicateJsonKeys(input)) return refusal("duplicate_keys");
    const pending: HookJson[] = [value];
    let nodes = 0;
    while (pending.length) {
      if (++nodes > HOOK_LIMITS.jsonNodes) return refusal("node_limit");
      const next = pending.pop();
      if (next && typeof next === "object") {
        for (const key of Object.keys(next)) {
          if (key === "__proto__" || key === "prototype" || key === "constructor") return refusal("unsafe_key");
          pending.push((next as { [key: string]: HookJson })[key]);
        }
        if (nodes + pending.length > HOOK_LIMITS.jsonNodes) return refusal("node_limit");
      }
    }
    return { status: "accepted", value };
  } catch (error) { return refusal(error instanceof LossyJsonNumberError ? "invalid_number" : "invalid_json"); }
}

function validText(value: string): boolean {
  if (value.includes("\0")) return false;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const following = value.charCodeAt(++i);
      if (!(following >= 0xdc00 && following <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

const fields = new Set(["session_id", "hook_event_name", "transcript_path", "cwd", "permission_mode", "agent_id", "agent_type", "model", "source", "reason", "prompt", "tool_use_id", "tool_name", "tool_input", "tool_response", "error", "error_type", "is_interrupt", "duration_ms", "stop_hook_active", "last_assistant_message", "agent_transcript_path", "background_tasks", "session_crons"]);
const sources = new Set(["startup", "resume", "clear", "compact", "fork"]);
const endReasons = new Set(["clear", "resume", "logout", "prompt_input_exit", "other"]);
const identifiers = ["session_id", "tool_use_id", "agent_id"];
const stringFields = ["transcript_path", "cwd", "permission_mode", "agent_id", "agent_type", "model", "source", "reason", "prompt", "tool_use_id", "tool_name", "error", "error_type", "last_assistant_message", "agent_transcript_path"];

/** Returned paths and bodies are private acquisition inputs, never a public transport projection. */
export function parseClaudeHookInput(input: unknown): HookAdmission {
  const decoded = parseBoundedHookJson(input);
  if (decoded.status !== "accepted") return decoded;
  const source = decoded.value;
  if (!source || Array.isArray(source) || typeof source !== "object") return refusal("invalid_fields");
  if (typeof source.session_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(source.session_id)) return refusal("invalid_fields");
  if (typeof source.hook_event_name !== "string" || !CLAUDE_HOOK_EVENTS.includes(source.hook_event_name as ClaudeHookEvent)) return refusal("unsupported_event");
  for (const key of stringFields) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || !validText(value)) return refusal("invalid_fields");
    const cap = key === "error" ? HOOK_LIMITS.errorUnits : identifiers.includes(key) ? HOOK_LIMITS.identifierUnits : HOOK_LIMITS.selectedStringUnits;
    if (value.length > cap) return refusal("field_limit");
    if (identifiers.includes(key) && !/^[A-Za-z0-9_.:-]+$/.test(value)) return refusal("invalid_fields");
  }
  for (const key of ["is_interrupt", "stop_hook_active"]) if (source[key] !== undefined && source[key] !== null && typeof source[key] !== "boolean") return refusal("invalid_fields");
  if (source.duration_ms !== undefined && source.duration_ms !== null && (typeof source.duration_ms !== "number" || source.duration_ms < 0 || source.duration_ms > Number.MAX_SAFE_INTEGER)) return refusal("invalid_fields");
  const event = source.hook_event_name as ClaudeHookEvent;
  if (event === "SessionStart" && (typeof source.source !== "string" || !sources.has(source.source))) return refusal("invalid_fields");
  if (event === "SessionEnd" && (typeof source.reason !== "string" || !endReasons.has(source.reason))) return refusal("invalid_fields");
  if (event === "UserPromptSubmit" && typeof source.prompt !== "string") return refusal("invalid_fields");
  if (["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(event) && (typeof source.tool_use_id !== "string" || typeof source.tool_name !== "string" || !source.tool_name)) return refusal("invalid_fields");
  if (event === "PostToolUseFailure" && typeof source.error !== "string") return refusal("invalid_fields");
  if (["SubagentStart", "SubagentStop"].includes(event) && typeof source.agent_id !== "string") return refusal("invalid_fields");
  const coverageReasons: HookCoverageReason[] = ["producer_unverified"];
  if (Object.keys(source).some(key => !fields.has(key))) coverageReasons.push("unknown_fields");
  if (!source.transcript_path) coverageReasons.push("transcript_absent");
  const text = (key: string): string | null => typeof source[key] === "string" ? source[key] as string : null;
  return { status: "accepted", value: {
    sessionId: source.session_id, event, provenance: "producer_reported", runtimeVerified: false, coverageReasons,
    transcriptPath: text("transcript_path"), cwd: text("cwd"), agentId: text("agent_id"), agentType: text("agent_type"), agentTranscriptPath: text("agent_transcript_path"), stopHookActive: typeof source.stop_hook_active === "boolean" ? source.stop_hook_active : null, model: text("model"), permissionMode: text("permission_mode"), source: text("source"), endReason: text("reason"), prompt: text("prompt"), toolId: text("tool_use_id"), toolName: text("tool_name"),
    toolInput: source.tool_input ?? null, toolResponse: source.tool_response ?? null, error: text("error"), errorType: text("error_type"), interrupted: typeof source.is_interrupt === "boolean" ? source.is_interrupt : null, durationMs: typeof source.duration_ms === "number" ? source.duration_ms : null, lastAssistantMessage: text("last_assistant_message"),
  } };
}
