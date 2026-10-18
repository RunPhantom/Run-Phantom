export const PRICING_VERSION = "runphantom-pricing/1" as const;

export const TOKEN_CATEGORIES = [
  "input", "output", "cache_read", "cache_write", "cache_write_5m",
  "cache_write_1h", "reasoning", "audio_input", "audio_output",
] as const;

export type TokenCategory = typeof TOKEN_CATEGORIES[number];
export type DetailCategory = Exclude<TokenCategory, "input" | "output">;
export type Inclusion = "included" | "additional" | "unknown";

export interface TokenMeasure {
  readonly count: number | null;
  readonly state: "known" | "missing" | "invalid" | "conflicting";
  readonly attributes: readonly string[];
}

export interface ModelIdentity {
  readonly provider: string;
  readonly model: string;
  readonly tier: string;
}

export interface NormalizedUsage {
  readonly version: typeof PRICING_VERSION;
  readonly provider: string | null;
  readonly model: string | null;
  readonly tier: string | null;
  readonly contextTokens: TokenMeasure;
  readonly categories: Readonly<Record<TokenCategory, TokenMeasure>>;
  readonly inclusion: Readonly<Record<DetailCategory, Inclusion>>;
  readonly inputDetailsDisjoint: boolean | null;
  readonly outputDetailsDisjoint: boolean | null;
  readonly issues: readonly string[];
}

export type CategoryRate =
  | { readonly kind: "priced"; readonly usdPerMillionTokens: number }
  | { readonly kind: "included" }
  | { readonly kind: "not_applicable" }
  | { readonly kind: "unavailable" };

export interface ContextRateBand {
  /** Inclusive maximum; the final band must have no maximum. */
  readonly maxContextTokens: number | null;
  readonly categories: Readonly<Record<TokenCategory, CategoryRate>>;
}

export interface FrozenRateRevision extends ModelIdentity {
  readonly version: typeof PRICING_VERSION;
  readonly revision: string;
  readonly currency: "USD";
  readonly unit: "usd_per_million_tokens";
  readonly source: {
    readonly kind: "manual" | "catalogue" | "capture";
    readonly name: string;
    readonly reference: string | null;
    readonly observedAt: string;
  };
  readonly aliases: readonly ModelIdentity[];
  readonly bands: readonly ContextRateBand[];
}

export interface CategoryCost {
  readonly category: TokenCategory;
  readonly observedTokens: number | null;
  readonly billedTokens: number | null;
  readonly rateUsdPerMillionTokens: number | null;
  readonly costUsd: number | null;
  readonly reason: string | null;
}

export interface CostEstimate {
  readonly version: typeof PRICING_VERSION;
  readonly kind: "estimated";
  readonly currency: "USD";
  readonly rateRevision: FrozenRateRevision | null;
  readonly contextBandMaximum: number | null;
  readonly categories: readonly CategoryCost[];
  readonly totalUsd: number | null;
  readonly coverage: "complete" | "unavailable";
  readonly reasons: readonly string[];
}
