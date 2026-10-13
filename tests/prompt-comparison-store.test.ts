import { beforeEach, afterEach, expect, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PromptRegistry } from "../src/prompts/registry";
import { acquireComparisonOwner } from "../src/prompts/comparison-owner";
import { ComparisonStore } from "../src/prompts/comparison-store";
import { COMPARISON_STORAGE_SQL } from "../src/prompts/comparison-storage";
import { COMPARISON_MODELS } from "../src/prompts/comparison-protocol";

let directory: string, file: string, db: Database, prompts: PromptRegistry, store: ComparisonStore;
let lease: Awaited<ReturnType<typeof acquireComparisonOwner>>;
let allowed = true;
const budgets = { openai: 1000000, anthropic: 1000000 };
function owner(database: Database, id = "local", kind: "local" | "project" = "local") {
  return { database, scope: { kind, id }, authorize() { if (!allowed) throw new Error("actual membership revoked"); } };
}
function request(promptId: string, operationKey = randomUUID(), targets = [...COMPARISON_MODELS]) { return { operationKey, promptId, revision: 1, variables: { topic: "$& {{literal}}" }, targets, options: { maxOutputTokens: 128, temperature: 0 }, operationBudgetMicrousd: 1000000, expectedGeneration: store.capture("edit").comparisonGeneration }; }
function saved() { return prompts.create({ operationKey: randomUUID(), name: "Frozen", template: "Explain {{topic}}" }, prompts.capture("edit")); }
function initialize(database: Database) {
  database.exec("PRAGMA legacy_alter_table=ON; PRAGMA foreign_keys=OFF"); migrate(drizzle(database), { migrationsFolder: `${import.meta.dir}/../drizzle` });
  database.exec("PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF");
  database.exec(COMPARISON_STORAGE_SQL);
  database.exec("INSERT INTO evaluation_evidence_scopes VALUES('local:local',1,1); INSERT INTO prompt_scope_controls VALUES('local:local',1); INSERT INTO comparison_scope_controls VALUES('local:local',1)");
}
beforeEach(async () => {
  allowed = true; directory = realpathSync(mkdtempSync(path.join(tmpdir(), "rp-comparison-store-"))); file = path.join(directory, "owner.sqlite"); db = new Database(file); initialize(db);
  lease = await acquireComparisonOwner(file); prompts = new PromptRegistry(owner(db)); store = new ComparisonStore(owner(db), lease, { budgets, availability: { openai: true, anthropic: true } });
});
afterEach(async () => { await lease.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
test("actual SQLite admission persists the entire frozen roster and same-key receipt exactly once", async () => {
  const first = saved(), input = request(first.id), fence = store.capture("edit");
  const [one, two] = await Promise.all([Promise.resolve().then(() => store.submit(input, fence)), Promise.resolve().then(() => store.submit(input, fence))]);
  expect(two).toEqual(one); expect(one.attempts).toHaveLength(4); expect(one.request?.compiled).toBe("Explain $& {{literal}}");
  expect(db.query("SELECT count(*) n FROM prompt_comparisons").get()).toEqual({ n: 1 });
  prompts.append(first.id, { operationKey: randomUUID(), name: "Later", template: "Changed", expectedRevision: 1 }, prompts.capture("edit"));
  expect(store.submit(input, fence)).toEqual(one); expect(() => store.submit({ ...input, options: { ...input.options, temperature: 1 } }, fence)).toThrow();
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
test("unavailable and refused targets retain every row with no invented usage or charge", () => {
  const input = request(saved().id), unavailable = new ComparisonStore(owner(db), lease, { budgets: { openai: 0, anthropic: 0 }, availability: { openai: false, anthropic: true } });
  const result = unavailable.submit(input, unavailable.capture("edit")); expect(result.attempts).toHaveLength(4);
  expect(result.attempts.map(row => row.status)).toEqual(["unavailable", "unavailable", "budget_refused", "budget_refused"]);
  expect(result.attempts.every(row => row.chargeMicrousd === 0 && row.holdMicrousd === 0 && row.payload === null)).toBe(true);
});
test("native SQL rejects terminal output/reason rewrites, refunds, mixed hold+charge and running requeue", () => {
  const operation = store.submit(request(saved().id), store.capture("edit")); const fence = store.capture("edit"); store.start(operation.id, 0, fence);
  store.finish(operation.id, 0, fence, { status: "failed", reason: "provider_error" });
  for (const change of ["payload='late output'", "reason='changed'", "charge_microusd=0", "status='queued'", "hold_microusd=1"]) expect(() => db.query(`UPDATE prompt_comparison_attempts SET ${change} WHERE comparison_id=? AND position=0`).run(operation.id)).toThrow();
  store.start(operation.id, 1, fence); expect(() => db.query("UPDATE prompt_comparison_attempts SET status='queued' WHERE comparison_id=? AND position=1").run(operation.id)).toThrow();
  expect(() => db.query("UPDATE prompt_comparison_attempts SET charge_microusd=1 WHERE comparison_id=? AND position=2").run(operation.id)).toThrow();
});
test("prompt clear and physical scope deletion purge copies while lifetime spend and retry receipts survive reopen", async () => {
  const first = saved(), input = request(first.id), fence = store.capture("edit"), operation = store.submit(input, fence); store.start(operation.id, 0, fence);
  store.finish(operation.id, 0, fence, { status: "completed", result: { output: "Private result", finishReason: "stop", provenance: "controlled-http-fixture", usage: { model: "gpt-5.4", inputTokens: 3, outputTokens: 2, tier: "standard" } } });
  const before = store.budgetTotals(); prompts.clear({ expectedGeneration: prompts.capture("delete").promptGeneration, operationKey: randomUUID() }, prompts.capture("delete"));
  const removed = store.get(operation.id, store.capture("read")); expect(removed.tombstone).toBe(true); expect(removed.request).toBeNull(); expect(removed.attempts.every(row => row.payload === null)).toBe(true);
  expect(store.budgetTotals().openai.chargeMicrousd).toBe(before.openai.chargeMicrousd);
  expect(() => store.start(operation.id, 1, fence)).toThrow();
  expect(store.submit({ ...input, expectedGeneration: store.capture("edit").comparisonGeneration }, store.capture("edit")).id).toBe(operation.id);
  db.query("DELETE FROM evaluation_evidence_scopes WHERE scope_key='local:local'").run();
  expect(db.query("SELECT count(*) n FROM prompt_comparisons").get()).toEqual({ n: 1 }); expect(db.query("SELECT count(*) n FROM prompt_comparison_attempts").get()).toEqual({ n: 4 });
  await lease.close(); db.close(); db = new Database(file); lease = await acquireComparisonOwner(file);
  db.exec("INSERT INTO evaluation_evidence_scopes VALUES('local:local',1,1); INSERT INTO prompt_scope_controls VALUES('local:local',1); INSERT INTO comparison_scope_controls VALUES('local:local',1)");
  prompts = new PromptRegistry(owner(db)); store = new ComparisonStore(owner(db), lease, { budgets, availability: { openai: true, anthropic: true } });
  expect(store.budgetTotals().openai.chargeMicrousd).toBe(before.openai.chargeMicrousd); expect(store.submit(input, store.capture("edit")).id).toBe(operation.id);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]); expect(() => db.query("DELETE FROM prompt_comparisons").run()).toThrow(); expect(() => db.query("DELETE FROM prompt_comparison_attempts").run()).toThrow();
});
test("fresh report epoch keeps comparison content readable and fences a captured request and role loss", () => {
  const first = saved(), original = store.submit(request(first.id), store.capture("edit")), stale = store.capture("read");
  db.query("UPDATE evaluation_evidence_scopes SET generation=generation+1 WHERE scope_key='local:local'").run();
  expect(() => store.get(original.id, stale)).toThrow(); expect(store.get(original.id, store.capture("read")).request).toEqual(original.request);
  const edit = store.capture("edit"), input = request(first.id); allowed = false; expect(() => store.submit(input, edit)).toThrow("membership");
});
test("over-reservation measured estimates permanently close admission across content deletion and restart", async () => {
  const first = saved(), operation = store.submit(request(first.id), store.capture("edit")), fence = store.capture("edit"); store.start(operation.id, 1, fence);
  const outcome = store.finish(operation.id, 1, fence, { status: "completed", result: { output: "Answer", finishReason: "stop", provenance: "controlled-http-fixture", usage: { model: "gpt-4.1", inputTokens: 1000000, outputTokens: 1, cacheReadTokens: 0, tier: "standard" } } });
  expect(outcome.attempts[1].budgetBreach).toBe(true); expect(outcome.attempts[1].chargeMicrousd).toBeGreaterThan(outcome.attempts[1].reserveMicrousd);
  expect(store.start(operation.id, 0, fence)).toBeNull(); expect(store.get(operation.id, fence).attempts[0].status).toBe("budget_refused");
  store.clear({ operationKey: randomUUID(), expectedGeneration: fence.comparisonGeneration, confirmRemoval: true }, fence);
  await lease.close(); db.close(); db = new Database(file); lease = await acquireComparisonOwner(file); prompts = new PromptRegistry(owner(db)); store = new ComparisonStore(owner(db), lease, { budgets, availability: { openai: true, anthropic: true } });
  expect(store.budgetTotals().openai.breached).toBe(true); const next = store.submit(request(first.id), store.capture("edit")); expect(next.attempts[0].status).toBe("budget_refused");
});
test("queued expiry starts at admission and restart interrupts all pending rows without automatically executing", async () => {
  const operation = store.submit(request(saved().id), store.capture("edit")), fence = store.capture("edit"); store.start(operation.id, 0, fence);
  await lease.close(); db.close(); db = new Database(file); lease = await acquireComparisonOwner(file); prompts = new PromptRegistry(owner(db)); store = new ComparisonStore(owner(db), lease, { budgets, availability: { openai: true, anthropic: true } });
  store.recoverPending(); const retained = store.get(operation.id, store.capture("read"));
  expect(retained.attempts.every(row => row.status === "interrupted")).toBe(true); expect(retained.attempts[0].chargeMicrousd).toBe(retained.attempts[0].reserveMicrousd); expect(retained.attempts.slice(1).every(row => row.holdMicrousd === 0 && row.chargeMicrousd === 0)).toBe(true);
  expect(store.start(operation.id, 0, store.capture("edit"))).toBeNull();
});

test("admission deadline expires while queued rather than giving dequeue a new30seconds", () => {
  const clock = spyOn(Date, "now"); clock.mockReturnValue(1791766000000);
  try {
    const operation = store.submit(request(saved().id), store.capture("edit")), fence = store.capture("edit");
    expect(operation.attempts[0].deadlineAt).toBe(1791766030000); clock.mockReturnValue(1791766030001);
    expect(store.start(operation.id, 0, fence)).toBeNull(); const expired = store.get(operation.id, fence).attempts[0];
    expect(expired.status).toBe("timeout"); expect(expired.chargeMicrousd).toBe(0); expect(expired.holdMicrousd).toBe(0);
  } finally { clock.mockRestore(); }
});
test("lifetime per-scope exhaustion includes privacy tombstones and cannot be recovered through clear", () => {
  const first = saved();
  for (let index = 0; index < 100; index++) store.submit(request(first.id), store.capture("edit"));
  const fence = store.capture("delete"); store.clear({ operationKey: randomUUID(), expectedGeneration: fence.comparisonGeneration, confirmRemoval: true }, fence);
  expect(db.query("SELECT count(*) n FROM prompt_comparisons WHERE tombstone=1").get()).toEqual({ n: 100 });
  expect(() => store.submit(request(first.id), store.capture("edit"))).toThrow("capacity");
});
test("actual malformed SQL cells and unsafe aggregate state refuse before payload materialization or SUM", () => {
  const operation = store.submit(request(saved().id), store.capture("edit"));
  db.exec("PRAGMA ignore_check_constraints=ON");
  db.query("UPDATE prompt_comparison_attempts SET payload=? WHERE comparison_id=? AND position=0").run(JSON.stringify("x".repeat(9000)), operation.id);
  expect(() => store.get(operation.id, store.capture("read"))).toThrow("integrity");
  db.query("UPDATE prompt_comparison_attempts SET payload=NULL,charge_microusd=2251799813685 WHERE comparison_id=? AND position=0").run(operation.id);
  expect(() => store.budgetTotals()).toThrow("integrity");
});

test("lease cannot authorize a different actual SQLite owner connection", () => {
  const other = new Database(path.join(directory, "different.sqlite"));
  try { initialize(other); expect(() => new ComparisonStore(owner(other), lease, { budgets, availability: { openai: true, anthropic: true } })).toThrow("unavailable"); expect(other.query("SELECT count(*) n FROM prompt_comparisons").get()).toEqual({ n: 0 }); }
  finally { other.close(); }
});
test("unrepresentable measured overage remains truthful and permanently fused without overflow or refund", () => {
  const operation = store.submit(request(saved().id), store.capture("edit")), fence = store.capture("edit"); store.start(operation.id, 1, fence);
  const receipt = store.finish(operation.id, 1, fence, { status: "completed", result: { output: "Answer", finishReason: "stop", provenance: "controlled-http-fixture", usage: { model: "gpt-4.1", inputTokens: 2000000000000, outputTokens: 1, cacheReadTokens: 0, tier: "standard" } } });
  const row = receipt.attempts[1]; expect(row.accountingState).toBe("unrepresentable_overage"); expect(Number(row.observedEstimateUsd)).toBeGreaterThan(2251799); expect(row.chargeMicrousd).toBe(row.reserveMicrousd); expect(row.budgetBreach).toBe(true);
  expect(store.start(operation.id, 0, fence)).toBeNull(); expect(Number.isSafeInteger(store.budgetTotals().openai.chargeMicrousd)).toBe(true);
});

test("unknown long-context pricing preserves observed counts and full charge while over-bound input fuses admission", () => {
  const operation = store.submit(request(saved().id), store.capture("edit")), fence = store.capture("edit"); store.start(operation.id, 0, fence);
  const receipt = store.finish(operation.id, 0, fence, { status: "completed", result: { output: "Answer", finishReason: "stop", provenance: "controlled-http-fixture", usage: { model: "gpt-5.4", inputTokens: 272001, contextTokens: 272001, cacheReadTokens: 0, outputTokens: 1, tier: "standard" } } });
  const row = receipt.attempts[0]; expect(row.accountingState).toBe("conservative"); expect(row.chargeMicrousd).toBe(row.reserveMicrousd); expect(row.budgetBreach).toBe(true); expect(row.payload).toMatchObject({ usage: { categories: { input: { count: 272001 } } }, estimate: { totalUsd: null } });
  expect(store.start(operation.id, 1, fence)).toBeNull();
});
