import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamError } from "../src/team/errors";
import { initializeTeamSchema, TEAM_SCHEMA_VERSION } from "../src/team/store-schema";
import { TeamStore } from "../src/team/store";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function connection(path = ":memory:") {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA foreign_keys=ON");
  cleanups.push(() => db.close());
  return db;
}
const oldSql = readFileSync(join(import.meta.dir, "fixtures/team-schema-v1.sql"), "utf8");
function snapshot(db: Database) {
  const names = (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name);
  return Object.fromEntries(names.map(name => [name, db.query(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}
function scope(db: Database, id: string) {
  return db.query("SELECT scope_key,generation,active FROM evaluation_evidence_scopes WHERE scope_key=?").get(`project:${id}`);
}

test("fresh Team initialization creates only existing-project evidence scopes and enforces safe generations", () => {
  const db = connection(); initializeTeamSchema(db);
  expect(TEAM_SCHEMA_VERSION).toBe(2);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
  expect(db.query("SELECT * FROM evaluation_evidence_scopes").all()).toEqual([]);
  db.query("INSERT INTO projects(id,name,created_at) VALUES(?,?,?)").run("project-a", "A", 1);
  db.query("INSERT INTO projects(id,name,created_at) VALUES(?,?,?)").run("project-b", "B", 2);
  expect(scope(db, "project-a")).toEqual({ scope_key: "project:project-a", generation: 1, active: 1 });
  expect(db.query("SELECT * FROM team_evidence_scopes ORDER BY project_id").all()).toEqual([
    { project_id: "project-a", scope_key: "project:project-a" }, { project_id: "project-b", scope_key: "project:project-b" },
  ]);
  expect(() => db.exec("INSERT INTO evaluation_evidence_scopes VALUES('local:local',1,1)")).toThrow();
  expect(() => db.exec("INSERT INTO evaluation_evidence_scopes VALUES('project:missing',1,1)")).toThrow();
  expect(() => db.exec("INSERT INTO team_evidence_scopes VALUES(NULL,'project:project-a')")).toThrow();
  expect(() => db.exec("UPDATE team_evidence_scopes SET project_id='project-b' WHERE project_id='project-a'")).toThrow();
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => db.query("UPDATE evaluation_evidence_scopes SET generation=? WHERE scope_key='project:project-a'").run(value)).toThrow();
  }
  db.exec("UPDATE evaluation_evidence_scopes SET generation=2 WHERE scope_key='project:project-a'");
  expect(() => db.exec("UPDATE evaluation_evidence_scopes SET generation=1 WHERE scope_key='project:project-a'")).toThrow();
  expect(() => db.exec("UPDATE evaluation_evidence_scopes SET scope_key='project:project-b' WHERE scope_key='project:project-a'")).toThrow();
  expect(scope(db, "project-b")).toEqual({ scope_key: "project:project-b", generation: 1, active: 1 });
});

test("genuine populated v1 Team rows remain exact through migration and two TeamStore boots", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-team-evidence-upgrade-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "team.sqlite");
  const db = new Database(path, { create: true, strict: true }); db.exec("PRAGMA foreign_keys=ON");
  try {
    db.exec(oldSql);
    db.exec("INSERT INTO accounts VALUES('owner','owner@example.test','old-hash',1,1); UPDATE team_meta SET value='1' WHERE key='initialized'; INSERT INTO projects(id,name,created_at,evidence_bytes,run_count,span_count,check_count) VALUES('old-project','Preserved',1,321,1,1,1); INSERT INTO memberships VALUES('old-project','owner','admin',1)");
    const captured = JSON.stringify({ input: "Describe the result of this checkout.", output: '{"status":"paid"}', failed: true });
    db.query("INSERT INTO runs VALUES('old-project','run',1,'failed',?,'original','{}',123)").run(captured);
    db.query("INSERT INTO spans VALUES('old-project','run','span','agent',NULL,NULL,1,?,123)").run(captured);
    db.query("INSERT INTO checks VALUES('old-project','check',1,'{}',?,?,75)").run(captured, captured);
    const before = snapshot(db);
    db.close();
    for (let boot = 0; boot < 2; boot++) {
      const store = new TeamStore(path); store.close();
      const observed = new Database(path, { readonly: true, strict: true });
      try {
        expect(observed.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
        const after = snapshot(observed);
        for (const [table, rows] of Object.entries(before)) expect(after[table]).toEqual(rows);
        expect(scope(observed, "old-project")).toEqual({ scope_key: "project:old-project", generation: 1, active: 1 });
        expect(observed.query("SELECT * FROM team_evidence_scopes").all()).toEqual([{ project_id: "old-project", scope_key: "project:old-project" }]);
      } finally { observed.close(); }
    }
  } finally { db.close(); }
});

test("project deletion cascades owned evidence without altering a different project or captured accounting", () => {
  const db = connection(); initializeTeamSchema(db);
  for (const id of ["a", "b"]) db.query("INSERT INTO projects(id,name,created_at,evidence_bytes) VALUES(?,?,1,789)").run(id, id);
  db.exec("INSERT INTO evaluation_evidence_inventory_heads VALUES('project:a','inventory',0); INSERT INTO evaluation_evidence_inventory_heads VALUES('project:b','inventory',0)");
  db.exec("DELETE FROM projects WHERE id='a'");
  expect(scope(db, "a")).toBeNull();
  expect(db.query("SELECT * FROM team_evidence_scopes").all()).toEqual([{ project_id: "b", scope_key: "project:b" }]);
  expect(db.query("SELECT * FROM evaluation_evidence_inventory_heads").all()).toEqual([{ scope_key: "project:b", id: "inventory", revision: 0 }]);
  expect(db.query("SELECT evidence_bytes FROM projects WHERE id='b'").get()).toEqual({ evidence_bytes: 789 });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("unknown, future, partial and non-Team v1 databases refuse before any mutation", () => {
  for (const kind of ["future", "local", "partial", "unknown-zero"] as const) {
    const db = connection();
    if (kind === "future") { db.exec(oldSql); db.exec("PRAGMA user_version=999"); }
    else if (kind === "partial") { db.exec(oldSql); db.exec("DROP TABLE spans"); }
    else db.exec(`CREATE TABLE protected_payload(value TEXT); INSERT INTO protected_payload VALUES('original'); PRAGMA user_version=${kind === "local" ? 1 : 0}`);
    const version = db.query("PRAGMA user_version").get(), schema = db.query("SELECT * FROM sqlite_master ORDER BY name").all(), before = snapshot(db);
    expect(() => initializeTeamSchema(db)).toThrow(TeamError);
    expect(db.query("PRAGMA user_version").get()).toEqual(version);
    expect(db.query("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(schema);
    expect(snapshot(db)).toEqual(before);
  }
});

test("failed v1 evidence migration rolls back the entire upgrade and original rows", () => {
  const db = connection(); db.exec(oldSql);
  db.exec("INSERT INTO projects(id,name,created_at) VALUES('existing','Existing',1); CREATE TABLE evaluation_evidence_sets(protected TEXT); INSERT INTO evaluation_evidence_sets VALUES('original')");
  const before = snapshot(db), schema = db.query("SELECT * FROM sqlite_master ORDER BY name").all();
  expect(() => initializeTeamSchema(db)).toThrow();
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
  expect(snapshot(db)).toEqual(before);
  expect(db.query("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(schema);
});

test("an altered v2 schema refuses reopening without changing the saved generation or project", () => {
  const db = connection(); initializeTeamSchema(db);
  db.exec("INSERT INTO projects(id,name,created_at) VALUES('saved','Saved',1); UPDATE evaluation_evidence_scopes SET generation=3 WHERE scope_key='project:saved'; DROP TRIGGER evaluation_evidence_sets_immutable");
  const before = snapshot(db), schema = db.query("SELECT * FROM sqlite_master ORDER BY name").all();
  expect(() => initializeTeamSchema(db)).toThrow(TeamError);
  expect(snapshot(db)).toEqual(before);
  expect(db.query("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(schema);
  expect(scope(db, "saved")).toEqual({ scope_key: "project:saved", generation: 3, active: 1 });
});
