import { createHash } from "node:crypto";
import { EVALUATION_LIMITS, type Rule, type Snapshot } from "../evaluations/protocol";
import { boundedText, fields, object, parseId, parseRule, parseVersion, EvaluationError } from "../evaluations/validation";
import { parseJsonEvidence } from "../evaluations/json-evidence";
import { sanitizeSnapshotText } from "../evaluations/snapshot";
import { hasDuplicateJsonKeys } from "../json-keys";
import { isSensitiveKey } from "../verification/redaction";
import { REVIEW_LIMITS as L, type ReviewSchema, type ReviewField, type ReviewScalar, type ReviewDraft,
  type ReviewSource, type CompiledReviewCase, type PromotionRequest, type ReviewCursor, type ReviewMutation } from "./protocol";

export class ReviewQueueError extends EvaluationError {
  constructor(public readonly code: string, message: string, status = 400) {
    super(message, status); this.name = "ReviewQueueError";
  }
}
function fail(message: string): never { throw new ReviewQueueError("invalid_request", message); }
export function boundedReviewBytes(value: string, max: number, label: string): string {
  if (Buffer.byteLength(value) > max) throw new ReviewQueueError("size_limit", `${label} exceeds its byte limit`, 413);
  return value;
}
function list(value: unknown, label: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max) fail(`${label} requires ${min} to ${max} entries`);
  for (const key of Reflect.ownKeys(value)) {
    if (key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) fail(`${label} requires ordinary JSON arrays`);
  }
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) fail(`${label} cannot contain accessors or holes`);
    return descriptor.value;
  });
}
function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail(`${label} must be boolean`);
  return value;
}
function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail(`${label} must be a finite exact number`);
  return value;
}
export function reviewTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("timestamp must be nonnegative integer milliseconds");
  return value;
}
function safeText(value: unknown, label: string, max: number, empty = false): string {
  const text = boundedText(value, label, max, empty), safe = sanitizeSnapshotText(text);
  if (safe.redacted || safe.truncated || safe.value !== text) fail(`${label} contains sensitive or unavailable data`);
  return text;
}
function scalar(value: unknown): ReviewScalar {
  if (typeof value === "string") return safeText(value, "target value", L.MAX_STRING, true);
  if (typeof value === "boolean") return value;
  return finite(value, "target value");
}
export function reviewDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("digest must be 64 lowercase hexadecimal characters");
  return value;
}
function canonical(value: unknown, depth = 0): unknown {
  if (depth > 16) fail("review structure exceeds its depth limit");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return finite(value, "canonical number");
  if (Array.isArray(value)) return list(value, "canonical array", 500).map(item => canonical(item, depth + 1));
  const row = object(value, "canonical value"), output: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(row).sort()) output[key] = canonical(row[key], depth + 1);
  return output;
}
export function canonicalReviewJson(value: unknown): string { return JSON.stringify(canonical(value)); }
export function reviewHash(value: unknown): string { return createHash("sha256").update(canonicalReviewJson(value)).digest("hex"); }
export function reviewItemId(queueId: string, runId: string, spanId: string | null): string {
  return reviewHash([parseId(queueId), parseId(runId), spanId === null ? "" : parseId(spanId)]);
}
export function reviewCaseId(queueId: string, itemId: string): string { return reviewHash([parseId(queueId), reviewDigest(itemId)]); }

