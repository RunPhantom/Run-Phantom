import { hasDuplicateJsonKeys } from "../json-keys";
import { parseJsonEvidence } from "../evaluations/json-evidence";
import { calculateCost } from "./calculator";
import { TOKEN_CATEGORIES, type FrozenRateRevision, type TokenCategory } from "./protocol";
import { freezeRateRevision, NOMINAL_CATALOGUE_PROVIDER, NOMINAL_CATALOGUE_TIER, NOMINAL_CATALOGUE_URL, selectRateRevision } from "./rates";
import { normalizeUsage } from "./usage";

export const COST_ANALYTICS_VERSION = "runphantom-cost-analytics/1" as const;
export const ANALYTICS_LIMITS = Object.freeze({ requestBytes: 256 * 1024, rates: 128, spans: 10_000, attributeBytes: 16 * 1024 * 1024, projectionBytes: 16 * 1024 * 1024, groups: 1_000, ancestryDepth: 256, windowMs: 31 * 86_400_000 });
const REPORTED_COST_KEYS = ["gen_ai.usage.cost_usd", "gen_ai.usage.cost", "runphantom.cost.usd", "llm.cost.total", "llm.usage.cost", "ai.usage.cost"] as const;
const MODEL_KEYS = ["gen_ai.response.model", "ai.response.model", "llm.response.model_name", "gen_ai.request.model", "ai.model.id", "llm.request.model", "llm.model_name"];
const INPUT_KEYS = ["gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens", "ai.usage.inputTokens", "ai.usage.promptTokens", "ai.usage.prompt_tokens", "llm.token_count.prompt"];
const OUTPUT_KEYS = ["gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens", "ai.usage.outputTokens", "ai.usage.completionTokens", "ai.usage.completion_tokens", "llm.token_count.completion"];

export class CostAnalyticsError extends Error {
  constructor(readonly code: "invalid_request" | "too_large", message: string) { super(message); }
}
const invalid = () => new CostAnalyticsError("invalid_request", "Invalid cost analytics request");
const large = () => new CostAnalyticsError("too_large", "Cost analytics exceeds a complete-population limit; select a smaller window");

