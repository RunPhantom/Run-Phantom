import { describe, expect, test } from "bun:test";
import { compareCapturedRuns, type CapturedComparisonSpan } from "../src/run-comparison";
import { snapshotRun } from "../src/evaluations/snapshot";
import { createEvaluationReport, evaluationReportJUnit } from "../src/evaluations/report";
import type { Experiment } from "../src/evaluations/protocol";
import { captureOtlpEvidence } from "../src/spans/otlp-evidence";
const key = "runphantom.agent.definition";
function root(id = "root", prompt = "original instructions"): CapturedComparisonSpan {
  const raw = JSON.stringify({ version: 1, systemPrompt: prompt, tools: [], model: "fixture", providers: ["local-fixture"], runtime: { temperature: .12345 } });
  const attributes = [{ key, value: { stringValue: raw } }];
  return { id, run_id: "run", parent_span_id: null, name: "agent", span_type: "AGENT_ROOT", status: "OK", input_payload: "same request", output_payload: "unchanged captured answer", model: "fixture", provider: "local-fixture", input_tokens: 2, output_tokens: 3, start_time_ms: 1, end_time_ms: 10, duration_ms: 9,
    attributes: JSON.stringify({ [key]: raw }), otlp_evidence: JSON.stringify(captureOtlpEvidence({ attributes }, {}, {})) };
}
function experiment(): Experiment {
  const snapshot = snapshotRun({ id: "run" }, [root()]);
  return { evaluationVersion: 1, snapshotVersion: 1, id: "experiment", name: "Definition frozen fixture", datasetId: "dataset", datasetName: "Fixture", datasetVersion: 1, datasetHash: "captured-hash", status: "completed", verdict: "pass", createdAt: 1, completedAt: 2, error: null,
    summary: { total: 1, pass: 1, fail: 0, inconclusive: 0, passRate: 1 }, results: [{ caseId: "case", caseName: "Captured case", runId: "run", inputMatch: "match", status: "pass", checks: [{ status: "pass", source: "code", evaluatorVersion: "code:1", score: 1, reason: "Exact output", actual: null, expected: null, spanIds: ["root"], redacted: false, truncated: false }], snapshot,
      case: { id: "case", name: "Captured case", input: "same request", sourceRunId: "run", sourceSpanId: "root", sourceOutput: "unchanged captured answer", tags: [], rules: [{ kind: "output", operation: "equals", value: "unchanged captured answer" }], sourceCapturedAt: 1, sourceRedacted: false, sourceTruncated: false, sourceSnapshotVersion: 1 } }] };
}
describe("captured definition integration preserves existing evidence semantics", () => {
  test("definition-only change appears independently of unchanged action correspondence, input and output", () => {
    const old = root("old"), newer = { ...root("new", "revised instructions"), run_id: "new-run" };
    const report = compareCapturedRuns({ id: "run", name: "run", spans: [old] }, { id: "new-run", name: "new-run", spans: [newer] });
    expect(report.counts).toMatchObject({ paired: 1, unchanged: 1, changed: 0 }); expect(report.rows[0].fields.find(f => f.name === "output_payload")?.state).toBe("same");
    expect(report.agentDefinitions?.baseline?.records[0].complete).toBe(true); expect(report.agentDefinitions?.candidate?.records[0].complete).toBe(true);
    expect(report.agentDefinitions?.baseline?.records[0].sha256).not.toBe(report.agentDefinitions?.candidate?.records[0].sha256);
    expect(report.rows[0].match).toBe("unique sibling key");
  });
  test("snapshot retains definition provenance separately from output completeness and frozen input", () => {
    const captured = snapshotRun({ id: "run" }, [root()]); expect(captured.output.value).toBe("unchanged captured answer"); expect(captured.input).toBe("same request"); expect(captured.complete).toBe(true);
    expect(captured.agentDefinitions?.records[0].complete).toBe(true); expect(captured.agentDefinitions?.records[0].sourceSpanId).toBe("root");
    const changed = snapshotRun({ id: "run" }, [root("root", "new instructions")]); expect(changed.agentDefinitions?.records[0].sha256).not.toBe(captured.agentDefinitions?.records[0].sha256);
    expect(changed.metrics).toEqual(captured.metrics); expect(changed.output).toEqual(captured.output);
  });
  test("report exports frozen safe provenance without recomputing from later capture or exporting private instructions", () => {
    const frozen = experiment(); const report = createEvaluationReport(frozen);
    expect(report.cases[0].agentDefinitions).toBeDefined(); expect(report.cases[0].agentDefinitions).toEqual(frozen.results[0].snapshot.agentDefinitions);
    const before = JSON.stringify(report); snapshotRun({ id: "run" }, [root("root", "later replacement instructions")]);
    expect(JSON.stringify(createEvaluationReport(frozen))).toBe(before); expect(before).not.toContain("original instructions"); expect(before).not.toContain("unchanged captured answer"); expect(report.gate.pass).toBe(true);
  });
  test("JSON and JUnit exports retain validated full frozen hashes but refuse counterfeit metadata or raw extension fields", () => {
    const frozen = experiment(), report = createEvaluationReport(frozen), meta = report.cases[0].agentDefinitions!;
    expect(evaluationReportJUnit(report)).toContain(meta.records[0].sha256!); expect(evaluationReportJUnit(report)).not.toContain("original instructions");
    for (const mutate of [
      (x: any) => { x.records[0].sha256 = "short"; },
      (x: any) => { x.records[0].rawPrompt = "secret unreviewed instructions"; },
      (x: any) => { x.records[0].components.prompt.sha256 = null; },
      (x: any) => { x.records[0].complete = false; },
      (x: any) => { x.observedRecords = 0; },
    ]) {
      const copy = experiment(); mutate(copy.results[0].snapshot.agentDefinitions); expect(() => createEvaluationReport(copy)).toThrow("provenance is invalid");
    }
  });
  test("legacy snapshot absence remains compatible and new partial definition metadata cannot alter machine verdict", () => {
    const frozen = experiment(); delete frozen.results[0].snapshot.agentDefinitions; expect(createEvaluationReport(frozen).gate.pass).toBe(true);
    const plain = { ...root(), otlp_evidence: undefined }; frozen.results[0].snapshot = snapshotRun({ id: "run" }, [plain]);
    expect(frozen.results[0].snapshot.agentDefinitions?.records[0].complete).toBe(false); expect(createEvaluationReport(frozen).gate.pass).toBe(true);
  });
  test("whole oversized receipts stay explicitly unavailable without replacing established output or certifying a version", () => {
    const oversized = { ...root(), otlp_evidence: null, unavailable: { otlpEvidence: true } };
    const frozen = snapshotRun({ id: "run" }, [oversized]); expect(frozen.output.value).toBe("unchanged captured answer");
    expect(frozen.agentDefinitions?.records[0].complete).toBe(false); expect(frozen.agentDefinitions?.records[0].sha256).toBeNull(); expect(frozen.agentDefinitions?.records[0].reasons).toContain("capture_oversized");
  });
});
