import { getDrizzleDb, runInTransaction } from "../db";
import { buildCostAnalyticsReport, type CostAnalyticsReport } from "../team/pricing";
import { ANALYTICS_LIMITS, CostAnalyticsError, parseCostAnalyticsRequest, type AnalyticsSpan } from "./analytics";

/** Every selected run supplies full ancestry, including parents outside the time window. */
export function getLocalCostAnalytics(input: unknown): CostAnalyticsReport {
  const request = parseCostAnalyticsRequest(input);
  return runInTransaction(() => {
    const db = getDrizzleDb().$client;
    const selection = `run_id IN (SELECT DISTINCT run_id FROM spans WHERE span_type='LLM_GENERATION' AND ((start_time_ms>=? AND start_time_ms<?) OR start_time_ms IS NULL OR start_time_ms<0 OR start_time_ms>8640000000000000))`;
    const projectionBytes = ["'local'", "run_id", "id", "parent_span_id", "span_type", "model", "provider", "attributes"].map(field => `length(CAST(COALESCE(${field},'') AS BLOB))`).join("+");
    const size = db.query(`SELECT COUNT(*) AS n,COALESCE(SUM(length(CAST(COALESCE(attributes,'') AS BLOB))),0) AS bytes,COALESCE(SUM(${projectionBytes}),0) AS projectionBytes FROM spans WHERE ${selection}`).get(request.from, request.to) as { n: number; bytes: number; projectionBytes: number };
    if (!Number.isSafeInteger(size.n) || !Number.isSafeInteger(size.bytes) || !Number.isSafeInteger(size.projectionBytes) || size.n > ANALYTICS_LIMITS.spans || size.bytes > ANALYTICS_LIMITS.attributeBytes || size.projectionBytes > ANALYTICS_LIMITS.projectionBytes) throw new CostAnalyticsError("too_large", "Cost analytics exceeds a complete-population limit; select a smaller window");
    const spans = db.query(`SELECT 'local' AS projectId,run_id AS runId,id,parent_span_id AS parentSpanId,span_type AS kind,start_time_ms AS startedAt,model,provider,input_tokens AS inputTokens,output_tokens AS outputTokens,attributes FROM spans WHERE ${selection} ORDER BY run_id,id`).all(request.from, request.to) as AnalyticsSpan[];
    return buildCostAnalyticsReport({ kind: "local", projectId: "local" }, spans, request, Date.now());
  });
}