export interface CostAnalyticsRequest {
  readonly from: number;
  readonly to: number;
  readonly bucket: "hour" | "day";
  readonly estimateMode: "captured" | "nominal-input-output";
  readonly rates: readonly FrozenRateRevision[];
}
/** Storage adapters supply only this projection, never prompts, responses or credential context. */
export interface AnalyticsSpan {
  readonly projectId: string;
  readonly runId: string;
  readonly id: string;
  readonly parentSpanId: string | null;
  readonly kind: string | null;
  readonly startedAt: number | null;
  readonly model: string | null;
  readonly provider: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly attributes: string | null;
  readonly attributesUnavailable?: boolean;
}
const PROJECTION_STRINGS = ["projectId", "runId", "id", "parentSpanId", "kind", "model", "provider", "attributes"] as const;
/** Match SQLite BLOB byte admission without allocating an encoded copy of a field. */
function utf8Bytes(value: string, remaining: number): number {
  if (value.length > remaining) throw large();
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
    else bytes += 3;
    if (bytes > remaining) throw large();
  }
  return bytes;
}
/** Guard direct callers before hashing, redaction, ancestry keys or normalization. */
export function assertCostAnalyticsProjection(spans: readonly AnalyticsSpan[]): void {
  if (spans.length > ANALYTICS_LIMITS.spans) throw large();
  let projectionBytes = 0, attributeBytes = 0;
  for (const span of spans) for (const key of PROJECTION_STRINGS) {
    const value = span[key];
    if (value === null) {
      if (key === "projectId" || key === "runId" || key === "id") throw invalid();
      continue;
    }
    if (typeof value !== "string") throw invalid();
    const bytes = utf8Bytes(value, ANALYTICS_LIMITS.projectionBytes - projectionBytes);
    projectionBytes += bytes;
    if (key === "attributes" && (attributeBytes += bytes) > ANALYTICS_LIMITS.attributeBytes) throw large();
  }
}
export interface MetricPopulation {
  readonly eligibleCount: number;
  readonly knownCount: number;
  readonly unavailableCount: number;
  readonly zeroCount: number;
  readonly knownSum: number | null;
  readonly completeTotal: number | null;
  readonly sumState: "known" | "empty" | "overflow";
  readonly unavailableReasons: Readonly<Record<string, number>>;
}
export interface AnalyticsPopulation {
  readonly reportedUsd: MetricPopulation;
  readonly estimatedUsd: MetricPopulation;
  readonly tokens: Readonly<Record<TokenCategory, MetricPopulation>>;
}
export interface AnalyticsGroup extends AnalyticsPopulation { readonly identity: string | null }
export interface CostAnalytics extends AnalyticsPopulation {
  readonly version: typeof COST_ANALYTICS_VERSION;
  readonly currency: "USD";
  readonly window: { readonly from: number; readonly to: number; readonly bucket: "hour" | "day"; readonly timezone: "UTC"; readonly field: "generationStartedAt" };
  readonly estimateMode: CostAnalyticsRequest["estimateMode"];
  readonly population: { readonly selectedGenerations: number; readonly nestedExcluded: number; readonly ancestryUnavailable: number; readonly untimedGenerations: number; readonly outsideWindow: number; readonly acquiredSpans: number };
  readonly untimed: AnalyticsPopulation;
  readonly byModel: readonly AnalyticsGroup[];
  readonly byProvider: readonly AnalyticsGroup[];
  readonly byProject: readonly AnalyticsGroup[];
  readonly byTime: readonly AnalyticsGroup[];
  readonly rateRevisions: readonly FrozenRateRevision[];
}
export interface CostAnalyticsReport extends CostAnalytics {
  readonly asOf: number;
  readonly scope: { readonly kind: "local" | "team"; readonly projectId: string };
  readonly sourceRevision: string;
  readonly rateAuthority: "request-declared";
}
const hasOwn = (value: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some(item => !("value" in item))) throw invalid();
  return Object.fromEntries(Object.entries(descriptors).map(([key, item]) => [key, item.value]));
}
export function parseCostAnalyticsRequest(value: unknown): CostAnalyticsRequest {
  const item = object(value);
  if (Object.keys(item).some(key => !["from", "to", "bucket", "estimateMode", "rates"].includes(key))
    || typeof item.from !== "number" || !Number.isSafeInteger(item.from) || item.from < 0
    || typeof item.to !== "number" || !Number.isSafeInteger(item.to) || item.to <= item.from || item.to > 8_640_000_000_000_000
    || item.to - item.from > ANALYTICS_LIMITS.windowMs
    || item.bucket !== "hour" && item.bucket !== "day" || item.estimateMode !== "captured" && item.estimateMode !== "nominal-input-output"
    || !Array.isArray(item.rates) || item.rates.length > ANALYTICS_LIMITS.rates) throw invalid();
  const rates: FrozenRateRevision[] = [];
  try {
    for (let index = 0; index < item.rates.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(item.rates, String(index));
      if (!descriptor || !("value" in descriptor)) throw invalid();
      rates.push(freezeRateRevision(descriptor.value));
    }
  } catch { throw invalid(); }
  const identities = rates.map(rate => JSON.stringify([rate.provider, rate.model, rate.tier, rate.revision]));
  if (new Set(identities).size !== rates.length) throw invalid();
  if (item.estimateMode === "nominal-input-output" && rates.some(rate => rate.provider !== NOMINAL_CATALOGUE_PROVIDER || rate.tier !== NOMINAL_CATALOGUE_TIER
    || rate.source.kind !== "catalogue" || rate.source.reference !== NOMINAL_CATALOGUE_URL || rate.bands.length !== 1
    || TOKEN_CATEGORIES.some(category => rate.bands[0].categories[category].kind !== (category === "input" || category === "output" ? "priced" : "not_applicable")))) throw invalid();
  return Object.freeze({ from: item.from, to: item.to, bucket: item.bucket as CostAnalyticsRequest["bucket"], estimateMode: item.estimateMode as CostAnalyticsRequest["estimateMode"], rates: Object.freeze(rates) });
}

