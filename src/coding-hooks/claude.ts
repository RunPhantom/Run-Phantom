import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { parseBoundedHookJson, parseClaudeHookInput, type ClaudeHookInput, type HookJson } from "./shared";
import { sanitizeWithReport, redactText } from "../verification/serialization";
import { defaultIsSensitiveKey, redactUrl, REDACTED_VALUE } from "../verification/redaction";

export const TRANSCRIPT_LIMITS = Object.freeze({ fileBytes: 8388608, chunkBytes: 65536, prefixBytes: 65536, acquisitionMs: 650, pathSegments: 8 });
export type TranscriptFailure = "invalid_authority" | "aborted" | "deadline" | "path_not_authorized" | "not_regular_file" | "source_unavailable" | "source_changed" | "file_limit" | "identity_unavailable" | "invalid_utf8";
/** Authority comes from the trusted installation, never the hook JSON or a caller-selected URL/path. */
export interface TranscriptAuthority {
  projectsRoot: string;
  homeDirectory: string;
  cursor: number;
  prefixBytes: number;
  expectedPrefixSha256: string | null;
  expectedIncarnationKey: string | null;
}
/** Raw text is ephemeral private parser input. It must not be transported, logged or persisted. */
export interface TranscriptSnapshot {
  text: string;
  fileBytes: number;
  startOffset: number;
  endOffset: number;
  incarnationKey: string;
  prefixBytes: number;
  prefixSha256: string | null;
}
export type TranscriptAcquisition = { status: "accepted"; value: TranscriptSnapshot; reason?: never } | { status: "unavailable"; reason: TranscriptFailure };
class AcquisitionRefusal extends Error { constructor(readonly reason: TranscriptFailure) { super(reason); } }
function fail(reason: TranscriptFailure): never { throw new AcquisitionRefusal(reason); }
const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const isDigest = (value: unknown): value is string | null => value === null || (typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
function sameFile(left: BigIntStats, right: BigIntStats): boolean { return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs; }
function within(root: string, file: string): string[] {
  const relative = path.relative(root, file);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) fail("path_not_authorized");
  const parts = relative.split(path.sep);
  if (parts.length > TRANSCRIPT_LIMITS.pathSegments) fail("path_not_authorized");
  return parts;
}

/** Race only private IO promises; a late open is closed, never adopted after abort. */
async function guarded<T>(promise: Promise<T>, signal: AbortSignal, onLate?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      reject(new AcquisitionRefusal(signal.reason === "deadline" ? "deadline" : "aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void promise.then(value => {
      if (settled) { onLate?.(value); return; }
      settled = true; signal.removeEventListener("abort", abort); resolve(value);
    }, error => {
      if (settled) return;
      settled = true; signal.removeEventListener("abort", abort); reject(error instanceof Error ? error : new AcquisitionRefusal("source_unavailable"));
    });
  });
}

