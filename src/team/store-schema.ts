import type { Database } from "bun:sqlite";
import { EVIDENCE_STORAGE_SQL } from "../evaluations/evidence-store";
import { TeamError } from "./errors";

export const TEAM_SCHEMA_VERSION = 2;

const TEAM_V1_SQL = `
      CREATE TABLE team_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO team_meta VALUES ('initialized','0');
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        is_owner INTEGER NOT NULL CHECK(is_owner IN (0,1)), created_at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64), created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, idle_expires_at INTEGER NOT NULL
      );
      CREATE INDEX sessions_account ON sessions(account_id);
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL,
        evidence_bytes INTEGER NOT NULL DEFAULT 0 CHECK(evidence_bytes>=0),
        run_count INTEGER NOT NULL DEFAULT 0 CHECK(run_count>=0),
        span_count INTEGER NOT NULL DEFAULT 0 CHECK(span_count>=0),
        check_count INTEGER NOT NULL DEFAULT 0 CHECK(check_count>=0),
        audit_pruned INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE memberships (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')), joined_at INTEGER NOT NULL,
        PRIMARY KEY(project_id,account_id)
      );
      CREATE INDEX memberships_account ON memberships(account_id,project_id);
      CREATE TABLE invites (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')),
        issuer_id TEXT NOT NULL REFERENCES accounts(id), token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX invites_project ON invites(project_id,created_at DESC,id DESC);
      CREATE TABLE ingest_keys (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        label TEXT NOT NULL, prefix TEXT NOT NULL, creator_id TEXT NOT NULL REFERENCES accounts(id),
        token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE INDEX ingest_keys_project ON ingest_keys(project_id,created_at DESC,id DESC);
      CREATE TABLE runs (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, id TEXT NOT NULL,
        started_at REAL, status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
        data TEXT NOT NULL CHECK(json_valid(data)), search_text TEXT NOT NULL, metadata TEXT NOT NULL CHECK(json_valid(metadata)), byte_size INTEGER NOT NULL CHECK(byte_size>=0),
        PRIMARY KEY(project_id,id)
      );
      CREATE INDEX runs_project_start ON runs(project_id,started_at DESC,id DESC);
      CREATE INDEX runs_project_status_start ON runs(project_id,status,started_at DESC,id DESC);
      CREATE TABLE spans (
        project_id TEXT NOT NULL, run_id TEXT NOT NULL, id TEXT NOT NULL,
        name TEXT NOT NULL, model TEXT, provider TEXT, started_at REAL,
        data TEXT NOT NULL CHECK(json_valid(data)), byte_size INTEGER NOT NULL CHECK(byte_size>=0),
        PRIMARY KEY(project_id,run_id,id),
        FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id) ON DELETE CASCADE
      );
      CREATE INDEX spans_project_model_provider ON spans(project_id,model,provider,run_id);
      CREATE INDEX spans_project_start ON spans(project_id,run_id,started_at,id);
      CREATE TABLE notes (
        project_id TEXT NOT NULL, run_id TEXT NOT NULL, id TEXT NOT NULL, span_id TEXT,
        author_id TEXT NOT NULL REFERENCES accounts(id), created_at INTEGER NOT NULL,
        data TEXT NOT NULL CHECK(json_valid(data)), byte_size INTEGER NOT NULL CHECK(byte_size>=0),
        PRIMARY KEY(project_id,id),
        FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id) ON DELETE CASCADE,
        FOREIGN KEY(project_id,run_id,span_id) REFERENCES spans(project_id,run_id,id) ON DELETE CASCADE
      );
      CREATE INDEX notes_project_run ON notes(project_id,run_id,created_at DESC,id DESC);
      CREATE TABLE checks (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, id TEXT NOT NULL,
        created_at INTEGER NOT NULL, summary TEXT NOT NULL CHECK(json_valid(summary)),
        data TEXT NOT NULL CHECK(json_valid(data)), report TEXT NOT NULL CHECK(json_valid(report)),
        byte_size INTEGER NOT NULL CHECK(byte_size>=0), PRIMARY KEY(project_id,id)
      );
      CREATE INDEX checks_project_created ON checks(project_id,created_at DESC,id DESC);
      CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        id TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
      );
      CREATE INDEX audit_project_created ON audit_events(project_id,created_at DESC,id DESC);
      CREATE TABLE operational_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL,
        account_id TEXT, action TEXT NOT NULL, request_id TEXT NOT NULL
      );
      PRAGMA user_version = 1;
`;

