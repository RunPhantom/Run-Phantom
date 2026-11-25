import { hasDuplicateJsonKeys } from "../../../src/json-keys";
import { parseJsonEvidence } from "../../../src/evaluations/json-evidence";
import { calculateCost } from "../../../src/pricing/calculator";
import { NOMINAL_CATALOGUE_PROVIDER, NOMINAL_CATALOGUE_TIER, NOMINAL_CATALOGUE_URL, parseNominalCatalogue, type NominalCatalogue } from "../../../src/pricing/rates";
import { normalizeUsage, validTokenCount } from "../../../src/pricing/usage";
import { PRICE_SOURCES, PRICE_TABLE_AS_OF, resolveModelIdentity } from "../../../src/pricing/list-prices";
import { spanCost } from "../../../src/pricing/span-cost";
import type { FrozenRateRevision } from "../../../src/pricing/protocol";
import type { Span } from "./types";

export const MODEL_PRICING_CONSENT_KEY = "runphantom:modelPricingConsent";
const MAX_CATALOGUE_BYTES = 8 * 1024 * 1024;

export interface PricingSnapshot {
  readonly status: "disabled" | "idle" | "loading" | "ready" | "error";
  readonly catalogue: NominalCatalogue | null;
  readonly error: string | null;
}

const DISABLED_SNAPSHOT: PricingSnapshot = Object.freeze({ status: "disabled", catalogue: null, error: null });
let snapshot: PricingSnapshot = DISABLED_SNAPSHOT;
let rateCache = new Map<string, FrozenRateRevision>();
let generation = 0;
let controller: AbortController | null = null;
let pending: Promise<void> | null = null;
let deniedUntilExplicitConsent = false;
const listeners = new Set<() => void>();

export function modelPricingConsentEnabled(): boolean {
  if (deniedUntilExplicitConsent) return false;
  try { return localStorage.getItem(MODEL_PRICING_CONSENT_KEY) === "1"; } catch { return false; }
}

function publish(value: PricingSnapshot): void {
  snapshot = Object.freeze(value);
  for (const listener of listeners) listener();
}

function resetPricing(): void {
  generation++;
  controller?.abort();
  controller = null;
  pending = null;
  rateCache = new Map();
  publish(modelPricingConsentEnabled() ? { status: "idle", catalogue: null, error: null } : DISABLED_SNAPSHOT);
}

export function setModelPricingConsent(enabled: boolean): void {
  deniedUntilExplicitConsent = !enabled;
  try { localStorage.setItem(MODEL_PRICING_CONSENT_KEY, enabled ? "1" : "0"); } catch { deniedUntilExplicitConsent = true; }
  resetPricing();
}

const handleStorage = (event: StorageEvent): void => {
  if (event.key !== MODEL_PRICING_CONSENT_KEY && event.key !== null) return;
  deniedUntilExplicitConsent = event.key === null || event.newValue !== "1";
  resetPricing();
  if (modelPricingConsentEnabled()) void fetchPrices();
};

export function subscribePricing(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener("storage", handleStorage);
  if (modelPricingConsentEnabled() && (snapshot.status === "disabled" || snapshot.status === "idle")) void fetchPrices();
  return () => {
    listeners.delete(listener);
    if (!listeners.size && typeof window !== "undefined") window.removeEventListener("storage", handleStorage);
  };
}

export function getPricingSnapshot(): PricingSnapshot {
  return modelPricingConsentEnabled() ? snapshot : DISABLED_SNAPSHOT;
}

