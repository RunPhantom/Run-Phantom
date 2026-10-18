import { describe, expect, test } from "bun:test";
import { snapshotRun } from "../src/evaluations/snapshot";
import { canonicalCaseDefinitions } from "../src/evaluations/validation";
import {
  DEFAULT_REVIEW_SCHEMA, canonicalReviewJson, reviewHash, parseReviewSchema,
  parseReviewDraft, freezeReviewSource, parseReviewSource, compileReviewCase,
  parseReviewJson, parsePromotionRequest, parseReviewCursor, reviewItemId,
} from "../src/review-queues/validation";
import { applyReviewMutation, assertReviewItemIntegrity, markReviewPromoted } from "../src/review-queues/state";
import type { ReviewItem } from "../src/review-queues/protocol";

function snapshot(output = "Actual captured output", input = "Captured input") {
  return snapshotRun({ id: "run-a", name: "Source run", started_at: 1, last_updated_at: 2 }, [{
    id: "root", run_id: "run-a", name: "agent", span_type: "AGENT_ROOT", status: "OK",
    input_payload: input, output_payload: output, attributes: "{}", start_time_ms: 1, end_time_ms: 2,
  }]);
}
function draft(target: Record<string, string | number | boolean> = { expectedOutput: "Curated expected output" }) {
  return { name: "Curated case", input: "Captured input", tags: ["curated"], target, note: "Operator review" };
}
function item(): ReviewItem {
  const schema = parseReviewSchema(DEFAULT_REVIEW_SCHEMA), source = freezeReviewSource(snapshot(), null), value = parseReviewDraft(draft(), schema);
  return { id: reviewItemId("queue-a", source.runId, null), queueId: "queue-a", ordinal: 1,
    source, sourceHash: reviewHash({ schemaHash: reviewHash(schema), source }), draft: value, draftHash: reviewHash(value),
    revision: 1, state: "draft", approvedHash: null, approvedAt: null, reviewSource: null,
    lastMutationId: null, lastMutationHash: null, promotedDatasetId: null, promotedDatasetVersion: null,
    promotedCaseId: null, createdAt: 1, updatedAt: 1 };
}
const typedSchema = { fields: [
  { key: "score", label: "Score", type: "enum", required: true, choices: [0, 1, 2], mapping: { kind: "jsonPath", path: "score" } },
  { key: "ok", label: "Accepted", type: "boolean", required: true, mapping: { kind: "jsonPath", path: "ok" } },
  { key: "comment", label: "Comment", type: "string", required: false, mapping: { kind: "jsonPath", path: "comment" } },
] };

