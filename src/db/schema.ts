import { asc, desc, sql } from "drizzle-orm";
import { blob, check, foreignKey, index, integer, primaryKey, real, sqliteTable, sqliteView, text, unique } from "drizzle-orm/sqlite-core";

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    event_id: text("event_id"),
    name: text("name"),
    event_name: text("event_name"),
    display_name: text("display_name"),
    user_id: text("user_id"),
    convo_id: text("convo_id"),
    started_at: integer("started_at").notNull(),
    last_updated_at: integer("last_updated_at").notNull(),
    metadata: text("metadata"),
  },
  (table) => [
    index("idx_runs_last_updated").on(table.last_updated_at),
    index("idx_runs_event_id").on(table.event_id).where(sql`${table.event_id} IS NOT NULL`),
  ],
);

export const spans = sqliteTable(
  "spans",
  {
    // Not a standalone primary key: OTel only guarantees a SpanId is unique within
    // its trace, so identity here is (run_id, id). See the composite key below.
    id: text("id").notNull(),
    run_id: text("run_id").notNull().references(() => runs.id),
    parent_span_id: text("parent_span_id"),
    name: text("name").notNull(),
    span_type: text("span_type"),
    status: text("status").default("UNSET"),
    input_payload: text("input_payload"),
    output_payload: text("output_payload"),
    start_time_ms: real("start_time_ms"),
    end_time_ms: real("end_time_ms"),
    duration_ms: real("duration_ms"),
    model: text("model"),
    provider: text("provider"),
    input_tokens: integer("input_tokens"),
    output_tokens: integer("output_tokens"),
    attributes: text("attributes"),
    otlp_evidence: text("otlp_evidence"),
  },
  (table) => [
    primaryKey({ columns: [table.run_id, table.id] }),
    index("idx_spans_run_id").on(table.run_id),
    index("idx_spans_parent").on(table.parent_span_id),
  ],
);

export const live_events = sqliteTable(
  "live_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    trace_id: text("trace_id").notNull(),
    span_id: text("span_id"),
    type: text("type").notNull(),
    content: text("content"),
    timestamp: integer("timestamp").notNull(),
    metadata: text("metadata"),
  },
  (table) => [index("idx_live_trace").on(table.trace_id, table.timestamp)],
);

export const saved_run_cache = sqliteTable("saved_run_cache", {
  id: text("id").primaryKey(),
  data: text("data").notNull(),
});

export const saved_events = sqliteTable(
  "saved_events",
  {
    id: text("id").primaryKey(),
    event_name: text("event_name").notNull(),
    user_id: text("user_id"),
    convo_id: text("convo_id"),
    timestamp: text("timestamp").notNull(),
    user_input: text("user_input"),
    assistant_output: text("assistant_output"),
    signals: text("signals"),
    properties: text("properties"),
    saved_at: integer("saved_at").notNull(),
    summary: text("summary"),
    source: text("source"),
    folder: text("folder"),
  },
  (table) => [
    index("idx_saved_events_saved_at").on(desc(table.saved_at)),
    index("idx_saved_events_folder").on(table.folder),
  ],
);

export const saved_folders = sqliteTable("saved_folders", {
  name: text("name").primaryKey(),
  color: text("color").notNull(),
  created_at: integer("created_at").notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    active: integer("active").notNull(),
    created_at: integer("created_at").notNull(),
    deactivated_at: integer("deactivated_at"),
  },
  (table) => [index("idx_sessions_active_created").on(table.active, desc(table.created_at))],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    session_id: text("session_id").notNull().references(() => sessions.id),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    run_id: text("run_id"),
    state: text("state", { enum: ["pending", "delivered", "processing", "done", "error", "timeout"] }).notNull(),
    created_at: integer("created_at").notNull(),
    state_updated_at: integer("state_updated_at").notNull(),
  },
  (table) => [
    index("idx_messages_session_created").on(table.session_id, asc(table.created_at)),
    index("idx_messages_state").on(table.state, table.state_updated_at),
  ],
);

export const annotations = sqliteTable(
  "annotations",
  {
    id: text("id").primaryKey(),
    run_id: text("run_id").notNull(),
    span_id: text("span_id"),
    kind: text("kind", { enum: ["issue", "good", "note"] }).notNull(),
    note: text("note"),
    source: text("source", { enum: ["user", "claude-code", "codex"] }).notNull(),
    created_at: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_annotations_run").on(table.run_id),
    index("idx_annotations_span").on(table.span_id).where(sql`${table.span_id} IS NOT NULL`),
  ],
);

