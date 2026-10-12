import path from "node:path";
import { acquireClaudeTranscript, type TranscriptAcquisition } from "./claude";
import type { ClaudeHookInput } from "./shared";
import type { HookAdmission } from "./store";

/** Even a valid local full capability cannot use an unregistered cwd or another project's source. */
export async function acquireRegisteredClaudeTranscript(hook: ClaudeHookInput, admission: HookAdmission, signal?: AbortSignal): Promise<TranscriptAcquisition> {
  const binding = admission.binding;
  if (hook.cwd !== binding.registeredWorkspace) return { status: "unavailable", reason: "path_not_authorized" };
  const reported = hook.transcriptPath;
  // The session cursor belongs only to the main descriptor; agent paths grant no acquisition.
  if (hook.event === "SubagentStop" && hook.agentTranscriptPath !== null) {
    const agent = hook.agentTranscriptPath;
    if (!path.isAbsolute(agent) || path.normalize(agent) !== agent || agent !== path.join(binding.projectDirectory, hook.sessionId, "subagents", `agent-${hook.agentId}.jsonl`)) return { status: "unavailable", reason: "path_not_authorized" };
  }
  if (!reported) return { status: "unavailable", reason: "source_unavailable" };
  const candidate = reported.startsWith("~/") ? path.join(binding.homeDirectory, reported.slice(2)) : reported;
  const relative = path.relative(binding.projectDirectory, candidate);
  if (!path.isAbsolute(candidate) || !relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return { status: "unavailable", reason: "path_not_authorized" };
  return acquireClaudeTranscript(hook.event === "SubagentStop" ? { ...hook, event: "Stop" } : hook, { projectsRoot: binding.transcriptRoot, homeDirectory: binding.homeDirectory, cursor: admission.transcriptCursor, prefixBytes: admission.prefixBytes, expectedIncarnationKey: admission.incarnationKey, expectedPrefixSha256: admission.prefixSha256 }, signal);
}

