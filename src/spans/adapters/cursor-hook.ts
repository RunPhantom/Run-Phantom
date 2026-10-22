import type { AdapterInput, AdapterMatch, SpanAdapter } from "./types";
import type { CursorHookCaptureView } from "../hook-capture-types";
export type { CursorHookCaptureView } from "../hook-capture-types";
import { parseBoundedHookJson } from "../../coding-hooks/shared";
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const kinds = { session: "AGENT_ROOT", prompt: "INTERNAL", tool: "TOOL_CALL", assistant: "LLM_GENERATION" } as const;
const keys = "captureContract,captureModel,coverage,coverageReasons,currentCapturePolicy,entityKind,producerVerified,reportedDurationMs,reportedPhase,retainedBody,retainedEntitySha256,runtimeVerified,source,sourceKind,usage";
const coverageReasons = new Set(["producer_unverified", "unknown_fields", "transcript_absent", "unresolved_prompt_identity", "unresolved_assistant_identity", "unresolved_subagent_linkage", "tool_output_absent", "terminal_regression", "contradictory_terminal_claims", "assistant_fragments_unmerged", "inconsistent_request_identity", "inconsistent_model_identity", "invalid_timestamp", "invalid_usage", "invalid_record", "unsupported_version", "unsupported_record", "unsupported_content", "transcript_version_absent", "incomplete_tail", "parse_deadline", "record_limit", "line_limit", "entity_limit", "body_partial", "body_redacted", "body_limit", "model_limit", "invalid_json", "byte_limit", "depth_limit", "node_limit", "duplicate_keys", "invalid_number", "unsafe_key", "invalid_fields", "field_limit", "unsupported_event", "source_changed", "source_unavailable", "path_not_authorized", "not_regular_file", "file_limit", "identity_unavailable", "invalid_utf8", "aborted", "deadline"]);
const validCoverageReasons = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 64 && value.every(reason => typeof reason === "string" && coverageReasons.has(reason));
const phases = ["pending", "success", "failure", "interrupted", "complete", "unknown", "conflict"];
function payload(raw: string | undefined): { ok: true; value: unknown } | { ok: false } { if (raw === undefined) return { ok: true, value: null }; const p = parseBoundedHookJson(raw, 16384); return p.status === "accepted" ? { ok: true, value: p.value } : { ok: false }; }
/** Closed native-hook read contract; matching malformed records cannot fall through to an SDK guess. */
export const cursorHookAdapter: SpanAdapter = { name: "cursor-hook-observation", apply(input: AdapterInput): AdapterMatch | null {
  const raw: unknown = input.attrs;
  if (!object(raw) || typeof raw.captureContract !== "string" || !raw.captureContract.startsWith("runphantom.cursor-hook.observation/")) return null;
  const unavailable = (): AdapterMatch => ({ normalized: { kind: "other" } });
  const parsed = parseBoundedHookJson(JSON.stringify(raw), 16384);
  if (parsed.status !== "accepted" || !object(parsed.value)) return unavailable();
  const a = parsed.value, kind = a.entityKind;
  if (Object.keys(a).sort().join() !== keys || a.captureContract !== "runphantom.cursor-hook.observation/v1" || a.source !== "cursor_hook" || a.sourceKind !== "hook" || typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(kinds, kind)
    || kinds[kind as keyof typeof kinds] !== input.spanType || a.producerVerified !== false || a.runtimeVerified !== false || a.coverage !== "partial" || !validCoverageReasons(a.coverageReasons)
    || typeof a.reportedPhase !== "string" || !phases.includes(a.reportedPhase) || a.usage !== null
    || !(a.reportedDurationMs === null || typeof a.reportedDurationMs === "number" && Number.isFinite(a.reportedDurationMs) && a.reportedDurationMs >= 0 && a.reportedDurationMs <= Number.MAX_SAFE_INTEGER)
    || !(a.captureModel === null || typeof a.captureModel === "string" && a.captureModel.length <= 256) || kind !== "assistant" && a.captureModel !== null
    || !["metadata", "full"].includes(a.currentCapturePolicy as string) || typeof a.retainedBody !== "boolean" || typeof a.retainedEntitySha256 !== "string" || !/^[a-f0-9]{64}$/.test(a.retainedEntitySha256)) return unavailable();
  const incoming = payload(input.inputPayload), outgoing = payload(input.outputPayload);
  if (!incoming.ok || !outgoing.ok || !a.retainedBody && (incoming.value !== null || outgoing.value !== null)) return unavailable();
  let userText: string | null = null, assistantText: string | null = null;
  if (kind === "prompt") { if (!(incoming.value === null || typeof incoming.value === "string") || outgoing.value !== null) return unavailable(); userText = incoming.value; }
  if (kind === "assistant") {
    if (incoming.value !== null || outgoing.value !== null && (!Array.isArray(outgoing.value) || outgoing.value.some(x => !object(x) || Object.keys(x).sort().join() !== "text,type" || x.type !== "text" || typeof x.text !== "string"))) return unavailable();
    assistantText = outgoing.value === null ? null : (outgoing.value as { text: string }[]).map(x => x.text).join("");
  }
  if (kind === "session" && (incoming.value !== null || outgoing.value !== null)) return unavailable();
  const capture: CursorHookCaptureView = { contract: "runphantom.cursor-hook.observation/v1", entityKind: kind as CursorHookCaptureView["entityKind"], sourceKind: "hook", coverage: "partial", producerVerified: false, runtimeVerified: false, reportedPhase: a.reportedPhase as CursorHookCaptureView["reportedPhase"], reportedDurationMs: a.reportedDurationMs as number | null, usage: null, userText, assistantText };
  if (kind === "tool") return { normalized: { kind: "tool", name: input.spanName, args: incoming.value, result: outgoing.value, resultIsError: ["failure", "interrupted", "conflict"].includes(capture.reportedPhase), capture } };
  if (kind === "assistant") return { normalized: { kind: "llm", messages: [], userMessage: "", systemPrompt: "", ...(typeof a.captureModel === "string" ? { model: a.captureModel } : {}), capture } };
  return { normalized: { kind: "other", capture } };
} };
