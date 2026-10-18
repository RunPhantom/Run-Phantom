import type { ComparisonReceipt, ComparisonPage, ComparisonAttempt } from "../../../../src/prompts/comparison-types";
import type { PromptClient } from "./client";

export type { ComparisonReceipt, ComparisonPage, ComparisonAttempt };
export interface ComparisonModel { provider: "openai" | "anthropic"; model: string; available: boolean; spendingEnabled: boolean; admissionReason: string | null; reservationCeilingMicrousd: number }
export interface ComparisonCapabilities { enabled: true; generation: number; models: ComparisonModel[]; invoiceAvailable: false }
const invalid = () => new Error("The comparison response does not match its finite format. Refresh with current access.");
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(); return value as Record<string, unknown>; };
const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): number => { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw invalid(); return value; };
const text = (value: unknown, maximum: number): string => { if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > maximum || value.includes("\0")) throw invalid(); return value; };
const id = (value: unknown): string => { const parsed = text(value, 36); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(parsed)) throw invalid(); return parsed; };
const target = (value: Record<string, unknown>) => {
  const provider = value.provider, model = text(value.model, 128);
  if (provider === "openai" && !["gpt-5.4", "gpt-4.1"].includes(model) || provider === "anthropic" && !["claude-opus-4-6", "claude-sonnet-4-6"].includes(model) || provider !== "openai" && provider !== "anthropic") throw invalid();
  return { provider, model };
};
function attempt(value: unknown, position: number): void {
  const row = object(value); target(row); if (integer(row.position, 3) !== position) throw invalid();
  if (!["queued", "running", "completed", "failed", "timeout", "cancelled", "unavailable", "budget_refused", "interrupted", "authority_lost"].includes(String(row.status))) throw invalid();
  if (row.reason !== null) text(row.reason, 64); integer(row.reserveMicrousd, 30000000); integer(row.holdMicrousd, 30000000); integer(row.chargeMicrousd, 2251799813685);
  if (!["not_started", "measured_estimate", "conservative", "unrepresentable_overage"].includes(String(row.accountingState)) || typeof row.budgetBreach !== "boolean") throw invalid();
  if (row.observedEstimateUsd !== null) { const amount = text(row.observedEstimateUsd, 64); if (!Number.isFinite(Number(amount)) || Number(amount) < 0) throw invalid(); }
  integer(row.deadlineAt); for (const field of ["startedAt", "finishedAt"]) if (row[field] !== null) integer(row[field]);
  if (row.payload !== undefined && row.payload !== null) {
    const payload = object(row.payload); text(payload.output, 8192); if (!["official-provider", "controlled-http-fixture"].includes(String(payload.provenance)) || payload.invoiceUsd !== null) throw invalid();
    const categories = object(object(payload.usage).categories); for (const field of ["input", "output"]) { const value = object(categories[field]).count; if (value !== null) integer(value); }
  }
}
export function comparisonCapabilities(value: unknown): ComparisonCapabilities {
  const input = object(value); if (input.enabled !== true || input.invoiceAvailable !== false || !Array.isArray(input.models) || input.models.length !== 4 || integer(input.generation) < 1) throw invalid();
  const seen = new Set<string>();
  for (const value of input.models) {
    const model = object(value), parsed = target(model), key = `${parsed.provider}:${parsed.model}`;
    if (seen.has(key) || typeof model.available !== "boolean" || typeof model.spendingEnabled !== "boolean"
      || ![null, "credentials_unavailable", "budget_not_configured", "overage_fuse", "ceiling_reached"].includes(model.admissionReason as string | null)) throw invalid();
    if (model.spendingEnabled !== (model.available && model.admissionReason === null) || integer(model.reservationCeilingMicrousd, 30000000) < 1) throw invalid(); seen.add(key);
  }
  return input as unknown as ComparisonCapabilities;
}
export function comparisonReceipt(value: unknown): ComparisonReceipt {
  const input = object(value); id(input.id); id(input.operationKey); integer(input.createdAt);
  if (typeof input.tombstone !== "boolean" || !Array.isArray(input.attempts) || input.attempts.length < 1 || input.attempts.length > 4) throw invalid();
  input.attempts.forEach(attempt);
  if (input.request !== null) {
    const request = object(input.request), prompt = object(request.prompt); id(prompt.id); integer(prompt.revision, 32); text(prompt.name, 256); text(prompt.templateSha256, 64); text(request.compiled, 16384);
    if (input.tombstone || request.policy !== "runphantom-model-comparison/v1" || prompt.id !== request.promptId || prompt.revision !== request.revision || !Array.isArray(request.targets) || request.targets.length !== input.attempts.length) throw invalid();
    id(request.operationKey); if (request.operationKey !== input.operationKey || integer(request.revision, 32) < 1 || integer(request.expectedGeneration) < 1 || integer(request.operationBudgetMicrousd, 1000000) < 1) throw invalid();
    const options = object(request.options); if (integer(options.maxOutputTokens, 1024) < 1 || typeof options.temperature !== "number" || !Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 1) throw invalid();
    const variables = object(request.variables); if (Object.keys(variables).length > 32) throw invalid(); for (const [name, value] of Object.entries(variables)) { text(name, 128); text(value, 4096); }
    request.targets.forEach((value, position) => { const model = target(object(value)), row = object((input.attempts as unknown[])[position]); if (row.provider !== model.provider || row.model !== model.model) throw invalid(); });
    if (!Array.isArray(request.rates) || request.rates.length !== request.targets.length || !Array.isArray(request.families) || request.families.length !== request.targets.length) throw invalid();
  } else if (!input.tombstone || input.attempts.some(value => object(value).payload !== null)) throw invalid();
  return input as unknown as ComparisonReceipt;
}
export function comparisonPage(value: unknown): ComparisonPage {
  const input = object(value); if (!Array.isArray(input.items) || input.items.length > 20 || typeof input.hasMore !== "boolean" || input.hasMore !== (input.cursor !== null)) throw invalid();
  if (input.cursor !== null && !/^[A-Za-z0-9_-]{1,256}$/.test(text(input.cursor, 256))) throw invalid();
  const seen = new Set<string>();
  for (const value of input.items) {
    const row = object(value), currentId = id(row.id); integer(row.createdAt); if (seen.has(currentId) || typeof row.tombstone !== "boolean" || !Array.isArray(row.attempts) || row.attempts.length < 1 || row.attempts.length > 4) throw invalid(); seen.add(currentId);
    row.attempts.forEach(attempt); if (row.prompt !== null) { const prompt = object(row.prompt); text(prompt.name, 256); integer(prompt.revision, 32); if (row.tombstone) throw invalid(); } else if (!row.tombstone) throw invalid();
  }
  return input as unknown as ComparisonPage;
}
export function comparisonRequest(client: PromptClient, signal: AbortSignal) {
  return async (path: string, options: { method?: string; body?: unknown } = {}) => {
    const result = await client.request<unknown>(`/comparisons${path}`, { ...options, signal, responseBytes: 65536 }); signal.throwIfAborted();
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 65536) throw invalid(); return result;
  };
}
export function comparisonExport(value: unknown, expectedId: string): unknown {
  const input = object(value); if (input.format !== "runphantom-model-comparison/v1" || comparisonReceipt(input.operation).id !== expectedId) throw invalid(); return input;
}
export function comparisonOutput(attempt: ComparisonAttempt): { output: string | null; input: number | null; outputTokens: number | null; controlled: boolean } {
  if (!attempt.payload) return { output: null, input: null, outputTokens: null, controlled: false };
  const payload = object(attempt.payload), usage = object(payload.usage), categories = object(usage.categories);
  const count = (field: string) => { const value = object(categories[field]).count; return value === null ? null : integer(value); };
  return { output: text(payload.output, 8192), input: count("input"), outputTokens: count("output"), controlled: payload.provenance === "controlled-http-fixture" };
}
