import { calculateCost } from "./calculator";
import { PRICING_VERSION, TOKEN_CATEGORIES, type CategoryRate, type FrozenRateRevision, type TokenCategory } from "./protocol";
import { freezeRateRevision } from "./rates";
import { normalizeUsage, validTokenCount } from "./usage";

/**
 * Bundled, offline list prices for first-party OpenAI, Anthropic and Google
 * Gemini text generation, in USD per million tokens (standard tier, no batch,
 * no data-residency or regional multiplier). Every row was read from the
 * provider's official pricing page on PRICE_TABLE_AS_OF:
 *
 * - OpenAI: https://developers.openai.com/api/docs/pricing (Standard tier
 *   text tokens; "Short: <=272K input tokens" / "Long: >272K"; cached input).
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 *   (Model pricing table; cache hits 0.1x base input, 0.05x on Opus 5.5 and
 *   Sonnet 5.5; 5-minute cache writes 1.25x, 1-hour writes 2x; Haiku 5.5 is
 *   priced by prompt length over 100,000 tokens, counting cache reads and
 *   writes).
 * - Google: https://aistudio.google.com/docs/pricing (the former
 *   ai.google.dev/gemini-api/docs/pricing URL redirects here; Paid tier, text
 *   input and context caching; Pro models change price for prompts over
 *   200k tokens).
 *
 * Input, output and cached input are priced. Cache storage, audio and image
 * tokens, tool fees (web search, grounding) and discounts are excluded, so
 * every figure produced from this table is an estimate. Gemini output prices
 * include thinking tokens; an estimate counts them only when the
 * instrumentation reports them inside output tokens.
 */
export const PRICE_TABLE_AS_OF = "2026-11-25";
export const PRICE_TABLE_REVISION = `runphantom-list-prices/${PRICE_TABLE_AS_OF}`;
export const LIST_PRICE_PROVIDER = "runphantom-list-prices";
export const LIST_PRICE_TIER = "list-input-output";

export const PRICE_SOURCES = Object.freeze({
  openai: { name: "OpenAI API pricing", url: "https://developers.openai.com/api/docs/pricing" },
  anthropic: { name: "Anthropic Claude API pricing", url: "https://platform.claude.com/docs/en/about-claude/pricing" },
  google: { name: "Google Gemini API pricing", url: "https://aistudio.google.com/docs/pricing" },
} as const);
export type PriceFamily = keyof typeof PRICE_SOURCES;

interface PriceBand { readonly maxPromptTokens: number | null; readonly input: number; readonly output: number }
export interface ListPriceEntry {
  readonly family: PriceFamily;
  readonly model: string;
  /** Exact ids the provider reports for this price, such as dated snapshots. */
  readonly aliases?: readonly string[];
  /** Snapshots that share this id's prefix but were priced differently; never matched by suffix stripping. */
  readonly excludedSnapshots?: readonly string[];
  readonly bands: readonly PriceBand[];
  /**
   * Cache-hit price as a fraction of each band's input price, read from the
   * provider page; absent when the page lists no cached-input price.
   */
  readonly cachedInputRatio?: number;
  /** Exclusive end of this price, from the provider's announced change; later calls are unpriced. */
  readonly effectiveUntil?: string;
}

const flat = (input: number, output: number): PriceBand[] => [{ maxPromptTokens: null, input, output }];
const tiered = (threshold: number, low: [number, number], high: [number, number]): PriceBand[] =>
  [{ maxPromptTokens: threshold, input: low[0], output: low[1] }, { maxPromptTokens: null, input: high[0], output: high[1] }];

