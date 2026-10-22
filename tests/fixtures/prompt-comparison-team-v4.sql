CREATE TABLE accounts (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        is_owner INTEGER NOT NULL CHECK(is_owner IN (0,1)), created_at INTEGER NOT NULL
      );

CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        id TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
      );

CREATE TABLE checks (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, id TEXT NOT NULL,
        created_at INTEGER NOT NULL, summary TEXT NOT NULL CHECK(json_valid(summary)),
        data TEXT NOT NULL CHECK(json_valid(data)), report TEXT NOT NULL CHECK(json_valid(report)),
        byte_size INTEGER NOT NULL CHECK(byte_size>=0), PRIMARY KEY(project_id,id)
      );

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

CREATE TABLE evaluation_evidence_inventories (
  scope_key TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
  data TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(scope_key,id,revision),
  FOREIGN KEY(scope_key,id) REFERENCES evaluation_evidence_inventory_heads(scope_key,id) ON DELETE CASCADE
);

CREATE TABLE evaluation_evidence_inventory_heads (
  scope_key TEXT NOT NULL REFERENCES evaluation_evidence_scopes(scope_key) ON DELETE CASCADE,
  id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), PRIMARY KEY(scope_key,id)
);

CREATE TABLE evaluation_evidence_jobs (
  id TEXT PRIMARY KEY, scope_key TEXT NOT NULL REFERENCES evaluation_evidence_scopes(scope_key) ON DELETE CASCADE,
  scope_generation INTEGER NOT NULL, operation_key TEXT NOT NULL, request_digest TEXT NOT NULL, request_data TEXT NOT NULL,
  inventory_data TEXT, status TEXT NOT NULL CHECK(status IN ('queued','running','completed','cancelled','failed')),
  job_token TEXT NOT NULL, admitted_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL,
  reserved_raw_bytes INTEGER NOT NULL CHECK(reserved_raw_bytes>=0), reserved_normalized_bytes INTEGER NOT NULL CHECK(reserved_normalized_bytes>=0),
  set_id TEXT, failure_code TEXT, UNIQUE(scope_key,scope_generation,operation_key)
);

CREATE TABLE evaluation_evidence_payloads (
  scope_key TEXT NOT NULL, interpretation_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope_key,interpretation_id),
  FOREIGN KEY(scope_key,interpretation_id) REFERENCES evaluation_evidence_interpretations(scope_key,id) ON DELETE CASCADE
);

CREATE TABLE evaluation_evidence_retention_events (
  id TEXT PRIMARY KEY, scope_key TEXT NOT NULL REFERENCES evaluation_evidence_scopes(scope_key) ON DELETE CASCADE,
  set_id TEXT NOT NULL, revision INTEGER NOT NULL, target_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('raw_removed','normalized_removed')), actor_id TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE evaluation_evidence_scopes (
  scope_key TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK(generation>0), active INTEGER NOT NULL CHECK(active IN (0,1))
);

CREATE TABLE evaluation_evidence_sets (
  scope_key TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
  job_id TEXT NOT NULL UNIQUE REFERENCES evaluation_evidence_jobs(id) ON DELETE CASCADE,
  data TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(scope_key,id,revision)
);

CREATE TABLE ingest_keys (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        label TEXT NOT NULL, prefix TEXT NOT NULL, creator_id TEXT NOT NULL REFERENCES accounts(id),
        token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        last_used_at INTEGER
      );

CREATE TABLE invites (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')),
        issuer_id TEXT NOT NULL REFERENCES accounts(id), token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );

CREATE TABLE memberships (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')), joined_at INTEGER NOT NULL,
        PRIMARY KEY(project_id,account_id)
      );

CREATE TABLE notes (
        project_id TEXT NOT NULL, run_id TEXT NOT NULL, id TEXT NOT NULL, span_id TEXT,
        author_id TEXT NOT NULL REFERENCES accounts(id), created_at INTEGER NOT NULL,
        data TEXT NOT NULL CHECK(json_valid(data)), byte_size INTEGER NOT NULL CHECK(byte_size>=0),
        PRIMARY KEY(project_id,id),
        FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id) ON DELETE CASCADE,
        FOREIGN KEY(project_id,run_id,span_id) REFERENCES spans(project_id,run_id,id) ON DELETE CASCADE
      );

CREATE TABLE operational_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL,
        account_id TEXT, action TEXT NOT NULL, request_id TEXT NOT NULL
      );

CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL,
        evidence_bytes INTEGER NOT NULL DEFAULT 0 CHECK(evidence_bytes>=0),
        run_count INTEGER NOT NULL DEFAULT 0 CHECK(run_count>=0),
        span_count INTEGER NOT NULL DEFAULT 0 CHECK(span_count>=0),
        check_count INTEGER NOT NULL DEFAULT 0 CHECK(check_count>=0),
        audit_pruned INTEGER NOT NULL DEFAULT 0
      );

