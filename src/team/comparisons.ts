import type { ComparisonStore, ComparisonFence } from "../prompts/comparison-store";
import type { ComparisonCoordinator } from "../prompts/comparison";
import { ComparisonError, comparisonJson } from "../prompts/comparison-protocol";
import { PromptRegistryError, promptId, promptInteger, promptObject } from "../prompts/protocol";
import { TeamError } from "./errors";

export type TeamComparisonRead = { kind: "capabilities" } | { kind: "list"; cursor?: unknown } | { kind: "get" | "export"; id: unknown };
export type TeamComparisonWrite = { kind: "submit" | "clear"; value: unknown } | { kind: "cancel"; id: unknown; value: unknown };
export interface TeamComparisonResponse { value: unknown; status: number; fence: ComparisonFence }
export function teamComparisonOperation<T>(work: () => T): T {
  try { return work(); } catch (error) {
    if (!(error instanceof ComparisonError) && !(error instanceof PromptRegistryError)) throw error;
    throw new TeamError(error.status === 403 ? "forbidden" : error.status === 404 ? "not_found" : error.status === 409 ? "conflict"
      : error.status === 413 ? "too_large" : "invalid_request", error.message);
  }
}
export function readTeamComparison(store: ComparisonStore, input: TeamComparisonRead, fence: ComparisonFence): TeamComparisonResponse {
  return teamComparisonOperation(() => {
    const value = input.kind === "capabilities" ? store.capabilities(fence) : input.kind === "list" ? store.list(input.cursor, fence)
      : input.kind === "get" ? store.get(input.id, fence) : store.export(input.id, fence);
    comparisonJson(value); return { value, status: 200, fence };
  });
}
export function writeTeamComparison(store: ComparisonStore, coordinator: ComparisonCoordinator, input: TeamComparisonWrite, fence: ComparisonFence): TeamComparisonResponse {
  return teamComparisonOperation(() => {
    let value: unknown, next = fence;
    if (input.kind === "submit") value = coordinator.submit(store, input.value, fence);
    else if (input.kind === "cancel") {
      const body = promptObject(input.value, ["expectedGeneration"]);
      if (promptInteger(body.expectedGeneration) !== fence.comparisonGeneration) throw new ComparisonError("authority_changed");
      value = coordinator.cancel(store, promptId(input.id), fence);
    } else { const result = coordinator.clear(store, input.value, fence); value = result; next = { ...fence, comparisonGeneration: result.generation }; }
    comparisonJson(value); return { value, status: input.kind === "submit" ? 201 : 200, fence: next };
  });
}
