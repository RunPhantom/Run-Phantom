import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROMPT_STORAGE_SQL } from "../src/prompts/storage";
import { initializeTeamSchema, TEAM_SCHEMA_VERSION } from "../src/team/store-schema";

const connections: Database[] = [];
afterEach(() => { for (const db of connections.splice(0)) db.close(); });
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
function database(version = 0): Database {
  const db = new Database(":memory:", { strict: true }); connections.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  if (version === 1) db.exec(fixture("team-schema-v1.sql"));
  if (version >= 2) db.exec(fixture("prompt-registry-team-v2.sql"));
  if (version === 3) { db.exec(PROMPT_STORAGE_SQL); db.exec("PRAGMA user_version=3"); }
  return db;
}
const catalog = (db: Database) => db.query("SELECT name,type,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all() as Array<{name: string;type: string;sql: string}>;
const tables = ["team_review_queues", "team_review_items", "team_review_datasets", "team_review_dataset_revisions", "team_review_promotions"];

test("fresh native Team storage installs exactly five project review tables at version4 and reopens", () => {
  const db = database(); initializeTeamSchema(db);
  expect(TEAM_SCHEMA_VERSION).toBe(4);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
  expect(catalog(db).filter(row => row.name.startsWith("team_review_") && row.type === "table").map(row => row.name).sort()).toEqual([...tables].sort());
  const before = catalog(db); initializeTeamSchema(db); expect(catalog(db)).toEqual(before);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

for (const version of [1, 2, 3]) test(`populated version${version} upgrade preserves every prior object and row exactly`, () => {
  const db = database(version);
  db.exec("INSERT INTO accounts VALUES('owner','owner@example.test','old-hash',1,1); INSERT INTO projects(id,name,created_at,evidence_bytes) VALUES('project','Original β',1,789); INSERT INTO memberships VALUES('project','owner','admin',1)");
  if (version === 3) db.exec("INSERT INTO prompt_scope_controls(scope_key,generation) VALUES('project:project',7)");
  const prior = catalog(db), data = db.query("SELECT * FROM projects").all(), accounts = db.query("SELECT * FROM accounts").all();
  initializeTeamSchema(db);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
  const after = catalog(db);
  for (const row of prior) expect(after.find(value => value.name === row.name)).toEqual(row);
  expect(db.query("SELECT * FROM projects").all()).toEqual(data);
  expect(db.query("SELECT * FROM accounts").all()).toEqual(accounts);
  expect(db.query("SELECT generation FROM prompt_scope_controls WHERE scope_key='project:project'").get()).toEqual({ generation: version === 3 ? 7 : 1 });
  expect(db.query("SELECT generation,active FROM evaluation_evidence_scopes WHERE scope_key='project:project'").get()).toEqual({ generation: 1, active: 1 });
  initializeTeamSchema(db); expect(catalog(db)).toEqual(after);
});

test("native allocation failure rolls back version3 upgrade without partial queue objects", () => {
  const db = database(3), before = catalog(db);
  const pages = (db.query("PRAGMA page_count").get() as {page_count: number}).page_count;
  db.exec(`PRAGMA max_page_count=${pages}`);
  expect(() => initializeTeamSchema(db)).toThrow();
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
  expect(catalog(db)).toEqual(before);
});

test("native project deletion cascades review storage and preserves another project's frozen data", () => {
  const db = database(); initializeTeamSchema(db);
  for (const project of ["a", "b"]) {
    db.query("INSERT INTO projects(id,name,created_at) VALUES(?,?,1)").run(project, project);
    db.query("INSERT INTO team_review_queues VALUES(?,?,?,'{\"fields\":[]}',?,1,1)").run(project, "q", project, "a".repeat(64));
    db.query("INSERT INTO runs VALUES(?,? ,1,'completed','{}','','[]',1)").run(project, "r");
    db.query("INSERT INTO team_review_items VALUES(?,?,?,1,'r','',1,'draft','{}',?)").run(project, "q", "b".repeat(64), "c".repeat(64));
    db.query("INSERT INTO team_review_datasets VALUES(?,'d','Dataset',1,1)").run(project);
    db.query("INSERT INTO team_review_dataset_revisions VALUES(?,'d',1,'[]',?,1)").run(project, "d".repeat(64));
    db.query("INSERT INTO team_review_promotions VALUES(?,'q','retry','{}',?,'{}',?)").run(project, "e".repeat(64), "f".repeat(64));
  }
  db.exec("DELETE FROM projects WHERE id='a'");
  for (const table of tables) expect(db.query(`SELECT project_id FROM ${table}`).all()).toEqual([{ project_id: "b" }]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("current catalog drift and future versions refuse without changing stored objects", () => {
  const db = database(); initializeTeamSchema(db);
  db.exec("DROP INDEX team_review_items_state");
  const before = catalog(db); expect(() => initializeTeamSchema(db)).toThrow(); expect(catalog(db)).toEqual(before);
  db.exec("PRAGMA user_version=5"); expect(() => initializeTeamSchema(db)).toThrow();
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 5 }); expect(catalog(db)).toEqual(before);
});
