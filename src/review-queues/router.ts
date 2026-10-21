import express, { type Request, type Response, type NextFunction } from "express";
import { EvaluationError, fields, object, parseId, parseVersion } from "../evaluations/validation";
import { promoteApprovedReviewItems } from "../evaluations/store";
import { REVIEW_LIMITS as L } from "./protocol";
import { parseReviewJson, parseReviewCursor, parsePromotionRequest, ReviewQueueError } from "./validation";
import * as store from "./store";

export function createReviewQueueRouter(): express.Router {
  const router = express.Router();
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const hasBody = req.headers["transfer-encoding"] !== undefined || Number(req.headers["content-length"] ?? 0) > 0;
    if (hasBody && !req.is("application/json")) return res.status(400).json({ error: { code: "invalid_request", message: "Review queues accept JSON request bodies only" } });
    next();
  });
  router.use(express.json({ limit: L.MAX_REQUEST_BYTES, verify: (_req, _res, bytes, encoding) => { parseReviewJson(new TextDecoder(encoding, { fatal: true }).decode(bytes)); } }));
  const route = (handler: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
    try { handler(req, res); } catch (error) { next(error); }
  };
  router.get("/", route((_req, res) => res.json(store.listReviewQueues())));
  router.post("/", route((req, res) => res.status(201).json(store.createReviewQueue(req.body))));
  router.get("/:id", route((req, res) => res.json({ ...store.readReviewQueue(parseId(req.params.id)), counts: store.reviewCounts(req.params.id) })));
  router.delete("/:id", route((req, res) => { store.deleteReviewQueue(parseId(req.params.id)); res.status(204).end(); }));
  router.post("/:id/items", route((req, res) => res.status(201).json(store.insertReviewItem(parseId(req.params.id), req.body))));
  router.get("/:id/items", route((req, res) => res.json(store.listReviewItems(parseId(req.params.id), parseReviewCursor(req.query)))));
  router.get("/:id/window", route((req, res) => {
    fields(req.query as Record<string, unknown>, ["centerId"], "window query");
    res.json(store.reviewWindow(parseId(req.params.id), parseId(req.query.centerId)));
  }));
  router.put("/:id/items/:itemId", route((req, res) => res.json(store.mutateReviewItem(parseId(req.params.id), parseId(req.params.itemId), "save", req.body))));
  router.post("/:id/items/:itemId/approve", route((req, res) => res.json(store.mutateReviewItem(parseId(req.params.id), parseId(req.params.itemId), "approve", req.body))));
  router.post("/:id/items/:itemId/reopen", route((req, res) => res.json(store.mutateReviewItem(parseId(req.params.id), parseId(req.params.itemId), "reopen", req.body))));
  router.delete("/:id/items/:itemId", route((req, res) => {
    const body = object(req.body, "deletion"); fields(body, ["expectedRevision"], "deletion");
    store.deleteReviewItem(parseId(req.params.id), parseId(req.params.itemId), parseVersion(body.expectedRevision)); res.status(204).end();
  }));
  router.post("/:id/promotions", route((req, res) => {
    const body = object(req.body, "promotion"); fields(body, ["datasetId", "expectedDatasetVersion", "idempotencyKey", "items"], "promotion");
    res.status(201).json(promoteApprovedReviewItems(parsePromotionRequest({ ...body, queueId: parseId(req.params.id) })));
  }));
  router.get("/:id/promotions/:key", route((req, res) => {
    const result = store.findReviewPromotion(parseId(req.params.id), parseId(req.params.key));
    if (!result) throw new ReviewQueueError("not_found", "Promotion receipt not found", 404);
    res.json(result.receipt);
  }));
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const known = error instanceof EvaluationError;
    const parser = error && typeof error === "object" ? error as { type?: string; code?: string } : {};
    const status = known ? error.status : parser.type === "charset.unsupported" || parser.type === "encoding.unsupported" ? 415 : parser.type === "entity.too.large" ? 413 : parser.type === "entity.parse.failed" || parser.type === "entity.verify.failed" ? 400 : parser.code === "SQLITE_BUSY" ? 503 : 500;
    res.status(status).json({ error: { code: error instanceof ReviewQueueError ? error.code : status === 503 ? "store_busy" : status === 413 ? "size_limit" : status === 415 ? "unsupported_media_type" : status === 400 ? "invalid_request" : "request_failed",
      message: known ? error.message : status === 503 ? "Local review store is busy; retry the original request" : status === 413 ? "Review request exceeds its byte limit" : status === 415 ? "Unsupported review request charset or content encoding" : status === 400 ? "Invalid review request JSON" : "Review queue request failed" } });
  });
  return router;
}
