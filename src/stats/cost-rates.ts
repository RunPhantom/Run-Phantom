import type { FrozenRateRevision } from "../pricing/protocol";
import { freezeRateRevision } from "../pricing/rates";

export interface ServerCostRates {
  readonly estimateMode: "captured" | "nominal-input-output";
  readonly rates: readonly FrozenRateRevision[];
  /** Changes whenever the rate set changes, so cached run costs are recomputed. */
  readonly key: string;
}

const NO_RATES: ServerCostRates = Object.freeze({ estimateMode: "captured", rates: Object.freeze([]), key: "none" });
let source: () => ServerCostRates = () => NO_RATES;

/**
 * Rates the daemon may use to estimate cost without a browser. Until a
 * server-held price table is registered, unreported costs stay unknown rather
 * than guessed.
 */
export function serverCostRates(): ServerCostRates {
  return source();
}

export function registerServerCostRates(provider: (() => { estimateMode: ServerCostRates["estimateMode"]; rates: readonly unknown[] }) | null): void {
  if (!provider) { source = () => NO_RATES; return; }
  let cachedInput: readonly unknown[] | null = null;
  let cached: ServerCostRates = NO_RATES;
  source = () => {
    const next = provider();
    if (next.rates === cachedInput && cached.estimateMode === next.estimateMode) return cached;
    const rates = Object.freeze(next.rates.map(rate => freezeRateRevision(rate)));
    const key = JSON.stringify([next.estimateMode, ...rates.map(rate => [rate.provider, rate.model, rate.tier, rate.revision])]);
    cachedInput = next.rates;
    cached = Object.freeze({ estimateMode: next.estimateMode, rates, key });
    return cached;
  };
}
