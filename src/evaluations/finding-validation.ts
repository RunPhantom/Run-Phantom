import { EvidenceError } from "./evidence-protocol";
import { evidenceArray, evidenceInteger, evidenceObject, evidenceSha256, evidenceText } from "./evidence-validation";
import { redactText } from "../verification/serialization";
import { FINDING_LIMITS, type FindingBatch, type FindingReference } from "./finding-protocol";

function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new EvidenceError(`Unsupported ${label}`);
  return value as T;
}
function text(value: unknown, label: string, max: number, normalize: boolean, empty = false): { value: string; available: boolean } {
  if (typeof value !== "string" || Buffer.byteLength(value) > max || value.includes("\0") || Buffer.from(value, "utf8").toString("utf8") !== value) throw new EvidenceError(`Invalid ${label}`);
  const safe = normalize ? redactText(value) : value;
  return { value: evidenceText(safe, label, max, empty), available: safe === value && !safe.includes("[REDACTED]") };
}
function path(value: unknown, normalize: boolean): { value: string; available: boolean } {
  const result = text(value, "finding path", 1_024, normalize);
  if (result.value.startsWith("/") || result.value.includes("\\") || /^[A-Za-z]:/.test(result.value) || result.value.split("/").some(segment => !segment || segment === "." || segment === "..")) throw new EvidenceError("Finding paths must be exact relative paths");
  return result;
}
/** Only the reader may normalize raw producer text. Stored/public captures are revalidated without trusting producer availability flags. */
export function parseFindingBatch(value: unknown, normalize = false): FindingBatch {
  const source = evidenceObject(value, ["format", "repositoryId", "sourceSnapshot", "checker", "declaredScope", "reportedExecution", "findings", ...(normalize ? [] : ["authentication", "identityAvailable"])], "finding batch");
  if (source.format !== "runphantom-findings/v1" || !normalize && source.authentication !== "not_authenticated") throw new EvidenceError("Unsupported finding format or authentication");
  const repository = text(source.repositoryId, "repository identity", 128, normalize), snapshot = text(source.sourceSnapshot, "source snapshot", 256, normalize);
  const checker = evidenceObject(source.checker, ["id", "version", "rulesSha256", "configurationSha256"], "finding checker");
  const checkerId = text(checker.id, "checker ID", 128, normalize), version = text(checker.version, "checker version", 128, normalize);
  const rulesSha256 = evidenceSha256(checker.rulesSha256), configurationSha256 = evidenceSha256(checker.configurationSha256);
  const scope = evidenceArray(source.declaredScope, FINDING_LIMITS.MAX_PATHS, "declared scope", 1).map(item => path(item, normalize));
  const declaredScope = scope.map(item => item.value);
  const declaredPaths = new Set(declaredScope);
  if (declaredPaths.size !== declaredScope.length) throw new EvidenceError("Declared finding paths must be unique");
  const execution = evidenceObject(source.reportedExecution, ["status", "files"], "reported execution");
  const status = choice(execution.status, ["completed", "partial", "not_run"], "reported execution status");
  const files = evidenceArray(execution.files, FINDING_LIMITS.MAX_PATHS, "reported files", 1).map(item => {
    const record = evidenceObject(item, ["path", "status"], "reported file");
    return { path: path(record.path, normalize).value, status: choice(record.status, ["completed", "partial", "not_run"], "reported file status") };
  });
  const fileStatuses = new Map(files.map(file => [file.path, file.status]));
  if (fileStatuses.size !== files.length || files.length !== declaredScope.length || files.some(file => !declaredPaths.has(file.path))) throw new EvidenceError("Reported files must identify each declared path exactly once");
  if (status === "completed" && files.some(file => file.status !== "completed") || status === "not_run" && files.some(file => file.status !== "not_run")) throw new EvidenceError("Reported file coverage contradicts its batch status");
  const findings = evidenceArray(source.findings, FINDING_LIMITS.MAX_FINDINGS, "findings").map(item => {
    const record = evidenceObject(item, ["id", "path", "ruleId", "message", "severity", "startLine", "endLine", ...(normalize ? [] : ["identityAvailable"])], "finding occurrence");
    const id = text(record.id, "occurrence ID", 128, normalize), file = path(record.path, normalize), rule = text(record.ruleId, "rule ID", 128, normalize), message = text(record.message, "finding message", 4_096, normalize, true);
    const startLine = record.startLine === undefined || record.startLine === null ? null : evidenceInteger(record.startLine, "start line", Number.MAX_SAFE_INTEGER, 1);
    const endLine = record.endLine === undefined || record.endLine === null ? null : evidenceInteger(record.endLine, "end line", Number.MAX_SAFE_INTEGER, 1);
    if (endLine !== null && (startLine === null || endLine < startLine)) throw new EvidenceError("End line requires a valid start line");
    const available = id.available && file.available && rule.available && message.available;
    if (!normalize && (typeof record.identityAvailable !== "boolean" || record.identityAvailable && !available)) throw new EvidenceError("Finding identity availability contradicts redaction");
    return { id: id.value, path: file.value, ruleId: rule.value, message: message.value, severity: choice(record.severity, ["error", "warning", "info"], "finding severity"), startLine, endLine, identityAvailable: normalize ? available : record.identityAvailable as boolean };
  });
  if (new Set(findings.map(finding => finding.id)).size !== findings.length || findings.some(finding => !declaredPaths.has(finding.path))) throw new EvidenceError("Finding IDs must be distinct and belong to declared paths");
  if (status === "not_run" && findings.length || findings.some(finding => fileStatuses.get(finding.path) === "not_run")) throw new EvidenceError("Unexecuted files cannot assert observed finding records");
  const available = repository.available && snapshot.available && checkerId.available && version.available && scope.every(item => item.available);
  if (!normalize && (typeof source.identityAvailable !== "boolean" || source.identityAvailable && !available)) throw new EvidenceError("Batch identity availability contradicts redaction");
  return { format: "runphantom-findings/v1", authentication: "not_authenticated", identityAvailable: normalize ? available : source.identityAvailable as boolean,
    repositoryId: repository.value, sourceSnapshot: snapshot.value, checker: { id: checkerId.value, version: version.value, rulesSha256, configurationSha256 }, declaredScope,
    reportedExecution: { status, files }, findings };
}
export function parseFindingReference(value: unknown): FindingReference {
  const source = evidenceObject(value, ["setId", "revision", "sourceId"], "finding reference");
  return { setId: evidenceText(source.setId, "set ID"), revision: evidenceInteger(source.revision, "revision", Number.MAX_SAFE_INTEGER, 1), sourceId: evidenceText(source.sourceId, "source ID") };
}