export const verification_flows = sqliteTable("verification_flows", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  origin: text("origin").notNull(),
  steps: text("steps").notNull(),
  created_at: integer("created_at").notNull(),
});

export const verification_reports = sqliteTable("verification_reports", {
  id: text("id").primaryKey(),
  session_id: text("session_id").notNull(),
  run_id: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
  flow_id: text("flow_id"),
  name: text("name").notNull(),
  status: text("status", { enum: ["pass", "fail", "inconclusive"] }).notNull(),
  reason: text("reason").notNull(),
  evidence: text("evidence").notNull(),
  context: text("context"),
  created_at: integer("created_at").notNull(),
}, (table) => [index("idx_verification_reports_run").on(table.run_id), index("idx_verification_reports_created").on(table.created_at)]);

export const verification_snapshots = sqliteTable("verification_snapshots", {
  id: text("id").primaryKey(),
  run_id: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
  session_id: text("session_id"),
  name: text("name").notNull(),
  origin: text("origin").notNull(),
  captured_at: integer("captured_at").notNull(),
  stored_at: integer("stored_at").notNull(),
  source: text("source", { enum: ["paired-sdk", "imported-evidence"] }).notNull(),
  content_sha256: text("content_sha256").notNull(),
  coverage_sha256: text("coverage_sha256").notNull(),
  payload: text("payload").notNull(),
}, (table) => [
  index("idx_verification_snapshots_stored").on(table.stored_at, table.id),
  index("idx_verification_snapshots_run").on(table.run_id, table.stored_at, table.id),
  check("verification_snapshots_payload_bound", sql`json_valid(${table.payload}) AND length(cast(${table.payload} AS blob)) <= 32768`),
  check("verification_snapshots_text_bound", sql`length(${table.id}) BETWEEN 1 AND 128 AND length(cast(${table.id} AS blob)) <= 512 AND length(${table.name}) BETWEEN 1 AND 128 AND length(cast(${table.name} AS blob)) <= 512 AND length(cast(${table.origin} AS blob)) BETWEEN 1 AND 2048 AND (${table.session_id} IS NULL OR length(cast(${table.session_id} AS blob)) BETWEEN 1 AND 512)`),
  check("verification_snapshots_time_bound", sql`typeof(${table.captured_at}) = 'integer' AND ${table.captured_at} BETWEEN 0 AND 9007199254740991 AND typeof(${table.stored_at}) = 'integer' AND ${table.stored_at} BETWEEN 0 AND 9007199254740991`),
  check("verification_snapshots_source_bound", sql`(${table.source} = 'paired-sdk' AND ${table.session_id} IS NOT NULL) OR (${table.source} = 'imported-evidence' AND ${table.session_id} IS NULL)`),
  check("verification_snapshots_digest_bound", sql`length(${table.content_sha256}) = 64 AND ${table.content_sha256} NOT GLOB '*[^0-9a-f]*' AND length(${table.coverage_sha256}) = 64 AND ${table.coverage_sha256} NOT GLOB '*[^0-9a-f]*'`),
]);

export const evaluation_datasets = sqliteTable("evaluation_datasets", {
  id: text("id").primaryKey(), name: text("name").notNull(), latest_version: integer("latest_version").notNull(),
  case_count: integer("case_count").notNull(), created_at: integer("created_at").notNull(),
});
export const evaluation_revisions = sqliteTable("evaluation_revisions", {
  dataset_id: text("dataset_id").notNull().references(() => evaluation_datasets.id, { onDelete: "cascade" }),
  version: integer("version").notNull(), hash: text("hash").notNull(), cases: text("cases").notNull(), created_at: integer("created_at").notNull(),
}, (table) => [primaryKey({ columns: [table.dataset_id, table.version] })]);
export const evaluation_experiments = sqliteTable("evaluation_experiments", {
  id: text("id").primaryKey(), status: text("status").notNull(), job_token: text("job_token").notNull(),
  completed_checks: integer("completed_checks").notNull(), data: text("data").notNull(), summary: text("summary").notNull(),
  created_at: integer("created_at").notNull(), completed_at: integer("completed_at"),
}, (table) => [index("idx_evaluation_experiments_status").on(table.status), index("idx_evaluation_experiments_created").on(table.created_at)]);
export const evaluation_reviews = sqliteTable("evaluation_reviews", {
  id: text("id").primaryKey(), experiment_id: text("experiment_id").notNull().references(() => evaluation_experiments.id, { onDelete: "cascade" }),
  case_id: text("case_id").notNull(), rating: text("rating").notNull(), note: text("note").notNull(), created_at: integer("created_at").notNull(),
}, (table) => [index("idx_evaluation_reviews_experiment").on(table.experiment_id)]);

