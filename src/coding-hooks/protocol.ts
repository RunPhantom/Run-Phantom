import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { NORMALIZATION_LIMITS, sanitizeClaudeLabel, sanitizeClaudeRetention, type NormalizedClaudeBatch, type NormalizedClaudeEntity } from "./claude";
import { CLAUDE_HOOK_EVENTS, parseBoundedHookJson, type HookJson } from "./shared";

export const HOOK_PROTOCOL = "runphantom.claude-hook/v1";
const COVERAGE_REASONS = new Set(["producer_unverified", "unknown_fields", "transcript_absent", "unresolved_prompt_identity", "unresolved_assistant_identity", "unresolved_subagent_linkage", "tool_output_absent", "terminal_regression", "contradictory_terminal_claims", "assistant_fragments_unmerged", "inconsistent_request_identity", "inconsistent_model_identity", "invalid_timestamp", "invalid_usage", "invalid_record", "unsupported_version", "unsupported_record", "unsupported_content", "transcript_version_absent", "incomplete_tail", "parse_deadline", "record_limit", "line_limit", "entity_limit", "body_partial", "body_redacted", "body_limit", "model_limit", "invalid_json", "byte_limit", "depth_limit", "node_limit", "duplicate_keys", "invalid_number", "unsafe_key", "invalid_fields", "field_limit", "unsupported_event", "source_changed", "source_unavailable", "path_not_authorized", "not_regular_file", "file_limit", "identity_unavailable", "invalid_utf8", "aborted", "deadline"]);
export class HookRefusal extends Error { constructor(readonly reason: "malformed" | "unauthorized" | "inactive" | "stale" | "suppressed" | "source_changed" | "projection_conflict" | "quota" | "corrupt" | "unavailable" | "busy" | "deadline" | "closed" | "unknown_scope", readonly status = 409) { super(reason); } }
export function refuse(reason: HookRefusal["reason"], status?: number): never { throw new HookRefusal(reason, status); }
export const hookDigest = (value: string): string => createHash("sha256").update(value).digest("hex");
export const isHex = (value: unknown, units: number): value is string => typeof value === "string" && value.length === units && /^[a-f0-9]+$/.test(value);
const object = (value: HookJson | undefined): value is { [key: string]: HookJson } => Boolean(value && typeof value === "object" && !Array.isArray(value));
const closed = (value: { [key: string]: HookJson }, keys: string[]) => { if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) refuse("malformed", 400); };
const finite = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
const textOrNull = (value: unknown, max: number): boolean => value === null || typeof value === "string" && value.length <= max;
const parse = (raw: unknown) => { const result = parseBoundedHookJson(raw); if (result.status !== "accepted" || !object(result.value)) refuse("malformed", 400); return result.value; };
export interface HookSourceClaims { workspaceClaim: string; projectClaim: string; }
export function parseHookAdmission(raw: unknown): HookSourceClaims & { sourceSessionIdentity: string } {
  const value = parse(raw); closed(value, ["version", "sourceSessionIdentity", "workspaceClaim", "projectClaim"]);
  if (value.version !== HOOK_PROTOCOL || !isHex(value.sourceSessionIdentity, 64) || !isHex(value.workspaceClaim, 64) || !isHex(value.projectClaim, 64)) refuse("malformed", 400);
  return { sourceSessionIdentity: value.sourceSessionIdentity, workspaceClaim: value.workspaceClaim, projectClaim: value.projectClaim };
}
export function parseHookPublication(raw: unknown): { ownerGeneration: string; installationGeneration: string; sourceKey: string; batch: NormalizedClaudeBatch } {
  const value = parse(raw); closed(value, ["version", "ownerGeneration", "installationGeneration", "sourceKey", "batch"]);
  if (value.version !== HOOK_PROTOCOL || !isHex(value.ownerGeneration, 32) || !isHex(value.installationGeneration, 32) || !isHex(value.sourceKey, 64)) refuse("malformed", 400);
  return { ownerGeneration: value.ownerGeneration, installationGeneration: value.installationGeneration, sourceKey: value.sourceKey, batch: validateClaudeBatch(JSON.stringify(value.batch), value.sourceKey, "full") };
}

