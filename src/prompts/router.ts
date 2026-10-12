import express, { type Request, type Response, type NextFunction } from "express";
import { strictEvidenceJson } from "../evaluations/evidence-reader/json";
import { readerLimits } from "../evaluations/evidence-reader/limits";
import { PROMPT_LIMITS, PROMPT_POLICY, PromptRegistryError, boundedPromptResult, promptInteger, promptObject, type PromptCapability, type PromptFence, samePromptFence } from "./protocol";
import type { PromptRegistry } from "./registry";

/** Mount behind existing local access guards and before the daemon's global JSON parser. */
export function createPromptRouter(registry: PromptRegistry): express.Router {
  const router = express.Router(), fences = new WeakMap<Request, PromptFence>();
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      if (!["GET", "POST", "DELETE"].includes(req.method) || req.originalUrl.includes("#") || req.path.endsWith("/") && req.path !== "/" || req.path.includes("%") || req.originalUrl.includes("\\")) throw new PromptRegistryError("invalid_request");
      const capability: PromptCapability = req.method === "DELETE" || req.path === "/clear" ? "delete"
        : req.method === "GET" || req.path.endsWith("/compile") ? "read" : "edit";
      fences.set(req, registry.capture(capability));
      const hasBody = req.headers["transfer-encoding"] !== undefined || Number(req.headers["content-length"] ?? 0) > 0;
      if (["GET", "HEAD", "DELETE"].includes(req.method) && hasBody) throw new PromptRegistryError("invalid_request");
      if (req.method === "POST" && (!req.is("application/json") || ![undefined, "identity"].includes(req.headers["content-encoding"] as string | undefined))) throw new PromptRegistryError("invalid_request");
      next();
    } catch (error) { next(error); }
  });
  router.use(express.json({ limit: PROMPT_LIMITS.requestBytes, strict: true, inflate: false, verify: (_req, _res, bytes) => {
    try { strictEvidenceJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes), readerLimits({ maxDepth: 4 })); }
    catch { throw new PromptRegistryError("invalid_request"); }
  } }));
  const fence = (req: Request) => fences.get(req)!;
  const number = (value: unknown) => {
    if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) throw new PromptRegistryError("invalid_request");
    return promptInteger(Number(value), PROMPT_LIMITS.revisionsPerPrompt);
  };
  const route = (allowed: string[], work: (req: Request) => unknown, status = 200) => (req: Request, res: Response, next: NextFunction) => {
    try {
      const seen = new Set<string>();
      for (const [key] of new URL(req.originalUrl, "http://local.invalid").searchParams) {
        if (!allowed.includes(key) || seen.has(key)) throw new PromptRegistryError("invalid_request");
        seen.add(key);
      }
      res.status(status).json(boundedPromptResult(work(req)));
    } catch (error) { next(error); }
  };
  router.get("/capabilities", route([], req => {
    if (!samePromptFence(registry.capture("read"), fence(req))) throw new PromptRegistryError("authority_changed");
    return { enabled: true, scope: "local", policy: PROMPT_POLICY, generation: fence(req).promptGeneration, limits: PROMPT_LIMITS };
  }));
  router.get("/", route(["cursor"], req => registry.list(req.query.cursor, fence(req))));
  router.post("/", route([], req => registry.create(req.body as unknown, fence(req)), 201));
  router.post("/clear", route([], req => registry.clear(req.body as unknown, fence(req))));
  router.get("/:id/history", route([], req => registry.history(req.params.id, fence(req))));
  router.get("/:id/revisions/:revision", route([], req => registry.get(req.params.id, number(req.params.revision), fence(req))));
  router.get("/:id/revisions/:revision/export", route([], req => registry.export(req.params.id, number(req.params.revision), fence(req))));
  router.post("/:id/revisions/:revision/compile", route([], req => registry.compile(req.params.id, number(req.params.revision), promptObject(req.body as unknown, ["variables"]).variables, fence(req))));
  router.post("/:id/revisions", route([], req => registry.append(req.params.id, req.body as unknown, fence(req)), 201));
  router.delete("/:id", route(["expectedRevision"], req => registry.delete(req.params.id, number(req.query.expectedRevision), fence(req))));
  router.use((_req, _res, next) => next(new PromptRegistryError("not_found")));
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const parserStatus = error && typeof error === "object" && "status" in error ? Number(error.status) : 500;
    const expected = error instanceof PromptRegistryError;
    const status = expected ? error.status : [400, 413, 415].includes(parserStatus) ? parserStatus : 500;
    res.status(status).json({ error: expected ? error.message : status === 413 ? "Prompt request exceeds its limit." : "Prompt request failed." });
  });
  return router;
}
