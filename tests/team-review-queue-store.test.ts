import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamStore, hashTeamToken, type ProjectContext } from "../src/team/store";
import { normalizeTeamIngest } from "../src/team/ingest";
import type { ReviewSchema } from "../src/review-queues/protocol";
import { createTeamReviewItem, exportTeamReviewRevision } from "../src/team/review-queues";
import { canonicalReviewJson, reviewHash } from "../src/review-queues/validation";

const fixtures: Array<{ dir: string; stores: TeamStore[] }> = [];
const runId = "1".repeat(32), spanId = "2".repeat(16);
const schema: ReviewSchema = { fields: [
  { key: "score", label: "Score", type: "number", required: true, mapping: { kind: "jsonPath", path: "$.score" } },
  { key: "accepted", label: "Accepted", type: "boolean", required: true, mapping: { kind: "jsonPath", path: "$.accepted" } },
] };
function fixture() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "f30-native-store-")), path = join(dir, "team.sqlite");
  const store = new TeamStore(path, { bootstrapHash: hashTeamToken("bootstrap") });
  const f = { dir, stores: [store] }; fixtures.push(f);
  const owner = store.setupOwner({ setupCodeHash: hashTeamToken("bootstrap"), email: "owner@example.test", passwordHash: "hash", sessionHash: hashTeamToken("owner") });
  const project = store.createProject(owner, { name: "A" }), foreign = store.createProject(owner, { name: "B" });
  const scope = store.projectScope(owner, project.id), scopeB = store.projectScope(owner, foreign.id);
  function member(role: "editor" | "viewer") {
    const email = role + "@example.test", invite = store.createInvite(scope, { email, role });
    const accepted = store.acceptInvite({ tokenHash: hashTeamToken(invite.token), email, expectedAccountId: null, passwordHash: "hash", sessionHash: hashTeamToken(role) });
    return store.projectScope(accepted.context, project.id);
  }
  const key = store.createKey(scope, { label: "native" }), ingestContext = store.getIngestContext(hashTeamToken(key.token))!;
  function capture(output = '{"score":0,"accepted":false}', input = "Original β") {
    const batch = normalizeTeamIngest(Buffer.from(JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: runId, spanId,
      name: "Agent β", startTimeUnixNano: "1800000000000000000", endTimeUnixNano: "1800000001000000000", status: { code: 1 },
      attributes: [{ key: "openinference.span.kind", value: { stringValue: "AGENT" } }, { key: "runphantom.input", value: { stringValue: input } }, { key: "runphantom.output", value: { stringValue: output } }] }] }] }] })), "json", key.token);
    store.ingest(ingestContext, batch);
  }
  const sql = () => new Database(path, { strict: true });
  const second = () => { const next = new TeamStore(path); f.stores.push(next); return next; };
  capture(); return { store, scope, scopeB, editor: member("editor"), viewer: member("viewer"), capture, sql, second, path };
}
afterEach(() => { for (const f of fixtures.splice(0)) { for (const s of f.stores) s.close(); rmSync(f.dir, { recursive: true, force: true }); } });
function curated(store: TeamStore, scope: ProjectContext) {
  const queue = store.createReviewQueue(scope, { name: "Frozen β", schema }), item = store.insertReviewItem(scope, queue.id, { runId });
  const approved = store.mutateReviewItem(scope, queue.id, item.id, "approve", { expectedRevision: item.revision, mutationId: randomUUID(), draft: { ...item.draft, target: { score: 0, accepted: false }, note: "Private curation" } });
  const dataset = store.createReviewDataset(scope, { name: "Curated cases" });
  const request = { queueId: queue.id, datasetId: dataset.datasetId, expectedDatasetVersion: 1, idempotencyKey: randomUUID(), items: [{ itemId: item.id, expectedRevision: approved.revision }] };
  return { queue, item, approved, dataset, request };
}

