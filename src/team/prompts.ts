import { PromptRegistryError, PROMPT_LIMITS, PROMPT_POLICY, boundedPromptResult, type PromptCapability } from "../prompts/protocol";
import type { PromptRegistry } from "../prompts/registry";
import { TeamError } from "./errors";

export type TeamPromptRead =
  | { kind: "capabilities" }
  | { kind: "list"; cursor?: unknown }
  | { kind: "history"; id: unknown }
  | { kind: "revision"; id: unknown; revision: unknown }
  | { kind: "export"; id: unknown; revision: unknown };
export type TeamPromptWrite =
  | { kind: "create"; value: unknown }
  | { kind: "append"; id: unknown; value: unknown }
  | { kind: "compile"; id: unknown; revision: unknown; variables: unknown }
  | { kind: "delete"; id: unknown; expectedRevision: unknown }
  | { kind: "clear"; value: unknown };
export interface TeamPromptResponse { value: unknown; status: number; generation: number }

export function teamPromptCapability(kind: TeamPromptWrite["kind"]): PromptCapability {
  return kind === "compile" ? "read" : kind === "delete" || kind === "clear" ? "delete" : "edit";
}
/** Preserve the existing authenticated Team error envelope without exposing storage errors. */
export function teamPromptOperation<T>(work: () => T): T {
  try { return work(); }
  catch (error) {
    if (!(error instanceof PromptRegistryError)) throw error;
    throw new TeamError(error.status === 403 ? "forbidden" : error.status === 404 ? "not_found"
      : error.status === 409 ? "conflict" : error.status === 413 ? "too_large" : "invalid_request", error.message);
  }
}
/** The actual private TeamStore supplies this registry; this module opens no database. */
export function readTeamPrompt(registry: PromptRegistry, input: TeamPromptRead, generation: number): TeamPromptResponse {
  return teamPromptOperation(() => {
    let value: unknown;
    switch (input.kind) {
      case "capabilities":
        if (registry.capture("read") !== generation) throw new PromptRegistryError("authority_changed");
        value = { enabled: true, scope: "project", policy: PROMPT_POLICY, generation, limits: PROMPT_LIMITS }; break;
      case "list": value = registry.list(input.cursor, generation); break;
      case "history": value = registry.history(input.id, generation); break;
      case "revision": value = registry.get(input.id, input.revision, generation); break;
      case "export": value = registry.export(input.id, input.revision, generation); break;
    }
    return { value: boundedPromptResult(value), status: 200, generation };
  });
}
export function writeTeamPrompt(registry: PromptRegistry, input: TeamPromptWrite, generation: number): TeamPromptResponse {
  return teamPromptOperation(() => {
    let value: unknown, current = generation;
    switch (input.kind) {
      case "create": value = registry.create(input.value, generation); break;
      case "append": value = registry.append(input.id, input.value, generation); break;
      case "compile": value = registry.compile(input.id, input.revision, input.variables, generation); break;
      case "delete": value = registry.delete(input.id, input.expectedRevision, generation); break;
      case "clear": { const result = registry.clear(input.value, generation); value = result; current = result.generation; break; }
    }
    return { value: boundedPromptResult(value), status: input.kind === "create" || input.kind === "append" ? 201 : 200, generation: current };
  });
}
