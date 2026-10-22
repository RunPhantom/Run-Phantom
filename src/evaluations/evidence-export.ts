import { EvidenceError, type EvidenceSetView } from "./evidence-protocol";

/** Publication DTOs contain no raw bytes. Exports additionally omit leaf detail, files and producer test-name assertions. */
export function evidenceExport(view: EvidenceSetView) {
  return { format: "runphantom-evidence-report/v1", revision: view.revision, sources: view.sources.map(source => ({
    sourceId: source.sourceId, rawAvailable: source.rawAvailable, normalizedAvailable: source.normalizedAvailable,
    observation: source.normalized ? { parseState: source.normalized.parseState, reportOutcome: source.normalized.reportOutcome,
      interpretationComplete: source.normalized.interpretationComplete, leafCounts: source.normalized.leafCounts,
      observedExecutedLowerBound: source.normalized.observedExecutedLowerBound, producerCounts: source.normalized.producerCounts,
      countsConsistent: source.normalized.countsConsistent, reasonCodes: source.normalized.reasonCodes,
      leaves: source.normalized.leaves.map(leaf => ({ id: leaf.id, status: leaf.status, durationMs: leaf.durationMs })) } : null,
  })) };
}
const escapeXml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
export function evidenceExportJUnit(view: EvidenceSetView): string {
  if (view.revision.sources.some(source => source.kind === "finding")) throw new EvidenceError("Findings are not test executions; use finding JSON export", 409);
  if (view.sources.some(source => !source.normalized || source.normalized.parseState !== "parsed" || !source.normalized.interpretationComplete || source.normalized.leaves.some(leaf => leaf.status === "unknown"))) throw new EvidenceError("JUnit export requires complete classified observations; use JSON for unavailable evidence", 409);
  const leaves = view.sources.flatMap(source => source.normalized!.leaves);
  const property = (name: string, value: string) => `<property name="${escapeXml(name)}" value="${escapeXml(value)}"/>`;
  const cases = view.sources.flatMap(source => source.normalized!.leaves.map(leaf => {
    const status = leaf.status === "failed" ? '<failure message="Observed failure"/>' : leaf.status === "errored" ? '<error message="Observed error"/>' :
      ["skipped", "disabled"].includes(leaf.status) ? `<skipped message="${escapeXml(leaf.status)}"/>` : "";
    return `<testcase classname="${escapeXml(source.sourceId)}" name="${escapeXml(leaf.id)}"${leaf.durationMs === null ? "" : ` time="${leaf.durationMs / 1_000}"`}>${status}</testcase>`;
  }));
  return `<?xml version="1.0" encoding="UTF-8"?><testsuite name="Run Phantom evidence" tests="${leaves.length}" failures="${leaves.filter(leaf => leaf.status === "failed").length}" errors="${leaves.filter(leaf => leaf.status === "errored").length}" skipped="${leaves.filter(leaf => ["skipped", "disabled"].includes(leaf.status)).length}"><properties>${property("runphantom.coverage", view.revision.coverage)}${property("runphantom.reportOutcomes", view.revision.sources.map(source => `${source.sourceId}:${source.reportOutcome}`).join(","))}${property("runphantom.verification", "not_checked")}${property("runphantom.revision", String(view.revision.revision))}</properties>${cases.join("")}</testsuite>`;
}
export const EVIDENCE_EXPORT_BYTES = 8 * 1024 * 1024;
export function boundedEvidenceExport(value: string): string {
  if (Buffer.byteLength(value, "utf8") > EVIDENCE_EXPORT_BYTES) throw new EvidenceError("Evidence export exceeds 8 MiB", 409);
  return value;
}
/** Plaintext deliberately derives from the same minimized DTO as JSON. */
export function evidenceExportText(view: EvidenceSetView): string {
  const report = evidenceExport(view), set = report.revision;
  const lines = ["Run Phantom external evidence", `Set: ${JSON.stringify(set.id)}`, `Revision: ${set.revision}`, `Attachment: ${set.attachment.kind}:${JSON.stringify(set.attachment.id)}`,
    `Coverage: ${set.coverage}`, "Authentication: not_checked", `Reader: ${JSON.stringify(set.parserVersion)}`, `Policy: ${JSON.stringify(set.policyVersion)}`,
    `Configuration SHA-256: ${set.configurationSha256}`, `Inventory: ${set.inventory ? `${JSON.stringify(set.inventory.id)} revision ${set.inventory.revision} (${set.inventory.declaration})` : "not declared"}`,
    `Missing: ${JSON.stringify(set.missing)}`, `Extra: ${JSON.stringify(set.extra)}`, `Duplicates: ${JSON.stringify(set.duplicates)}`, `Rejected: ${JSON.stringify(set.rejected)}`];
  for (const source of report.sources) {
    const summary = set.sources.find(item => item.sourceId === source.sourceId)!, observation = source.observation;
    lines.push("", `Source: ${JSON.stringify(source.sourceId)}`, `SHA-256: ${summary.artifactSha256}`, `Outcome: ${summary.reportOutcome}`, `Parse: ${summary.parseState}`,
      `Report identity asserted: ${summary.reportIdentityAsserted}`, `Commit assertion matches: ${summary.commitAssertionMatches ?? "unavailable"}`, "Authentication: not_checked",
      `Raw available: ${source.rawAvailable}`, `Normalized available: ${source.normalizedAvailable}`, `Observed counts: ${JSON.stringify(summary.leafCounts)}`,
      `Observed executed lower bound: ${summary.observedExecutedLowerBound}`, `Reasons: ${JSON.stringify(summary.reasonCodes)}`,
      `Observed leaves: ${observation ? JSON.stringify(observation.leaves) : "unavailable"}`);
  }
  return boundedEvidenceExport(lines.join("\n") + "\n");
}
