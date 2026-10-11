import express, { type Request, type Response, type NextFunction } from "express";
import { EVIDENCE_LIMITS, EvidenceError, type EvidenceSetView } from "./evidence-protocol";
import { EvidenceInventories, type EvidenceOwner } from "./evidence-inventory";
import { EvidenceImportService, EVIDENCE_HEADER_BYTES, EVIDENCE_FRAME_BYTES, EVIDENCE_IMPORT_CONTENT_TYPE, EVIDENCE_READER_IDENTITY, EvidenceUploadError } from "./evidence-import";
import { evidenceInteger, evidenceObject, evidenceText, parseEvidenceImportRequest } from "./evidence-validation";
import { strictEvidenceJson } from "./evidence-reader/json";
import { readerLimits } from "./evidence-reader/limits";

function errorResponse(error: unknown, res: Response): void {
  const expected = error instanceof EvidenceError;
  res.status(expected ? error.status : 500).json({ error: expected ? error.message : "Evidence request failed",
    ...(error instanceof EvidenceUploadError ? { failureCode: error.code } : {}) });
}
export function evidenceBinaryHandler(service: EvidenceImportService, owner: EvidenceOwner) {
  return (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    void service.receive(owner, req).then(receipt => res.status(202).json(receipt)).catch(error => {
      res.setHeader("Connection", "close"); errorResponse(error, res);
    });
  };
}
export function evidenceJsonBody(): express.RequestHandler {
  return express.json({ limit: EVIDENCE_HEADER_BYTES, strict: true, verify: (_req, _res, bytes) => {
    try { strictEvidenceJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes), readerLimits({ maxDepth: 16 })); }
    catch { throw new EvidenceError("Evidence controls require strict bounded UTF-8 JSON"); }
  } });
}
function revision(value: unknown, required = false): number | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) throw new EvidenceError("Evidence revision must be a positive integer");
  return evidenceInteger(Number(value), "evidence revision", Number.MAX_SAFE_INTEGER, 1);
}
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
export function createEvidenceRouter(service: EvidenceImportService, owner: EvidenceOwner): express.Router {
  const router = express.Router(), inventories = new EvidenceInventories(owner);
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  const route = (handler: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve().then(() => handler(req, res)).catch(next);
  };
  router.get("/capabilities", route((_req, res) => {
    owner.database.transaction(() => owner.authorize("normalized_read", null)).immediate();
    res.json({ transport: { version: 1, contentType: EVIDENCE_IMPORT_CONTENT_TYPE, maxHeaderBytes: EVIDENCE_HEADER_BYTES, maxFrameBytes: EVIDENCE_FRAME_BYTES },
      reader: EVIDENCE_READER_IDENTITY, dialects: ["junit-xml/v1", "in-toto-statement/v1", "dsse-envelope/v1", "dsse-envelope-jsonl/v1"], limits: EVIDENCE_LIMITS });
  }));
  router.post("/inventories", route((req, res) => res.status(201).json(inventories.save(req.body))));
  router.put("/inventories", route((req, res) => res.status(201).json(inventories.save(req.body))));
  router.get("/inventories", route((req, res) => {
    const anchor = strictEvidenceJson(evidenceText(req.query.anchor, "inventory anchor", 1_024), readerLimits({ maxDepth: 4 }));
    res.json(inventories.get(anchor, revision(req.query.revision, true)!));
  }));
  router.get("/imports/:id", route((req, res) => {
    const id = evidenceText(req.params.id, "job ID");
    const value = owner.database.transaction(() => {
      const job = owner.store.getJob(id);
      const row = owner.database.query("SELECT CASE WHEN typeof(request_data)='text' AND length(cast(request_data AS BLOB))<=65536 THEN request_data ELSE NULL END AS request FROM evaluation_evidence_jobs WHERE scope_key=? AND id=?").get(`${owner.scope.kind}:${owner.scope.id}`, id) as { request: string | null } | null;
      if (!row?.request) throw new EvidenceError("Stored evidence integrity check failed", 409);
      const request = parseEvidenceImportRequest(strictEvidenceJson(row.request, readerLimits()));
      return { job, declaredSources: request.sources, observationsAvailable: job.status === "completed", timings: service.timings(owner, job.id) };
    }).immediate();
    res.json(value);
  }));
  router.get("/imports", route((req, res) => {
    const operationKey = evidenceText(req.query.operationKey, "operation key");
    const job = owner.database.transaction(() => {
      owner.authorize("normalized_read", null);
      const row = owner.database.query("SELECT CASE WHEN typeof(j.id)='text' AND length(cast(j.id AS BLOB))<=128 THEN j.id ELSE NULL END AS id FROM evaluation_evidence_jobs j JOIN evaluation_evidence_scopes s ON s.scope_key=j.scope_key AND s.generation=j.scope_generation AND s.active=1 WHERE j.scope_key=? AND j.operation_key=?").get(`${owner.scope.kind}:${owner.scope.id}`, operationKey) as { id: string | null } | null;
      if (!row) throw new EvidenceError("Evidence job not found", 404);
      if (row.id === null) throw new EvidenceError("Stored evidence integrity check failed", 409);
      return owner.store.getJob(row.id);
    }).immediate();
    res.json({ job });
  }));
  router.post("/imports/:id/cancel", route(async (req, res) => { evidenceObject(req.body ?? {}, [], "cancellation"); res.json({ cancelled: await service.cancel(owner, evidenceText(req.params.id, "job ID")) }); }));
  router.get("/sets/:id", route((req, res) => res.json(owner.store.getSet(evidenceText(req.params.id, "set ID"), revision(req.query.revision)))));
  router.get("/sets/:id/export", route((req, res) => {
    const view = owner.store.getSet(evidenceText(req.params.id, "set ID"), revision(req.query.revision));
    if (req.query.format === "junit") res.type("application/xml").send(evidenceExportJUnit(view));
    else if (req.query.format === undefined || req.query.format === "json") res.json(evidenceExport(view));
    else throw new EvidenceError("Evidence export format must be json or junit");
  }));
  router.get("/sets/:id/raw/:sourceId", route((req, res) => {
    const bytes = owner.store.exportRaw(evidenceText(req.params.id, "set ID"), revision(req.query.revision, true)!, evidenceText(req.params.sourceId, "source ID"));
    res.type("application/octet-stream").setHeader("Content-Disposition", 'attachment; filename="evidence.bin"'); res.send(Buffer.from(bytes));
  }));
  router.post("/sets/:id/reparse", route(async (req, res) => res.status(202).json(await service.reparse(owner, evidenceText(req.params.id, "set ID"), req.body))));
  router.delete("/sets/:id/retention/:kind", route(async (req, res) => {
    if (req.params.kind !== "raw" && req.params.kind !== "normalized") throw new EvidenceError("Retention kind must be raw or normalized");
    evidenceObject(req.body ?? {}, [], "retention deletion");
    res.json({ removed: await service.removePayloads(owner, evidenceText(req.params.id, "set ID"), revision(req.query.revision, true)!, req.params.kind === "raw" ? "raw_removed" : "normalized_removed") });
  }));
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => errorResponse(error, res));
  return router;
}