export const runs_with_hints = sqliteView("runs_with_hints", {
  id: text("id"),
  event_id: text("event_id"),
  name: text("name"),
  event_name: text("event_name"),
  display_name: text("display_name"),
  user_id: text("user_id"),
  convo_id: text("convo_id"),
  started_at: integer("started_at"),
  last_updated_at: integer("last_updated_at"),
  metadata: text("metadata"),
  model: text("model"),
  finished: integer("finished"),
  span_count: integer("span_count"),
  live_event_count: integer("live_event_count"),
  payload_total_chars: integer("payload_total_chars"),
}).as(sql`
  SELECT
    r.*,
    (SELECT s.model FROM spans s WHERE s.run_id = r.id AND s.model IS NOT NULL LIMIT 1) AS model,
    (SELECT CASE WHEN COUNT(*) > 0
                  AND COUNT(*) = COUNT(CASE WHEN s.status IN ('OK','ERROR') THEN 1 END)
                 THEN 1 ELSE 0 END
     FROM spans s WHERE s.run_id = r.id AND s.parent_span_id IS NULL) AS finished,
    (SELECT COUNT(*) FROM spans s WHERE s.run_id = r.id) AS span_count,
    (SELECT COUNT(*) FROM live_events e WHERE e.trace_id = r.id) AS live_event_count,
    (SELECT COALESCE(SUM(LENGTH(COALESCE(s.input_payload, '')) + LENGTH(COALESCE(s.output_payload, ''))), 0)
     FROM spans s WHERE s.run_id = r.id) AS payload_total_chars
  FROM runs r
`);

export const evaluation_evidence_scopes = sqliteTable("evaluation_evidence_scopes", {
  scope_key: text("scope_key").primaryKey(),
  generation: integer("generation").notNull(), active: integer("active").notNull(),
}, table => [check("evidence_scope_generation", sql`${table.generation}>0`), check("evidence_scope_active", sql`${table.active} IN (0,1)`)]);

export const evaluation_evidence_inventory_heads = sqliteTable("evaluation_evidence_inventory_heads", {
  scope_key: text("scope_key").notNull().references(() => evaluation_evidence_scopes.scope_key, { onDelete: "cascade" }),
  id: text("id").notNull(), revision: integer("revision").notNull(),
}, table => [primaryKey({ columns: [table.scope_key, table.id] }), check("evidence_head_revision", sql`${table.revision}>=0`)]);

export const evaluation_evidence_inventories = sqliteTable("evaluation_evidence_inventories", {
  scope_key: text("scope_key").notNull(), id: text("id").notNull(), revision: integer("revision").notNull(),
  data: text("data").notNull(), digest: text("digest").notNull(), created_at: integer("created_at").notNull(),
}, table => [primaryKey({ columns: [table.scope_key, table.id, table.revision] }), check("evidence_inventory_revision", sql`${table.revision}>0`),
  foreignKey({ columns: [table.scope_key, table.id], foreignColumns: [evaluation_evidence_inventory_heads.scope_key, evaluation_evidence_inventory_heads.id] }).onDelete("cascade")]);

export const evaluation_evidence_jobs = sqliteTable("evaluation_evidence_jobs", {
  id: text("id").primaryKey(), scope_key: text("scope_key").notNull().references(() => evaluation_evidence_scopes.scope_key, { onDelete: "cascade" }),
  scope_generation: integer("scope_generation").notNull(), operation_key: text("operation_key").notNull(),
  request_digest: text("request_digest").notNull(), request_data: text("request_data").notNull(), inventory_data: text("inventory_data"),
  status: text("status", { enum: ["queued", "running", "completed", "cancelled", "failed"] }).notNull(), job_token: text("job_token").notNull(),
  admitted_at: integer("admitted_at").notNull(), deadline_at: integer("deadline_at").notNull(),
  reserved_raw_bytes: integer("reserved_raw_bytes").notNull(), reserved_normalized_bytes: integer("reserved_normalized_bytes").notNull(),
  set_id: text("set_id"), failure_code: text("failure_code"),
}, table => [unique("evidence_job_operation").on(table.scope_key, table.scope_generation, table.operation_key),
  index("evaluation_evidence_jobs_status").on(table.status), check("evidence_job_status", sql`${table.status} IN ('queued','running','completed','cancelled','failed')`),
  check("evidence_job_raw_reservation", sql`${table.reserved_raw_bytes}>=0`), check("evidence_job_normalized_reservation", sql`${table.reserved_normalized_bytes}>=0`)]);

