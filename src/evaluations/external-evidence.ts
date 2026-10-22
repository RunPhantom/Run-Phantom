import { EVIDENCE_VERSION, EVIDENCE_LIMITS as L, EVIDENCE_PAYLOAD_TYPES, EVIDENCE_PREDICATE_TYPE, EVIDENCE_STATEMENT_TYPE,
  type EvidenceAttestationSummary, type EvidenceLeaf, type EvidenceProducerCounts, type EvidenceProducerSummary,
  type EvidenceReason, type NormalizedEvidenceSource } from "./evidence-protocol";
import { deriveEvidenceCounts, evidenceText, observedExecutedLowerBound, parseNormalizedEvidence } from "./evidence-validation";
import { redactText } from "../verification/serialization";
import { decodeEvidence, ReaderRefusal, readerLimits, type ReaderLimits } from "./evidence-reader/limits";
import { strictEvidenceJson } from "./evidence-reader/json";
import { localName, strictEvidenceXml, xmlChildren, type EvidenceXmlElement } from "./evidence-reader/xml";
import { FINDING_DIALECT } from "./finding-protocol";
import { parseFindingBatch } from "./finding-validation";

export const EXTERNAL_EVIDENCE_PARSER_VERSION = "runphantom-report-reader/2";
const countKeys = ["tests", "executed", "passed", "failures", "errors", "skipped", "disabled", "unknown"] as const;
const noCounts = () => ({ executed: null, passed: null, failed: null, errored: null, skipped: null, disabled: null, unknown: null });
function empty(sourceId: string): NormalizedEvidenceSource {
  return { version: EVIDENCE_VERSION, sourceId, parseState: "unparsed", interpretationComplete: false, reportOutcome: "unknown",
    leafCounts: noCounts(), observedExecutedLowerBound: null, producerCounts: null, producerSummaries: [], countsConsistent: null,
    assertedIdentity: { runnerId: null, commit: null, sourceSha256: null }, attestation: null, reasonCodes: [], leaves: [] };
}
function safeText(value: string, max: number): string {
  const text = redactText(value);
  if (Buffer.byteLength(text) > max || text.includes("\0")) throw new ReaderRefusal("normalization_limit");
  return text;
}
function textOf(node: EvidenceXmlElement): string {
  return node.children.map(child => typeof child === "string" ? child : "name" in child ? textOf(child) : "").join("");
}
function countsOf(leaves: EvidenceLeaf[]) {
  const counts = deriveEvidenceCounts(leaves);
  return { tests: String(leaves.length), executed: counts.executed, passed: counts.passed, failures: counts.failed,
    errors: counts.errored, skipped: counts.skipped, disabled: counts.disabled, unknown: counts.unknown };
}
function junit(text: string, sourceId: string, limits: ReaderLimits): NormalizedEvidenceSource {
  const root = strictEvidenceXml(text, limits);
  if (!["testsuite", "testsuites"].includes(localName(root.name))) throw new ReaderRefusal("unsupported_schema", false);
  const result = empty(sourceId), leaves: EvidenceLeaf[] = [], summaries: EvidenceProducerSummary[] = [];
  let complete = true, suiteNumber = 0, inconsistent = false;
  const harmless = new Set(["properties", "property", "system-out", "system-err"]);
  function visit(node: EvidenceXmlElement, parent: string | null): void {
    const suiteId = `suite-${suiteNumber++}`, before = leaves.length, counts: EvidenceProducerCounts = {};
    if (suiteNumber > L.MAX_SUITE_SUMMARIES) throw new ReaderRefusal("source_limit");
    let invalidCount = false;
    for (const key of countKeys) if (Object.hasOwn(node.attributes, key)) {
      const raw = node.attributes[key].trim();
      if (/^(0|[1-9][0-9]*)$/.test(raw) && raw.length <= L.MAX_COUNT_DIGITS) counts[key] = raw;
      else invalidCount = true;
    }
    const summary: EvidenceProducerSummary = { suiteId, parentSuiteId: parent, name: safeText(node.attributes.name ?? "", 512), counts, countsConsistent: null };
    summaries.push(summary);
    for (const child of node.children) {
      if (typeof child === "string") { safeText(child, 4096); if (child.trim()) complete = false; continue; }
      if (!("name" in child)) continue;
      const name = localName(child.name);
      if (name === "testsuite" || name === "testsuites") { visit(child, suiteId); continue; }
      if (name === "testcase") {
        if (leaves.length >= limits.maxLeaves) throw new ReaderRefusal("source_limit");
        const children = xmlChildren(child), terminals = children.filter(c => ["failure", "error", "skipped"].includes(localName(c.name)));
        const unexpected = children.some(c => !["failure", "error", "skipped", "flakyFailure", "flakyError", "rerunFailure", "rerunError"].includes(localName(c.name)) && !harmless.has(localName(c.name)));
        const conflicting = new Set(terminals.map(c => localName(c.name))).size > 1;
        const incomplete = conflicting || unexpected || child.children.some(content => typeof content === "string" && content.trim()) || !terminals.length && children.some(c => ["rerunFailure", "rerunError"].includes(localName(c.name)));
        let status: EvidenceLeaf["status"] = incomplete ? "unknown" : terminals.some(c => localName(c.name) === "error") ? "errored" : terminals.some(c => localName(c.name) === "failure") ? "failed" : terminals.length ? "skipped" :
          child.attributes.status?.toLowerCase() === "notrun" || ["suppressed", "skipped"].includes(child.attributes.result?.toLowerCase()) ? "disabled" : "passed";
        if (incomplete) complete = false;
        // A suite-level initialization error is never manufactured into a testcase.
        if (status === "passed" && child.attributes.status && !["run", "passed", "1"].includes(child.attributes.status.toLowerCase())) { status = "unknown"; complete = false; }
        const duration = child.attributes.time === undefined ? null : Number(child.attributes.time) * 1000;
        if (duration !== null && (!Number.isFinite(duration) || duration < 0 || duration > Number.MAX_SAFE_INTEGER)) throw new ReaderRefusal("source_unparsed", false);
        const detail = children.map(textOf).join("\n");
        leaves.push({ id: `leaf-${leaves.length}`, name: safeText(child.attributes.name ?? "", 512), status,
          file: child.attributes.file === undefined ? null : safeText(child.attributes.file, 1024), durationMs: duration, detail: detail ? safeText(detail, 4096) : null });
      } else if (harmless.has(name)) {
        safeText(textOf(child), 4096);
        if (name === "properties") for (const property of xmlChildren(child)) {
          if (localName(property.name) !== "property") { complete = false; continue; }
          if (["commit", "git_commit", "gitcommit", "git.commit", "git.commit.id", "GIT_COMMIT", "revision", "sha", "vcs.revision"].includes(property.attributes.name ?? "")) result.assertedIdentity.commit = safeText(property.attributes.value ?? "", 256) || null;
        }
      } else complete = false;
    }
    const observed = countsOf(leaves.slice(before));
    summary.countsConsistent = !invalidCount && Object.entries(counts).every(([key, value]) => observed[key as keyof typeof observed] === value);
    inconsistent ||= !summary.countsConsistent;
  }
  visit(root, null);
  result.parseState = "parsed"; result.interpretationComplete = complete; result.leaves = leaves;
  result.leafCounts = deriveEvidenceCounts(leaves); result.observedExecutedLowerBound = observedExecutedLowerBound(leaves);
  result.producerCounts = Object.keys(summaries[0].counts).length ? summaries[0].counts : null;
  result.producerSummaries = summaries; result.countsConsistent = !inconsistent;
  if (inconsistent) result.reasonCodes.push("counts_mismatch");
  if (!complete) result.reasonCodes.push("parse_incomplete");
  if (result.leafCounts.unknown !== "0") result.reasonCodes.push("unknown_leaves");
  result.reportOutcome = result.leafCounts.failed !== "0" || result.leafCounts.errored !== "0" ? "reports_fail" : !complete || inconsistent ? "unknown" : result.leafCounts.executed === "0" ? "no_tests" : "reports_pass";
  if (result.reportOutcome === "no_tests") result.reasonCodes.push("no_tests");
  return result;
}
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new ReaderRefusal("unsupported_schema", false);
  return value as Record<string, unknown>;
}
function array(value: unknown, max: number, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new ReaderRefusal("source_limit");
  return value;
}
function base64(value: unknown, limit: number): Uint8Array {
  if (typeof value !== "string" || value.length > Math.ceil(limit / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new ReaderRefusal("invalid_json");
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength > limit || decoded.toString("base64") !== value) throw new ReaderRefusal("source_limit");
  return decoded;
}
function attestation(text: string, dialect: string, sourceId: string, limits: ReaderLimits): NormalizedEvidenceSource {
  if (dialect === "dsse-envelope-jsonl/v1") {
    const lines = text.split(/\r?\n/).filter(line => line.trim());
    if (lines.length !== 1) throw new ReaderRefusal("unsupported_schema", false);
    text = lines[0];
  }
  let raw = strictEvidenceJson(text, limits), payloadType: string | null = null, signatureCount: string | null = null;
  if (dialect !== "in-toto-statement/v1") {
    const envelope = object(raw, ["payloadType", "payload", "signatures"]);
    if (!(EVIDENCE_PAYLOAD_TYPES as readonly unknown[]).includes(envelope.payloadType)) throw new ReaderRefusal("unsupported_schema", false);
    payloadType = envelope.payloadType as string;
    const signatures = envelope.signatures === undefined ? null : array(envelope.signatures, L.MAX_SUBJECTS);
    if (signatures) for (const signature of signatures) {
      const record = object(signature, ["keyid", "sig"]);
      if (typeof record.sig !== "string") throw new ReaderRefusal("unsupported_schema", false);
      safeText(record.sig, 4096); if (record.keyid !== undefined) { if (typeof record.keyid !== "string") throw new ReaderRefusal("unsupported_schema", false); safeText(record.keyid, 512); }
    }
    signatureCount = signatures === null ? null : String(signatures.length);
    raw = strictEvidenceJson(decodeEvidence(base64(envelope.payload, limits.maxSourceBytes), limits), limits);
  }
  const statement = object(raw, ["_type", "predicateType", "subject", "predicate"]);
  if (statement._type !== EVIDENCE_STATEMENT_TYPE || statement.predicateType !== EVIDENCE_PREDICATE_TYPE) throw new ReaderRefusal("unsupported_schema", false);
  const predicate = object(statement.predicate, ["result", "passedTests", "warnedTests", "failedTests", "configuration"]);
  if (!["PASSED", "WARNED", "FAILED"].includes(predicate.result as string)) throw new ReaderRefusal("unsupported_schema", false);
  const subjects: EvidenceAttestationSummary["subjects"] = array(statement.subject, L.MAX_SUBJECTS, 1).map(rawSubject => {
    const subject = object(rawSubject, ["name", "digest"]);
    if (typeof subject.name !== "string") throw new ReaderRefusal("unsupported_schema", false);
    const digest = object(subject.digest, ["sha256", "gitCommit", "sha1", "gitTree"]);
    if (!Object.keys(digest).length) throw new ReaderRefusal("unsupported_schema", false);
    return { name: safeText(subject.name, 512), digests: Object.entries(digest).map(([algorithm, rawValue]) => {
      if (typeof rawValue !== "string" || !(algorithm === "sha256" ? /^[a-fA-F0-9]{64}$/ : algorithm === "sha1" ? /^[a-fA-F0-9]{40}$/ : /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/).test(rawValue)) throw new ReaderRefusal("unsupported_schema", false);
      return { algorithm: algorithm as EvidenceAttestationSummary["subjects"][number]["digests"][number]["algorithm"], value: rawValue.toLowerCase() };
    }) };
  });
  function names(key: string): string[] | null {
    if (predicate[key] === undefined) return null;
    return array(predicate[key], L.MAX_PRODUCER_TEST_NAMES).map(value => { if (typeof value !== "string") throw new ReaderRefusal("unsupported_schema", false); return safeText(value, 512); });
  }
  const result = empty(sourceId); result.parseState = "parsed"; result.interpretationComplete = true;
  result.reasonCodes = ["attestation_only", "identity_unverified"];
  result.attestation = { statementType: EVIDENCE_STATEMENT_TYPE, predicateType: EVIDENCE_PREDICATE_TYPE, payloadType, signatureCount, signaturesChecked: false,
    producerResult: predicate.result as "PASSED" | "WARNED" | "FAILED", producerTests: { passed: names("passedTests"), warned: names("warnedTests"), failed: names("failedTests") }, subjects,
    assertedCommits: [...new Set(subjects.flatMap(subject => subject.digests.filter(digest => digest.algorithm === "gitCommit").map(digest => digest.value)))],
    reportReferences: subjects.flatMap(subject => subject.digests.filter(digest => digest.algorithm === "sha256").map(digest => ({ subjectName: subject.name, sha256: digest.value }))) };
  return result;
}

/** Pure report interpretation: no file paths, external lookups, commands or execution authority. */
export function parseExternalEvidence(bytes: Uint8Array, dialect: string, sourceId: string, overrides: Partial<ReaderLimits> = {}): NormalizedEvidenceSource {
  evidenceText(sourceId, "source ID");
  const limits = readerLimits(overrides), kind = dialect === "junit-xml/v1" ? "junit" : dialect === FINDING_DIALECT ? "finding" : "attestation";
  try {
    const text = decodeEvidence(bytes, limits);
    const result = dialect === FINDING_DIALECT ? { ...empty(sourceId), parseState: "parsed" as const, interpretationComplete: true, reasonCodes: ["identity_unverified" as const], findingBatch: parseFindingBatch(strictEvidenceJson(text, limits), true) } :
      dialect === "junit-xml/v1" ? junit(text, sourceId, limits) : ["in-toto-statement/v1", "dsse-envelope/v1", "dsse-envelope-jsonl/v1"].includes(dialect) ? attestation(text, dialect, sourceId, limits) : (() => { throw new ReaderRefusal("unsupported_schema", false); })();
    if (result.findingBatch && result.findingBatch.findings.length > limits.maxLeaves) throw new ReaderRefusal("source_limit");
    if (Buffer.byteLength(JSON.stringify(result)) > limits.maxNormalizedBytes) throw new ReaderRefusal("normalization_limit");
    return parseNormalizedEvidence(result, kind);
  } catch (error) {
    const result = empty(sourceId), reason: EvidenceReason = error instanceof ReaderRefusal ? error.code : "source_unparsed";
    result.parseState = error instanceof ReaderRefusal && error.rejected ? "rejected" : "unparsed";
    result.reasonCodes = [...new Set<EvidenceReason>([reason, result.parseState === "rejected" ? "source_rejected" : "source_unparsed"])];
    return result;
  }
}
