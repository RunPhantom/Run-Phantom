import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateDatabase } from "../src/db/migrate";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireComparisonOwner } from "../src/prompts/comparison-owner";
import { ComparisonStore } from "../src/prompts/comparison-store";
import { PromptRegistry } from "../src/prompts/registry";

let directory: string, db: Database, store: ComparisonStore, prompts: PromptRegistry;
let lease: Awaited<ReturnType<typeof acquireComparisonOwner>>, allowed: boolean;
beforeEach(async () => {
  allowed = true; directory = realpathSync(mkdtempSync(path.join(tmpdir(), "rp-comparison-history-")));
  const file = path.join(directory, "owner.sqlite"); db = new Database(file);
  db.exec("PRAGMA legacy_alter_table=ON; PRAGMA foreign_keys=OFF");
  migrateDatabase(db, `${import.meta.dir}/../drizzle`);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF");
  db.exec("INSERT INTO evaluation_evidence_scopes VALUES('local:local',1,1); INSERT INTO prompt_scope_controls VALUES('local:local',1); INSERT INTO comparison_scope_controls VALUES('local:local',1)");
  lease = await acquireComparisonOwner(file);
  const owner = { database: db, scope: { kind: "local" as const, id: "local" as const }, authorize() { if (!allowed) throw new Error("membership revoked"); } };
  prompts = new PromptRegistry(owner);
  store = new ComparisonStore(owner, lease, { budgets: { openai: 0, anthropic: 0 }, availability: { openai: false, anthropic: false } });
});
afterEach(async () => { await lease.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
function submit() {
  const source = prompts.create({ operationKey: randomUUID(), name: "Saved history", template: "Private input {{topic}}" }, prompts.capture("edit"));
  return store.submit({ operationKey: randomUUID(), promptId: source.id, revision: 1, variables: { topic: "Literal secret-free fixture" },
    targets: [{ provider: "openai", model: "gpt-4.1" }], options: { maxOutputTokens: 128, temperature: 0 },
    operationBudgetMicrousd: 1000000, expectedGeneration: 1 }, store.capture("edit"));
}
test("history pages every same-timestamp native receipt once without acquiring private input/output", () => {
  const clock = spyOn(Date, "now"); clock.mockReturnValue(1791766000000);
  try {
    const operations = Array.from({ length: 41 }, submit), ids: string[] = []; let cursor: string | undefined;
    do {
      const page = store.list(cursor, store.capture("read"));
      expect(page.items.length).toBeLessThanOrEqual(20);
      expect(page.items.every(item => item.prompt?.name === "Saved history" && item.prompt.revision === 1 && item.attempts.length === 1)).toBe(true);
      const serialized = JSON.stringify(page);
      for (const forbidden of ["Private input", "Literal secret-free fixture", '"variables"', '"compiled"', '"payload"', '"rates"']) expect(serialized).not.toContain(forbidden);
      ids.push(...page.items.map(item => item.id)); cursor = page.cursor ?? undefined;
      expect(page.hasMore).toBe(page.cursor !== null);
    } while (cursor);
    expect(ids).toEqual(operations.map(item => item.id).sort().reverse()); expect(new Set(ids).size).toBe(41);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { clock.mockRestore(); }
});
test("history rejects noncanonical, duplicated and authority-bearing cursor forms", () => {
  const operation = submit(), valid = Buffer.from(JSON.stringify([operation.createdAt, operation.id])).toString("base64url");
  expect(store.list(valid, store.capture("read")).items).toEqual([]);
  for (const cursor of [valid + "=", "!", "x".repeat(257), Buffer.from('[0,"' + operation.id + '"]').toString("base64url"),
    Buffer.from('[1,"' + operation.id + '","project:foreign"]').toString("base64url"), Buffer.from('{"time":1,"time":2}').toString("base64url"),
    Buffer.from('[ 1,"' + operation.id + '"]').toString("base64url")]) expect(() => store.list(cursor, store.capture("read"))).toThrow("invalid");
});
test("history preserves finite accounting tombstones while clear removes all private contents", () => {
  const operation = submit(), before = store.list(undefined, store.capture("read")).items[0].attempts;
  store.clear({ operationKey: randomUUID(), expectedGeneration: 1, confirmRemoval: true }, store.capture("delete"));
  const page = store.list(undefined, store.capture("read"));
  expect(page.items[0]).toMatchObject({ id: operation.id, tombstone: true, prompt: null, attempts: before });
  expect(db.query("SELECT frozen_request,prompt_id FROM prompt_comparisons").get()).toEqual({ frozen_request: null, prompt_id: null });
});
test("SQL refuses oversized frozen history metadata without returning its cells", () => {
  const operation = submit(); db.exec("DROP TRIGGER prompt_comparisons_immutable; PRAGMA ignore_check_constraints=ON");
  db.query("UPDATE prompt_comparisons SET frozen_request=? WHERE id=?").run(JSON.stringify({ prompt: { name: "Bounded", revision: 1 }, compiled: "x".repeat(24577) }), operation.id);
  expect(() => store.list(undefined, store.capture("read"))).toThrow("integrity");
});
test("history refuses malformed JSON before evaluating JSON field extraction", () => {
  const operation = submit(); db.exec("DROP TRIGGER prompt_comparisons_immutable");
  db.query("UPDATE prompt_comparisons SET frozen_request='{' WHERE id=?").run(operation.id);
  expect(() => store.list(undefined, store.capture("read"))).toThrow("integrity");
});
test("history keeps captured epochs and native membership authority current", () => {
  submit(); const old = store.capture("read"); db.exec("UPDATE evaluation_evidence_scopes SET generation=generation+1");
  expect(() => store.list(undefined, old)).toThrow("authority"); expect(store.list(undefined, store.capture("read")).items).toHaveLength(1);
  allowed = false; expect(() => store.list(undefined, old)).toThrow("membership");
});
