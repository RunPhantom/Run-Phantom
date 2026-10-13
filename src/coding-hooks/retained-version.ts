import type { Database } from "bun:sqlite";
import { sanitizeClaudeRetention } from "./claude";
import { claudeEntityProjection } from "./projection";
import { hookDigest, isHex, refuse, validateClaudeRetainedEntity, validCoverageReasons } from "./protocol";
import { parseBoundedHookJson } from "./shared";

export const CANONICAL_COLUMNS = ["id", "run_id", "parent_span_id", "name", "span_type", "status", "input_payload", "output_payload", "start_time_ms", "end_time_ms", "duration_ms", "model", "provider", "input_tokens", "output_tokens", "attributes", "otlp_evidence"] as const;
export interface CompleteSessionRow {
 source_key: string; owner_id: number; source_root_key: string; run_id: string; root_span_id: string; state: string;
 incarnation_key: string | null; prefix_sha256: string | null; prefix_bytes: number; source_cursor: number; observed_file_bytes: number; data: string; created_at: number; updated_at: number;
}
export function readCompleteSession(db: Database, key: string): CompleteSessionRow | null {
 return db.query("SELECT source_key,owner_id,source_root_key,run_id,root_span_id,state,incarnation_key,prefix_sha256,prefix_bytes,source_cursor,observed_file_bytes,CASE WHEN length(CAST(data AS BLOB))<=16384 THEN data END data,created_at,updated_at FROM coding_hook_sessions WHERE source_key=?").get(key) as CompleteSessionRow | null;
}
export const boundedInteger = (value: unknown, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
export function validateSessionColumns(row: CompleteSessionRow, key: string, registration: string): void {
 if (row.source_key !== key || row.owner_id !== 1 || row.source_root_key !== registration || row.run_id !== key.slice(0, 32) || row.root_span_id !== hookDigest(key + "root").slice(0, 16)
  || !["open", "closed"].includes(row.state) || !boundedInteger(row.created_at, 9999999999999) || !boundedInteger(row.updated_at, 9999999999999)
  || !boundedInteger(row.source_cursor, 8388608) || !boundedInteger(row.prefix_bytes, 65536) || !boundedInteger(row.observed_file_bytes, 8388608)
  || row.source_cursor > row.observed_file_bytes || row.prefix_bytes > row.observed_file_bytes
  || (row.incarnation_key === null ? row.source_cursor !== 0 || row.prefix_bytes !== 0 || row.observed_file_bytes !== 0 : !isHex(row.incarnation_key, 64))
  || (row.prefix_bytes === 0 ? row.prefix_sha256 !== null : !isHex(row.prefix_sha256, 64) || row.incarnation_key === null)) refuse("corrupt", 503);
}
export function assertAbsentAnchors(db: Database, key: string): void {
 if (db.query("SELECT 1 FROM coding_hook_entities WHERE source_key=? LIMIT 1").get(key)
  || db.query("SELECT 1 FROM runs WHERE id=? LIMIT 1").get(key.slice(0,32))
  || db.query("SELECT 1 FROM spans WHERE run_id=? LIMIT 1").get(key.slice(0,32))) refuse("projection_conflict");
}
export function readCanonical(db: Database, runId: string, spanId: string): Record<string, unknown> | null {
 const bytes = CANONICAL_COLUMNS.map(column => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join("+");
 const row = db.query(`SELECT (${bytes})<=65536 bounded,${CANONICAL_COLUMNS.map(column => `CASE WHEN (${bytes})<=65536 THEN ${column} END ${column}`).join(",")} FROM spans WHERE run_id=? AND id=?`).get(runId,spanId) as Record<string,unknown>|null;
 if (!row) return null; if (row.bounded !== 1) refuse("corrupt",503); delete row.bounded; return row;
}
/** Read-only C06 legacy preflight. Suppression is deliberately earlier than JSON/witness validation. */
export function validateLegacySource(db: Database, key: string, registration: string): "absent" | "legacy-main-v1" | "context-v2" {
 const started = performance.now(), deadline = () => { if (performance.now()-started > 250) refuse("deadline",503); };
 const row = readCompleteSession(db,key);
 if (!row) { assertAbsentAnchors(db,key); return "absent"; }
 if (row.state === "suppressed") refuse("suppressed");
 validateSessionColumns(row,key,registration);
 const parsed = parseBoundedHookJson(row.data,16384); if (parsed.status !== "accepted" || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) refuse("corrupt",503);
 const data = parsed.value;
 if (data.version === 2) return "context-v2";
 const initial = Object.keys(data).join(",") === "coverage,producerVerified" && data.coverage === "partial" && data.producerVerified === false;
 if (initial) {
  if (row.data !== '{"coverage":"partial","producerVerified":false}' || row.state !== "open" || row.incarnation_key !== null || row.prefix_sha256 !== null || row.source_cursor !== 0 || row.prefix_bytes !== 0 || row.observed_file_bytes !== 0) refuse("corrupt",503);
  assertAbsentAnchors(db,key); return "legacy-main-v1";
 }
 if (Object.keys(data).join(",") !== "coverage,reasons,unlinkedAssertions" || data.coverage !== "partial" || !validCoverageReasons(data.reasons) || new Set(data.reasons).size !== data.reasons.length) refuse("corrupt",503);
 const assertions = data.unlinkedAssertions;
 if (assertions !== null && (!assertions || typeof assertions !== "object" || Array.isArray(assertions) || Object.keys(assertions).join(",") !== "prompt,assistant,error" || Object.values(assertions).some(value => value !== null && (typeof value !== "string" || value.length > 4096)))) refuse("corrupt",503);
 if (JSON.stringify(data) !== row.data || JSON.stringify(sanitizeClaudeRetention({ bodies: [], assertions }).value) !== JSON.stringify({ bodies: [], assertions })) refuse("corrupt",503);
 if (!db.query("SELECT 1 FROM runs WHERE id=?").get(row.run_id)) refuse("corrupt",503);
 const entries = db.query("SELECT entity_key,span_id,kind,phase,incarnation_key,source_offset,observation_sha256,projection_sha256,CASE WHEN length(CAST(data AS BLOB))<=16384 THEN data END data FROM coding_hook_entities WHERE source_key=? ORDER BY entity_key LIMIT 1001").all(key) as {entity_key:string;span_id:string;kind:string;phase:string;incarnation_key:string|null;source_offset:number|null;observation_sha256:string;projection_sha256:string;data:string}[];
 if (entries.length > 1000) refuse("quota",507);
 let roots = 0; const ids = new Set<string>();
 for (const entry of entries) {
  deadline(); const entity = validateClaudeRetainedEntity(entry.data,key,row.incarnation_key,row.source_cursor);
  if (entity.entityKey !== entry.entity_key || entity.kind !== entry.kind || entity.phase !== entry.phase || entity.incarnationKey !== entry.incarnation_key || entity.sourceOffset !== entry.source_offset || !isHex(entry.observation_sha256,64) || !isHex(entry.projection_sha256,64)) refuse("corrupt",503);
  const spanId = entity.kind === "session" ? row.root_span_id : entity.entityKey.slice(0,16); if (entry.span_id !== spanId) refuse("corrupt",503);
  const canonical = readCanonical(db,row.run_id,spanId); if (!canonical || hookDigest(JSON.stringify(canonical)) !== entry.projection_sha256) refuse("corrupt",503);
  const attrs = parseBoundedHookJson(canonical.attributes,16384);
  if (attrs.status !== "accepted" || !attrs.value || typeof attrs.value !== "object" || Array.isArray(attrs.value) || (attrs.value.currentCapturePolicy !== "full" && attrs.value.currentCapturePolicy !== "metadata")) refuse("corrupt",503);
  if (JSON.stringify(claudeEntityProjection(entity,{runId:row.run_id,rootSpanId:row.root_span_id},attrs.value.currentCapturePolicy,entry.data)) !== JSON.stringify(canonical)) refuse("corrupt",503);
  if (entity.kind === "session") { roots++; if (entity.sourceKind !== "hook" || entity.model !== null || entity.body !== null || entity.usage !== null || entity.phase !== (row.state === "closed" ? "complete" : "pending")) refuse("corrupt",503); }
  ids.add(spanId);
 }
 if (roots !== 1) refuse("corrupt",503);
 const spans = db.query("SELECT id,CASE WHEN length(CAST(attributes AS BLOB))<=16384 THEN attributes END attributes FROM spans WHERE run_id=? AND CASE WHEN json_valid(attributes) THEN json_extract(attributes,'$.source')='claude_hook' OR json_extract(attributes,'$.captureContract') LIKE 'runphantom.claude-hook.observation/%' ELSE attributes LIKE '%runphantom.claude-hook.observation/%' END LIMIT 1001").all(row.run_id) as {id:string;attributes:string|null}[];
 if (spans.length > 1000) refuse("quota",507);
 for (const span of spans) { deadline(); if (!ids.has(span.id)) refuse("corrupt",503); }
 deadline(); return "legacy-main-v1";
}
