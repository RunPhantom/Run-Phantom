import { createHash } from "node:crypto";
import { redactText } from "../verification/serialization";
import { EVIDENCE_LIMITS as L, EVIDENCE_VERSION, EvidenceError, type EvidenceAttachment, type EvidenceCounts,
  type EvidenceExpectedSource, type EvidenceImportRequest, type EvidenceKind, type EvidenceLeaf,
  type EvidenceReason, type EvidenceScope, type NormalizedEvidenceSource } from "./evidence-protocol";

const kinds = ["junit", "json", "jsonl", "attestation"] as const;
const dialects = { junit: ["junit-xml/v1"], json: ["test-report-json/v1"], jsonl: ["test-report-jsonl/v1"], attestation: ["in-toto-statement/v1", "dsse-envelope/v1"] } as const;
const countKeys = ["executed", "passed", "failed", "errored", "skipped", "disabled", "unknown"] as const;
const producerKeys = ["tests", "executed", "passed", "failures", "errors", "skipped", "disabled", "unknown"] as const;
const statuses = ["passed", "failed", "errored", "skipped", "disabled", "unknown"] as const;
const reasons: readonly EvidenceReason[] = ["source_unparsed", "source_rejected", "counts_mismatch", "unknown_leaves", "no_tests",
  "missing_source", "extra_source", "duplicate_shard", "kind_mismatch", "constraint_mismatch", "inventory_not_declared",
  "retrospective_inventory", "identity_unverified", "raw_removed", "normalized_removed", "parse_incomplete", "attestation_only"];