export const LIST_PRICES: readonly ListPriceEntry[] = Object.freeze([
  { family: "openai", model: "gpt-6.2-astra", bands: tiered(272_000, [8, 40], [16, 60]), cachedInputRatio: 0.05 },
  { family: "openai", model: "gpt-6.2-sol", bands: tiered(272_000, [2, 10], [4, 15]), cachedInputRatio: 0.05 },
  { family: "openai", model: "gpt-6.1-sol", bands: tiered(272_000, [2, 10], [4, 15]), cachedInputRatio: 0.05 },
  { family: "openai", model: "gpt-6.1-terra", bands: tiered(272_000, [1, 5], [2, 7.5]), cachedInputRatio: 0.05 },
  { family: "openai", model: "gpt-6-astra", bands: tiered(272_000, [10, 50], [20, 75]), cachedInputRatio: 0.1 },
  { family: "openai", model: "gpt-6-sol", bands: tiered(272_000, [2, 10], [4, 15]), cachedInputRatio: 0.1 },
  { family: "openai", model: "gpt-6-luna", bands: tiered(272_000, [0.1, 0.5], [0.2, 0.75]), cachedInputRatio: 0.1 },
  { family: "openai", model: "gpt-5.6-sol", bands: tiered(272_000, [4, 20], [8, 30]), cachedInputRatio: 0.1 },
  { family: "openai", model: "gpt-5.6-terra", bands: tiered(272_000, [2, 12], [4, 18]), cachedInputRatio: 0.1 },
  { family: "openai", model: "gpt-5.6-luna", bands: tiered(272_000, [0.2, 1.2], [0.4, 1.8]), cachedInputRatio: 0.1 },
  { family: "openai", model: "gpt-5.5", aliases: ["gpt-5.5-2026-04-23"], bands: tiered(272_000, [5, 30], [10, 45]), cachedInputRatio: 0.1 },
  { family: "openai", model: "gpt-5.5-pro", aliases: ["gpt-5.5-pro-2026-04-23"], bands: tiered(272_000, [30, 180], [60, 270]) },
  { family: "openai", model: "gpt-5.4", aliases: ["gpt-5.4-2026-03-05"], bands: tiered(272_000, [2.5, 15], [5, 22.5]), cachedInputRatio: 0.1 },
  { family: "openai", model: "gpt-5.4-pro", aliases: ["gpt-5.4-pro-2026-03-05"], bands: tiered(272_000, [30, 180], [60, 270]) },
  { family: "openai", model: "gpt-5.4-mini", aliases: ["gpt-5.4-mini-2026-03-17"], bands: flat(0.75, 4.5), cachedInputRatio: 0.1 },
  { family: "openai", model: "gpt-5.4-nano", aliases: ["gpt-5.4-nano-2026-03-17"], bands: flat(0.2, 1.25), cachedInputRatio: 0.1 },
  { family: "openai", model: "gpt-5.2", aliases: ["gpt-5.2-2025-12-11"], bands: flat(1.75, 14), cachedInputRatio: 0.1 },
  { family: "openai", model: "gpt-5.2-pro", aliases: ["gpt-5.2-pro-2025-12-11"], bands: flat(21, 168) },
  { family: "openai", model: "gpt-5.1", aliases: ["gpt-5.1-2025-11-13"], bands: flat(1.25, 10), cachedInputRatio: 0.1 },
  { family: "openai", model: "gpt-5", aliases: ["gpt-5-2025-08-07"], bands: flat(1.25, 10), cachedInputRatio: 0.1 },
  { family: "openai", model: "gpt-5-mini", aliases: ["gpt-5-mini-2025-08-07"], bands: flat(0.25, 2), cachedInputRatio: 0.1 },
  { family: "openai", model: "gpt-5-nano", aliases: ["gpt-5-nano-2025-08-07"], bands: flat(0.05, 0.4), cachedInputRatio: 0.1 },
  { family: "openai", model: "gpt-5-pro", aliases: ["gpt-5-pro-2025-10-06"], bands: flat(15, 120) },
  { family: "openai", model: "gpt-4.1", aliases: ["gpt-4.1-2025-04-14"], bands: flat(2, 8), cachedInputRatio: 0.25 },
  { family: "openai", model: "gpt-4.1-mini", aliases: ["gpt-4.1-mini-2025-04-14"], bands: flat(0.4, 1.6), cachedInputRatio: 0.25 },
  // gpt-4o-2024-05-13 launched at $5/$15 and is not the price listed for gpt-4o.
  { family: "openai", model: "gpt-4o", aliases: ["gpt-4o-2024-08-06", "gpt-4o-2024-11-20"], excludedSnapshots: ["gpt-4o-2024-05-13"], bands: flat(2.5, 10), cachedInputRatio: 0.5 },
  { family: "openai", model: "gpt-4o-mini", aliases: ["gpt-4o-mini-2024-07-18"], bands: flat(0.15, 0.6), cachedInputRatio: 0.5 },
  { family: "openai", model: "o3-pro", bands: flat(20, 80) },
  { family: "openai", model: "o3", aliases: ["o3-2025-04-16"], bands: flat(2, 8), cachedInputRatio: 0.25 },

  { family: "anthropic", model: "claude-opus-5-5", bands: flat(4, 20), cachedInputRatio: 0.05 },
  { family: "anthropic", model: "claude-sonnet-5-5", bands: flat(2, 10), cachedInputRatio: 0.05 },
  { family: "anthropic", model: "claude-haiku-5-5", bands: tiered(100_000, [0.1, 0.5], [0.5, 2.5]), cachedInputRatio: 0.1 },
  { family: "anthropic", model: "claude-opus-5", bands: flat(5, 25), cachedInputRatio: 0.1 },
  { family: "anthropic", model: "claude-sonnet-5", bands: flat(2, 10), cachedInputRatio: 0.1 },
  { family: "anthropic", model: "claude-opus-4-8", bands: flat(5, 25), cachedInputRatio: 0.1 },
  { family: "anthropic", model: "claude-opus-4-7", bands: flat(5, 25), cachedInputRatio: 0.1 },
  { family: "anthropic", model: "claude-opus-4-6", bands: flat(5, 25), cachedInputRatio: 0.1 },
  { family: "anthropic", model: "claude-sonnet-4-6", bands: flat(3, 15), cachedInputRatio: 0.1 },
  { family: "anthropic", model: "claude-opus-4-5-20251101", aliases: ["claude-opus-4-5"], bands: flat(5, 25), cachedInputRatio: 0.1 },
  { family: "anthropic", model: "claude-sonnet-4-5-20250929", aliases: ["claude-sonnet-4-5"], bands: flat(3, 15), cachedInputRatio: 0.1 },
  { family: "anthropic", model: "claude-haiku-4-5-20251001", aliases: ["claude-haiku-4-5"], bands: flat(1, 5), cachedInputRatio: 0.1 },
  // Retired on the first-party API but still listed, so earlier captures of them get estimates.
  { family: "anthropic", model: "claude-opus-4-1-20250805", aliases: ["claude-opus-4-1"], bands: flat(15, 75), cachedInputRatio: 0.1 },
  { family: "anthropic", model: "claude-opus-4-20250514", aliases: ["claude-opus-4-0"], bands: flat(15, 75), cachedInputRatio: 0.1 },
  { family: "anthropic", model: "claude-sonnet-4-20250514", aliases: ["claude-sonnet-4-0"], bands: flat(3, 15), cachedInputRatio: 0.1 },

  // From 2026-12-01 Google routes gemini-2.5-pro to Gemini 3.8 Flash and
  // gemini-2.5-flash to Gemini 3.5 Flash-Lite, billed at the routed model's rates.
  { family: "google", model: "gemini-2.5-pro", bands: tiered(200_000, [1.25, 10], [2.5, 15]), cachedInputRatio: 0.1, effectiveUntil: "2026-12-01T00:00:00.000Z" },
  { family: "google", model: "gemini-2.5-flash", bands: flat(0.3, 2.5), cachedInputRatio: 0.1, effectiveUntil: "2026-12-01T00:00:00.000Z" },
  { family: "google", model: "gemini-2.5-flash-lite", bands: flat(0.1, 0.4), cachedInputRatio: 0.1 },
  { family: "google", model: "gemini-3-flash-preview", bands: flat(0.5, 3), cachedInputRatio: 0.1 },
  { family: "google", model: "gemini-3.1-pro-preview", aliases: ["gemini-3.1-pro-preview-customtools"], bands: tiered(200_000, [2, 12], [4, 18]), cachedInputRatio: 0.1 },
  { family: "google", model: "gemini-3.1-flash-lite", bands: flat(0.25, 1.5), cachedInputRatio: 0.1 },
  { family: "google", model: "gemini-3.5-flash-lite", bands: flat(0.3, 2.5), cachedInputRatio: 0.1 },
  { family: "google", model: "gemini-3.6-flash", bands: flat(0.75, 3.75), cachedInputRatio: 0.1, effectiveUntil: "2027-01-01T00:00:00.000Z" },
  { family: "google", model: "gemini-3.8-flash", bands: flat(0.75, 3.75), cachedInputRatio: 0.1, effectiveUntil: "2027-01-01T00:00:00.000Z" },
  { family: "google", model: "gemini-4-neon", bands: flat(3, 15), cachedInputRatio: 0.05 },
  { family: "google", model: "gemini-4-hydrogen", bands: flat(1.5, 7.5), cachedInputRatio: 0.05 },
  { family: "google", model: "gemini-4-carbon", bands: flat(2, 10), cachedInputRatio: 0.05, effectiveUntil: "2026-12-01T00:00:00.000Z" },
  { family: "google", model: "gemini-4-argon", bands: flat(2, 10), cachedInputRatio: 0.05, effectiveUntil: "2026-12-01T00:00:00.000Z" },
] satisfies ListPriceEntry[]);