async function readCatalogue(response: Response): Promise<Uint8Array<ArrayBuffer>> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_CATALOGUE_BYTES)) throw new Error("Catalogue exceeds byte limit");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Catalogue body is unavailable");
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_CATALOGUE_BYTES) throw new Error("Catalogue exceeds byte limit");
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function fetchPrices(): Promise<void> {
  if (!modelPricingConsentEnabled()) { resetPricing(); return; }
  if (pending) return pending;
  if (snapshot.status === "ready") return;
  const requestGeneration = ++generation;
  const requestController = new AbortController();
  controller = requestController;
  publish({ status: "loading", catalogue: null, error: null });
  const timeout = setTimeout(() => requestController.abort(), 20_000);
  pending = (async () => {
    try {
      const response = await fetch(NOMINAL_CATALOGUE_URL, { signal: requestController.signal });
      if (requestGeneration !== generation || !modelPricingConsentEnabled()) { await response.body?.cancel().catch(() => {}); return; }
      if (!response.ok) throw new Error("Catalogue request failed");
      const bytes = await readCatalogue(response);
      if (requestGeneration !== generation || !modelPricingConsentEnabled()) return;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const value = parseJsonEvidence(text);
      if (hasDuplicateJsonKeys(text)) throw new Error("Duplicate catalogue keys");
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const revision = "sha256:" + [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
      const catalogue = parseNominalCatalogue(value, revision, new Date().toISOString());
      if (!catalogue.rates.length) throw new Error("Catalogue has no usable complete quotes");
      if (requestGeneration !== generation || !modelPricingConsentEnabled()) return;
      const next = new Map<string, FrozenRateRevision>();
      for (const rate of catalogue.rates) {
        next.set(rate.model, rate);
        for (const alias of rate.aliases) next.set(alias.model, rate);
      }
      rateCache = next;
      publish({ status: "ready", catalogue, error: null });
    } catch {
      if (requestGeneration === generation && modelPricingConsentEnabled()) {
        rateCache = new Map();
        publish({ status: "error", catalogue: null, error: "Public input/output pricing is unavailable. Re-enable pricing to retry." });
      }
    } finally {
      clearTimeout(timeout);
      if (requestGeneration === generation) { pending = null; controller = null; }
    }
  })();
  return pending;
}

export function hasFetchedPrices(): boolean { return getPricingSnapshot().status === "ready"; }

export interface CostBreakdown {
  inRate: number;
  outRate: number;
  inCost: number;
  outCost: number;
  totalCost: number;
  catalogueId: string;
  rateRevision: string;
  source: FrozenRateRevision["source"];
}

export interface PricingUsageTotals { inTok: number | null; outTok: number | null }

export function getPricingUsageByModel(spans: Span[]): Map<string | null, PricingUsageTotals> {
  const byModel = new Map<string | null, PricingUsageTotals>();
  const llmIds = new Set(spans.filter(span => span.span_type?.includes("LLM")).map(span => span.id));
  const sum = (previous: number | null, value: number | null): number | null => previous !== null && validTokenCount(value) && Number.isSafeInteger(previous + value) ? previous + value : null;
  for (const span of spans) {
    if (!span.span_type?.includes("LLM") || (span.parent_span_id && llmIds.has(span.parent_span_id))) continue;
    const key = span.model || null;
    const previous = byModel.get(key) ?? { inTok: 0, outTok: 0 };
    byModel.set(key, { inTok: sum(previous.inTok, span.input_tokens), outTok: sum(previous.outTok, span.output_tokens) });
  }
  return byModel;
}

export function getCostBreakdown(model: string | null | undefined, inTokens: number | null, outTokens: number | null): CostBreakdown | null {
  if (!model || !modelPricingConsentEnabled() || !validTokenCount(inTokens) || !validTokenCount(outTokens)) return null;
  const rate = resolveModelIdentity(model, identity => rateCache.has(identity) ? [rateCache.get(identity)!] : []);
  if (!rate) return null;
  const usage = normalizeUsage({ "gen_ai.response.model": rate.model, "runphantom.usage.tier": NOMINAL_CATALOGUE_TIER, "gen_ai.usage.input_tokens": inTokens, "gen_ai.usage.output_tokens": outTokens }, NOMINAL_CATALOGUE_PROVIDER);
  const estimate = calculateCost(usage, rate);
  if (estimate.totalUsd === null) return null;
  const input = estimate.categories.find(category => category.category === "input")!;
  const output = estimate.categories.find(category => category.category === "output")!;
  return { inRate: input.rateUsdPerMillionTokens!, outRate: output.rateUsdPerMillionTokens!, inCost: input.costUsd!, outCost: output.costUsd!, totalCost: estimate.totalUsd, catalogueId: rate.model, rateRevision: rate.revision, source: rate.source };
}

export interface ListPriceDetail { inRate: number; outRate: number; sourceName: string; sourceUrl: string; asOf: string; priceModel: string }

export interface ModelCostRow {
  model: string | null;
  inTok: number | null;
  outTok: number | null;
  generations: number;
  /** Generations priced by each source; they sum to `generations` minus the unpriced ones. */
  sources: { reported: number; listPrice: number; catalogue: number };
  reportedUsd: number;
  listPriceUsd: number;
  /** Part of listPriceUsd spent on cached input, and the cache tokens it covers. */
  listPriceCacheUsd: number;
  listPriceCacheTokens: number;
  catalogueUsd: number;
  /** Null when any generation of this model has no reported cost and no estimate. */
  totalUsd: number | null;
  listPrice: ListPriceDetail | null;
  catalogue: CostBreakdown | null;
  unavailableReason: string | null;
}

function unavailableReason(span: Span, reason: string | null, pricing: PricingSnapshot): string {
  if (reason === "reported_cost_invalid") return "The captured reported cost is invalid or conflicting.";
  if (reason === "cache_usage_ambiguous") return "The capture does not say whether input tokens include cached tokens.";
  if (!span.model) return "Model identity was not captured.";
  if (!validTokenCount(span.input_tokens) || !validTokenCount(span.output_tokens)) return "Input or output token capture is unavailable.";
  if (pricing.status === "disabled") return "No list price. Enable public pricing in Settings.";
  if (pricing.status === "loading" || pricing.status === "idle") return "No list price. Public pricing is loading.";
  if (pricing.status === "error") return pricing.error ?? "Public pricing is unavailable.";
  return "No list price or unambiguous catalogue price.";
}

/**
 * Per-model cost of a run's top-level generations. A captured reported cost
 * always wins; otherwise the bundled list price; otherwise, with consent, the
 * OpenRouter catalogue. Nested generations are skipped like token totals.
 */
export function getRunCostRows(spans: Span[], pricing: PricingSnapshot = getPricingSnapshot()): ModelCostRow[] {
  const usage = getPricingUsageByModel(spans);
  const rows = new Map<string | null, ModelCostRow>();
  const llmIds = new Set(spans.filter(span => span.span_type?.includes("LLM")).map(span => span.id));
  for (const span of spans) {
    if (!span.span_type?.includes("LLM") || (span.parent_span_id && llmIds.has(span.parent_span_id))) continue;
    const key = span.model || null;
    const tokens = usage.get(key) ?? { inTok: null, outTok: null };
    const row = rows.get(key) ?? { model: key, inTok: tokens.inTok, outTok: tokens.outTok, generations: 0, sources: { reported: 0, listPrice: 0, catalogue: 0 }, reportedUsd: 0, listPriceUsd: 0, listPriceCacheUsd: 0, listPriceCacheTokens: 0, catalogueUsd: 0, totalUsd: 0, listPrice: null, catalogue: null, unavailableReason: null };
    rows.set(key, row);
    row.generations++;
    const cost = spanCost(span);
    let amount: number | null = null;
    if (cost.source === "reported") { amount = cost.usd; row.reportedUsd += cost.usd; row.sources.reported++; }
    else if (cost.source === "list-price") {
      amount = cost.usd; row.listPriceUsd += cost.usd; row.sources.listPrice++;
      row.listPriceCacheUsd += cost.estimate.cacheUsd; row.listPriceCacheTokens += cost.estimate.cacheTokens;
      const family = cost.estimate.family;
      row.listPrice ??= { inRate: cost.estimate.inputUsdPerMillion, outRate: cost.estimate.outputUsdPerMillion, sourceName: PRICE_SOURCES[family].name, sourceUrl: PRICE_SOURCES[family].url, asOf: PRICE_TABLE_AS_OF, priceModel: cost.estimate.model };
    } else if (cost.reason !== "reported_cost_invalid" && pricing.catalogue) {
      const quote = getCostBreakdown(span.model, span.input_tokens, span.output_tokens);
      if (quote) { amount = quote.totalCost; row.catalogueUsd += quote.totalCost; row.catalogue ??= quote; row.sources.catalogue++; }
    }
    if (amount === null) { row.totalUsd = null; row.unavailableReason ??= unavailableReason(span, cost.source === null ? cost.reason : null, pricing); }
    else if (row.totalUsd !== null) row.totalUsd = Number.isFinite(row.totalUsd + amount) ? row.totalUsd + amount : null;
  }
  return [...rows.values()];
}

export function fmtCost(cost: number): string {
  if (!Number.isFinite(cost) || cost < 0) return "Unavailable";
  if (cost === 0) return "$0.00";
  if (cost < 0.0001) return "<$0.0001";
  if (cost < 0.01) return "$" + cost.toFixed(4);
  if (cost < 1) return "$" + cost.toFixed(3);
  return "$" + cost.toFixed(2);
}

// Four significant digits absorb float noise while preserving sub-cent rates.
const rateFormat = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 });
export function fmtRate(rate: number): string { return Number.isFinite(rate) && rate >= 0 ? "$" + rateFormat.format(rate) : "Unavailable"; }
