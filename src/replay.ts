import { randomUUID } from "crypto";
import type { Response as ExpressResponse } from "express";
import { getRunWithSpans, upsertRun, updateRunMetadata, countReplaysBySource, findRecentRunByEventName, findRunByEventId, deleteRun, reassignAnnotations } from "./db";
import { getReplayTrace } from "./replay-map";
import { ensureAgentEndpointDetailed, extractContextFromTrace } from "./agents-config";
import type { NormalizedSpan } from "./spans/normalized";

export type ReplayMode = "local";

export interface ReplayConfig {
  sourceRunId: string;
  mode: ReplayMode;
  userMessage?: string;
  model?: string;
  systemPrompt?: string;
  apiKey?: string;
  openaiKey?: string;
  maxIterations?: number;
  contextOverrides?: Record<string, any>;
}

function canWriteSSE(res: ExpressResponse): boolean {
  return !res.writableEnded && !res.destroyed;
}

function sendSSE(res: ExpressResponse, event: string, data: any): boolean {
  if (!canWriteSSE(res)) return false;
  res.write(`data: ${JSON.stringify({ type: event, ...data })}\n\n`);
  return true;
}

const DEFAULT_REPLAY_TRACE_TIMEOUT_MS = 120_000;
const MAX_AGENT_RESPONSE_BYTES = 64 * 1024;

interface BoundedAgentResponse {
  status: string | null;
  code: string | null;
  failed: boolean;
  replayId: string | null;
}

async function readBoundedAgentResponse(response: globalThis.Response): Promise<BoundedAgentResponse> {
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AGENT_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Agent response is too large.");
  }
  if (!response.body) throw new Error("Agent response body is missing.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_AGENT_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("Agent response is too large.");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    throw new Error("Agent returned an invalid response.");
  }

  const status = typeof body.status === "string" && body.status.length <= 32
    ? body.status.toLowerCase()
    : null;
  const rawCode = typeof body.code === "string" ? body.code.toLowerCase() : "";
  const code = /^[a-z0-9][a-z0-9_-]{0,63}$/.test(rawCode) ? rawCode : null;
  const rawReplayId = typeof body.replayId === "string" ? body.replayId.trim() : "";
  const replayId = /^[a-z0-9][a-z0-9._:-]{0,199}$/i.test(rawReplayId) ? rawReplayId : null;
  return {
    status,
    code,
    failed: Boolean(body.error) || status === "error" || status === "failed",
    replayId,
  };
}

function agentReportedFailure(body: BoundedAgentResponse): { code: string; message: string } | null {
  if (!body.failed) return null;
  return {
    code: body.code ?? "agent_replay_failed",
    message: "Agent reported that replay failed.",
  };
}

