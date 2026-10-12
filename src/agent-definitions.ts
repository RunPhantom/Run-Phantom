import { createHash } from "node:crypto";
import { hasDuplicateJsonKeys } from "./json-keys";
import { parseJsonEvidence } from "./evaluations/json-evidence";
import { isSensitiveKey } from "./verification/redaction";
import { redactText } from "./verification/serialization";
import { validateOtlpEvidence, type OtlpEvidence } from "./spans/otlp-evidence";
import { AGENT_DEFINITION_CAPTURE_KEY as KEY, AGENT_DEFINITION_FORMAT as FORMAT, AGENT_DEFINITION_LIMITS as L, DEFINITION_COMPONENTS,
  type CapturedAgentDefinition, type CapturedAgentDefinitions, type DefinitionAvailability, type DefinitionCaptureSpan, type DefinitionComponent, type DefinitionComponentEvidence } from "./agent-definitions-protocol";

const unavailable = /\[(?:REDACTED|TRUNCATED|UNAVAILABLE|UNSERIALIZABLE|CIRCULAR|COMPACTED)\]|__REDACTED__/i;
const size = (s: string) => Buffer.byteLength(s, "utf8");
const hash = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const own = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== "object") return undefined;
  const d = Object.getOwnPropertyDescriptor(value, key); return d && "value" in d ? d.value : undefined;
};
class Unavailable extends Error { constructor(readonly status: DefinitionAvailability) { super(status); } }
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function codepointOrder(a: string, b: string): number {
  const left = Array.from(a), right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) { const delta = left[i].codePointAt(0)! - right[i].codePointAt(0)!; if (delta) return delta; }
  return left.length - right.length;
}
function safeString(value: unknown): asserts value is string {
  if (typeof value !== "string" || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw new Unavailable("invalid");
  if (value.length > L.fieldBytes || size(value) > L.fieldBytes) throw new Unavailable("oversized");
  if (redactText(value) !== value || /\[REDACTED\]|__REDACTED__/i.test(value)) throw new Unavailable("redacted");
  if (unavailable.test(value)) throw new Unavailable("incomplete");
}
/** Canonical captured JSON: codepoint key order, literal string bytes, exact finite numbers and material array order. */
function canonical(value: unknown): string {
  let nodes = 0;
  function visit(raw: unknown, depth: number): string {
    if (++nodes > L.nodes || depth > L.depth) throw new Unavailable("oversized");
    if (raw === null || typeof raw === "boolean") return JSON.stringify(raw);
    if (typeof raw === "number") {
      if (!Number.isFinite(raw) || Number.isInteger(raw) && !Number.isSafeInteger(raw)) throw new Unavailable("invalid");
      return JSON.stringify(raw);
    }
    if (typeof raw === "string") { safeString(raw); return JSON.stringify(raw); }
    if (Array.isArray(raw)) return `[${raw.map(item => visit(item, depth + 1)).join(",")}]`;
    if (!object(raw)) throw new Unavailable("invalid");
    const keys = Reflect.ownKeys(raw);
    if (keys.some(key => typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key as string))) throw new Unavailable("invalid");
    return `{${(keys as string[]).sort(codepointOrder).map(key => {
      safeString(key); if (isSensitiveKey(key)) throw new Unavailable("redacted");
      const d = Object.getOwnPropertyDescriptor(raw, key)!; if (!("value" in d)) throw new Unavailable("invalid");
      return `${JSON.stringify(key)}:${visit(d.value, depth + 1)}`;
    }).join(",")}}`;
  }
  const result = visit(value, 0); if (size(result) > L.fieldBytes) throw new Unavailable("oversized"); return result;
}
function decode(raw: unknown): unknown {
  if (typeof raw !== "string") throw new Unavailable("invalid");
  if (raw.length > L.fieldBytes || size(raw) > L.fieldBytes) throw new Unavailable("oversized");
  const parsed = parseJsonEvidence(raw);
  if (hasDuplicateJsonKeys(raw)) throw new Unavailable("ambiguous");
  return parsed;
}
function status(error: unknown): DefinitionAvailability { return error instanceof Unavailable ? error.status : "invalid"; }
const empty = (s: DefinitionAvailability): Record<DefinitionComponent, DefinitionComponentEvidence> => Object.fromEntries(DEFINITION_COMPONENTS.map(key => [key, { status: s, sha256: null }])) as Record<DefinitionComponent, DefinitionComponentEvidence>;
const reasonFor = (s: DefinitionAvailability): CapturedAgentDefinition["reasons"][number] => s === "redacted" ? "capture_redacted" : s === "oversized" ? "capture_oversized" : s === "ambiguous" ? "capture_ambiguous" : s === "invalid" ? "capture_invalid" : s === "missing" ? "capture_missing" : "capture_partial";
function tools(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Unavailable("invalid");
  if (value.length > L.tools) throw new Unavailable("oversized");
  const named = value.map(raw => {
    if (!object(raw)) throw new Unavailable("invalid");
    const definition = raw.type === "function" && object(raw.function) ? raw.function : raw;
    safeString(definition.name); if (!definition.name) throw new Unavailable("incomplete");
    if (typeof definition.description !== "string" || !["parameters", "input_schema", "schema"].some(key => Object.hasOwn(definition, key))) throw new Unavailable("incomplete");
    const schemas = ["parameters", "input_schema", "schema"].filter(key => Object.hasOwn(definition, key));
    if (schemas.length !== 1 || !(object(definition[schemas[0]]) || typeof definition[schemas[0]] === "boolean")) throw new Unavailable(schemas.length > 1 ? "ambiguous" : "incomplete");
    return { name: definition.name, raw };
  });
  if (new Set(named.map(t => t.name)).size !== named.length) throw new Unavailable("ambiguous");
  return named.sort((a, b) => codepointOrder(a.name, b.name)).map(t => t.raw);
}
function providers(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > L.providers) throw new Unavailable(Array.isArray(value) ? "oversized" : "invalid");
  for (const name of value) { safeString(name); if (!name) throw new Unavailable("incomplete"); }
  // Explicit provider membership is a set; literal names are not aliased, lowercased or trimmed.
  return [...new Set(value as string[])].sort(codepointOrder);
}
function explicit(raw: unknown, record: CapturedAgentDefinition): void {
  let value: unknown;
  try {
    value = decode(raw);
    // Privacy precedes every digest, including a safe-looking prompt inside a secret-bearing definition.
    canonical(value);
    if (!object(value) || value.version !== 1 || Object.keys(value).some(k => !["version", "systemPrompt", "tools", "model", "providers", "runtime"].includes(k))) throw new Unavailable("invalid");
  } catch (error) { const s = status(error); record.components = empty(s); record.reasons.push(reasonFor(s)); return; }
  const definition = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const component of DEFINITION_COMPONENTS) {
    const key = component === "prompt" ? "systemPrompt" : component;
    if (!Object.hasOwn(definition, key)) { record.components[component] = { status: "missing", sha256: null }; continue; }
    try {
      let v = definition[key];
      if (component === "prompt" || component === "model") safeString(v);
      if (component === "tools") v = tools(v);
      if (component === "providers") v = providers(v);
      if (component === "runtime" && !object(v)) throw new Unavailable("invalid");
      normalized[key] = v;
      record.components[component] = { status: "available", sha256: component === "prompt" ? hash(v as string) : hash(canonical({ component, value: v })) };
    } catch (error) { const s = status(error); record.components[component] = { status: s, sha256: null }; record.reasons.push(reasonFor(s)); }
  }
  if (DEFINITION_COMPONENTS.some(key => record.components[key].status !== "available")) record.reasons.push("capture_partial");
  if (!record.reasons.length) { record.complete = true; record.sha256 = hash(canonical({ format: FORMAT, ...normalized })); }
}
function legacy(attrs: Record<string, unknown>, record: CapturedAgentDefinition): void {
  const keys = { prompt: "gen_ai.system_instructions", tools: "gen_ai.tool.definitions", model: "gen_ai.request.model", providers: "gen_ai.provider.name" } as const;
  record.reasons.push("capture_partial");
  // All legacy fields are observed attributes, never a user's input or an executed tool-call list.
  for (const component of ["prompt", "tools", "model", "providers"] as const) {
    const raw = attrs[keys[component]]; if (raw === undefined) continue;
    try {
      canonical(raw);
      const value = component === "tools" ? tools(decode(raw)) : raw;
      if (component !== "tools") safeString(value);
      record.components[component] = { status: "available", sha256: component === "prompt" ? hash(value as string) : hash(canonical({ component, value })) };
    } catch (error) { record.components[component] = { status: status(error), sha256: null }; }
  }
}
/** Uses one already-admitted span population; never acquires data, writes state, or infers invocation identity. */
export function deriveCapturedAgentDefinitions(spans: readonly DefinitionCaptureSpan[], maxBytes: number = L.metadataBytes): CapturedAgentDefinitions | undefined {
  if (spans.length > 5000 || !Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > L.metadataBytes) throw new TypeError("Definition population exceeds its bound");
  const result: CapturedAgentDefinitions = { format: "runphantom-agent-definitions/v1", records: [], observedRecords: 0, omittedRecords: 0, unavailableAttributes: 0, complete: false };
  let admittedBytes = 0;
  for (const row of spans) for (const key of ["attributes", "otlp_evidence"]) {
    const raw = own(row, key);
    if (typeof raw === "string") {
      if (raw.length > 32 * 1024 * 1024) throw new TypeError("Definition bytes exceed their admission bound");
      admittedBytes += size(raw);
      if (admittedBytes > 32 * 1024 * 1024) throw new TypeError("Definition bytes exceed their admission bound");
    }
  }
  const idCounts = new Map<string, number>(); for (const row of spans) { const id = own(row, "id"); if (typeof id === "string") idCounts.set(id, (idCounts.get(id) ?? 0) + 1); }
  for (const row of spans) {
    const unavailableRow = own(row, "unavailable");
    const attributes = own(row, "attributes"); let attrs: Record<string, unknown> = {};
    if (own(row, "attributes_oversized") || own(unavailableRow, "attributes")) result.unavailableAttributes++;
    else if (attributes !== null && attributes !== undefined) try { const raw = decode(attributes); if (object(raw)) attrs = raw; else result.unavailableAttributes++; } catch { result.unavailableAttributes++; }
    let receipt: OtlpEvidence | null = null, receiptState: DefinitionAvailability = "missing";
    const receiptRaw = own(row, "otlp_evidence");
    if (own(row, "otlp_evidence_oversized") || own(unavailableRow, "otlpEvidence")) receiptState = "oversized";
    else if (receiptRaw != null) try { const decoded = decode(receiptRaw); validateOtlpEvidence(decoded); receipt = decoded; receiptState = "available"; } catch (error) { receiptState = status(error); }
    const observed = receipt?.attributes.filter(attribute => attribute.key === KEY) ?? [];
    const hasExplicit = Object.hasOwn(attrs, KEY) || observed.length > 0;
    const hasLegacy = ["gen_ai.system_instructions", "gen_ai.tool.definitions"].some(key => Object.hasOwn(attrs, key));
    if (!hasExplicit && !hasLegacy) continue;
    result.observedRecords++;
    if (result.records.length >= L.records) continue;
    const id = own(row, "id");
    const record: CapturedAgentDefinition = { sourceSpanId: typeof id === "string" && size(id) <= 4096 && redactText(id) === id && !unavailable.test(id) ? id : null,
      provenance: hasExplicit ? "explicit-v1" : "legacy-attributes", complete: false, semanticVersion: FORMAT, sha256: null, components: empty("missing"), reasons: [] };
    if (!record.sourceSpanId || idCounts.get(id as string) !== 1) { record.sourceSpanId = null; record.reasons.push("source_identity_unavailable"); }
    if (hasExplicit) {
      if (!receipt) record.reasons.push("source_receipt_missing");
      else {
        if (observed.length !== 1 || [...receipt.resource?.attributes ?? [], ...receipt.scope?.attributes ?? []].some(a => a.key === KEY)) record.reasons.push("capture_ambiguous");
        if (Object.values(receipt.capture).some(v => typeof v === "number" && v > 0) || (receipt.droppedAttributesCount ?? 0) > 0) record.reasons.push("source_receipt_loss");
        if (observed.length === 1 && !Object.hasOwn(observed[0].value, "stringValue")) record.reasons.push("capture_invalid");
      }
      const raw = observed.length === 1 ? own(observed[0].value, "stringValue") : attrs[KEY];
      explicit(raw, record);
      if (!receipt && receiptState !== "missing") record.reasons.push(reasonFor(receiptState));
    } else legacy(attrs, record);
    record.reasons = [...new Set(record.reasons)];
    result.records.push(record);
  }
  if (!result.observedRecords && !result.unavailableAttributes) return undefined;
  result.omittedRecords = result.observedRecords - result.records.length;
  const complete = () => result.records.length > 0 && !result.omittedRecords && !result.unavailableAttributes && result.records.every(r => r.complete);
  result.complete = complete();
  while (size(JSON.stringify(result)) > maxBytes && result.records.length) { result.records.pop(); result.omittedRecords++; result.complete = false; }
  if (size(JSON.stringify(result)) > maxBytes) return undefined;
  return result;
}
