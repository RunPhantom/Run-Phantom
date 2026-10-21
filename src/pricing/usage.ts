import { PRICING_VERSION, TOKEN_CATEGORIES, type DetailCategory, type Inclusion, type NormalizedUsage, type TokenCategory, type TokenMeasure } from "./protocol";

const COUNT_ATTRIBUTES: Record<TokenCategory, readonly string[]> = {
  input: ["gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens", "ai.usage.inputTokens", "ai.usage.promptTokens", "ai.usage.prompt_tokens", "llm.token_count.prompt"],
  output: ["gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens", "ai.usage.outputTokens", "ai.usage.completionTokens", "ai.usage.completion_tokens", "llm.token_count.completion"],
  cache_read: ["gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.input_tokens.cached", "runphantom.usage.cache_read_tokens"],
  cache_write: ["gen_ai.usage.cache_creation.input_tokens", "runphantom.usage.cache_write_tokens"],
  cache_write_5m: ["runphantom.usage.cache_write_5m_tokens"],
  cache_write_1h: ["runphantom.usage.cache_write_1h_tokens"],
  reasoning: ["gen_ai.usage.output_tokens.reasoning", "runphantom.usage.reasoning_tokens"],
  audio_input: ["gen_ai.usage.input_tokens.audio", "runphantom.usage.audio_input_tokens"],
  audio_output: ["gen_ai.usage.output_tokens.audio", "runphantom.usage.audio_output_tokens"],
};

function ownValue(attributes: Record<string, unknown>, key: string): { present: boolean; value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(attributes, key);
  return descriptor ? { present: true, value: "value" in descriptor ? descriptor.value : undefined } : { present: false, value: undefined };
}

export function validTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function measure(attributes: Record<string, unknown>, keys: readonly string[]): TokenMeasure {
  const present = keys.map(key => ({ key, ...ownValue(attributes, key) })).filter(item => item.present);
  if (!present.length) return { count: null, state: "missing", attributes: [] };
  const sources = present.map(item => item.key);
  if (present.some(item => !validTokenCount(item.value))) return { count: null, state: "invalid", attributes: sources };
  if (present.some(item => item.value !== present[0].value)) return { count: null, state: "conflicting", attributes: sources };
  return { count: present[0].value as number, state: "known", attributes: sources };
}

function identity(attributes: Record<string, unknown>, keys: readonly string[]): string | null {
  const present = keys.map(key => ownValue(attributes, key)).filter(item => item.present);
  if (!present.length) return null;
  const value = present[0].value;
  if (typeof value !== "string" || !value.length || value.length > 256 || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return null;
  return present.every(item => item.value === value) ? value : null;
}

function declaration(attributes: Record<string, unknown>, key: string): boolean | null {
  const value = ownValue(attributes, key).value;
  return typeof value === "boolean" ? value : null;
}

function inclusion(attributes: Record<string, unknown>, key: string): Inclusion {
  const value = declaration(attributes, key);
  return value === true ? "included" : value === false ? "additional" : "unknown";
}

/** Provider names are identity only: an absent exporter declaration never implies cache semantics. */
export function normalizeUsage(attributes: Record<string, unknown>, provider: string | null = null): NormalizedUsage {
  const categories = Object.fromEntries(TOKEN_CATEGORIES.map(category => [category, measure(attributes, COUNT_ATTRIBUTES[category])])) as Record<TokenCategory, TokenMeasure>;
  const issues: string[] = [];
  const unit = ownValue(attributes, "runphantom.usage.unit");
  if (unit.present && unit.value !== "tokens") {
    issues.push("invalid_usage_unit");
    for (const category of TOKEN_CATEGORIES) categories[category] = { ...categories[category], count: null, state: "invalid" };
  }
  const capturedProvider = identity(attributes, ["gen_ai.provider.name", "gen_ai.system", "ai.model.provider"]);
  const suppliedProvider = provider === null ? null : identity({ provider }, ["provider"]);
  if (capturedProvider === null && ["gen_ai.provider.name", "gen_ai.system", "ai.model.provider"].some(key => ownValue(attributes, key).present)) issues.push("invalid_or_conflicting_provider");
  if (provider !== null && suppliedProvider === null) issues.push("invalid_provider");
  if (capturedProvider !== null && suppliedProvider !== null && capturedProvider !== suppliedProvider) issues.push("conflicting_provider");
  const responseKeys = ["gen_ai.response.model", "ai.response.model", "llm.response.model_name"];
  const hasResponseModel = responseKeys.some(key => ownValue(attributes, key).present);
  const relations: Record<DetailCategory, Inclusion> = {
    cache_read: inclusion(attributes, "runphantom.usage.input_includes_cache"),
    cache_write: inclusion(attributes, "runphantom.usage.input_includes_cache"),
    cache_write_5m: inclusion(attributes, "runphantom.usage.input_includes_cache"),
    cache_write_1h: inclusion(attributes, "runphantom.usage.input_includes_cache"),
    reasoning: inclusion(attributes, "runphantom.usage.output_includes_reasoning"),
    audio_input: inclusion(attributes, "runphantom.usage.input_includes_audio"),
    audio_output: inclusion(attributes, "runphantom.usage.output_includes_audio"),
  };
  for (const category of TOKEN_CATEGORIES) {
    Object.freeze(categories[category].attributes);
    Object.freeze(categories[category]);
  }
  const contextTokens = measure(attributes, ["runphantom.usage.context_tokens"]);
  Object.freeze(contextTokens.attributes);
  Object.freeze(contextTokens);
  return Object.freeze({
    version: PRICING_VERSION,
    provider: issues.some(issue => issue.endsWith("provider")) ? null : suppliedProvider ?? capturedProvider,
    model: identity(attributes, hasResponseModel ? responseKeys : ["gen_ai.request.model", "ai.model.id", "llm.request.model", "llm.model_name"]),
    tier: identity(attributes, ["runphantom.usage.tier", "gen_ai.request.service_tier"]),
    contextTokens,
    categories: Object.freeze(categories),
    inclusion: Object.freeze(relations),
    inputDetailsDisjoint: declaration(attributes, "runphantom.usage.input_categories_disjoint"),
    outputDetailsDisjoint: declaration(attributes, "runphantom.usage.output_categories_disjoint"),
    issues: Object.freeze(issues),
  });
}
