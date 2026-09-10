import { getDrizzleDb } from "../db";
import { EVALUATION_LIMITS as L, type SnapshotRun, type SnapshotSpan } from "./protocol";
import { snapshotRun, sanitizeSnapshotText } from "./snapshot";
import { parseId, EvaluationError } from "./validation";

function assertSpanBounds(runId: string): void {
  const db = getDrizzleDb().$client;
  const count = db.query("SELECT COUNT(*) AS n FROM spans WHERE run_id = ?").get(runId) as { n: number };
  if (count.n > L.MAX_SPANS) throw new EvaluationError("Trace exceeds the evaluation span limit", 413);
  const oversizedIds = db.query(`SELECT COUNT(*) AS n FROM spans WHERE run_id = ? AND
    (length(id) > 128 OR length(parent_span_id) > 128 OR length(CAST(id AS BLOB)) > 512 OR length(CAST(parent_span_id AS BLOB)) > 512)`).get(runId) as { n: number };
  if (oversizedIds.n) throw new EvaluationError("Trace identity exceeds the evaluation acquisition limit", 413);
}

/** Response choices use the same exact-identity limits, without loading any trace payload. */
export function listResponseSpans(runId: string): { spans: Array<{ id: string; name: string; spanType: string | null }>; truncated: boolean } {
  parseId(runId); const db = getDrizzleDb();
  return db.transaction(() => {
    if (!db.$client.query("SELECT 1 FROM runs WHERE id=?").get(runId)) throw new EvaluationError("Run not found", 404);
    assertSpanBounds(runId);
    const rows = db.$client.query(`SELECT id,
      CASE WHEN length(CAST(name AS BLOB)) <= 4096 THEN name ELSE NULL END AS name,
      CASE WHEN length(CAST(span_type AS BLOB)) <= 128 THEN span_type ELSE NULL END AS span_type,
      COALESCE(length(CAST(span_type AS BLOB)) > 128,0) AS type_withheld
      FROM spans WHERE run_id=? ORDER BY start_time_ms,id`).all(runId) as Array<{ id: string; name: string | null; span_type: string | null; type_withheld: number }>;
    let truncated = false;
    const spans = rows.map((row) => {
      parseId(row.id);
      const name = sanitizeSnapshotText(row.name), type = sanitizeSnapshotText(row.span_type);
      truncated ||= row.name === null || !!row.type_withheld || name.redacted || name.truncated || (name.value?.length ?? 0) > 200 || type.redacted || type.truncated;
      return { id: row.id, name: (name.value ?? "[UNAVAILABLE]").slice(0, 200), spanType: type.value };
    });
    return { spans, truncated };
  });
}

