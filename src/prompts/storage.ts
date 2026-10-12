/** Reviewed additive schema; only migration coordinators install these tables. */
export const PROMPT_STORAGE_SQL = `
CREATE TABLE prompt_scope_controls (
  scope_key TEXT PRIMARY KEY NOT NULL REFERENCES evaluation_evidence_scopes(scope_key) ON DELETE CASCADE
    CHECK(length(cast(scope_key AS BLOB)) BETWEEN 1 AND 128),
  generation INTEGER NOT NULL DEFAULT 1
    CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991)
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
CREATE UNIQUE INDEX prompt_heads_create_operation_unique ON prompt_heads(scope_key,create_operation_key);
CREATE INDEX prompt_heads_scope ON prompt_heads(scope_key,deleted,updated_at DESC,id DESC);
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
CREATE UNIQUE INDEX prompt_revisions_operation_unique ON prompt_revisions(scope_key,operation_key);
CREATE TRIGGER prompt_revision_immutable BEFORE UPDATE ON prompt_revisions BEGIN SELECT RAISE(ABORT,'Prompt revisions are immutable'); END;
`;