export async function acquireClaudeTranscript(hook: ClaudeHookInput, authority: TranscriptAuthority, outerSignal?: AbortSignal): Promise<TranscriptAcquisition> {
  if (outerSignal?.aborted) return { status: "unavailable", reason: "aborted" };
  if (typeof authority.projectsRoot !== "string" || typeof authority.homeDirectory !== "string"
    || !path.isAbsolute(authority.projectsRoot) || !path.isAbsolute(authority.homeDirectory)
    || Buffer.byteLength(authority.projectsRoot, "utf8") > 4096 || Buffer.byteLength(authority.homeDirectory, "utf8") > 4096
    || !Number.isSafeInteger(authority.cursor) || authority.cursor < 0 || authority.cursor > TRANSCRIPT_LIMITS.fileBytes
    || !Number.isSafeInteger(authority.prefixBytes) || authority.prefixBytes < 0 || authority.prefixBytes > TRANSCRIPT_LIMITS.prefixBytes
    || !isDigest(authority.expectedPrefixSha256) || !isDigest(authority.expectedIncarnationKey)
    || (authority.prefixBytes > 0) !== (authority.expectedPrefixSha256 !== null)
    || (authority.prefixBytes > 0 && authority.expectedIncarnationKey === null)
    || (authority.cursor > 0 && (authority.prefixBytes === 0 || authority.expectedIncarnationKey === null))) return { status: "unavailable", reason: "invalid_authority" };
  const controller = new AbortController(), abort = () => controller.abort("aborted");
  outerSignal?.addEventListener("abort", abort, { once: true });
  const clock = setTimeout(() => controller.abort("deadline"), TRANSCRIPT_LIMITS.acquisitionMs);
  let handle: FileHandle | undefined;
  try {
    const signal = controller.signal;
    const reported = hook.event === "SubagentStop" ? hook.agentTranscriptPath : hook.transcriptPath;
    if (!reported) fail("source_unavailable");
    const candidate = reported.startsWith("~/") ? path.join(authority.homeDirectory, reported.slice(2)) : reported;
    if (!path.isAbsolute(candidate)) fail("path_not_authorized");
    const root = await guarded(realpath(authority.projectsRoot), signal);
    const parts = within(root, path.resolve(candidate));
    const main = parts.length === 2 && parts[1] === `${hook.sessionId}.jsonl`;
    const subagent = hook.event === "SubagentStop" && hook.agentId !== null && parts.length === 4
      && parts[1] === hook.sessionId && parts[2] === "subagents" && parts[3] === `agent-${hook.agentId}.jsonl`;
    if (!main && !subagent) fail("path_not_authorized");
    let parent = root;
    for (const part of parts) {
      parent = path.join(parent, part);
      const entry = await guarded(lstat(parent, { bigint: true }), signal);
      if (entry.isSymbolicLink()) fail("path_not_authorized");
    }
    const before = await guarded(lstat(candidate, { bigint: true }), signal);
    if (!before.isFile()) fail("not_regular_file");
    const resolved = await guarded(realpath(candidate), signal);
    within(root, resolved);
    // Windows lacks O_NOFOLLOW; descriptor/path identity checks remain mandatory there.
    handle = await guarded(open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)), signal, late => { void late.close().catch(() => undefined); });
    const initial = await guarded(handle.stat({ bigint: true }), signal);
    if (!initial.isFile()) fail("not_regular_file");
    if (!sameFile(before, initial)) fail("source_changed");
    if (initial.birthtimeNs <= 0n || initial.ino <= 0n) fail("identity_unavailable");
    if (initial.size > BigInt(TRANSCRIPT_LIMITS.fileBytes)) fail("file_limit");
    const fileBytes = Number(initial.size);
    if (fileBytes < authority.cursor || fileBytes < authority.prefixBytes) fail("source_changed");
    const incarnationKey = digest(JSON.stringify(["runphantom.claude.transcript/v1", hook.sessionId, subagent ? hook.agentId : null, initial.dev.toString(), initial.ino.toString(), initial.birthtimeNs.toString()]));
    if (authority.expectedIncarnationKey !== null && authority.expectedIncarnationKey !== incarnationKey) fail("source_changed");
    const read = async (position: number, bytes: number): Promise<Buffer> => {
      const result = Buffer.allocUnsafe(bytes);
      let offset = 0;
      while (offset < bytes) {
        const next = await guarded(handle!.read(result, offset, Math.min(TRANSCRIPT_LIMITS.chunkBytes, bytes - offset), position + offset), signal);
        if (next.bytesRead === 0) fail("source_changed");
        offset += next.bytesRead;
      }
      return result;
    };
    // Freeze the initial nonempty prefix length so a short first snapshot can append safely.
    const prefixBytes = authority.prefixBytes || Math.min(fileBytes, TRANSCRIPT_LIMITS.prefixBytes);
    const prefix = await read(0, prefixBytes), prefixSha256 = prefixBytes ? digest(prefix) : null;
    if (authority.expectedPrefixSha256 !== null && authority.expectedPrefixSha256 !== prefixSha256) fail("source_changed");
    const bytes = await read(authority.cursor, fileBytes - authority.cursor);
    const after = await guarded(handle.stat({ bigint: true }), signal);
    const currentPath = await guarded(realpath(candidate), signal);
    const current = await guarded(lstat(candidate, { bigint: true }), signal);
    within(root, currentPath);
    if (!current.isFile() || current.isSymbolicLink() || !sameFile(initial, after) || !sameFile(initial, current)
      || after.size !== initial.size || after.mtimeNs !== initial.mtimeNs || after.ctimeNs !== initial.ctimeNs) fail("source_changed");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail("invalid_utf8"); }
    return { status: "accepted", value: { text, fileBytes, startOffset: authority.cursor, endOffset: fileBytes, incarnationKey, prefixBytes, prefixSha256 } };
  } catch (error) { return { status: "unavailable", reason: error instanceof AcquisitionRefusal ? error.reason : "source_unavailable" }; }
  finally {
    clearTimeout(clock); outerSignal?.removeEventListener("abort", abort);
    if (handle) await handle.close().catch(() => undefined);
  }
}