interface MutableMetric { eligibleCount: number; knownCount: number; zeroCount: number; sum: number; overflow: boolean; reasons: Record<string, number> }
type MutablePopulation = { reportedUsd: MutableMetric; estimatedUsd: MutableMetric; tokens: Record<TokenCategory, MutableMetric> };
const metric = (): MutableMetric => ({ eligibleCount: 0, knownCount: 0, zeroCount: 0, sum: 0, overflow: false, reasons: Object.create(null) });
const population = (): MutablePopulation => ({ reportedUsd: metric(), estimatedUsd: metric(), tokens: Object.fromEntries(TOKEN_CATEGORIES.map(category => [category, metric()])) as Record<TokenCategory, MutableMetric> });
function add(target: MutableMetric, value: number | null, reasons: readonly string[], integer = false): void {
  target.eligibleCount++;
  if (value === null || !Number.isFinite(value) || value < 0 || integer && !Number.isSafeInteger(value)) {
    for (const reason of new Set(reasons.length ? reasons : ["unavailable"])) target.reasons[reason] = (target.reasons[reason] ?? 0) + 1;
    return;
  }
  target.knownCount++;
  if (value === 0) target.zeroCount++;
  const sum = target.sum + value;
  if (!Number.isFinite(sum) || integer && !Number.isSafeInteger(sum) || sum > Number.MAX_SAFE_INTEGER) target.overflow = true;
  else target.sum = sum;
}
function finishMetric(item: MutableMetric): MetricPopulation {
  const knownSum = item.knownCount && !item.overflow ? item.sum : null;
  return Object.freeze({ eligibleCount: item.eligibleCount, knownCount: item.knownCount, unavailableCount: item.eligibleCount - item.knownCount,
    zeroCount: item.zeroCount, knownSum, completeTotal: item.eligibleCount && item.knownCount === item.eligibleCount && !item.overflow ? item.sum : null,
    sumState: item.overflow ? "overflow" : item.knownCount ? "known" : "empty", unavailableReasons: Object.freeze({ ...item.reasons }) });
}
function finish(item: MutablePopulation): AnalyticsPopulation {
  return Object.freeze({ reportedUsd: finishMetric(item.reportedUsd), estimatedUsd: finishMetric(item.estimatedUsd), tokens: Object.freeze(Object.fromEntries(TOKEN_CATEGORIES.map(category => [category, finishMetric(item.tokens[category])])) as Record<TokenCategory, MetricPopulation>) });
}
function attributes(span: AnalyticsSpan): { values: Record<string, unknown>; unavailable: boolean } {
  if (span.attributesUnavailable) return { values: {}, unavailable: true };
  if (span.attributes === null) return { values: {}, unavailable: false };
  try {
    if (span.attributes.length > 64 * 1024 || hasDuplicateJsonKeys(span.attributes)) return { values: {}, unavailable: true };
    return { values: object(parseJsonEvidence(span.attributes)), unavailable: false };
  } catch { return { values: {}, unavailable: true }; }
}
function reported(values: Record<string, unknown>, unavailable: boolean): { value: number | null; reasons: string[] } {
  if (unavailable) return { value: null, reasons: ["attributes_unavailable"] };
  if (hasOwn(values, "runphantom.cost.currency") && values["runphantom.cost.currency"] !== "USD") return { value: null, reasons: ["reported_currency_unavailable"] };
  const observed = REPORTED_COST_KEYS.filter(key => hasOwn(values, key)).map(key => values[key]);
  if (!observed.length) return { value: null, reasons: ["reported_cost_missing"] };
  if (observed.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0)) return { value: null, reasons: ["reported_cost_invalid"] };
  if (observed.some(value => value !== observed[0])) return { value: null, reasons: ["reported_cost_conflicting"] };
  return { value: observed[0] as number, reasons: [] };
}
const spanKey = (span: AnalyticsSpan, id = span.id): string => JSON.stringify([span.projectId, span.runId, id]);

