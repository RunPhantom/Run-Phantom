/** Project review storage is installed only by the strict Team migration coordinator. */
export const TEAM_REVIEW_STORAGE_SQL = `
CREATE TABLE team_review_queues (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 id TEXT NOT NULL, name TEXT NOT NULL CHECK(length(CAST(name AS BLOB))<=512),
 schema_json TEXT NOT NULL CHECK(json_valid(schema_json) AND length(CAST(schema_json AS BLOB))<=8192),
 schema_hash TEXT NOT NULL CHECK(length(schema_hash)=64),
 next_ordinal INTEGER NOT NULL DEFAULT 1 CHECK(typeof(next_ordinal)='integer' AND next_ordinal BETWEEN 1 AND 9007199254740991),
 created_at INTEGER NOT NULL, PRIMARY KEY(project_id,id)
);
CREATE INDEX team_review_queues_order ON team_review_queues(project_id,created_at DESC,id DESC);
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
CREATE INDEX team_review_items_state ON team_review_items(project_id,queue_id,state,ordinal,id);
CREATE TABLE team_review_datasets (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, id TEXT NOT NULL,
 name TEXT NOT NULL CHECK(length(CAST(name AS BLOB))<=512),
 latest_version INTEGER NOT NULL CHECK(typeof(latest_version)='integer' AND latest_version BETWEEN 1 AND 20),
 created_at INTEGER NOT NULL, PRIMARY KEY(project_id,id)
);
CREATE INDEX team_review_datasets_order ON team_review_datasets(project_id,created_at DESC,id DESC);
CREATE TABLE team_review_dataset_revisions (
 project_id TEXT NOT NULL, dataset_id TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 20),
 cases_json TEXT NOT NULL CHECK(json_valid(cases_json) AND length(CAST(cases_json AS BLOB))<=2097152),
 hash TEXT NOT NULL CHECK(length(hash)=64), created_at INTEGER NOT NULL,
 PRIMARY KEY(project_id,dataset_id,version),
 FOREIGN KEY(project_id,dataset_id) REFERENCES team_review_datasets(project_id,id) ON DELETE CASCADE
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
`;
