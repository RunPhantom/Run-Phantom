import express, { type Request, type Response, type NextFunction } from "express";
import type { EvidenceOwner } from "../evaluations/evidence-inventory";
import { EvidenceError } from "../evaluations/evidence-protocol";
import { evidenceInteger, evidenceObject, evidenceText, parseEvidenceAttachment } from "../evaluations/evidence-validation";
import { strictEvidenceJson } from "../evaluations/evidence-reader/json";
import { readerLimits } from "../evaluations/evidence-reader/limits";
import { completionEnabled, observeCompletion } from "./report";
import { currentCompletionReport } from "./service";
import { CompletionStore } from "./store";

function selection(query: unknown, history = false) {
  const value = evidenceObject(query, history ? ["attachment", "offset"] : ["attachment"], "completion history selection");
  const attachment = parseEvidenceAttachment(strictEvidenceJson(evidenceText(value.attachment, "completion attachment", 1024), readerLimits({ maxDepth: 4 })));
  if (value.offset !== undefined && (typeof value.offset !== "string" || !/^(0|[1-9][0-9]*)$/.test(value.offset))) throw new EvidenceError("Completion history offset must be a bounded integer");
  return { attachment, offset: value.offset === undefined ? 0 : evidenceInteger(Number(value.offset), "completion history offset", 100) };
}
export function createCompletionRouter(owner: EvidenceOwner): express.Router {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  const route = (work: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => { try { work(req, res); } catch (error) { next(error); } };
  router.post("/inspect", route((req, res) => { evidenceObject(req.query, [], "completion query"); res.json(currentCompletionReport(owner, req.body)); }));
  router.post("/reports", route((req, res) => {
    evidenceObject(req.query, [], "completion creation query");
    if (!completionEnabled(req.body)) { res.json(observeCompletion(req.body, null)); return; }
    const result = new CompletionStore(owner).create(req.body); res.status(201).json(result);
  }));
  router.get("/reports", route((req, res) => { const { attachment, offset } = selection(req.query, true); res.json(new CompletionStore(owner).list(attachment, offset)); }));
  router.get("/reports/:id", route((req, res) => { const { attachment } = selection(req.query); res.json(new CompletionStore(owner).get(evidenceText(req.params.id, "completion report ID"), attachment)); }));
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(error instanceof EvidenceError ? error.status : 500).json({ error: error instanceof EvidenceError ? error.message : "Completion inspection failed" }));
  return router;
}