const TEAM_EVIDENCE_SQL = `${EVIDENCE_STORAGE_SQL}
CREATE TABLE team_evidence_scopes (
  project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL UNIQUE REFERENCES evaluation_evidence_scopes(scope_key) ON DELETE CASCADE,
  CHECK(scope_key='project:'||project_id)
);
CREATE TRIGGER team_evidence_scope_insert BEFORE INSERT ON evaluation_evidence_scopes
WHEN typeof(NEW.generation)!='integer' OR NEW.generation<1 OR NEW.generation>9007199254740991
  OR NOT EXISTS(SELECT 1 FROM projects WHERE 'project:'||id=NEW.scope_key)
BEGIN SELECT RAISE(ABORT,'invalid project evidence scope'); END;
CREATE TRIGGER team_evidence_scope_update BEFORE UPDATE ON evaluation_evidence_scopes
WHEN NEW.scope_key!=OLD.scope_key OR typeof(NEW.generation)!='integer' OR NEW.generation<OLD.generation
  OR NEW.generation>9007199254740991
BEGIN SELECT RAISE(ABORT,'invalid project evidence generation'); END;
CREATE TRIGGER team_evidence_project_insert AFTER INSERT ON projects
BEGIN
  INSERT INTO evaluation_evidence_scopes(scope_key,generation,active) VALUES('project:'||NEW.id,1,1);
  INSERT INTO team_evidence_scopes(project_id,scope_key) VALUES(NEW.id,'project:'||NEW.id);
END;
CREATE TRIGGER team_evidence_project_delete AFTER DELETE ON projects
BEGIN DELETE FROM evaluation_evidence_scopes WHERE scope_key='project:'||OLD.id; END;
`;

type SchemaObject = { name: string; type: string; sql: string };
const normalizedSql = (sql: string) => sql.replace(/\s+/g, " ").trim().replace(/;$/, "");
function expectedSchema(sql: string): Map<string, SchemaObject> {
  const objects = new Map<string, SchemaObject>();
  for (const match of sql.matchAll(/CREATE (TABLE|INDEX) (\w+) [\s\S]*?;/g)) {
    objects.set(match[2], { name: match[2], type: match[1].toLowerCase(), sql: normalizedSql(match[0]) });
  }
  for (const match of sql.matchAll(/CREATE TRIGGER (\w+) [\s\S]*?\bEND;/g)) {
    objects.set(match[1], { name: match[1], type: "trigger", sql: normalizedSql(match[0]) });
  }
  return objects;
}
const v1Schema = expectedSchema(TEAM_V1_SQL);
const v2Schema = expectedSchema(`${TEAM_V1_SQL}\n${TEAM_EVIDENCE_SQL}`);
function knownTeamSchema(db: Database, version: number): void {
  const expected = version === 1 ? v1Schema : v2Schema;
  const actual = db.query("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as SchemaObject[];
  if (actual.length !== expected.size || actual.some(row => {
    const object = expected.get(row.name);
    return !object || row.type !== object.type || typeof row.sql !== "string" || normalizedSql(row.sql) !== object.sql;
  })) throw new TeamError("conflict", "The selected database is not a supported team schema");
  const initialized = db.query("SELECT value FROM team_meta WHERE key='initialized'").get() as { value: string } | null;
  if (!initialized || !["0", "1"].includes(initialized.value)) throw new TeamError("conflict", "The selected database is not an initialized team database");
}

/** Only the Team migration coordinator installs evidence; request handlers never create tables. */
export function initializeTeamSchema(db: Database): void {
  db.transaction(() => {
    const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (![0, 1, TEAM_SCHEMA_VERSION].includes(version)) throw new TeamError("conflict", "Unsupported team database version");
    if (version === 0) {
      const objects = db.query("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
      if (objects.length) throw new TeamError("conflict", "The selected database is not an initialized team database");
    } else knownTeamSchema(db, version);
    if (version === TEAM_SCHEMA_VERSION) return;
    if ((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys !== 1) {
      throw new TeamError("conflict", "Team evidence storage requires foreign key enforcement");
    }
    if (version === 0) db.exec(TEAM_V1_SQL);
    db.exec(TEAM_EVIDENCE_SQL);
    db.exec("INSERT INTO evaluation_evidence_scopes(scope_key,generation,active) SELECT 'project:'||id,1,1 FROM projects; INSERT INTO team_evidence_scopes(project_id,scope_key) SELECT id,'project:'||id FROM projects; PRAGMA user_version=2;");
  }).immediate();
}
