import { expect, test } from "bun:test";
import { parseExternalEvidence } from "../src/evaluations/external-evidence";
import { EvidenceSupervisor } from "../src/evaluations/evidence-supervisor";
import { parseFindingBatch } from "../src/evaluations/finding-validation";
import { FINDING_DIALECT } from "../src/evaluations/finding-protocol";

function producer(count = 1) {
  return { format: "runphantom-findings/v1", repositoryId: "bounded-fixture", sourceSnapshot: "9007199254740993123456789",
    checker: { id: "checker", version: "1.0.0", rulesSha256: "a".repeat(64), configurationSha256: "b".repeat(64) },
    declaredScope: ["src/a.ts"], reportedExecution: { status: "completed", files: [{ path: "src/a.ts", status: "completed" }] },
    findings: Array.from({ length: count }, (_, index) => ({ id: `occurrence-${index}`, path: "src/a.ts", ruleId: "R1", message: "exact retry(2)", severity: "warning", startLine: index + 1 })) };
}
const bytes = (raw: unknown) => new TextEncoder().encode(typeof raw === "string" ? raw : JSON.stringify(raw));
test("actual finding workers retain bounded large reports and exact snapshot strings while malformed sources stay non-test", async () => {
  const supervisor = new EvidenceSupervisor();
  try {
    const result = await supervisor.submit({ jobId: "finding-boundaries", publicationToken: "finding-boundaries", scopeGeneration: 1, sources: [
      { sourceId: "bounded-large", dialect: FINDING_DIALECT, bytes: bytes(producer(3_000)) },
      { sourceId: "duplicate", dialect: FINDING_DIALECT, bytes: bytes('{"format":"runphantom-findings/v1","format":"runphantom-findings/v1"}') },
      { sourceId: "invalid-encoding", dialect: FINDING_DIALECT, bytes: new Uint8Array([0xc0, 0xaf]) },
    ] }).result;
    expect(result.sources[0]).toMatchObject({ parseState: "parsed", reportOutcome: "unknown", leaves: [], leafCounts: { executed: null, passed: null }, findingBatch: { authentication: "not_authenticated", sourceSnapshot: "9007199254740993123456789" } });
    expect(result.sources[0].findingBatch!.findings).toHaveLength(3_000); expect(result.sources[1].reasonCodes).toContain("duplicate_key"); expect(result.sources[2].reasonCodes).toContain("unsafe_encoding");
    for (const source of result.sources) { expect(source.reportOutcome).toBe("unknown"); expect(source.leaves).toEqual([]); }
    for (const worker of result.workers) expect(() => process.kill(worker.pid, 0)).toThrow(); expect(supervisor.state.active).toBe(0);
  } finally { await supervisor.shutdown(); }
});
test("finite finding DTOs refuse count, UTF-8 message, unsafe surrogate and reader structure excess before comparison", () => {
  const boundary = producer(); boundary.findings[0].message = "é".repeat(2_048); expect(parseFindingBatch(boundary, true).findings[0].message).toBe(boundary.findings[0].message);
  boundary.findings[0].message += "é"; expect(() => parseFindingBatch(boundary, true)).toThrow("finding message");
  boundary.findings[0].message = "\ud800"; expect(() => parseFindingBatch(boundary, true)).toThrow("finding message");
  expect(() => parseFindingBatch(producer(50_001), true)).toThrow("findings exceeds");
  expect(parseExternalEvidence(bytes(producer(2)), FINDING_DIALECT, "records", { maxLeaves: 1 }).reasonCodes).toContain("source_limit");
  expect(parseExternalEvidence(bytes({ excessive: Array(200_001).fill(null) }), FINDING_DIALECT, "structure").reasonCodes).toContain("source_limit");
  expect(parseExternalEvidence(bytes(producer()), FINDING_DIALECT, "depth", { maxDepth: 1 }).reasonCodes).toContain("depth_exceeded");
});
