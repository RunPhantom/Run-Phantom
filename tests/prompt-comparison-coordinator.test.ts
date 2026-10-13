import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireComparisonOwner } from "../src/prompts/comparison-owner";
import { ComparisonCoordinator } from "../src/prompts/comparison";
import { ComparisonStore } from "../src/prompts/comparison-store";
import { COMPARISON_STORAGE_SQL } from "../src/prompts/comparison-storage";
import { COMPARISON_MODELS } from "../src/prompts/comparison-protocol";
import { PromptRegistry } from "../src/prompts/registry";
import { createComparisonProviderClient } from "../src/prompts/providers";

let directory: string, db: Database, lease: Awaited<ReturnType<typeof acquireComparisonOwner>>, store: ComparisonStore, prompts: PromptRegistry, coordinator: ComparisonCoordinator;
let allowed = true, calls = 0, active = 0, peak = 0;
let responseMode: "normal" | "unavailable" | "oversized" = "normal";
let server: ReturnType<typeof Bun.serve>;
const controls = new Set<() => void>();
beforeEach(async () => {
  allowed = true; calls = 0; active = 0; peak = 0; responseMode = "normal"; controls.clear(); directory = realpathSync(mkdtempSync(path.join(tmpdir(), "rp-comparison-http-"))); const file = path.join(directory, "owner.sqlite"); db = new Database(file);
  db.exec("PRAGMA legacy_alter_table=ON; PRAGMA foreign_keys=OFF"); migrate(drizzle(db), { migrationsFolder: `${import.meta.dir}/../drizzle` }); db.exec("PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF"); db.exec(COMPARISON_STORAGE_SQL);
  db.exec("INSERT INTO evaluation_evidence_scopes VALUES('local:local',1,1); INSERT INTO prompt_scope_controls VALUES('local:local',1); INSERT INTO comparison_scope_controls VALUES('local:local',1)");
  lease = await acquireComparisonOwner(file);
  const owner = { database: db, scope: { kind: "local" as const, id: "local" }, authorize() { if (!allowed) throw new Error("membership revoked"); } }; prompts = new PromptRegistry(owner); store = new ComparisonStore(owner, lease, { budgets: { openai: 1000000, anthropic: 1000000 }, availability: { openai: true, anthropic: true } }); store.recoverPending();
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { model: string; messages: { content: string }[] }; calls++; active++; peak = Math.max(peak, active); expect(body.messages[0].content).toBe("Frozen $& {{literal}}");
    let completed = false; const done = () => { if (!completed) { completed = true; active--; } };
    if (responseMode === "unavailable") { done(); return new Response("controlled upstream unavailable", { status: 503 }); }
    return new Response(new ReadableStream({ start(controller) {
      const release = () => { controls.delete(release); if (completed) return; const output = responseMode === "oversized" ? "x".repeat(70000) : "Controlled answer", raw = body.model.startsWith("gpt") ? { model: body.model, service_tier: "default", choices: [{ message: { content: output }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } } }
        : { model: body.model, stop_reason: "end_turn", content: [{ type: "text", text: output }], usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, inference_geo: "global", service_tier: "standard" } }; controller.enqueue(new TextEncoder().encode(JSON.stringify(raw))); controller.close(); done(); };
      controls.add(release);
    }, cancel() { done(); } }));
  } });
  const provider = createComparisonProviderClient({ credentials: { openai: "fixture-token", anthropic: "fixture-token" }, transport: (_url, init) => fetch(server.url, init), provenance: "controlled-http-fixture" }); coordinator = new ComparisonCoordinator(lease, provider);
});
afterEach(async () => { for (const release of [...controls]) release(); await coordinator.close(); await server.stop(true); db.close(); rmSync(directory, { recursive: true, force: true }); });
function input(registry = prompts, comparisons = store) { const prompt = registry.create({ operationKey: randomUUID(), name: "Frozen", template: "Frozen {{topic}}" }, registry.capture("edit")); return { operationKey: randomUUID(), promptId: prompt.id, revision: 1, variables: { topic: "$& {{literal}}" }, targets: [...COMPARISON_MODELS], options: { maxOutputTokens: 128, temperature: 0 }, operationBudgetMicrousd: 1000000, expectedGeneration: comparisons.capture("edit").comparisonGeneration }; }
async function until(condition: () => boolean) { const deadline = performance.now() + 1500; while (!condition()) { if (performance.now() >= deadline) throw new Error("native control deadline"); await Bun.sleep(5); } }
test("three actual HTTP operations share exactly two fetch slots and preserve all12 immutable target results", async () => {
  const operations = [input(), input(), input()].map(value => coordinator.submit(store, value, store.capture("edit"))); await until(() => calls === 2); expect(peak).toBe(2);
  for (let round = 0; round < 6; round++) { await until(() => controls.size >= 2); for (const release of [...controls]) release(); }
  await coordinator.idle(); expect(calls).toBe(12); expect(peak).toBe(2);
  for (const operation of operations) { const receipt = store.get(operation.id, store.capture("read")); expect(receipt.attempts).toHaveLength(4); expect(receipt.attempts.every(row => row.status === "completed")).toBe(true); expect(receipt.request?.compiled).toBe("Frozen $& {{literal}}"); }
});
test("same-key submissions never dispatch twice and explicit cancellation retains every requested target", async () => {
  const value = input(), one = coordinator.submit(store, value, store.capture("edit")); expect(coordinator.submit(store, value, store.capture("edit")).id).toBe(one.id);
  await until(() => calls === 2); coordinator.cancel(store, one.id, store.capture("edit")); await coordinator.idle();
  const receipt = store.get(one.id, store.capture("read")); expect(calls).toBe(2); expect(receipt.attempts.map(row => row.status)).toEqual(["cancelled", "cancelled", "cancelled", "cancelled"]); expect(receipt.attempts.slice(0, 2).every(row => row.chargeMicrousd === row.reserveMicrousd)).toBe(true); expect(receipt.attempts.slice(2).every(row => row.chargeMicrousd === 0 && row.holdMicrousd === 0)).toBe(true);
});
test("actual prompt privacy deletion aborts work and no late HTTP output can repopulate tombstoned results", async () => {
  const value = input(), operation = coordinator.submit(store, value, store.capture("edit")); await until(() => calls === 2);
  prompts.delete(value.promptId, 1, prompts.capture("delete")); coordinator.retireInvalidated(); for (const release of [...controls]) release(); await coordinator.idle();
  const receipt = store.get(operation.id, store.capture("read")); expect(receipt.tombstone).toBe(true); expect(receipt.request).toBeNull(); expect(receipt.attempts.every(row => row.payload === null && row.status === "authority_lost")).toBe(true); expect(calls).toBe(2);
});
test("current membership loss fences HTTP publication but owner cleanup retains terminal rows and charge", async () => {
  const operation = coordinator.submit(store, input(), store.capture("edit")); await until(() => calls === 2); allowed = false; coordinator.retireInvalidated(); for (const release of [...controls]) release(); await coordinator.idle(); allowed = true;
  const receipt = store.get(operation.id, store.capture("read")); expect(receipt.attempts.every(row => row.status === "authority_lost" && row.payload === null)).toBe(true); expect(receipt.attempts[0].chargeMicrousd).toBe(receipt.attempts[0].reserveMicrousd); expect(calls).toBe(2);
});
test("elapsed admission deadline times out actual native response bodies and queued targets without new calls", async () => {
  const value = input(), now = Date.now(), clock = spyOn(Date, "now"); clock.mockReturnValue(now - 29930);
  let operation;
  try { operation = store.submit(value, store.capture("edit")); } finally { clock.mockRestore(); }
  coordinator.enqueue(store, operation!, store.capture("edit")); await coordinator.idle();
  const receipt = store.get(operation!.id, store.capture("read")); expect(receipt.attempts).toHaveLength(4); expect(receipt.attempts.every(row => row.status === "timeout")).toBe(true); expect(calls).toBe(2); expect(receipt.attempts[0].chargeMicrousd).toBe(receipt.attempts[0].reserveMicrousd); expect(receipt.attempts[2].chargeMicrousd).toBe(0);
});
test("different stores race under one native owner and comparison clear affects only the authorized scope", async () => {
  const projectId = randomUUID(), scopeKey = `project:${projectId}`;
  db.query("INSERT INTO evaluation_evidence_scopes VALUES(?,1,1)").run(scopeKey); db.query("INSERT INTO prompt_scope_controls VALUES(?,1)").run(scopeKey); db.query("INSERT INTO comparison_scope_controls VALUES(?,1)").run(scopeKey);
  const projectOwner = { database: db, scope: { kind: "project" as const, id: projectId }, authorize() {} };
  const projectStore = new ComparisonStore(projectOwner, lease, { budgets: { openai: 1000000, anthropic: 1000000 }, availability: { openai: true, anthropic: true } }), projectPrompts = new PromptRegistry(projectOwner);
  const localAgain = new ComparisonStore({ database: db, scope: { kind: "local", id: "local" }, authorize() {} }, lease, { budgets: { openai: 1000000, anthropic: 1000000 }, availability: { openai: true, anthropic: true } });
  expect(store.sameScope(localAgain)).toBe(true); expect(store.sameScope(projectStore)).toBe(false);
  const localValue = input(), local = coordinator.submit(store, localValue, store.capture("edit")), projectValue = input(projectPrompts, projectStore), project = coordinator.submit(projectStore, projectValue, projectStore.capture("edit"));
  await until(() => calls === 2);
  const before = store.capture("delete"), projectBefore = projectStore.capture("read");
  const cleared = coordinator.clear(localAgain, { operationKey: randomUUID(), expectedGeneration: before.comparisonGeneration, confirmRemoval: true }, localAgain.capture("delete"));
  expect(cleared.generation).toBe(before.comparisonGeneration + 1); expect(store.capture("read").promptGeneration).toBe(before.promptGeneration); expect(store.capture("read").evidenceGeneration).toBe(before.evidenceGeneration); expect(projectStore.capture("read")).toEqual(projectBefore);
  expect(prompts.get(localValue.promptId, 1, prompts.capture("read")).template).toBe("Frozen {{topic}}");
  await until(() => calls === 4); for (const release of [...controls]) release(); await until(() => calls === 6); for (const release of [...controls]) release(); await coordinator.idle();
  const localReceipt = localAgain.get(local.id, localAgain.capture("read")), projectReceipt = projectStore.get(project.id, projectStore.capture("read"));
  expect(peak).toBe(2); expect(calls).toBe(6); expect(localReceipt.tombstone).toBe(true); expect(localReceipt.request).toBeNull(); expect(localReceipt.attempts).toHaveLength(4); expect(localReceipt.attempts.every(row => row.status === "authority_lost" && row.payload === null)).toBe(true); expect(localReceipt.attempts[0].chargeMicrousd).toBe(localReceipt.attempts[0].reserveMicrousd); expect(localReceipt.attempts[2].chargeMicrousd).toBe(0); expect(projectReceipt.attempts.every(row => row.status === "completed")).toBe(true); expect(projectReceipt.request?.compiled).toBe("Frozen $& {{literal}}");
});
test("native upstream failures retain all requested target rows and conservative charges without retries", async () => {
  responseMode = "unavailable"; const operation = coordinator.submit(store, input(), store.capture("edit")); await coordinator.idle();
  const receipt = store.get(operation.id, store.capture("read")); expect(calls).toBe(4); expect(peak).toBeLessThanOrEqual(2); expect(receipt.attempts).toHaveLength(4); expect(receipt.attempts.every(row => row.status === "failed" && row.reason === "provider_error" && row.payload === null && row.chargeMicrousd === row.reserveMicrousd)).toBe(true);
});
test("native oversized provider bodies retain bounded failure outcomes and no unbounded result content", async () => {
  responseMode = "oversized"; const operation = coordinator.submit(store, input(), store.capture("edit"));
  for (let round = 0; round < 2; round++) { await until(() => controls.size >= 2); for (const release of [...controls]) release(); } await coordinator.idle();
  const receipt = store.get(operation.id, store.capture("read")); expect(calls).toBe(4); expect(peak).toBe(2); expect(receipt.attempts).toHaveLength(4); expect(receipt.attempts.every(row => row.status === "failed" && row.reason === "response_limit" && row.payload === null && row.chargeMicrousd === row.reserveMicrousd)).toBe(true); expect(JSON.stringify(receipt).length).toBeLessThan(16000);
});
test("ordinary evidence authority rotation fences held work while saved prompt content remains available", async () => {
  const value = input(), operation = coordinator.submit(store, value, store.capture("edit")), original = prompts.get(value.promptId, 1, prompts.capture("read")); await until(() => calls === 2);
  db.query("UPDATE evaluation_evidence_scopes SET generation=generation+1 WHERE scope_key='local:local'").run(); coordinator.retireInvalidated(); for (const release of [...controls]) release(); await coordinator.idle();
  const receipt = store.get(operation.id, store.capture("read")); expect(receipt.tombstone).toBe(false); expect(receipt.request?.compiled).toBe("Frozen $& {{literal}}"); expect(receipt.attempts).toHaveLength(4); expect(receipt.attempts.every(row => row.status === "authority_lost" && row.payload === null)).toBe(true); expect(prompts.get(value.promptId, 1, prompts.capture("read"))).toEqual(original); expect(calls).toBe(2);
});
test("reopening the same real database recovers uncertain started work without refund or a second dispatch", async () => {
  const value = input(), operation = coordinator.submit(store, value, store.capture("edit")); await until(() => calls === 2); const started = store.get(operation.id, store.capture("read")), file = db.filename, history = db.query("SELECT * FROM __drizzle_migrations ORDER BY id").all();
  await coordinator.close(); db.close(); db = new Database(file); db.exec("PRAGMA foreign_keys=ON"); lease = await acquireComparisonOwner(file);
  const owner = { database: db, scope: { kind: "local" as const, id: "local" }, authorize() {} }; prompts = new PromptRegistry(owner); store = new ComparisonStore(owner, lease, { budgets: { openai: 1000000, anthropic: 1000000 }, availability: { openai: true, anthropic: true } }); store.recoverPending();
  const provider = createComparisonProviderClient({ credentials: { openai: "fixture-token", anthropic: "fixture-token" }, transport: (_url, init) => fetch(server.url, init), provenance: "controlled-http-fixture" }); coordinator = new ComparisonCoordinator(lease, provider);
  const replay = coordinator.submit(store, value, store.capture("edit")); await coordinator.idle();
  expect(replay.id).toBe(operation.id); expect(replay.attempts).toHaveLength(4); expect(replay.attempts.every(row => row.status === "interrupted" && row.payload === null && row.holdMicrousd === 0)).toBe(true); expect(replay.attempts.slice(0, 2).map(row => row.chargeMicrousd)).toEqual(started.attempts.slice(0, 2).map(row => row.chargeMicrousd)); expect(replay.attempts.slice(2).every(row => row.chargeMicrousd === 0)).toBe(true); expect(calls).toBe(2); expect(db.query("SELECT * FROM __drizzle_migrations ORDER BY id").all()).toEqual(history); expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]); expect(prompts.get(value.promptId, 1, prompts.capture("read")).template).toBe("Frozen {{topic}}");
});