export const NORMALIZATION_LIMITS = Object.freeze({ lineBytes: 262144, records: 5000, entities: 128, entityBytes: 16384, transportBytes: 262144, bodyNodes: 500, parseMs: 250 });
/** This is resolved installation authority, never a field admitted from hook stdin. */
export interface NormalizationAuthority { sourceKey: string; captureMode: "metadata" | "full"; }
type EntityKind = "session" | "prompt" | "tool" | "assistant" | "subagent";
type EntityPhase = "pending" | "success" | "failure" | "interrupted" | "complete" | "unknown" | "conflict";
interface ProducerUsage { freshInputTokens: number | null; outputTokens: number | null; cacheCreatedInputTokens: number | null; cacheReadInputTokens: number | null; }
interface ObservationBody { input: HookJson | null; output: HookJson | null; error: string | null; }
export interface NormalizedClaudeEntity {
  entityKey: string;
  kind: EntityKind;
  phase: EntityPhase;
  name: string;
  model: string | null;
  sourceKind: "hook" | "transcript";
  incarnationKey: string | null;
  sourceOffset: number | null;
  reportedAt: string | null;
  reportedDurationMs: number | null;
  runtimeDurationMs: null;
  runtimeVerified: false;
  producerVerified: false;
  usage: ProducerUsage | null;
  body: ObservationBody | null;
  coverageReasons: string[];
}
export interface NormalizedClaudeBatch {
  event: ClaudeHookInput["event"];
  sourceKey: string;
  sessionClosureClaim: boolean;
  runtimeVerified: false;
  producerVerified: false;
  coverage: "partial";
  coverageReasons: string[];
  entities: NormalizedClaudeEntity[];
  unlinkedAssertions: { prompt: string | null; assistant: string | null; error: string | null } | null;
  transcriptCursor: number | null;
  incarnationKey: string | null;
  prefixBytes: number | null;
  prefixSha256: string | null;
  observedFileBytes: number | null;
}
type NormalizationResult = { status: "accepted"; value: NormalizedClaudeBatch } | { status: "unavailable"; reason: string };
type JsonRecord = { [key: string]: HookJson };
const objectRecord = (value: HookJson | undefined): value is JsonRecord => !!value && typeof value === "object" && !Array.isArray(value);
const sourceId = (value: HookJson | undefined): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const terminal = (phase: EntityPhase): boolean => ["success", "failure", "interrupted", "complete", "conflict"].includes(phase);

