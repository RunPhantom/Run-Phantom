import { asc, desc, sql } from "drizzle-orm";
import { blob, check, foreignKey, index, integer, primaryKey, real, sqliteTable, sqliteView, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";

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

export const evaluation_finding_mappings = sqliteTable("evaluation_finding_mappings", {
  scope_key: text("scope_key").notNull().references(() => evaluation_evidence_scopes.scope_key, { onDelete: "cascade" }),
  scope_generation: integer("scope_generation").notNull(), id: text("id").notNull(),
  baseline_set: text("baseline_set").notNull(), baseline_revision: integer("baseline_revision").notNull(),
  candidate_set: text("candidate_set").notNull(), candidate_revision: integer("candidate_revision").notNull(),
  data: text("data").notNull(), digest: text("digest").notNull(), created_at: integer("created_at").notNull(),
}, table => [primaryKey({ columns: [table.scope_key, table.id] }),
  check("finding_mapping_generation", sql`${table.scope_generation}>0`), check("finding_mapping_bytes", sql`length(cast(${table.data} AS BLOB))<=4194304`),
  index("finding_mapping_scope").on(table.scope_key, table.scope_generation, table.created_at),
  foreignKey({ columns: [table.scope_key, table.baseline_set, table.baseline_revision], foreignColumns: [evaluation_evidence_sets.scope_key, evaluation_evidence_sets.id, evaluation_evidence_sets.revision] }).onDelete("cascade"),
  foreignKey({ columns: [table.scope_key, table.candidate_set, table.candidate_revision], foreignColumns: [evaluation_evidence_sets.scope_key, evaluation_evidence_sets.id, evaluation_evidence_sets.revision] }).onDelete("cascade")]);

export const evaluation_finding_comparisons = sqliteTable("evaluation_finding_comparisons", {
  scope_key: text("scope_key").notNull().references(() => evaluation_evidence_scopes.scope_key, { onDelete: "cascade" }),
  scope_generation: integer("scope_generation").notNull(), id: text("id").notNull(),
  operation_key: text("operation_key").notNull(), request_digest: text("request_digest").notNull(),
  baseline_set: text("baseline_set").notNull(), baseline_revision: integer("baseline_revision").notNull(),
  candidate_set: text("candidate_set").notNull(), candidate_revision: integer("candidate_revision").notNull(),
  baseline_attachment_kind: text("baseline_attachment_kind").notNull(), baseline_attachment_id: text("baseline_attachment_id").notNull(),
  candidate_attachment_kind: text("candidate_attachment_kind").notNull(), candidate_attachment_id: text("candidate_attachment_id").notNull(),
  mapping_id: text("mapping_id"), data: text("data").notNull(), digest: text("digest").notNull(), created_at: integer("created_at").notNull(),
}, table => [primaryKey({ columns: [table.scope_key, table.id] }), unique("finding_comparison_operation").on(table.scope_key, table.scope_generation, table.operation_key),
  check("finding_comparison_generation", sql`${table.scope_generation}>0`), check("finding_comparison_bytes", sql`length(cast(${table.data} AS BLOB))<=4194304`),
  index("finding_comparison_scope").on(table.scope_key, table.scope_generation, table.created_at),
  index("finding_comparison_baseline_attachment").on(table.scope_key, table.scope_generation, table.baseline_attachment_kind, table.baseline_attachment_id, table.created_at),
  index("finding_comparison_candidate_attachment").on(table.scope_key, table.scope_generation, table.candidate_attachment_kind, table.candidate_attachment_id, table.created_at),
  foreignKey({ columns: [table.scope_key, table.baseline_set, table.baseline_revision], foreignColumns: [evaluation_evidence_sets.scope_key, evaluation_evidence_sets.id, evaluation_evidence_sets.revision] }).onDelete("cascade"),
  foreignKey({ columns: [table.scope_key, table.candidate_set, table.candidate_revision], foreignColumns: [evaluation_evidence_sets.scope_key, evaluation_evidence_sets.id, evaluation_evidence_sets.revision] }).onDelete("cascade"),
  foreignKey({ columns: [table.scope_key, table.mapping_id], foreignColumns: [evaluation_finding_mappings.scope_key, evaluation_finding_mappings.id] }).onDelete("cascade")]);

export const coding_hook_owner = sqliteTable("coding_hook_owner", {
  id: integer("id").primaryKey(),
  source_epoch: text("source_epoch").notNull(),
  generation: text("generation").notNull(),
  updated_at: integer("updated_at").notNull(),
}, table => [
  check("coding_hook_owner_id", sql`${table.id} = 1`),
  check("coding_hook_owner_source_epoch", sql`length(${table.source_epoch}) = 32 AND ${table.source_epoch} NOT GLOB '*[^a-f0-9]*'`),
  check("coding_hook_owner_generation", sql`length(${table.generation}) = 32 AND ${table.generation} NOT GLOB '*[^a-f0-9]*'`),
  check("coding_hook_owner_updated_at", sql`${table.updated_at} >= 0`),
]);

export const coding_hook_installations = sqliteTable("coding_hook_installations", {
  id: text("id").primaryKey(),
  owner_id: integer("owner_id").notNull().references(() => coding_hook_owner.id),
  generation: text("generation").notNull(),
  token_sha256: text("token_sha256").notNull().unique(),
  state: text("state", { enum: ["active", "disabled"] }).notNull(),
  capture_mode: text("capture_mode", { enum: ["metadata", "full"] }).notNull(),
  scope: text("scope", { enum: ["global", "local"] }).notNull(),
  workspace: text("workspace"),
  transcript_root: text("transcript_root").notNull(),
  source_root_key: text("source_root_key").notNull(),
  config_sha256: text("config_sha256").notNull(),
  data: text("data").notNull(),
  updated_at: integer("updated_at").notNull(),
}, table => [
  check("coding_hook_installations_id", sql`length(${table.id}) = 32 AND ${table.id} NOT GLOB '*[^a-f0-9]*'`),
  check("coding_hook_installations_generation", sql`length(${table.generation}) = 32 AND ${table.generation} NOT GLOB '*[^a-f0-9]*'`),
  check("coding_hook_installations_token_sha256", sql`length(${table.token_sha256}) = 64 AND ${table.token_sha256} NOT GLOB '*[^a-f0-9]*'`),
  check("coding_hook_installations_state", sql`${table.state} IN ('active', 'disabled')`),
  check("coding_hook_installations_capture_mode", sql`${table.capture_mode} IN ('metadata', 'full')`),
  check("coding_hook_installations_scope", sql`${table.scope} IN ('global', 'local')`),
  check("coding_hook_installations_workspace", sql`${table.workspace} IS NULL OR length(CAST(${table.workspace} AS BLOB)) BETWEEN 1 AND 4096`),
  check("coding_hook_installations_transcript_root", sql`length(CAST(${table.transcript_root} AS BLOB)) BETWEEN 1 AND 4096`),
  check("coding_hook_installations_source_root_key", sql`length(${table.source_root_key}) = 64 AND ${table.source_root_key} NOT GLOB '*[^a-f0-9]*'`),
  check("coding_hook_installations_config_sha256", sql`length(${table.config_sha256}) = 64 AND ${table.config_sha256} NOT GLOB '*[^a-f0-9]*'`),
  check("coding_hook_installations_data", sql`length(CAST(${table.data} AS BLOB)) <= 16384`),
  check("coding_hook_installations_updated_at", sql`${table.updated_at} >= 0`),
  check("coding_hook_installations_scope_workspace", sql`(${table.scope} = 'global' AND ${table.workspace} IS NULL) OR (${table.scope} = 'local' AND ${table.workspace} IS NOT NULL)`),
]);

export const coding_hook_sessions = sqliteTable("coding_hook_sessions", {
  source_key: text("source_key").primaryKey(),
  owner_id: integer("owner_id").notNull().references(() => coding_hook_owner.id),
  source_root_key: text("source_root_key").notNull(),
  run_id: text("run_id").notNull().unique(),
  root_span_id: text("root_span_id").notNull(),
  state: text("state", { enum: ["open", "closed", "unknown", "suppressed"] }).notNull(),
  incarnation_key: text("incarnation_key"),
  prefix_sha256: text("prefix_sha256"),
  prefix_bytes: integer("prefix_bytes").notNull(),
  source_cursor: integer("source_cursor").notNull(),
  observed_file_bytes: integer("observed_file_bytes").notNull(),
  data: text("data").notNull(),
  created_at: integer("created_at").notNull(),
  updated_at: integer("updated_at").notNull(),
}, table => [
  index("idx_coding_hook_sessions_run").on(table.run_id),
  check("coding_hook_sessions_source_key", sql`length(${table.source_key}) = 64 AND ${table.source_key} NOT GLOB '*[^a-f0-9]*'`),
  check("coding_hook_sessions_source_root_key", sql`length(${table.source_root_key}) = 64 AND ${table.source_root_key} NOT GLOB '*[^a-f0-9]*'`),
  check("coding_hook_sessions_run_id", sql`length(${table.run_id}) = 32 AND ${table.run_id} NOT GLOB '*[^a-f0-9]*'`),
  check("coding_hook_sessions_root_span_id", sql`length(${table.root_span_id}) = 16 AND ${table.root_span_id} NOT GLOB '*[^a-f0-9]*'`),
  check("coding_hook_sessions_state", sql`${table.state} IN ('open', 'closed', 'unknown', 'suppressed')`),
  check("coding_hook_sessions_incarnation_key", sql`${table.incarnation_key} IS NULL OR (length(${table.incarnation_key}) = 64 AND ${table.incarnation_key} NOT GLOB '*[^a-f0-9]*')`),
  check("coding_hook_sessions_prefix_sha256", sql`${table.prefix_sha256} IS NULL OR (length(${table.prefix_sha256}) = 64 AND ${table.prefix_sha256} NOT GLOB '*[^a-f0-9]*')`),
  check("coding_hook_sessions_prefix_bytes", sql`${table.prefix_bytes} BETWEEN 0 AND 65536`),
  check("coding_hook_sessions_source_cursor", sql`${table.source_cursor} BETWEEN 0 AND 8388608`),
  check("coding_hook_sessions_observed_file_bytes", sql`${table.observed_file_bytes} BETWEEN 0 AND 9007199254740991`),
  check("coding_hook_sessions_data", sql`length(CAST(${table.data} AS BLOB)) <= 16384`),
  check("coding_hook_sessions_created_at", sql`${table.created_at} >= 0`),
  check("coding_hook_sessions_updated_at", sql`${table.updated_at} >= 0`),
  check("coding_hook_sessions_prefix_integrity", sql`(${table.prefix_bytes} = 0 AND ${table.prefix_sha256} IS NULL) OR (${table.prefix_bytes} > 0 AND ${table.prefix_sha256} IS NOT NULL)`),
  check("coding_hook_sessions_suppressed_tombstone", sql`${table.state} <> 'suppressed' OR (${table.incarnation_key} IS NULL AND ${table.prefix_sha256} IS NULL AND ${table.prefix_bytes} = 0 AND ${table.source_cursor} = 0 AND ${table.observed_file_bytes} = 0 AND length(CAST(${table.data} AS BLOB)) <= 1024)`),
]);

export const coding_hook_entities = sqliteTable("coding_hook_entities", {
  source_key: text("source_key").notNull().references(() => coding_hook_sessions.source_key, { onDelete: "cascade" }),
  entity_key: text("entity_key").notNull(),
  span_id: text("span_id").notNull(),
  kind: text("kind", { enum: ["session", "prompt", "tool", "assistant", "subagent", "turn"] }).notNull(),
  phase: text("phase", { enum: ["pending", "success", "failure", "interrupted", "complete", "unknown", "conflict"] }).notNull(),
  incarnation_key: text("incarnation_key"),
  source_offset: integer("source_offset"),
  observation_sha256: text("observation_sha256").notNull(),
  projection_sha256: text("projection_sha256").notNull(),
  data: text("data").notNull(),
  updated_at: integer("updated_at").notNull(),
}, table => [
  primaryKey({ columns: [table.source_key, table.entity_key] }),
  unique("coding_hook_entities_source_key_span_id_unique").on(table.source_key, table.span_id),
  check("coding_hook_entities_entity_key", sql`length(${table.entity_key}) = 64 AND ${table.entity_key} NOT GLOB '*[^a-f0-9]*'`),
  check("coding_hook_entities_span_id", sql`length(${table.span_id}) = 16 AND ${table.span_id} NOT GLOB '*[^a-f0-9]*'`),
  check("coding_hook_entities_kind", sql`${table.kind} IN ('session', 'prompt', 'tool', 'assistant', 'subagent', 'turn')`),
  check("coding_hook_entities_phase", sql`${table.phase} IN ('pending', 'success', 'failure', 'interrupted', 'complete', 'unknown', 'conflict')`),
  check("coding_hook_entities_incarnation_key", sql`${table.incarnation_key} IS NULL OR (length(${table.incarnation_key}) = 64 AND ${table.incarnation_key} NOT GLOB '*[^a-f0-9]*')`),
  check("coding_hook_entities_source_offset", sql`${table.source_offset} IS NULL OR ${table.source_offset} BETWEEN 0 AND 8388608`),
  check("coding_hook_entities_observation_sha256", sql`length(${table.observation_sha256}) = 64 AND ${table.observation_sha256} NOT GLOB '*[^a-f0-9]*'`),
  check("coding_hook_entities_projection_sha256", sql`length(${table.projection_sha256}) = 64 AND ${table.projection_sha256} NOT GLOB '*[^a-f0-9]*'`),
  check("coding_hook_entities_data", sql`length(CAST(${table.data} AS BLOB)) <= 16384`),
  check("coding_hook_entities_updated_at", sql`${table.updated_at} >= 0`),
  check("coding_hook_entities_ordinal_incarnation", sql`(${table.source_offset} IS NULL AND ${table.incarnation_key} IS NULL) OR (${table.source_offset} IS NOT NULL AND ${table.incarnation_key} IS NOT NULL)`),
]);

export const review_queues = sqliteTable("review_queues", {
  id: text("id").primaryKey().notNull(), name: text("name").notNull(),
  schema_json: text("schema_json").notNull(), schema_hash: text("schema_hash").notNull(),
  next_ordinal: integer("next_ordinal").notNull().default(1), created_at: integer("created_at").notNull(),
}, t => [
  check("review_queues_id", sql`length(${t.id}) BETWEEN 1 AND 128`),
  check("review_queues_name", sql`length(${t.name}) BETWEEN 1 AND 128`),
  check("review_queues_schema_bytes", sql`length(CAST(${t.schema_json} AS BLOB)) <= 8192`),
  check("review_queues_schema_hash", sql`length(${t.schema_hash}) = 64`),
  check("review_queues_next_ordinal", sql`${t.next_ordinal} >= 1`),
  check("review_queues_created_at", sql`${t.created_at} >= 0`),
  index("review_queues_created").on(t.created_at, t.id),
]);

export const review_queue_items = sqliteTable("review_queue_items", {
  id: text("id").primaryKey().notNull(),
  queue_id: text("queue_id").notNull().references(() => review_queues.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  source_run_id: text("source_run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  source_span_key: text("source_span_key").notNull(), source_json: text("source_json").notNull(), source_hash: text("source_hash").notNull(),
  draft_json: text("draft_json").notNull(), draft_hash: text("draft_hash").notNull(),
  revision: integer("revision").notNull().default(1), state: text("state", { enum: ["draft", "approved", "promoted"] }).notNull().default("draft"),
  approved_hash: text("approved_hash"), approved_at: integer("approved_at"), review_source: text("review_source"),
  last_mutation_id: text("last_mutation_id"), last_mutation_hash: text("last_mutation_hash"),
  promoted_dataset_id: text("promoted_dataset_id"), promoted_dataset_version: integer("promoted_dataset_version"), promoted_case_id: text("promoted_case_id"),
  created_at: integer("created_at").notNull(), updated_at: integer("updated_at").notNull(),
}, t => [
  check("review_queue_items_id", sql`length(${t.id}) = 64`),
  check("review_queue_items_ordinal", sql`${t.ordinal} >= 1`),
  check("review_queue_items_source_key", sql`length(${t.source_span_key}) <= 128`),
  check("review_queue_items_source_bytes", sql`length(CAST(${t.source_json} AS BLOB)) <= 49152`),
  check("review_queue_items_source_hash", sql`length(${t.source_hash}) = 64`),
  check("review_queue_items_draft_bytes", sql`length(CAST(${t.draft_json} AS BLOB)) <= 32768`),
  check("review_queue_items_draft_hash", sql`length(${t.draft_hash}) = 64`),
  check("review_queue_items_revision", sql`${t.revision} >= 1`),
  check("review_queue_items_state", sql`${t.state} IN ('draft','approved','promoted')`),
  check("review_queue_items_approved_hash", sql`${t.approved_hash} IS NULL OR length(${t.approved_hash}) = 64`),
  check("review_queue_items_approved_at", sql`${t.approved_at} IS NULL OR ${t.approved_at} >= 0`),
  check("review_queue_items_review_source", sql`${t.review_source} IS NULL OR ${t.review_source} = 'localOperator'`),
  check("review_queue_items_mutation_id", sql`${t.last_mutation_id} IS NULL OR length(${t.last_mutation_id}) BETWEEN 1 AND 128`),
  check("review_queue_items_mutation_hash", sql`${t.last_mutation_hash} IS NULL OR length(${t.last_mutation_hash}) = 64`),
  check("review_queue_items_dataset_version", sql`${t.promoted_dataset_version} IS NULL OR ${t.promoted_dataset_version} >= 1`),
  check("review_queue_items_created_at", sql`${t.created_at} >= 0`), check("review_queue_items_updated_at", sql`${t.updated_at} >= 0`),
  check("review_queue_items_approval", sql`(${t.state} = 'draft' AND ${t.approved_hash} IS NULL AND ${t.approved_at} IS NULL AND ${t.review_source} IS NULL) OR (${t.state} IN ('approved','promoted') AND ${t.approved_hash} IS NOT NULL AND ${t.approved_at} IS NOT NULL AND ${t.review_source} = 'localOperator')`),
  check("review_queue_items_promotion", sql`(${t.state} != 'promoted' AND ${t.promoted_dataset_id} IS NULL AND ${t.promoted_dataset_version} IS NULL AND ${t.promoted_case_id} IS NULL) OR (${t.state} = 'promoted' AND ${t.promoted_dataset_id} IS NOT NULL AND ${t.promoted_dataset_version} IS NOT NULL AND ${t.promoted_case_id} IS NOT NULL)`),
  uniqueIndex("review_queue_items_ordinal_unique").on(t.queue_id, t.ordinal), uniqueIndex("review_queue_items_source_unique").on(t.queue_id, t.source_run_id, t.source_span_key),
  index("review_queue_items_window").on(t.queue_id, t.ordinal, t.id), index("review_queue_items_state").on(t.queue_id, t.state, t.ordinal, t.id), index("review_queue_items_source").on(t.source_run_id),
]);

export const review_queue_promotions = sqliteTable("review_queue_promotions", {
  id: text("id").primaryKey().notNull(),
  queue_id: text("queue_id").notNull().references(() => review_queues.id, { onDelete: "cascade" }),
  idempotency_key: text("idempotency_key").notNull(), request_hash: text("request_hash").notNull(), request_json: text("request_json").notNull(),
  dataset_id: text("dataset_id").notNull(), dataset_version: integer("dataset_version").notNull(), dataset_hash: text("dataset_hash").notNull(),
  result_json: text("result_json").notNull(), created_at: integer("created_at").notNull(),
}, t => [
  check("review_queue_promotions_id", sql`length(${t.id}) = 64`),
  check("review_queue_promotions_key", sql`length(${t.idempotency_key}) BETWEEN 1 AND 128`),
  check("review_queue_promotions_request_hash", sql`length(${t.request_hash}) = 64`),
  check("review_queue_promotions_request_bytes", sql`length(CAST(${t.request_json} AS BLOB)) <= 16384`),
  check("review_queue_promotions_version", sql`${t.dataset_version} >= 1`),
  check("review_queue_promotions_dataset_hash", sql`length(${t.dataset_hash}) = 64`),
  check("review_queue_promotions_result_bytes", sql`length(CAST(${t.result_json} AS BLOB)) <= 16384`),
  check("review_queue_promotions_created_at", sql`${t.created_at} >= 0`),
  uniqueIndex("review_queue_promotions_key_unique").on(t.queue_id, t.idempotency_key), index("review_queue_promotions_dataset").on(t.dataset_id, t.dataset_version),
  foreignKey({ columns: [t.dataset_id, t.dataset_version], foreignColumns: [evaluation_revisions.dataset_id, evaluation_revisions.version] }).onDelete("cascade"),
]);
