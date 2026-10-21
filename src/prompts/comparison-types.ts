import type { FrozenRateRevision } from "../pricing/protocol";

export type ComparisonProvider = "openai" | "anthropic";
export interface ComparisonTarget { readonly provider: ComparisonProvider; readonly model: string }
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
  readonly reasoningEffort: "none" | null; readonly thinking: "disabled" | null;
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