CREATE TABLE prompt_heads (
  scope_key TEXT NOT NULL REFERENCES evaluation_evidence_scopes(scope_key) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK(length(id)=36),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 32),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
  create_operation_key TEXT NOT NULL CHECK(length(create_operation_key)=36),
  create_request_digest TEXT NOT NULL CHECK(length(create_request_digest)=64),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
  PRIMARY KEY(scope_key,id)
);

CREATE TABLE prompt_revisions (
  scope_key TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 32),
  name TEXT NOT NULL CHECK(length(cast(name AS BLOB)) BETWEEN 1 AND 256),
  template TEXT NOT NULL CHECK(length(cast(template AS BLOB))<=32768),
  template_sha256 TEXT NOT NULL CHECK(length(template_sha256)=64),
  variable_names TEXT NOT NULL CHECK(json_valid(variable_names) AND length(cast(variable_names AS BLOB))<=4353),
  policy TEXT NOT NULL CHECK(policy='literal-v1'),
  operation_key TEXT NOT NULL CHECK(length(operation_key)=36),
  request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  PRIMARY KEY(scope_key,id,revision),
  FOREIGN KEY(scope_key,id) REFERENCES prompt_heads(scope_key,id) ON DELETE CASCADE
);

CREATE TABLE prompt_scope_controls (
  scope_key TEXT PRIMARY KEY NOT NULL REFERENCES evaluation_evidence_scopes(scope_key) ON DELETE CASCADE
    CHECK(length(cast(scope_key AS BLOB)) BETWEEN 1 AND 128),
  generation INTEGER NOT NULL DEFAULT 1
    CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991)
);

CREATE TABLE runs (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, id TEXT NOT NULL,
        started_at REAL, status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
        data TEXT NOT NULL CHECK(json_valid(data)), search_text TEXT NOT NULL, metadata TEXT NOT NULL CHECK(json_valid(metadata)), byte_size INTEGER NOT NULL CHECK(byte_size>=0),
        PRIMARY KEY(project_id,id)
      );

CREATE TABLE sessions (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64), created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, idle_expires_at INTEGER NOT NULL
      );

CREATE TABLE spans (
        project_id TEXT NOT NULL, run_id TEXT NOT NULL, id TEXT NOT NULL,
        name TEXT NOT NULL, model TEXT, provider TEXT, started_at REAL,
        data TEXT NOT NULL CHECK(json_valid(data)), byte_size INTEGER NOT NULL CHECK(byte_size>=0),
        PRIMARY KEY(project_id,run_id,id),
        FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id) ON DELETE CASCADE
      );

CREATE TABLE team_evidence_scopes (
  project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL UNIQUE REFERENCES evaluation_evidence_scopes(scope_key) ON DELETE CASCADE,
  CHECK(scope_key='project:'||project_id)
);

CREATE TABLE team_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE team_review_dataset_revisions (
 project_id TEXT NOT NULL, dataset_id TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 20),
 cases_json TEXT NOT NULL CHECK(json_valid(cases_json) AND length(CAST(cases_json AS BLOB))<=2097152),
 hash TEXT NOT NULL CHECK(length(hash)=64), created_at INTEGER NOT NULL,
 PRIMARY KEY(project_id,dataset_id,version),
 FOREIGN KEY(project_id,dataset_id) REFERENCES team_review_datasets(project_id,id) ON DELETE CASCADE
);

CREATE TABLE team_review_datasets (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, id TEXT NOT NULL,
 name TEXT NOT NULL CHECK(length(CAST(name AS BLOB))<=512),
 latest_version INTEGER NOT NULL CHECK(typeof(latest_version)='integer' AND latest_version BETWEEN 1 AND 20),
 created_at INTEGER NOT NULL, PRIMARY KEY(project_id,id)
);

CREATE TABLE team_review_items (
 project_id TEXT NOT NULL, queue_id TEXT NOT NULL, id TEXT NOT NULL CHECK(length(id)=64),
 ordinal INTEGER NOT NULL CHECK(typeof(ordinal)='integer' AND ordinal BETWEEN 1 AND 9007199254740991),
 source_run_id TEXT NOT NULL, source_span_key TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 state TEXT NOT NULL CHECK(state IN ('draft','approved','promoted')),
 data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB))<=98304),
 data_hash TEXT NOT NULL CHECK(length(data_hash)=64),
 PRIMARY KEY(project_id,queue_id,id), UNIQUE(project_id,queue_id,ordinal), UNIQUE(project_id,queue_id,source_run_id,source_span_key),
 FOREIGN KEY(project_id,queue_id) REFERENCES team_review_queues(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,source_run_id) REFERENCES runs(project_id,id) ON DELETE CASCADE
);

CREATE TABLE team_review_promotions (
 project_id TEXT NOT NULL, queue_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL, request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(CAST(request_json AS BLOB))<=16384),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(CAST(result_json AS BLOB))<=16384),
 result_hash TEXT NOT NULL CHECK(length(result_hash)=64),
 PRIMARY KEY(project_id,queue_id,idempotency_key),
 FOREIGN KEY(project_id,queue_id) REFERENCES team_review_queues(project_id,id) ON DELETE CASCADE
);

