import { createHash } from "node:crypto";
import { computeScoreAggregates } from "./aggregation";
import { DISTRIBUTION_FORMAT, DISTRIBUTION_UNITS, type DistributionRequest, type ScoreDistributionAnalysis } from "./aggregation-protocol";
import { EVALUATION_LIMITS as L, EVALUATION_VERSION, SNAPSHOT_VERSION, type Experiment } from "./protocol";
import { canonicalCaseDefinitions, EvaluationError, fields, object, parseId, parseRule } from "./validation";
import { MAX_REPORT_BYTES } from "./report";

function closed(value: unknown, keys: string[]) {
  const record = object(value); fields(record, keys);
  if (Reflect.ownKeys(record).some(key => !keys.includes(String(key)))) throw new EvaluationError("Analysis contains an unsupported field");
  return record;
}
export function parseDistributionIds(value: unknown): string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1) throw new EvaluationError("Select at least one experiment");
  if (value.length > 20) throw new EvaluationError("Select at most 20 experiments", 413);
  if (Reflect.ownKeys(value).some(key => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) throw new EvaluationError("Experiment selection requires an ordinary array");
  const ids = Array.from({ length: value.length }, (_, i) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !("value" in descriptor)) throw new EvaluationError("Experiment selection cannot contain accessors or holes");
    return parseId(descriptor.value);
  });
  if (new Set(ids).size !== ids.length) throw new EvaluationError("Select each experiment only once");
  return ids;
}
export function parseDistributionRequest(body: unknown): DistributionRequest {
  const value = closed(body, ["experimentIds", "selector", "direction", "bins"]);
  const experimentIds = parseDistributionIds(value.experimentIds);
  if (typeof value.direction !== "string" || !["higher", "lower", "none"].includes(value.direction)) throw new EvaluationError("Choose higher, lower or no preference");
  if (typeof value.bins !== "number" || !Number.isInteger(value.bins) || value.bins < 1 || value.bins > 20) throw new EvaluationError("Select 1 to 20 histogram bins");
  const selector = object(value.selector);
  let selected: DistributionRequest["selector"];
  if (selector.kind === "check_score") {
    closed(selector, ["kind", "caseId", "ruleIndex"]);
    if (typeof selector.ruleIndex !== "number" || !Number.isInteger(selector.ruleIndex) || selector.ruleIndex < 0 || selector.ruleIndex >= L.MAX_RULES) throw new EvaluationError("Choose one rule index from 0 to 7");
    selected = { kind: "check_score", caseId: parseId(selector.caseId), ruleIndex: selector.ruleIndex };
  } else if (selector.kind === "snapshot_metric") {
    closed(selector, ["kind", "metric"]);
    if (typeof selector.metric !== "string" || !Object.hasOwn(DISTRIBUTION_UNITS, selector.metric)) throw new EvaluationError("Choose one supported captured metric");
    selected = { kind: "snapshot_metric", metric: selector.metric as keyof typeof DISTRIBUTION_UNITS };
  } else throw new EvaluationError("Choose a check score or captured metric");
  return { experimentIds, selector: selected, direction: value.direction as DistributionRequest["direction"], bins: value.bins };
}