/** Keep the fixed key/value floor even when another SDK consumer has ambient allow exemptions. */
function floorText(text: string): string {
  // Refuse ambiguous giant JWT-shaped runs before the shared recognizer can backtrack over them.
  const bounded = text.replace(/[A-Za-z0-9_.-]+/g, token => token.length > 256 && token.includes("eyJ") ? "[UNAVAILABLE]" : token);
  return redactText(bounded)
    .replace(/https?:\/\/[^\s<>"']+/gi, url => redactUrl(url, defaultIsSensitiveKey))
    .replace(/"([A-Za-z][A-Za-z0-9_.-]{0,127})"\s*:\s*"(?:[^"\\]|\\.)*"/g,
      (match, key: string) => defaultIsSensitiveKey(key) ? `"${key}":"${REDACTED_VALUE}"` : match)
    .replace(/(^|[\s?&#,;{"'])([A-Za-z][A-Za-z0-9_.-]{0,127})(\s*[=:]\s*["']?)([^&\s,;"'}]+)/g,
      (match, prefix: string, key: string, separator: string) => defaultIsSensitiveKey(key) ? `${prefix}${key}${separator}${REDACTED_VALUE}` : match);
}

/** One cumulative structural floor budget applies to the whole body bundle, before generic sanitization. */
function bodyFloor(value: HookJson, state: { nodes: number; partial: boolean; redacted: boolean }, depth = 0): HookJson {
  if (++state.nodes > NORMALIZATION_LIMITS.bodyNodes || depth > 8) { state.partial = true; return "[TRUNCATED]"; }
  if (typeof value === "string") { const safe = floorText(value); if (safe !== value) state.redacted = true; return safe; }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const output: HookJson[] = [];
    for (let index = 0; index < Math.min(value.length, 100); index++) {
      if (state.nodes >= NORMALIZATION_LIMITS.bodyNodes) { state.partial = true; break; }
      output.push(bodyFloor(value[index], state, depth + 1));
    }
    if (output.length !== value.length) state.partial = true;
    return output;
  }
  const output: JsonRecord = Object.create(null);
  const keys = Object.keys(value);
  for (const key of keys.slice(0, 100)) {
    if (state.nodes >= NORMALIZATION_LIMITS.bodyNodes) { state.partial = true; break; }
    const safeKey = floorText(key);
    if (defaultIsSensitiveKey(key)) { output[safeKey] = REDACTED_VALUE; state.redacted = true; state.nodes++; }
    else output[safeKey] = bodyFloor(value[key], state, depth + 1);
  }
  if (Object.keys(output).length !== keys.length) state.partial = true;
  return output;
}

/** Producer data stays partial/unverified even when the actual bounded source layout is supported. */
export function normalizeClaudeHook(raw: unknown, authority: NormalizationAuthority, snapshot: TranscriptSnapshot | null): NormalizationResult {
  const admitted = parseClaudeHookInput(raw);
  if (admitted.status !== "accepted") return admitted;
  const key = Object.getOwnPropertyDescriptor(authority, "sourceKey"), mode = Object.getOwnPropertyDescriptor(authority, "captureMode");
  if (!key || !("value" in key) || typeof key.value !== "string" || !/^[a-f0-9]{64}$/.test(key.value)
    || !mode || !("value" in mode) || (mode.value !== "metadata" && mode.value !== "full")) return { status: "unavailable", reason: "invalid_authority" };
  const sourceKey: string = key.value, full = mode.value === "full", hook = admitted.value;
  if (snapshot && (typeof snapshot.text !== "string" || Buffer.byteLength(snapshot.text, "utf8") > TRANSCRIPT_LIMITS.fileBytes
    || !Number.isSafeInteger(snapshot.startOffset) || snapshot.startOffset < 0 || !Number.isSafeInteger(snapshot.endOffset)
    || snapshot.endOffset > TRANSCRIPT_LIMITS.fileBytes || snapshot.endOffset - snapshot.startOffset !== Buffer.byteLength(snapshot.text, "utf8")
    || snapshot.fileBytes !== snapshot.endOffset || !/^[a-f0-9]{64}$/.test(snapshot.incarnationKey)
    || !Number.isSafeInteger(snapshot.prefixBytes) || snapshot.prefixBytes < 0 || snapshot.prefixBytes > TRANSCRIPT_LIMITS.prefixBytes
    || snapshot.prefixBytes > snapshot.fileBytes || (snapshot.prefixBytes === 0) !== (snapshot.prefixSha256 === null)
    || (snapshot.prefixSha256 !== null && !/^[a-f0-9]{64}$/.test(snapshot.prefixSha256)))) return { status: "unavailable", reason: "invalid_snapshot" };
  const reasons = new Set<string>(hook.coverageReasons), entities = new Map<string, NormalizedClaudeEntity>();
  const identity = (kind: EntityKind, id: string) => digest(JSON.stringify(["runphantom.claude.entity/v1", sourceKey, kind, id]));
  const make = (kind: EntityKind, id: string, phase: EntityPhase, name: string, body: ObservationBody | null): NormalizedClaudeEntity => ({
    entityKey: identity(kind, id), kind, phase, name: floorText(name).slice(0, 256), model: null, sourceKind: "hook", incarnationKey: null, sourceOffset: null, reportedAt: null,
    reportedDurationMs: null, runtimeDurationMs: null, runtimeVerified: false, producerVerified: false, usage: null, body: full ? body : null, coverageReasons: ["producer_unverified"],
  });
  const add = (next: NormalizedClaudeEntity): boolean => {
    const prior = entities.get(next.entityKey);
    if (!prior && entities.size >= NORMALIZATION_LIMITS.entities) { reasons.add("entity_limit"); return false; }
    if (prior) {
      next.coverageReasons = [...new Set([...prior.coverageReasons, ...next.coverageReasons])];
      if (prior.kind === "assistant" && JSON.stringify(prior.body?.output) !== JSON.stringify(next.body?.output)) next.coverageReasons.push("assistant_fragments_unmerged");
      if (terminal(prior.phase) && next.phase === "pending") {
        prior.coverageReasons = [...new Set([...next.coverageReasons, "terminal_regression"])]; return true;
      }
      if (terminal(prior.phase) && terminal(next.phase) && prior.phase !== next.phase) { next.phase = "conflict"; next.coverageReasons.push("contradictory_terminal_claims"); }
      if (prior.body && next.body) next.body.input ??= prior.body.input;
    }
    entities.set(next.entityKey, next); return true;
  };
  add(make("session", "root", hook.event === "SessionEnd" ? "complete" : "pending", "Claude session", null));
  if (hook.toolId && ["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(hook.event)) {
    const phase = hook.event === "PreToolUse" ? "pending" : hook.event === "PostToolUse" ? "success" : hook.interrupted ? "interrupted" : "failure";
    const tool = make("tool", hook.toolId, phase, hook.toolName ?? "Tool", { input: hook.toolInput, output: hook.toolResponse, error: hook.error });
    tool.reportedDurationMs = hook.durationMs;
    if (hook.event === "PostToolUse" && hook.toolResponse === null) tool.coverageReasons.push("tool_output_absent");
    add(tool);
  }
  if (hook.agentId && ["SubagentStart", "SubagentStop"].includes(hook.event)) {
    const agent = make("subagent", hook.agentId, hook.event === "SubagentStop" ? "complete" : "pending", hook.agentType ?? "Subagent", null);
    agent.coverageReasons.push("unresolved_subagent_linkage"); add(agent);
  }
  if (hook.event === "UserPromptSubmit") reasons.add("unresolved_prompt_identity");
  if (hook.event === "Stop" && hook.lastAssistantMessage !== null) reasons.add("unresolved_assistant_identity");
  let cursor = snapshot?.startOffset ?? null;
  const requestIds = new Map<string, string | null>(), assistantBodies = new Map<string, string>();
  const started = performance.now();
  if (snapshot) {
    let position = 0, records = 0;
    while (position < snapshot.text.length) {
      if (performance.now() - started > NORMALIZATION_LIMITS.parseMs) { reasons.add("parse_deadline"); break; }
      if (records++ >= NORMALIZATION_LIMITS.records) { reasons.add("record_limit"); break; }
      const newline = snapshot.text.indexOf("\n", position);
      if (newline < 0) { reasons.add("incomplete_tail"); break; }
      const line = snapshot.text.slice(position, newline), bytes = Buffer.byteLength(line, "utf8") + 1;
      if (bytes - 1 > NORMALIZATION_LIMITS.lineBytes) { reasons.add("line_limit"); break; }
      const nextOffset = cursor! + bytes;
      if (line.trim() === "") { cursor = nextOffset; position = newline + 1; continue; }
      const decoded = parseBoundedHookJson(line, NORMALIZATION_LIMITS.lineBytes);
      if (decoded.status !== "accepted") { reasons.add(decoded.reason); cursor = nextOffset; position = newline + 1; continue; }
      const record = decoded.value;
      const currentReasons: string[] = ["producer_unverified"];
      const emitted: NormalizedClaudeEntity[] = [];
      if (!objectRecord(record) || record.sessionId !== hook.sessionId || !sourceId(record.uuid) || !objectRecord(record.message)) reasons.add("invalid_record");
      else if (record.version !== undefined && record.version !== "2.1.296") reasons.add("unsupported_version");
      else {
        if (record.version === undefined) currentReasons.push("transcript_version_absent");
        let reportedAt: string | null = null;
        if (typeof record.timestamp === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(record.timestamp)
          && Number.isFinite(Date.parse(record.timestamp)) && new Date(record.timestamp).toISOString() === record.timestamp) reportedAt = record.timestamp;
        else currentReasons.push("invalid_timestamp");
        const message = record.message;
        if (record.type === "assistant" && sourceId(message.id) && Array.isArray(message.content)) {
          const content: HookJson[] = [];
          for (const block of message.content) {
            if (objectRecord(block) && block.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text });
            else if (objectRecord(block) && block.type === "tool_use" && sourceId(block.id) && typeof block.name === "string") {
              content.push({ type: "tool_use", toolIdentity: identity("tool", block.id), name: floorText(block.name).slice(0, 256), input: block.input ?? null });
              if (Object.keys(block).some(key => !["type", "id", "name", "input"].includes(key))) currentReasons.push("unsupported_content");
            } else currentReasons.push("unsupported_content");
          }
          const assistant = make("assistant", message.id, typeof message.stop_reason === "string" && message.stop_reason.length > 0 ? "complete" : "pending", "Assistant", { input: null, output: content, error: null });
          assistant.model = typeof message.model === "string" ? floorText(message.model).slice(0, 256) : null;
          const contentDigest = digest(JSON.stringify(content)), priorAssistant = entities.get(assistant.entityKey);
          if (assistantBodies.has(assistant.entityKey) && assistantBodies.get(assistant.entityKey) !== contentDigest) currentReasons.push("assistant_fragments_unmerged");
          assistantBodies.set(assistant.entityKey, contentDigest);
          if (priorAssistant?.model && assistant.model && priorAssistant.model !== assistant.model) { assistant.phase = "conflict"; currentReasons.push("inconsistent_model_identity"); }
          const request = sourceId(record.requestId) ? record.requestId : null;
          if (requestIds.has(assistant.entityKey) && requestIds.get(assistant.entityKey) !== request) { assistant.phase = "conflict"; currentReasons.push("inconsistent_request_identity"); }
          requestIds.set(assistant.entityKey, request);
          const usage = objectRecord(message.usage) ? message.usage : {};
          const count = (field: string): number | null => {
            const value = usage[field];
            if (value === undefined || value === null) return null;
            if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
            currentReasons.push("invalid_usage"); return null;
          };
          assistant.usage = { freshInputTokens: count("input_tokens"), outputTokens: count("output_tokens"), cacheCreatedInputTokens: count("cache_creation_input_tokens"), cacheReadInputTokens: count("cache_read_input_tokens") };
          emitted.push(assistant);
        } else if (record.type === "user" && (typeof message.content === "string" || Array.isArray(message.content))) {
          const content = message.content;
          if (typeof content === "string") emitted.push(make("prompt", record.uuid, "complete", "User prompt observation", { input: content, output: null, error: null }));
          else {
            const text: HookJson[] = [];
            for (const block of content) {
              if (objectRecord(block) && block.type === "text" && typeof block.text === "string") text.push({ type: "text", text: block.text });
              else if (objectRecord(block) && block.type === "tool_result" && sourceId(block.tool_use_id)) {
                const tool = make("tool", block.tool_use_id, typeof block.is_error === "boolean" ? block.is_error ? "failure" : "success" : "unknown", "Tool", { input: null, output: block.content ?? null, error: null });
                emitted.push(tool);
              } else currentReasons.push("unsupported_content");
            }
            if (text.length) emitted.push(make("prompt", record.uuid, "complete", "User prompt observation", { input: text, output: null, error: null }));
          }
        } else reasons.add("unsupported_record");
        if (new Set(emitted.map(value => value.entityKey).filter(value => !entities.has(value))).size + entities.size > NORMALIZATION_LIMITS.entities) { reasons.add("entity_limit"); break; }
        for (const value of emitted) {
          value.sourceKind = "transcript"; value.incarnationKey = snapshot.incarnationKey; value.sourceOffset = nextOffset; value.reportedAt = reportedAt;
          value.coverageReasons = [...new Set([...value.coverageReasons, ...currentReasons])]; add(value);
        }
      }
      cursor = nextOffset; position = newline + 1;
    }
  } else reasons.add("transcript_absent");
  const list = [...entities.values()];
  let unlinkedAssertions: NormalizedClaudeBatch["unlinkedAssertions"] = full ? { prompt: hook.event === "UserPromptSubmit" ? hook.prompt : null, assistant: hook.event === "Stop" ? hook.lastAssistantMessage : null, error: hook.event === "StopFailure" ? hook.error : null } : null;
  if (full) {
    const state = { nodes: 0, partial: false, redacted: false };
    const safe = sanitizeWithReport(bodyFloor({ unlinkedAssertions, bodies: list.map(value => value.body) } as unknown as HookJson, state));
    if (state.partial || safe.truncation) reasons.add("body_partial");
    if (state.redacted || safe.redacted) reasons.add("body_redacted");
    const bundle = objectRecord(safe.value as HookJson) ? safe.value as JsonRecord : {};
    const bodies = Array.isArray(bundle.bodies) ? bundle.bodies : [];
    const assertions = bundle.unlinkedAssertions;
    unlinkedAssertions = objectRecord(assertions) ? { prompt: typeof assertions.prompt === "string" ? assertions.prompt : null, assistant: typeof assertions.assistant === "string" ? assertions.assistant : null, error: typeof assertions.error === "string" ? assertions.error : null } : null;
    list.forEach((value, index) => {
      const body = bodies[index];
      value.body = objectRecord(body) ? { input: body.input ?? null, output: body.output ?? null, error: typeof body.error === "string" ? body.error : null } : null;
      if (state.partial || safe.truncation) value.coverageReasons.push("body_partial");
      if (Buffer.byteLength(JSON.stringify(value), "utf8") > NORMALIZATION_LIMITS.entityBytes) { value.body = null; value.coverageReasons.push("body_limit"); reasons.add("body_partial"); }
    });
  }
  for (const value of list) for (const reason of value.coverageReasons) reasons.add(reason);
  const batch: NormalizedClaudeBatch = { event: hook.event, sourceKey, sessionClosureClaim: hook.event === "SessionEnd", runtimeVerified: false, producerVerified: false, coverage: "partial", coverageReasons: [...reasons], entities: list, unlinkedAssertions,
    transcriptCursor: cursor, incarnationKey: snapshot?.incarnationKey ?? null, prefixBytes: snapshot?.prefixBytes ?? null, prefixSha256: snapshot?.prefixSha256 ?? null, observedFileBytes: snapshot?.fileBytes ?? null };
  if (Buffer.byteLength(JSON.stringify(batch), "utf8") > NORMALIZATION_LIMITS.transportBytes) {
    for (const value of list) { value.body = null; value.coverageReasons.push("body_limit"); }
    batch.unlinkedAssertions = null; batch.coverageReasons = [...new Set([...batch.coverageReasons, "body_partial"])];
  }
  return Buffer.byteLength(JSON.stringify(batch), "utf8") > NORMALIZATION_LIMITS.transportBytes ? { status: "unavailable", reason: "transport_limit" } : { status: "accepted", value: batch };
}
