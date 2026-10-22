import type { CostAnalyticsReport, CostAnalyticsRequest } from "../../../src/pricing/analytics";
import { apiJson, jsonInit } from "./request";

export function getLocalPricingAnalytics(request: CostAnalyticsRequest, signal?: AbortSignal): Promise<CostAnalyticsReport> {
  return apiJson<CostAnalyticsReport>("/api/pricing/analytics", jsonInit("POST", request, { signal, cache: "no-store" }));
}