/** Withhold oversized payloads in SQLite before any JavaScript string or normalizer sees them. */
export function loadSnapshot(runId: string, outputSpanId?: string) {
  parseId(runId); if (outputSpanId !== undefined) parseId(outputSpanId);
  const db = getDrizzleDb();
  return db.transaction(() => {
    const run = db.$client.query(`SELECT id,
      CASE WHEN length(CAST(name AS BLOB)) <= 4096 THEN name ELSE NULL END AS name,
      CASE WHEN length(CAST(display_name AS BLOB)) <= 4096 THEN display_name ELSE NULL END AS display_name,
      CASE WHEN length(CAST(event_name AS BLOB)) <= 4096 THEN event_name ELSE NULL END AS event_name,
      started_at, last_updated_at FROM runs WHERE id = ?`).get(runId) as SnapshotRun | null;
    if (!run) throw new EvaluationError("Run not found", 404);
    assertSpanBounds(runId);
    const size = db.$client.query(`SELECT COALESCE(SUM(
      CASE WHEN length(CAST(input_payload AS BLOB)) <= ? THEN length(CAST(input_payload AS BLOB)) ELSE 0 END +
      CASE WHEN length(CAST(output_payload AS BLOB)) <= ? THEN length(CAST(output_payload AS BLOB)) ELSE 0 END +
      CASE WHEN length(CAST(attributes AS BLOB)) <= ? THEN length(CAST(attributes AS BLOB)) ELSE 0 END +
      length(CAST(id AS BLOB)) + length(CAST(run_id AS BLOB)) + COALESCE(length(CAST(parent_span_id AS BLOB)), 0) +
      CASE WHEN length(CAST(name AS BLOB)) <= 4096 THEN length(CAST(name AS BLOB)) ELSE 0 END +
      CASE WHEN length(CAST(model AS BLOB)) <= 4096 THEN length(CAST(model AS BLOB)) ELSE 0 END +
      CASE WHEN length(CAST(provider AS BLOB)) <= 4096 THEN length(CAST(provider AS BLOB)) ELSE 0 END +
      CASE WHEN length(CAST(status AS BLOB)) <= 128 THEN length(CAST(status AS BLOB)) ELSE 0 END +
      CASE WHEN length(CAST(span_type AS BLOB)) <= 128 THEN length(CAST(span_type AS BLOB)) ELSE 0 END), 0) AS bytes
      FROM spans WHERE run_id = ?`).get(L.MAX_PAYLOAD_BYTES, L.MAX_PAYLOAD_BYTES, L.MAX_PAYLOAD_BYTES, runId) as { bytes: number };
    if (size.bytes > L.MAX_ACQUIRED_PAYLOAD_BYTES) throw new EvaluationError("Trace payloads exceed the bounded evaluation acquisition limit", 413);
    const rows = db.$client.query(`SELECT id, run_id, parent_span_id,
      CASE WHEN length(CAST(name AS BLOB)) <= 4096 THEN name ELSE '[TRUNCATED]' END AS name,
      CASE WHEN length(CAST(span_type AS BLOB)) <= 128 THEN span_type ELSE NULL END AS span_type,
      CASE WHEN length(CAST(status AS BLOB)) <= 128 THEN status ELSE NULL END AS status,
      CASE WHEN length(CAST(model AS BLOB)) <= 4096 THEN model ELSE NULL END AS model,
      CASE WHEN length(CAST(provider AS BLOB)) <= 4096 THEN provider ELSE NULL END AS provider,
      start_time_ms, end_time_ms, duration_ms, input_tokens, output_tokens,
      CASE WHEN length(CAST(input_payload AS BLOB)) <= ? THEN input_payload ELSE NULL END AS input_payload,
      CASE WHEN length(CAST(output_payload AS BLOB)) <= ? THEN output_payload ELSE NULL END AS output_payload,
      CASE WHEN length(CAST(attributes AS BLOB)) <= ? THEN attributes ELSE NULL END AS attributes,
      COALESCE(length(CAST(input_payload AS BLOB)) > ?, 0) AS input_unavailable,
      COALESCE(length(CAST(output_payload AS BLOB)) > ?, 0) AS output_unavailable,
      COALESCE(length(CAST(attributes AS BLOB)) > ?, 0) AS attributes_unavailable
      FROM spans WHERE run_id = ?`).all(L.MAX_PAYLOAD_BYTES, L.MAX_PAYLOAD_BYTES, L.MAX_PAYLOAD_BYTES,
        L.MAX_PAYLOAD_BYTES, L.MAX_PAYLOAD_BYTES, L.MAX_PAYLOAD_BYTES, runId) as Array<SnapshotSpan & { input_unavailable: number; output_unavailable: number; attributes_unavailable: number }>;
    const spans: SnapshotSpan[] = rows.map(({ input_unavailable, output_unavailable, attributes_unavailable, ...span }) => ({
      ...span, unavailable: { input: !!input_unavailable, output: !!output_unavailable, attributes: !!attributes_unavailable } }));
    if (outputSpanId !== undefined && !spans.some((span) => span.id === outputSpanId)) throw new EvaluationError("Selected output span does not belong to this exact run", 400);
    return snapshotRun(run, spans, outputSpanId);
  });
}
