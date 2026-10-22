import type { SpanAdapter } from "./types";
import type { CodexHookCaptureView } from "../hook-capture-types";
export type { CodexHookCaptureView } from "../hook-capture-types";
import { parseBoundedHookJson } from "../../coding-hooks/shared";

const contract = "runphantom.codex-hook.observation/v1";
const allowed = new Set(["captureContract", "source", "entityKind", "coverage", "producerVerified", "runtimeVerified", "reportedPhase", "runphantom.span.kind", "gen_ai.provider.name", "runphantom.conversation.id", "turnId", "gen_ai.request.model", "runphantom.input", "runphantom.output", "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "cachedInputTokens", "reasoningOutputTokens", "usageAccounting", "otel.scope.name", "otel.scope.version", "otel.status.code"]);
/** A read label is producer-reported evidence, never execution or replay authority. */
export const codexHookAdapter: SpanAdapter = { name: "codex-hook-observation", apply(input) {
  const a = input.attrs;
  if (typeof a.captureContract !== "string" || !a.captureContract.startsWith("runphantom.codex-hook.observation/")) return null;
  const unavailable = { normalized: { kind: "other" as const } };
  if (Object.keys(a).some(k => !allowed.has(k)) || parseBoundedHookJson(JSON.stringify(a)).status !== "accepted" || a.captureContract !== contract || a.source !== "codex_hook" || a.coverage !== "partial" || a.producerVerified !== false || a.runtimeVerified !== false || a.reportedPhase !== "unknown") return unavailable;
  const kind = a.entityKind;
  if (kind !== "session" && kind !== "prompt" && kind !== "assistant" && kind !== "tool") return unavailable;
  const types = { session: "AGENT_ROOT", prompt: "INTERNAL", assistant: "LLM_GENERATION", tool: "TOOL_CALL" };
  if (input.spanType !== types[kind]) return unavailable;
  const body = (value: unknown): { valid: boolean; value: unknown } => {
    if (value === undefined) return { valid: true, value: null };
    const decoded = parseBoundedHookJson(value);
    return decoded.status === "accepted" ? { valid: true, value: decoded.value } : { valid: false, value: null };
  };
  const incoming = input.inputPayload ?? a["runphantom.input"], outgoing = input.outputPayload ?? a["runphantom.output"];
  const p = body(incoming), q = body(outgoing);
  if (!p.valid || !q.valid || kind === "prompt" && typeof p.value !== "string" || kind === "assistant" && typeof q.value !== "string") return unavailable;
  const capture: CodexHookCaptureView = { contract, entityKind: kind, sourceKind: "transcript", coverage: "partial", producerVerified: false, runtimeVerified: false, reportedPhase: "unknown", reportedDurationMs: null, usage: null, userText: kind === "prompt" ? p.value as string : null, assistantText: kind === "assistant" ? q.value as string : null };
  const payloads = { ...(typeof incoming === "string" ? { inputPayload: incoming } : {}), ...(typeof outgoing === "string" ? { outputPayload: outgoing } : {}) };
  if (kind === "tool") return { ...payloads, normalized: { kind: "tool", name: input.spanName, args: p.value, result: q.value, resultIsError: false, capture } };
  if (kind === "assistant") return { ...payloads, normalized: { kind: "llm", messages: [], userMessage: "", systemPrompt: "", capture } };
  return { ...payloads, normalized: { kind: "other", capture } };
} };
