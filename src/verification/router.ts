import express, { type Request, type Response, type NextFunction } from "express";
import { VerificationHttpError } from "./bridge";
import { VerificationInputError } from "./validation";
import type { VerificationService } from "./service";
import { deleteFlow, listFlows, listReports, saveFlow } from "./store";
import { VERIFICATION_LIMITS as L } from "./protocol";

function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VerificationHttpError(400, "JSON object required");
  const out = value as Record<string, unknown>;
  if (Object.keys(out).some((key) => !allowed.includes(key))) throw new VerificationHttpError(400, "Unexpected request field");
  return out;
}
function text(value: unknown, label: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || value.length > L.MAX_NAME_LENGTH) throw new VerificationHttpError(400, `${label} must be 1 to ${L.MAX_NAME_LENGTH} characters`);
  return value.trim();
}
function cursor(value: unknown, latest: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && !/^\d+$/.test(value)) throw new VerificationHttpError(400, "since must be a valid cursor");
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0 || number > latest) throw new VerificationHttpError(400, "since must be a cursor between zero and the current observation cursor");
  return number;
}

export function createVerificationRouter(service: VerificationService): express.Router {
  const router = express.Router();
  const route = (handler: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve().then(() => handler(req, res)).catch(next);
  };
  router.get("/sessions", route((_req, res) => res.json([...service.bridge.sessions.values()].map((s) => service.bridge.summary(s)))));
  router.post("/sessions", route((req, res) => {
    const body = object(req.body, ["origin", "runId"]);
    const result = service.bridge.create(body.origin, body.runId);
    const address = req.socket.localPort;
    const origin = `http://127.0.0.1:${address}`;
    res.status(201).json({ ...result, sdkUrl: `${origin}/verification/sdk.js`, wsUrl: `${origin.replace("http:", "ws:")}/verification/ws?sessionId=${result.id}` });
  }));
  router.delete("/sessions/:id", route((req, res) => { service.bridge.get(String(req.params.id)); service.bridge.remove(String(req.params.id)); res.json({ ok: true }); }));
  router.get("/sessions/:id/events", route((req, res) => {
    const session = service.bridge.get(String(req.params.id));
    const since = cursor(req.query.since, session.cursor) ?? session.generationCursor;
    res.json(service.bridge.observe(session, since));
  }));
  router.post("/sessions/:id/command", route(async (req, res) => res.json(await service.act(String(req.params.id), req.body))));
  router.post("/sessions/:id/assert", route(async (req, res) => {
    const body = object(req.body, ["predicate", "since", "name"]);
    const session = service.bridge.get(String(req.params.id));
    res.json(await service.assert(session.id, body.predicate, cursor(body.since, session.cursor), text(body.name, "name", "Application check")));
  }));
  router.get("/reports", route((req, res) => res.json(listReports(req.query.runId === undefined ? undefined : text(req.query.runId, "runId")))));
  router.get("/flows", route((_req, res) => res.json(listFlows())));
  router.post("/flows", route((req, res) => {
    const body = object(req.body, ["name", "origin", "steps"]);
    res.status(201).json(saveFlow(text(body.name, "name"), body.origin, body.steps));
  }));
  router.post("/flows/:id/run", route(async (req, res) => {
    const body = object(req.body, ["sessionId"]);
    res.json(await service.runFlow(String(req.params.id), text(body.sessionId, "sessionId")));
  }));
  router.delete("/flows/:id", route((req, res) => { deleteFlow(String(req.params.id)); res.json({ ok: true }); }));
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof VerificationHttpError || err instanceof VerificationInputError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: "Application verification failed" });
  });
  return router;
}
