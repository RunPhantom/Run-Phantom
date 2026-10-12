import { createHash } from "node:crypto";
import { hasDuplicateJsonKeys } from "./json-keys";
import { parseJsonEvidence } from "./evaluations/json-evidence";
import { isSensitiveKey } from "./verification/redaction";
import { redactText } from "./verification/serialization";
import { OTLP_EVIDENCE_LIMITS, validateOtlpEvidence, type EvidenceAttribute, type EvidenceValue, type OtlpEvidence } from "./spans/otlp-evidence";
import { AGENT_DEFINITION_CAPTURE_KEY as KEY, AGENT_DEFINITION_FORMAT as FORMAT, AGENT_DEFINITION_LIMITS as L, DEFINITION_COMPONENTS,
  type CapturedAgentDefinition, type CapturedAgentDefinitions, type DefinitionAvailability, type DefinitionCaptureSpan, type DefinitionComponent, type DefinitionComponentEvidence } from "./agent-definitions-protocol";

const unavailable = /\[(?:REDACTED|TRUNCATED|UNAVAILABLE|UNSERIALIZABLE|CIRCULAR|COMPACTED)\]|__REDACTED__/i;
const size = (s: string) => Buffer.byteLength(s, "utf8");
const hash = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const own = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== "object") return undefined;
  const d = Object.getOwnPropertyDescriptor(value, key); return d && "value" in d ? d.value : undefined;
};

