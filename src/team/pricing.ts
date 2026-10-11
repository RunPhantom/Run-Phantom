import { createHash } from "node:crypto";
import { aggregateCostAnalytics, assertCostAnalyticsProjection, CostAnalyticsError, type AnalyticsSpan, type CostAnalyticsReport, type CostAnalyticsRequest } from "../pricing/analytics";
import { hasDuplicateJsonKeys } from "../json-keys";
import { parseJsonEvidence } from "../evaluations/json-evidence";
import { redactTeamText } from "./ingest";

export type { CostAnalyticsReport } from "../pricing/analytics";
const IDENTITY_KEYS = ["gen_ai.response.model", "ai.response.model", "llm.response.model_name", "gen_ai.request.model", "ai.model.id", "llm.request.model", "llm.model_name", "gen_ai.provider.name", "gen_ai.system", "ai.model.provider"];
function safeIdentity(value: string | null): string | null { return value !== null && redactTeamText(value) === value ? value : null; }
function safeProjection(span: AnalyticsSpan): AnalyticsSpan {
  let attributes = span.attributes;
  try {
    if (attributes !== null) {
      if (hasDuplicateJsonKeys(attributes)) return { ...span, model: safeIdentity(span.model), provider: safeIdentity(span.provider) };
      const values = parseJsonEvidence(attributes) as Record<string, unknown>;
      if (values && typeof values === "object" && !Array.isArray(values)) {
        for (const key of IDENTITY_KEYS) if (typeof values[key] === "string" && safeIdentity(values[key] as string) === null) values[key] = null;
        // Keep the original strict parser responsible for duplicate-key rejection.
        if (IDENTITY_KEYS.some(key => values[key] === null)) attributes = JSON.stringify(values);
      }
    }
  } catch { /* Malformed capture is refused by the pure normalizer. */ }
  return { ...span, attributes, model: safeIdentity(span.model), provider: safeIdentity(span.provider) };
}

/** Called only after the owning store acquires the complete projection under current authority. */
export function buildCostAnalyticsReport(scope: CostAnalyticsReport["scope"], spans: readonly AnalyticsSpan[], request: CostAnalyticsRequest, asOf: number): CostAnalyticsReport {
  assertCostAnalyticsProjection(spans);
  if (!Number.isSafeInteger(asOf) || asOf < 0 || spans.some(span => span.projectId !== scope.projectId)) throw new CostAnalyticsError("invalid_request", "Invalid cost analytics acquisition");
  if (redactTeamText(JSON.stringify(request.rates)) !== JSON.stringify(request.rates)) throw new CostAnalyticsError("invalid_request", "Invalid cost analytics rates");
  const sourceRevision = "sha256:" + createHash("sha256").update(JSON.stringify({ version: "runphantom-cost-source/1", scope, request, spans })).digest("hex");
  const result = aggregateCostAnalytics(spans.map(safeProjection), request);
  return Object.freeze({ ...result, asOf, scope: Object.freeze({ ...scope }), sourceRevision, rateAuthority: "request-declared" });
}