function timestamp(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function definition(experiment: Experiment): string {
  try {
    object(experiment);
    parseId(experiment.id); parseId(experiment.datasetId);
    object(experiment.summary);
    if (experiment.status !== "completed" && experiment.status !== "cancelled") throw new Error();
    if (experiment.verdict !== null && !["pass", "fail", "inconclusive"].includes(experiment.verdict)) throw new Error();
    if (experiment.evaluationVersion !== EVALUATION_VERSION || experiment.snapshotVersion !== SNAPSHOT_VERSION || !Number.isSafeInteger(experiment.datasetVersion) || experiment.datasetVersion < 1) throw new Error();
    if (!Array.isArray(experiment.results) || !experiment.results.length || experiment.results.length > L.MAX_CASES || experiment.summary.total !== experiment.results.length) throw new Error();
    const ids = new Set<string>();
    for (const result of experiment.results) {
      object(result); object(result.case); object(result.snapshot);
      parseId(result.caseId); parseId(result.runId);
      if (ids.has(result.caseId) || result.case.id !== result.caseId || result.snapshot.runId !== result.runId || result.snapshot.version !== experiment.snapshotVersion) throw new Error();
      ids.add(result.caseId);
      if (!Array.isArray(result.case.rules) || !result.case.rules.length || result.case.rules.length > L.MAX_RULES || !Array.isArray(result.checks) || result.checks.length !== result.case.rules.length) throw new Error();
      for (const [i, check] of result.checks.entries()) {
        object(check); parseRule(result.case.rules[i]);
        if (typeof check.evaluatorVersion !== "string" || !check.evaluatorVersion.length || check.evaluatorVersion.length > 64 || check.source !== (result.case.rules[i].kind === "rubric" ? "llm" : "code")) throw new Error();
      }
    }
    const frozen = canonicalCaseDefinitions(experiment.results.map(result => result.case));
    if (createHash("sha256").update(frozen).digest("hex") !== experiment.datasetHash) throw new Error();
    return JSON.stringify([experiment.datasetId, experiment.datasetVersion, experiment.datasetHash, experiment.evaluationVersion, experiment.snapshotVersion,
      experiment.results.map(result => [result.caseId, result.checks.map(check => [check.source, check.evaluatorVersion])]).sort((a, b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0)]);
  } catch { throw new EvaluationError("Selected experiments require complete identical frozen case definitions and supported versions", 409); }
}
function observations(experiment: Experiment, request: DistributionRequest): unknown[] {
  const selector = request.selector;
  if (selector.kind === "check_score") {
    const result = experiment.results.find(item => item.caseId === selector.caseId);
    if (!result || !result.checks[selector.ruleIndex]) throw new EvaluationError("Selected check is absent from this frozen population", 409);
    const check = result.checks[selector.ruleIndex], score = check.score;
    return [typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 1 && !check.redacted && !check.truncated ? score : null];
  }
  return experiment.results.map(result => {
    const value = result.snapshot.metrics?.[selector.metric];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    return ["inputTokens", "outputTokens", "totalTokens", "toolCalls"].includes(selector.metric) && !Number.isSafeInteger(value) ? null : value;
  });
}

/** Read only admitted whole frozen rows; no paginated summary or raw sample projection. */
export function analyzeScoreDistribution(body: DistributionRequest, read: (ids: string[], consume: (experiment: Experiment) => void) => void): ScoreDistributionAnalysis {
  const request = parseDistributionRequest(body);
  let expected: string | undefined;
  let dataset: ScoreDistributionAnalysis["dataset"] | undefined;
  const seen = new Set<string>(), values: unknown[] = [];
  const experiments: ScoreDistributionAnalysis["experiments"] = [];
  read(request.experimentIds, experiment => {
    const identity = definition(experiment);
    if (!request.experimentIds.includes(experiment.id) || seen.has(experiment.id)) throw new EvaluationError("Frozen selection is inconsistent", 409);
    seen.add(experiment.id);
    if (expected !== undefined && identity !== expected) throw new EvaluationError("Selected experiments require identical dataset revisions, case membership and evaluator versions", 409);
    expected = identity; dataset ??= { id: experiment.datasetId, version: experiment.datasetVersion };
    const population = observations(experiment, request); values.push(...population);
    experiments.push({ experimentId: experiment.id, status: experiment.status as "completed" | "cancelled", verdict: experiment.verdict,
      createdAt: timestamp(experiment.createdAt), completedAt: timestamp(experiment.completedAt), stats: computeScoreAggregates(population, request.bins) });
  });
  if (!dataset || seen.size !== request.experimentIds.length) throw new EvaluationError("Experiment not found", 404);
  experiments.sort((a, b) => request.experimentIds.indexOf(a.experimentId) - request.experimentIds.indexOf(b.experimentId));
  const trend: ScoreDistributionAnalysis["trend"] = experiments.slice(1).map((item, i) => {
    const previous = experiments[i], a = previous.stats.mean, b = item.stats.mean;
    const delta = a === null || b === null ? null : b - a;
    const change = a === null || b === null ? "unavailable" : b > a ? "higher" : b < a ? "lower" : "unchanged";
    return { from: previous.experimentId, to: item.experimentId, delta: delta !== null && Number.isFinite(delta) ? delta : null,
      deltaUnavailable: delta === null ? "empty" : Number.isFinite(delta) ? null : "overflow", change,
      preference: request.direction === "none" || change === "unavailable" ? null : change === "unchanged" ? "unchanged" : change === request.direction ? "improved" : "regressed" };
  });
  const analysis: ScoreDistributionAnalysis = { format: DISTRIBUTION_FORMAT, selection: request, dataset, evaluationVersion: EVALUATION_VERSION, snapshotVersion: SNAPSHOT_VERSION,
    unit: request.selector.kind === "check_score" ? "score" : DISTRIBUTION_UNITS[request.selector.metric], overall: computeScoreAggregates(values, request.bins), experiments, trend,
    limitations: ["Only explicitly selected frozen experiments are included, in selection order; this order does not establish chronology or independent sampling.",
      "Check scores share the selected case and rule meaning. Model scores remain advisory, not measured execution proof. Numeric preferences never change machine verdicts or quality gates.",
      "Excluded observations include unavailable, withheld, invalid or out-of-scale evidence. Captured metrics retain known numeric values independently of raw payload availability.",
      "No agents or evaluators are rerun. Floating-point resolution can reduce the requested histogram bin count."] };
  if (Buffer.byteLength(JSON.stringify(analysis), "utf8") > MAX_REPORT_BYTES) throw new EvaluationError("Score distribution exceeds 1 MiB", 413);
  return analysis;
}