/** Public views retain F10's ordered receipt and loss contract while withholding private definition content. */
export function withholdAgentDefinitionCapture<T extends { attributes?: unknown; otlp_evidence?: unknown }>(span: T): T {
  const fail = (): never => { throw new TypeError("Public definition capture is unavailable"); };
  // A carrier has an extra JSON string layer. Scan escape runs once with a
  // fixed-size window; this detects candidates and never authorizes projection.
  const mayContainKey = (raw: string): boolean => {
    if (raw.includes(KEY)) return true;
    if (!raw.includes("\\u")) return false;
    let window = "", escaped = "", at = 0;
    const candidate = (char: string): boolean => {
      if (escaped) {
        escaped += char;
        if ((escaped.length === 2 && char !== "u") || (escaped.length > 2 && !/^[\da-f]$/i.test(char))) {
          escaped = char === "\\" ? "\\" : ""; window = ""; return false;
        }
        if (escaped.length < 6) return false;
        char = String.fromCharCode(parseInt(escaped.slice(2), 16)); escaped = "";
      } else if (char === "\\") { escaped = char; return false; }
      window = (window + char).slice(-KEY.length);
      return window === KEY;
    };
    while (at < raw.length) {
      let char = raw[at++];
      if (char === "\\") {
        while (raw[at] === "\\") at++;
        const hex = raw.slice(at + 1, at + 5);
        if (raw[at] !== "u" || !/^[\da-f]{4}$/i.test(hex)) { window = ""; escaped = ""; continue; }
        char = String.fromCharCode(parseInt(hex, 16)); at += 5;
      }
      if (candidate(char)) return true;
    }
    return false;
  };
  let attributes = span.attributes, receipt = span.otlp_evidence;
  const relevantFlat = typeof attributes === "string" && mayContainKey(attributes);
  let typed: OtlpEvidence | undefined;
  if (typeof receipt === "string" && (relevantFlat || mayContainKey(receipt))) {
    if (receipt.length > OTLP_EVIDENCE_LIMITS.bytes || size(receipt) > OTLP_EVIDENCE_LIMITS.bytes) fail();
    let parsed: OtlpEvidence; try { parsed = JSON.parse(receipt); validateOtlpEvidence(parsed); } catch { fail(); }
    typed = parsed!;
  }
  const nestedDefinition = (value: EvidenceValue): boolean => "kvlistValue" in value
    ? value.kvlistValue.values.some(entry => entry.key === KEY || nestedDefinition(entry.value))
    : "arrayValue" in value && value.arrayValue.values.some(nestedDefinition);
  const sources = typed ? [typed.resource, typed.scope, typed].filter(source => source !== null) : [];
  const carriers = new Set(sources.flatMap(source => source!.attributes.filter(entry => nestedDefinition(entry.value)).map(entry => entry.key)));
  let flat: Record<string, unknown> | undefined, flatAmbiguous = false;
  if (typeof attributes === "string" && (relevantFlat || carriers.size > 0)) {
    if (attributes.length > 10 * 1024 * 1024 || size(attributes) > 10 * 1024 * 1024) fail();
    let parsed: unknown; try { parsed = JSON.parse(attributes); } catch { fail(); }
    if (object(parsed)) { flat = parsed; flatAmbiguous = hasDuplicateJsonKeys(attributes); }
  }
  if (flat) {
    let changed = false;
    const replace = (key: string, value: unknown) => { if (flat![key] !== value) { flat![key] = value; changed = true; } };
    // Only ordered typed composites authorize projecting a flat companion.
    // A genuine stringValue, even one that looks like JSON, remains a string.
    const flatten = (value: EvidenceValue, project: boolean): unknown => {
      if ("stringValue" in value) return value.stringValue;
      if ("boolValue" in value) return value.boolValue;
      if ("bytesValue" in value) return value.bytesValue;
      if ("doubleValue" in value) return value.doubleValue;
      if ("intValue" in value) { const n = Number(value.intValue); return Number.isSafeInteger(n) ? n : "[UNAVAILABLE]"; }
      if ("arrayValue" in value) return value.arrayValue.values.map(child => flatten(child, project));
      const result: Record<string, unknown> = Object.create(null), seen = new Set<string>();
      for (const entry of value.kvlistValue.values) {
        if (seen.has(entry.key)) throw new TypeError("Ambiguous composite");
        seen.add(entry.key); result[entry.key] = project && entry.key === KEY ? "[REDACTED]" : flatten(entry.value, project);
      }
      return result;
    };
    const lossy = typed && (Object.entries(typed.capture).some(([key, value]) => key !== "redactedValues" && typeof value === "number" && value > 0)
      || sources.some(source => (source!.droppedAttributesCount ?? 0) > 0));
    for (const [key, value] of Object.entries(flat)) {
      if (key === KEY) { replace(key, "[REDACTED]"); continue; }
      if (!carriers.has(key) && !mayContainKey(typeof value === "string" ? value : JSON.stringify(value))) continue;
      const observations = sources.flatMap(source => source!.attributes.filter(entry => entry.key === key));
      if (flatAmbiguous || observations.length !== 1) { replace(key, "[UNAVAILABLE]"); continue; }
      const observed = observations[0].value;
      if ("stringValue" in observed && observed.stringValue === value) continue;
      if (lossy || !("arrayValue" in observed || "kvlistValue" in observed)) { replace(key, "[UNAVAILABLE]"); continue; }
      try {
        const original = JSON.stringify(flatten(observed, false));
        if (original !== value) { replace(key, "[UNAVAILABLE]"); continue; }
        replace(key, JSON.stringify(flatten(observed, true)));
      } catch { replace(key, "[UNAVAILABLE]"); }
    }
    if (changed) attributes = JSON.stringify(flat);
  }
  if (typed) {
    const parsed = typed;
    let withheld = 0;
    const value = (entry: EvidenceValue) => {
      if ("kvlistValue" in entry) visit(entry.kvlistValue.values);
      else if ("arrayValue" in entry) for (const child of entry.arrayValue.values) value(child);
    };
    const visit = (entries: EvidenceAttribute[]) => {
      for (const entry of entries) {
        if (entry.key === KEY) {
          if (!("stringValue" in entry.value) || entry.value.stringValue !== "[REDACTED]") {
            entry.value = { stringValue: "[REDACTED]" }; withheld++;
          }
        } else value(entry.value);
      }
    };
    for (const source of [parsed, parsed.resource, parsed.scope, ...parsed.events, ...parsed.links]) if (source) visit(source.attributes);
    if (withheld) {
      if (parsed.capture.redactedValues > 0xffffffff - withheld) fail();
      parsed.capture.redactedValues += withheld;
      // The fixed marker can expand a short captured value; retain the original
      // closed receipt validator and byte ceiling after projection too.
      try { validateOtlpEvidence(parsed); } catch { fail(); }
      receipt = JSON.stringify(parsed);
    }
  }
  return attributes === span.attributes && receipt === span.otlp_evidence ? span : { ...span, ...(span.attributes !== undefined ? { attributes } : {}), ...(span.otlp_evidence !== undefined ? { otlp_evidence: receipt } : {}) };
}
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
      if (!Number.isFinite(raw) || Object.is(raw, -0) || Number.isInteger(raw) && !Number.isSafeInteger(raw)) throw new Unavailable("invalid");
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
    safeString(raw);
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
    const id = own(row, "id"); let sourceSpanId: string | null = null;
    if (typeof id === "string" && id.length <= 4096 && size(id) <= 4096 && !id.includes("\0")) try { safeString(id); sourceSpanId = id; } catch { /* No public source identity from invalid or redacted text. */ }
    const record: CapturedAgentDefinition = { sourceSpanId,
      provenance: hasExplicit ? "explicit-v1" : "legacy-attributes", complete: false, semanticVersion: FORMAT, sha256: null, components: empty("missing"), reasons: [] };
    if (!record.sourceSpanId || idCounts.get(id as string) !== 1) { record.sourceSpanId = null; record.reasons.push("source_identity_unavailable"); }
    if (hasExplicit) {
      if (!receipt) record.reasons.push("source_receipt_missing");
      else {
        if (observed.length !== 1 || [...receipt.resource?.attributes ?? [], ...receipt.scope?.attributes ?? []].some(a => a.key === KEY)) record.reasons.push("capture_ambiguous");
        if (Object.values(receipt.capture).some(v => typeof v === "number" && v > 0)
          || [receipt.droppedAttributesCount, receipt.resource?.droppedAttributesCount, receipt.scope?.droppedAttributesCount, receipt.droppedEventsCount, receipt.droppedLinksCount].some(value => (value ?? 0) > 0)) record.reasons.push("source_receipt_loss");
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

/** Validate frozen safe metadata independently of mutable raw spans; absent legacy metadata is handled by callers. */
export function parseCapturedAgentDefinitions(value: unknown): CapturedAgentDefinitions {
  const fail = (): never => { throw new TypeError("Invalid captured definition provenance"); };
  const closed = (raw: unknown, keys: readonly string[]) => {
    if (!object(raw)) return fail();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (Reflect.ownKeys(raw).length !== keys.length || keys.some(key => !descriptors[key] || !("value" in descriptors[key]))) fail();
    return raw as Record<string, unknown>;
  };
  const list = (raw: unknown, max: number): unknown[] => {
    if (!Array.isArray(raw) || raw.length > max || Object.getPrototypeOf(raw) !== Array.prototype || Object.keys(raw).length !== raw.length) return fail();
    for (let i = 0; i < raw.length; i++) if (!("value" in Object.getOwnPropertyDescriptor(raw, String(i))!)) fail();
    return raw;
  };
  const count = (raw: unknown): number => typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 && raw <= 5000 ? raw : fail();
  const digest = (raw: unknown): string | null => raw === null ? null : typeof raw === "string" && /^[0-9a-f]{64}$/.test(raw) ? raw : fail();
  const bool = (raw: unknown): boolean => typeof raw === "boolean" ? raw : fail();
  const reasons = ["capture_missing", "capture_unavailable", "capture_ambiguous", "capture_invalid", "capture_partial", "capture_redacted", "capture_oversized", "source_receipt_missing", "source_receipt_loss", "source_identity_unavailable"];
  const statuses: DefinitionAvailability[] = ["available", "missing", "redacted", "invalid", "oversized", "ambiguous", "incomplete"];
  const top = closed(value, ["format", "records", "observedRecords", "omittedRecords", "unavailableAttributes", "complete"]);
  if (top.format !== "runphantom-agent-definitions/v1") fail();
  const records = list(top.records, L.records).map(raw => {
    const rec = closed(raw, ["sourceSpanId", "provenance", "complete", "semanticVersion", "sha256", "components", "reasons"]);
    if (rec.semanticVersion !== FORMAT || !["explicit-v1", "legacy-attributes"].includes(rec.provenance as string)) fail();
    if (rec.sourceSpanId !== null) {
      try { safeString(rec.sourceSpanId); } catch { return fail(); }
      if (!rec.sourceSpanId || rec.sourceSpanId.length > 4096 || size(rec.sourceSpanId) > 4096 || rec.sourceSpanId.includes("\0")) fail();
    }
    const rawComponents = closed(rec.components, DEFINITION_COMPONENTS);
    const components = Object.fromEntries(DEFINITION_COMPONENTS.map(key => {
      const part = closed(rawComponents[key], ["status", "sha256"]);
      if (!statuses.includes(part.status as DefinitionAvailability)) fail();
      const sha256 = digest(part.sha256); if ((part.status === "available") !== (sha256 !== null)) fail();
      return [key, { status: part.status, sha256 }];
    })) as CapturedAgentDefinition["components"];
    const codes = list(rec.reasons, reasons.length).map(code => typeof code === "string" && reasons.includes(code) ? code : fail());
    if (new Set(codes).size !== codes.length) fail();
    const complete = bool(rec.complete), sha256 = digest(rec.sha256);
    if (complete !== (sha256 !== null) || complete && (rec.provenance !== "explicit-v1" || rec.sourceSpanId === null || codes.length || DEFINITION_COMPONENTS.some(key => components[key].status !== "available"))) fail();
    if (!complete && !codes.length) fail();
    return { sourceSpanId: rec.sourceSpanId, provenance: rec.provenance, semanticVersion: FORMAT, complete, sha256, components, reasons: codes } as CapturedAgentDefinition;
  });
  const ids = records.filter(r => r.sourceSpanId !== null).map(r => r.sourceSpanId); if (new Set(ids).size !== ids.length) fail();
  const result: CapturedAgentDefinitions = { format: "runphantom-agent-definitions/v1", records, observedRecords: count(top.observedRecords), omittedRecords: count(top.omittedRecords), unavailableAttributes: count(top.unavailableAttributes), complete: bool(top.complete) };
  if (result.observedRecords !== records.length + result.omittedRecords || result.complete !== (records.length > 0 && !result.omittedRecords && !result.unavailableAttributes && records.every(r => r.complete)) || size(JSON.stringify(result)) > L.metadataBytes) fail();
  return result;
}