function waitForReplayPoll(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function generateReplayRunId(): string {
  return randomUUID();
}

function missingAgentEndpointMessage(eventName: string): string {
  const suffix = eventName ? ` for "${eventName}"` : "";
  return `No local replay agent endpoint found${suffix}. Run /setup-agent-replay in the agent repo, then retry replay.`;
}

/**
 * Pull the conversation context out of a recorded run so we can replay it.
 *
 * Reads from the SDK-agnostic typed view that `getRunWithSpans` attaches to
 * every span via the adapter dispatcher (`src/spans/`); this function only
 * picks the most informative LLM span and reads its fields.
 */
function extractContext(spans: any[]) {
  const allLLMs = spans.filter((s: any) => s.span_type?.includes("LLM"));

  // Pick the LLM span with the longest serialized input — that's almost
  // always the most-recent turn (longest history) and gives the LLM the
  // richest context to continue from.
  const best = allLLMs.reduce(
    (b: any, s: any) => !b || (s.input_payload?.length ?? 0) > (b.input_payload?.length ?? 0) ? s : b,
    null,
  );

  const normalized: NormalizedSpan | undefined = best?.normalized;
  const view = normalized?.kind === "llm" ? normalized : null;

  // Cast to `any[]` for the AI SDK consumer below — `streamText` accepts a
  // tight `ModelMessage` discriminated union that our role-as-string view
  // can't satisfy structurally. The runtime values (string roles + string
  // content) are exactly what `ModelMessage` accepts; the typing gap is
  // purely a TS narrowing limitation. `prepareMessages` and the AI SDK
  // itself enforce the shape from here on.
  const messages = (view?.messages.map((m) => ({ role: m.role, content: m.content })) ?? []) as any[];

  return {
    systemPrompt: view?.systemPrompt && view.systemPrompt.length > 0
      ? view.systemPrompt
      : "You are a helpful assistant.",
    messages,
    model: best?.model ?? view?.model ?? null,
    providerOptions: view?.providerOptions as any,
  };
}

function isReplayProviderMessage(message: any): boolean {
  if (!message || typeof message !== "object") return false;
  if (message.role === "tool") {
    return Array.isArray(message.content) && message.content.length > 0;
  }
  const isProviderRole = message.role === "system" || message.role === "user" || message.role === "assistant";
  return isProviderRole && typeof message.content === "string" && message.content.length > 0;
}

function prepareMessages(ctx: ReturnType<typeof extractContext>, userMessage?: string) {
  const allMessages = [...ctx.messages].filter(isReplayProviderMessage);
  let lastUserIdx = -1;
  for (let i = allMessages.length - 1; i >= 0; i--) {
    if (allMessages[i].role === "user") {
      const content = allMessages[i].content;
      const isToolResult = Array.isArray(content) && content.every((c: any) => c.type === "tool_result");
      if (!isToolResult) { lastUserIdx = i; break; }
    }
  }

  if (lastUserIdx >= 0) {
    const messages = allMessages.slice(0, lastUserIdx + 1);
    if (userMessage) messages[messages.length - 1] = { role: "user", content: userMessage };
    return messages;
  }
  return userMessage ? [{ role: "user", content: userMessage }] : allMessages;
}

function setupReplay(config: ReplayConfig, sourceRun: any, broadcast: (event: string, data: any) => void) {
  const sourceRunAny = sourceRun as any;
  const sourceEventName = (sourceRunAny.event_name ?? "unknown").replace(/^replay:/, "");
  const replayEventName = `replay:${sourceEventName}`;
  const replayRunId = generateReplayRunId();
  const now = Date.now();
  const replayCount = countReplaysBySource(config.sourceRunId) + 1;

  const replayName = `Replay of ${sourceEventName}-${config.sourceRunId.slice(0, 4)} (#${replayCount})`;

  // Create a placeholder run in DB so the URL the UI navigates to (`/runs/<replayRunId>`)
  // always resolves to something. If stitching to the agent's OTLP run succeeds
  // (the common case), we'll redirect the UI to that run on `replay_complete`.
  // If stitching fails — agent crashed before any span shipped, agent didn't echo
  // replayRunId back, etc. — the user lands on an empty placeholder row instead
  // of a "Run not found" wall.
  upsertRun({
    id: replayRunId,
    name: replayName,
    event_name: replayEventName,
    started_at: now,
    last_updated_at: now,
    metadata: JSON.stringify({ replay: { sourceRunId: config.sourceRunId, mode: config.mode, model: config.model ?? null, overrides: { model: !!config.model, systemPrompt: !!config.systemPrompt } } }),
  });
  broadcast("spans", { runIds: [replayRunId] });

  return { replayRunId, replayEventName, sourceEventName, replayName, now };
}

function recordPlaceholderError(
  replayRunId: string,
  config: ReplayConfig,
  error: { code: string; message: string; status?: number },
  broadcast?: (event: string, data: any) => void,
): void {
  updateRunMetadata(replayRunId, JSON.stringify({
    replay: {
      sourceRunId: config.sourceRunId,
      mode: config.mode,
      model: config.model ?? null,
      overrides: { model: !!config.model, systemPrompt: !!config.systemPrompt },
      error: { ...error, at: Date.now() },
    },
  }));
  // RunDetail listens for "spans" and refetches when its runId matches.
  broadcast?.("spans", { runIds: [replayRunId] });
}

export function promoteLocalReplayRun(args: {
  placeholderRunId: string;
  otlpRunId: string;
  replayMetadata: string;
  replayName: string;
}): string {
  const otlpRun = getRunWithSpans(args.otlpRunId).run as any;
  if (!otlpRun) return args.placeholderRunId;

  updateRunMetadata(args.otlpRunId, args.replayMetadata);
  upsertRun({
    id: args.otlpRunId,
    name: args.replayName,
    started_at: otlpRun.started_at,
    last_updated_at: otlpRun.last_updated_at,
  });
  if (args.placeholderRunId !== args.otlpRunId) {
    // Ordering matters: deleteRun removes the run's annotations, so anything the
    // user flagged on the placeholder during the replay has to be moved first.
    reassignAnnotations(args.placeholderRunId, args.otlpRunId);
    deleteRun(args.placeholderRunId);
  }
  return args.otlpRunId;
}

async function runLocalAgentReplay(
  config: ReplayConfig,
  res: ExpressResponse,
  broadcast: (event: string, data: any) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { run: sourceRun, spans: sourceSpans } = getRunWithSpans(config.sourceRunId);
  if (!sourceRun) {
    sendSSE(res, "error", { code: "source_run_not_found", message: "Source run not found" });
    res.end();
    return;
  }

  // Checked before the agent lookup: whether this trace can be replayed at all is
  // a property of the trace, and telling someone to go configure an agent for a
  // run that could never be replayed sends them down the wrong path.
  //
  // With no LLM span there are no messages, and extractContext substitutes a
  // generic system prompt for the one it could not find — so the replay would
  // run an empty conversation under an invented prompt and return something that
  // looks like a replay of this trace but has nothing to do with it.
  const ctx = extractContext(sourceSpans);
  const messages = prepareMessages(ctx, config.userMessage);
  if (messages.length === 0) {
    sendSSE(res, "error", {
      code: "no_replayable_context",
      message: "This run has no LLM span to replay. Run Phantom replays a recorded model call, and this trace contains none — record a run that includes one, or supply a message to replay with.",
      suggestedAction: "Replay a run containing an LLM span, or provide userMessage.",
    });
    res.end();
    return;
  }

  const sourceRunAny = sourceRun as any;
  const eventName = (sourceRunAny.event_name ?? "").replace(/^replay:/, "");
  const endpoint = await ensureAgentEndpointDetailed(eventName);
  if (signal?.aborted) {
    if (canWriteSSE(res)) res.end();
    return;
  }
  const agentConfig = endpoint.config;
  if (!agentConfig?.url) {
    if (endpoint.registered) {
      sendSSE(res, "error", {
        code: "replay_agent_start_failed",
        setupRequired: false,
        eventName,
        message:
          `Registered replay agent "${eventName}" was found, but Run Phantom could not reach its /health endpoint` +
          (endpoint.attemptedStart && endpoint.command ? ` after starting \`${endpoint.command}\`` : "") +
          ".",
        suggestedAction: endpoint.logPath
          ? `Check ${endpoint.logPath}, then retry replay.`
          : "Start the replay server manually, then retry replay.",
        command: endpoint.command,
        cwd: endpoint.cwd,
        logPath: endpoint.logPath,
        attemptedStart: endpoint.attemptedStart,
      });
      res.end();
      return;
    }
    sendSSE(res, "error", {
      code: "missing_replay_agent",
      setupRequired: true,
      eventName,
      message: missingAgentEndpointMessage(eventName),
      suggestedAction: "Run /setup-agent-replay in the agent repo.",
    });
    res.end();
    return;
  }

  const { replayRunId, replayEventName, replayName, now } = setupReplay(config, sourceRun, broadcast);
  sendSSE(res, "replay_started", { replayRunId, sourceRunId: config.sourceRunId, mode: "local" });

  // Extract agent-specific context from trace, then apply overrides
  const prefillMapping = agentConfig.prefillFromTrace;
  const agentContext = prefillMapping
    ? extractContextFromTrace(sourceSpans, prefillMapping)
    : {};
  if (config.contextOverrides) Object.assign(agentContext, config.contextOverrides);

  let agentError = false;
  let replayCancelled = false;
  let agentReplayId: string | null = null;

  const markCancelled = () => {
    if (replayCancelled) return;
    replayCancelled = true;
    const message = "Replay was cancelled because the client disconnected.";
    recordPlaceholderError(replayRunId, config, { code: "replay_cancelled", message }, broadcast);
    sendSSE(res, "error", { code: "replay_cancelled", message, replayRunId });
  };

  try {
    sendSSE(res, "llm_start", { iteration: 1 });

    const agentResp = await fetch(agentConfig.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        sourceRunId: config.sourceRunId,
        replayRunId,
        messages,
        systemPrompt: config.systemPrompt ?? ctx.systemPrompt,
        userMessage: config.userMessage,
        model: config.model,
        providerOptions: ctx.providerOptions,
        context: agentContext,
      }),
    });

    if (signal?.aborted) {
      await agentResp.body?.cancel().catch(() => {});
      markCancelled();
    } else if (!agentResp.ok) {
      // The POST /replay contract lets the agent explain why it refused, and that
      // explanation was thrown away with the body — so every agent-side failure
      // read as the same bare status line and the actual reason never reached the
      // person trying to fix it.
      let agentDetail: string | null = null;
      try {
        const raw = await agentResp.text();
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            const candidate = parsed?.message ?? parsed?.error ?? parsed?.detail;
            agentDetail = typeof candidate === "string" && candidate ? candidate : raw;
          } catch {
            agentDetail = raw;
          }
        }
      } catch { /* body unreadable; the status alone still tells the user something */ }
      if (agentDetail && agentDetail.length > 500) agentDetail = `${agentDetail.slice(0, 500)}…`;
      const message = agentDetail
        ? `Agent endpoint returned HTTP ${agentResp.status}: ${agentDetail}`
        : `Agent endpoint returned HTTP ${agentResp.status}.`;
      recordPlaceholderError(replayRunId, config, { code: "agent_http_error", message, status: agentResp.status }, broadcast);
      sendSSE(res, "error", { code: "agent_http_error", status: agentResp.status, message, agentMessage: agentDetail });
      agentError = true;
    } else {
      let body: BoundedAgentResponse | null = null;
      try {
        body = await readBoundedAgentResponse(agentResp);
      } catch {
        if (signal?.aborted) {
          markCancelled();
        } else {
          const message = "Agent endpoint returned an invalid or oversized response.";
          recordPlaceholderError(replayRunId, config, { code: "agent_bad_response", message }, broadcast);
          sendSSE(res, "error", { code: "agent_bad_response", message });
          agentError = true;
        }
      }
      if (!agentError && !replayCancelled && body) {
        const failure = agentReportedFailure(body);
        if (failure) {
          recordPlaceholderError(replayRunId, config, failure, broadcast);
          sendSSE(res, "error", failure);
          agentError = true;
        } else {
          agentReplayId = body.replayId;
          sendSSE(res, "agent_started", { replayId: agentReplayId });
        }
      }
    }
  } catch {
    if (signal?.aborted) {
      markCancelled();
    } else {
      const message = "Run Phantom could not reach the replay agent endpoint.";
      recordPlaceholderError(replayRunId, config, { code: "agent_unreachable", message }, broadcast);
      sendSSE(res, "error", { code: "agent_unreachable", message });
      agentError = true;
    }
  }

  if (!agentError && !replayCancelled) {
    // Poll the replay map for the real OTLP run ID.
    // The agent sends traces with replayRunId in metadata; when the first
    // batch arrives, the ingest handler records the mapping.
    const maxWaitMs = DEFAULT_REPLAY_TRACE_TIMEOUT_MS;
    const pollMs = 500;
    const deadline = Date.now() + maxWaitMs;
    let otlpRunId: string | undefined;

    while (Date.now() < deadline && !signal?.aborted) {
      if (!await waitForReplayPoll(pollMs, signal)) break;
      otlpRunId = getReplayTrace(replayRunId) ?? findRunByEventId(replayRunId)?.id;
      if (otlpRunId) break;
    }

    if (signal?.aborted) {
      markCancelled();
    } else if (otlpRunId) {
      const replayMeta = JSON.stringify({
        replay: { sourceRunId: config.sourceRunId, mode: config.mode, model: config.model ?? null, overrides: { model: !!config.model, systemPrompt: !!config.systemPrompt } },
      });
      const finalRunId = promoteLocalReplayRun({
        placeholderRunId: replayRunId,
        otlpRunId,
        replayMetadata: replayMeta,
        replayName,
      });
      broadcast("spans", { runIds: [finalRunId] });
      sendSSE(res, "replay_complete", { replayRunId: finalRunId, iterations: 0, toolCallCount: 0, matchStats: { exact: 0, ordered: 0, name_only: 0, fallback: 0 } });
    } else {
      // Fallback: try the old event-name heuristic.
      const otlpRun = findRecentRunByEventName(replayEventName, now - 5000, replayRunId);
      let finalRunId = replayRunId;
      if (otlpRun) {
        const replayMeta = JSON.stringify({
          replay: { sourceRunId: config.sourceRunId, mode: config.mode, model: config.model ?? null, overrides: { model: !!config.model, systemPrompt: !!config.systemPrompt } },
        });
        // Same promotion as the primary path, which also moves annotations off the
        // placeholder and deletes it. Hand-rolling it here left a zero-span replay
        // row behind on every fallback stitch, with no error and no way to tell it
        // from a replay that genuinely produced nothing.
        finalRunId = promoteLocalReplayRun({
          placeholderRunId: replayRunId,
          otlpRunId: otlpRun.id,
          replayMetadata: replayMeta,
          replayName,
        });
        broadcast("spans", { runIds: [finalRunId] });
        sendSSE(res, "replay_complete", { replayRunId: finalRunId, iterations: 0, toolCallCount: 0, matchStats: { exact: 0, ordered: 0, name_only: 0, fallback: 0 } });
      } else {
        const message = `Agent accepted replay${agentReplayId ? ` ${agentReplayId}` : ""}, but Run Phantom did not receive a replay trace within ${Math.round(maxWaitMs / 1000)}s.`;
        recordPlaceholderError(replayRunId, config, { code: "replay_timeout", message }, broadcast);
        sendSSE(res, "error", {
          code: "replay_timeout",
          message,
          replayRunId,
          replayId: agentReplayId,
        });
      }
    }
  }

  if (canWriteSSE(res)) res.end();
}

export async function runReplay(
  config: ReplayConfig,
  res: ExpressResponse,
  broadcast: (event: string, data: any) => void,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  return runLocalAgentReplay(config, res, broadcast, options.signal);
}

export const _internal = {
  generateReplayRunId,
  prepareMessages,
  recordPlaceholderError,
  readBoundedAgentResponse,
  agentReportedFailure,
  waitForReplayPoll,
};
