import path from "node:path";
import type { Readable } from "node:stream";
import { parseBoundedHookJson, type HookJson, type HookResult } from "./shared";
import { sanitizeClaudeLabel, sanitizeClaudeRetention, type NormalizedClaudeBatch, type NormalizedClaudeEntity } from "./claude";
import { CALLBACK_LIMITS, readClaudeHookStdin } from "./callback";
import { readClaudeCapabilityDescriptor } from "./capability";
import { postClaudeHook, validateMainAdmission } from "./client";
import { HOOK_PROTOCOL, hookDigest, isHex } from "./protocol";
import type { ClaudeHookInput } from "./shared";

// Permission hooks can reject empty stdout even with failClosed=false. Observe completion instead.
export const CURSOR_HOOK_EVENTS = ["sessionStart", "sessionEnd", "beforeSubmitPrompt", "postToolUse", "postToolUseFailure", "afterAgentResponse", "stop"] as const;
export type CursorHookEvent = typeof CURSOR_HOOK_EVENTS[number];
export interface CursorHookInput {
  event: CursorHookEvent;
  conversationId: string;
  generationId: string | null;
  cwd: string;
  toolId: string | null;
  toolName: string | null;
  toolInput: HookJson | null;
  toolOutput: HookJson | null;
  prompt: string | null;
  text: string | null;
  model: string | null;
  error: string | null;
  durationMs: number | null;
  interrupted: boolean;
  coverageReasons: string[];
}
const record = (v: HookJson | undefined): v is { [key: string]: HookJson } => !!v && typeof v === "object" && !Array.isArray(v);
const identifier = (v: HookJson | undefined): v is string => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(v);
const aliases: Record<string, CursorHookEvent> = { SessionStart: "sessionStart", SessionEnd: "sessionEnd", UserPromptSubmit: "beforeSubmitPrompt", PostToolUse: "postToolUse", PostToolUseFailure: "postToolUseFailure", Stop: "stop" };
const fields = new Set(["conversation_id", "session_id", "generation_id", "hook_event_name", "cursor_version", "workspace_roots", "cwd", "model", "model_id", "model_params", "user_email", "prompt", "attachments", "text", "tool_name", "tool_input", "tool_output", "tool_response", "tool_use_id", "error_message", "error", "failure_type", "duration", "duration_ms", "is_interrupt", "status", "loop_count", "reason", "final_status", "is_background_agent", "composer_mode", "last_assistant_message"]);
export function parseCursorHookInput(raw: unknown): HookResult<CursorHookInput> {
  const parsed = parseBoundedHookJson(raw);
  if (parsed.status !== "accepted") return parsed;
  const v = parsed.value;
  if (!record(v)) return { status: "unavailable", reason: "invalid_fields" };
  const event = typeof v.hook_event_name === "string" ? aliases[v.hook_event_name] ?? v.hook_event_name : null;
  if (!CURSOR_HOOK_EVENTS.includes(event as CursorHookEvent)) return { status: "unavailable", reason: "unsupported_event" };
  const id = v.conversation_id ?? v.session_id;
  if (!identifier(id) || v.session_id !== undefined && v.conversation_id !== undefined && v.session_id !== v.conversation_id) return { status: "unavailable", reason: "invalid_fields" };
  const roots = v.workspace_roots;
  if (roots !== undefined && (!Array.isArray(roots) || roots.length > 16 || roots.some(p => typeof p !== "string" || !path.isAbsolute(p) || path.normalize(p) !== p || p.includes("\0") || Buffer.byteLength(p) > 4096))) return { status: "unavailable", reason: "invalid_fields" };
  const cwd = v.cwd ?? (Array.isArray(roots) && roots.length === 1 ? roots[0] : null);
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || path.normalize(cwd) !== cwd || cwd.includes("\0") || Buffer.byteLength(cwd) > 4096) return { status: "unavailable", reason: "invalid_fields" };
  if (v.generation_id !== undefined && !identifier(v.generation_id)) return { status: "unavailable", reason: "invalid_fields" };
  for (const field of ["prompt", "text", "model", "model_id", "tool_name", "error_message", "error", "last_assistant_message"]) {
    const s = v[field];
    if (s !== undefined && (typeof s !== "string" || s.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s))) return { status: "unavailable", reason: "invalid_fields" };
    if (typeof s === "string" && s.length > (field.startsWith("error") ? 1000 : 4096)) return { status: "unavailable", reason: "field_limit" };
  }
  const duration = v.duration ?? v.duration_ms;
  if (duration !== undefined && (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0 || duration > Number.MAX_SAFE_INTEGER)
    || v.is_interrupt !== undefined && typeof v.is_interrupt !== "boolean") return { status: "unavailable", reason: "invalid_fields" };
  if (["postToolUse", "postToolUseFailure"].includes(event!) && (!identifier(v.tool_use_id) || typeof v.tool_name !== "string" || !v.tool_name)) return { status: "unavailable", reason: "invalid_fields" };
  if (event === "beforeSubmitPrompt" && typeof v.prompt !== "string" || event === "afterAgentResponse" && typeof v.text !== "string"
    || event === "postToolUseFailure" && typeof (v.error_message ?? v.error) !== "string"
    || event === "stop" && !["completed", "aborted", "error"].includes(v.status as string)
    || event === "sessionEnd" && !["completed", "aborted", "error", "window_close", "user_close"].includes(v.reason as string)) return { status: "unavailable", reason: "invalid_fields" };
  const text = (k: string): string | null => typeof v[k] === "string" ? v[k] as string : null;
  return { status: "accepted", value: { event: event as CursorHookEvent, conversationId: id, generationId: text("generation_id"), cwd, toolId: text("tool_use_id"), toolName: text("tool_name"), toolInput: v.tool_input ?? null, toolOutput: v.tool_output ?? v.tool_response ?? null, prompt: text("prompt"), text: text("text") ?? text("last_assistant_message"), model: text("model_id") ?? text("model"), error: text("error_message") ?? text("error"), durationMs: typeof duration === "number" ? duration : null, interrupted: v.is_interrupt === true || v.status === "aborted", coverageReasons: ["producer_unverified", "transcript_absent", ...(Object.keys(v).some(k => !fields.has(k)) ? ["unknown_fields"] : [])] } };
}