const OBSERVED_AT = `${PRICE_TABLE_AS_OF}T00:00:00.000Z`;

const priced = (usdPerMillionTokens: number): CategoryRate => ({ kind: "priced", usdPerMillionTokens });

/**
 * Anthropic bills cache writes at 1.25x input for the 5-minute cache and 2x
 * for the 1-hour cache. A write reported without its duration is priced as
 * the 5-minute default; OpenAI and Gemini report no cache writes.
 */
function cacheRates(entry: ListPriceEntry, input: number): Partial<Record<TokenCategory, CategoryRate>> {
  if (entry.cachedInputRatio === undefined) return {};
  const read = { cache_read: priced(input * entry.cachedInputRatio) };
  if (entry.family !== "anthropic") return read;
  return { ...read, cache_write: priced(input * 1.25), cache_write_5m: priced(input * 1.25), cache_write_1h: priced(input * 2) };
}

function revisionFor(entry: ListPriceEntry): FrozenRateRevision {
  const source = PRICE_SOURCES[entry.family];
  const notPriced = Object.fromEntries(TOKEN_CATEGORIES.map(category => [category, { kind: "not_applicable" }])) as Record<TokenCategory, CategoryRate>;
  return freezeRateRevision({
    version: PRICING_VERSION, provider: LIST_PRICE_PROVIDER, model: entry.model, tier: LIST_PRICE_TIER,
    revision: PRICE_TABLE_REVISION, currency: "USD", unit: "usd_per_million_tokens",
    source: { kind: "catalogue", name: `${source.name}, list price as of ${PRICE_TABLE_AS_OF}`, reference: source.url, observedAt: OBSERVED_AT },
    aliases: (entry.aliases ?? []).map(alias => ({ provider: LIST_PRICE_PROVIDER, model: alias, tier: LIST_PRICE_TIER })),
    bands: entry.bands.map(band => ({ maxContextTokens: band.maxPromptTokens, categories: {
      ...notPriced, input: priced(band.input), output: priced(band.output), ...cacheRates(entry, band.input),
    } })),
  });
}

