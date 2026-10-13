import { beforeEach, afterEach, expect, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PromptRegistry } from "../src/prompts/registry";
import { acquireComparisonOwner } from "../src/prompts/comparison-owner";
import { ComparisonStore } from "../src/prompts/comparison-store";
import { COMPARISON_STORAGE_SQL } from "../src/prompts/comparison-storage";
import { COMPARISON_MODELS, COMPARISON_LIMITS } from "../src/prompts/comparison-protocol";
import { estimateComparisonUsage } from "../src/prompts/spend-ledger";
import { createComparisonProviderClient } from "../src/prompts/providers";
import { ComparisonCoordinator } from "../src/prompts/comparison";

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

test("retained payload accounting keeps measured overage and admission fuse through same-file reopen", async () => {
  const first = saved(), operation = store.submit(request(first.id, randomUUID(), [COMPARISON_MODELS[1]]), store.capture("edit")), fence = store.capture("edit");
  store.start(operation.id, 0, fence);
  const result = { output: "x".repeat(7900), finishReason: "stop", provenance: "controlled-http-fixture", usage: { model: "gpt-4.1", inputTokens: 1000000, outputTokens: 1, cacheReadTokens: 0, tier: "standard" } };
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(COMPARISON_LIMITS.attemptPayloadBytes);
  const priced = estimateComparisonUsage(COMPARISON_MODELS[1], result.usage, operation.request!.rates[0]);
  expect(Buffer.byteLength(JSON.stringify({ ...result, ...priced }))).toBeGreaterThan(COMPARISON_LIMITS.attemptPayloadBytes);
  const receipt = store.finish(operation.id, 0, fence, { status: "completed", result });
  expect(receipt.attempts[0]).toMatchObject({ status: "failed", reason: "response_limit", payload: null, chargeMicrousd: 2000008, accountingState: "measured_estimate", observedEstimateUsd: "2.000008", budgetBreach: true });
  expect(store.budgetTotals().openai).toMatchObject({ chargeMicrousd: 2000008, holdMicrousd: 0, breached: true });
  await lease.close(); db.close(); db = new Database(file); lease = await acquireComparisonOwner(file);
  prompts = new PromptRegistry(owner(db)); store = new ComparisonStore(owner(db), lease, { budgets, availability: { openai: true, anthropic: true } });
  expect(store.get(operation.id, store.capture("read"))).toEqual(receipt);
  expect(store.submit(request(first.id, randomUUID(), [COMPARISON_MODELS[1]]), store.capture("edit")).attempts[0].status).toBe("budget_refused");
  const clear = store.capture("delete"); store.clear({ operationKey: randomUUID(), expectedGeneration: clear.comparisonGeneration, confirmRemoval: true }, clear);
  expect(store.budgetTotals().openai).toMatchObject({ chargeMicrousd: 2000008, holdMicrousd: 0, breached: true });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("retained payload accounting preserves an unrepresentable overage without refund or false measured charge", () => {
  const operation = store.submit(request(saved().id, randomUUID(), [COMPARISON_MODELS[1]]), store.capture("edit")), fence = store.capture("edit");
  store.start(operation.id, 0, fence);
  const receipt = store.finish(operation.id, 0, fence, { status: "completed", result: { output: "x".repeat(7900), finishReason: "stop", provenance: "controlled-http-fixture", usage: { model: "gpt-4.1", inputTokens: 2000000000000, outputTokens: 1, cacheReadTokens: 0, tier: "standard" } } });
  expect(receipt.attempts[0]).toMatchObject({ status: "failed", reason: "response_limit", payload: null, chargeMicrousd: operation.attempts[0].reserveMicrousd, accountingState: "unrepresentable_overage", budgetBreach: true });
  expect(Number(receipt.attempts[0].observedEstimateUsd)).toBeGreaterThan(2251799);
  expect(store.budgetTotals().openai.breached).toBe(true);
});

test("retained payload accounting keeps unknown-price input breach conservative and fused", () => {
  const operation = store.submit(request(saved().id, randomUUID(), [COMPARISON_MODELS[0]]), store.capture("edit")), fence = store.capture("edit");
  store.start(operation.id, 0, fence);
  const receipt = store.finish(operation.id, 0, fence, { status: "completed", result: { output: "x".repeat(7900), finishReason: "stop", provenance: "controlled-http-fixture", usage: { model: "gpt-5.4", inputTokens: 272001, contextTokens: 272001, outputTokens: 1, cacheReadTokens: 0, tier: "standard" } } });
  expect(receipt.attempts[0]).toMatchObject({ status: "failed", reason: "response_limit", payload: null, chargeMicrousd: operation.attempts[0].reserveMicrousd, accountingState: "conservative", observedEstimateUsd: null, budgetBreach: true });
  expect(store.budgetTotals().openai.breached).toBe(true);
});

test("retained payload accounting preserves invalid output refusal atomically", () => {
  const operation = store.submit(request(saved().id, randomUUID(), [COMPARISON_MODELS[1]]), store.capture("edit")), fence = store.capture("edit");
  store.start(operation.id, 0, fence); const before = store.get(operation.id, fence), budget = store.budgetTotals();
  expect(() => store.finish(operation.id, 0, fence, { status: "completed", result: { output: "x".repeat(7900) + "\0", finishReason: "stop", provenance: "controlled-http-fixture", usage: { model: "gpt-4.1", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, tier: "standard" } } })).toThrow();
  expect(store.get(operation.id, fence)).toEqual(before); expect(store.budgetTotals()).toEqual(budget);
});

test("retained payload accounting survives the actual adapter and coordinator before reopening its native file", async () => {
  let calls = 0;
  const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(message) {
    const body = await message.json() as { model: string; store: boolean; service_tier: string; max_completion_tokens: number };
    expect(body).toMatchObject({ model: "gpt-4.1", store: false, service_tier: "default", max_completion_tokens: 128 }); calls++;
    return Response.json({ model: "gpt-4.1", service_tier: "default", choices: [{ message: { role: "assistant", content: "x".repeat(7900) }, finish_reason: "stop" }], usage: { prompt_tokens: 1000000, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } } });
  } });
  const client = createComparisonProviderClient({ credentials: { openai: "controlled-private-fixture" }, transport: (_official, init) => fetch(`http://127.0.0.1:${endpoint.port}/controlled`, init), provenance: "controlled-http-fixture" });
  const coordinator = new ComparisonCoordinator(lease, client);
  try {
    const first = saved(), input = request(first.id, randomUUID(), [COMPARISON_MODELS[1]]);
    const operation = coordinator.submit(store, input, store.capture("edit")); await coordinator.idle();
    expect(calls).toBe(1);
    const receipt = store.get(operation.id, store.capture("read"));
    expect(receipt.attempts[0]).toMatchObject({ status: "failed", reason: "response_limit", payload: null, chargeMicrousd: 2000008, accountingState: "measured_estimate", observedEstimateUsd: "2.000008", budgetBreach: true });
    const refused = coordinator.submit(store, { ...input, operationKey: randomUUID() }, store.capture("edit")); await coordinator.idle();
    expect(refused.attempts[0].status).toBe("budget_refused"); expect(calls).toBe(1);
    await coordinator.close(); db.close(); db = new Database(file); lease = await acquireComparisonOwner(file);
    prompts = new PromptRegistry(owner(db)); store = new ComparisonStore(owner(db), lease, { budgets, availability: { openai: true, anthropic: true } });
    expect(store.get(operation.id, store.capture("read"))).toEqual(receipt);
    expect(store.budgetTotals().openai).toMatchObject({ chargeMicrousd: 2000008, holdMicrousd: 0, breached: true });
    expect(store.submit({ ...input, operationKey: randomUUID() }, store.capture("edit")).attempts[0].status).toBe("budget_refused");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]); expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  } finally { await coordinator.close(); await endpoint.stop(true); }
});

