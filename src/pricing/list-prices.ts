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
 *   text tokens; "Short: <=272K input tokens" / "Long: >272K").
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 *   (Model pricing table; Haiku 5.5 is priced by prompt length over 100,000
 *   tokens, counting cache reads and writes).
 * - Google: https://ai.google.dev/gemini-api/docs/pricing (Paid tier, text
 *   input; Pro models change price for prompts over 200k tokens).
 *
 * Only input and output are priced. Cache reads and writes, audio and image
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
  google: { name: "Google Gemini API pricing", url: "https://ai.google.dev/gemini-api/docs/pricing" },
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
  /** Exclusive end of this price, from the provider's announced change; later calls are unpriced. */
  readonly effectiveUntil?: string;
}

const flat = (input: number, output: number): PriceBand[] => [{ maxPromptTokens: null, input, output }];
const tiered = (threshold: number, low: [number, number], high: [number, number]): PriceBand[] =>
  [{ maxPromptTokens: threshold, input: low[0], output: low[1] }, { maxPromptTokens: null, input: high[0], output: high[1] }];

export const LIST_PRICES: readonly ListPriceEntry[] = Object.freeze([
  { family: "openai", model: "gpt-5.6-sol", bands: flat(4, 20) },
  { family: "openai", model: "gpt-5.6-terra", bands: flat(2, 12) },
  { family: "openai", model: "gpt-5.6-luna", bands: flat(0.2, 1.2) },
  { family: "openai", model: "gpt-5.5", aliases: ["gpt-5.5-2026-04-23"], bands: tiered(272_000, [5, 30], [10, 45]) },
  { family: "openai", model: "gpt-5.5-pro", aliases: ["gpt-5.5-pro-2026-04-23"], bands: tiered(272_000, [30, 180], [60, 270]) },
  { family: "openai", model: "gpt-5.4", aliases: ["gpt-5.4-2026-03-05"], bands: tiered(272_000, [2.5, 15], [5, 22.5]) },
  { family: "openai", model: "gpt-5.4-pro", aliases: ["gpt-5.4-pro-2026-03-05"], bands: tiered(272_000, [30, 180], [60, 270]) },
  { family: "openai", model: "gpt-5.4-mini", aliases: ["gpt-5.4-mini-2026-03-17"], bands: flat(0.75, 4.5) },
  { family: "openai", model: "gpt-5.4-nano", aliases: ["gpt-5.4-nano-2026-03-17"], bands: flat(0.2, 1.25) },
  { family: "openai", model: "gpt-5.2", aliases: ["gpt-5.2-2025-12-11"], bands: flat(1.75, 14) },
  { family: "openai", model: "gpt-5.2-pro", aliases: ["gpt-5.2-pro-2025-12-11"], bands: flat(21, 168) },
  { family: "openai", model: "gpt-5.1", aliases: ["gpt-5.1-2025-11-13"], bands: flat(1.25, 10) },
  { family: "openai", model: "gpt-5", aliases: ["gpt-5-2025-08-07"], bands: flat(1.25, 10) },
  { family: "openai", model: "gpt-5-mini", aliases: ["gpt-5-mini-2025-08-07"], bands: flat(0.25, 2) },
  { family: "openai", model: "gpt-5-nano", aliases: ["gpt-5-nano-2025-08-07"], bands: flat(0.05, 0.4) },
  { family: "openai", model: "gpt-5-pro", aliases: ["gpt-5-pro-2025-10-06"], bands: flat(15, 120) },
  { family: "openai", model: "gpt-4.1", aliases: ["gpt-4.1-2025-04-14"], bands: flat(2, 8) },
  { family: "openai", model: "gpt-4.1-mini", aliases: ["gpt-4.1-mini-2025-04-14"], bands: flat(0.4, 1.6) },
  // gpt-4o-2024-05-13 launched at $5/$15 and is not the price listed for gpt-4o.
  { family: "openai", model: "gpt-4o", aliases: ["gpt-4o-2024-08-06", "gpt-4o-2024-11-20"], excludedSnapshots: ["gpt-4o-2024-05-13"], bands: flat(2.5, 10) },
  { family: "openai", model: "gpt-4o-mini", aliases: ["gpt-4o-mini-2024-07-18"], bands: flat(0.15, 0.6) },
  { family: "openai", model: "o3", aliases: ["o3-2025-04-16"], bands: flat(2, 8) },

  { family: "anthropic", model: "claude-opus-5-5", bands: flat(4, 20) },
  { family: "anthropic", model: "claude-sonnet-5-5", bands: flat(2, 10) },
  { family: "anthropic", model: "claude-haiku-5-5", bands: tiered(100_000, [0.1, 0.5], [0.5, 2.5]) },
  { family: "anthropic", model: "claude-opus-5", bands: flat(5, 25) },
  { family: "anthropic", model: "claude-sonnet-5", bands: flat(2, 10) },
  { family: "anthropic", model: "claude-opus-4-8", bands: flat(5, 25) },
  { family: "anthropic", model: "claude-opus-4-7", bands: flat(5, 25) },
  { family: "anthropic", model: "claude-opus-4-6", bands: flat(5, 25) },
  { family: "anthropic", model: "claude-sonnet-4-6", bands: flat(3, 15) },
  { family: "anthropic", model: "claude-opus-4-5-20251101", aliases: ["claude-opus-4-5"], bands: flat(5, 25) },
  { family: "anthropic", model: "claude-sonnet-4-5-20250929", aliases: ["claude-sonnet-4-5"], bands: flat(3, 15) },
  { family: "anthropic", model: "claude-haiku-4-5-20251001", aliases: ["claude-haiku-4-5"], bands: flat(1, 5) },

  // Google routes gemini-2.5-pro to Gemini 3.8 Flash billing from 2026-12-01.
  { family: "google", model: "gemini-2.5-pro", bands: tiered(200_000, [1.25, 10], [2.5, 15]), effectiveUntil: "2026-12-01T00:00:00.000Z" },
  { family: "google", model: "gemini-2.5-flash", bands: flat(0.3, 2.5) },
  { family: "google", model: "gemini-2.5-flash-lite", bands: flat(0.1, 0.4) },
  { family: "google", model: "gemini-3-flash-preview", bands: flat(0.5, 3) },
  { family: "google", model: "gemini-3.1-pro-preview", aliases: ["gemini-3.1-pro-preview-customtools"], bands: tiered(200_000, [2, 12], [4, 18]) },
  { family: "google", model: "gemini-3.1-flash-lite", bands: flat(0.25, 1.5) },
  { family: "google", model: "gemini-3.5-flash-lite", bands: flat(0.3, 2.5) },
  { family: "google", model: "gemini-3.6-flash", bands: flat(0.75, 3.75), effectiveUntil: "2027-01-01T00:00:00.000Z" },
  { family: "google", model: "gemini-3.8-flash", bands: flat(0.75, 3.75), effectiveUntil: "2027-01-01T00:00:00.000Z" },
  { family: "google", model: "gemini-4-neon", bands: flat(3, 15) },
  { family: "google", model: "gemini-4-hydrogen", bands: flat(1.5, 7.5) },
  { family: "google", model: "gemini-4-carbon", bands: flat(2, 10), effectiveUntil: "2026-12-01T00:00:00.000Z" },
  { family: "google", model: "gemini-4-argon", bands: flat(2, 10), effectiveUntil: "2026-12-01T00:00:00.000Z" },
] satisfies ListPriceEntry[]);

