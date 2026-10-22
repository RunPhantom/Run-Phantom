import type { DatasetCase, Status, RuleResult } from "./protocol";

export const EXECUTION_FORMAT = "runphantom-dataset-execution/v1" as const;
export const EXECUTION_LIMITS = { MAX_CASES: 50, MAX_ATTEMPTS: 3, MAX_CONCURRENCY: 2, MAX_ACTIVE: 2, MAX_QUEUE: 100,
  MIN_TIMEOUT_MS: 100, MAX_TIMEOUT_MS: 120_000, MAX_RESPONSE_BYTES: 64 * 1024, MAX_RECORD_BYTES: 4 * 1024 * 1024,
  MAX_OPERATIONS: 200, MAX_PROVIDER_USD: 30 } as const;
export interface ExecutionDraft {
  datasetId: string; version: number; datasetHash: string; endpointName: string; operationKey: string;
  concurrency: number; timeoutMs: number; maxAttempts: number; maxTotalCostUsd: number; maxCostPerAttemptUsd: number; allowSideEffects: true;
}
export type AttemptStatus = "not_started" | "running" | "transport_success" | "failed" | "timed_out" | "cancelled" | "interrupted" | "unavailable";
export interface ExecutionAttempt {
  id: string; index: number; status: AttemptStatus; startedAt: number | null; completedAt: number | null;
  runId: string | null; actualCostUsd: number | null; reason: string; sideEffects: "not_dispatched" | "may_have_occurred";
}
export interface ExecutionCase {
  case: DatasetCase; attempts: ExecutionAttempt[];
  grading: { status: Status; checks: RuleResult[]; runId: string | null; reason: string };
}
export interface DatasetExecution {
  format: typeof EXECUTION_FORMAT; kind: "registered_endpoint_execution"; id: string; requestDigest: string;
  dataset: { id: string; name: string; version: number; hash: string }; request: ExecutionDraft;
  createdAt: number; completedAt: number | null; status: "queued" | "running" | "completed" | "cancelled" | "interrupted";
  reservedCostUsd: number; cases: ExecutionCase[];
}
export interface DispatchResult { status: "transport_success" | "failed" | "unavailable"; runId: string | null; actualCostUsd: number | null }
