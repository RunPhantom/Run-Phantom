import express, { type NextFunction, type Request, type Response } from "express";
import { strictEvidenceJson } from "../evaluations/evidence-reader/json";
import { readerLimits } from "../evaluations/evidence-reader/limits";
import { promptId, promptInteger, promptObject, PromptRegistryError, type PromptCapability } from "./protocol";
import { COMPARISON_LIMITS, ComparisonError, comparisonJson } from "./comparison-protocol";
import type { ComparisonCoordinator } from "./comparison";
import type { ComparisonFence, ComparisonStore } from "./comparison-store";

const identical = (a: ComparisonFence, b: ComparisonFence) => a.comparisonGeneration === b.comparisonGeneration
  && a.promptGeneration === b.promptGeneration && a.evidenceGeneration === b.evidenceGeneration
  && a.owner.birth === b.owner.birth && a.owner.generation === b.owner.generation;
/** Trusted owner store only; local or authenticated project guards must precede this router. */
export function createComparisonRouter(store: ComparisonStore | null, coordinator: ComparisonCoordinator | null): express.Router {
  const router = express.Router({ caseSensitive: true, strict: true }), requests = new WeakMap<Request, { fence: ComparisonFence; capability: PromptCapability }>();
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      if (!store || !coordinator) throw new ComparisonError("unavailable");
      if (!["GET", "POST"].includes(req.method) || !req.baseUrl.endsWith("/prompts/comparisons") || req.originalUrl.includes("#") || req.path.includes("%") || req.originalUrl.includes("\\")) throw new ComparisonError("invalid_request");
      if (new URL(req.originalUrl, "http://local.invalid").pathname !== req.baseUrl + (req.path === "/" ? "" : req.path)) throw new ComparisonError("invalid_request");
      if (req.path !== "/" && req.path.endsWith("/")) throw new ComparisonError("invalid_request");
      const capability: PromptCapability = req.path === "/clear" ? "delete" : req.method === "GET" ? "read" : "edit";
      requests.set(req, { fence: store.capture(capability), capability });
      const hasBody = req.headers["transfer-encoding"] !== undefined || Number(req.headers["content-length"] ?? 0) > 0;
      if (req.method === "GET" && hasBody || req.method === "POST" && (!req.is("application/json") || ![undefined, "identity"].includes(req.headers["content-encoding"] as string | undefined))) throw new ComparisonError("invalid_request");
      next();
    } catch (error) { next(error); }
  });
  router.use(express.json({ limit: COMPARISON_LIMITS.requestBytes, strict: true, inflate: false, verify: (_req, _res, bytes) => {
    try { strictEvidenceJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes), readerLimits({ maxDepth: 8 })); }
    catch { throw new ComparisonError("invalid_request"); }
  } }));
  const fence = (req: Request) => requests.get(req)!.fence;
  const route = (allowed: string[], work: (req: Request) => unknown, status = 200, clears = false) => (req: Request, res: Response, next: NextFunction) => {
    try {
      const seen = new Set<string>();
      for (const [key] of new URL(req.originalUrl, "http://local.invalid").searchParams) {
        if (!allowed.includes(key) || seen.has(key)) throw new ComparisonError("invalid_request"); seen.add(key);
      }
      const value = work(req), captured = requests.get(req)!;
      const expected = clears ? { ...captured.fence, comparisonGeneration: promptInteger(promptObject(value, ["removed", "generation"]).generation) } : captured.fence;
      if (!identical(store!.capture(captured.capability), expected)) throw new ComparisonError("authority_changed");
      const serialized = comparisonJson(value);
      if (!identical(store!.capture(captured.capability), expected)) throw new ComparisonError("authority_changed");
      res.status(status).type("application/json").send(serialized);
    } catch (error) { next(error); }
  };
  router.get("/capabilities", route([], req => store!.capabilities(fence(req))));
  router.get("/", route(["cursor"], req => store!.list(req.query.cursor, fence(req))));
  router.get("/:id/export", route([], req => store!.export(promptId(req.params.id), fence(req))));
  router.get("/:id", route([], req => store!.get(promptId(req.params.id), fence(req))));
  router.post("/", route([], req => coordinator!.submit(store!, req.body as unknown, fence(req)), 201));
  router.post("/clear", route([], req => coordinator!.clear(store!, req.body as unknown, fence(req)), 200, true));
  router.post("/:id/cancel", route([], req => {
    const input = promptObject(req.body as unknown, ["expectedGeneration"]);
    if (promptInteger(input.expectedGeneration) !== fence(req).comparisonGeneration) throw new ComparisonError("authority_changed");
    return coordinator!.cancel(store!, promptId(req.params.id), fence(req));
  }));
  router.use((_req, _res, next) => next(new ComparisonError("not_found")));
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const expected = error instanceof ComparisonError || error instanceof PromptRegistryError;
    const status = expected ? error.status : error && typeof error === "object" && "status" in error && [400, 413, 415].includes(Number(error.status)) ? Number(error.status) : 500;
    res.status(status).json({ error: expected ? error.message : status === 413 ? "Comparison request exceeds its limit." : "Comparison request failed." });
  });
  return router;
}