CREATE TABLE team_review_queues (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 id TEXT NOT NULL, name TEXT NOT NULL CHECK(length(CAST(name AS BLOB))<=512),
 schema_json TEXT NOT NULL CHECK(json_valid(schema_json) AND length(CAST(schema_json AS BLOB))<=8192),
 schema_hash TEXT NOT NULL CHECK(length(schema_hash)=64),
 next_ordinal INTEGER NOT NULL DEFAULT 1 CHECK(typeof(next_ordinal)='integer' AND next_ordinal BETWEEN 1 AND 9007199254740991),
 created_at INTEGER NOT NULL, PRIMARY KEY(project_id,id)
);

CREATE INDEX audit_project_created ON audit_events(project_id,created_at DESC,id DESC);

CREATE INDEX checks_project_created ON checks(project_id,created_at DESC,id DESC);

CREATE INDEX evaluation_evidence_jobs_status ON evaluation_evidence_jobs(status);

CREATE INDEX ingest_keys_project ON ingest_keys(project_id,created_at DESC,id DESC);

CREATE INDEX invites_project ON invites(project_id,created_at DESC,id DESC);

CREATE INDEX memberships_account ON memberships(account_id,project_id);

CREATE INDEX notes_project_run ON notes(project_id,run_id,created_at DESC,id DESC);

CREATE UNIQUE INDEX prompt_heads_create_operation_unique ON prompt_heads(scope_key,create_operation_key);

CREATE INDEX prompt_heads_scope ON prompt_heads(scope_key,deleted,updated_at DESC,id DESC);

CREATE UNIQUE INDEX prompt_revisions_operation_unique ON prompt_revisions(scope_key,operation_key);

CREATE INDEX runs_project_start ON runs(project_id,started_at DESC,id DESC);

CREATE INDEX runs_project_status_start ON runs(project_id,status,started_at DESC,id DESC);

CREATE INDEX sessions_account ON sessions(account_id);

CREATE INDEX spans_project_model_provider ON spans(project_id,model,provider,run_id);

CREATE INDEX spans_project_start ON spans(project_id,run_id,started_at,id);

CREATE INDEX team_review_datasets_order ON team_review_datasets(project_id,created_at DESC,id DESC);

CREATE INDEX team_review_items_state ON team_review_items(project_id,queue_id,state,ordinal,id);

CREATE INDEX team_review_queues_order ON team_review_queues(project_id,created_at DESC,id DESC);

CREATE TRIGGER evaluation_evidence_artifacts_immutable BEFORE UPDATE ON evaluation_evidence_artifacts BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;

CREATE TRIGGER evaluation_evidence_blobs_immutable BEFORE UPDATE ON evaluation_evidence_blobs BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;

CREATE TRIGGER evaluation_evidence_interpretations_immutable BEFORE UPDATE ON evaluation_evidence_interpretations BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;

CREATE TRIGGER evaluation_evidence_inventories_immutable BEFORE UPDATE ON evaluation_evidence_inventories BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;

CREATE TRIGGER evaluation_evidence_payloads_immutable BEFORE UPDATE ON evaluation_evidence_payloads BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;

CREATE TRIGGER evaluation_evidence_retention_events_immutable BEFORE UPDATE ON evaluation_evidence_retention_events BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;

CREATE TRIGGER evaluation_evidence_sets_immutable BEFORE UPDATE ON evaluation_evidence_sets BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;

CREATE TRIGGER prompt_revision_immutable BEFORE UPDATE ON prompt_revisions BEGIN SELECT RAISE(ABORT,'Prompt revisions are immutable'); END;

CREATE TRIGGER team_evidence_project_delete AFTER DELETE ON projects
BEGIN DELETE FROM evaluation_evidence_scopes WHERE scope_key='project:'||OLD.id; END;

CREATE TRIGGER team_evidence_project_insert AFTER INSERT ON projects
BEGIN
  INSERT INTO evaluation_evidence_scopes(scope_key,generation,active) VALUES('project:'||NEW.id,1,1);
  INSERT INTO team_evidence_scopes(project_id,scope_key) VALUES(NEW.id,'project:'||NEW.id);
END;

CREATE TRIGGER team_evidence_scope_insert BEFORE INSERT ON evaluation_evidence_scopes
WHEN typeof(NEW.generation)!='integer' OR NEW.generation<1 OR NEW.generation>9007199254740991
  OR NOT EXISTS(SELECT 1 FROM projects WHERE 'project:'||id=NEW.scope_key)
BEGIN SELECT RAISE(ABORT,'invalid project evidence scope'); END;

CREATE TRIGGER team_evidence_scope_update BEFORE UPDATE ON evaluation_evidence_scopes
WHEN NEW.scope_key!=OLD.scope_key OR typeof(NEW.generation)!='integer' OR NEW.generation<OLD.generation
  OR NEW.generation>9007199254740991
BEGIN SELECT RAISE(ABORT,'invalid project evidence generation'); END;
INSERT INTO team_meta VALUES ('initialized','0');
PRAGMA user_version=4;