test("full project quota refuses new intake before materializing its corrupt live source", () => {
  const { store, scope, sql } = fixture(), queue = store.createReviewQueue(scope, { name: "Retention admission" }), db = sql();
  try {
    db.query("UPDATE projects SET evidence_bytes=? WHERE id=?").run(512 * 1024 * 1024, scope.projectId);
    db.query("UPDATE runs SET data='null' WHERE project_id=? AND id=?").run(scope.projectId, runId);
    expect(() => store.insertReviewItem(scope, queue.id, { runId })).toThrow("The project or account storage limit has been reached");
    expect(db.query("SELECT count(*) AS n FROM team_review_items").get()).toEqual({ n: 0 });
    expect(db.query("SELECT next_ordinal FROM team_review_queues WHERE id=?").get(queue.id)).toEqual({ next_ordinal: 1 });
  } finally { db.close(); }
});

test("native Team intake freezes actual β output and retry cannot overwrite approved witness", () => {
  const { store, editor, capture } = fixture(), { queue, approved } = curated(store, editor);
  capture('{"score":99,"accepted":true}', "Live γ");
  const retry = store.insertReviewItem(editor, queue.id, { runId });
  expect(retry).toEqual(approved); expect(retry.source.input).toBe("Original β");
  expect(retry.source.output).toBe('{"score":0,"accepted":false}'); expect(retry.reviewSource).toBe("projectAccount");
  expect(retry.approvalWitness?.accountId).toBe(editor.user.id); expect(retry.approvalWitness?.role).toBe("editor");
});

test("fresh membership denies viewer writes, editor deletes and foreign project IDs", () => {
  const { store, scope, scopeB, editor, viewer } = fixture(), { queue, item } = curated(store, editor);
  expect(store.listReviewQueues(viewer)).toHaveLength(1);
  expect(() => store.createReviewQueue(viewer, { name: "Denied" })).toThrow("not permitted");
  expect(() => store.deleteReviewItem(editor, queue.id, item.id, item.revision)).toThrow("not permitted");
  expect(() => store.reviewWindow(scopeB, queue.id, item.id)).toThrow("not found");
  store.changeMemberRole(scope, editor.user.id, "viewer");
  expect(() => store.mutateReviewItem(editor, queue.id, item.id, "reopen", { expectedRevision: item.revision + 1, mutationId: randomUUID() })).toThrow("not permitted");
  expect(() => store.promoteReviewItems(editor, { queueId: queue.id })).toThrow("not permitted");
});

test("actual newest full draft approval uses current CAS and rejects a stale editor", () => {
  const { store, editor } = fixture(), queue = store.createReviewQueue(editor, { name: "CAS", schema }), item = store.insertReviewItem(editor, queue.id, { runId });
  const save = store.mutateReviewItem(editor, queue.id, item.id, "save", { expectedRevision: item.revision, mutationId: randomUUID(), draft: { ...item.draft, target: { score: 3, accepted: true } } });
  const approved = store.mutateReviewItem(editor, queue.id, item.id, "approve", { expectedRevision: save.revision, mutationId: randomUUID(), draft: { ...save.draft, name: "Latest β", target: { score: 0, accepted: false } } });
  expect(approved.draft.name).toBe("Latest β"); expect(approved.draft.target).toEqual({ score: 0, accepted: false });
  expect(() => store.mutateReviewItem(editor, queue.id, item.id, "save", { expectedRevision: item.revision, mutationId: randomUUID(), draft: item.draft })).toThrow("changed");
  expect(store.reviewWindow(editor, queue.id, item.id)[0]).toEqual(approved);
});

test("two actual Team connections reuse the first receipt after dataset head and source advance", () => {
  const { store, editor, scope, second } = fixture(), other = second(), { queue, approved, request } = curated(store, editor);
  const receipt = store.promoteReviewItems(editor, request);
  expect(other.promoteReviewItems(scope, request)).toEqual(receipt); expect(receipt.actor.accountId).toBe(editor.user.id);
  const revision = store.getReviewDatasetRevision(scope, receipt.datasetId, 2);
  expect(revision.cases[0].sourceOutput).toBe('{"score":0,"accepted":false}');
  expect(revision.cases[0].rules).toEqual([{ kind: "jsonPath", path: "$.score", equals: 0 }, { kind: "jsonPath", path: "$.accepted", equals: false }]);
  expect(JSON.stringify(exportTeamReviewRevision(revision))).not.toContain("Private curation");
  expect(JSON.stringify(exportTeamReviewRevision(revision))).not.toContain(editor.user.id);
  expect(JSON.stringify(exportTeamReviewRevision(revision))).not.toContain(runId);
  expect(store.reviewWindow(scope, queue.id, approved.id)[0].state).toBe("promoted");
  store.deleteReviewItem(scope, queue.id, approved.id, approved.revision + 1);
  expect(other.promoteReviewItems(scope, request)).toEqual(receipt);
  expect(() => other.promoteReviewItems(scope, { ...request, expectedDatasetVersion: 2 })).toThrow("retry");
  expect(store.getReviewDatasetRevision(scope, receipt.datasetId, 2)).toEqual(revision);
});

