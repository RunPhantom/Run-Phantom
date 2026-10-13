import { createHash } from "node:crypto";
import { literalPromptCompilation, promptId, promptInteger, promptObject, promptText, boundedPromptResult, type PromptRevision } from "./protocol";

export const COMPARISON_POLICY = "runphantom-model-comparison/v1" as const;
export const COMPARISON_LIMITS = Object.freeze({ targets: 4, active: 2, queued: 8, inputBytes: 16384, providerResponseBytes: 65536,
  frozenRequestBytes: 24576, attemptPayloadBytes: 8192, responseBytes: 65536, requestBytes: 65536,
  outputTokens: 1024, attemptMs: 30000, operationsPerScope: 100, operationsGlobal: 1000, attemptsGlobal: 4000,
  controlsGlobal: 1000, retainedBytes: 33554432, operationBudgetMicrousd: 1000000, providerBudgetMicrousd: 30000000, listPage: 50 });
export const COMPARISON_MODELS = Object.freeze([
  Object.freeze({ provider: "openai", model: "gpt-4.1-mini" }), Object.freeze({ provider: "openai", model: "gpt-4.1" }),
  Object.freeze({ provider: "anthropic", model: "claude-haiku-4-5-20251001" }), Object.freeze({ provider: "anthropic", model: "claude-sonnet-4-6" }),
] as const);
export type ComparisonProvider = "openai" | "anthropic";
export interface ComparisonTarget { readonly provider: ComparisonProvider; readonly model: string }
export interface ComparisonOptions { readonly maxOutputTokens: number; readonly temperature: number }
export interface ComparisonRequest {
  readonly operationKey: string; readonly promptId: string; readonly revision: number; readonly variables: Readonly<Record<string, string>>;
  readonly targets: readonly ComparisonTarget[]; readonly options: ComparisonOptions; readonly operationBudgetMicrousd: number; readonly expectedGeneration: number;
}
export interface FrozenComparisonRequest extends ComparisonRequest {
  readonly policy: typeof COMPARISON_POLICY; readonly prompt: { readonly id: string; readonly revision: number; readonly name: string; readonly templateSha256: string };
  readonly compiled: string;
}
const messages = { invalid_request: "Comparison request is invalid.", limit_refused: "Comparison exceeds its limit.",
  source_conflict: "The selected prompt revision does not match.", operation_conflict: "Comparison operation key conflicts.",
  authority_changed: "Comparison authority changed. Retry with current access.", not_found: "Comparison not found.",
  unavailable: "Comparison scope is unavailable.", capacity: "Comparison capacity reached.", integrity: "Stored comparison integrity check failed.",
  deleted: "Comparison content was removed.", budget_refused: "Comparison exceeds the admitted budget." } as const;
export class ComparisonError extends Error {
  readonly status: number;
  constructor(readonly code: keyof typeof messages) { super(messages[code]); this.name = "ComparisonError";
    this.status = code === "not_found" ? 404 : code === "unavailable" ? 403 : ["limit_refused", "capacity"].includes(code) ? 413
      : ["source_conflict", "operation_conflict", "authority_changed", "integrity", "deleted"].includes(code) ? 409 : 400; }
}
export function comparisonTarget(value: unknown): ComparisonTarget {
  const input = promptObject(value, ["provider", "model"]);
  const found = COMPARISON_MODELS.find(target => target.provider === input.provider && target.model === input.model);
  if (!found) throw new ComparisonError("invalid_request");
  return { ...found };
}
export function parseComparisonRequest(value: unknown): ComparisonRequest {
  const input = promptObject(value, ["operationKey", "promptId", "revision", "variables", "targets", "options", "operationBudgetMicrousd", "expectedGeneration"]);
  const variables: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!input.variables || typeof input.variables !== "object" || Array.isArray(input.variables)) throw new ComparisonError("invalid_request");
  const names = Reflect.ownKeys(input.variables);
  if (names.length > 32 || names.some(name => typeof name !== "string")) throw new ComparisonError("limit_refused");
  for (const [name, content] of Object.entries(promptObject(input.variables, names as string[]))) variables[name] = promptText(content, 4096);
  if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > COMPARISON_LIMITS.targets) throw new ComparisonError("invalid_request");
  const targets: ComparisonTarget[] = [], seen = new Set<string>();
  for (let i = 0; i < input.targets.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(input.targets, String(i));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new ComparisonError("invalid_request");
    const target = comparisonTarget(descriptor.value), key = `${target.provider}:${target.model}`;
    if (seen.has(key)) throw new ComparisonError("invalid_request"); seen.add(key); targets.push(target);
  }
  if (Reflect.ownKeys(input.targets).length !== input.targets.length + 1) throw new ComparisonError("invalid_request");
  const options = promptObject(input.options, ["maxOutputTokens", "temperature"]), temperature = options.temperature;
  if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 1) throw new ComparisonError("invalid_request");
  return { operationKey: promptId(input.operationKey), promptId: promptId(input.promptId), revision: promptInteger(input.revision, 32), variables,
    targets, options: { maxOutputTokens: promptInteger(options.maxOutputTokens, COMPARISON_LIMITS.outputTokens), temperature },
    operationBudgetMicrousd: promptInteger(input.operationBudgetMicrousd, COMPARISON_LIMITS.operationBudgetMicrousd), expectedGeneration: promptInteger(input.expectedGeneration) };
}
/** Reuse the immutable registry's selected source, never a mutable latest lookup. */
export function freezeComparisonRequest(input: ComparisonRequest, source: PromptRevision): FrozenComparisonRequest {
  if (source.id !== input.promptId || source.revision !== input.revision || source.policy !== "literal-v1"
    || createHash("sha256").update(source.template).digest("hex") !== source.templateSha256) throw new ComparisonError("source_conflict");
  const compiled = promptText(literalPromptCompilation(source.template, input.variables), COMPARISON_LIMITS.inputBytes);
  const result = { ...input, variables: { ...input.variables }, targets: input.targets.map(target => Object.freeze({ ...target })), options: Object.freeze({ ...input.options }),
    prompt: Object.freeze({ id: source.id, revision: source.revision, name: source.name, templateSha256: source.templateSha256 }), compiled, policy: COMPARISON_POLICY };
  comparisonJson(result, COMPARISON_LIMITS.frozenRequestBytes);
  Object.freeze(result.variables); Object.freeze(result.targets); return Object.freeze(result);
}
/** The existing finite DTO walker bounds serialization before its small JSON allocation. */
export function comparisonJson(value: unknown, maximum: number = COMPARISON_LIMITS.responseBytes): string {
  boundedPromptResult(value);
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > maximum) throw new ComparisonError("limit_refused");
  return json;
}
