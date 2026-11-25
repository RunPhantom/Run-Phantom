import { hasDuplicateJsonKeys } from "../json-keys";
import { parseJsonEvidence } from "../evaluations/json-evidence";
import { reportedCost } from "./analytics";
import { estimateCallListPrice, requestModel, type CallListPriceInput, type ListPriceEstimate } from "./list-prices";

export { requestModel };

export interface CostSpan {
  readonly model: string | null;
  readonly provider: string | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly attributes: string | null;
  readonly start_time_ms?: number | null;
}

export type SpanCostUnavailableReason = "reported_cost_invalid" | "model_unpriced" | "provider_unresolved" | "usage_unavailable" | "cache_usage_ambiguous" | "estimate_failed";

export type SpanCost =
  | { readonly source: "reported"; readonly usd: number }
  | { readonly source: "list-price"; readonly usd: number; readonly estimate: Extract<ListPriceEstimate, { kind: "estimated" }> }
  | { readonly source: null; readonly usd: null; readonly reason: SpanCostUnavailableReason };

/** values null means the attributes could not be read, so no reported cost is known. */
export type GenerationCostInput = CallListPriceInput;

function attributeValues(attributes: string | null): Record<string, unknown> | null {
  if (attributes === null) return {};
  try {
    if (attributes.length > 64 * 1024 || hasDuplicateJsonKeys(attributes)) return null;
    const value = parseJsonEvidence(attributes);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
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
  const estimate = estimateCallListPrice(input);
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