export const evaluation_evidence_artifacts = sqliteTable("evaluation_evidence_artifacts", {
  scope_key: text("scope_key").notNull(), id: text("id").notNull(), job_id: text("job_id").notNull().references(() => evaluation_evidence_jobs.id, { onDelete: "cascade" }),
  source_id: text("source_id").notNull(), sha256: text("sha256").notNull(), byte_length: integer("byte_length").notNull(),
}, table => [primaryKey({ columns: [table.scope_key, table.id] }), unique("evidence_artifact_source").on(table.job_id, table.source_id),
  check("evidence_artifact_length", sql`${table.byte_length}>=0`)]);

export const evaluation_evidence_blobs = sqliteTable("evaluation_evidence_blobs", {
  scope_key: text("scope_key").notNull(), artifact_id: text("artifact_id").notNull(), bytes: blob("bytes", { mode: "buffer" }).notNull(),
}, table => [primaryKey({ columns: [table.scope_key, table.artifact_id] }),
  foreignKey({ columns: [table.scope_key, table.artifact_id], foreignColumns: [evaluation_evidence_artifacts.scope_key, evaluation_evidence_artifacts.id] }).onDelete("cascade")]);

export const evaluation_evidence_interpretations = sqliteTable("evaluation_evidence_interpretations", {
  scope_key: text("scope_key").notNull(), id: text("id").notNull(), artifact_id: text("artifact_id").notNull(), normalized_sha256: text("normalized_sha256").notNull(),
  parser_version: text("parser_version").notNull(), policy_version: text("policy_version").notNull(), configuration_sha256: text("configuration_sha256").notNull(), dialect: text("dialect").notNull(),
}, table => [primaryKey({ columns: [table.scope_key, table.id] }),
  foreignKey({ columns: [table.scope_key, table.artifact_id], foreignColumns: [evaluation_evidence_artifacts.scope_key, evaluation_evidence_artifacts.id] }).onDelete("cascade")]);

export const evaluation_evidence_payloads = sqliteTable("evaluation_evidence_payloads", {
  scope_key: text("scope_key").notNull(), interpretation_id: text("interpretation_id").notNull(), data: text("data").notNull(),
}, table => [primaryKey({ columns: [table.scope_key, table.interpretation_id] }),
  foreignKey({ columns: [table.scope_key, table.interpretation_id], foreignColumns: [evaluation_evidence_interpretations.scope_key, evaluation_evidence_interpretations.id] }).onDelete("cascade")]);

export const evaluation_evidence_sets = sqliteTable("evaluation_evidence_sets", {
  scope_key: text("scope_key").notNull(), id: text("id").notNull(), revision: integer("revision").notNull(),
  job_id: text("job_id").notNull().unique("evidence_set_job").references(() => evaluation_evidence_jobs.id, { onDelete: "cascade" }),
  data: text("data").notNull(), digest: text("digest").notNull(), created_at: integer("created_at").notNull(),
}, table => [primaryKey({ columns: [table.scope_key, table.id, table.revision] }), check("evidence_set_revision", sql`${table.revision}>0`)]);

export const evaluation_evidence_retention_events = sqliteTable("evaluation_evidence_retention_events", {
  id: text("id").primaryKey(), scope_key: text("scope_key").notNull().references(() => evaluation_evidence_scopes.scope_key, { onDelete: "cascade" }),
  set_id: text("set_id").notNull(), revision: integer("revision").notNull(), target_id: text("target_id").notNull(),
  kind: text("kind", { enum: ["raw_removed", "normalized_removed"] }).notNull(), actor_id: text("actor_id").notNull(), created_at: integer("created_at").notNull(),
}, table => [check("evidence_retention_kind", sql`${table.kind} IN ('raw_removed','normalized_removed')`)]);
