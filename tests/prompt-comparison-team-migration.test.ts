import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initializeTeamSchema, TEAM_SCHEMA_VERSION } from "../src/team/store-schema";
const connections: Database[] = [];
afterEach(() => { for (const db of connections.splice(0)) db.close(); });
function prior() { const db = new Database(":memory:", { strict: true }); connections.push(db); db.exec("PRAGMA foreign_keys=ON"); db.exec(readFileSync(join(import.meta.dir, "fixtures/prompt-comparison-team-v4.sql"), "utf8")); return db; }
function witness(db: Database) {
  const objects = db.query("SELECT name,type,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all() as { name: string; type: string }[];
  const tables = Object.fromEntries(objects.filter(row => row.type === "table").map(row => [row.name, db.query(`SELECT * FROM "${row.name}" ORDER BY ${db.query(`PRAGMA table_info("${row.name}")`).all().map((_value, index) => index + 1).join(",")}`).all()]));
  return { objects, tables };
}
test("real qualified Team4 upgrades atomically to Team5 while all62 oldschema objects and every old row remain exact", () => {
  const db = prior(); db.exec("INSERT INTO accounts VALUES('owner','owner@example.test','old-hash',1,1); INSERT INTO projects(id,name,created_at) VALUES('project','Frozen β',1); INSERT INTO memberships VALUES('project','owner','admin',1); INSERT INTO prompt_scope_controls VALUES('project:project',7)");
  db.exec("INSERT INTO team_review_queues VALUES('project','q','Qualified queue','{\"fields\":[]}','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,1)");
  const before = witness(db); expect(before.objects).toHaveLength(62); initializeTeamSchema(db);
  expect(TEAM_SCHEMA_VERSION).toBe(5); expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 5 }); const after = witness(db);
  for (const object of before.objects) expect(after.objects.find(row => row.name === object.name)).toEqual(object);
  for (const [table, rows] of Object.entries(before.tables)) expect(after.tables[table]).toEqual(rows);
  expect(db.query("SELECT * FROM comparison_scope_controls").all()).toEqual([{ scope_key: "project:project", generation: 1 }]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]); expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  initializeTeamSchema(db); expect(witness(db)).toEqual(after);
});
test("a real Team4 allocation failure rolls back every newobject and leaves version4 history exactly readable", () => {
  const db = prior(), before = witness(db), pages = (db.query("PRAGMA page_count").get() as { page_count: number }).page_count;
  db.exec(`PRAGMA max_page_count=${pages}`); expect(() => initializeTeamSchema(db)).toThrow(); expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 4 }); expect(witness(db)).toEqual(before);
});
test("Team5 refuses schema drift and future versions without installing or repairing caller storage", () => {
  const db = prior(); initializeTeamSchema(db); db.exec("DROP INDEX prompt_comparisons_operation_unique"); const before = witness(db);
  expect(() => initializeTeamSchema(db)).toThrow(); expect(witness(db)).toEqual(before); db.exec("PRAGMA user_version=6");
  expect(() => initializeTeamSchema(db)).toThrow(); expect(witness(db)).toEqual(before);
});
