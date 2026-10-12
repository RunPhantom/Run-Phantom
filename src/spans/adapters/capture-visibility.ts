import { defaultIsSensitiveKey } from "../../verification/redaction";
import { redactText } from "../../verification/serialization";
import { hasDuplicateJsonKeys } from "../../json-keys";
import { validateOtlpEvidence, OTLP_EVIDENCE_LIMITS, type OtlpEvidence, type EvidenceAttribute, type EvidenceValue } from "../otlp-evidence";
import type { AdapterInput, SpanAdapter } from "./types";

export const CAPTURE_LIMITS = { bytes: 65536, text: 4096, chunks: 64, chunkText: 2048, streamText: 16384, filterBytes: 8192, filterDepth: 6, filterNodes: 256, filterEntries: 64 } as const;
import type { CaptureReason, RetrievalCapture, EmbeddingCapture, StreamCapture, CaptureVisibilityV1 } from "./capture-visibility-types";
export type { CaptureVisibilityV1 } from "./capture-visibility-types";
const placeholder = /\[(?:REDACTED|TRUNCATED|UNAVAILABLE|UNSERIALIZABLE)\]/;
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff;
const own = (v: unknown, key: string): unknown => {
  if (!v || typeof v !== "object") return undefined;
  const d = Object.getOwnPropertyDescriptor(v, key); return d && "value" in d ? d.value : undefined;
};
function primitive(value: EvidenceValue): string | number | boolean | null {
  if ("stringValue" in value) return value.stringValue;
  if ("boolValue" in value) return value.boolValue;
  if ("doubleValue" in value) return value.doubleValue;
  if ("intValue" in value) { const n = Number(value.intValue); return Number.isSafeInteger(n) ? n : null; }
  return null;
}
function fields(items: EvidenceAttribute[]): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = Object.create(null);
  for (const item of items) result[item.key] = Object.hasOwn(result, item.key) ? null : primitive(item.value);
  return result;
}
function safeText(v: unknown, maximum: number = CAPTURE_LIMITS.text): string | null {
  if (typeof v !== "string") return null;
  // Oversize values are withheld whole, so cutting a secret never creates a safe-looking prefix.
  if (v.length > maximum) return "[TRUNCATED]";
  const safe = redactText(v.replace(/\0/g, "\uFFFD"));
  return safe.length <= maximum ? safe : "[TRUNCATED]";
}
export function sanitizeCaptureFilter(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (Buffer.byteLength(raw) > CAPTURE_LIMITS.filterBytes) return "[TRUNCATED]";
  if (["[REDACTED]", "[TRUNCATED]", "[UNAVAILABLE]"].includes(raw)) return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (hasDuplicateJsonKeys(raw) || !parsed || typeof parsed !== "object") return "[UNAVAILABLE]";
    let nodes = 0;
    const visit = (v: unknown, depth: number): unknown => {
      if (++nodes > CAPTURE_LIMITS.filterNodes || depth > CAPTURE_LIMITS.filterDepth) throw new Error("bounded filter");
      if (typeof v === "string") return safeText(v);
      if (v === null || typeof v === "boolean" || typeof v === "number") return v;
      if (Array.isArray(v)) { if (v.length > CAPTURE_LIMITS.filterEntries) throw new Error("bounded filter"); return v.map(item => visit(item, depth + 1)); }
      const out: Record<string, unknown> = Object.create(null);
      const entries = Object.entries(v as object);
      if (entries.length > CAPTURE_LIMITS.filterEntries) throw new Error("bounded filter");
      for (const [key, item] of entries) {
        if (key.length > 256 || ["__proto__", "prototype", "constructor"].includes(key)) throw new Error("invalid filter key");
        out[safeText(key, 256)!] = (defaultIsSensitiveKey(key) || key === "runphantom.agent.definition") ? "[REDACTED]" : visit(item, depth + 1);
      }
      return out;
    };
    const output = JSON.stringify(visit(parsed, 0));
    return Buffer.byteLength(output) <= CAPTURE_LIMITS.filterBytes ? output : "[TRUNCATED]";
  } catch { return "[UNAVAILABLE]"; }
}
export function captureKind(attrs: AdapterInput["attrs"]): "RETRIEVAL" | "EMBEDDING" | null {
  const local = attrs["runphantom.span.kind"];
  if (local === "retrieval") return "RETRIEVAL";
  if (local === "embedding") return "EMBEDDING";
  if (attrs["openinference.span.kind"] === "RETRIEVER") return "RETRIEVAL";
  if (attrs["openinference.span.kind"] === "EMBEDDING") return "EMBEDDING";
  if (attrs["gen_ai.operation.name"] === "retrieval") return "RETRIEVAL";
  if (attrs["gen_ai.operation.name"] === "embeddings") return "EMBEDDING";
  return attrs["db.system.name"] === "qdrant" && attrs["db.operation.name"] === "SEARCH" ? "RETRIEVAL" : null;
}
export function readCaptureReceipt(value: unknown): OtlpEvidence | undefined {
  if (typeof value !== "string" || Buffer.byteLength(value) > OTLP_EVIDENCE_LIMITS.bytes) return undefined;
  try { const receipt: unknown = JSON.parse(value); validateOtlpEvidence(receipt); return receipt; } catch { return undefined; }
}
const filterKeys = new Set(["db.filter"]);
const textKeys = new Set(["db.collection.name", "db.query.summary", "db.query.text", "gen_ai.retrieval.query", "gen_ai.retrieval.query.text", "gen_ai.retrieval.source"]);
/** Only owned metadata carriers are interpreted. Ordinary message/body strings stay literal. */
export function publicCaptureMetadata<T extends { attributes?: unknown; otlp_evidence?: unknown }>(row: T): T {
  let changed = false;
  const sanitize = (key: string, value: unknown): unknown => filterKeys.has(key) ? sanitizeCaptureFilter(value) : textKeys.has(key) ? safeText(value) : value;
  let attributes = row.attributes, receipt = row.otlp_evidence;
  if (typeof attributes === "string") {
    try {
      const parsed: unknown = JSON.parse(attributes);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const key of [...filterKeys, ...textKeys]) {
          const old = own(parsed, key); if (old === undefined) continue;
          const safe = sanitize(key, old); if (safe !== old) { (parsed as Record<string, unknown>)[key] = safe; changed = true; }
        }
        if (changed) attributes = JSON.stringify(parsed);
      }
    } catch { /* No ownership inferred from an unparseable carrier. */ }
  }
  const evidence = readCaptureReceipt(receipt);
  if (evidence) {
    let receiptChanged = false;
    for (const source of [evidence, evidence.resource, evidence.scope, ...evidence.events, ...evidence.links]) {
      if (!source) continue;
      for (const item of source.attributes) {
        if (!filterKeys.has(item.key) && !textKeys.has(item.key)) continue;
        const old = primitive(item.value), safe = sanitize(item.key, old);
        if (safe !== old) { item.value = { stringValue: typeof safe === "string" ? safe : "[UNAVAILABLE]" }; evidence.capture.redactedValues++; receiptChanged = true; }
      }
    }
    if (receiptChanged) { receipt = JSON.stringify(evidence); changed = true; }
  }
  return changed ? { ...row, attributes, otlp_evidence: receipt } : row;
}
export function captureVisibility(input: AdapterInput): CaptureVisibilityV1 | undefined {
  const evidence = input.otlpEvidence;
  const attrs = evidence ? fields(evidence.attributes) : input.attrs;
  const retrievalKind = input.spanType === "RETRIEVAL", embeddingKind = input.spanType === "EMBEDDING";
  const hasStream = attrs["gen_ai.request.stream"] === true || attrs["gen_ai.request.is_stream"] === true || evidence?.events.some(e => e.name.startsWith("runphantom.stream."));
  const usageKeys = ["gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cache_creation.input_tokens", "gen_ai.usage.reasoning_tokens", "gen_ai.usage.completion_tokens_details.reasoning"];
  if (!retrievalKind && !embeddingKind && !hasStream && !usageKeys.some(key => attrs[key] !== undefined)) return undefined;
  const reasons = new Set<CaptureReason>();
  if (!evidence) reasons.add("missing-source-evidence");
  const number = (...keys: string[]): number | null => {
    const found = keys.map(key => attrs[key]).filter(v => v !== undefined);
    if (!found.length) return null;
    if (!found.every(v => uint(v))) { reasons.add("invalid-field"); return null; }
    if (!found.every(v => v === found[0])) { reasons.add("metadata-conflict"); return null; }
    return found[0] as number;
  };
  const text = (...keys: string[]): string | null => {
    const found = keys.map(key => attrs[key]).filter(v => v !== undefined);
    if (!found.length) return null;
    if (!found.every(v => typeof v === "string") || !found.every(v => v === found[0])) { reasons.add("metadata-conflict"); return null; }
    const safe = safeText(found[0]);
    if (safe === "[TRUNCATED]") reasons.add("content-truncated");
    if (safe?.includes("[REDACTED]")) reasons.add("content-redacted");
    return safe;
  };
  const retrieval: RetrievalCapture | null = retrievalKind ? { kind: "retrieval", collection: text("db.collection.name"), topK: number("db.vector.query.top_k"),
    filter: sanitizeCaptureFilter(attrs["db.filter"]), resultCount: number("db.n_results", "gen_ai.retrieval.document_count"),
    querySummary: text("db.query.summary"), queryText: text("gen_ai.retrieval.query.text", "gen_ai.retrieval.query", "db.query.text") } : null;
  const embedding: EmbeddingCapture | null = embeddingKind ? { kind: "embedding", model: text("gen_ai.request.model", "llm.model_name"),
    dimensions: number("gen_ai.embeddings.dimension.count", "gen_ai.request.embedding_dimension"), inputText: text("gen_ai.input.messages") } : null;
  if (retrieval?.filter?.includes("[REDACTED]")) reasons.add("content-redacted");
  if (retrieval?.filter === "[UNAVAILABLE]") reasons.add("content-unavailable");
  if (retrieval?.filter?.includes("[TRUNCATED]")) reasons.add("content-truncated");
  // F10's mandatory sensitive-key floor withholds *_tokens receipt values.
  // Read only the exact numeric usage allowlist from the canonical flat map;
  // token counts cannot carry content and never feed stream completion.
  const usageNumber = (...keys: string[]): number | null => {
    const found = keys.map(key => input.attrs[key]).filter(v => v !== undefined);
    if (!found.length) return null;
    if (!found.every(uint)) { reasons.add("invalid-field"); return null; }
    if (!found.every(v => v === found[0])) { reasons.add("metadata-conflict"); return null; }
    return found[0] as number;
  };
  const usage = { cacheReadInputTokens: usageNumber(usageKeys[0]), cacheCreationInputTokens: usageNumber(usageKeys[1]), reasoningOutputTokens: usageNumber(...usageKeys.slice(2)) };
  if (evidence?.capture.droppedEvents || evidence?.capture.droppedAttributes || evidence?.capture.invalidValues || evidence?.capture.truncatedValues) reasons.add("receiver-loss");
  if (evidence && (evidence.droppedEventsCount !== 0 || evidence.droppedAttributesCount !== 0)) reasons.add("source-loss");
  let stream: StreamCapture | null = null;
  if (hasStream) {
    const streamReasons = new Set<CaptureReason>();
    const chunks = new Map<number, StreamCapture["chunks"][number]>();
    const terminals: Array<{ state: NonNullable<StreamCapture["reportedTerminal"]>; count: number | null }> = [];
    let duplicateChunkCount = 0, observedChunkCount = 0, totalText = 0;
    for (const [sourceEventIndex, event] of (evidence?.events ?? []).entries()) {
      const fieldsInEvent = fields(event.attributes);
      if (event.name === "runphantom.stream.chunk") {
        observedChunkCount++;
        const sequence = fieldsInEvent["runphantom.stream.sequence"];
        if (!uint(sequence)) { streamReasons.add("invalid-field"); continue; }
        const raw = fieldsInEvent["runphantom.stream.text"];
        let capturedText = safeText(raw, CAPTURE_LIMITS.chunkText);
        if (capturedText === null || placeholder.test(capturedText)) streamReasons.add("content-unavailable");
        const old = chunks.get(sequence);
        if (old) {
          if (old.text === capturedText && old.timeUnixNano === event.timeUnixNano) duplicateChunkCount++;
          else streamReasons.add("duplicate-conflict");
          continue;
        }
        if (chunks.size >= CAPTURE_LIMITS.chunks) { streamReasons.add("content-truncated"); continue; }
        totalText += capturedText?.length ?? 0;
        if (totalText > CAPTURE_LIMITS.streamText) { capturedText = "[TRUNCATED]"; streamReasons.add("content-truncated"); }
        chunks.set(sequence, { sequence, sourceEventIndex, timeUnixNano: event.timeUnixNano, text: capturedText });
      } else if (["runphantom.stream.completed", "runphantom.stream.cancelled", "runphantom.stream.error"].includes(event.name)) {
        const count = fieldsInEvent["runphantom.stream.chunk_count"];
        terminals.push({ state: event.name.slice("runphantom.stream.".length) as NonNullable<StreamCapture["reportedTerminal"]>, count: uint(count) ? count : null });
      } else if (event.name.startsWith("runphantom.stream.")) streamReasons.add("unsupported-event");
      if (event.name.startsWith("runphantom.stream.") && event.droppedAttributesCount !== 0) streamReasons.add("source-loss");
    }
    const sameTerminal = terminals.length && terminals.every(item => item.state === terminals[0].state && item.count === terminals[0].count);
    if (terminals.length > 1 && !sameTerminal) streamReasons.add("terminal-conflict");
    const reportedTerminal = sameTerminal ? terminals[0].state : null;
    const declaredChunkCount = sameTerminal ? terminals[0].count : null;
    const ordered = [...chunks.values()].sort((a, b) => a.sequence - b.sequence);
    if (reportedTerminal === "completed") {
      if (declaredChunkCount === null) streamReasons.add("missing-roster");
      else if (declaredChunkCount !== ordered.length || ordered.some((item, index) => item.sequence !== index)) streamReasons.add("missing-chunk");
    }
    for (const reason of reasons) if (["missing-source-evidence", "source-loss", "receiver-loss"].includes(reason)) streamReasons.add(reason);
    const timing = (...keys: string[]): number | null => {
      const found = keys.map(key => attrs[key]).filter(v => v !== undefined);
      if (!found.length) return null;
      if (!found.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v * 1000 <= Number.MAX_SAFE_INTEGER)) { reasons.add("invalid-field"); return null; }
      if (!found.every(v => v === found[0])) { reasons.add("metadata-conflict"); return null; }
      return (found[0] as number) * 1000;
    };
    const state = streamReasons.size ? "incomplete" : reportedTerminal ?? "unknown";
    let finishReasons: string[] = [];
    const finish = attrs["gen_ai.response.finish_reasons"];
    if (typeof finish === "string" && finish.length <= 4096) { try { const parsed: unknown = JSON.parse(finish); if (Array.isArray(parsed)) finishReasons = parsed.slice(0, 8).map(v => safeText(v, 256)).filter((v): v is string => v !== null); } catch { /* Unsupported report stays absent. */ } }
    stream = { requested: attrs["gen_ai.request.stream"] === true || attrs["gen_ai.request.is_stream"] === true ? true : null,
      state: reportedTerminal === "cancelled" || reportedTerminal === "error" ? reportedTerminal : state,
      reportedTerminal, coverage: state === "completed" ? "complete" : ordered.length ? "partial" : "unavailable", chunks: ordered,
      observedChunkCount, duplicateChunkCount, declaredChunkCount, timeToFirstChunkMs: timing("gen_ai.response.time_to_first_chunk", "gen_ai.server.time_to_first_token", "gen_ai.client.operation.time_to_first_chunk"),
      timePerOutputChunkMs: timing("gen_ai.server.time_per_output_token", "gen_ai.client.operation.time_per_output_chunk"), finishReasons, reasons: [...streamReasons] };
  }
  const result: CaptureVisibilityV1 = { schemaVersion: 1, source: { traceId: safeText(input.traceId, 1024), spanId: safeText(input.spanId, 1024), scopeName: evidence?.scope?.name ?? null, scopeVersion: evidence?.scope?.version ?? null,
    kindSource: retrievalKind || embeddingKind ? ["runphantom.span.kind", "openinference.span.kind", "gen_ai.operation.name", "db.operation.name"].find(key => attrs[key] !== undefined) ?? null : null },
    retrieval, embedding, stream, usage, coverage: { reasons: [...reasons], receiverDroppedEvents: evidence?.capture.droppedEvents ?? 0,
      exporterDroppedEvents: evidence?.droppedEventsCount ?? null, receiverDroppedAttributes: evidence?.capture.droppedAttributes ?? 0, exporterDroppedAttributes: evidence?.droppedAttributesCount ?? null,
      invalidValues: evidence?.capture.invalidValues ?? 0, truncatedValues: evidence?.capture.truncatedValues ?? 0, redactedValues: evidence?.capture.redactedValues ?? 0 } };
  if (Buffer.byteLength(JSON.stringify(result)) > CAPTURE_LIMITS.bytes) {
    result.retrieval = null; result.embedding = null; result.coverage.reasons = [...new Set([...result.coverage.reasons, "content-truncated" as const])];
    if (result.stream) { result.stream.chunks = []; result.stream.state = "incomplete"; result.stream.coverage = "unavailable"; result.stream.reasons.push("content-truncated"); }
  }
  return result;
}
export const captureKindAdapter: SpanAdapter = {
  name: "captured-operation",
  apply(input) {
    const capture = captureVisibility(input);
    if (input.spanType === "RETRIEVAL" && capture?.retrieval) return { normalized: capture.retrieval };
    if (input.spanType === "EMBEDDING" && capture?.embedding) return { normalized: capture.embedding };
    return null;
  },
};
