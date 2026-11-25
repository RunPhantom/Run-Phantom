import { PLAYGROUND_LIMITS, emptyUsage, type PlaygroundCallResult, type PlaygroundError, type PlaygroundRunRequest, type PlaygroundTarget } from "./protocol";
import { ProviderStreamError, buildProviderRequest, classifyHttpError, createAccumulator, playgroundError, type ProviderRequest } from "./providers";
import { ResponseLimitError, readBoundedText, readSse } from "./sse";

export type PlaygroundFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ExecutedCall {
  result: Omit<PlaygroundCallResult, "runId" | "spanId">;
  /** Wall-clock bounds of the provider call, in epoch milliseconds. */
  startedAt: number;
  endedAt: number;
  /** Null when nothing was sent, so there is nothing to record. */
  sent: ProviderRequest["sent"] | null;
}

export interface ExecuteOptions {
  request: PlaygroundRunRequest;
  target: PlaygroundTarget;
  index: number;
  key: string | null;
  fetch: PlaygroundFetch;
  signal: AbortSignal;
  onDelta?: (text: string) => void;
  now?: () => number;
  timeoutMs?: number;
}

export async function executePlaygroundCall(options: ExecuteOptions): Promise<ExecutedCall> {
  const { request, target, index, key } = options;
  const now = options.now ?? Date.now;
  const base = { index, provider: target.provider, model: target.model };
  const startedAt = now();
  if (!key) {
    return {
      startedAt, endedAt: startedAt, sent: null,
      result: { ...base, status: "error", output: { text: "", toolCalls: [] }, finishReason: null, providerFinishReason: null, responseModel: null, responseId: null,
        usage: emptyUsage(), latencyMs: null, timeToFirstTokenMs: null, warnings: [], error: playgroundError("missing_key", target) },
    };
  }

  const providerRequest = buildProviderRequest(request, target, key);
  const accumulator = createAccumulator(target.provider);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? PLAYGROUND_LIMITS.callTimeoutMs);
  const signal = AbortSignal.any([options.signal, timeout.signal]);
  let firstTokenAt: number | null = null;
  let error: PlaygroundError | null = null;
  try {
    const response = await options.fetch(providerRequest.url, {
      method: "POST", headers: providerRequest.headers, body: JSON.stringify(providerRequest.body), signal, redirect: "error",
    });
    if (!response.ok) {
      const body = await readBoundedText(response, 64 * 1024);
      const classified = classifyHttpError(target.provider, response.status, body);
      error = playgroundError(classified.kind, target, { providerMessage: classified.providerMessage, httpStatus: response.status, key });
    } else if (!response.body) {
      error = playgroundError("invalid_response", target, { httpStatus: response.status });
    } else {
      for await (const event of readSse(response.body, PLAYGROUND_LIMITS.providerResponseBytes)) {
        const delta = accumulator.push(event);
        if (delta) {
          firstTokenAt ??= now();
          options.onDelta?.(delta);
        }
      }
    }
  } catch (cause) {
    if (timeout.signal.aborted) error = playgroundError("timeout", target);
    else if (options.signal.aborted) error = playgroundError("cancelled", target);
    else if (cause instanceof ProviderStreamError) error = playgroundError(cause.kind, target, { providerMessage: cause.providerMessage, key });
    else if (cause instanceof ResponseLimitError) error = playgroundError("response_limit", target);
    else if (cause instanceof TypeError || (cause instanceof Error && /fetch|network|socket|ECONN|ENOTFOUND|EAI_AGAIN/i.test(cause.message))) error = playgroundError("network", target, { providerMessage: cause instanceof Error ? cause.message : null, key });
    else error = playgroundError("invalid_response", target);
  } finally {
    clearTimeout(timer);
  }
  const endedAt = now();
  const accumulated = accumulator.result();
  if (!error && !accumulated.complete) error = playgroundError("invalid_response", target, { providerMessage: "The response stream ended before the provider marked it complete." });

  let text = accumulated.text;
  const warnings = [...providerRequest.warnings];
  if (text.length > PLAYGROUND_LIMITS.outputChars) {
    text = text.slice(0, PLAYGROUND_LIMITS.outputChars);
    warnings.push(`The output was longer than ${PLAYGROUND_LIMITS.outputChars} characters and was shortened.`);
  }
  // A provider that echoes the configured key must not get it stored in a trace.
  if (key && (text.includes(key) || JSON.stringify(accumulated.toolCalls).includes(key))) {
    text = text.split(key).join("[REDACTED]");
    accumulated.toolCalls = JSON.parse(JSON.stringify(accumulated.toolCalls).split(key).join("[REDACTED]"));
    warnings.push("The output contained the configured API key, which was redacted.");
  }

  return {
    startedAt, endedAt, sent: providerRequest.sent,
    result: {
      ...base,
      status: error ? "error" : "ok",
      output: { text, toolCalls: accumulated.toolCalls },
      finishReason: error ? "error" : accumulated.finishReason,
      providerFinishReason: accumulated.providerFinishReason,
      responseModel: accumulated.responseModel,
      responseId: accumulated.responseId,
      usage: accumulated.usage,
      latencyMs: Math.max(0, endedAt - startedAt),
      timeToFirstTokenMs: firstTokenAt === null ? null : Math.max(0, firstTokenAt - startedAt),
      warnings,
      error,
    },
  };
}