for (const table of ["team_review_dataset_revisions", "team_review_items", "team_review_promotions"]) test(`actual SQL ${table} fault rolls back revision, item state and receipt together`, () => {
  const { store, scope, sql } = fixture(), { queue, approved, request, dataset } = curated(store, scope), db = sql();
  const operation = table === "team_review_items" ? "UPDATE" : "INSERT";
  db.exec(`CREATE TRIGGER review_fault BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'Injected transactional review fault'); END;`);
  try {
    expect(() => store.promoteReviewItems(scope, request)).toThrow("Injected transactional review fault");
    expect(store.getReviewDatasetRevision(scope, dataset.datasetId, 1)).toEqual(dataset);
    expect(store.reviewWindow(scope, queue.id, approved.id)[0]).toEqual(approved);
    expect(db.query("SELECT count(*) AS n FROM team_review_promotions").get()).toEqual({ n: 0 });
    expect(db.query("SELECT latest_version FROM team_review_datasets WHERE id=?").get(dataset.datasetId)).toEqual({ latest_version: 1 });
  } finally { db.exec("DROP TRIGGER review_fault"); db.close(); }
  expect(store.promoteReviewItems(scope, request).datasetVersion).toBe(2);
});

test("deleted-item delayed CAS cannot bind to re-intake with same immutable ID", () => {
  const { store, scope, capture } = fixture(), { queue, item, approved, request } = curated(store, scope);
  store.deleteReviewItem(scope, queue.id, item.id, approved.revision); capture('{"score":7,"accepted":true}', "New incarnation γ");
  const next = store.insertReviewItem(scope, queue.id, { runId });
  expect(next.id).toBe(item.id); expect(next.revision).toBeGreaterThan(approved.revision); expect(next.source.input).toBe("New incarnation γ");
  expect(() => store.mutateReviewItem(scope, queue.id, next.id, "approve", { expectedRevision: item.revision, mutationId: randomUUID(), draft: approved.draft })).toThrow("changed");
  expect(() => store.promoteReviewItems(scope, request)).toThrow("changed"); expect(store.reviewWindow(scope, queue.id, next.id)[0]).toEqual(next);
});

test("corrupted frozen row never reloads live source and allocator overflow refuses atomically", () => {
  const { store, scope, sql } = fixture(), { queue, item } = curated(store, scope), db = sql();
  try {
    db.query("UPDATE team_review_items SET data=json_set(data,'$.source.output','corrupted') WHERE queue_id=?").run(queue.id);
    expect(() => store.reviewWindow(scope, queue.id, item.id)).toThrow("invalid");
    db.query("DELETE FROM team_review_items WHERE queue_id=?").run(queue.id);
    db.query("UPDATE team_review_queues SET next_ordinal=? WHERE id=?").run(Number.MAX_SAFE_INTEGER, queue.id);
    expect(() => store.insertReviewItem(scope, queue.id, { runId })).toThrow("limit");
    expect(db.query("SELECT count(*) AS n FROM team_review_items").get()).toEqual({ n: 0 });
    expect(db.query("SELECT next_ordinal FROM team_review_queues WHERE id=?").get(queue.id)).toEqual({ next_ordinal: Number.MAX_SAFE_INTEGER });
  } finally { db.close(); }
});

test("first exact promotion receipt survives later quota exhaustion and admin deletion can release retention", () => {
  const {store, scope, sql} = fixture(), {queue, request} = curated(store, scope), receipt = store.promoteReviewItems(scope, request), db = sql();
  try {
    db.query("UPDATE projects SET evidence_bytes=? WHERE id=?").run(512 * 1024 * 1024, scope.projectId);
    expect(store.promoteReviewItems(scope, request)).toEqual(receipt);
    store.deleteReviewQueue(scope, queue.id);
    expect(db.query("SELECT count(*) AS n FROM team_review_items").get()).toEqual({n:0});
    expect(db.query("SELECT count(*) AS n FROM team_review_promotions").get()).toEqual({n:0});
  } finally {db.close();}
});

