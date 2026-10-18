import { describe, expect, test } from "bun:test";
import { DEFAULT_REVIEW_SCHEMA, freezeReviewSource, reviewHash } from "../src/review-queues/validation";
import { snapshotRun } from "../src/evaluations/snapshot";
import { TeamError } from "../src/team/errors";
import { createTeamReviewItem, mutateTeamReviewItem, promoteTeamReviewItem, assertTeamReviewItem,
  compileTeamReviewCase, parseTeamReviewInsert, teamReviewCore, type TeamReviewActor } from "../src/team/review-queues";

const project = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const queue = "33333333-3333-4333-8333-333333333333", dataset = "44444444-4444-4444-8444-444444444444";
const actor: TeamReviewActor = { accountId: "55555555-5555-4555-8555-555555555555", role: "editor" };
const mutation = "66666666-6666-4666-8666-666666666666";
const runId = "a".repeat(32), spanId = "b".repeat(16);
const source = freezeReviewSource(snapshotRun({ id: runId, name: "Team β captured response" }, [{ id: spanId, run_id: runId, parent_span_id: null, name: "Team β", span_type: "AGENT_ROOT", status: "OK", attributes: "{}", input_payload: "Original β input", output_payload: '{"score":0,"accepted":false}', start_time_ms: 10, end_time_ms: 20 }]), null);
function item() { return createTeamReviewItem(project, queue, DEFAULT_REVIEW_SCHEMA, source, 7, 100); }
function approve() { const row = item(); return mutateTeamReviewItem(project, row, DEFAULT_REVIEW_SCHEMA, "approve", { expectedRevision: 7, mutationId: mutation, draft: { ...row.draft, target: { expectedOutput: "Curated β" } } }, actor, 101); }

