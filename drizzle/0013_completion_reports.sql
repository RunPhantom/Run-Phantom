CREATE TABLE evaluation_completion_reports (
  scope_key TEXT NOT NULL, scope_generation INTEGER NOT NULL CHECK(scope_generation>0),
  id TEXT NOT NULL CHECK(length(cast(id AS BLOB)) BETWEEN 1 AND 128),
  operation_key TEXT NOT NULL CHECK(length(cast(operation_key AS BLOB)) BETWEEN 1 AND 128),
  request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
  attachment_kind TEXT NOT NULL CHECK(attachment_kind IN ('run','inspection','experiment','check')),
  attachment_id TEXT NOT NULL CHECK(length(cast(attachment_id AS BLOB)) BETWEEN 1 AND 128),
  set_id TEXT NOT NULL CHECK(length(cast(set_id AS BLOB)) BETWEEN 1 AND 128), set_revision INTEGER NOT NULL CHECK(set_revision>0),
  detector_version TEXT NOT NULL CHECK(length(cast(detector_version AS BLOB)) BETWEEN 1 AND 64),
  summary_sha256 TEXT NOT NULL CHECK(length(summary_sha256)=64),
  payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64),
  payload_bytes INTEGER NOT NULL CHECK(payload_bytes BETWEEN 1 AND 65536),
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(scope_key,id),
  FOREIGN KEY(scope_key) REFERENCES evaluation_evidence_scopes(scope_key) ON DELETE CASCADE,
  FOREIGN KEY(scope_key,set_id,set_revision) REFERENCES evaluation_evidence_sets(scope_key,id,revision) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX completion_report_operation_unique ON evaluation_completion_reports(scope_key,scope_generation,operation_key);
--> statement-breakpoint
CREATE INDEX completion_report_attachment ON evaluation_completion_reports(scope_key,scope_generation,attachment_kind,attachment_id,created_at,id);
--> statement-breakpoint
CREATE TABLE evaluation_completion_payloads (
  scope_key TEXT NOT NULL, report_id TEXT NOT NULL,
  data TEXT NOT NULL CHECK(typeof(data)='text' AND length(cast(data AS BLOB)) BETWEEN 1 AND 65536),
  PRIMARY KEY(scope_key,report_id),
  FOREIGN KEY(scope_key,report_id) REFERENCES evaluation_completion_reports(scope_key,id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TRIGGER evaluation_completion_reports_immutable BEFORE UPDATE ON evaluation_completion_reports BEGIN SELECT RAISE(ABORT,'immutable completion report'); END;
--> statement-breakpoint
CREATE TRIGGER evaluation_completion_payloads_immutable BEFORE UPDATE ON evaluation_completion_payloads BEGIN SELECT RAISE(ABORT,'immutable completion payload'); END;
--> statement-breakpoint
CREATE TRIGGER evaluation_completion_source_removed AFTER INSERT ON evaluation_evidence_retention_events WHEN NEW.kind='normalized_removed' BEGIN
  DELETE FROM evaluation_completion_payloads WHERE scope_key=NEW.scope_key AND report_id IN
    (SELECT id FROM evaluation_completion_reports WHERE scope_key=NEW.scope_key AND set_id=NEW.set_id AND set_revision=NEW.revision);
END;
--> statement-breakpoint
CREATE TRIGGER evaluation_completion_generation_revoked AFTER UPDATE OF generation,active ON evaluation_evidence_scopes
  WHEN NEW.generation<>OLD.generation OR NEW.active=0 BEGIN
  DELETE FROM evaluation_completion_reports WHERE scope_key=NEW.scope_key;
END;