/** Native and compatibility spellings use the same producer identities; paths never grant IO authority. */
export function normalizeCursorHook(hook: CursorHookInput, sourceKey: string, mode: "metadata" | "full"): NormalizedClaudeBatch {
  if (!isHex(sourceKey, 64) || !["metadata", "full"].includes(mode)) throw new Error("invalid Cursor normalization authority");
  const reasons = [...hook.coverageReasons];
  const make = (kind: NormalizedClaudeEntity["kind"], identity: string, phase: NormalizedClaudeEntity["phase"], name: string, body: NormalizedClaudeEntity["body"]): NormalizedClaudeEntity => ({
    entityKey: hookDigest(JSON.stringify(["runphantom.claude.entity/v1", sourceKey, kind, identity])), kind, phase, name: sanitizeClaudeLabel(name), model: null, sourceKind: "hook", incarnationKey: null, sourceOffset: null, reportedAt: null, reportedDurationMs: null, runtimeDurationMs: null, runtimeVerified: false, producerVerified: false, usage: null, body: mode === "full" ? body : null, coverageReasons: reasons,
  });
  const entities = [make("session", "root", hook.event === "sessionEnd" ? "complete" : "pending", "Cursor session", null)];
  const identity = (id: string) => hookDigest(JSON.stringify(["runphantom.cursor.entity/v1", hook.generationId, id]));
  if (hook.toolId) {
    const tool = make("tool", identity(hook.toolId), hook.event === "postToolUseFailure" ? hook.interrupted ? "interrupted" : "failure" : "success", hook.toolName ?? "Tool", { input: hook.toolInput, output: hook.toolOutput, error: hook.error });
    tool.reportedDurationMs = hook.durationMs; entities.push(tool);
    if (hook.toolOutput === null && hook.event === "postToolUse") reasons.push("tool_output_absent");
  }
  if (hook.event === "beforeSubmitPrompt" && hook.generationId) entities.push(make("prompt", identity("prompt"), "complete", "User prompt observation", { input: hook.prompt, output: null, error: null }));
  if (hook.event === "afterAgentResponse" && hook.generationId) {
    const assistant = make("assistant", identity("assistant"), "complete", "Assistant", { input: null, output: [{ type: "text", text: hook.text }], error: null });
    assistant.model = hook.model === null ? null : sanitizeClaudeLabel(hook.model); entities.push(assistant);
    reasons.push("assistant_fragments_unmerged");
  }
  if (hook.event === "beforeSubmitPrompt" && !hook.generationId) reasons.push("unresolved_prompt_identity");
  if (hook.event === "afterAgentResponse" && !hook.generationId) reasons.push("unresolved_assistant_identity");
  const assertions = mode === "full" ? { prompt: !hook.generationId ? hook.prompt : null, assistant: !hook.generationId ? hook.text : null, error: hook.event === "stop" ? hook.error : null } : null;
  const safe = sanitizeClaudeRetention({ bodies: entities.map(x => x.body), assertions } as HookJson);
  if (safe.redacted) reasons.push("body_redacted"); if (safe.partial) reasons.push("body_partial");
  if (!record(safe.value) || !Array.isArray(safe.value.bodies)) throw new Error("unavailable");
  const bodies = safe.value.bodies;
  entities.forEach((entity, i) => { const body = bodies[i]; entity.body = record(body) ? { input: body.input ?? null, output: body.output ?? null, error: typeof body.error === "string" ? body.error : null } : null; });
  const event: NormalizedClaudeBatch["event"] = hook.event === "sessionEnd" ? "SessionEnd" : hook.event === "sessionStart" ? "SessionStart" : hook.event === "beforeSubmitPrompt" ? "UserPromptSubmit" : hook.event === "postToolUse" ? "PostToolUse" : hook.event === "postToolUseFailure" ? "PostToolUseFailure" : "Stop";
  return { event, sourceKey, sessionClosureClaim: hook.event === "sessionEnd", runtimeVerified: false, producerVerified: false, coverage: "partial", coverageReasons: [...new Set(reasons)], entities, unlinkedAssertions: safe.value.assertions as NormalizedClaudeBatch["unlinkedAssertions"], transcriptCursor: null, incarnationKey: null, prefixBytes: null, prefixSha256: null, observedFileBytes: null };
}