describe("Project review contract without a database or authority shortcut", () => {
  test("frozen projection binds actual project identity and retains β payload", () => {
    const row = item(); expect(row.source.output).toBe('{"score":0,"accepted":false}');
    expect(row.source.input).toBe("Original β input"); expect(row.revision).toBe(7); expect(row.ordinal).toBe(7);
    expect(row.projectSourceHash).toBe(reviewHash({ projectId: project, queueId: queue, schemaHash: reviewHash(DEFAULT_REVIEW_SCHEMA), source }));
    expect(row.approvalWitness).toBeNull(); expect(row.reviewSource).toBeNull(); assertTeamReviewItem(project, row, DEFAULT_REVIEW_SCHEMA);
  });
  test("wrong project and borrowed source identity explicitly refuse", () => {
    const row = item(); expect(() => assertTeamReviewItem(other, row, DEFAULT_REVIEW_SCHEMA)).toThrow(TeamError);
    expect(() => assertTeamReviewItem(other, { ...row, projectId: other }, DEFAULT_REVIEW_SCHEMA)).toThrow(TeamError);
    expect(() => assertTeamReviewItem(project, { ...row, source: { ...row.source, output: "Live γ replacement" } }, DEFAULT_REVIEW_SCHEMA)).toThrow(TeamError);
  });
  test("newest supplied draft is approved atomically with server actor witness", () => {
    const row = approve(); expect(row.draft.target.expectedOutput).toBe("Curated β"); expect(row.revision).toBe(8);
    expect(row.reviewSource).toBe("projectAccount"); expect(row.approvalWitness).toEqual({ ...actor, approvedAt: 101, revision: 8, approvedHash: row.approvedHash });
    expect(teamReviewCore(row).reviewSource).toBe("localOperator");
    assertTeamReviewItem(project, row, DEFAULT_REVIEW_SCHEMA);
  });
  test("exact approval retry keeps first witness even for another current editor", () => {
    const row = approve(), retryActor = { accountId: "77777777-7777-4777-8777-777777777777", role: "admin" as const };
    const retry = mutateTeamReviewItem(project, row, DEFAULT_REVIEW_SCHEMA, "approve", { expectedRevision: 7, mutationId: mutation, draft: row.draft }, retryActor, 102);
    expect(retry).toEqual(row); expect(retry.approvalWitness!.accountId).toBe(actor.accountId);
  });
  test("stale or modified identity cannot overwrite approved state", () => {
    const row = approve(); expect(() => mutateTeamReviewItem(project, row, DEFAULT_REVIEW_SCHEMA, "save", { expectedRevision: 7, mutationId: dataset, draft: { ...row.draft, target: { expectedOutput: "stale" } } }, actor, 102)).toThrow(TeamError);
    expect(() => mutateTeamReviewItem(project, row, DEFAULT_REVIEW_SCHEMA, "approve", { expectedRevision: 7, mutationId: mutation, draft: { ...row.draft, target: { expectedOutput: "changed retry" } } }, actor, 102)).toThrow(TeamError);
  });
  test("client supplied actor and viewer witness are refused", () => {
    const row = item(); expect(() => mutateTeamReviewItem(project, row, DEFAULT_REVIEW_SCHEMA, "approve", { expectedRevision: 7, mutationId: mutation, draft: { ...row.draft, target: { expectedOutput: "β" } }, approvalWitness: actor }, actor, 101)).toThrow(TeamError);
    expect(() => mutateTeamReviewItem(project, row, DEFAULT_REVIEW_SCHEMA, "approve", { expectedRevision: 7, mutationId: mutation, draft: { ...row.draft, target: { expectedOutput: "β" } } }, { ...actor, role: "viewer" }, 101)).toThrow(TeamError);
  });
  test("reopen clears approval witness; promoted items retain first witness and freeze", () => {
    const row = approve(); const reopened = mutateTeamReviewItem(project, row, DEFAULT_REVIEW_SCHEMA, "reopen", { expectedRevision: 8, mutationId: dataset }, actor, 102);
    expect(reopened.state).toBe("draft"); expect(reopened.approvalWitness).toBeNull(); expect(reopened.reviewSource).toBeNull();
    const promoted = promoteTeamReviewItem(project, row, DEFAULT_REVIEW_SCHEMA, 8, { datasetId: dataset, datasetVersion: 2 }, 103);
    expect(promoted.state).toBe("promoted"); expect(promoted.revision).toBe(9); expect(promoted.approvalWitness).toEqual(row.approvalWitness);
    expect(() => mutateTeamReviewItem(project, promoted, DEFAULT_REVIEW_SCHEMA, "reopen", { expectedRevision: 9, mutationId: dataset }, actor, 104)).toThrow(TeamError);
  });
  test("corrupt witness/hash and public compatibility source refuse integrity", () => {
    const row = approve(); expect(() => assertTeamReviewItem(project, { ...row, approvalWitness: { ...row.approvalWitness!, revision: 7 } }, DEFAULT_REVIEW_SCHEMA)).toThrow(TeamError);
    expect(() => assertTeamReviewItem(project, { ...row, reviewSource: JSON.parse('"localOperator"') }, DEFAULT_REVIEW_SCHEMA)).toThrow(TeamError);
    expect(() => assertTeamReviewItem(project, { ...row, approvalWitness: { ...row.approvalWitness!, approvedHash: "0".repeat(64) } }, DEFAULT_REVIEW_SCHEMA)).toThrow(TeamError);
  });
  test("typed zero and false compile unchanged with frozen output", () => {
    const schema = { fields: [{ key: "score", label: "Score", type: "number" as const, required: true, mapping: { kind: "jsonPath" as const, path: "score" } }, { key: "accepted", label: "Accepted", type: "boolean" as const, required: true, mapping: { kind: "jsonPath" as const, path: "accepted" } }] };
    const initial = createTeamReviewItem(project, queue, schema, source, 1, 100);
    const row = mutateTeamReviewItem(project, initial, schema, "approve", { expectedRevision: 1, mutationId: mutation, draft: { ...initial.draft, target: { score: 0, accepted: false } } }, actor, 101);
    const compiled = compileTeamReviewCase(project, row, schema); expect(compiled.rules).toEqual([{ kind: "jsonPath", path: "score", equals: 0 }, { kind: "jsonPath", path: "accepted", equals: false }]);
    expect(compiled.sourceOutput).toBe(source.output); expect(compiled.input).toBe(source.input);
  });
  test("selection has actual Team trace/span formats and no caller project authority", () => {
    expect(parseTeamReviewInsert({ runId, outputSpanId: spanId })).toEqual({ runId, outputSpanId: spanId });
    for (const body of [{ runId: project }, { runId, outputSpanId: queue }, { runId, projectId: other }, { runId, witness: actor }]) expect(() => parseTeamReviewInsert(body)).toThrow(TeamError);
  });
  test("whole draft and source values obey the existing Team credential privacy floor", () => {
    const secret = "rp_team_session_" + "s".repeat(43), row = item();
    expect(() => mutateTeamReviewItem(project, row, DEFAULT_REVIEW_SCHEMA, "approve", { expectedRevision: 7, mutationId: mutation, draft: { ...row.draft, target: { expectedOutput: "Allowed prefix " + "β".repeat(1500) + secret } } }, actor, 101)).toThrow(TeamError);
    expect(() => createTeamReviewItem(project, queue, DEFAULT_REVIEW_SCHEMA, { ...source, output: "Allowed prefix " + secret }, 1, 100)).toThrow(TeamError);
  });
  test("unsafe counter lineage inputs and revision overflow refuse without wrap", () => {
    for (const ordinal of [0, -1, Number.MAX_SAFE_INTEGER + 1]) expect(() => createTeamReviewItem(project, queue, DEFAULT_REVIEW_SCHEMA, source, ordinal, 100)).toThrow(TeamError);
    const initial = createTeamReviewItem(project, queue, DEFAULT_REVIEW_SCHEMA, source, Number.MAX_SAFE_INTEGER, 100);
    expect(() => mutateTeamReviewItem(project, initial, DEFAULT_REVIEW_SCHEMA, "save", { expectedRevision: Number.MAX_SAFE_INTEGER, mutationId: mutation, draft: initial.draft }, actor, 101)).toThrow(TeamError);
  });
});
