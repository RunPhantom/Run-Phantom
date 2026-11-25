import { hasDuplicateJsonKeys } from "../json-keys";
import { parseJsonEvidence } from "../evaluations/json-evidence";
import { reportedCost } from "./analytics";
import { estimateListPriceCost, spanCacheUsage, type ListPriceEstimate } from "./list-prices";

export interface CostSpan {
  readonly model: string | null;
  readonly provider: string | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly attributes: string | null;
  readonly start_time_ms?: number | null;
}

export type SpanCostUnavailableReason = "reported_cost_invalid" | "model_unpriced" | "usage_unavailable" | "cache_usage_ambiguous" | "estimate_failed";

export type SpanCost =
  | { readonly source: "reported"; readonly usd: number }
  | { readonly source: "list-price"; readonly usd: number; readonly estimate: Extract<ListPriceEstimate, { kind: "estimated" }> }
  | { readonly source: null; readonly usd: null; readonly reason: SpanCostUnavailableReason };

export interface GenerationCostInput {
  /** Parsed span attributes, or null when they could not be read (then no reported cost is known). */
  readonly values: Record<string, unknown> | null;
  /** Model ids to price, in order of preference; the first one the table knows is used. */
  readonly models: readonly (string | null | undefined)[];
  readonly provider: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Call start in epoch ms; prices with an announced end do not apply after it. */
  readonly at: number | null;
}

function attributeValues(attributes: string | null): Record<string, unknown> | null {
  if (attributes === null) return {};
  try {
    if (attributes.length > 64 * 1024 || hasDuplicateJsonKeys(attributes)) return null;
    const value = parseJsonEvidence(attributes);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

export function requestModel(values: Record<string, unknown> | null): string | null {
  const value = values?.["gen_ai.request.model"];
  return typeof value === "string" && value ? value : null;
}

/**
 * The one cost rule for a model call, shared by the run header, the run list
 * and the overview: a captured reported cost always wins; an invalid or
 * conflicting one is never replaced by a guess; otherwise the bundled list
 * price estimates it; otherwise the cost is unknown.
 */
export function generationCost(input: GenerationCostInput): SpanCost {
  const values = input.values;
  if (values) {
    const reported = reportedCost(values);
    if (reported.value !== null) return { source: "reported", usd: reported.value };
    if (reported.reasons[0] !== "reported_cost_missing") return { source: null, usd: null, reason: "reported_cost_invalid" };
  }
  const cache = values ? spanCacheUsage(values) : {};
  let estimate: ListPriceEstimate = { kind: "unavailable", reason: "model_unpriced" };
  for (const model of new Set(input.models.filter((value): value is string => !!value))) {
    estimate = estimateListPriceCost({ model, provider: input.provider, inputTokens: input.inputTokens, outputTokens: input.outputTokens, ...cache, at: input.at });
    if (estimate.kind === "estimated" || estimate.reason !== "model_unpriced") break;
  }
  return estimate.kind === "estimated" ? { source: "list-price", usd: estimate.totalUsd, estimate } : { source: null, usd: null, reason: estimate.reason };
}

/**
 * Cost of one stored generation span: the response model is priced first,
 * then gen_ai.request.model (providers report dated snapshots of the requested id).
 */
export function spanCost(span: CostSpan): SpanCost {
  const values = attributeValues(span.attributes);
  return generationCost({ values, models: [span.model, requestModel(values)], provider: span.provider, inputTokens: span.input_tokens, outputTokens: span.output_tokens, at: span.start_time_ms ?? null });
}
