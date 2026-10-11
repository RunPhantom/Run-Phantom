import { describe, expect, test } from "bun:test";
import { parseExternalEvidence } from "../src/evaluations/external-evidence";
import { EVIDENCE_PREDICATE_TYPE, EVIDENCE_STATEMENT_TYPE } from "../src/evaluations/evidence-protocol";

const bytes = (text: string) => new TextEncoder().encode(text);
const read = (text: string, dialect = "junit-xml/v1") => parseExternalEvidence(bytes(text), dialect, "fixture");
function statement(extra: Record<string, unknown> = {}) {
  return { _type: EVIDENCE_STATEMENT_TYPE, predicateType: EVIDENCE_PREDICATE_TYPE,
    subject: [{ name: "report.xml", digest: { sha256: "a".repeat(64), gitCommit: "b".repeat(40) } }],
    predicate: { result: "PASSED", passedTests: ["one"] }, ...extra };
}

describe("real bounded report byte interpretation", () => {
  test("a nonempty green report remains unauthenticated report evidence", () => {
    const result = read('<testsuite tests="1"><testcase name="one"/></testsuite>');
    expect(result.reportOutcome).toBe("reports_pass");
    expect(result.leafCounts).toEqual({ executed: "1", passed: "1", failed: "0", errored: "0", skipped: "0", disabled: "0", unknown: "0" });
    expect(result.assertedIdentity.commit).toBeNull();
    expect(result.attestation).toBeNull();
  });
  test("nested producer totals never double count leaves or hide a definite failure", () => {
    const result = read('<testsuites tests="2"><testsuite tests="1"><testcase name="a"/></testsuite><testsuite tests="1"><testcase name="b"><failure>wrong</failure></testcase></testsuite></testsuites>');
    expect(result.leafCounts.executed).toBe("2");
    expect(result.producerSummaries).toHaveLength(3);
    expect(result.countsConsistent).toBe(true);
    expect(result.reportOutcome).toBe("reports_fail");
  });
  test("exact large producer assertions stay distinct from counted leaves", () => {
    const result = read('<testsuite tests="9007199254740993"><testcase name="one"/></testsuite>');
    expect(result.producerCounts?.tests).toBe("9007199254740993");
    expect(result.leafCounts.executed).toBe("1");
    expect(result.countsConsistent).toBe(false);
    expect(result.reportOutcome).toBe("unknown");
  });
  test("missing optional producer counts permit complete leaf interpretation", () => {
    expect(read('<testsuite><testcase name="one"/></testsuite>').reportOutcome).toBe("reports_pass");
  });
  test.each([
    '<testsuite/>', '<testsuite><testcase name="s"><skipped/></testcase></testsuite>',
    '<testsuite><testcase name="d" status="notrun" result="suppressed"/></testsuite>',
  ])("zero execution does not certify a substantive pass: %s", xml => {
    expect(read(xml).reportOutcome).toBe("no_tests");
  });
  test("contradictory terminal children remain unknown with a nullable denominator", () => {
    const result = read('<testsuite><testcase name="ambiguous"><failure/><skipped/></testcase></testsuite>');
    expect(result.leaves[0].status).toBe("unknown");
    expect(result.leafCounts.executed).toBeNull();
    expect(result.observedExecutedLowerBound).toBe("0");
    expect(result.reportOutcome).toBe("unknown");
  });
  test("a known failure stays visible alongside unknown classification", () => {
    const result = read('<testsuite><testcase name="ambiguous"><rerunFailure/></testcase><testcase name="red"><failure/></testcase></testsuite>');
    expect(result.reportOutcome).toBe("reports_fail");
    expect(result.interpretationComplete).toBe(false);
    expect(result.leafCounts.executed).toBeNull();
  });
  test("unsafe XML declarations are refused after the whole prefix", () => {
    const result = read('<!--' + "x".repeat(9216) + '--><!DOCTYPE testsuite [<!ENTITY x "small">]><testsuite/>');
    expect(result.parseState).toBe("rejected");
    expect(result.reasonCodes).toContain("xml_doctype");
    expect(result.leaves).toEqual([]);
  });
  test.each([
    '<!ENTITY x SYSTEM "urn:runphantom:no-resolution"><testsuite/>',
    '<!NOTATION x SYSTEM "urn:runphantom:no-resolution"><testsuite/>',
  ])("entity and notation directives cannot reach native expansion: %s", xml => {
    expect(read(xml).parseState).toBe("rejected");
  });
  test("escaped and CDATA directive-like log text stays inert", () => {
    const result = read('<testsuite><testcase name="one"/><system-out>&lt;!DOCTYPE html&gt;</system-out><system-err><![CDATA[<!ENTITY harmless>]]></system-err></testsuite>');
    expect(result.reportOutcome).toBe("reports_pass");
  });
  test("malformed XML is retained as an unparsed observation", () => {
    expect(read('<testsuite><testcase></testsuite>').parseState).toBe("unparsed");
  });
  test("unsafe encodings and excessive structure are refused", () => {
    expect(parseExternalEvidence(new Uint8Array([0xc0, 0xaf]), "junit-xml/v1", "fixture").reasonCodes).toContain("unsafe_encoding");
    expect(read('<?xml version="1.0" encoding="UTF-16"?><testsuite/>').reasonCodes).toContain("unsafe_encoding");
    expect(read('<testsuites>'.repeat(70) + '</testsuites>'.repeat(70)).reasonCodes).toContain("depth_exceeded");
  });
  test("normalization redacts captured secrets before publication", () => {
    const result = read('<testsuite><testcase name="one"><failure>Authorization: Bearer synthetic-token-value</failure></testcase></testsuite>');
    expect(JSON.stringify(result)).not.toContain("synthetic-token-value");
    expect(result.reportOutcome).toBe("reports_fail");
  });
  test("bare attestation keeps producer assertions without inventing executed leaves", () => {
    const result = read(JSON.stringify(statement()), "in-toto-statement/v1");
    expect(result.parseState).toBe("parsed");
    expect(result.reportOutcome).toBe("unknown");
    expect(result.leafCounts.executed).toBeNull();
    expect(result.attestation?.assertedCommits).toEqual(["b".repeat(40)]);
    expect(result.attestation?.reportReferences).toEqual([{ subjectName: "report.xml", sha256: "a".repeat(64) }]);
  });
  test("fake-signed DSSE has no authentication capability", () => {
    const text = JSON.stringify({ payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(statement())).toString("base64"), signatures: [{ keyid: "fake", sig: "bm90LWE tc2lnbmF0dXJl" }] });
    const result = read(text, "dsse-envelope/v1");
    expect(result.attestation?.signatureCount).toBe("1");
    expect(result.attestation?.signaturesChecked).toBe(false);
    expect(result.reportOutcome).toBe("unknown");
  });
  test("duplicate keys, lossy tokens and prototype fields are refused before shape validation", () => {
    for (const text of ['{"_type":"one","_type":"two"}', '{"value":9007199254740993}', '{"__proto__":{}}']) {
      expect(read(text, "in-toto-statement/v1").parseState).not.toBe("parsed");
    }
    expect(read('{"_type":"one","\\u005ftype":"two"}', "in-toto-statement/v1").reasonCodes).toContain("duplicate_key");
  });
  test("unsupported schemas and multiple JSONL envelopes do not merge assertions", () => {
    expect(read(JSON.stringify(statement({ predicateType: "https://in-toto.io/attestation/test-result/v2" })), "in-toto-statement/v1").reasonCodes).toContain("unsupported_schema");
    expect(read('{}\n{}\n', "dsse-envelope-jsonl/v1").parseState).not.toBe("parsed");
  });
  test("source and leaf limits are applied before a success can be produced", () => {
    expect(read(" ".repeat(2 * 1024 * 1024 + 1)).reasonCodes).toContain("source_limit");
    expect(read('<testsuite>' + '<testcase/>'.repeat(50_001) + '</testsuite>').reasonCodes).toContain("source_limit");
  });
  test("unregistered XML versions and unexpected mixed content cannot look complete", () => {
    expect(read('<?xml version="1.1"?><testsuite><testcase name="one"/></testsuite>').reasonCodes).toContain("unsupported_schema");
    expect(read('<testsuite>unrecognized outcome<testcase name="one"/></testsuite>').reportOutcome).toBe("unknown");
    expect(read('<testsuite><testcase name="one">FAILED</testcase></testsuite>').reportOutcome).toBe("unknown");
  });
  test("the real byte parser never resolves a report-supplied external resource", async () => {
    let requests = 0;
    const server = Bun.serve({ port: 0, fetch() { requests++; return new Response("synthetic-resource"); } });
    try {
      await fetch(`http://127.0.0.1:${server.port}/monitor-control`);
      expect(requests).toBe(1); requests = 0;
      const malicious = `<!DOCTYPE testsuite [<!ENTITY x SYSTEM "http://127.0.0.1:${server.port}/must-not-resolve">]><testsuite><testcase name="one"/><system-out>&x;</system-out></testsuite>`;
      expect(read(malicious).parseState).toBe("rejected");
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(requests).toBe(0);
    } finally { await server.stop(true); }
  });
});
