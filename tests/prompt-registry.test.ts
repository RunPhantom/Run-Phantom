import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalPromptRegistry, PromptRegistry } from "../src/prompts/registry";
import { PromptRegistryError } from "../src/prompts/protocol";
import { createLocalEvidenceOwner } from "../src/evaluations/evidence-inventory";
import { buildRedactionPolicy, resetActiveRedactionPolicy, setActiveRedactionPolicy } from "../src/verification/redaction";

let db: Database, registry: PromptRegistry;
const draft = (template = "Hello {{who}}", name = "Greeting") => ({ operationKey: randomUUID(), name, template });
function initialize(database: Database) {
  database.exec("PRAGMA legacy_alter_table=ON; PRAGMA foreign_keys=OFF");
  migrate(drizzle(database), { migrationsFolder: `${import.meta.dir}/../drizzle` });
  database.exec("PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF");
  database.exec(readFileSync(`${import.meta.dir}/fixtures/prompt-registry-schema.sql`, "utf8"));
  database.exec("INSERT INTO evaluation_evidence_scopes VALUES('local:local',1,1)");
}
beforeEach(() => {
  db = new Database(":memory:"); initialize(db);
  registry = createLocalPromptRegistry(db);
});
afterEach(() => { resetActiveRedactionPolicy(); db.close(); });