const REVISIONS = new Map<ListPriceEntry, FrozenRateRevision>(LIST_PRICES.map(entry => [entry, revisionFor(entry)]));
export const LIST_PRICE_REVISIONS: readonly FrozenRateRevision[] = Object.freeze([...REVISIONS.values()]);

const DATED_SUFFIX = /-(?:\d{4}-\d{2}-\d{2}|\d{8}|latest)$/;

/**
 * Resolves a reported model id against catalogue identities. Exact ids win.
 * Otherwise one dated or "-latest" suffix (gpt-5-nano-2025-08-07,
 * claude-haiku-4-5-20251001) is stripped, and the stripped id must name
 * exactly one identity; an ambiguous or absent match stays unpriced.
 */
export function resolveModelIdentity<T>(model: string, lookup: (identity: string) => readonly T[], excluded?: (model: string) => boolean): T | null {
  const exact = lookup(model);
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  if (excluded?.(model)) return null;
  const stripped = model.replace(DATED_SUFFIX, "");
  if (stripped === model || !stripped.length) return null;
  const matches = lookup(stripped);
  return matches.length === 1 ? matches[0] : null;
}

const BY_IDENTITY = new Map<string, ListPriceEntry[]>();
for (const entry of LIST_PRICES) {
  for (const identity of new Set([entry.model, ...(entry.aliases ?? [])])) {
    const list = BY_IDENTITY.get(identity) ?? [];
    list.push(entry);
    BY_IDENTITY.set(identity, list);
  }
}
const EXCLUDED = new Set(LIST_PRICES.flatMap(entry => entry.excludedSnapshots ?? []));