describe("bounded local review contracts", () => {
  test("typed targets preserve zero and false and compile existing frozen case semantics", () => {
    const schema = parseReviewSchema(typedSchema), source = freezeReviewSource(snapshot('{"score":0,"ok":false}'), "root");
    const compiled = compileReviewCase("queue-a", reviewItemId("queue-a", "run-a", "root"), schema, draft({ score: 0, ok: false }), source);
    expect(compiled.rules).toEqual([{ kind: "jsonPath", path: "score", equals: 0 }, { kind: "jsonPath", path: "ok", equals: false }]);
    expect(compiled).toMatchObject({ input: "Captured input", sourceRunId: "run-a", sourceSpanId: "root", sourceOutput: '{"score":0,"ok":false}', sourceSnapshotVersion: 1 });
    const before = canonicalCaseDefinitions([compiled]);
    source.output = "Changed live output";
    expect(canonicalCaseDefinitions([compiled])).toBe(before);
    expect(() => parseReviewDraft(draft({ score: "0", ok: false }), schema, true)).toThrow();
  });
  test("schema rejects null, malformed fields, coercion and duplicate mappings", () => {
    for (const value of [null, { fields: [null] }, { fields: [] }, { fields: [typedSchema.fields[0], typedSchema.fields[0]] },
      { fields: [{ ...typedSchema.fields[0], choices: [1, "1"] }] },
      { fields: [{ ...typedSchema.fields[0], type: "number", minimum: 3, maximum: 1, choices: undefined }] },
      { fields: [{ ...typedSchema.fields[1], mapping: { kind: "output" } }] },
      { fields: [{ ...typedSchema.fields[1], mapping: { kind: "jsonPath", path: "api_key" } }] },
      { fields: [{ ...typedSchema.fields[1], required: "true" }] },
      { fields: Array.from({ length: 9 }, (_, n) => ({ ...typedSchema.fields[1], key: `key${n}`, mapping: { kind: "jsonPath", path: `key${n}` } })) },
    ]) expect(() => parseReviewSchema(value)).toThrow();
    const getter = Object.defineProperty({}, "fields", { get() { throw new Error("getter invoked"); } });
    expect(() => parseReviewSchema(getter)).toThrow("accessors");
  });
  test("partial drafts can save; approval requires fields and finite exact values", () => {
    const schema = parseReviewSchema(typedSchema);
    expect(parseReviewDraft(draft({}), schema).target).toEqual({});
    expect(() => parseReviewDraft(draft({}), schema, true)).toThrow();
    for (const target of [{ score: NaN, ok: true }, { score: Infinity, ok: true }, { score: 0, ok: "false" }, { score: 0, ok: false, extra: 1 }]) {
      expect(() => parseReviewDraft(draft(target as any), schema, true)).toThrow();
    }
    expect(() => parseReviewDraft({ ...draft({ score: 0, ok: false }), reviewer: "Authenticated person" }, schema)).toThrow();
    expect(() => parseReviewDraft({ ...draft(), target: { expectedOutput: "x".repeat(4097) } }, DEFAULT_REVIEW_SCHEMA)).toThrow();
  });
  test("whole-value privacy precedes projection and never stores extra prompt/tool carriers", () => {
    const secret = "f29-private-sentinel", raw = JSON.stringify({ safe: "x".repeat(17000), api_key: secret });
    const captured = snapshot(); captured.output.value = raw; captured.input = raw;
    (captured as any).rawPrompt = secret;
    const source = freezeReviewSource(captured, null);
    expect(source.redacted).toBe(true); expect(source.input).toBeNull(); expect(source.output).toBeNull();
    expect(JSON.stringify(source)).not.toContain(secret);
    expect(source).not.toHaveProperty("tools"); expect(source).not.toHaveProperty("agentDefinitions");
    expect(() => parseReviewSource({ ...source, rawPrompt: secret })).toThrow();
    expect(() => parseReviewDraft(draft({ expectedOutput: JSON.stringify({ safe: "okay", api_key: secret }) }), DEFAULT_REVIEW_SCHEMA, true)).toThrow();
  });
  test("unavailable and partial sources preserve independent coverage flags", () => {
    const captured = snapshot(); captured.complete = false; captured.output.complete = false; captured.redacted = true; captured.truncated = true;
    const source = freezeReviewSource(captured, null);
    expect(source).toMatchObject({ complete: false, outputComplete: false, redacted: true, truncated: true });
    const compiled = compileReviewCase("queue-a", reviewItemId("queue-a", "run-a", null), DEFAULT_REVIEW_SCHEMA, draft(), source);
    expect(compiled).toMatchObject({ sourceRedacted: true, sourceTruncated: true });
    expect(() => freezeReviewSource(snapshot(), "other-run-span")).toThrow();
  });
  test("privacy disclosure follows warning sanitization without returning a clipped sensitive prefix", () => {
    const captured = snapshot(); captured.warnings = ["Authorization: Bearer f29-warning-secret-sentinel"];
    const source = freezeReviewSource(captured, null);
    expect(source.redacted).toBe(true);
    expect(JSON.stringify(source)).not.toContain("f29-warning-secret-sentinel");
    expect(source.warnings).toEqual(["Source evidence is unavailable"]);
  });
  test("number bounds, boolean enum choices, unicode byte caps and strict arrays are enforced", () => {
    const schema = parseReviewSchema({ fields: [
      { key: "score", label: "Score", type: "number", required: true, minimum: -2, maximum: 2, mapping: { kind: "jsonPath", path: "score" } },
      { key: "ok", label: "Accepted", type: "enum", required: true, choices: [true, false], mapping: { kind: "jsonPath", path: "ok" } },
    ] });
    expect(parseReviewDraft(draft({ score: -2, ok: false }), schema, true).target).toEqual({ score: -2, ok: false });
    for (const target of [{ score: 3, ok: false }, { score: -3, ok: true }, { score: Number.MAX_SAFE_INTEGER + 1, ok: false }]) expect(() => parseReviewDraft(draft(target), schema, true)).toThrow();
    const source = freezeReviewSource(snapshot(), null);
    expect(() => parseReviewSource({ ...source, output: "界".repeat(10000) })).toThrow();
    const arrayWithHole = Array(1);
    expect(() => parseReviewSchema({ fields: arrayWithHole })).toThrow("holes");
    expect(() => parseReviewSource({ ...source, version: 2 })).toThrow();
    expect(() => parseReviewSource({ ...source, capturedAt: NaN })).toThrow();
  });
  test("transport rejects escaped duplicate keys, lossy integers, deep or oversized bodies", () => {
    expect(() => parseReviewJson('{"name":"A","na\\u006de":"B"}')).toThrow();
    expect(() => parseReviewJson('{"revision":9007199254740993}')).toThrow();
    expect(() => parseReviewJson('['.repeat(18) + '0' + ']'.repeat(18))).toThrow();
    expect(() => parseReviewJson(JSON.stringify("x".repeat(65536)))).toThrow();
    expect(parseReviewJson('{"value":0,"accepted":false}')).toEqual({ value: 0, accepted: false });
  });
  test("canonical identity includes exact source membership and frozen schema", () => {
    expect(canonicalReviewJson({ b: false, a: 0 })).toBe(canonicalReviewJson({ a: 0, b: false }));
    expect(reviewItemId("queue-a", "run-a", "same-span")).not.toBe(reviewItemId("queue-a", "run-b", "same-span"));
    expect(reviewItemId("queue-a", "run-a", null)).not.toBe(reviewItemId("queue-a", "run-a", "root"));
    const value = item(); assertReviewItemIntegrity(value, DEFAULT_REVIEW_SCHEMA);
    expect(() => assertReviewItemIntegrity({ ...value, source: { ...value.source, output: "Tampered" } }, DEFAULT_REVIEW_SCHEMA)).toThrow();
  });
  test("promotion request canonicalizes exact references and page cursors stay finite", () => {
    const a = reviewItemId("q", "a", null), b = reviewItemId("q", "b", null);
    const req = { queueId: "q", datasetId: "d", expectedDatasetVersion: 1, idempotencyKey: "attempt", items: [{ itemId: b, expectedRevision: 2 }, { itemId: a, expectedRevision: 1 }] };
    expect(parsePromotionRequest(req).items.map(x => x.itemId)).toEqual([a, b].sort());
    expect(() => parsePromotionRequest({ ...req, items: [req.items[0], req.items[0]] })).toThrow();
    expect(() => parsePromotionRequest({ ...req, expectedDatasetVersion: 0 })).toThrow();
    expect(parseReviewCursor({ limit: "50", afterOrdinal: "5", afterId: a })).toEqual({ limit: 50, afterOrdinal: 5, afterId: a });
    for (const value of [{ limit: "51" }, { limit: "01" }, { afterOrdinal: "1" }, { afterId: a }, { afterOrdinal: "1e2", afterId: a }]) expect(() => parseReviewCursor(value)).toThrow();
  });
});

