import { describe, expect, test } from "bun:test";
import { EVIDENCE_LIMITS as L, EVIDENCE_PREDICATE_TYPE, EVIDENCE_STATEMENT_TYPE, type EvidenceImportRequest, type NormalizedEvidenceSource } from "../src/evaluations/evidence-protocol";
import { canonicalEvidenceJson, deriveEvidenceCounts, evidenceDecimal, evidenceDigest, parseEvidenceExpectedSources,
  parseEvidenceImportRequest, parseNormalizedEvidence, observedExecutedLowerBound } from "../src/evaluations/evidence-validation";

const raw = new TextEncoder().encode("synthetic report");
function request(): EvidenceImportRequest {
  return { operationKey: "retry-1", target: null, attachment: { kind: "inspection", id: "local-review" },
    sources: [{ sourceId: "source-1", kind: "junit", dialect: "junit-xml/v1", shardId: "unit", artifactSha256: evidenceDigest(raw), byteLength: raw.byteLength }],
    inventory: null, parserVersion: "strict-1", policyVersion: "redaction-1", configurationSha256: evidenceDigest("strict-configuration"), retention: "raw_and_normalized" };
}
function normalized(): NormalizedEvidenceSource {
  const leaves = [{ id: "leaf-1", name: "Synthetic assertion", status: "passed" as const, file: null, durationMs: 0, detail: null }];
  return { version: 1, sourceId: "source-1", parseState: "parsed", interpretationComplete: true, reportOutcome: "reports_pass", leafCounts: deriveEvidenceCounts(leaves), observedExecutedLowerBound: "1",
    producerCounts: { tests: "1", failures: "0" }, countsConsistent: true, assertedIdentity: { runnerId: null, commit: null, sourceSha256: null },
    attestation: null, reasonCodes: [], leaves };
}
describe("versioned immutable evidence contracts", () => {
  test("retains exact producer counts beyond safe integer while independently deriving leaves", () => {
    const source = normalized(); source.producerCounts = { tests: "900719925474099312345678901234567890" };
    source.countsConsistent = false; source.reportOutcome = "unknown";
    const parsed = parseNormalizedEvidence(source, "junit");
    expect(parsed.producerCounts!.tests).toBe("900719925474099312345678901234567890");
    expect(parsed.leafCounts.executed).toBe("1");
    expect(() => parseNormalizedEvidence({ ...source, countsConsistent: true }, "junit")).toThrow("Conflicting producer");
  });
  test("report failures dominate contradictory totals, while unknown or skipped-only reports cannot pass", () => {
    const failed = normalized(); failed.leaves[0].status = "failed"; failed.leafCounts = deriveEvidenceCounts(failed.leaves);
    failed.countsConsistent = false; failed.reportOutcome = "reports_fail";
    expect(parseNormalizedEvidence(failed, "junit").reportOutcome).toBe("reports_fail");
    for (const status of ["unknown", "skipped", "disabled"] as const) {
      const source = normalized(); source.leaves[0].status = status; source.leafCounts = deriveEvidenceCounts(source.leaves); source.producerCounts = null;
      source.observedExecutedLowerBound = observedExecutedLowerBound(source.leaves); source.interpretationComplete = status !== "unknown";
      source.reportOutcome = status === "unknown" ? "unknown" : "no_tests";
      expect(parseNormalizedEvidence(source, "junit").reportOutcome).toBe(source.reportOutcome);
      expect(() => parseNormalizedEvidence({ ...source, reportOutcome: "reports_pass" }, "junit")).toThrow("precedence");
    }
  });
  test("unparsed sources and attestations cannot invent leaf execution or parser authentication", () => {
    const source = normalized();
    expect(() => parseNormalizedEvidence(source, "attestation")).toThrow("cannot assert executed");
    expect(() => parseNormalizedEvidence({ ...source, parseState: "unparsed" }, "junit")).toThrow("cannot assert executed");
    expect(() => parseNormalizedEvidence({ ...source, authentication: "verified" }, "junit")).toThrow("unsupported field");
    const attestation = { ...source, leaves: [], leafCounts: Object.fromEntries(Object.keys(source.leafCounts).map(key => [key, null])),
      observedExecutedLowerBound: null, producerCounts: { tests: "100" }, countsConsistent: null, reportOutcome: "unknown", assertedIdentity: { ...source.assertedIdentity, commit: "asserted-commit" },
      attestation: { statementType: EVIDENCE_STATEMENT_TYPE, predicateType: EVIDENCE_PREDICATE_TYPE, payloadType: null, signatureCount: null, signaturesChecked: false,
        producerResult: "PASSED", producerTests: { passed: ["producer claims success"], warned: null, failed: null }, subjects: [], assertedCommits: [], reportReferences: [] } };
    expect(parseNormalizedEvidence(attestation, "attestation")).toMatchObject({ reportOutcome: "unknown", producerCounts: { tests: "100" }, leafCounts: { executed: null } });
  });
  test("missing consistency and forged leaf counts cannot fabricate observed success", () => {
    const source = normalized();
    expect(() => parseNormalizedEvidence({ ...source, countsConsistent: null }, "junit")).toThrow("precedence");
    expect(() => parseNormalizedEvidence({ ...source, leafCounts: { ...source.leafCounts, executed: "100" } }, "junit")).toThrow("observed leaves");
    expect(() => parseNormalizedEvidence({ ...source, leaves: [source.leaves[0], source.leaves[0]] }, "junit")).toThrow("distinct observations");
  });
  test("request identity ignores object field order but preserves source order and duplicate membership", () => {
    const first = request(); const second = { ...first, sources: [...first.sources, { ...first.sources[0], sourceId: "source-2" }] };
    const parsed = parseEvidenceImportRequest(second);
    expect(parsed.sources).toHaveLength(2); expect(parsed.sources[0].artifactSha256).toBe(parsed.sources[1].artifactSha256);
    expect(canonicalEvidenceJson(first)).toBe(canonicalEvidenceJson(Object.fromEntries(Object.entries(first).reverse())));
    expect(evidenceDigest(canonicalEvidenceJson(parsed))).not.toBe(evidenceDigest(canonicalEvidenceJson({ ...parsed, sources: [...parsed.sources].reverse() })));
    expect(() => parseEvidenceImportRequest({ ...first, sources: [first.sources[0], first.sources[0]] })).toThrow("Source IDs");
  });
  test("source and aggregate limits reject hostile admission before decoding", () => {
    const draft = request();
    expect(() => parseEvidenceImportRequest({ ...draft, sources: Array(33).fill(draft.sources[0]) })).toThrow("entry limit");
    expect(() => parseEvidenceImportRequest({ ...draft, sources: [{ ...draft.sources[0], byteLength: L.MAX_SOURCE_BYTES + 1 }] })).toThrow("bounded integer");
    const large = Array.from({ length: 5 }, (_, index) => ({ ...draft.sources[0], sourceId: `source-${index}`, byteLength: L.MAX_SOURCE_BYTES }));
    expect(() => parseEvidenceImportRequest({ ...draft, sources: large })).toThrow("8 MiB");
    expect(() => parseEvidenceImportRequest({ ...draft, sources: [{ ...draft.sources[0], byteLength: Number.MAX_SAFE_INTEGER + 1 }] })).toThrow("bounded integer");
  });
  test("selected dialect, policy configuration and explicit revision targets are strict request identity", () => {
    const draft = request();
    expect(() => parseEvidenceImportRequest({ ...draft, sources: [{ ...draft.sources[0], dialect: "dsse-envelope/v1" }] })).toThrow("dialect");
    expect(() => parseEvidenceImportRequest({ ...draft, configurationSha256: "abc" })).toThrow("SHA-256");
    expect(() => parseEvidenceImportRequest({ ...draft, target: { setId: "previous", expectedRevision: 0 } })).toThrow("bounded integer");
    const append = parseEvidenceImportRequest({ ...draft, target: { setId: "previous", expectedRevision: 1 } });
    expect(evidenceDigest(canonicalEvidenceJson(append))).not.toBe(evidenceDigest(canonicalEvidenceJson(draft)));
    expect(evidenceDigest(canonicalEvidenceJson({ ...draft, configurationSha256: evidenceDigest("another policy") }))).not.toBe(evidenceDigest(canonicalEvidenceJson(draft)));
  });
  test("inventory cannot self-collapse expected shard duplicates or silently omit constraints", () => {
    const expected = { shardId: "unit", kind: "junit", constraints: { runnerId: null, commit: null, sourceSha256: null } };
    expect(parseEvidenceExpectedSources([expected])).toEqual([expected]);
    expect(() => parseEvidenceExpectedSources([expected, expected])).toThrow("unique");
    expect(() => parseEvidenceExpectedSources([{ ...expected, constraints: {} }])).toThrow("text limit");
  });
  test("count syntax stays canonical and finite without coercion or rounding", () => {
    expect(evidenceDecimal("0")).toBe("0"); expect(evidenceDecimal("9".repeat(128))).toHaveLength(128);
    for (const value of [0, -1, 1.1, "-1", "01", "1e100", "1.0", "Infinity", "9".repeat(129)]) expect(() => evidenceDecimal(value)).toThrow();
  });
  test("prototypes, symbolic/nonenumerable fields, getters and sparse arrays are refused without invoking accessors", () => {
    const draft = request(); let reads = 0;
    const getter = { ...draft }; Object.defineProperty(getter, "sources", { enumerable: true, get() { reads++; return draft.sources; } });
    expect(() => parseEvidenceImportRequest(getter)).toThrow("ordinary JSON"); expect(reads).toBe(0);
    expect(() => parseEvidenceImportRequest(Object.assign(Object.create({ inherited: true }), draft))).toThrow("plain object");
    expect(() => parseEvidenceImportRequest({ ...draft, [Symbol("bad")]: true })).toThrow("unsupported field");
    const hidden = { ...draft }; Object.defineProperty(hidden, "hidden", { value: true });
    expect(() => parseEvidenceImportRequest(hidden)).toThrow("unsupported field");
    const sparse = new Array(1); expect(() => parseEvidenceImportRequest({ ...draft, sources: sparse })).toThrow();
    const arrayGetter = [draft.sources[0]]; Object.defineProperty(arrayGetter, "0", { get() { reads++; return draft.sources[0]; } });
    expect(() => parseEvidenceImportRequest({ ...draft, sources: arrayGetter })).toThrow("accessors"); expect(reads).toBe(0);
    expect(() => canonicalEvidenceJson(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow("unsafe field");
  });
  test("normalized text must have applied privacy policy before durable publication", () => {
    const source = normalized(); source.leaves[0].detail = `Authorization: Bearer ${"s".repeat(50)}`;
    expect(() => parseNormalizedEvidence(source, "junit")).toThrow("unredacted credentials");
    expect(() => parseEvidenceImportRequest({ ...request(), operationKey: `sk-proj-${"s".repeat(50)}` })).toThrow("unredacted credentials");
  });
  test("unknown classification withholds exact execution while preserving observed lower bounds and definite failure", () => {
    const source = normalized(); source.leaves.push({ ...source.leaves[0], id: "unknown", status: "unknown" });
    source.leafCounts = deriveEvidenceCounts(source.leaves); source.interpretationComplete = false; source.reportOutcome = "unknown";
    source.producerCounts = { tests: "2" }; source.reasonCodes = ["unknown_leaves"];
    expect(parseNormalizedEvidence(source, "junit")).toMatchObject({ leafCounts: { executed: null, passed: "1", unknown: "1" }, observedExecutedLowerBound: "1", reportOutcome: "unknown" });
    expect(() => parseNormalizedEvidence({ ...source, leafCounts: { ...source.leafCounts, executed: "1" } }, "junit")).toThrow("observed leaves");
    source.leaves[0].status = "failed"; source.leafCounts = deriveEvidenceCounts(source.leaves); source.reportOutcome = "reports_fail";
    expect(parseNormalizedEvidence(source, "junit")).toMatchObject({ leafCounts: { executed: null, failed: "1" }, reportOutcome: "reports_fail" });
  });
  test("an incomplete parser diagnostic cannot pass even when every retained leaf is successful", () => {
    const source = normalized(); source.interpretationComplete = false; source.reasonCodes = ["parse_incomplete"]; source.reportOutcome = "unknown";
    expect(parseNormalizedEvidence(source, "junit").reportOutcome).toBe("unknown");
    expect(() => parseNormalizedEvidence({ ...source, reportOutcome: "reports_pass" }, "junit")).toThrow("precedence");
    expect(() => parseNormalizedEvidence({ ...source, interpretationComplete: true }, "junit")).toThrow("completeness");
  });
  test("finite JSON and JSONL admit exact attestation dialects rather than invented test-report schemas", () => {
    const draft = request();
    for (const [kind, dialect] of [["json", "in-toto-statement/v1"], ["json", "dsse-envelope/v1"], ["jsonl", "dsse-envelope-jsonl/v1"]] as const) {
      expect(parseEvidenceImportRequest({ ...draft, sources: [{ ...draft.sources[0], kind, dialect }] }).sources[0].dialect).toBe(dialect);
    }
    expect(() => parseEvidenceImportRequest({ ...draft, sources: [{ ...draft.sources[0], kind: "json", dialect: "test-report-json/v1" }] })).toThrow("dialect");
    expect(() => parseNormalizedEvidence(normalized(), "json")).toThrow("cannot assert executed");
  });
});
