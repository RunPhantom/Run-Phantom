import { hasDuplicateJsonKeys } from "../../../src/json-keys";
import { parseJsonEvidence } from "../../../src/evaluations/json-evidence";
import { calculateCost } from "../../../src/pricing/calculator";
import { NOMINAL_CATALOGUE_PROVIDER, NOMINAL_CATALOGUE_TIER, NOMINAL_CATALOGUE_URL, parseNominalCatalogue, type NominalCatalogue } from "../../../src/pricing/rates";
import { normalizeUsage, validTokenCount } from "../../../src/pricing/usage";
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
const listeners = new Set<() => void>();

export function modelPricingConsentEnabled(): boolean {
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
  try { localStorage.setItem(MODEL_PRICING_CONSENT_KEY, enabled ? "1" : "0"); } catch {}
  resetPricing();
}

const handleStorage = (event: StorageEvent): void => {
  if (event.key !== MODEL_PRICING_CONSENT_KEY && event.key !== null) return;
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
      if (!response.ok) throw new Error("Catalogue request failed");
      const bytes = await readCatalogue(response);
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

export function getTokensByModel(spans: Span[]): Map<string, { inTok: number; outTok: number }> {
  const byModel = new Map<string, { inTok: number; outTok: number }>();
  const llmIds = new Set(spans.filter(span => span.span_type?.includes("LLM")).map(span => span.id));
  for (const span of spans) {
    if (!span.model || !span.span_type?.includes("LLM") || !(span.input_tokens || span.output_tokens)) continue;
    if (span.parent_span_id && llmIds.has(span.parent_span_id)) continue;
    const existing = byModel.get(span.model) ?? { inTok: 0, outTok: 0 };
    existing.inTok += span.input_tokens ?? 0;
    existing.outTok += span.output_tokens ?? 0;
    byModel.set(span.model, existing);
  }
  return byModel;
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
  const rate = rateCache.get(model);
  if (!rate) return null;
  const usage = normalizeUsage({ "gen_ai.response.model": model, "runphantom.usage.tier": NOMINAL_CATALOGUE_TIER, "gen_ai.usage.input_tokens": inTokens, "gen_ai.usage.output_tokens": outTokens }, NOMINAL_CATALOGUE_PROVIDER);
  const estimate = calculateCost(usage, rate);
  if (estimate.totalUsd === null) return null;
  const input = estimate.categories.find(category => category.category === "input")!;
  const output = estimate.categories.find(category => category.category === "output")!;
  return { inRate: input.rateUsdPerMillionTokens!, outRate: output.rateUsdPerMillionTokens!, inCost: input.costUsd!, outCost: output.costUsd!, totalCost: estimate.totalUsd, catalogueId: rate.model, rateRevision: rate.revision, source: rate.source };
}

export function fmtCost(cost: number): string {
  if (!Number.isFinite(cost) || cost < 0) return "Unavailable";
  if (cost === 0) return "$0.00";
  if (cost < 0.0001) return "<$0.0001";
  if (cost < 0.01) return "$" + cost.toFixed(4);
  if (cost < 1) return "$" + cost.toFixed(3);
  return "$" + cost.toFixed(2);
}

const rateFormat = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 });
export function fmtRate(rate: number): string { return Number.isFinite(rate) && rate >= 0 ? "$" + rateFormat.format(rate) : "Unavailable"; }