describe("operator draft revision state", () => {
  test("atomic approval contains newest edit, exact current retry is idempotent, stale save cannot unapprove", () => {
    const value = item(), latest = draft({ expectedOutput: "Newest immediate edit" });
    const request = { expectedRevision: 1, mutationId: "approve-1", draft: latest };
    const approved = applyReviewMutation(value, DEFAULT_REVIEW_SCHEMA, "approve", request, 10);
    expect(approved).toMatchObject({ state: "approved", revision: 2, draft: latest, reviewSource: "localOperator", approvedAt: 10 });
    expect(applyReviewMutation(approved, DEFAULT_REVIEW_SCHEMA, "approve", request, 20)).toEqual(approved);
    expect(() => applyReviewMutation(approved, DEFAULT_REVIEW_SCHEMA, "save", { ...request, mutationId: "late-save" }, 20)).toThrow();
    expect(() => applyReviewMutation(approved, DEFAULT_REVIEW_SCHEMA, "approve", { ...request, draft: draft() }, 20)).toThrow();
    expect(value.state).toBe("draft"); expect(value.revision).toBe(1);
  });
  test("explicit reopen is revision guarded and promoted items remain terminal", () => {
    const approved = applyReviewMutation(item(), DEFAULT_REVIEW_SCHEMA, "approve", { expectedRevision: 1, mutationId: "approve", draft: draft() }, 10);
    const reopened = applyReviewMutation(approved, DEFAULT_REVIEW_SCHEMA, "reopen", { expectedRevision: 2, mutationId: "reopen" }, 11);
    expect(reopened).toMatchObject({ state: "draft", revision: 3, approvedHash: null, reviewSource: null });
    expect(() => applyReviewMutation(reopened, DEFAULT_REVIEW_SCHEMA, "approve", { expectedRevision: 1, mutationId: "approve", draft: draft() }, 12)).toThrow();
    const promoted = markReviewPromoted(approved, DEFAULT_REVIEW_SCHEMA, 2, { datasetId: "dataset", datasetVersion: 2 }, 12);
    expect(promoted).toMatchObject({ state: "promoted", revision: 3, promotedDatasetId: "dataset", promotedDatasetVersion: 2 });
    expect(() => applyReviewMutation(promoted, DEFAULT_REVIEW_SCHEMA, "reopen", { expectedRevision: 3, mutationId: "reopen" }, 13)).toThrow();
    expect(() => markReviewPromoted(promoted, DEFAULT_REVIEW_SCHEMA, 3, { datasetId: "other", datasetVersion: 1 }, 13)).toThrow();
  });
});
