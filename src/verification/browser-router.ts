import express, { type Request, type Response, type NextFunction } from "express";
import { BrowserInputError, browserObject } from "./browser-contract";
import { VerificationInputError } from "./validation";
import { BrowserAutomation } from "./automation";

export function createBrowserRouter(automation: BrowserAutomation, controlPort: () => number): express.Router {
  const router = express.Router();
  const route = (handler: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
    const port = controlPort();
    automation.setControlOrigins(["localhost", "127.0.0.1", "[::1]"].flatMap(host => [`http://${host}:${port}`, `https://${host}:${port}`]));
    Promise.resolve().then(() => handler(req, res)).catch(next);
  };
  router.get("/status", route((_req, res) => res.json(automation.provider.status())));
  router.get("/sessions", route((_req, res) => res.json(automation.summaries())));
  router.post("/sessions", route(async (req, res) => res.status(201).json(await automation.open(req.body))));
  router.post("/attached-pages", route(async (req, res) => { browserObject(req.body, []); res.json(await automation.attachedPages()); }));
  router.post("/sessions/:id/select", route(async (req, res) => res.json(await automation.selectPage(req.params.id, req.body))));
  router.get("/sessions/:id/events", route((req, res) => {
    const query = browserObject(req.query, ["since"]);
    if (query.since !== undefined && (typeof query.since !== "string" || !/^\d{1,16}$/.test(query.since))) throw new BrowserInputError(400, "Valid observation cursor required");
    res.json(automation.observe(req.params.id, query.since === undefined ? undefined : Number(query.since)));
  }));
  router.post("/sessions/:id/action", route(async (req, res) => res.json(await automation.act(req.params.id, req.body))));
  router.post("/sessions/:id/check", route(async (req, res) => res.json(await automation.check(req.params.id, req.body))));
  router.post("/sessions/:id/capture", route(async (req, res) => res.status(201).json(await automation.capture(req.params.id, req.body))));
  for (const operation of ["close", "cancel"]) router.post(`/sessions/:id/${operation}`, route(async (req, res) => {
    const body = browserObject(req.body, ["generation"]); res.json(await automation.closeSession(req.params.id, body.generation));
  }));
  router.get("/artifacts", route((_req, res) => res.json(automation.artifacts.list())));
  router.get("/artifacts/:id", route((req, res) => res.json(automation.artifacts.metadata(req.params.id))));
  router.delete("/artifacts/:id", route((req, res) => { automation.artifacts.delete(req.params.id); res.json({ ok: true }); }));
  router.get("/artifacts/:id/content", route((req, res) => {
    const query = browserObject(req.query, ["rawConsent"]), meta = automation.artifacts.metadata(req.params.id);
    if (query.rawConsent !== undefined && query.rawConsent !== "true" || meta.raw && query.rawConsent !== "true") throw new BrowserInputError(400, "Private raw artifact access requires explicit consent");
    const bytes = automation.artifacts.read(req.params.id);
    res.set({ "Content-Type": meta.mime, "Content-Length": String(bytes.length), "Content-Disposition": `${meta.raw ? "attachment" : "inline"}; filename="${meta.id}.${meta.kind === "screenshot" ? "png" : "webm"}"`,
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'" }).send(bytes);
  }));
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof BrowserInputError || err instanceof VerificationInputError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: "Browser verification is unavailable" });
  });
  return router;
}