test("append preserves exact pinned name, template, schema, hash and literal compilation", () => {
  const first = registry.create(draft('  日本語\n{"a":{"b":"{{who}}"}}\n', "Original"), registry.capture("edit"));
  const second = registry.append(first.id, { ...draft("Edited {{other}}", "Changed"), expectedRevision: 1 }, registry.capture("edit"));
  expect(second.revision).toBe(2);
  expect(registry.get(first.id, 1)).toEqual(first);
  expect(first.templateSha256).toBe(createHash("sha256").update(first.template).digest("hex"));
  expect(first.variableNames).toEqual(["who"]);
  expect(registry.compile(first.id, 1, { who: "$& {{other}} 🦊" }, registry.capture("read"))).toMatchObject({ revision: 1, compiled: '  日本語\n{"a":{"b":"$& {{other}} 🦊"}}\n' });
  expect(registry.export(first.id, 1).prompt).toEqual(first);
  expect(registry.history(first.id).items.map(item => item.revision)).toEqual([2, 1]);
  expect(() => db.query("UPDATE prompt_revisions SET name='mutated' WHERE id=?").run(first.id)).toThrow("immutable");
});
test("durable same-operation retries return original revision after later appends", () => {
  const input = draft(), first = registry.create(input, registry.capture("edit"));
  const append = { ...draft("Second"), expectedRevision: 1 };
  const second = registry.append(first.id, append, registry.capture("edit"));
  registry.append(first.id, { ...draft("Third"), expectedRevision: 2 }, registry.capture("edit"));
  expect(registry.create(input, registry.capture("edit"))).toEqual(first);
  expect(registry.append(first.id, append, registry.capture("edit"))).toEqual(second);
  expect(() => registry.create({ ...input, template: "changed" }, registry.capture("edit"))).toThrow("operation");
  expect(() => registry.append(first.id, { ...append, name: "changed" }, registry.capture("edit"))).toThrow("operation");
  expect(() => registry.append(first.id, { ...draft(), expectedRevision: 1 }, registry.capture("edit"))).toThrow("changed");
  expect(db.query("SELECT count(*) AS n FROM prompt_revisions").get()).toEqual({ n: 3 });
});
test("operation keys cannot migrate between create/append or owned prompt identities", () => {
  const input = draft(), first = registry.create(input, registry.capture("edit")), other = registry.create(draft(), registry.capture("edit"));
  expect(() => registry.append(first.id, { ...input, expectedRevision: 1 }, registry.capture("edit"))).toThrow("operation");
  const append = { ...draft(), expectedRevision: 1 };
  registry.append(first.id, append, registry.capture("edit"));
  expect(() => registry.create(append, registry.capture("edit"))).toThrow(PromptRegistryError);
  expect(() => registry.append(other.id, append, registry.capture("edit"))).toThrow("operation");
});
test("generation rotation refuses stale requests while fresh authority retains immutable history", () => {
  const first = registry.create(draft(), registry.capture("edit")), stale = registry.capture("edit");
  db.exec("UPDATE evaluation_evidence_scopes SET generation=generation+1 WHERE scope_key='local:local'");
  expect(registry.get(first.id, 1)).toEqual(first);
  expect(() => registry.create(draft(), stale)).toThrow("authority changed");
  expect(() => registry.compile(first.id, 1, { who: "reader" }, stale)).toThrow("authority changed");
  expect(registry.append(first.id, { ...draft("Fresh"), expectedRevision: 1 }, registry.capture("edit")).revision).toBe(2);
  expect(db.query("PRAGMA table_info(prompt_revisions)").all().map((row: unknown) => (row as { name: string }).name)).not.toContain("scope_generation");
});
test("delete removes content and retains bounded identity tombstone without resurrection", () => {
  const input = draft("private ordinary content"), first = registry.create(input, registry.capture("edit"));
  expect(() => registry.delete(first.id, 2, registry.capture("delete"))).toThrow("changed");
  registry.delete(first.id, 1, registry.capture("delete"));
  expect(db.query("SELECT count(*) AS n FROM prompt_revisions").get()).toEqual({ n: 0 });
  expect(db.query("SELECT deleted FROM prompt_heads WHERE id=?").get(first.id)).toEqual({ deleted: 1 });
  expect(() => registry.create(input, registry.capture("edit"))).toThrow("removed");
  expect(() => registry.get(first.id, 1)).toThrow("not found");
  expect(() => registry.export(first.id, 1)).toThrow("not found");
  expect(registry.list().items).toEqual([]);
});
test("explicit prompt-only clear rotates authority before deletion and invalidates queued operations", () => {
  const input = draft(), first = registry.create(input, registry.capture("edit")), queued = registry.capture("edit");
  db.exec("INSERT INTO runs(id,started_at,last_updated_at) VALUES('unrelated-run',1,1)");
  const result = registry.clear({ expectedGeneration: queued, operationKey: randomUUID() }, registry.capture("delete"));
  expect(result.generation).toBe(queued + 1);
  expect(db.query("SELECT count(*) AS n FROM prompt_heads").get()).toEqual({ n: 0 });
  expect(db.query("SELECT count(*) AS n FROM runs WHERE id='unrelated-run'").get()).toEqual({ n: 1 });
  expect(() => registry.create(input, queued)).toThrow("authority changed");
  expect(() => registry.delete(first.id, 1, queued)).toThrow("authority changed");
  expect(() => registry.clear({ expectedGeneration: queued, operationKey: randomUUID() }, registry.capture("delete"))).toThrow("authority changed");
  expect(registry.create(input, registry.capture("edit")).id).not.toBe(first.id);
});
test("unknown and malformed explicit revisions or authority fields refuse without fallback", () => {
  const first = registry.create(draft(), registry.capture("edit"));
  for (const revision of [undefined, null, 0, -1, 1.5, "1", 33, Infinity]) expect(() => registry.get(first.id, revision as number)).toThrow(PromptRegistryError);
  expect(() => registry.get(first.id, 2)).toThrow("not found");
  for (const field of ["scope", "database", "profile", "projectId", "id"]) {
    expect(() => registry.create({ ...draft(), [field]: "override" }, registry.capture("edit"))).toThrow(PromptRegistryError);
  }
});
test("credential-bearing names/templates/variables/output fragments refuse before persistence under ambient exemptions", () => {
  setActiveRedactionPolicy(buildRedactionPolicy({ allow: ["password", "access_token"] }));
  for (const input of [draft("password=synthetic-password"), draft("literal", "password=synthetic-password"), draft("https://example.invalid/?access_token=synthetic-query")]) {
    expect(() => registry.create(input, registry.capture("edit"))).toThrow("credentials");
  }
  expect(db.query("SELECT count(*) AS n FROM prompt_revisions").get()).toEqual({ n: 0 });
  const first = registry.create(draft("sk-proj-{{suffix}}"), registry.capture("edit"));
  expect(() => registry.compile(first.id, 1, { suffix: "A".repeat(20) }, registry.capture("read"))).toThrow("credentials");
  expect(() => registry.compile(first.id, 1, { suffix: "password=synthetic-password" }, registry.capture("read"))).toThrow("credentials");
  expect(registry.compile(first.id, 1, { suffix: "ordinary" }, registry.capture("read"))).toMatchObject({ compiled: "sk-proj-ordinary" });
  expect(() => registry.create(draft("{{password}}"), registry.capture("edit"))).toThrow("credentials");
});
test("bounded corrupt payloads are withheld by SQL CASE and never echoed in refusals", () => {
  const first = registry.create(draft(), registry.capture("edit"));
  db.exec("DROP TRIGGER prompt_revision_immutable; PRAGMA ignore_check_constraints=ON");
  const bad = "SYNTHETIC_PRIVATE_" + "x".repeat(32769);
  db.query("UPDATE prompt_revisions SET template=? WHERE id=?").run(bad, first.id);
  try { registry.get(first.id, 1); throw new Error("Expected refusal"); }
  catch (error) { expect(error).toBeInstanceOf(PromptRegistryError); expect((error as Error).message).not.toContain("SYNTHETIC_PRIVATE_"); }
  expect(() => registry.list()).toThrow("integrity");
});
test("normal actual external-report scope clear preserves prompt history across its authority rotation", () => {
  const input = draft(), first = registry.create(input, registry.capture("edit")), fence = registry.capture("read");
  createLocalEvidenceOwner(db).store.purgeScope();
  expect(registry.get(first.id, 1)).toEqual(first);
  expect(registry.create(input, registry.capture("edit"))).toEqual(first);
  expect(() => registry.get(first.id, 1, fence)).toThrow("authority changed");
  expect(registry.export(first.id, 1).prompt).toEqual(first);
});
test("real SQLite file reopen preserves historical revisions, operation identity and tombstones", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "runphantom-prompts-")), filename = path.join(directory, "fixture.sqlite");
  let database = new Database(filename);
  try {
    initialize(database); const initial = createLocalPromptRegistry(database), input = draft(), first = initial.create(input, initial.capture("edit"));
    const second = initial.append(first.id, { ...draft("Later"), expectedRevision: 1 }, initial.capture("edit"));
    database.close(); database = new Database(filename); const reopened = createLocalPromptRegistry(database);
    expect(reopened.get(first.id, 1)).toEqual(first);
    expect(reopened.get(first.id, 2)).toEqual(second);
    expect(reopened.create(input, reopened.capture("edit"))).toEqual(first);
    reopened.delete(first.id, 2, reopened.capture("delete"));
    database.close(); database = new Database(filename);
    expect(() => createLocalPromptRegistry(database).create(input, createLocalPromptRegistry(database).capture("edit"))).toThrow("removed");
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
test("100 scoped heads including tombstones bound admission and prompt-only clear recovers capacity", () => {
  const first = registry.create(draft("small"), registry.capture("edit"));
  for (let i = 1; i < 100; i++) registry.create(draft("small"), registry.capture("edit"));
  expect(() => registry.create(draft(), registry.capture("edit"))).toThrow("capacity");
  registry.delete(first.id, 1, registry.capture("delete"));
  expect(() => registry.create(draft(), registry.capture("edit"))).toThrow("capacity");
  registry.clear({ expectedGeneration: registry.capture("delete"), operationKey: randomUUID() }, registry.capture("delete"));
  expect(registry.create(draft(), registry.capture("edit")).revision).toBe(1);
});
test("32 revisions cap append while exact old retries still succeed", () => {
  const input = draft("small"), first = registry.create(input, registry.capture("edit"));
  for (let expectedRevision = 1; expectedRevision < 32; expectedRevision++) registry.append(first.id, { ...draft("small"), expectedRevision }, registry.capture("edit"));
  expect(() => registry.append(first.id, { ...draft(), expectedRevision: 32 }, registry.capture("edit"))).toThrow("capacity");
  expect(registry.create(input, registry.capture("edit"))).toEqual(first);
  expect(registry.history(first.id).items).toHaveLength(32);
});
test("list keyset pagination retains all 100 identities and never materializes templates for summaries/history", () => {
  for (let i = 0; i < 100; i++) registry.create(draft("body {{who}}", "Prompt " + i), registry.capture("edit"));
  const query = spyOn(db, "query");
  try {
    const first = registry.list(), second = registry.list(first.cursor);
    expect(first.items).toHaveLength(50); expect(first.hasMore).toBe(true);
    expect(second.items).toHaveLength(50); expect(second.hasMore).toBe(false);
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(100);
    registry.history(first.items[0].id);
    const reads = query.mock.calls.map(call => String(call[0])).filter(sql => /^SELECT /.test(sql));
    expect(reads.some(sql => /THEN template ELSE NULL/.test(sql))).toBe(false);
    expect(reads.some(sql => /CASE WHEN typeof\(template\)/.test(sql))).toBe(true);
  } finally { query.mockRestore(); }
});
test("actual global logical UTF-8 totals refuse oversized retained payload before selecting its text", () => {
  const first = registry.create(draft("small"), registry.capture("edit"));
  db.exec("DROP TRIGGER prompt_revision_immutable; PRAGMA ignore_check_constraints=ON");
  db.query("UPDATE prompt_revisions SET template=cast(zeroblob(33554433) AS TEXT) WHERE id=?").run(first.id);
  const query = spyOn(db, "query");
  try {
    expect(() => registry.get(first.id, 1)).toThrow("integrity");
    expect(query.mock.calls.map(call => String(call[0])).some(sql => /THEN template ELSE NULL/.test(sql))).toBe(false);
  } finally { query.mockRestore(); }
});
test("JSON response escaping is bounded and refused creates roll back entirely", () => {
  expect(() => registry.create(draft("\u0001".repeat(32768)), registry.capture("edit"))).toThrow("limit");
  expect(db.query("SELECT count(*) AS n FROM prompt_heads").get()).toEqual({ n: 0 });
  expect(db.query("SELECT count(*) AS n FROM prompt_revisions").get()).toEqual({ n: 0 });
});
function seedOtherScopes(heads: number, revisions: number, template = "") {
  db.transaction(() => {
    let scopeKey = "", remaining = revisions;
    const templateHash = createHash("sha256").update(template).digest("hex");
    for (let head = 0; head < heads; head++) {
      if (head % 100 === 0) {
        scopeKey = "project:" + randomUUID();
        db.query("INSERT INTO evaluation_evidence_scopes VALUES(?,1,1)").run(scopeKey);
      }
      const id = randomUUID(), count = Math.min(32, remaining - (heads - head - 1)), operationKey = randomUUID();
      db.query("INSERT INTO prompt_heads VALUES(?,?,?,0,?,?,1,1)").run(scopeKey, id, Math.max(1, count), operationKey, "a".repeat(64));
      for (let revision = 1; revision <= count; revision++) db.query("INSERT INTO prompt_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .run(scopeKey, id, revision, "Fixture", template, templateHash, "[]", "literal-v1", revision === 1 ? operationKey : randomUUID(), "a".repeat(64), 1);
      remaining -= count;
    }
    expect(remaining).toBe(0);
  }).immediate();
}
test("global 1000 head and 10000 revision populations bound fresh admission independently", () => {
  const first = registry.create(draft("small"), registry.capture("edit"));
  seedOtherScopes(999, 9999);
  expect(db.query("SELECT count(*) AS n FROM prompt_heads").get()).toEqual({ n: 1000 });
  expect(db.query("SELECT count(*) AS n FROM prompt_revisions").get()).toEqual({ n: 10000 });
  expect(() => registry.create(draft(), registry.capture("edit"))).toThrow("capacity");
  expect(() => registry.append(first.id, { ...draft(), expectedRevision: 1 }, registry.capture("edit"))).toThrow("capacity");
  expect(registry.get(first.id, 1).id).toBe(first.id);
});
test("actual retained UTF-8 admission counts every row and keeps existing content readable at the cap", () => {
  const first = registry.create(draft("small"), registry.capture("edit"));
  seedOtherScopes(32, 1015, "a".repeat(32768));
  expect(() => registry.create(draft("a".repeat(32768)), registry.capture("edit"))).toThrow("capacity");
  expect(registry.get(first.id, 1).template).toBe("small");
  expect(db.query("SELECT count(*) AS n FROM prompt_heads WHERE scope_key='local:local'").get()).toEqual({ n: 1 });
});
test("trusted scope selection refuses another scope's prompt IDs and revoked owner requests", () => {
  const first = registry.create(draft("local-only"), registry.capture("edit")), projectId = randomUUID();
  db.query("INSERT INTO evaluation_evidence_scopes VALUES(?,1,1)").run("project:" + projectId);
  let allowed = true;
  const project = new PromptRegistry({ database: db, scope: { kind: "project", id: projectId }, authorize: () => { if (!allowed) throw new Error("Current actual owner revoked"); } });
  expect(() => project.get(first.id, 1)).toThrow("not found");
  const created = project.create(draft("project-only"), project.capture("edit"));
  expect(() => registry.get(created.id, 1)).toThrow("not found");
  const queued = project.capture("edit"); allowed = false;
  expect(() => project.append(created.id, { ...draft("late"), expectedRevision: 1 }, queued)).toThrow("revoked");
  expect(() => project.get(created.id, 1, queued)).toThrow("revoked");
  expect(registry.get(first.id, 1).template).toBe("local-only");
});
