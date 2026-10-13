import { request } from "node:http";
import path from "node:path";
import { readClaudeCapabilityDescriptor, type ClaudeCapabilityDescriptor } from "./capability";
import { acquireRegisteredClaudeTranscript } from "./acquisition";
import { normalizeClaudeHook } from "./claude";
import { hookDigest, HOOK_PROTOCOL, isHex } from "./protocol";
import { parseBoundedHookJson, type ClaudeHookInput } from "./shared";
import type { HookAdmission } from "./store";

export const CLIENT_LIMITS = Object.freeze({ responseBytes: 16384, requestMs: 300, transportBytes: 262144 });
export function postClaudeHook(capability: ClaudeCapabilityDescriptor, endpoint: "admission" | "publication", body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > CLIENT_LIMITS.transportBytes || capability.state !== "active" || !capability.origin || !capability.token || signal.aborted) return Promise.reject(new Error("unavailable"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: Record<string, unknown>) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); if (error) reject(error); else resolve(value!); };
    // The reviewed descriptor supplies the sole fixed loopback origin. Native HTTP never follows redirects.
    const client = request(capability.origin + "/api/coding-hooks/claude/" + endpoint, { method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(encoded), authorization: "Bearer " + capability.token } });
    const abort = () => { finish(new Error("unavailable")); client.destroy(); };
    const timer = setTimeout(abort, CLIENT_LIMITS.requestMs); signal.addEventListener("abort", abort, { once: true });
    client.once("error", () => finish(new Error("unavailable")));
    client.once("response", response => {
      const chunks: Buffer[] = []; let bytes = 0;
      if (response.statusCode !== 200 || response.headers["content-type"] !== "application/json") { abort(); response.destroy(); return; }
      response.on("data", chunk => { if (!Buffer.isBuffer(chunk) || chunk.length > CLIENT_LIMITS.responseBytes - bytes) { abort(); response.destroy(); return; } bytes += chunk.length; chunks.push(chunk); });
      response.once("error", abort); response.once("aborted", abort);
      response.once("end", () => {
        try {
          const parsed = parseBoundedHookJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)), CLIENT_LIMITS.responseBytes);
          if (parsed.status !== "accepted" || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) throw new Error("unavailable");
          finish(undefined, parsed.value);
        } catch { abort(); }
      });
    });
    if (signal.aborted) abort(); else client.end(encoded);
  });
}
export function validateMainAdmission(value: Record<string, unknown>, capability: ClaudeCapabilityDescriptor, hook: ClaudeHookInput, project: string): HookAdmission {
  const keys = ["version", "ownerGeneration", "installationGeneration", "sourceKey", "runId", "rootSpanId", "captureMode", "transcriptCursor", "incarnationKey", "prefixBytes", "prefixSha256", "observedFileBytes", "binding", "coverage", "producerVerified", "runtimeVerified"];
  if (Object.keys(value).sort().join() !== keys.sort().join() || value.version !== HOOK_PROTOCOL || value.ownerGeneration !== capability.ownerGeneration || value.installationGeneration !== capability.installationGeneration
    || !isHex(value.sourceKey, 64) || !isHex(value.runId, 32) || !isHex(value.rootSpanId, 16) || value.coverage !== "partial" || value.producerVerified !== false || value.runtimeVerified !== false) throw new Error("unavailable");
  const binding = value.binding;
  if (!binding || typeof binding !== "object" || Array.isArray(binding) || Object.keys(binding).sort().join() !== "captureMode,executable,homeDirectory,installationId,projectDirectory,registeredWorkspace,scope,settingsPath,transcriptRoot,workspace") throw new Error("unavailable");
  const b = binding as Record<string, unknown>;
  if (b.installationId !== capability.installationId || b.registeredWorkspace !== hook.cwd || b.projectDirectory !== project || b.captureMode !== value.captureMode || !["metadata", "full"].includes(value.captureMode as string)
    || (b.scope === "global" ? b.workspace !== null || b.captureMode !== "metadata" : b.scope !== "local" || b.workspace !== b.registeredWorkspace)) throw new Error("unavailable");
  for (const key of ["executable", "homeDirectory", "projectDirectory", "registeredWorkspace", "settingsPath", "transcriptRoot"]) { const p = b[key]; if (typeof p !== "string" || !path.isAbsolute(p) || path.normalize(p) !== p || p.includes("\0") || Buffer.byteLength(p) > 4096) throw new Error("unavailable"); }
  const relative = path.relative(b.transcriptRoot as string, project); if (!relative || relative.includes(path.sep) || relative === ".." || path.isAbsolute(relative)) throw new Error("unavailable");
  for (const key of ["transcriptCursor", "prefixBytes", "observedFileBytes"]) if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0 || (value[key] as number) > (key === "prefixBytes" ? 65536 : 8388608)) throw new Error("unavailable");
  if ((value.transcriptCursor as number) > (value.observedFileBytes as number) || (value.prefixBytes as number) > (value.observedFileBytes as number)
    || value.incarnationKey !== null && !isHex(value.incarnationKey, 64) || (value.prefixBytes === 0 ? value.prefixSha256 !== null : !isHex(value.prefixSha256, 64)) || value.transcriptCursor !== 0 && value.incarnationKey === null) throw new Error("unavailable");
  return value as unknown as HookAdmission;
}
/** No DB, profile discovery, daemon startup or policy promotion exists in this graph. */
export async function captureClaudeHook(raw: string, hook: ClaudeHookInput, file: string, installationId: string, signal: AbortSignal): Promise<void> {
  const capability = await readClaudeCapabilityDescriptor(file, installationId, undefined, signal);
  if (capability.state !== "active" || !hook.cwd || !path.isAbsolute(hook.cwd) || path.normalize(hook.cwd) !== hook.cwd) return;
  const reported = hook.transcriptPath;
  if (!reported || !path.isAbsolute(reported) || path.normalize(reported) !== reported) return;
  const project = path.dirname(reported);
  const sourceSessionIdentity = hookDigest(JSON.stringify(["runphantom.claude.session-identity/v1", hook.sessionId]));
  const reply = await postClaudeHook(capability, "admission", { version: HOOK_PROTOCOL, sourceSessionIdentity, workspaceClaim: hookDigest(JSON.stringify(["runphantom.claude.workspace-claim/v1", hook.cwd])), projectClaim: hookDigest(JSON.stringify(["runphantom.claude.project-claim/v1", project])) }, signal);
  const admission = validateMainAdmission(reply, capability, hook, project);
  const acquired = await acquireRegisteredClaudeTranscript(hook, admission, signal); if (acquired.status !== "accepted" || signal.aborted) return;
  const normalized = normalizeClaudeHook(raw, { sourceKey: admission.sourceKey, captureMode: admission.captureMode }, acquired.value); if (normalized.status !== "accepted" || signal.aborted) return;
  await postClaudeHook(capability, "publication", { version: HOOK_PROTOCOL, ownerGeneration: admission.ownerGeneration, installationGeneration: admission.installationGeneration, sourceKey: admission.sourceKey, batch: normalized.value }, signal);
}
