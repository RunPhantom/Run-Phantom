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

export type SpanCost =
  | { readonly source: "reported"; readonly usd: number }
  | { readonly source: "list-price"; readonly usd: number; readonly estimate: Extract<ListPriceEstimate, { kind: "estimated" }> }
  | { readonly source: null; readonly usd: null; readonly reason: "reported_cost_invalid" | "model_unpriced" | "usage_unavailable" | "cache_usage_ambiguous" | "estimate_failed" };

function attributeValues(attributes: string | null): Record<string, unknown> | null {
  if (attributes === null) return {};
  try {
    if (attributes.length > 64 * 1024 || hasDuplicateJsonKeys(attributes)) return null;
    const value = parseJsonEvidence(attributes);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/**
 * Cost of one generation span: a captured reported cost always wins; otherwise
 * the bundled list-price estimate, tried on the response model and then on
 * gen_ai.request.model (providers report dated snapshots of the requested id).
 */
export function spanCost(span: CostSpan): SpanCost {
  const values = attributeValues(span.attributes);
  if (values) {
    const reported = reportedCost(values);
    if (reported.value !== null) return { source: "reported", usd: reported.value };
    if (reported.reasons[0] !== "reported_cost_missing") return { source: null, usd: null, reason: "reported_cost_invalid" };
  }
  const cache = values ? spanCacheUsage(values) : {};
  const requestModel = typeof values?.["gen_ai.request.model"] === "string" ? values["gen_ai.request.model"] as string : null;
  let estimate: ListPriceEstimate = { kind: "unavailable", reason: "model_unpriced" };
  for (const model of new Set([span.model, requestModel].filter((value): value is string => !!value))) {
    estimate = estimateListPriceCost({ model, provider: span.provider, inputTokens: span.input_tokens, outputTokens: span.output_tokens, ...cache, at: span.start_time_ms ?? null });
    if (estimate.kind === "estimated" || estimate.reason !== "model_unpriced") break;
  }
  return estimate.kind === "estimated" ? { source: "list-price", usd: estimate.totalUsd, estimate } : { source: null, usd: null, reason: estimate.reason };
}