function retainedBytes() {
  const columns = (names: string[]) => names.map(name => `coalesce(length(CAST(${name} AS BLOB)),0)`).join("+");
  return (db.query(`SELECT (SELECT coalesce(sum(${columns(["scope_key", "id", "operation_key", "request_digest", "prompt_id", "frozen_request"])}+80),0) FROM prompt_comparisons)+(SELECT coalesce(sum(${columns(["scope_key", "comparison_id", "provider", "model", "status", "reason", "payload", "accounting_state", "observed_estimate_usd"])}+96),0) FROM prompt_comparison_attempts)+(SELECT coalesce(sum(length(CAST(scope_key AS BLOB))+8),0) FROM comparison_scope_controls) n`).get() as { n: number }).n;
}

/** Native valid finite histories, not a claim of background provider dispatches. */
function nearCapacity(freeBytes: number, runningPosition = 0) {
  const complete = store.submit(request(saved().id), store.capture("edit"));
  for (let position = 0; position < 4; position++) {
    const target = COMPARISON_MODELS[position], usage = { model: target.model, inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, ...(target.provider === "openai" ? { contextTokens: 3 } : { cacheWriteTokens: 0 }), tier: "standard" };
    const priced = estimateComparisonUsage(target, usage, complete.request!.rates[position]);
    const result = { output: "", finishReason: "stop", provenance: "controlled-http-fixture" as const, usage };
    result.output = "x".repeat(COMPARISON_LIMITS.attemptPayloadBytes - Buffer.byteLength(JSON.stringify({ ...result, ...priced })));
    store.start(complete.id, position, store.capture("edit")); store.finish(complete.id, position, store.capture("edit"), { status: "completed", result });
  }
  const prototype = store.get(complete.id, store.capture("read"));
  const target = store.submit(request(saved().id), store.capture("edit")); store.start(target.id, runningPosition, store.capture("edit"));
  const rows = db.query("SELECT * FROM prompt_comparison_attempts WHERE comparison_id=? ORDER BY position").all(complete.id) as Array<{
    position: number; provider: string; model: string; status: string; reason: string | null; payload: string; reserve_microusd: number; hold_microusd: number;
    charge_microusd: number; accounting_state: string; observed_estimate_usd: string; budget_breach: number; deadline_at: number; started_at: number; finished_at: number;
  }>;
  const groups = Array.from({ length: 10 }, () => {
    const id = randomUUID(), scope = `project:${id}`;
    db.query("INSERT INTO evaluation_evidence_scopes VALUES(?,1,1)").run(scope); db.query("INSERT INTO prompt_scope_controls VALUES(?,1)").run(scope); db.query("INSERT INTO comparison_scope_controls VALUES(?,1)").run(scope);
    const projectOwner = owner(db, id, "project"), registry = new PromptRegistry(projectOwner);
    const source = registry.create({ operationKey: randomUUID(), name: "Frozen", template: "Explain {{topic}}" }, registry.capture("edit"));
    return { scope, source, projectOwner };
  });
  const plan = (index: number) => {
    const group = groups[Math.floor(index / 100)], id = randomUUID(), key = randomUUID();
    const frozen = { ...prototype.request!, operationKey: key, promptId: group.source.id, prompt: { ...prototype.request!.prompt, id: group.source.id } };
    const semantic = { operationKey: key, promptId: group.source.id, revision: frozen.revision, variables: frozen.variables, targets: frozen.targets, options: frozen.options, operationBudgetMicrousd: frozen.operationBudgetMicrousd };
    const serialized = JSON.stringify(frozen), digest = createHash("sha256").update(JSON.stringify({ scope: group.scope, request: semantic })).digest("hex");
    const headSize = Buffer.byteLength(group.scope) + 36 + 36 + 64 + 36 + Buffer.byteLength(serialized) + 80;
    const size = headSize + rows.reduce((sum, row) => sum + Buffer.byteLength(group.scope) + 36 + Buffer.byteLength(row.provider) + Buffer.byteLength(row.model) + Buffer.byteLength(row.status) + Buffer.byteLength(row.payload) + Buffer.byteLength(row.accounting_state) + Buffer.byteLength(row.observed_estimate_usd) + 96, 0);
    return { group, id, key, serialized, digest, size };
  };
  const need = COMPARISON_LIMITS.retainedBytes - freeBytes - retainedBytes(), first = plan(0), count = Math.ceil(need / first.size);
  expect(count).toBeLessThan(998); let shaving = count * first.size - need;
  db.transaction(() => {
    for (let index = 0; index < count; index++) {
      const item = index === 0 ? first : plan(index);
      db.query("INSERT INTO prompt_comparisons(scope_key,id,operation_key,request_digest,prompt_id,frozen_request,prompt_generation,evidence_generation,comparison_generation,target_count,created_at) VALUES(?,?,?,?,?,?,1,1,1,4,?)").run(item.group.scope, item.id, item.key, item.digest, item.group.source.id, item.serialized, prototype.createdAt);
      for (const row of rows) {
        const body = JSON.parse(row.payload) as { output: string }; const take = Math.min(shaving, body.output.length); body.output = body.output.slice(take); shaving -= take;
        db.query("INSERT INTO prompt_comparison_attempts(scope_key,comparison_id,position,provider,model,status,reason,payload,reserve_microusd,hold_microusd,charge_microusd,accounting_state,observed_estimate_usd,budget_breach,deadline_at,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(item.group.scope, item.id, row.position, row.provider, row.model, row.status, row.reason, JSON.stringify(body), row.reserve_microusd, row.hold_microusd, row.charge_microusd, row.accounting_state, row.observed_estimate_usd, row.budget_breach, row.deadline_at, row.started_at, row.finished_at);
      }
      const validating = new ComparisonStore(item.group.projectOwner, lease, { budgets, availability: { openai: true, anthropic: true } });
      expect(validating.get(item.id, validating.capture("read")).attempts).toHaveLength(4);
    }
  }).immediate();
  expect(shaving).toBe(0); expect(retainedBytes()).toBe(COMPARISON_LIMITS.retainedBytes - freeBytes);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  return target;
}

test("near-cap completion retains truthful terminal accounting and leaves clear and recovery usable", () => {
  const clock = spyOn(Date, "now"); clock.mockReturnValue(1791766000000);
  try {
    const target = nearCapacity(100), fence = store.capture("edit");
    const completed = { output: "", finishReason: "stop", provenance: "controlled-http-fixture" as const, usage: { model: "gpt-5.4", inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, contextTokens: 3, tier: "standard" } };
    const priced = estimateComparisonUsage(COMPARISON_MODELS[0], completed.usage, target.request!.rates[0]);
    completed.output = "x".repeat(COMPARISON_LIMITS.attemptPayloadBytes - Buffer.byteLength(JSON.stringify({ ...completed, ...priced })));
    const result = store.finish(target.id, 0, fence, { status: "completed", result: completed });
    expect(retainedBytes()).toBeLessThanOrEqual(COMPARISON_LIMITS.retainedBytes);
    expect(result.attempts).toHaveLength(4); expect(result.attempts[0]).toMatchObject({ status: "failed", reason: "response_limit", payload: null, accountingState: "measured_estimate", budgetBreach: false });
    expect(result.attempts[0].chargeMicrousd).toBeGreaterThan(0); expect(result.attempts[0].observedEstimateUsd).not.toBeNull();
    expect(store.get(target.id, fence)).toEqual(result);
    const charged = store.budgetTotals().openai.chargeMicrousd; store.terminatePending(target.id); store.recoverPending();
    expect(retainedBytes()).toBeLessThanOrEqual(COMPARISON_LIMITS.retainedBytes);
    expect(store.get(target.id, fence).attempts.every(row => !["queued", "running"].includes(row.status))).toBe(true);
    store.clear({ operationKey: randomUUID(), expectedGeneration: 1, confirmRemoval: true }, store.capture("delete"));
    expect(store.get(target.id, store.capture("read")).tombstone).toBe(true); expect(store.budgetTotals().openai.chargeMicrousd).toBe(charged);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { clock.mockRestore(); }
}, 30000);

test("admission reserves every pending target's complete future payload before retaining another operation", () => {
  const clock = spyOn(Date, "now"); clock.mockReturnValue(1791766000000);
  try {
    const target = nearCapacity(20000), before = retainedBytes(), budget = store.budgetTotals();
    const counts = db.query("SELECT (SELECT count(*) FROM prompt_comparisons) operations,(SELECT count(*) FROM prompt_comparison_attempts) attempts").get();
    expect(() => store.submit(request(target.request!.promptId), store.capture("edit"))).toThrow("capacity");
    expect(retainedBytes()).toBe(before); expect(store.budgetTotals()).toEqual(budget);
    expect(db.query("SELECT (SELECT count(*) FROM prompt_comparisons) operations,(SELECT count(*) FROM prompt_comparison_attempts) attempts").get()).toEqual(counts);
    expect(store.get(target.id, store.capture("read")).attempts).toHaveLength(4);
  } finally { clock.mockRestore(); }
}, 30000);

test("full historical retention purges only the current operation's content and preserves overage accounting", async () => {
  const clock = spyOn(Date, "now"); clock.mockReturnValue(1791766000000);
  try {
    const target = nearCapacity(0, 1), fence = store.capture("edit"), reserved = target.attempts[1].reserveMicrousd;
    const others = db.query("SELECT count(*) n,sum(length(CAST(payload AS BLOB))) bytes FROM prompt_comparison_attempts WHERE comparison_id<>?").get(target.id);
    const receipt = store.finish(target.id, 1, fence, { status: "completed", result: { output: "Answer", finishReason: "stop", provenance: "controlled-http-fixture", usage: { model: "gpt-4.1", inputTokens: 2000000000000, outputTokens: 1, cacheReadTokens: 0, tier: "standard" } } });
    expect(receipt.tombstone).toBe(true); expect(receipt.request).toBeNull(); expect(receipt.attempts).toHaveLength(4);
    expect(receipt.attempts[1]).toMatchObject({ status: "failed", reason: "response_limit", payload: null, chargeMicrousd: reserved, accountingState: "unrepresentable_overage", budgetBreach: true });
    expect(Number(receipt.attempts[1].observedEstimateUsd)).toBeGreaterThan(2251799);
    expect(receipt.attempts.filter(row => row.position !== 1).every(row => row.status === "authority_lost" && row.chargeMicrousd === 0 && row.holdMicrousd === 0)).toBe(true);
    expect(retainedBytes()).toBeLessThanOrEqual(COMPARISON_LIMITS.retainedBytes);
    expect(db.query("SELECT count(*) n,sum(length(CAST(payload AS BLOB))) bytes FROM prompt_comparison_attempts WHERE comparison_id<>?").get(target.id)).toEqual(others);
    expect(store.get(target.id, fence)).toEqual(receipt); store.recoverPending(); store.terminatePending(target.id);
    await lease.close(); db.close(); db = new Database(file); db.exec("PRAGMA foreign_keys=ON"); lease = await acquireComparisonOwner(file);
    prompts = new PromptRegistry(owner(db)); store = new ComparisonStore(owner(db), lease, { budgets, availability: { openai: true, anthropic: true } });
    expect(store.get(target.id, store.capture("read"))).toEqual(receipt); store.recoverPending();
    const budget = store.budgetTotals(); store.clear({ operationKey: randomUUID(), expectedGeneration: 1, confirmRemoval: true }, store.capture("delete"));
    expect(store.budgetTotals()).toEqual(budget); expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { clock.mockRestore(); }
}, 30000);

test("an output that fits alone cannot consume other pending targets' terminal cleanup space", () => {
  const clock = spyOn(Date, "now"); clock.mockReturnValue(1791766000000);
  try {
    const target = nearCapacity(8192 + 16), fence = store.capture("edit");
    const result = { output: "", finishReason: "stop", provenance: "controlled-http-fixture" as const, usage: { model: "gpt-5.4", inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, contextTokens: 3, tier: "standard" } };
    const priced = estimateComparisonUsage(COMPARISON_MODELS[0], result.usage, target.request!.rates[0]);
    result.output = "x".repeat(COMPARISON_LIMITS.attemptPayloadBytes - Buffer.byteLength(JSON.stringify({ ...result, ...priced })));
    const receipt = store.finish(target.id, 0, fence, { status: "completed", result });
    expect(receipt.attempts[0]).toMatchObject({ status: "failed", reason: "response_limit", payload: null });
    store.recoverPending(); expect(store.get(target.id, fence).attempts.slice(1).every(row => row.status === "interrupted")).toBe(true);
    expect(retainedBytes()).toBeLessThanOrEqual(COMPARISON_LIMITS.retainedBytes);
  } finally { clock.mockRestore(); }
}, 30000);
