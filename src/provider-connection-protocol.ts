export type ProviderId = "openai" | "anthropic" | "gemini";

export type ProviderCheckFailure = "missing_key" | "auth" | "quota" | "rate_limit" | "overloaded" | "timeout" | "network" | "provider_error";

export interface ProviderCheckResult {
  provider: ProviderId;
  ok: boolean;
  /** Where the key that was tested came from; the environment wins over the saved key. */
  source: "env" | "store" | null;
  checkedAt: number;
  latencyMs: number | null;
  /** Models the key could list in the first page of the provider's models endpoint. */
  modelCount: number | null;
  /** False when the provider said more pages exist, so `modelCount` is a lower bound. */
  modelCountComplete: boolean;
  failure: ProviderCheckFailure | null;
  message: string;
  httpStatus: number | null;
  /** The provider's own error text with anything shaped like a key removed. */
  providerMessage: string | null;
  /** Set when this is an earlier answer reused inside the cooldown rather than a new request. */
  reusedUntil?: number;
}

export const PROVIDER_CHECK_TIMEOUT_MS = 10_000;

/**
 * Repeat checks of the same key inside this window reuse the last answer, so repeated clicks or a script
 * cannot push the user's key into provider rate limits that would then hit Playground and Ask Agent calls.
 */
export const PROVIDER_CHECK_COOLDOWN_MS = 15_000;

/**
 * Every provider check is a single GET to the provider's models list, which none of the three providers bill for.
 * Keys never go in the URL; each provider gets them in a header.
 */
export const PROVIDER_MODELS_ENDPOINT: Readonly<Record<ProviderId, string>> = Object.freeze({
  openai: "https://api.openai.com/v1/models",
  anthropic: "https://api.anthropic.com/v1/models?limit=1000",
  gemini: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
});

const KEY_PREFIXES = ["sk-ant-", "sk-proj-", "sk-svcacct-", "sk-", "AIza"] as const;

/** "sk-proj-…Ab3d": enough to tell two keys apart, never enough to use one. Short values show no characters. */
export function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 16) return "••••";
  const prefix = KEY_PREFIXES.find(item => trimmed.startsWith(item)) ?? "";
  return `${prefix}…${trimmed.slice(-4)}`;
}
