-- Additive producer-reported hook authority and source evidence.
CREATE TABLE coding_hook_owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  source_epoch TEXT NOT NULL CHECK (length(source_epoch) = 32 AND source_epoch NOT GLOB '*[^a-f0-9]*'),
  generation TEXT NOT NULL CHECK (length(generation) = 32 AND generation NOT GLOB '*[^a-f0-9]*'),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);
--> statement-breakpoint
CREATE TABLE coding_hook_installations (
  id TEXT PRIMARY KEY CHECK (length(id) = 32 AND id NOT GLOB '*[^a-f0-9]*'),
  owner_id INTEGER NOT NULL REFERENCES coding_hook_owner(id),
  generation TEXT NOT NULL CHECK (length(generation) = 32 AND generation NOT GLOB '*[^a-f0-9]*'),
  token_sha256 TEXT NOT NULL UNIQUE CHECK (length(token_sha256) = 64 AND token_sha256 NOT GLOB '*[^a-f0-9]*'),
  state TEXT NOT NULL CHECK (state IN ('active', 'disabled')),
  capture_mode TEXT NOT NULL CHECK (capture_mode IN ('metadata', 'full')),
  scope TEXT NOT NULL CHECK (scope IN ('global', 'local')),
  workspace TEXT CHECK (workspace IS NULL OR length(CAST(workspace AS BLOB)) BETWEEN 1 AND 4096),
  transcript_root TEXT NOT NULL CHECK (length(CAST(transcript_root AS BLOB)) BETWEEN 1 AND 4096),
  source_root_key TEXT NOT NULL CHECK (length(source_root_key) = 64 AND source_root_key NOT GLOB '*[^a-f0-9]*'),
  config_sha256 TEXT NOT NULL CHECK (length(config_sha256) = 64 AND config_sha256 NOT GLOB '*[^a-f0-9]*'),
  data TEXT NOT NULL CHECK (length(CAST(data AS BLOB)) <= 16384),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  CHECK ((scope = 'global' AND workspace IS NULL) OR (scope = 'local' AND workspace IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE coding_hook_sessions (
  source_key TEXT PRIMARY KEY CHECK (length(source_key) = 64 AND source_key NOT GLOB '*[^a-f0-9]*'),
  owner_id INTEGER NOT NULL REFERENCES coding_hook_owner(id),
  source_root_key TEXT NOT NULL CHECK (length(source_root_key) = 64 AND source_root_key NOT GLOB '*[^a-f0-9]*'),
  run_id TEXT NOT NULL UNIQUE CHECK (length(run_id) = 32 AND run_id NOT GLOB '*[^a-f0-9]*'),
  root_span_id TEXT NOT NULL CHECK (length(root_span_id) = 16 AND root_span_id NOT GLOB '*[^a-f0-9]*'),
  state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'unknown', 'suppressed')),
  incarnation_key TEXT CHECK (incarnation_key IS NULL OR (length(incarnation_key) = 64 AND incarnation_key NOT GLOB '*[^a-f0-9]*')),
  prefix_sha256 TEXT CHECK (prefix_sha256 IS NULL OR (length(prefix_sha256) = 64 AND prefix_sha256 NOT GLOB '*[^a-f0-9]*')),
  prefix_bytes INTEGER NOT NULL CHECK (prefix_bytes BETWEEN 0 AND 65536),
  source_cursor INTEGER NOT NULL CHECK (source_cursor BETWEEN 0 AND 8388608),
  observed_file_bytes INTEGER NOT NULL CHECK (observed_file_bytes BETWEEN 0 AND 9007199254740991),
  data TEXT NOT NULL CHECK (length(CAST(data AS BLOB)) <= 16384),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  CHECK ((prefix_bytes = 0 AND prefix_sha256 IS NULL) OR (prefix_bytes > 0 AND prefix_sha256 IS NOT NULL)),
  CHECK (state <> 'suppressed' OR (incarnation_key IS NULL AND prefix_sha256 IS NULL AND prefix_bytes = 0 AND source_cursor = 0 AND observed_file_bytes = 0 AND length(CAST(data AS BLOB)) <= 1024))
);
--> statement-breakpoint
CREATE INDEX idx_coding_hook_sessions_run ON coding_hook_sessions(run_id);
--> statement-breakpoint
CREATE TABLE coding_hook_entities (
  source_key TEXT NOT NULL REFERENCES coding_hook_sessions(source_key) ON DELETE CASCADE,
  entity_key TEXT NOT NULL CHECK (length(entity_key) = 64 AND entity_key NOT GLOB '*[^a-f0-9]*'),
  span_id TEXT NOT NULL CHECK (length(span_id) = 16 AND span_id NOT GLOB '*[^a-f0-9]*'),
  kind TEXT NOT NULL CHECK (kind IN ('session', 'prompt', 'tool', 'assistant', 'subagent', 'turn')),
  phase TEXT NOT NULL CHECK (phase IN ('pending', 'success', 'failure', 'interrupted', 'complete', 'unknown', 'conflict')),
  incarnation_key TEXT CHECK (incarnation_key IS NULL OR (length(incarnation_key) = 64 AND incarnation_key NOT GLOB '*[^a-f0-9]*')),
  source_offset INTEGER CHECK (source_offset IS NULL OR source_offset BETWEEN 0 AND 8388608),
  observation_sha256 TEXT NOT NULL CHECK (length(observation_sha256) = 64 AND observation_sha256 NOT GLOB '*[^a-f0-9]*'),
  projection_sha256 TEXT NOT NULL CHECK (length(projection_sha256) = 64 AND projection_sha256 NOT GLOB '*[^a-f0-9]*'),
  data TEXT NOT NULL CHECK (length(CAST(data AS BLOB)) <= 16384),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (source_key, entity_key),
  UNIQUE (source_key, span_id),
  CHECK ((source_offset IS NULL AND incarnation_key IS NULL) OR (source_offset IS NOT NULL AND incarnation_key IS NOT NULL))
);
--> statement-breakpoint
CREATE TRIGGER coding_hook_run_delete BEFORE DELETE ON runs BEGIN
  DELETE FROM coding_hook_entities WHERE source_key IN (SELECT source_key FROM coding_hook_sessions WHERE run_id = OLD.id);
  UPDATE coding_hook_sessions SET state='suppressed', incarnation_key=NULL, prefix_sha256=NULL,
    prefix_bytes=0, source_cursor=0, observed_file_bytes=0,
    data='{"capture":"suppressed","reason":"anchor_deleted"}'
    WHERE run_id=OLD.id AND state<>'suppressed';
END;
--> statement-breakpoint
CREATE TRIGGER coding_hook_span_delete BEFORE DELETE ON spans BEGIN
  DELETE FROM coding_hook_entities WHERE source_key IN (SELECT source_key FROM coding_hook_sessions WHERE run_id = OLD.run_id);
  UPDATE coding_hook_sessions SET state='suppressed', incarnation_key=NULL, prefix_sha256=NULL,
    prefix_bytes=0, source_cursor=0, observed_file_bytes=0,
    data='{"capture":"suppressed","reason":"anchor_replaced"}'
    WHERE run_id=OLD.run_id AND state<>'suppressed';
END;