const reasons = (value: HookJson): value is string[] => Array.isArray(value) && value.length <= 64 && value.every(reason => typeof reason === "string" && COVERAGE_REASONS.has(reason));
function validateClaudeEntity(candidate: HookJson, sourceKey: string, context: { incarnationKey: HookJson; transcriptCursor: HookJson }): NormalizedClaudeEntity {
  if (!object(candidate) || Buffer.byteLength(JSON.stringify(candidate)) > NORMALIZATION_LIMITS.entityBytes) refuse("malformed", 400);
  closed(candidate, ["entityKey", "kind", "phase", "name", "model", "sourceKind", "incarnationKey", "sourceOffset", "reportedAt", "reportedDurationMs", "runtimeDurationMs", "runtimeVerified", "producerVerified", "usage", "body", "coverageReasons"]);
  if (!isHex(candidate.entityKey, 64) || !["session", "prompt", "tool", "assistant", "subagent"].includes(candidate.kind as string)
    || !["pending", "success", "failure", "interrupted", "complete", "unknown", "conflict"].includes(candidate.phase as string)
    || typeof candidate.name !== "string" || candidate.name.length > 256 || !textOrNull(candidate.model, 256) || candidate.runtimeDurationMs !== null || candidate.runtimeVerified !== false || candidate.producerVerified !== false || !reasons(candidate.coverageReasons)) refuse("malformed", 400);
  if (candidate.kind === "session") {
    if (candidate.entityKey !== hookDigest(JSON.stringify(["runphantom.claude.entity/v1", sourceKey, "session", "root"])) || candidate.usage !== null || candidate.body !== null
      || !["pending", "complete"].includes(candidate.phase as string)) refuse("malformed", 400);
  }
  if (candidate.sourceKind === "hook" ? candidate.incarnationKey !== null || candidate.sourceOffset !== null
    : candidate.sourceKind !== "transcript" || context.incarnationKey === null || candidate.incarnationKey !== context.incarnationKey || !finite(candidate.sourceOffset, 8388608) || candidate.sourceOffset > (context.transcriptCursor as number)) refuse("malformed", 400);
  if (candidate.reportedAt !== null && (typeof candidate.reportedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(candidate.reportedAt) || !Number.isFinite(Date.parse(candidate.reportedAt)) || new Date(candidate.reportedAt).toISOString() !== candidate.reportedAt)) refuse("malformed", 400);
  if (candidate.reportedDurationMs !== null && (typeof candidate.reportedDurationMs !== "number" || !Number.isFinite(candidate.reportedDurationMs) || candidate.reportedDurationMs < 0 || candidate.reportedDurationMs > Number.MAX_SAFE_INTEGER)) refuse("malformed", 400);
  if (candidate.usage !== null) {
    if (candidate.kind !== "assistant" || !object(candidate.usage)) refuse("malformed", 400);
    closed(candidate.usage, ["freshInputTokens", "outputTokens", "cacheCreatedInputTokens", "cacheReadInputTokens"]);
    if (Object.values(candidate.usage).some(value => value !== null && !finite(value))) refuse("malformed", 400);
  }
  if (candidate.body !== null) { if (!object(candidate.body)) refuse("malformed", 400); closed(candidate.body, ["input", "output", "error"]); if (!textOrNull(candidate.body.error, 1000)) refuse("malformed", 400); }
  return candidate as unknown as NormalizedClaudeEntity;
}
/** Retained DTO validation shares the publication boundary without stripping earlier consented bodies. */
export function validateClaudeRetainedEntity(raw: string, sourceKey: string, incarnationKey: string | null, transcriptCursor: number): NormalizedClaudeEntity {
  const parsed = parseBoundedHookJson(raw, NORMALIZATION_LIMITS.entityBytes);
  if (parsed.status !== "accepted") refuse("corrupt", 503);
  try {
    const entity = validateClaudeEntity(parsed.value, sourceKey, { incarnationKey, transcriptCursor });
    const safe = sanitizeClaudeRetention({ bodies: [entity.body], assertions: null } as HookJson);
    if (!object(safe.value) || !Array.isArray(safe.value.bodies) || !isDeepStrictEqual(JSON.parse(JSON.stringify(safe.value.bodies[0])), entity.body)
      || sanitizeClaudeLabel(entity.name) !== entity.name || entity.model !== null && sanitizeClaudeLabel(entity.model) !== entity.model) refuse("corrupt", 503);
    return entity;
  }
  catch { refuse("corrupt", 503); }
}
/** Only current authenticated installation policy chooses retained bodies. All observations stay unverified. */
export function validateClaudeBatch(value: unknown, sourceKey: string, mode: "metadata" | "full"): NormalizedClaudeBatch {
  const result = parseBoundedHookJson(value);
  if (result.status !== "accepted" || !object(result.value)) refuse("malformed", 400);
  const batch = result.value;
  closed(batch, ["event", "sourceKey", "sessionClosureClaim", "runtimeVerified", "producerVerified", "coverage", "coverageReasons", "entities", "unlinkedAssertions", "transcriptCursor", "incarnationKey", "prefixBytes", "prefixSha256", "observedFileBytes"]);
  if (!CLAUDE_HOOK_EVENTS.includes(batch.event as typeof CLAUDE_HOOK_EVENTS[number]) || batch.sourceKey !== sourceKey || batch.runtimeVerified !== false || batch.producerVerified !== false || batch.coverage !== "partial"
    || batch.sessionClosureClaim !== (batch.event === "SessionEnd") || !Array.isArray(batch.entities) || !batch.entities.length || batch.entities.length > NORMALIZATION_LIMITS.entities) refuse("malformed", 400);
  if (!reasons(batch.coverageReasons)) refuse("malformed", 400);
  const snapshot = batch.incarnationKey !== null;
  if (snapshot ? !isHex(batch.incarnationKey, 64) || !finite(batch.transcriptCursor, 8388608) || !finite(batch.prefixBytes, 65536) || !finite(batch.observedFileBytes, 8388608)
    || batch.transcriptCursor > batch.observedFileBytes || batch.prefixBytes > batch.observedFileBytes || (batch.prefixBytes === 0 ? batch.prefixSha256 !== null : !isHex(batch.prefixSha256, 64))
    : [batch.transcriptCursor, batch.prefixBytes, batch.prefixSha256, batch.observedFileBytes].some(value => value !== null)) refuse("malformed", 400);
  let roots = 0;
  const seen = new Set<string>();
  for (const candidate of batch.entities) {
    const validated = validateClaudeEntity(candidate, sourceKey, { incarnationKey: batch.incarnationKey, transcriptCursor: batch.transcriptCursor });
    if (seen.has(validated.entityKey)) refuse("malformed", 400); seen.add(validated.entityKey);
    if (validated.kind === "session") { roots++; if (validated.phase !== (batch.event === "SessionEnd" ? "complete" : "pending")) refuse("malformed", 400); }
    validated.name = sanitizeClaudeLabel(validated.name); if (typeof validated.model === "string") validated.model = sanitizeClaudeLabel(validated.model);
    if (mode === "metadata") validated.body = null;
  }
  if (roots !== 1 || batch.unlinkedAssertions !== null && !object(batch.unlinkedAssertions)) refuse("malformed", 400);
  if (object(batch.unlinkedAssertions)) { closed(batch.unlinkedAssertions, ["prompt", "assistant", "error"]); if (Object.values(batch.unlinkedAssertions).some(value => !textOrNull(value, 4096))) refuse("malformed", 400); }
  const entities = batch.entities as unknown as NormalizedClaudeEntity[];
  if (mode === "metadata") batch.unlinkedAssertions = null;
  else {
    const safe = sanitizeClaudeRetention({ bodies: entities.map(entity => entity.body), assertions: batch.unlinkedAssertions } as HookJson);
    const retained = safe.value;
    if (!object(retained) || !Array.isArray(retained.bodies)) refuse("malformed", 400);
    const bodies = retained.bodies;
    entities.forEach((entity, index) => { const body = bodies[index]; entity.body = object(body) ? { input: body.input ?? null, output: body.output ?? null, error: typeof body.error === "string" ? body.error : null } : null; });
    batch.unlinkedAssertions = retained.assertions ?? null;
    if (safe.partial) batch.coverageReasons.push("body_partial"); if (safe.redacted) batch.coverageReasons.push("body_redacted");
  }
  batch.coverageReasons = [...new Set(batch.coverageReasons)];
  return batch as unknown as NormalizedClaudeBatch;
}