const OBSERVED_AT = `${PRICE_TABLE_AS_OF}T00:00:00.000Z`;

function revisionFor(entry: ListPriceEntry): FrozenRateRevision {
  const source = PRICE_SOURCES[entry.family];
  const notPriced = Object.fromEntries(TOKEN_CATEGORIES.map(category => [category, { kind: "not_applicable" }])) as Record<TokenCategory, CategoryRate>;
  return freezeRateRevision({
    version: PRICING_VERSION, provider: LIST_PRICE_PROVIDER, model: entry.model, tier: LIST_PRICE_TIER,
    revision: PRICE_TABLE_REVISION, currency: "USD", unit: "usd_per_million_tokens",
    source: { kind: "catalogue", name: `${source.name}, list price as of ${PRICE_TABLE_AS_OF}`, reference: source.url, observedAt: OBSERVED_AT },
    aliases: (entry.aliases ?? []).map(alias => ({ provider: LIST_PRICE_PROVIDER, model: alias, tier: LIST_PRICE_TIER })),
    bands: entry.bands.map(band => ({ maxContextTokens: band.maxPromptTokens, categories: {
      ...notPriced, input: { kind: "priced", usdPerMillionTokens: band.input }, output: { kind: "priced", usdPerMillionTokens: band.output },
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
  /** Anthropic reports cache tokens outside input_tokens; they count toward prompt-length price bands. */
  readonly cacheReadTokens?: number | null;
  readonly cacheWriteTokens?: number | null;
  /** Call time in epoch ms; prices with an announced end are unavailable after it. */
  readonly at?: number | null;
}

export type ListPriceEstimate =
  | { readonly kind: "estimated"; readonly totalUsd: number; readonly inputUsd: number; readonly outputUsd: number; readonly inputUsdPerMillion: number; readonly outputUsdPerMillion: number; readonly model: string; readonly family: PriceFamily; readonly revision: FrozenRateRevision }
  | { readonly kind: "unavailable"; readonly reason: "model_unpriced" | "usage_unavailable" | "estimate_failed" };

export function estimateListPriceCost(usage: ListPriceUsage): ListPriceEstimate {
  const match = lookupListPrice(usage.model, { provider: usage.provider, at: usage.at });
  if (!match) return { kind: "unavailable", reason: "model_unpriced" };
  if (!validTokenCount(usage.inputTokens) || !validTokenCount(usage.outputTokens)) return { kind: "unavailable", reason: "usage_unavailable" };
  let promptTokens = usage.inputTokens;
  if (match.entry.family === "anthropic") {
    for (const extra of [usage.cacheReadTokens, usage.cacheWriteTokens]) if (validTokenCount(extra)) promptTokens += extra;
  }
  const normalized = normalizeUsage({
    "gen_ai.response.model": match.revision.model, "runphantom.usage.tier": LIST_PRICE_TIER,
    "gen_ai.usage.input_tokens": usage.inputTokens, "gen_ai.usage.output_tokens": usage.outputTokens,
    "runphantom.usage.context_tokens": promptTokens,
  }, LIST_PRICE_PROVIDER);
  const estimate = calculateCost(normalized, match.revision);
  if (estimate.totalUsd === null) return { kind: "unavailable", reason: "estimate_failed" };
  const input = estimate.categories.find(category => category.category === "input")!;
  const output = estimate.categories.find(category => category.category === "output")!;
  return { kind: "estimated", totalUsd: estimate.totalUsd, inputUsd: input.costUsd!, outputUsd: output.costUsd!,
    inputUsdPerMillion: input.rateUsdPerMillionTokens!, outputUsdPerMillion: output.rateUsdPerMillionTokens!, model: match.revision.model, family: match.entry.family, revision: match.revision };
}
