import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { draftFromSpan, DraftUnavailableError, type DraftSpanInput } from "./draft";
import { executePlaygroundCall, type PlaygroundFetch } from "./execute";
import {
  PLAYGROUND_DEFAULT_MODEL, PLAYGROUND_LIMITS, PLAYGROUND_MODELS, PLAYGROUND_PROVIDERS, PlaygroundRequestError, parsePlaygroundRunRequest,
  type PlaygroundCallResult, type PlaygroundProvider, type PlaygroundRunRequest,
} from "./protocol";
import { PROVIDER_LABEL } from "./providers";
import { buildPlaygroundOtlp, newSpanId, newTraceId } from "./trace";

export interface PlaygroundRouterDeps {
  resolveKey(provider: PlaygroundProvider): string | null;
  /** `envVar` names the variable a key is read from when `source` is "env"; never the value. */
  keyStatus(provider: PlaygroundProvider): { source: "env" | "store" | null; envVar: string | null };
  /** Ingests an OTLP/JSON export through the daemon's normal trace path. */
  recordOtlp(body: Record<string, unknown>): void;
  getSpan(spanId: string, runId?: string): DraftSpanInput | null;
  getRunName(runId: string): string | null;
  fetch?: PlaygroundFetch;
}

const SPAN_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Mount behind the daemon's local access and origin guards, before its global JSON parser. */
export function createPlaygroundRouter(deps: PlaygroundRouterDeps): express.Router {
  const router = express.Router();
  const providerFetch: PlaygroundFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  let callsInFlight = 0;

  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "POST" && !req.is("application/json")) { res.status(415).json({ error: "The Playground accepts JSON request bodies only." }); return; }
    next();
  });
  router.use(express.json({ limit: PLAYGROUND_LIMITS.requestBytes, strict: true }));

  router.get("/models", (_req, res) => {
    res.json({
      providers: PLAYGROUND_PROVIDERS.map(provider => {
        const { source, envVar } = deps.keyStatus(provider);
        return {
          id: provider, label: PROVIDER_LABEL[provider], configured: source !== null, keySource: source, keyEnvVar: source === "env" ? envVar : null,
          defaultModel: PLAYGROUND_DEFAULT_MODEL[provider],
          models: PLAYGROUND_MODELS.filter(item => item.provider === provider).map(item => ({ id: item.model, label: item.label, temperature: item.temperature, maxTemperature: item.maxTemperature, reasoningEffort: item.reasoningEffort })),
        };
      }),
      limits: {
        targets: PLAYGROUND_LIMITS.targets, concurrentCalls: PLAYGROUND_LIMITS.concurrentCalls, messages: PLAYGROUND_LIMITS.messages, systemChars: PLAYGROUND_LIMITS.systemChars, messageChars: PLAYGROUND_LIMITS.messageChars,
        totalTextChars: PLAYGROUND_LIMITS.totalTextChars, tools: PLAYGROUND_LIMITS.tools, defaultMaxOutputTokens: PLAYGROUND_LIMITS.defaultMaxOutputTokens,
        maxOutputTokens: PLAYGROUND_LIMITS.maxOutputTokens, callTimeoutMs: PLAYGROUND_LIMITS.callTimeoutMs, requestBytes: PLAYGROUND_LIMITS.requestBytes,
      },
    });
  });

  router.get("/draft-from-span/:spanId", (req, res) => {
    const spanId = req.params.spanId;
    const runId = typeof req.query.run_id === "string" && req.query.run_id ? req.query.run_id : undefined;
    if (!SPAN_ID.test(spanId) || (runId !== undefined && !SPAN_ID.test(runId))) { res.status(400).json({ error: "Span and run ids may contain only letters, digits, and _ . : -" }); return; }
    const span = deps.getSpan(spanId, runId);
    if (!span) { res.status(404).json({ error: "Span not found" }); return; }
    try {
      res.json(draftFromSpan(span, deps.getRunName(span.run_id)));
    } catch (error) {
      if (error instanceof DraftUnavailableError) { res.status(error.status).json({ error: error.message }); return; }
      throw error;
    }
  });

  router.post("/runs", (req, res, next) => { void runPlayground(req, res).catch(next); });

  async function runPlayground(req: Request, res: Response): Promise<void> {
    let request: PlaygroundRunRequest;
    try {
      request = parsePlaygroundRunRequest(req.body);
    } catch (error) {
      if (error instanceof PlaygroundRequestError) { res.status(error.status).json({ error: error.message }); return; }
      throw error;
    }
    if (callsInFlight + request.targets.length > PLAYGROUND_LIMITS.concurrentCalls) {
      res.status(429).json({ error: `The Playground is already running ${callsInFlight} model calls. Wait for them to finish, then try again.` });
      return;
    }
    callsInFlight += request.targets.length;
    try {
      await runTargets(request, res);
    } finally {
      callsInFlight -= request.targets.length;
    }
  }

  async function runTargets(request: PlaygroundRunRequest, res: Response): Promise<void> {
    const comparisonId = randomUUID();
    const cancel = new AbortController();
    // `close` on the response fires when the client goes away before we finish, including after the request body was read.
    res.on("close", () => { if (!res.writableFinished) cancel.abort(); });

    const streaming = request.stream;
    const send = (event: string, data: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    if (streaming) {
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      send("start", { comparisonId, targets: request.targets.map((target, index) => ({ index, ...target })) });
    }

    const results = await Promise.all(request.targets.map(async (target, index): Promise<PlaygroundCallResult> => {
      const key = deps.resolveKey(target.provider);
      const { source, envVar } = deps.keyStatus(target.provider);
      const executed = await executePlaygroundCall({
        request, target, index, key, keyOrigin: source ? { source, envVar: source === "env" ? envVar : null } : null, fetch: providerFetch, signal: cancel.signal,
        onDelta: streaming ? text => send("delta", { index, text }) : undefined,
      });
      let runId: string | null = null, spanId: string | null = null;
      if (executed.sent) {
        const ids = { traceId: newTraceId(), rootSpanId: newSpanId(), llmSpanId: newSpanId() };
        try {
          deps.recordOtlp(buildPlaygroundOtlp({ request, target, call: executed, comparisonId, ids }));
          runId = ids.traceId; spanId = ids.llmSpanId;
        } catch (error) {
          console.error("[runphantom] Playground trace could not be recorded:", error instanceof Error ? error.message : String(error));
          executed.result.warnings.push("The call finished but could not be recorded as a run.");
        }
      }
      const result: PlaygroundCallResult = { ...executed.result, runId, spanId };
      if (streaming) send("result", result);
      return result;
    })).catch((error: unknown) => {
      console.error("[runphantom] Playground request failed:", error instanceof Error ? error.message : String(error));
      return null;
    });

    if (results === null) {
      if (streaming) { send("error", { error: "The Playground request failed." }); res.end(); }
      else if (!res.headersSent) res.status(500).json({ error: "The Playground request failed." });
      return;
    }
    if (streaming) { send("done", { comparisonId }); res.end(); return; }
    if (!res.destroyed) res.json({ comparisonId, results });
  }

  router.use((_req, res) => { res.status(404).json({ error: "Not found" }); });
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = error && typeof error === "object" && "status" in error ? Number((error as { status: unknown }).status) : 500;
    if (res.headersSent) { res.end(); return; }
    if (status === 413) { res.status(413).json({ error: `The Playground request is larger than ${PLAYGROUND_LIMITS.requestBytes / 1024} KB.` }); return; }
    if (status === 400) { res.status(400).json({ error: "invalid JSON body" }); return; }
    res.status(500).json({ error: "The Playground request failed." });
  });
  return router;
}
