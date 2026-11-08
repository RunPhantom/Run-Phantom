import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb } from "../src/db";
import { evaluateRubric } from "../src/evaluations/judge";
import { boundJudgeUsage, summarizeJudgeSpend } from "../src/evaluations/judge-usage";
import { boundRuleResult } from "../src/evaluations/rules";
import { insertExperiment, judgeSpendTotals, listExperiments } from "../src/evaluations/store";
import { EVALUATION_VERSION, SNAPSHOT_VERSION, type CaseResult, type Experiment, type RubricRule, type RuleResult, type Snapshot } from "../src/evaluations/protocol";
import { RUNPHANTOM_SECRET_STORE_PATH_ENV } from "../src/secret-store";

const envNames = ["OPENAI_API_KEY", "RUNPHANTOM_OPENAI_API_KEY", "ANTHROPIC_API_KEY", "RUNPHANTOM_DB_PATH", RUNPHANTOM_SECRET_STORE_PATH_ENV];
const originals = new Map<string, string | undefined>();
let root: string;
beforeEach(() => {
  for (const name of envNames) { originals.set(name, process.env[name]); delete process.env[name]; }
  root = mkdtempSync(path.join(realpathSync(os.tmpdir()), "runphantom-judge-usage-"));
  process.env[RUNPHANTOM_SECRET_STORE_PATH_ENV] = path.join(root, "secrets.json");
  process.env.RUNPHANTOM_DB_PATH = path.join(root, "evaluations.db");
  process.env.OPENAI_API_KEY = "synthetic-judge-usage-key";
  process.env.ANTHROPIC_API_KEY = "synthetic-judge-usage-key";
  closeDb();
});
afterEach(() => {
  closeDb();
  for (const [name, value] of originals) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  originals.clear(); rmSync(root, { recursive: true, force: true });
});

const rule = (provider: "openai" | "anthropic", model: string): RubricRule => ({ kind: "rubric", provider, model, rubric: "The answer must be correct.", threshold: 0.5 });
const snapshot = (): Snapshot => ({ version: 1, runId: "judge-run", runName: "Arithmetic", capturedAt: 1000, complete: true, warnings: [],
  input: "What is 2 + 2?", output: { value: "4", spanId: "answer-span", source: "selected", complete: true }, tools: [], toolsComplete: true,
  metrics: { inputTokens: 1, outputTokens: 1, totalTokens: 2, durationMs: 1, costUsd: null, toolCalls: 0, errorSpans: 0 }, models: [], redacted: false, truncated: false });
const judgment = JSON.stringify({ score: 0.9, reason: "Correct." });
const judge = (value: RubricRule, body: unknown, status = 200) => evaluateRubric(value, snapshot(), snapshot().input,
  { fetch: (() => Promise.resolve(Response.json(body, { status }))) as unknown as typeof fetch });
const openai = (usage?: unknown, model = "gpt-6.1-terra") => ({ model, service_tier: "default", choices: [{ message: { role: "assistant", content: judgment }, finish_reason: "stop" }], ...(usage === undefined ? {} : { usage }) });
const anthropic = (usage?: unknown) => ({ type: "message", model: "claude-sonnet-5-5", content: [{ type: "text", text: judgment }], stop_reason: "end_turn", ...(usage === undefined ? {} : { usage }) });

