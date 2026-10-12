import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { ClaudeHookInput } from "./shared";

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
