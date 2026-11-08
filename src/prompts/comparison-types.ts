import type { FrozenRateRevision } from "../pricing/protocol";

export type ComparisonProvider = "openai" | "anthropic";
export interface ComparisonTarget { readonly provider: ComparisonProvider; readonly model: string }
export const COMPARISON_TARGET_LIMIT = 4;
export const COMPARISON_OUTPUT_TOKEN_LIMIT = 1024;
/** Browser-safe so the UI and daemon share one allowlist. */
export const COMPARISON_MODELS = Object.freeze([
  Object.freeze({ provider: "openai", model: "gpt-5.4" }), Object.freeze({ provider: "openai", model: "gpt-4.1" }),
  Object.freeze({ provider: "anthropic", model: "claude-opus-4-6" }), Object.freeze({ provider: "anthropic", model: "claude-sonnet-4-6" }),
  Object.freeze({ provider: "openai", model: "gpt-6.1-terra" }), Object.freeze({ provider: "anthropic", model: "claude-sonnet-5-5" }),
] as const);
export interface ComparisonModelSettings {
  readonly reasoningEffort: "none" | "medium" | null; readonly thinking: "disabled" | "between_tools" | null; readonly temperature: "requested" | "provider_default";
}
/**
 * gpt-6.1-terra only accepts the default temperature (1) once reasoning is on, and claude-sonnet-5-5 rejects any
 * temperature and `thinking: disabled` with HTTP 400; `between_tools` is its lowest setting and returns text only
 * when no tools are sent (developers.openai.com/api/docs/models/gpt-6.1-terra, platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5).
 */
export function comparisonModelSettings(target: ComparisonTarget): ComparisonModelSettings {
  if (target.provider === "anthropic") return target.model === "claude-sonnet-5-5"
    ? { reasoningEffort: null, thinking: "between_tools", temperature: "provider_default" } : { reasoningEffort: null, thinking: "disabled", temperature: "requested" };
  return target.model === "gpt-6.1-terra" ? { reasoningEffort: "medium", thinking: null, temperature: "provider_default" }
    : { reasoningEffort: target.model === "gpt-5.4" ? "none" : null, thinking: null, temperature: "requested" };
}
export interface ComparisonOptions { readonly maxOutputTokens: number; readonly temperature: number }
export interface ComparisonRequest {
  readonly operationKey: string; readonly promptId: string; readonly revision: number; readonly variables: Readonly<Record<string, string>>;
  readonly targets: readonly ComparisonTarget[]; readonly options: ComparisonOptions; readonly operationBudgetMicrousd: number; readonly expectedGeneration: number;
}
export interface FrozenComparisonRequest extends ComparisonRequest {
  readonly policy: "runphantom-model-comparison/v1"; readonly prompt: { readonly id: string; readonly revision: number; readonly name: string; readonly templateSha256: string };
  readonly compiled: string; readonly families: readonly ComparisonFamily[];
}
export interface ComparisonFamily extends ComparisonTarget {
  readonly version: "standard-text/v1"; readonly endpoint: "chat-completions" | "messages";
  readonly reasoningEffort: ComparisonModelSettings["reasoningEffort"]; readonly thinking: ComparisonModelSettings["thinking"]; readonly temperature: ComparisonModelSettings["temperature"];
  readonly tier: "default" | "standard_only"; readonly inferenceGeo: "global" | null; readonly store: false;
}
export interface FrozenExecution extends FrozenComparisonRequest { readonly rates: readonly FrozenRateRevision[] }
export type ComparisonAttemptStatus = "queued" | "running" | "completed" | "failed" | "timeout" | "cancelled" | "unavailable" | "budget_refused" | "interrupted" | "authority_lost";
export interface ComparisonAttempt {
  position: number; provider: ComparisonProvider; model: string; status: ComparisonAttemptStatus; reason: string | null; payload: unknown;
  reserveMicrousd: number; holdMicrousd: number; chargeMicrousd: number; accountingState: string; observedEstimateUsd: string | null;
  budgetBreach: boolean; deadlineAt: number; startedAt: number | null; finishedAt: number | null;
}
export interface ComparisonReceipt { id: string; operationKey: string; createdAt: number; tombstone: boolean; request: FrozenExecution | null; attempts: ComparisonAttempt[] }
export type ComparisonAttemptSummary = Omit<ComparisonAttempt, "payload">;
export interface ComparisonSummary { id: string; createdAt: number; tombstone: boolean; prompt: { name: string; revision: number } | null; attempts: ComparisonAttemptSummary[] }
export interface ComparisonPage { items: ComparisonSummary[]; cursor: string | null; hasMore: boolean }