describe("model judge usage and cost", () => {
  test("OpenAI usage with cached and reasoning tokens is priced with the frozen gpt-6.1-terra rate", async () => {
    const result = await judge(rule("openai", "gpt-6.1-terra"), openai({ prompt_tokens: 86, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 9 } }));
    expect(result.status).toBe("pass");
    expect(result.usage).toMatchObject({ provider: "openai", model: "gpt-6.1-terra", responseModel: "gpt-6.1-terra", inputTokens: 86, outputTokens: 40, cacheReadTokens: 20, reasoningTokens: 9, costUnavailableReason: null });
    // 66 uncached input x $1/M + 20 cached x $0.05/M + 40 output (reasoning included) x $5/M.
    expect(result.usage!.costUsd).toBeCloseTo((66 * 1 + 20 * 0.05 + 40 * 5) / 1e6, 12);
    expect(result.usage!.rateRevision).toContain("gpt-6.1-terra");
  });

  test("Anthropic usage with cache reads is priced with the frozen claude-sonnet-5-5 rate", async () => {
    const result = await judge(rule("anthropic", "claude-sonnet-5-5"), anthropic({ input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, service_tier: "standard", inference_geo: "global" }));
    expect(result.usage).toMatchObject({ provider: "anthropic", inputTokens: 100, outputTokens: 30, cacheReadTokens: 10, cacheWriteTokens: 0, reasoningTokens: null });
    expect(result.usage!.costUsd).toBeCloseTo((100 * 2 + 10 * 0.1 + 30 * 10) / 1e6, 12);
  });

  test("missing usage, unpriced models and failed requests are unavailable, never $0", async () => {
    const missing = await judge(rule("openai", "gpt-6.1-terra"), openai());
    expect(missing.status).toBe("pass"); expect(missing.usage).toMatchObject({ inputTokens: null, outputTokens: null, costUsd: null, costUnavailableReason: "Provider reported no usage" });
    const unpriced = await judge(rule("openai", "gpt-4.1-mini"), openai({ prompt_tokens: 50, completion_tokens: 5 }));
    expect(unpriced.usage).toMatchObject({ inputTokens: 50, outputTokens: 5, costUsd: null, costUnavailableReason: "No frozen rate for this judge model" });
    const unknownSnapshot = await judge(rule("openai", "gpt-6.1-terra"), openai({ prompt_tokens: 50, completion_tokens: 5 }, "gpt-6.1-terra-2099-01-01"));
    expect(unknownSnapshot.usage).toMatchObject({ inputTokens: 50, outputTokens: 5, costUsd: null, costUnavailableReason: "rate_identity_mismatch" });
    const failed = await judge(rule("anthropic", "claude-sonnet-5-5"), { type: "error" }, 529);
    expect(failed.status).toBe("inconclusive"); expect(failed.usage).toMatchObject({ costUsd: null, costUnavailableReason: "Provider returned HTTP 529" });
    delete process.env.OPENAI_API_KEY;
    const notCalled = await judge(rule("openai", "gpt-6.1-terra"), openai({ prompt_tokens: 1, completion_tokens: 1 }));
    expect(notCalled.status).toBe("inconclusive"); expect(notCalled).not.toHaveProperty("usage");
  });

  test("bounding keeps exact usage, drops malformed usage and never attaches usage to code checks", async () => {
    const result = await judge(rule("openai", "gpt-6.1-terra"), openai({ prompt_tokens: 10, completion_tokens: 2 }));
    expect(boundRuleResult(result).usage).toEqual(result.usage);
    expect(boundRuleResult({ ...result, usage: { ...result.usage!, costUsd: -1 } }).usage).toBeUndefined();
    expect(boundRuleResult({ ...result, usage: { ...result.usage!, extra: 1 } as never }).usage).toBeUndefined();
    expect(boundRuleResult({ ...result, source: "code" }).usage).toBeUndefined();
    expect(boundJudgeUsage({ ...result.usage!, costUsd: 0.1 })).toBeUndefined();
  });
});

function experiment(id: string, checks: RuleResult[]): Experiment {
  const result = { caseId: "case-1", caseName: "Case", runId: "run-1", inputMatch: "match", status: "pass", checks, snapshot: snapshot(),
    case: { id: "case-1", name: "Case", input: "What is 2 + 2?", sourceRunId: null, sourceSpanId: null, sourceOutput: null, tags: [], rules: [rule("openai", "gpt-6.1-terra")], sourceCapturedAt: null, sourceRedacted: false, sourceTruncated: false, sourceSnapshotVersion: null } } as CaseResult;
  const judgeSpend = summarizeJudgeSpend([result]);
  return { evaluationVersion: EVALUATION_VERSION, snapshotVersion: SNAPSHOT_VERSION, id, name: id, datasetId: "dataset", datasetName: "Dataset", datasetVersion: 1, datasetHash: "a".repeat(64),
    status: "completed", verdict: "pass", createdAt: Date.now(), completedAt: Date.now(), results: [result],
    summary: { total: 1, pass: 1, fail: 0, inconclusive: 0, passRate: 1, ...(judgeSpend ? { judgeSpend } : {}) }, error: null };
}

describe("experiment judge spend", () => {
  test("summaries sum known usage, keep unavailable calls separate and leave legacy experiments without a total", async () => {
    const priced = await judge(rule("openai", "gpt-6.1-terra"), openai({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } }));
    const unavailable = await judge(rule("openai", "gpt-6.1-terra"), openai());
    const spend = summarizeJudgeSpend(experiment("x", [priced, unavailable]).results)!;
    expect(spend).toMatchObject({ calls: 2, costKnownCalls: 1, costUnavailableCalls: 1, inputTokens: 100, outputTokens: 10, cacheWriteTokens: null });
    expect(spend.costUsd).toBeCloseTo(priced.usage!.costUsd!, 12);
    const legacyCheck = { ...priced }; delete legacyCheck.usage;
    expect(summarizeJudgeSpend(experiment("y", [legacyCheck]).results)).toBeUndefined();

    insertExperiment(experiment("00000000000000000000000000000a01", [priced, unavailable]), "t1");
    insertExperiment(experiment("00000000000000000000000000000a02", [legacyCheck]), "t2");
    expect(listExperiments().map(item => item.summary.judgeSpend?.calls ?? null).sort()).toEqual([2, null]);
    const totals = judgeSpendTotals();
    expect(totals).toMatchObject({ experiments: 2, experimentsWithJudgeCalls: 1, experimentsWithoutUsageRecord: 1, spend: { calls: 2, costKnownCalls: 1, costUnavailableCalls: 1 } });
    expect(totals.spend!.costUsd).toBeCloseTo(priced.usage!.costUsd!, 12);
  });

  test("a profile with no judge usage reports no spend rather than zero", () => {
    expect(judgeSpendTotals()).toEqual({ experiments: 0, experimentsWithJudgeCalls: 0, experimentsWithoutUsageRecord: 0, spend: null });
  });
});