export const DEFAULT_REVIEW_SCHEMA: ReviewSchema = { fields: [{
  key: "expectedOutput", label: "Expected output", type: "string", required: true, mapping: { kind: "output" },
}] };
export function parseReviewSchema(value: unknown): ReviewSchema {
  const row = object(value, "review schema"); fields(row, ["fields"], "review schema");
  const keys = new Set<string>(), mappings = new Set<string>();
  const schema: ReviewSchema = { fields: list(row.fields, "schema fields", L.MAX_FIELDS, 1).map(raw => {
    const field = object(raw, "schema field");
    fields(field, ["key", "label", "type", "required", "mapping", "choices", "minimum", "maximum"], "schema field");
    const key = safeText(field.key, "field key", L.MAX_FIELD_KEY);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || ["constructor", "prototype", "__proto__"].includes(key) || isSensitiveKey(key) || keys.has(key)) fail("schema field key is unsafe or duplicated");
    keys.add(key);
    if (!["string", "number", "boolean", "enum"].includes(field.type as string)) fail("unsupported schema field type");
    const type = field.type as ReviewField["type"], mapping = object(field.mapping, "field mapping");
    let parsedMapping: ReviewField["mapping"];
    if (mapping.kind === "output") {
      fields(mapping, ["kind"], "output mapping");
      if (type !== "string") fail("output mapping requires a string field");
      parsedMapping = { kind: "output" };
    } else if (mapping.kind === "jsonPath") {
      fields(mapping, ["kind", "path"], "JSON path mapping");
      const rule = parseRule({ kind: "jsonPath", path: mapping.path, equals: 0 }) as Extract<Rule, { kind: "jsonPath" }>;
      parsedMapping = { kind: "jsonPath", path: rule.path };
    } else return fail("unsupported field mapping");
    const mapKey = canonicalReviewJson(parsedMapping);
    if (mappings.has(mapKey)) fail("schema mappings must be unique"); mappings.add(mapKey);
    const result: ReviewField = { key, label: safeText(field.label, "field label", 128), type,
      required: bool(field.required, "required"), mapping: parsedMapping };
    if (type === "enum") {
      const choices = list(field.choices, "enum choices", L.MAX_CHOICES, 1).map(scalar);
      if (choices.some(choice => typeof choice !== typeof choices[0]) || new Set(choices.map(choice => canonicalReviewJson(choice))).size !== choices.length) fail("enum choices must be unique scalars of one exact type");
      choices.forEach(choice => parseRule({ kind: "jsonPath", path: "", equals: choice }));
      result.choices = choices;
    } else if (Object.hasOwn(field, "choices")) fail("choices require an enum field");
    if (Object.hasOwn(field, "minimum") || Object.hasOwn(field, "maximum")) {
      if (type !== "number") fail("numeric bounds require a number field");
      if (Object.hasOwn(field, "minimum")) result.minimum = finite(field.minimum, "minimum");
      if (Object.hasOwn(field, "maximum")) result.maximum = finite(field.maximum, "maximum");
      if (result.minimum !== undefined && result.maximum !== undefined && result.minimum > result.maximum) fail("minimum exceeds maximum");
    }
    return result;
  }) };
  boundedReviewBytes(canonicalReviewJson(schema), L.MAX_SCHEMA_BYTES, "schema");
  return schema;
}
function targetRule(field: ReviewField, value: ReviewScalar): Rule {
  return parseRule(field.mapping.kind === "output" ? { kind: "output", operation: "equals", value }
    : { kind: "jsonPath", path: field.mapping.path, equals: value });
}
export function parseReviewDraft(value: unknown, rawSchema: ReviewSchema, complete = false): ReviewDraft {
  const schema = parseReviewSchema(rawSchema), row = object(value, "review draft");
  fields(row, ["name", "input", "tags", "target", "note"], "review draft");
  const targetRow = object(row.target, "target"), target: Record<string, ReviewScalar> = {};
  fields(targetRow, schema.fields.map(field => field.key), "target");
  for (const field of schema.fields) {
    if (!Object.hasOwn(targetRow, field.key)) { if (complete && field.required) fail("required target field is missing"); continue; }
    const value = scalar(targetRow[field.key]);
    if (field.type === "enum" ? !field.choices!.some(choice => choice === value) : typeof value !== field.type) fail("target field has an incorrect type or choice");
    if (typeof value === "number" && ((field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum))) fail("target field is outside its numeric bounds");
    targetRule(field, value); target[field.key] = value;
  }
  if (complete && !Object.keys(target).length) fail("approval requires at least one target expectation");
  const tags = list(row.tags, "tags", EVALUATION_LIMITS.MAX_TAGS).map(tag => safeText(tag, "tag", 64));
  if (new Set(tags).size !== tags.length) fail("tags must be unique");
  const draft: ReviewDraft = { name: safeText(row.name, "case name", EVALUATION_LIMITS.MAX_NAME),
    input: row.input === null ? null : safeText(row.input, "case input", EVALUATION_LIMITS.MAX_TEXT_BYTES, true),
    tags, target, note: safeText(row.note, "review note", L.MAX_NOTE, true) };
  boundedReviewBytes(canonicalReviewJson(draft), L.MAX_DRAFT_BYTES, "draft");
  return draft;
}
export function parseReviewMutation(value: unknown, schema: ReviewSchema, kind: "save" | "approve" | "reopen"): ReviewMutation {
  const row = object(value, "review mutation");
  fields(row, kind === "reopen" ? ["expectedRevision", "mutationId"] : ["expectedRevision", "mutationId", "draft"], "review mutation");
  return { expectedRevision: parseVersion(row.expectedRevision), mutationId: parseId(row.mutationId),
    ...(kind === "reopen" ? {} : { draft: parseReviewDraft(row.draft, schema, kind === "approve") }) };
}
export function parseReviewSource(value: unknown): ReviewSource {
  const row = object(value, "frozen review source");
  fields(row, ["version", "runId", "requestedOutputSpanId", "resolvedOutputSpanId", "runName", "capturedAt", "input", "output", "sourceSnapshotVersion", "complete", "outputComplete", "redacted", "truncated", "warnings"], "frozen review source");
  if (row.version !== 1 || row.sourceSnapshotVersion !== 1) fail("unsupported frozen source version");
  const input = row.input === null ? null : safeText(row.input, "source input", EVALUATION_LIMITS.MAX_TEXT_BYTES, true);
  const output = row.output === null ? null : safeText(row.output, "source output", EVALUATION_LIMITS.MAX_TEXT_BYTES, true);
  if (input !== null) boundedReviewBytes(input, EVALUATION_LIMITS.MAX_TEXT_BYTES, "source input");
  if (output !== null) boundedReviewBytes(output, EVALUATION_LIMITS.MAX_TEXT_BYTES, "source output");
  const source: ReviewSource = { version: 1, runId: parseId(row.runId),
    requestedOutputSpanId: row.requestedOutputSpanId === null ? null : parseId(row.requestedOutputSpanId),
    resolvedOutputSpanId: row.resolvedOutputSpanId === null ? null : parseId(row.resolvedOutputSpanId),
    runName: safeText(row.runName, "source run name", 128), capturedAt: reviewTimestamp(row.capturedAt), input, output,
    sourceSnapshotVersion: 1, complete: bool(row.complete, "source complete"), outputComplete: bool(row.outputComplete, "output complete"),
    redacted: bool(row.redacted, "source redacted"), truncated: bool(row.truncated, "source truncated"),
    warnings: list(row.warnings, "source warnings", 16).map(warning => safeText(warning, "source warning", 512)) };
  if (source.requestedOutputSpanId !== null && source.requestedOutputSpanId !== source.resolvedOutputSpanId) fail("selected output identity differs from frozen source");
  boundedReviewBytes(canonicalReviewJson(source), L.MAX_SOURCE_BYTES, "source");
  return source;
}
/** Project only reviewed fields; inspect complete values before any display clipping. */
export function freezeReviewSource(snapshot: Snapshot, requestedOutputSpanId: string | null): ReviewSource {
  const input = sanitizeSnapshotText(snapshot.input), output = sanitizeSnapshotText(snapshot.output.value), name = sanitizeSnapshotText(snapshot.runName);
  const warningReports = snapshot.warnings.slice(0, 16).map(sanitizeSnapshotText);
  const warnings = warningReports.map(safe => {
    return safe.redacted || safe.truncated || !safe.value ? "Source evidence is unavailable" : safe.value.slice(0, 512);
  });
  return parseReviewSource({ version: 1, runId: snapshot.runId, requestedOutputSpanId,
    resolvedOutputSpanId: snapshot.output.spanId, runName: name.redacted || !name.value ? "Unavailable run name" : name.value.slice(0, 128),
    capturedAt: snapshot.capturedAt, input: input.redacted || input.truncated ? null : input.value,
    output: output.redacted ? null : output.value, sourceSnapshotVersion: snapshot.version,
    complete: snapshot.complete, outputComplete: snapshot.output.complete,
    redacted: snapshot.redacted || input.redacted || output.redacted || name.redacted || warningReports.some(warning => warning.redacted),
    truncated: snapshot.truncated || input.truncated || output.truncated || name.truncated || (name.value?.length ?? 0) > 128
      || snapshot.warnings.length > 16 || warningReports.some(warning => warning.truncated || (warning.value?.length ?? 0) > 512), warnings });
}
export function compileReviewCase(queueId: string, itemId: string, rawSchema: ReviewSchema, rawDraft: unknown, rawSource: ReviewSource): CompiledReviewCase {
  const schema = parseReviewSchema(rawSchema), draft = parseReviewDraft(rawDraft, schema, true), source = parseReviewSource(rawSource);
  if (itemId !== reviewItemId(queueId, source.runId, source.requestedOutputSpanId)) fail("case source membership identity differs");
  return { id: reviewCaseId(queueId, itemId), name: draft.name, input: draft.input, tags: draft.tags,
    rules: schema.fields.filter(field => Object.hasOwn(draft.target, field.key)).map(field => targetRule(field, draft.target[field.key])),
    sourceRunId: source.runId, sourceSpanId: source.requestedOutputSpanId, sourceOutput: source.output,
    sourceCapturedAt: source.capturedAt, sourceRedacted: source.redacted, sourceTruncated: source.truncated, sourceSnapshotVersion: source.sourceSnapshotVersion };
}
export function parsePromotionRequest(value: unknown): PromotionRequest {
  const row = object(value, "promotion"); fields(row, ["queueId", "datasetId", "expectedDatasetVersion", "idempotencyKey", "items"], "promotion");
  const seen = new Set<string>();
  const items = list(row.items, "promotion items", L.MAX_PROMOTION_ITEMS, 1).map(raw => {
    const item = object(raw, "promotion item"); fields(item, ["itemId", "expectedRevision"], "promotion item");
    const itemId = reviewDigest(item.itemId); if (seen.has(itemId)) fail("promotion items must be unique"); seen.add(itemId);
    return { itemId, expectedRevision: parseVersion(item.expectedRevision) };
  }).sort((a, b) => a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0);
  const request: PromotionRequest = { queueId: parseId(row.queueId), datasetId: parseId(row.datasetId),
    expectedDatasetVersion: parseVersion(row.expectedDatasetVersion), idempotencyKey: parseId(row.idempotencyKey), items };
  boundedReviewBytes(canonicalReviewJson(request), L.MAX_RECEIPT_BYTES, "promotion request");
  return request;
}
export function parseReviewCursor(value: unknown): ReviewCursor {
  const row = object(value, "queue cursor"); fields(row, ["limit", "afterOrdinal", "afterId"], "queue cursor");
  const integer = (raw: unknown): number => {
    if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) fail("cursor values must be positive decimal integers");
    return parseVersion(Number(raw));
  };
  const limit = row.limit === undefined ? L.MAX_PAGE : integer(row.limit);
  if (limit > L.MAX_PAGE) fail("page limit exceeds 50");
  if (Object.hasOwn(row, "afterOrdinal") !== Object.hasOwn(row, "afterId")) fail("cursor ordinal and ID are required together");
  return { limit, ...(row.afterOrdinal === undefined ? {} : { afterOrdinal: integer(row.afterOrdinal), afterId: reviewDigest(row.afterId) }) };
}
export function parseReviewJson(text: string): unknown {
  boundedReviewBytes(text, L.MAX_REQUEST_BYTES, "request");
  const value = parseJsonEvidence(text);
  if (hasDuplicateJsonKeys(text)) fail("JSON contains duplicate decoded keys");
  canonicalReviewJson(value);
  return value;
}
export function parseQueueCreate(value: unknown): { name: string; schema: ReviewSchema } {
  const row = object(value, "queue"); fields(row, ["name", "schema"], "queue");
  return { name: safeText(row.name, "queue name", 128), schema: parseReviewSchema(row.schema === undefined ? DEFAULT_REVIEW_SCHEMA : row.schema) };
}
export function parseQueueInsert(value: unknown): { runId: string; outputSpanId: string | null } {
  const row = object(value, "source selection"); fields(row, ["runId", "outputSpanId"], "source selection");
  return { runId: parseId(row.runId), outputSpanId: row.outputSpanId === undefined ? null : parseId(row.outputSpanId) };
}
export function parsePromotionReceipt(value: unknown): import("./protocol").PromotionReceipt {
  const row = object(value, "promotion receipt");
  fields(row, ["promotionId", "datasetId", "datasetVersion", "datasetHash", "itemIds", "caseIds", "createdAt"], "promotion receipt");
  const itemIds = list(row.itemIds, "receipt items", L.MAX_PROMOTION_ITEMS, 1).map(reviewDigest);
  const caseIds = list(row.caseIds, "receipt cases", L.MAX_PROMOTION_ITEMS, 1).map(reviewDigest);
  if (itemIds.length !== caseIds.length || new Set(itemIds).size !== itemIds.length || new Set(caseIds).size !== caseIds.length) fail("receipt membership is invalid");
  const receipt = { promotionId: reviewDigest(row.promotionId), datasetId: parseId(row.datasetId), datasetVersion: parseVersion(row.datasetVersion),
    datasetHash: reviewDigest(row.datasetHash), itemIds, caseIds, createdAt: reviewTimestamp(row.createdAt) };
  boundedReviewBytes(canonicalReviewJson(receipt), L.MAX_RECEIPT_BYTES, "receipt"); return receipt;
}