/** Entire selected-run ancestry must be acquired before calling; incomplete graphs never prove a standalone generation. */
export function aggregateCostAnalytics(spans: readonly AnalyticsSpan[], input: CostAnalyticsRequest): CostAnalytics {
  const request = parseCostAnalyticsRequest(input);
  assertCostAnalyticsProjection(spans);
  const byId = new Map<string, AnalyticsSpan>();
  const duplicates = new Set<string>();
  for (const span of spans) {
    const key = spanKey(span);
    if (byId.has(key)) duplicates.add(key);
    byId.set(key, span);
  }
  const ancestry = (span: AnalyticsSpan): "root" | "nested" | "unavailable" => {
    const seen = new Set<string>();
    let current: AnalyticsSpan | undefined = span;
    let nested = false;
    while (current) {
      const key = spanKey(current);
      if (seen.size >= ANALYTICS_LIMITS.ancestryDepth || seen.has(key) || duplicates.has(key)) return "unavailable";
      seen.add(key);
      if (current !== span && current.kind === "LLM_GENERATION") nested = true;
      if (!current.parentSpanId) return nested ? "nested" : "root";
      current = byId.get(spanKey(span, current.parentSpanId));
      if (!current) return "unavailable";
    }
    return "unavailable";
  };
  const total = population(), untimed = population();
  const groups = { byModel: new Map<string | null, MutablePopulation>(), byProvider: new Map<string | null, MutablePopulation>(), byProject: new Map<string | null, MutablePopulation>(), byTime: new Map<string | null, MutablePopulation>() };
  const counts = { selectedGenerations: 0, nestedExcluded: 0, ancestryUnavailable: 0, untimedGenerations: 0, outsideWindow: 0, acquiredSpans: spans.length };
  let groupCount = 0;
  for (const span of spans) {
    if (span.kind !== "LLM_GENERATION") continue;
    const timed = typeof span.startedAt === "number" && Number.isFinite(span.startedAt) && span.startedAt >= 0 && span.startedAt <= 8_640_000_000_000_000;
    if (timed && (span.startedAt! < request.from || span.startedAt! >= request.to)) { counts.outsideWindow++; continue; }
    const structure = ancestry(span);
    if (structure === "nested") { counts.nestedExcluded++; continue; }
    if (structure === "unavailable") counts.ancestryUnavailable++;
    if (timed) counts.selectedGenerations++; else counts.untimedGenerations++;
    const captured = attributes(span);
    const values = { ...captured.values };
    if (!MODEL_KEYS.some(key => hasOwn(values, key)) && span.model !== null) values["gen_ai.response.model"] = span.model;
    if (!INPUT_KEYS.some(key => hasOwn(values, key)) && span.inputTokens !== null) values["gen_ai.usage.input_tokens"] = span.inputTokens;
    if (!OUTPUT_KEYS.some(key => hasOwn(values, key)) && span.outputTokens !== null) values["gen_ai.usage.output_tokens"] = span.outputTokens;
    if (captured.unavailable) values["runphantom.usage.unit"] = "unavailable";
    const usage = normalizeUsage(values, span.provider);
    const quoteUsage = request.estimateMode === "nominal-input-output" ? normalizeUsage({
      "gen_ai.response.model": usage.model, "runphantom.usage.tier": NOMINAL_CATALOGUE_TIER,
      "gen_ai.usage.input_tokens": usage.categories.input.count, "gen_ai.usage.output_tokens": usage.categories.output.count,
    }, NOMINAL_CATALOGUE_PROVIDER) : usage;
    const rate = selectRateRevision(quoteUsage, request.rates);
    const estimate = rate ? calculateCost(quoteUsage, rate) : null;
    const capturedCost = reported(values, captured.unavailable);
    const loss = !timed ? ["timestamp_unavailable"] : structure === "unavailable" ? ["ancestry_unavailable"] : [];
    // An untimed capture might belong inside the window; retain it in the
    // unavailable denominator so timed subtotals never certify full coverage.
    const targets = timed ? [total] : [total, untimed];
    const identities = { byModel: usage.model, byProvider: usage.provider, byProject: span.projectId, byTime: timed ? new Date(Math.floor(span.startedAt! / (request.bucket === "hour" ? 3_600_000 : 86_400_000)) * (request.bucket === "hour" ? 3_600_000 : 86_400_000)).toISOString() : null };
    for (const key of Object.keys(groups) as Array<keyof typeof groups>) {
      const identity = identities[key];
      if (!groups[key].has(identity)) { if (++groupCount > ANALYTICS_LIMITS.groups) throw large(); groups[key].set(identity, population()); }
      targets.push(groups[key].get(identity)!);
    }
    for (const target of targets) {
      add(target.reportedUsd, loss.length ? null : capturedCost.value, loss.length ? loss : capturedCost.reasons);
      add(target.estimatedUsd, loss.length ? null : estimate?.totalUsd ?? null, loss.length ? loss : estimate?.reasons ?? ["rate_identity_unavailable"]);
      for (const category of TOKEN_CATEGORIES) {
        const measure = usage.categories[category];
        add(target.tokens[category], loss.length ? null : measure.count, loss.length ? loss : [`usage_${measure.state}`], true);
      }
    }
  }
  const finishGroups = (items: Map<string | null, MutablePopulation>): readonly AnalyticsGroup[] => Object.freeze([...items].sort(([a], [b]) => a === null ? 1 : b === null ? -1 : a < b ? -1 : a > b ? 1 : 0).map(([identity, item]) => Object.freeze({ identity, ...finish(item) })));
  return Object.freeze({ ...finish(total), version: COST_ANALYTICS_VERSION, currency: "USD", window: Object.freeze({ from: request.from, to: request.to, bucket: request.bucket, timezone: "UTC", field: "generationStartedAt" }),
    estimateMode: request.estimateMode, population: Object.freeze(counts), untimed: finish(untimed), byModel: finishGroups(groups.byModel), byProvider: finishGroups(groups.byProvider), byProject: finishGroups(groups.byProject), byTime: finishGroups(groups.byTime), rateRevisions: request.rates });
}