function invalid(message: string): never { throw new EvidenceError(message); }
export function evidenceObject(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${label} must be a plain object`);
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) invalid(`${label} has an unsupported field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor) || !descriptor.enumerable) invalid(`${label} requires ordinary JSON fields`);
    result[key] = descriptor.value;
  }
  return result;
}
export function evidenceArray(value: unknown, max: number, label: string, min = 0): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max) invalid(`${label} exceeds its entry limit`);
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid(`${label} requires ordinary JSON entries`);
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid(`${label} cannot contain holes or accessors`);
    return descriptor.value;
  });
}
export function evidenceText(value: unknown, label: string, max = 128, empty = false): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > max || (!empty && !value.trim()) || value.includes("\0")) invalid(`${label} exceeds its text limit`);
  if (redactText(value) !== value) invalid(`${label} contains unredacted credentials`);
  return value;
}
export function evidenceInteger(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) invalid(`${label} must be a bounded integer`);
  return value;
}
export function evidenceSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid("SHA-256 must be lowercase hexadecimal");
  return value;
}
export function evidenceDecimal(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > L.MAX_COUNT_DIGITS) invalid("Counts must be bounded exact decimal strings");
  return value;
}
function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) invalid(`Unsupported ${label}`);
  return value as T;
}
function nullableText(value: unknown, label: string, max = 128): string | null { return value === null ? null : evidenceText(value, label, max); }
export function parseEvidenceScope(value: unknown): EvidenceScope {
  const scope = evidenceObject(value, ["kind", "id"], "scope");
  if (scope.kind === "local" && scope.id === "local") return { kind: "local", id: "local" };
  if (scope.kind !== "project") invalid("Unsupported evidence scope");
  return { kind: "project", id: evidenceText(scope.id, "project ID") };
}
export function parseEvidenceAttachment(value: unknown): EvidenceAttachment {
  const attachment = evidenceObject(value, ["kind", "id"], "attachment");
  return { kind: oneOf(attachment.kind, ["inspection", "experiment", "check", "run"], "attachment"), id: evidenceText(attachment.id, "attachment ID") };
}
export function parseEvidenceExpectedSources(value: unknown): EvidenceExpectedSource[] {
  const seen = new Set<string>();
  return evidenceArray(value, L.MAX_REPORTS, "expected sources", 1).map(raw => {
    const source = evidenceObject(raw, ["shardId", "kind", "constraints"], "expected source");
    const shardId = evidenceText(source.shardId, "shard ID");
    if (seen.has(shardId)) invalid("Expected shard IDs must be unique");
    seen.add(shardId);
    const constraints = evidenceObject(source.constraints, ["runnerId", "commit", "sourceSha256"], "constraints");
    return { shardId, kind: oneOf(source.kind, kinds, "source kind"), constraints: {
      runnerId: nullableText(constraints.runnerId, "runner ID"), commit: nullableText(constraints.commit, "commit", 256),
      sourceSha256: constraints.sourceSha256 === null ? null : evidenceSha256(constraints.sourceSha256),
    } };
  });
}
export function parseEvidenceImportRequest(value: unknown): EvidenceImportRequest {
  const request = evidenceObject(value, ["operationKey", "target", "attachment", "sources", "inventory", "parserVersion", "policyVersion", "configurationSha256", "retention"], "import request");
  const seen = new Set<string>();
  let bytes = 0;
  const sources = evidenceArray(request.sources, L.MAX_REPORTS, "sources", 1).map(raw => {
    const source = evidenceObject(raw, ["sourceId", "kind", "dialect", "shardId", "artifactSha256", "byteLength"], "source descriptor");
    const sourceId = evidenceText(source.sourceId, "source ID");
    if (seen.has(sourceId)) invalid("Source IDs must be unique; duplicate shard claims must have distinct source IDs");
    seen.add(sourceId);
    const byteLength = evidenceInteger(source.byteLength, "source bytes", L.MAX_SOURCE_BYTES);
    bytes += byteLength;
    if (bytes > L.MAX_IMPORT_BYTES) throw new EvidenceError("Import exceeds 8 MiB", 413);
    const kind = oneOf(source.kind, kinds, "source kind");
    return { sourceId, kind, dialect: oneOf(source.dialect, dialects[kind], "source dialect"), shardId: nullableText(source.shardId, "shard ID"),
      artifactSha256: evidenceSha256(source.artifactSha256), byteLength };
  });
  const inventory = request.inventory === null ? null : evidenceObject(request.inventory, ["id", "revision"], "inventory reference");
  const target = request.target === null ? null : evidenceObject(request.target, ["setId", "expectedRevision"], "target");
  return { operationKey: evidenceText(request.operationKey, "operation key"), target: target ? { setId: evidenceText(target.setId, "set ID"),
    expectedRevision: evidenceInteger(target.expectedRevision, "expected set revision", Number.MAX_SAFE_INTEGER, 1) } : null,
    attachment: parseEvidenceAttachment(request.attachment), sources,
    inventory: inventory ? { id: evidenceText(inventory.id, "inventory ID"), revision: evidenceInteger(inventory.revision, "inventory revision", Number.MAX_SAFE_INTEGER, 1) } : null,
    parserVersion: evidenceText(request.parserVersion, "parser version"), policyVersion: evidenceText(request.policyVersion, "policy version"),
    configurationSha256: evidenceSha256(request.configurationSha256),
    retention: oneOf(request.retention, ["raw_and_normalized", "normalized_only"], "retention") };
}
function parseLeaf(value: unknown): EvidenceLeaf {
  const leaf = evidenceObject(value, ["id", "name", "status", "file", "durationMs", "detail"], "leaf");
  if (leaf.durationMs !== null && (typeof leaf.durationMs !== "number" || !Number.isFinite(leaf.durationMs) || leaf.durationMs < 0)) invalid("Leaf duration must be finite or unavailable");
  return { id: evidenceText(leaf.id, "leaf ID"), name: evidenceText(leaf.name, "leaf name", 512, true), status: oneOf(leaf.status, statuses, "leaf status"),
    file: nullableText(leaf.file, "leaf file", 1024), durationMs: leaf.durationMs as number | null, detail: leaf.detail === null ? null : evidenceText(leaf.detail, "leaf detail", 4096, true) };
}
export function deriveEvidenceCounts(leaves: EvidenceLeaf[]): EvidenceCounts {
  const counts = { executed: 0, passed: 0, failed: 0, errored: 0, skipped: 0, disabled: 0, unknown: 0 };
  for (const leaf of leaves) {
    counts[leaf.status]++;
    if (["passed", "failed", "errored"].includes(leaf.status)) counts.executed++;
  }
  return Object.fromEntries(countKeys.map(key => [key, String(counts[key])])) as EvidenceCounts;
}
export function parseNormalizedEvidence(value: unknown, kind: EvidenceKind): NormalizedEvidenceSource {
  const source = evidenceObject(value, ["version", "sourceId", "parseState", "reportOutcome", "leafCounts", "producerCounts", "countsConsistent", "assertedIdentity", "reasonCodes", "leaves"], "normalized source");
  if (source.version !== EVIDENCE_VERSION) invalid("Unsupported evidence version");
  const parseState = oneOf(source.parseState, ["parsed", "unparsed", "rejected"], "parse state");
  const leaves = evidenceArray(source.leaves, L.MAX_LEAVES, "leaves").map(parseLeaf);
  if (new Set(leaves.map(leaf => leaf.id)).size !== leaves.length) invalid("Leaf IDs must retain distinct observations");
  if ((parseState !== "parsed" || kind === "attestation") && leaves.length) invalid("Unparsed or attestation sources cannot assert executed leaves");
  const rawCounts = evidenceObject(source.leafCounts, countKeys, "leaf counts");
  const leafCounts = Object.fromEntries(countKeys.map(key => [key, rawCounts[key] === null ? null : evidenceDecimal(rawCounts[key])])) as EvidenceCounts;
  const expectedCounts = parseState === "parsed" && kind !== "attestation" ? deriveEvidenceCounts(leaves) : Object.fromEntries(countKeys.map(key => [key, null]));
  if (canonicalEvidenceJson(leafCounts) !== canonicalEvidenceJson(expectedCounts)) invalid("Leaf counts must match observed leaves without producer-count substitution");
  const producer = source.producerCounts === null ? null : evidenceObject(source.producerCounts, producerKeys, "producer counts");
  const producerCounts = producer ? Object.fromEntries(Object.entries(producer).map(([key, count]) => [key, evidenceDecimal(count)])) : null;
  if (source.countsConsistent !== null && typeof source.countsConsistent !== "boolean") invalid("Count consistency must be explicit or unavailable");
  if ((parseState !== "parsed" || kind === "attestation") && source.countsConsistent !== null) invalid("No leaf consistency is established for unparsed or attestation evidence");
  const observedProducerCounts = { tests: String(leaves.length), executed: leafCounts.executed, passed: leafCounts.passed, failures: leafCounts.failed,
    errors: leafCounts.errored, skipped: leafCounts.skipped, disabled: leafCounts.disabled, unknown: leafCounts.unknown };
  if (source.countsConsistent === true && producerCounts && Object.entries(producerCounts).some(([key, count]) => count !== observedProducerCounts[key as keyof typeof observedProducerCounts])) invalid("Conflicting producer counts cannot be consistent");
  const reportOutcome = oneOf(source.reportOutcome, ["reports_pass", "reports_fail", "no_tests", "unknown"], "report outcome");
  const expectedOutcome = leafCounts.failed !== null && (leafCounts.failed !== "0" || leafCounts.errored !== "0") ? "reports_fail" :
    parseState !== "parsed" || kind === "attestation" || source.countsConsistent !== true || leafCounts.unknown !== "0" ? "unknown" :
      leafCounts.executed === "0" ? "no_tests" : "reports_pass";
  if (reportOutcome !== expectedOutcome) invalid("Report outcome does not follow its independent observation precedence");
  const identity = evidenceObject(source.assertedIdentity, ["runnerId", "commit", "sourceSha256"], "asserted identity");
  return { version: EVIDENCE_VERSION, sourceId: evidenceText(source.sourceId, "source ID"), parseState, reportOutcome, leafCounts, producerCounts,
    countsConsistent: source.countsConsistent as boolean | null, assertedIdentity: { runnerId: nullableText(identity.runnerId, "runner ID"),
      commit: nullableText(identity.commit, "commit", 256), sourceSha256: identity.sourceSha256 === null ? null : evidenceSha256(identity.sourceSha256) },
    reasonCodes: evidenceArray(source.reasonCodes, reasons.length, "reason codes").map(reason => oneOf(reason, reasons, "reason code")), leaves };
}

/** Only validated ordinary JSON participates in identity. Key order is irrelevant; array order and duplicate membership are material. */
export function canonicalEvidenceJson(value: unknown): string {
  let nodes = 0;
  function canonical(raw: unknown, depth: number): unknown {
    if (++nodes > 600_000 || depth > 12) invalid("Evidence exceeds its structure limit");
    if (raw === null || typeof raw === "string" || typeof raw === "boolean") return raw;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (Array.isArray(raw)) return evidenceArray(raw, L.MAX_LEAVES, "canonical array").map(item => canonical(item, depth + 1));
    if (typeof raw !== "object" || !raw) invalid("Evidence requires ordinary JSON values");
    const keys = Reflect.ownKeys(raw);
    if (keys.some(key => typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key as string))) invalid("Evidence contains an unsafe field");
    const record = evidenceObject(raw, keys as string[], "canonical object");
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key], depth + 1)]));
  }
  return JSON.stringify(canonical(value, 0));
}
export function evidenceDigest(bytes: string | Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
