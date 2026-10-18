import { EvidenceError } from "./evidence-protocol";
import { canonicalEvidenceJson, evidenceDigest } from "./evidence-validation";
import { FINDING_LIMITS, FINDING_POLICY, type FindingBatch, type FindingDelta, type FindingDifference, type FindingMapping, type FindingOccurrence } from "./finding-protocol";

export function findingPairDigest(baseline: FindingBatch, candidate: FindingBatch): string {
  const identity = (batch: FindingBatch) => ({ repositoryId: batch.repositoryId, sourceSnapshot: batch.sourceSnapshot, checker: batch.checker, declaredScope: batch.declaredScope });
  return evidenceDigest(canonicalEvidenceJson({ baseline: identity(baseline), candidate: identity(candidate), policy: FINDING_POLICY }));
}
import { parseFindingBatch } from "./finding-validation";

const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
/** Exact multiset matching. Location is presentation; same-severity occurrences are paired before changed-severity occurrences. */
export function compareFindingBatches(left: FindingBatch, right: FindingBatch, mapping: FindingMapping | null = null): FindingDifference {
  const baseline = parseFindingBatch(left), candidate = parseFindingBatch(right);
  if (baseline.findings.length + candidate.findings.length > FINDING_LIMITS.MAX_PAIR) throw new EvidenceError("Finding pair exceeds its population limit", 413);
  const reasons: string[] = [], occurrences: FindingDelta[] = [], rename = new Map<string, string>();
  if (mapping) {
    if (mapping.policy !== FINDING_POLICY || mapping.actor !== "local_operator" || mapping.reviewed !== true || mapping.pairDigest !== findingPairDigest(baseline, candidate)) throw new EvidenceError("Reviewed mapping does not bind these exact finding identities", 409);
    for (const entry of mapping.paths) {
      if (rename.has(entry.baseline) || [...rename.values()].includes(entry.candidate) || !baseline.declaredScope.includes(entry.baseline) || !candidate.declaredScope.includes(entry.candidate)) throw new EvidenceError("Reviewed finding paths must be one-to-one declared paths", 409);
      rename.set(entry.baseline, entry.candidate);
    }
  }
  const mappedScope = baseline.declaredScope.map(path => rename.get(path) ?? path);
  if (new Set(mappedScope).size !== mappedScope.length) throw new EvidenceError("Reviewed paths collide with unchanged paths", 409);
  const compatible = baseline.identityAvailable && candidate.identityAvailable && baseline.repositoryId === candidate.repositoryId &&
    (canonicalEvidenceJson(baseline.checker) === canonicalEvidenceJson(candidate.checker) || !!mapping) &&
    canonicalEvidenceJson([...mappedScope].sort(compare)) === canonicalEvidenceJson([...candidate.declaredScope].sort(compare));
  if (!compatible) reasons.push("incompatible_or_unavailable_identity");
  const complete = baseline.reportedExecution.status === "completed" && candidate.reportedExecution.status === "completed";
  if (!complete) reasons.push("reported_execution_incomplete");
  const identityAvailable = baseline.findings.every(finding => finding.identityAvailable) && candidate.findings.every(finding => finding.identityAvailable);
  if (!identityAvailable) reasons.push("redacted_finding_identity");
  if (!compatible || !complete || !identityAvailable) {
    for (const finding of baseline.findings) occurrences.push({ baselineId: finding.id, candidateId: null, classification: "unresolved", severityChanged: false, locationChanged: false });
    for (const finding of candidate.findings) occurrences.push({ baselineId: null, candidateId: finding.id, classification: "unresolved", severityChanged: false, locationChanged: false });
  } else {
    type Group = { baseline: FindingOccurrence[]; candidate: FindingOccurrence[] };
    const groups = new Map<string, Group>();
    for (const [side, batch] of [["baseline", baseline], ["candidate", candidate]] as const) for (const finding of batch.findings) {
      const key = canonicalEvidenceJson([side === "baseline" ? rename.get(finding.path) ?? finding.path : finding.path, finding.ruleId, finding.message]);
      let group = groups.get(key); if (!group) { group = { baseline: [], candidate: [] }; groups.set(key, group); } group[side].push(finding);
    }
    for (const key of [...groups.keys()].sort(compare)) {
      const group = groups.get(key)!; group.baseline.sort((a, b) => compare(a.id, b.id)); group.candidate.sort((a, b) => compare(a.id, b.id));
      const used = new Set<string>(), paired = new Set<string>();
      const pair = (a: FindingOccurrence, b: FindingOccurrence) => { used.add(a.id); paired.add(b.id); occurrences.push({ baselineId: a.id, candidateId: b.id, classification: "retained", severityChanged: a.severity !== b.severity, locationChanged: a.path !== b.path || a.startLine !== b.startLine || a.endLine !== b.endLine }); };
      for (const severity of ["error", "warning", "info"] as const) {
        const a = group.baseline.filter(item => item.severity === severity), b = group.candidate.filter(item => item.severity === severity);
        for (let index = 0; index < Math.min(a.length, b.length); index++) pair(a[index], b[index]);
      }
      const a = group.baseline.filter(item => !used.has(item.id)), b = group.candidate.filter(item => !paired.has(item.id));
      for (let index = 0; index < Math.min(a.length, b.length); index++) pair(a[index], b[index]);
      for (const item of group.baseline) if (!used.has(item.id)) occurrences.push({ baselineId: item.id, candidateId: null, classification: "removed", severityChanged: false, locationChanged: false });
      for (const item of group.candidate) if (!paired.has(item.id)) occurrences.push({ baselineId: null, candidateId: item.id, classification: "introduced", severityChanged: false, locationChanged: false });
    }
  }
  const conditional = reasons.length === 0;
  return { policy: FINDING_POLICY, authentication: "not_authenticated", interpretation: conditional ? "conditional" : "unavailable",
    observed: { baseline: baseline.findings.length, candidate: candidate.findings.length },
    counts: { retained: conditional ? occurrences.filter(item => item.classification === "retained").length : null, introduced: conditional ? occurrences.filter(item => item.classification === "introduced").length : null,
      removed: conditional ? occurrences.filter(item => item.classification === "removed").length : null, unresolved: conditional ? 0 : occurrences.length }, reasons, occurrences };
}
