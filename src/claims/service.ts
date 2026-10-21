import type { EvidenceOwner } from "../evaluations/evidence-inventory";
import { EvidenceError } from "../evaluations/evidence-protocol";
import { canonicalEvidenceJson, parseEvidenceImportRequest } from "../evaluations/evidence-validation";
import { strictEvidenceJson } from "../evaluations/evidence-reader/json";
import { readerLimits } from "../evaluations/evidence-reader/limits";
import { completionEnabled, observeCompletion, parseCompletionRequest } from "./report";
import type { CompletionDisabled, CompletionReport } from "./protocol";

/** The injected owner supplies the only database and current attachment authority. No derived report is stored. */
export function currentCompletionReport(owner: EvidenceOwner, value: unknown): CompletionReport | CompletionDisabled {
  if (!completionEnabled(value)) return observeCompletion(value, null);
  const input = parseCompletionRequest(value);
  if (owner.scope.kind !== "local") throw new EvidenceError("Completion observer is unavailable for this scope", 403);
  return owner.database.transaction(() => {
    owner.authorize("normalized_read", null); owner.authorize("normalized_read", input.attachment); owner.resolveAnchor(input.attachment);
    const key = `${owner.scope.kind}:${owner.scope.id}`;
    // Exact selected metadata is bounded before JSON parsing and before canonical payload lookup.
    const row = owner.database.query(`SELECT s.revision,g.generation,j.id AS jobId,
      CASE WHEN typeof(j.request_data)='text' AND length(cast(j.request_data AS BLOB))<=65536 THEN j.request_data ELSE NULL END AS request
      FROM evaluation_evidence_sets s JOIN evaluation_evidence_jobs j ON j.id=s.job_id AND j.scope_key=s.scope_key
      JOIN evaluation_evidence_scopes g ON g.scope_key=s.scope_key AND g.generation=j.scope_generation AND g.active=1
      WHERE s.scope_key=? AND s.id=? AND s.revision=(SELECT max(h.revision) FROM evaluation_evidence_sets h WHERE h.scope_key=s.scope_key AND h.id=s.id)`)
      .get(key, input.setId) as { revision: number; generation: number; jobId: string; request: string | null } | null;
    if (!row) throw new EvidenceError("Selected completion evidence is unavailable", 404);
    if (row.revision !== input.revision) throw new EvidenceError("Select the current evidence revision before inspecting completion prose", 409);
    if (!row.request) throw new EvidenceError("Stored evidence metadata integrity check failed", 409);
    const request = parseEvidenceImportRequest(strictEvidenceJson(row.request, readerLimits()));
    if (canonicalEvidenceJson(request) !== row.request) throw new EvidenceError("Stored evidence metadata integrity check failed", 409);
    if (canonicalEvidenceJson(request.attachment) !== canonicalEvidenceJson(input.attachment)) throw new EvidenceError("Completion evidence belongs to a different attachment", 409);
    const job = owner.store.getJob(row.jobId);
    if (job.status !== "completed" || job.setId !== input.setId) throw new EvidenceError("Completion evidence publication identity changed", 409);
    const view = owner.store.getSet(input.setId, input.revision);
    if (canonicalEvidenceJson(view.revision.attachment) !== canonicalEvidenceJson(input.attachment)) throw new EvidenceError("Completion evidence attachment changed", 409);
    if (!view.sources.some(source => source.normalizedAvailable)) throw new EvidenceError("Selected normalized completion evidence was removed", 404);
    if (view.revision.scopeGeneration !== row.generation) throw new EvidenceError("Completion evidence scope changed", 409);
    const report = observeCompletion(input, view);
    owner.authorize("normalized_read", null); owner.authorize("normalized_read", input.attachment); owner.resolveAnchor(input.attachment);
    const current = owner.database.query("SELECT generation,active FROM evaluation_evidence_scopes WHERE scope_key=?").get(key) as { generation: number; active: number } | null;
    if (current?.active !== 1 || current.generation !== row.generation) throw new EvidenceError("Completion evidence scope changed", 409);
    return report;
  }).immediate();
}
