/** The only provider summary the daemon will send, and only with matching consent in the request. */
export const PROVIDER_SUMMARY = { provider: "anthropic", providerLabel: "Anthropic", model: "claude-haiku-4-5-20251001", maxFieldChars: 1500, maxContentChars: 4500 } as const;
export interface ProviderSummaryConsent { provider: typeof PROVIDER_SUMMARY.provider; model: typeof PROVIDER_SUMMARY.model }
export type ProviderSummaryResult = { summary: string } | { summary: null; available: false; reason: "empty_content" | "consent_required" | "missing_provider_key" | "provider_error" | "provider_unavailable" };
export function hasProviderSummaryConsent(value: unknown): value is ProviderSummaryConsent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const consent = value as Record<string, unknown>;
  return Object.keys(consent).length === 2 && consent.provider === PROVIDER_SUMMARY.provider && consent.model === PROVIDER_SUMMARY.model;
}
