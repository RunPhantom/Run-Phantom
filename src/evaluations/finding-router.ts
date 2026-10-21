import express, { type Request, type Response, type NextFunction } from "express";
import { listEvidenceSets, type EvidenceOwner } from "./evidence-inventory";
import { EvidenceError } from "./evidence-protocol";
import { evidenceInteger, evidenceObject, evidenceText, parseEvidenceAttachment } from "./evidence-validation";
import { strictEvidenceJson } from "./evidence-reader/json";
import { readerLimits } from "./evidence-reader/limits";
import { FindingStore } from "./finding-store";
import { FINDING_DIALECT, FINDING_LIMITS, FINDING_POLICY } from "./finding-protocol";

function anchor(query: unknown) {
  const source = evidenceObject(query, ["attachment"], "finding discovery query");
  return parseEvidenceAttachment(strictEvidenceJson(evidenceText(source.attachment, "attachment", 1_024), readerLimits({ maxDepth: 4 })));
}
function integer(value: unknown, label: string, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new EvidenceError(`Invalid ${label}`);
  return evidenceInteger(Number(value), label, max);
}
export function createFindingRouter(owner: EvidenceOwner): express.Router {
  const router = express.Router(), store = new FindingStore(owner);
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  const route = (work: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => { Promise.resolve().then(() => work(req, res)).catch(next); };
  router.get("/capabilities", route((_req, res) => {
    store.authorizeCurrent(null);
    res.json({ dialect: FINDING_DIALECT, policy: FINDING_POLICY, enabled: true, scope: "local", actor: "local_operator", authentication: "not_authenticated", limits: FINDING_LIMITS });
  }));
  router.get("/batches", route((req, res) => res.json(owner.database.transaction(() => {
    if (owner.scope.kind !== "local") throw new EvidenceError("Finding comparison is unavailable for this scope", 403);
    const attachment = anchor(req.query); store.authorizeCurrent(attachment);
    const history = listEvidenceSets(owner, attachment), items = [];
    let truncated = history.truncated;
    for (const entry of history.items) {
      const view = owner.store.getSet(entry.id, entry.revision); store.authorizeCurrent(view.revision.attachment);
      for (const source of view.revision.sources) if (source.kind === "finding") {
        const capture = view.sources.find(item => item.sourceId === source.sourceId);
        if (!capture) throw new EvidenceError("Stored finding source identity changed", 409);
        if (!capture.normalizedAvailable) continue;
        if (!capture.normalized) throw new EvidenceError("Stored finding interpretation is unavailable", 409);
        const batch = capture.normalized?.findingBatch;
        if (items.length >= 100) { truncated = true; break; }
        items.push({ reference: { setId: entry.id, revision: entry.revision, sourceId: source.sourceId }, createdAt: entry.createdAt, parseState: source.parseState, observed: batch?.findings.length ?? null, repositoryId: batch?.repositoryId ?? null, sourceSnapshot: batch?.sourceSnapshot ?? null, checker: batch?.checker ?? null, reportedExecution: batch?.reportedExecution.status ?? null, authentication: "not_authenticated" });
      }
      if (truncated && items.length >= 100) break;
    }
    return { items, truncated };
  }).immediate())));
  router.post("/mappings", route((req, res) => res.status(201).json(store.reviewMapping(req.body))));
  router.post("/comparisons", route((req, res) => {
    const started = performance.now(), result = store.compareWithAttempt(req.body, attemptId => {
      res.once("finish", () => { try { store.completeResponse(attemptId, performance.now() - started); } catch { /* Current authority can be revoked before the response completes. */ } });
      res.setHeader("X-Run-Phantom-Finding-Attempt", attemptId);
    });
    res.status(201).json(result.page);
  }));
  router.get("/metrics", route((_req, res) => res.json(store.metrics())));
  router.get("/comparisons", route((req, res) => res.json(store.list(anchor(req.query)))));
  router.get("/comparisons/:id/authority", route((req, res) => res.json(store.current(evidenceText(req.params.id, "comparison ID"), anchor(req.query)))));
  router.get("/comparisons/:id/export", route((req, res) => { evidenceObject(req.query, [], "finding export query"); res.json(store.export(evidenceText(req.params.id, "comparison ID"))); }));
  router.get("/comparisons/:id", route((req, res) => {
    evidenceObject(req.query, ["offset", "limit"], "finding page query"); res.json(store.get(evidenceText(req.params.id, "comparison ID"), integer(req.query.offset, "offset", 0, FINDING_LIMITS.MAX_PAIR), integer(req.query.limit, "limit", 100, 100)));
  }));
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(error instanceof EvidenceError ? error.status : 500).json({ error: error instanceof EvidenceError ? error.message : "Finding request failed" }));
  return router;
}
