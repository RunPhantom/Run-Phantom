import { describe, expect, test } from "bun:test";
import { compareFindingBatches, findingPairDigest } from "../src/evaluations/finding-diff";
import { FINDING_POLICY, type FindingExecution, type FindingMapping } from "../src/evaluations/finding-protocol";

import { parseFindingBatch } from "../src/evaluations/finding-validation";

function producer(count = 1, status: FindingExecution = "completed") {
  return { format: "runphantom-findings/v1", repositoryId: "fixture-repository", sourceSnapshot: "original-commit",
    checker: { id: "fixture-checker", version: "1.0.0", rulesSha256: "a".repeat(64), configurationSha256: "b".repeat(64) }, declaredScope: ["src/a.ts"],
    reportedExecution: { status, files: [{ path: "src/a.ts", status }] }, findings: Array.from({ length: status === "not_run" ? 0 : count }, (_, index) => ({ id: `finding-${index}`, path: "src/a.ts", ruleId: "R1", message: "unexpected retry(2)", severity: "error", startLine: 10, endLine: 10 })) };
}
const batch = (count = 1, status: FindingExecution = "completed") => parseFindingBatch(producer(count, status), true);
describe("exact producer finding multisets", () => {
  test("duplicates keep separate IDs and obey count symmetry", () => {
    const forward = compareFindingBatches(batch(1), batch(2));
    expect(forward.counts).toEqual({ retained: 1, introduced: 1, removed: 0, unresolved: 0 });
    expect(forward.occurrences).toHaveLength(2);
    expect(compareFindingBatches(batch(2), batch(1)).counts).toEqual({ retained: 1, introduced: 0, removed: 1, unresolved: 0 });
    expect(forward.authentication).toBe("not_authenticated"); expect(forward.interpretation).toBe("conditional");
  });
  test("line movement retains identity while exact numbers, whitespace, rule and file stay material", () => {
    const a = batch(), b = batch(); b.sourceSnapshot = "candidate-commit"; b.findings[0].startLine = 23; b.findings[0].endLine = 24;
    expect(compareFindingBatches(a, b).occurrences[0]).toMatchObject({ classification: "retained", locationChanged: true });
    for (const message of ["unexpected retry(3)", "unexpected  retry(2)", "Unexpected retry(2)", "unexpected retry(2)\u00a0"]) {
      b.findings[0].message = message; expect(compareFindingBatches(a, b).counts).toMatchObject({ retained: 0, introduced: 1, removed: 1 });
    }
    b.findings[0].message = a.findings[0].message; b.findings[0].ruleId = "R2";
    expect(compareFindingBatches(a, b).counts.retained).toBe(0);
    b.findings[0].ruleId = "R1"; b.findings[0].path = "other/a.ts"; b.declaredScope = ["other/a.ts"]; b.reportedExecution.files[0].path = "other/a.ts";
    expect(compareFindingBatches(a, b).counts.introduced).toBeNull();
    b.repositoryId = "other-repository"; expect(compareFindingBatches(a, b).counts.retained).toBeNull();
  });
  test("equal severity is retained first and changed severity is explicit", () => {
    const a = batch(2), b = batch(1); a.findings[0].severity = "warning";
    const result = compareFindingBatches(a, b);
    expect(result.occurrences.find(item => item.classification === "retained")).toMatchObject({ baselineId: "finding-1", severityChanged: false });
    b.findings[0].severity = "info"; expect(compareFindingBatches(batch(), b).occurrences[0].severityChanged).toBe(true);
  });
  for (const left of ["completed", "partial", "not_run"] as const) for (const right of ["completed", "partial", "not_run"] as const) test(`reported coverage ${left}/${right} stays conditional or unknown`, () => {
    const result = compareFindingBatches(batch(1, left), batch(1, right));
    if (left === "completed" && right === "completed") expect(result.counts.retained).toBe(1);
    else { expect(result.counts.retained).toBeNull(); expect(result.counts.introduced).toBeNull(); expect(result.counts.removed).toBeNull(); expect(result.interpretation).toBe("unavailable"); }
  });
  test("complete empty differs from not-run empty and producer totals cannot fabricate observations", () => {
    expect(compareFindingBatches(batch(0), batch(0)).counts).toEqual({ retained: 0, introduced: 0, removed: 0, unresolved: 0 });
    expect(compareFindingBatches(batch(0), batch(0, "not_run")).counts.retained).toBeNull();
    expect(() => parseFindingBatch({ ...producer(), totals: { passed: 100 } }, true)).toThrow();
  });
  test("redaction blocks identity even when both credential-bearing messages scrub equally", () => {
    const raw = producer(); raw.findings[0].message = "Authorization: Bearer fixture-token-for-test";
    const a = parseFindingBatch(raw, true); expect(a.findings[0].identityAvailable).toBe(false);
    expect(JSON.stringify(a)).not.toContain("fixture-token-for-test"); expect(compareFindingBatches(a, a).counts.retained).toBeNull();
    a.findings[0].identityAvailable = true; expect(() => parseFindingBatch(a)).toThrow();
  });
  test("reviewed rename requires exact pair, no changed snapshot or path collisions", () => {
    const a = batch(), b = batch(); b.sourceSnapshot = "candidate-commit"; b.declaredScope = ["src/renamed.ts"]; b.reportedExecution.files[0].path = b.declaredScope[0]; b.findings[0].path = b.declaredScope[0];
    expect(compareFindingBatches(a, b).counts.retained).toBeNull();
    const mapping: FindingMapping = { id: "reviewed", actor: "local_operator", policy: FINDING_POLICY, reviewed: true, baseline: { setId: "a", revision: 1, sourceId: "one" }, candidate: { setId: "b", revision: 1, sourceId: "two" }, pairDigest: findingPairDigest(a, b), paths: [{ baseline: "src/a.ts", candidate: "src/renamed.ts" }], reason: "Operator reviewed an exact rename", createdAt: 1 };
    expect(compareFindingBatches(a, b, mapping).counts.retained).toBe(1);
    b.sourceSnapshot = "later-commit"; expect(() => compareFindingBatches(a, b, mapping)).toThrow();
  });
  test("checker version/rules/config mismatch stays unknown without explicit reviewed mapping", () => {
    for (const key of ["id", "version", "rulesSha256", "configurationSha256"] as const) {
      const a = batch(), b = batch(); b.checker[key] = key.endsWith("Sha256") ? "c".repeat(64) : "other";
      expect(compareFindingBatches(a, b).counts.retained).toBeNull();
    }
  });
  test("closed schemas refuse unsafe locations, paths, duplicate IDs, claims and accessors", () => {
    const mutations: ((raw: ReturnType<typeof producer>) => void)[] = [raw => { raw.findings[0].startLine = Number.MAX_SAFE_INTEGER + 1; }, raw => { raw.findings[0].endLine = 1; }, raw => { raw.findings.push(raw.findings[0]); }, raw => { raw.declaredScope.push(raw.declaredScope[0]); }, raw => { raw.findings[0].path = "../a.ts"; }, raw => { Object.defineProperty(raw.findings[0], "message", { get() { throw Error("getter invoked"); }, enumerable: true }); }];
    for (const mutation of mutations) { const raw = producer(); mutation(raw); expect(() => parseFindingBatch(raw, true)).toThrow(); }
    expect(() => parseFindingBatch({ ...producer(), reviewed: true }, true)).toThrow();
  });
});
