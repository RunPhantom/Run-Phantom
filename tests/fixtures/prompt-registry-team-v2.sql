-- Frozen qualified F06 Team version 2 schema at b2673ce; preservation fixture.

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
    

CREATE TABLE evaluation_evidence_scopes (
  scope_key TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK(generation>0), active INTEGER NOT NULL CHECK(active IN (0,1))
);
CREATE TABLE evaluation_evidence_inventory_heads (
  scope_key TEXT NOT NULL REFERENCES evaluation_evidence_scopes(scope_key) ON DELETE CASCADE,
  id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), PRIMARY KEY(scope_key,id)
);
CREATE TABLE evaluation_evidence_inventories (
  scope_key TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
  data TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(scope_key,id,revision),
  FOREIGN KEY(scope_key,id) REFERENCES evaluation_evidence_inventory_heads(scope_key,id) ON DELETE CASCADE
);
CREATE TABLE evaluation_evidence_jobs (
  id TEXT PRIMARY KEY, scope_key TEXT NOT NULL REFERENCES evaluation_evidence_scopes(scope_key) ON DELETE CASCADE,
  scope_generation INTEGER NOT NULL, operation_key TEXT NOT NULL, request_digest TEXT NOT NULL, request_data TEXT NOT NULL,
  inventory_data TEXT, status TEXT NOT NULL CHECK(status IN ('queued','running','completed','cancelled','failed')),
  job_token TEXT NOT NULL, admitted_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL,
  reserved_raw_bytes INTEGER NOT NULL CHECK(reserved_raw_bytes>=0), reserved_normalized_bytes INTEGER NOT NULL CHECK(reserved_normalized_bytes>=0),
  set_id TEXT, failure_code TEXT, UNIQUE(scope_key,scope_generation,operation_key)
);
CREATE INDEX evaluation_evidence_jobs_status ON evaluation_evidence_jobs(status);
CREATE TABLE evaluation_evidence_artifacts (
  scope_key TEXT NOT NULL, id TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES evaluation_evidence_jobs(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL, sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length>=0),
  PRIMARY KEY(scope_key,id), UNIQUE(job_id,source_id)
);
CREATE TABLE evaluation_evidence_blobs (
  scope_key TEXT NOT NULL, artifact_id TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(scope_key,artifact_id),
  FOREIGN KEY(scope_key,artifact_id) REFERENCES evaluation_evidence_artifacts(scope_key,id) ON DELETE CASCADE
);
CREATE TABLE evaluation_evidence_interpretations (
  scope_key TEXT NOT NULL, id TEXT NOT NULL, artifact_id TEXT NOT NULL, normalized_sha256 TEXT NOT NULL,
  parser_version TEXT NOT NULL, policy_version TEXT NOT NULL, configuration_sha256 TEXT NOT NULL, dialect TEXT NOT NULL,
  PRIMARY KEY(scope_key,id), FOREIGN KEY(scope_key,artifact_id) REFERENCES evaluation_evidence_artifacts(scope_key,id) ON DELETE CASCADE
);
CREATE TABLE evaluation_evidence_payloads (
  scope_key TEXT NOT NULL, interpretation_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope_key,interpretation_id),
  FOREIGN KEY(scope_key,interpretation_id) REFERENCES evaluation_evidence_interpretations(scope_key,id) ON DELETE CASCADE
);
CREATE TABLE evaluation_evidence_sets (
  scope_key TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
  job_id TEXT NOT NULL UNIQUE REFERENCES evaluation_evidence_jobs(id) ON DELETE CASCADE,
  data TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(scope_key,id,revision)
);
CREATE TABLE evaluation_evidence_retention_events (
  id TEXT PRIMARY KEY, scope_key TEXT NOT NULL REFERENCES evaluation_evidence_scopes(scope_key) ON DELETE CASCADE,
  set_id TEXT NOT NULL, revision INTEGER NOT NULL, target_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('raw_removed','normalized_removed')), actor_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TRIGGER evaluation_evidence_inventories_immutable BEFORE UPDATE ON evaluation_evidence_inventories BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;
CREATE TRIGGER evaluation_evidence_artifacts_immutable BEFORE UPDATE ON evaluation_evidence_artifacts BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;
CREATE TRIGGER evaluation_evidence_blobs_immutable BEFORE UPDATE ON evaluation_evidence_blobs BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;
CREATE TRIGGER evaluation_evidence_interpretations_immutable BEFORE UPDATE ON evaluation_evidence_interpretations BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;
CREATE TRIGGER evaluation_evidence_payloads_immutable BEFORE UPDATE ON evaluation_evidence_payloads BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;
CREATE TRIGGER evaluation_evidence_sets_immutable BEFORE UPDATE ON evaluation_evidence_sets BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;
CREATE TRIGGER evaluation_evidence_retention_events_immutable BEFORE UPDATE ON evaluation_evidence_retention_events BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;

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

PRAGMA user_version=2;