test("10000 actual native rows keep metadata pages50 and source windows5 with stable scoped cursors", () => {
  const {store,scope,scopeB,sql}=fixture(), queue=store.createReviewQueue(scope,{name:"10000 frozen items"}), initial=store.insertReviewItem(scope,queue.id,{runId}), db=sql();
  try {
    db.query("DELETE FROM team_review_items WHERE queue_id=?").run(queue.id);
    const run=db.query("SELECT data FROM runs WHERE project_id=? AND id=?").get(scope.projectId,runId) as {data:string};
    const source={...initial.source,output:'{"accepted":false,"score":0}'};
    db.transaction(()=> {
      const addRun=db.query("INSERT INTO runs VALUES(?,?,1,'completed',?,'','[]',1)"), addItem=db.query("INSERT INTO team_review_items VALUES(?,?,?,?,?,?,?,?,?,?)");
      for(let n=1;n<=10000;n++) {
        const id=(n+100).toString(16).padStart(32,"0"); addRun.run(scope.projectId,id,run.data);
        const item=createTeamReviewItem(scope.projectId,queue.id,queue.schema,{...source,runId:id},n,initial.createdAt);
        addItem.run(scope.projectId,queue.id,item.id,n,id,"",n,"draft",canonicalReviewJson(item),reviewHash(item));
      }
      db.query("UPDATE team_review_queues SET next_ordinal=10001 WHERE id=?").run(queue.id);
    }).immediate();
    const page=store.listReviewItems(scope,queue.id,{limit:50}); expect(page.items).toHaveLength(50);expect(page.counts).toEqual({total:10000,draft:10000,approved:0,promoted:0});
    expect(JSON.stringify(page)).not.toContain("Original β");expect(JSON.stringify(page)).not.toContain('"accepted"');expect(page.hasMore).toBe(true);
    const last=page.items.at(-1)!;store.deleteReviewItem(scope,queue.id,last.id,last.revision);
    const next=store.listReviewItems(scope,queue.id,{limit:50,cursor:page.nextCursor!});expect(next.items[0].ordinal).toBe(51);expect(next.items).toHaveLength(50);
    const window=store.reviewWindow(scope,queue.id,next.items[25].id);expect(window).toHaveLength(5);expect(window[2].id).toBe(next.items[25].id);
    expect(window[2].source.output).toBe('{"accepted":false,"score":0}');
    const other=store.createReviewQueue(scope,{name:"Other"});expect(()=>store.listReviewItems(scope,other.id,{cursor:page.nextCursor!})).toThrow("mismatched");
    expect(()=>store.listReviewItems(scopeB,queue.id,{cursor:page.nextCursor!})).toThrow("not found");
    expect(()=>store.listReviewItems(scope,queue.id,{limit:51})).toThrow("50");
  } finally {db.close();}
});

test("re-intaken promoted membership explicitly refuses replacing an existing curated case ID",()=> {
  const {store,scope,capture}=fixture(),{queue,approved,request}=curated(store,scope),receipt=store.promoteReviewItems(scope,request);
  store.deleteReviewItem(scope,queue.id,approved.id,approved.revision+1);capture('{"score":5,"accepted":true}',"New γ");
  const next=store.insertReviewItem(scope,queue.id,{runId});const updated=store.mutateReviewItem(scope,queue.id,next.id,"approve",{expectedRevision:next.revision,mutationId:randomUUID(),draft:{...next.draft,target:{score:5,accepted:true}}});
  expect(()=>store.promoteReviewItems(scope,{...request,expectedDatasetVersion:2,idempotencyKey:randomUUID(),items:[{itemId:updated.id,expectedRevision:updated.revision}]})).toThrow("duplicate");
  expect(store.getReviewDatasetRevision(scope,receipt.datasetId,2).cases[0].sourceOutput).toBe('{"score":0,"accepted":false}');
  expect(store.reviewWindow(scope,queue.id,updated.id)[0]).toEqual(updated);
});