/**
 * Providers billed by the first party. A span routed through another vendor
 * (Bedrock, Vertex AI, Azure, a proxy) has its own prices, so it stays
 * unpriced; an absent provider is judged by the model id alone.
 */
function providerMatches(family: PriceFamily, provider: string | null | undefined): boolean {
  if (!provider) return true;
  const value = provider.trim().toLowerCase();
  if (family === "google") return value === "google" || value === "gemini" || value === "gcp.gemini" || value.startsWith("google.") || value === "google_genai";
  return value === family || value.startsWith(`${family}.`);
}

export interface ListPriceMatch { readonly entry: ListPriceEntry; readonly revision: FrozenRateRevision }

export function lookupListPrice(model: string | null | undefined, options: { provider?: string | null; at?: number | null } = {}): ListPriceMatch | null {
  if (!model) return null;
  const entry = resolveModelIdentity(model.startsWith("models/") ? model.slice("models/".length) : model, identity => BY_IDENTITY.get(identity) ?? [], id => EXCLUDED.has(id));
  if (!entry || !providerMatches(entry.family, options.provider)) return null;
  if (entry.effectiveUntil && typeof options.at === "number" && options.at >= Date.parse(entry.effectiveUntil)) return null;
  return { entry, revision: REVISIONS.get(entry)! };
}

export interface ListPriceUsage {
  readonly model: string | null | undefined;
  readonly provider?: string | null;
  readonly inputTokens: number | null | undefined;
  readonly outputTokens: number | null | undefined;
  readonly cacheReadTokens?: number | null;
  /** A cache write of unreported duration; priced as Anthropic's 5-minute write. */
  readonly cacheWriteTokens?: number | null;
  readonly cacheWrite5mTokens?: number | null;
  readonly cacheWrite1hTokens?: number | null;
  /**
   * Whether inputTokens already counts the cache tokens. OpenAI and Gemini
   * report cached tokens inside the prompt total; the Anthropic API reports
   * them separately, but OpenTelemetry instrumentations may sum them in.
   * Null or absent means "infer it", which fails closed when ambiguous.
   */
  readonly inputIncludesCache?: boolean | null;
  /** Call time in epoch ms; prices with an announced end are unavailable after it. */
  readonly at?: number | null;
}

/**
 * Claude Code hook spans keep Anthropic's usage under `usage`, where
 * freshInputTokens (the span's input_tokens) excludes cache reads and writes
 * (src/coding-hooks/projection.ts). Other spans use the captured gen_ai
 * cache attributes and the exporter's runphantom.usage.input_includes_cache.
 */
export function spanCacheUsage(values: Record<string, unknown>): Pick<ListPriceUsage, "cacheReadTokens" | "cacheWriteTokens" | "cacheWrite5mTokens" | "cacheWrite1hTokens" | "inputIncludesCache"> {
  const hook = values.usage;
  if ((values.source === "claude_hook" || values.source === "cursor_hook") && hook && typeof hook === "object" && !Array.isArray(hook)) {
    const usage = hook as Record<string, unknown>;
    const count = (value: unknown) => typeof value === "number" ? value : null;
    return { cacheReadTokens: count(usage.cacheReadInputTokens), cacheWriteTokens: count(usage.cacheCreatedInputTokens), inputIncludesCache: false };
  }
  const usage = normalizeUsage(values, null);
  const inclusion = usage.inclusion.cache_read;
  return {
    cacheReadTokens: usage.categories.cache_read.count, cacheWriteTokens: usage.categories.cache_write.count,
    cacheWrite5mTokens: usage.categories.cache_write_5m.count, cacheWrite1hTokens: usage.categories.cache_write_1h.count,
    inputIncludesCache: inclusion === "included" ? true : inclusion === "additional" ? false : null,
  };
}