/** Reuse F11's descriptor/owner fencing. Native hook JSON supplies no filesystem read path. */
export async function captureCursorHook(hook: CursorHookInput, file: string, id: string, signal: AbortSignal): Promise<void> {
  const capability = await readClaudeCapabilityDescriptor(file, id, undefined, signal);
  if (capability.state !== "active") return;
  // Management selects the registered private source root; never derive it from hook-supplied paths.
  const project = path.join(path.dirname(file), "sources", hookDigest(hook.cwd));
  const reply = await postClaudeHook(capability, "admission", { version: HOOK_PROTOCOL, sourceSessionIdentity: hookDigest(JSON.stringify(["runphantom.cursor.session/v1", hook.conversationId])), workspaceClaim: hookDigest(JSON.stringify(["runphantom.claude.workspace-claim/v1", hook.cwd])), projectClaim: hookDigest(JSON.stringify(["runphantom.claude.project-claim/v1", project])) }, signal);
  const admission = validateMainAdmission(reply, capability, { cwd: hook.cwd } as ClaudeHookInput, project);
  if (admission.binding.settingsPath !== path.join(admission.binding.scope === "global" ? admission.binding.homeDirectory : hook.cwd, ".cursor/hooks.json")) return;
  const batch = normalizeCursorHook(hook, admission.sourceKey, admission.captureMode);
  await postClaudeHook(capability, "publication", { version: HOOK_PROTOCOL, ownerGeneration: admission.ownerGeneration, installationGeneration: admission.installationGeneration, sourceKey: admission.sourceKey, batch }, signal);
}
export async function runCursorHookCallback(args: string[], input: Readable = process.stdin): Promise<0> {
  if (args.length !== 4 || args[0] !== "--installation-id" || !isHex(args[1], 32) || args[2] !== "--capability-file" || !path.isAbsolute(args[3]) || path.normalize(args[3]) !== args[3] || args[3].includes("\0") || Buffer.byteLength(args[3]) > 4096) return 0;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), CALLBACK_LIMITS.lifetimeMs);
  try { const raw = await readClaudeHookStdin(input, controller.signal); if (raw.status !== "accepted" || controller.signal.aborted) return 0; const parsed = parseCursorHookInput(raw.text); if (parsed.status === "accepted") await captureCursorHook(parsed.value, args[3], args[1], controller.signal); }
  catch { /* Observation failure never changes the host result or writes a policy response. */ }
  finally { clearTimeout(timer); input.pause(); }
  return 0;
}
