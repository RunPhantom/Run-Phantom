CREATE TABLE evaluation_finding_mappings (
  scope_key TEXT NOT NULL REFERENCES evaluation_evidence_scopes(scope_key) ON DELETE CASCADE,
  scope_generation INTEGER NOT NULL CHECK(scope_generation>0), id TEXT NOT NULL,
  baseline_set TEXT NOT NULL, baseline_revision INTEGER NOT NULL, candidate_set TEXT NOT NULL, candidate_revision INTEGER NOT NULL,
  data TEXT NOT NULL CHECK(length(cast(data AS BLOB))<=4194304), digest TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(scope_key,id),
  FOREIGN KEY(scope_key,baseline_set,baseline_revision) REFERENCES evaluation_evidence_sets(scope_key,id,revision) ON DELETE CASCADE,
  FOREIGN KEY(scope_key,candidate_set,candidate_revision) REFERENCES evaluation_evidence_sets(scope_key,id,revision) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX finding_mapping_scope ON evaluation_finding_mappings(scope_key,scope_generation,created_at);
--> statement-breakpoint
CREATE TABLE evaluation_finding_comparisons (
  scope_key TEXT NOT NULL REFERENCES evaluation_evidence_scopes(scope_key) ON DELETE CASCADE,
  scope_generation INTEGER NOT NULL CHECK(scope_generation>0), id TEXT NOT NULL, operation_key TEXT NOT NULL, request_digest TEXT NOT NULL,
  baseline_set TEXT NOT NULL, baseline_revision INTEGER NOT NULL, candidate_set TEXT NOT NULL, candidate_revision INTEGER NOT NULL,
  baseline_attachment_kind TEXT NOT NULL, baseline_attachment_id TEXT NOT NULL, candidate_attachment_kind TEXT NOT NULL, candidate_attachment_id TEXT NOT NULL,
  mapping_id TEXT, data TEXT NOT NULL CHECK(length(cast(data AS BLOB))<=4194304), digest TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(scope_key,id), UNIQUE(scope_key,scope_generation,operation_key),
  FOREIGN KEY(scope_key,baseline_set,baseline_revision) REFERENCES evaluation_evidence_sets(scope_key,id,revision) ON DELETE CASCADE,
  FOREIGN KEY(scope_key,candidate_set,candidate_revision) REFERENCES evaluation_evidence_sets(scope_key,id,revision) ON DELETE CASCADE,
  FOREIGN KEY(scope_key,mapping_id) REFERENCES evaluation_finding_mappings(scope_key,id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX finding_comparison_scope ON evaluation_finding_comparisons(scope_key,scope_generation,created_at);
--> statement-breakpoint
CREATE INDEX finding_comparison_baseline_attachment ON evaluation_finding_comparisons(scope_key,scope_generation,baseline_attachment_kind,baseline_attachment_id,created_at);
--> statement-breakpoint
CREATE INDEX finding_comparison_candidate_attachment ON evaluation_finding_comparisons(scope_key,scope_generation,candidate_attachment_kind,candidate_attachment_id,created_at);
--> statement-breakpoint
CREATE TRIGGER evaluation_finding_mappings_immutable BEFORE UPDATE ON evaluation_finding_mappings BEGIN SELECT RAISE(ABORT,'immutable finding review'); END;
--> statement-breakpoint
CREATE TRIGGER evaluation_finding_comparisons_immutable BEFORE UPDATE ON evaluation_finding_comparisons BEGIN SELECT RAISE(ABORT,'immutable finding comparison'); END;
--> statement-breakpoint
CREATE TRIGGER evaluation_finding_generation_revoked AFTER UPDATE OF generation ON evaluation_evidence_scopes
WHEN OLD.generation!=NEW.generation BEGIN
  DELETE FROM evaluation_finding_comparisons WHERE scope_key=NEW.scope_key;
  DELETE FROM evaluation_finding_mappings WHERE scope_key=NEW.scope_key;
END;
