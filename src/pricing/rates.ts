import { PRICING_VERSION, TOKEN_CATEGORIES, type CategoryRate, type ContextRateBand, type FrozenRateRevision, type ModelIdentity, type NormalizedUsage, type TokenCategory } from "./protocol";
import { validTokenCount } from "./usage";

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Rate revision requires an object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some(item => !("value" in item))) throw new Error("Rate revision must not contain accessors");
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function fields(item: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(item).some(key => !allowed.includes(key))) throw new Error("Unsupported rate field");
}

function boundedArray(value: unknown, maximum: number, minimum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`Rate array requires ${minimum} to ${maximum} entries`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) throw new Error("Rate arrays must not contain holes or accessors");
    return descriptor.value;
  });
}

function text(value: unknown, field: string, maximum = 256): string {
  if (typeof value !== "string" || !value.length || value.length > maximum || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error(`Invalid rate ${field}`);
  return value;
}

function modelIdentity(value: unknown): ModelIdentity {
  const item = record(value);
  return Object.freeze({ provider: text(item.provider, "provider"), model: text(item.model, "model"), tier: text(item.tier, "tier") });
}

function categoryRate(value: unknown, category: TokenCategory): CategoryRate {
  const item = record(value);
  fields(item, item.kind === "priced" ? ["kind", "usdPerMillionTokens"] : ["kind"]);
  if (item.kind === "priced") {
    if (typeof item.usdPerMillionTokens !== "number" || !Number.isFinite(item.usdPerMillionTokens) || item.usdPerMillionTokens < 0) throw new Error(`Invalid ${category} rate`);
    return Object.freeze({ kind: "priced", usdPerMillionTokens: item.usdPerMillionTokens });
  }
  if (item.kind === "included" && category !== "input" && category !== "output") return Object.freeze({ kind: "included" });
  if (item.kind === "not_applicable" || item.kind === "unavailable") return Object.freeze({ kind: item.kind });
  throw new Error(`Invalid ${category} billing policy`);
}

/** Copies the supplied values before freezing, so later catalogue/override edits cannot rewrite an estimate. */
export function freezeRateRevision(value: unknown): FrozenRateRevision {
  const item = record(value);
  fields(item, ["provider", "model", "tier", "version", "revision", "currency", "unit", "source", "aliases", "bands"]);
  if (item.version !== PRICING_VERSION || item.currency !== "USD" || item.unit !== "usd_per_million_tokens") throw new Error("Unsupported pricing version, currency or units");
  const source = record(item.source);
  fields(source, ["kind", "name", "reference", "observedAt"]);
  if (source.kind !== "manual" && source.kind !== "catalogue" && source.kind !== "capture") throw new Error("Invalid rate source kind");
  const observedAt = text(source.observedAt, "source timestamp");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(observedAt) || !Number.isFinite(Date.parse(observedAt))) throw new Error("Invalid rate source timestamp");
  const canonicalTimestamp = observedAt.includes(".") ? observedAt.replace(/(\.\d{1,3})Z$/, fraction => `${fraction.slice(0, -1).padEnd(4, "0")}Z`) : observedAt.replace("Z", ".000Z");
  if (new Date(observedAt).toISOString() !== canonicalTimestamp) throw new Error("Invalid rate source timestamp");
  const canonical = modelIdentity(item);
  const aliases = boundedArray(item.aliases, 32, 0).map((value: unknown) => { const alias = record(value); fields(alias, ["provider", "model", "tier"]); return modelIdentity(alias); });
  const identities = [canonical, ...aliases].map(alias => JSON.stringify([alias.provider, alias.model, alias.tier]));
  if (new Set(identities).size !== identities.length) throw new Error("Duplicate model identity");
  const suppliedBands = boundedArray(item.bands, 8, 1);
  let previousMaximum = -1;
  const bands: ContextRateBand[] = suppliedBands.map((value: unknown, index: number) => {
    const band = record(value);
    fields(band, ["maxContextTokens", "categories"]);
    const last = index === suppliedBands.length - 1;
    if (last ? band.maxContextTokens !== null : !validTokenCount(band.maxContextTokens) || band.maxContextTokens <= previousMaximum) throw new Error("Context bands require increasing inclusive maxima and an unbounded final band");
    if (typeof band.maxContextTokens === "number") previousMaximum = band.maxContextTokens;
    const supplied = record(band.categories);
    fields(supplied, TOKEN_CATEGORIES);
    const categories = Object.fromEntries(TOKEN_CATEGORIES.map(category => [category, categoryRate(supplied[category], category)])) as Record<TokenCategory, CategoryRate>;
    return Object.freeze({ maxContextTokens: band.maxContextTokens as number | null, categories: Object.freeze(categories) });
  });
  return Object.freeze({
    ...canonical, version: PRICING_VERSION, revision: text(item.revision, "revision"), currency: "USD", unit: "usd_per_million_tokens",
    source: Object.freeze({ kind: source.kind, name: text(source.name, "source name"), reference: source.reference === null ? null : text(source.reference, "source reference", 2048), observedAt }),
    aliases: Object.freeze(aliases), bands: Object.freeze(bands),
  });
}

export function rateMatchesUsage(usage: NormalizedUsage, revision: FrozenRateRevision): boolean {
  return [revision, ...revision.aliases].some(identity => identity.provider === usage.provider && identity.model === usage.model && identity.tier === usage.tier);
}

/** Ambiguous or approximate matches are unavailable; catalogue ordering never picks a price. */
export function selectRateRevision(usage: NormalizedUsage, revisions: readonly FrozenRateRevision[]): FrozenRateRevision | null {
  const matches = revisions.filter(revision => rateMatchesUsage(usage, revision));
  return matches.length === 1 ? matches[0] : null;
}
