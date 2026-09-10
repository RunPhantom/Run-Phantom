type ProviderResult = {
  body: Record<string, any>;
  headers: Record<string, string>;
};

export type ProviderId = "anthropic" | "openai" | "google" | "unknown";
export type SupportedProviderId = "anthropic" | "openai";

export class UnsupportedProviderError extends Error {
  readonly provider: string;

  constructor(provider: string) {
    super(`Unsupported provider: ${provider}`);
    this.name = "UnsupportedProviderError";
    this.provider = provider;
  }
}

export function isSupportedProvider(provider: string): provider is SupportedProviderId {
  return provider === "anthropic" || provider === "openai";
}

const providers: Record<SupportedProviderId, (opts: Record<string, any>) => ProviderResult> = {

  anthropic(opts) {
    const body: Record<string, any> = {};
    const headers: Record<string, string> = {};
    const betas: string[] = [];

    if (opts.thinking) {
      body.thinking = opts.thinking;
      betas.push("interleaved-thinking-2025-05-14");
    }
    if (opts.contextManagement || opts.context_management) {
      betas.push("context-management-2025-06-27");
    }
    if (opts.compact) {
      betas.push("compact-2026-01-12");
    }

    for (const [k, v] of Object.entries(opts)) {
      if (["thinking", "cacheControl", "contextManagement", "context_management", "compact"].includes(k)) continue;
      body[k] = v;
    }

    if (betas.length > 0) headers["anthropic-beta"] = betas.join(",");
    return { body, headers };
  },

  openai(opts) {
    const body: Record<string, any> = {};
    const headers: Record<string, string> = {};

    if (opts.reasoning_effort) body.reasoning_effort = opts.reasoning_effort;
    if (opts.store !== undefined) body.store = opts.store;
    if (opts.metadata) body.metadata = opts.metadata;
    if (opts.service_tier) body.service_tier = opts.service_tier;

    for (const [k, v] of Object.entries(opts)) {
      if (["reasoning_effort", "store", "metadata", "service_tier"].includes(k)) continue;
      body[k] = v;
    }

    return { body, headers };
  },

};

export function applyProviderOptions(
  providerOptions: Record<string, any> | undefined,
  requestBody: Record<string, any>,
  requestHeaders: Record<string, string>,
): void {
  if (!providerOptions) return;

  for (const [providerName, opts] of Object.entries(providerOptions)) {
    if (!opts || typeof opts !== "object") continue;

    if (!isSupportedProvider(providerName)) {
      throw new UnsupportedProviderError(providerName);
    }
    const { body, headers } = providers[providerName](opts);
    Object.assign(requestBody, body);

    for (const [hk, hv] of Object.entries(headers)) {
      if (hk === "anthropic-beta" && requestHeaders[hk]) {
        const existing = new Set(requestHeaders[hk].split(",").map(s => s.trim()));
        for (const b of hv.split(",")) existing.add(b.trim());
        requestHeaders[hk] = [...existing].join(",");
      } else {
        requestHeaders[hk] = hv;
      }
    }
  }
}

function providerFromText(value?: string | null): Exclude<ProviderId, "unknown"> | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("anthropic") || normalized.includes("claude")) return "anthropic";
  if (normalized.includes("openai") || normalized.includes("gpt") || /(?:^|[\s/_-])o[134](?:$|[\s/_-])/.test(normalized)) {
    return "openai";
  }
  if (normalized.includes("google") || normalized.includes("gemini")) return "google";
  return null;
}

export function detectProvider(model?: string | null, providerAttr?: string | null): ProviderId {
  if (providerAttr?.trim()) return providerFromText(providerAttr) ?? "unknown";
  return providerFromText(model) ?? "unknown";
}

export function getProviderBaseURL(provider: ProviderId, _traceBaseURL?: string | null): string {
  switch (provider) {
    case "anthropic": return "https://api.anthropic.com/v1/messages";
    case "openai": return "https://api.openai.com/v1/chat/completions";
    default: throw new UnsupportedProviderError(provider);
  }
}

export function getProviderHeaders(provider: ProviderId, apiKey: string): Record<string, string> {
  switch (provider) {
    case "anthropic":
      return {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      };
    case "openai":
      return {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      };
    default: throw new UnsupportedProviderError(provider);
  }
}
