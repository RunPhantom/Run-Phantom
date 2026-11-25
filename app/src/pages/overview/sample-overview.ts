import type { Overview } from "../../api/overview";

const HOUR = 3_600_000;
const RUNS = [3, 4, 6, 6, 7, 7, 8, 6, 7, 6, 6, 4, 5, 4, 4, 4, 5, 4, 5, 7, 7, 7, 6, 7, 5];
const FAILED = [0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 1, 1, 0, 1];

/**
 * Illustrative numbers for the empty-state ghost only. The ghost is labelled as a
 * sample, hidden from assistive tech and never links anywhere.
 */
export function sampleOverview(now: number): Overview {
  const from = now - 24 * HOUR;
  const first = Math.floor(from / HOUR) * HOUR;
  const timeseries = RUNS.map((runs, index) => ({
    start: first + index * HOUR,
    end: first + (index + 1) * HOUR,
    partial: index === 0 || index === RUNS.length - 1,
    runs,
    failed: FAILED[index],
    completedWithErrors: index % 5 === 2 ? 1 : 0,
    inputTokens: runs * 21_000,
    outputTokens: runs * 3_400,
    tokenUnknownCalls: 0,
    costUsd: runs * 0.052,
    costUnknownCalls: 0,
    durationP95Ms: 9_000 + (index % 6) * 1_400,
  }));
  const group = (runs: number, failed: number) => ({
    runs, failed, completedWithErrors: 1, failureRate: failed / runs, inputTokens: runs * 20_000, outputTokens: runs * 3_000,
    tokenUnknownCalls: 0, costUsd: runs * 0.05, costKnownCalls: runs * 3, costUnknownCalls: 0,
  });
  return {
    version: "runphantom-overview/1",
    asOf: now,
    window: { selection: "24h", from, to: now, previousFrom: from - 24 * HOUR, previousTo: from, bucketMs: HOUR, tzOffsetMinutes: 0, field: "startedAt" },
    filters: { agent: null, model: null },
    pricing: { estimateMode: "list-prices", rateCount: 0, revision: "sample", asOf: new Date(now).toISOString().slice(0, 10) },
    kpis: {
      runs: { value: 136, previous: 115 },
      running: { value: 3, previous: 0 },
      completed: { value: 117, previous: 101 },
      completedWithErrors: { value: 7, previous: 6 },
      failed: { value: 9, previous: 8 },
      failureRate: { value: 0.068, previous: 0.07 },
      errorRate: { value: 0.12, previous: 0.122 },
      durationP50Ms: { value: 5_200, previous: 5_600, knownRuns: 133 },
      durationP95Ms: { value: 14_200, previous: 15_500, knownRuns: 133 },
      inputTokens: { value: 2_900_000, previous: 2_400_000, knownCalls: 412, unknownCalls: 0 },
      outputTokens: { value: 480_000, previous: 380_000, knownCalls: 412, unknownCalls: 0 },
      costUsd: { value: 7.45, previous: 6.25, knownCalls: 412, unknownCalls: 0, reportedCalls: 0, estimatedCalls: 412, previousUnknownCalls: 0 },
      activeAgents: { value: 5, previous: 5 },
    },
    timeseries,
    byAgent: [
      { agent: "code_review_agent", ...group(41, 4), durationP50Ms: 6_100, durationP95Ms: 15_900 },
      { agent: "research_agent", ...group(37, 1), durationP50Ms: 7_400, durationP95Ms: 18_400 },
      { agent: "triage_agent", ...group(29, 0), durationP50Ms: 4_100, durationP95Ms: 7_800 },
      { agent: "support_bot", ...group(14, 1), durationP50Ms: 2_100, durationP95Ms: 30_100 },
      { agent: "planner", ...group(7, 0), durationP50Ms: 1_600, durationP95Ms: 3_200 },
    ],
    byModel: [
      { model: "claude-sonnet-5-5", provider: "anthropic", ...group(80, 3), calls: 212, callP50Ms: 1_900, callP95Ms: 6_100, durationP50Ms: 6_000, durationP95Ms: 15_000 },
      { model: "gpt-5-mini", provider: "openai", ...group(51, 1), calls: 128, callP50Ms: 1_200, callP95Ms: 3_900, durationP50Ms: 4_000, durationP95Ms: 9_000 },
      { model: "gemini-3.8-flash", provider: "gcp.gemini", ...group(30, 0), calls: 72, callP50Ms: 900, callP95Ms: 2_400, durationP50Ms: 3_000, durationP95Ms: 7_000 },
    ],
    topFailingTools: [
      { tool: "run_tests", failures: 5, calls: 41, failedRuns: 5, lastError: { message: "exit code 1", runId: "sample", spanId: "sample", at: now - 12_000 } },
      { tool: "fetch_url", failures: 2, calls: 88, failedRuns: 2, lastError: { message: "403 Forbidden", runId: "sample", spanId: "sample", at: now - 1_260_000 } },
    ],
    recentFailures: [
      { runId: "sample-1", name: "code_review_agent", agent: "code_review_agent", status: "failed", startedAt: now - 12_000, errorCount: 1, error: { spanId: "s", step: "run_tests", message: "exit code 1" } },
      { runId: "sample-2", name: "support_bot", agent: "support_bot", status: "failed", startedAt: now - 360_000, errorCount: 1, error: { spanId: "s", step: "chat", message: "Model call timed out after 30s" } },
      { runId: "sample-3", name: "research_agent", agent: "research_agent", status: "completed_with_errors", startedAt: now - 1_260_000, errorCount: 1, error: { spanId: "s", step: "fetch_url", message: "403 Forbidden" } },
      { runId: "sample-4", name: "code_review_agent", agent: "code_review_agent", status: "failed", startedAt: now - 2_040_000, errorCount: 1, error: { spanId: "s", step: "run_tests", message: "exit code 1" } },
    ],
    liveRuns: [],
    truncated: { byAgent: false, byModel: false },
  };
}
