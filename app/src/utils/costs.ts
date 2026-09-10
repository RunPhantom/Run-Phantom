import type { Span } from "./types";

export const MODEL_PRICING_CONSENT_KEY = "runphantom:modelPricingConsent";

let priceCache: Record<string, [number, number]> = {};
let fetched = false;

export function modelPricingConsentEnabled(): boolean {
  try {
    return localStorage.getItem(MODEL_PRICING_CONSENT_KEY) === "1";
  } catch {
    return false;
  }
}

export function setModelPricingConsent(enabled: boolean): void {
  try {
    localStorage.setItem(MODEL_PRICING_CONSENT_KEY, enabled ? "1" : "0");
  } catch {}
}

export async function fetchPrices(): Promise<void> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    if (!res.ok) return;
    const data = await res.json();
    if (!data?.data) return;
    const newPrices: Record<string, [number, number]> = {};
    for (const m of data.data) {
      if (m.id && m.pricing) {
        const inPrice = parseFloat(m.pricing.prompt ?? "0") * 1_000_000;
        const outPrice = parseFloat(m.pricing.completion ?? "0") * 1_000_000;
        if (inPrice > 0 || outPrice > 0) {
          newPrices[m.id] = [inPrice, outPrice];
          const shortId = m.id.includes("/") ? m.id.split("/").pop()! : m.id;
          newPrices[shortId] = [inPrice, outPrice];
        }
      }
    }
    if (Object.keys(newPrices).length > 0) {
      priceCache = newPrices;
      fetched = true;
    }
  } catch {}
}

export function hasFetchedPrices(): boolean {
  return fetched;
}

function findPrice(model: string): [number, number] | null {
  if (priceCache[model]) return priceCache[model];
  const lower = model.toLowerCase();
  if (priceCache[lower]) return priceCache[lower];
  for (const [key, val] of Object.entries(priceCache)) {
    if (lower.includes(key) || key.includes(lower)) return val;
  }
  return null;
}

export interface CostBreakdown {
  inRate: number;  // $/1M input tokens
  outRate: number; // $/1M output tokens
  inCost: number;
  outCost: number;
  totalCost: number;
}

export function getTokensByModel(spans: Span[]): Map<string, { inTok: number; outTok: number }> {
  const byModel = new Map<string, { inTok: number; outTok: number }>();
  const llmIds = new Set<string>();
  for (const span of spans) {
    if (span.span_type?.includes("LLM")) llmIds.add(span.id);
  }
  for (const span of spans) {
    if (!span.model || !span.span_type?.includes("LLM")) continue;
    if (!(span.input_tokens || span.output_tokens)) continue;
    if (span.parent_span_id && llmIds.has(span.parent_span_id)) continue;
    const existing = byModel.get(span.model) ?? { inTok: 0, outTok: 0 };
    existing.inTok += span.input_tokens ?? 0;
    existing.outTok += span.output_tokens ?? 0;
    byModel.set(span.model, existing);
  }
  return byModel;
}

export function getCostBreakdown(model: string | null | undefined, inTokens: number, outTokens: number): CostBreakdown | null {
  if (!model) return null;
  const rates = findPrice(model);
  if (!rates) return null;
  const inCost = (inTokens * rates[0]) / 1_000_000;
  const outCost = (outTokens * rates[1]) / 1_000_000;
  return { inRate: rates[0], outRate: rates[1], inCost, outCost, totalCost: inCost + outCost };
}

export function fmtCost(cost: number): string {
  if (cost < 0.0001) return "<$0.0001";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}
