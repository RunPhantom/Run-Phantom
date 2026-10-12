-- PROPOSAL ONLY. Migration ordinal/timestamp reserved by the coordinator.
-- Additive, no existing table rebuild and no foreign-key pragma changes.
CREATE TABLE review_queues (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 128),
  schema_json TEXT NOT NULL CHECK(length(CAST(schema_json AS BLOB)) <= 8192),
  schema_hash TEXT NOT NULL CHECK(length(schema_hash) = 64),
  next_ordinal INTEGER NOT NULL DEFAULT 1 CHECK(next_ordinal >= 1),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
);
--> statement-breakpoint
CREATE INDEX review_queues_created ON review_queues(created_at, id);
--> statement-breakpoint
CREATE TABLE review_queue_items (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) = 64),
  queue_id TEXT NOT NULL REFERENCES review_queues(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 1),
  source_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  source_span_key TEXT NOT NULL CHECK(length(source_span_key) <= 128),
  source_json TEXT NOT NULL CHECK(length(CAST(source_json AS BLOB)) <= 49152),
  source_hash TEXT NOT NULL CHECK(length(source_hash) = 64),
  draft_json TEXT NOT NULL CHECK(length(CAST(draft_json AS BLOB)) <= 32768),
  draft_hash TEXT NOT NULL CHECK(length(draft_hash) = 64),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','approved','promoted')),
  approved_hash TEXT CHECK(approved_hash IS NULL OR length(approved_hash) = 64),
  approved_at INTEGER CHECK(approved_at IS NULL OR approved_at >= 0),
  review_source TEXT CHECK(review_source IS NULL OR review_source = 'localOperator'),
  last_mutation_id TEXT CHECK(last_mutation_id IS NULL OR length(last_mutation_id) BETWEEN 1 AND 128),
  last_mutation_hash TEXT CHECK(last_mutation_hash IS NULL OR length(last_mutation_hash) = 64),
  promoted_dataset_id TEXT,
  promoted_dataset_version INTEGER CHECK(promoted_dataset_version IS NULL OR promoted_dataset_version >= 1),
  promoted_case_id TEXT,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  CHECK((state = 'draft' AND approved_hash IS NULL AND approved_at IS NULL AND review_source IS NULL)
    OR (state IN ('approved','promoted') AND approved_hash IS NOT NULL AND approved_at IS NOT NULL AND review_source = 'localOperator')),
  CHECK((state != 'promoted' AND promoted_dataset_id IS NULL AND promoted_dataset_version IS NULL AND promoted_case_id IS NULL)
    OR (state = 'promoted' AND promoted_dataset_id IS NOT NULL AND promoted_dataset_version IS NOT NULL AND promoted_case_id IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX review_queue_items_ordinal_unique ON review_queue_items(queue_id, ordinal);
--> statement-breakpoint
CREATE UNIQUE INDEX review_queue_items_source_unique ON review_queue_items(queue_id, source_run_id, source_span_key);
--> statement-breakpoint
CREATE INDEX review_queue_items_window ON review_queue_items(queue_id, ordinal, id);
--> statement-breakpoint
CREATE INDEX review_queue_items_state ON review_queue_items(queue_id, state, ordinal, id);
--> statement-breakpoint
CREATE INDEX review_queue_items_source ON review_queue_items(source_run_id);
--> statement-breakpoint
CREATE TABLE review_queue_promotions (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) = 64),
  queue_id TEXT NOT NULL REFERENCES review_queues(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
  request_json TEXT NOT NULL CHECK(length(CAST(request_json AS BLOB)) <= 16384),
  dataset_id TEXT NOT NULL,
  dataset_version INTEGER NOT NULL CHECK(dataset_version >= 1),
  dataset_hash TEXT NOT NULL CHECK(length(dataset_hash) = 64),
  result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB)) <= 16384),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  FOREIGN KEY(dataset_id, dataset_version) REFERENCES evaluation_revisions(dataset_id, version) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX review_queue_promotions_key_unique ON review_queue_promotions(queue_id, idempotency_key);
--> statement-breakpoint
CREATE INDEX review_queue_promotions_dataset ON review_queue_promotions(dataset_id, dataset_version);