export type ListPriceEstimate =
  | { readonly kind: "estimated"; readonly totalUsd: number; readonly inputUsd: number; readonly outputUsd: number; readonly cacheUsd: number; readonly cacheTokens: number; readonly inputUsdPerMillion: number; readonly outputUsdPerMillion: number; readonly model: string; readonly family: PriceFamily; readonly revision: FrozenRateRevision }
  | { readonly kind: "unavailable"; readonly reason: "model_unpriced" | "usage_unavailable" | "cache_usage_ambiguous" | "estimate_failed" };

export function estimateListPriceCost(usage: ListPriceUsage): ListPriceEstimate {
  const match = lookupListPrice(usage.model, { provider: usage.provider, at: usage.at });
  if (!match) return { kind: "unavailable", reason: "model_unpriced" };
  if (!validTokenCount(usage.inputTokens) || !validTokenCount(usage.outputTokens)) return { kind: "unavailable", reason: "usage_unavailable" };
  const cache = { cache_read: usage.cacheReadTokens, cache_write: usage.cacheWriteTokens, cache_write_5m: usage.cacheWrite5mTokens, cache_write_1h: usage.cacheWrite1hTokens };
  const counts = Object.fromEntries(Object.entries(cache).map(([key, value]) => [key, validTokenCount(value) ? value : 0])) as Record<keyof typeof cache, number>;
  if (Object.values(cache).some(value => value !== null && value !== undefined && !validTokenCount(value))) return { kind: "unavailable", reason: "usage_unavailable" };
  const cacheTokens = counts.cache_read + counts.cache_write + counts.cache_write_5m + counts.cache_write_1h;
  if (!Number.isSafeInteger(cacheTokens)) return { kind: "unavailable", reason: "usage_unavailable" };
  let included = usage.inputIncludesCache ?? null;
  if (included === null && cacheTokens > 0) {
    if (cacheTokens > usage.inputTokens) included = false;
    else if (match.entry.family !== "anthropic") included = true;
    else return { kind: "unavailable", reason: "cache_usage_ambiguous" };
  }
  const promptTokens = included === false ? usage.inputTokens + cacheTokens : usage.inputTokens;
  if (!Number.isSafeInteger(promptTokens)) return { kind: "unavailable", reason: "usage_unavailable" };
  const normalized = normalizeUsage({
    "gen_ai.response.model": match.revision.model, "runphantom.usage.tier": LIST_PRICE_TIER,
    "gen_ai.usage.input_tokens": usage.inputTokens, "gen_ai.usage.output_tokens": usage.outputTokens,
    "runphantom.usage.context_tokens": promptTokens,
    "runphantom.usage.cache_read_tokens": counts.cache_read, "runphantom.usage.cache_write_tokens": counts.cache_write,
    "runphantom.usage.cache_write_5m_tokens": counts.cache_write_5m, "runphantom.usage.cache_write_1h_tokens": counts.cache_write_1h,
    "runphantom.usage.input_includes_cache": included === true, "runphantom.usage.input_categories_disjoint": true,
  }, LIST_PRICE_PROVIDER);
  const estimate = calculateCost(normalized, match.revision);
  if (estimate.totalUsd === null) return { kind: "unavailable", reason: "estimate_failed" };
  const category = (name: TokenCategory) => estimate.categories.find(item => item.category === name)!;
  const input = category("input"), output = category("output");
  const cacheUsd = (["cache_read", "cache_write", "cache_write_5m", "cache_write_1h"] as const).reduce((sum, name) => sum + (category(name).costUsd ?? 0), 0);
  return { kind: "estimated", totalUsd: estimate.totalUsd, inputUsd: input.costUsd!, outputUsd: output.costUsd!, cacheUsd, cacheTokens,
    inputUsdPerMillion: input.rateUsdPerMillionTokens!, outputUsdPerMillion: output.rateUsdPerMillionTokens!, model: match.revision.model, family: match.entry.family, revision: match.revision };
}
