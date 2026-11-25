import { getEnvSecret, getStoredSecret } from "./secret-store";
import { classifyHttpError, sanitizeProviderMessage } from "./playground/providers";
import {
  PROVIDER_CHECK_TIMEOUT_MS,
  PROVIDER_MODELS_ENDPOINT,
  type ProviderCheckFailure,
  type ProviderCheckResult,
  type ProviderId,
} from "./provider-connection-protocol";

export type ProviderCheckFetch = (url: string, init: RequestInit) => Promise<Response>;

const LABEL: Record<ProviderId, string> = { openai: "OpenAI", anthropic: "Anthropic", gemini: "Google Gemini" };

function headers(provider: ProviderId, key: string): Record<string, string> {
  if (provider === "openai") return { Authorization: `Bearer ${key}` };
  if (provider === "anthropic") return { "x-api-key": key, "anthropic-version": "2023-06-01" };
  return { "x-goog-api-key": key };
}

function failureMessage(provider: ProviderId, failure: ProviderCheckFailure, status: number | null): string {
  const label = LABEL[provider];
  switch (failure) {
    case "missing_key": return `No ${label} key is saved or set in the environment.`;
    case "auth": return `${label} rejected this key${status ? ` (HTTP ${status})` : ""}. Paste a new key to replace it.`;
    case "quota": return `${label} accepted the key, but the account has no credit or quota left.`;
    case "rate_limit": return `${label} is rate limiting this key. Try again in a minute.`;
    case "overloaded": return `${label} is temporarily unavailable. Try again shortly.`;
    case "timeout": return `${label} did not answer within ${PROVIDER_CHECK_TIMEOUT_MS / 1000} seconds.`;
    case "network": return `Could not reach ${label}. Check this machine's network connection.`;
    case "provider_error": return `${label} returned an unexpected error${status ? ` (HTTP ${status})` : ""}.`;
  }
}

function countModels(provider: ProviderId, body: unknown): { count: number | null; complete: boolean } {
  if (!body || typeof body !== "object") return { count: null, complete: false };
  const record = body as Record<string, unknown>;
  const list = provider === "gemini" ? record.models : record.data;
  if (!Array.isArray(list)) return { count: null, complete: false };
  const more = provider === "anthropic" ? record.has_more === true : provider === "gemini" ? typeof record.nextPageToken === "string" && record.nextPageToken.length > 0 : false;
  return { count: list.length, complete: !more };
}

/** Tests the effective key (environment first, then the saved key) with one models-list request. Never throws. */
export async function checkProviderConnection(provider: ProviderId, options: { fetch?: ProviderCheckFetch; now?: () => number } = {}): Promise<ProviderCheckResult> {
  const now = options.now ?? Date.now;
  const env = getEnvSecret(provider);
  const stored = env ? null : getStoredSecret(provider);
  const key = env?.value ?? stored;
  const source = env ? "env" : stored ? "store" : null;
  const base = { provider, source, checkedAt: now(), modelCount: null, modelCountComplete: false, httpStatus: null, providerMessage: null } as const;
  if (!key) return { ...base, ok: false, latencyMs: null, failure: "missing_key", message: failureMessage(provider, "missing_key", null) };

  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(PROVIDER_MODELS_ENDPOINT[provider], {
      method: "GET",
      headers: headers(provider, key),
      signal: AbortSignal.timeout(PROVIDER_CHECK_TIMEOUT_MS),
    });
  } catch (cause) {
    const failure: ProviderCheckFailure = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError") ? "timeout" : "network";
    return { ...base, ok: false, latencyMs: elapsed(), failure, message: failureMessage(provider, failure, null) };
  }
  const text = await response.text().catch(() => "");
  const latencyMs = elapsed();
  if (!response.ok) {
    const classified = classifyHttpError(provider, response.status, text);
    const failure: ProviderCheckFailure = classified.kind === "auth" || classified.kind === "quota" || classified.kind === "rate_limit" || classified.kind === "overloaded" || classified.kind === "timeout"
      ? classified.kind : "provider_error";
    return {
      ...base, ok: false, latencyMs, failure, httpStatus: response.status,
      message: failureMessage(provider, failure, response.status),
      providerMessage: sanitizeProviderMessage(classified.providerMessage, key),
    };
  }
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* counted as unknown below */ }
  const { count, complete } = countModels(provider, body);
  const listed = count === null ? "" : ` and listed ${count}${complete ? "" : "+"} ${count === 1 && complete ? "model" : "models"}`;
  return {
    ...base, ok: true, latencyMs, failure: null, httpStatus: response.status, modelCount: count, modelCountComplete: count !== null && complete,
    message: `${LABEL[provider]} accepted the key${listed}.`,
  };
}
