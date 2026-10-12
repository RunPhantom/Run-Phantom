import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Database } from "bun:sqlite";
import type { NormalizedClaudeBatch, NormalizedClaudeEntity } from "./claude";
import { parseBoundedHookJson } from "./shared";
import { HookRefusal, hookDigest, isHex, refuse, validateClaudeBatch } from "./protocol";

export const STORE_LIMITS = Object.freeze({ installations: 64, sessions: 10000, sessionEntities: 1000, entities: 100000, bytes: 33554432 });
type StoreLimits = { [Key in keyof typeof STORE_LIMITS]: number };
export interface InstallationBinding { installationId: string; scope: "global" | "local"; captureMode: "metadata" | "full"; workspace: string | null; registeredWorkspace: string; transcriptRoot: string; projectDirectory: string; homeDirectory: string; settingsPath: string; executable: string; }
interface InstallationRow { id: string; generation: string; capture_mode: "metadata" | "full"; state: "active" | "disabled"; source_root_key: string; token_sha256: string; config_sha256: string; data: string | null; }
export interface HookAdmission { ownerGeneration: string; installationGeneration: string; sourceKey: string; runId: string; rootSpanId: string; captureMode: "metadata" | "full"; transcriptCursor: number; incarnationKey: string | null; prefixBytes: number; prefixSha256: string | null; observedFileBytes: number; binding: InstallationBinding; }
interface SessionRow { source_key: string; source_root_key: string; run_id: string; root_span_id: string; state: "open" | "closed" | "unknown" | "suppressed"; incarnation_key: string | null; prefix_sha256: string | null; prefix_bytes: number; source_cursor: number; observed_file_bytes: number; data: string | null; }
interface EntityRow { data: string | null; projection_sha256: string; observation_sha256: string; }
const random = () => randomBytes(16).toString("hex");
const rootKey = (binding: InstallationBinding) => hookDigest(JSON.stringify(["runphantom.claude.root/v1", binding.registeredWorkspace, binding.transcriptRoot, binding.projectDirectory]));
const terminal = (phase: NormalizedClaudeEntity["phase"]) => ["success", "failure", "interrupted", "complete", "conflict"].includes(phase);

export function validateInstallationBinding(binding: InstallationBinding): InstallationBinding {
  if (!binding || typeof binding !== "object" || Object.keys(binding).sort().join(",") !== "captureMode,executable,homeDirectory,installationId,projectDirectory,registeredWorkspace,scope,settingsPath,transcriptRoot,workspace") refuse("malformed", 400);
  if (!isHex(binding.installationId, 32) || !["global", "local"].includes(binding.scope) || !["metadata", "full"].includes(binding.captureMode)
    || (binding.scope === "global" ? binding.workspace !== null || binding.captureMode !== "metadata" : binding.workspace !== binding.registeredWorkspace)) refuse("malformed", 400);
  for (const value of [binding.registeredWorkspace, binding.transcriptRoot, binding.projectDirectory, binding.homeDirectory, binding.settingsPath, binding.executable]) {
    if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0") || Buffer.byteLength(value) > 4096 || path.normalize(value) !== value) refuse("malformed", 400);
  }
  const relative = path.relative(binding.transcriptRoot, binding.projectDirectory);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative) || relative.includes(path.sep)) refuse("malformed", 400);
  if (Buffer.byteLength(JSON.stringify(binding)) > 16384) refuse("malformed", 400);
  return binding;
}

/** Uses the injected owner connection; never creates schema or selects a profile/database. */
export class CodingHookStore {
  private readonly limits: StoreLimits;
  constructor(readonly db: Database, limits: Partial<StoreLimits> = {}) {
    this.limits = { ...STORE_LIMITS, ...limits };
    for (const key of Object.keys(STORE_LIMITS) as (keyof typeof STORE_LIMITS)[]) if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 1 || this.limits[key] > STORE_LIMITS[key]) refuse("malformed", 400);
  }
  private transaction<T>(work: () => T): T { try { return this.db.transaction(work).immediate(); } catch (error) { if (error instanceof HookRefusal) throw error; refuse("unavailable", 503); } }
  beginOwner(): void { this.transaction(() => { this.db.query("INSERT INTO coding_hook_owner VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,updated_at=excluded.updated_at").run(random(), random(), Date.now()); this.checkQuota(); }); }
  rotateOwner(): void { this.transaction(() => { this.owner(); this.db.query("UPDATE coding_hook_owner SET generation=?,updated_at=? WHERE id=1").run(random(), Date.now()); }); }
  private owner(): { generation: string; source_epoch: string } {
    const row = this.db.query("SELECT CASE WHEN length(generation)=32 THEN generation END generation,CASE WHEN length(source_epoch)=32 THEN source_epoch END source_epoch FROM coding_hook_owner WHERE id=1").get() as { generation: string; source_epoch: string } | null;
    if (!row || !isHex(row.generation, 32) || !isHex(row.source_epoch, 32)) refuse("inactive", 503); return row;
  }
  private installation(id: string): InstallationRow | null {
    if (!isHex(id, 32)) refuse("malformed", 400);
    return this.db.query("SELECT id,generation,capture_mode,state,source_root_key,token_sha256,config_sha256,CASE WHEN length(CAST(data AS BLOB))<=16384 THEN data END data FROM coding_hook_installations WHERE id=?").get(id) as InstallationRow | null;
  }
  readInstallation(id: string): { row: InstallationRow; binding: InstallationBinding } | null {
    this.checkQuota(); const row = this.installation(id); if (!row) return null;
    if (!row.data || !isHex(row.generation, 32) || !isHex(row.source_root_key, 64) || !isHex(row.token_sha256, 64) || !isHex(row.config_sha256, 64)) refuse("corrupt", 503);
    let binding: InstallationBinding; try { const parsed = parseBoundedHookJson(row.data, 16384); if (parsed.status !== "accepted") refuse("corrupt", 503); binding = validateInstallationBinding(parsed.value as unknown as InstallationBinding); } catch { refuse("corrupt", 503); }
    if (binding.installationId !== id || binding.captureMode !== row.capture_mode || rootKey(binding) !== row.source_root_key || !["active", "disabled"].includes(row.state)) refuse("corrupt", 503);
    return { row, binding };
  }
  authenticate(token: string): { row: InstallationRow; binding: InstallationBinding; ownerGeneration: string; sourceEpoch: string } {
    if (!isHex(token, 64)) refuse("unauthorized", 401);
    this.checkQuota();
    const found = this.db.query("SELECT id FROM coding_hook_installations WHERE token_sha256=?").get(hookDigest(token)) as { id: string } | null;
    if (!found) refuse("unauthorized", 401);
    const installed = this.readInstallation(found.id); if (!installed || installed.row.state !== "active") refuse("inactive", 409);
    const owner = this.owner(); return { ...installed, ownerGeneration: owner.generation, sourceEpoch: owner.source_epoch };
  }
  prepareInstallation(binding: InstallationBinding, token: string, configSha256: string): { installationGeneration: string; ownerGeneration: string; unchanged: boolean } {
    binding = validateInstallationBinding(binding); if (!isHex(token, 64) || !isHex(configSha256, 64)) refuse("malformed", 400);
    return this.transaction(() => {
      const owner = this.owner(); this.checkQuota(); const before = this.readInstallation(binding.installationId), data = JSON.stringify(binding), tokenSha256 = hookDigest(token);
      if (before?.row.state === "active" && before.row.data === data && before.row.config_sha256 === configSha256 && before.row.token_sha256 === tokenSha256) return { installationGeneration: before.row.generation, ownerGeneration: owner.generation, unchanged: true };
      const generation = random();
      this.db.query("INSERT INTO coding_hook_installations VALUES(?,1,?,?,'disabled',?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,token_sha256=excluded.token_sha256,state='disabled',capture_mode=excluded.capture_mode,scope=excluded.scope,workspace=excluded.workspace,transcript_root=excluded.transcript_root,source_root_key=excluded.source_root_key,config_sha256=excluded.config_sha256,data=excluded.data,updated_at=excluded.updated_at").run(binding.installationId, generation, tokenSha256, binding.captureMode, binding.scope, binding.workspace, binding.transcriptRoot, rootKey(binding), configSha256, data, Date.now());
      this.checkQuota(); return { installationGeneration: generation, ownerGeneration: owner.generation, unchanged: false };
    });
  }
  commitInstallation(id: string, generation: string, token: string, configSha256: string, ownerGeneration: string): void {
    this.transaction(() => { if (!isHex(ownerGeneration, 32) || this.owner().generation !== ownerGeneration) refuse("stale"); const installed = this.readInstallation(id); if (!installed || installed.row.generation !== generation || installed.row.token_sha256 !== hookDigest(token) || installed.row.config_sha256 !== configSha256) refuse("stale");
      this.db.query("UPDATE coding_hook_installations SET state='active',updated_at=? WHERE id=?").run(Date.now(), id); this.checkQuota(); });
  }
  disableInstallation(id: string): void {
    this.transaction(() => { const before = this.readInstallation(id); if (!before) return;
      const binding = { ...before.binding, captureMode: "metadata" as const };
      this.db.query("UPDATE coding_hook_installations SET state='disabled',capture_mode='metadata',generation=?,token_sha256=?,data=?,updated_at=? WHERE id=?").run(random(), hookDigest(randomBytes(32).toString("hex")), JSON.stringify(binding), Date.now(), id); });
  }
  private session(sourceKey: string): SessionRow | null {
    if (!isHex(sourceKey, 64)) refuse("malformed", 400);
    const row = this.db.query("SELECT source_key,source_root_key,run_id,root_span_id,state,incarnation_key,prefix_sha256,prefix_bytes,source_cursor,observed_file_bytes,CASE WHEN length(CAST(data AS BLOB))<=16384 THEN data END data FROM coding_hook_sessions WHERE source_key=?").get(sourceKey) as SessionRow | null;
    if (row && (row.data === null || !isHex(row.run_id, 32) || !isHex(row.root_span_id, 16) || !isHex(row.source_root_key, 64))) refuse("corrupt", 503);
    return row;
  }
  admit(token: string, identity: string): HookAdmission {
    if (!isHex(identity, 64)) refuse("malformed", 400);
    return this.transaction(() => {
      const authority = this.authenticate(token), sourceKey = hookDigest(JSON.stringify(["runphantom.claude.session/v1", authority.sourceEpoch, authority.row.source_root_key, identity]));
      let session = this.session(sourceKey);
      if (!session) {
        const runId = sourceKey.slice(0, 32), rootSpanId = hookDigest(sourceKey + "root").slice(0, 16);
        this.db.query("INSERT INTO coding_hook_sessions VALUES(?,1,?,?,?,'open',NULL,NULL,0,0,0,?, ?,?)").run(sourceKey, authority.row.source_root_key, runId, rootSpanId, '{"coverage":"partial","producerVerified":false}', Date.now(), Date.now());
        this.checkQuota(); session = this.session(sourceKey)!;
      }
      if (session.state === "suppressed") refuse("suppressed");
      return { ownerGeneration: authority.ownerGeneration, installationGeneration: authority.row.generation, sourceKey, runId: session.run_id, rootSpanId: session.root_span_id, captureMode: authority.row.capture_mode,
        transcriptCursor: session.source_cursor, incarnationKey: session.incarnation_key, prefixBytes: session.prefix_bytes, prefixSha256: session.prefix_sha256, observedFileBytes: session.observed_file_bytes, binding: authority.binding };
    });
  }
  private checkQuota(): void {
    const count = (table: string) => (this.db.query(`SELECT count(*) count FROM ${table}`).get() as { count: number }).count;
    if (count("coding_hook_installations") > this.limits.installations || count("coding_hook_sessions") > this.limits.sessions || count("coding_hook_entities") > this.limits.entities) refuse("quota", 507);
    if (this.db.query("SELECT source_key FROM coding_hook_entities GROUP BY source_key HAVING count(*)>? LIMIT 1").get(this.limits.sessionEntities)) refuse("quota", 507);
    // Actual UTF8 state includes repeated indexed identities and paths; this is not the physical pages/WAL quota.
    const total = this.db.query(`SELECT
      COALESCE((SELECT sum(80) FROM coding_hook_owner),0)+
      COALESCE((SELECT sum(2*length(CAST(id AS BLOB))+2*length(CAST(token_sha256 AS BLOB))+length(CAST(generation||state||capture_mode||scope||COALESCE(workspace,'')||transcript_root||source_root_key||config_sha256||data AS BLOB))+8) FROM coding_hook_installations),0)+
      COALESCE((SELECT sum(2*length(CAST(source_key AS BLOB))+3*length(CAST(run_id AS BLOB))+length(CAST(source_root_key||root_span_id||state||COALESCE(incarnation_key,'')||COALESCE(prefix_sha256,'')||data AS BLOB))+40) FROM coding_hook_sessions),0)+
      COALESCE((SELECT sum(3*length(CAST(source_key AS BLOB))+2*length(CAST(entity_key AS BLOB))+2*length(CAST(span_id AS BLOB))+length(CAST(kind||phase||COALESCE(incarnation_key,'')||observation_sha256||projection_sha256||data AS BLOB))+16) FROM coding_hook_entities),0) bytes`).get() as { bytes: number };
    if (!Number.isSafeInteger(total.bytes) || total.bytes > this.limits.bytes) refuse("quota", 507);
  }
  private canonical(runId: string, spanId: string): Record<string, unknown> | null {
    const columns = ["id", "run_id", "parent_span_id", "name", "span_type", "status", "input_payload", "output_payload", "start_time_ms", "end_time_ms", "duration_ms", "model", "provider", "input_tokens", "output_tokens", "attributes", "otlp_evidence"];
    const bytes = columns.map(column => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join("+");
    const row = this.db.query(`SELECT (${bytes})<=65536 bounded,${columns.map(column => `CASE WHEN (${bytes})<=65536 THEN ${column} END ${column}`).join(",")} FROM spans WHERE run_id=? AND id=?`).get(runId, spanId) as Record<string, unknown> | null;
    if (!row) return null; if (!row.bounded) refuse("projection_conflict"); delete row.bounded; return row;
  }
  publish(token: string, admission: Pick<HookAdmission, "ownerGeneration" | "installationGeneration" | "sourceKey">, input: NormalizedClaudeBatch): { status: "accepted"; runId: string; entities: number } {
    return this.transaction(() => {
      const authority = this.authenticate(token), session = this.session(admission.sourceKey);
      if (authority.ownerGeneration !== admission.ownerGeneration || authority.row.generation !== admission.installationGeneration) refuse("stale");
      if (!session || session.source_root_key !== authority.row.source_root_key) refuse("unauthorized", 401); if (session.state === "suppressed") refuse("suppressed");
      const batch = validateClaudeBatch(JSON.stringify(input), admission.sourceKey, authority.row.capture_mode);
      if (session.incarnation_key !== null && batch.incarnationKey !== null && (batch.incarnationKey !== session.incarnation_key || session.prefix_bytes > 0 && (batch.prefixBytes !== session.prefix_bytes || batch.prefixSha256 !== session.prefix_sha256) || batch.transcriptCursor! < session.source_cursor || batch.observedFileBytes! < session.observed_file_bytes)) refuse("source_changed");
      const run = this.db.query("SELECT id FROM runs WHERE id=?").get(session.run_id);
      const entityCount = (this.db.query("SELECT count(*) count FROM coding_hook_entities WHERE source_key=?").get(session.source_key) as { count: number }).count;
      if (run && entityCount === 0) refuse("projection_conflict");
      const now = Date.now(); if (!run) this.db.query("INSERT INTO runs(id,name,started_at,last_updated_at,metadata) VALUES(?,'Claude session',?,?,?)").run(session.run_id, now, now, '{"source":"claude_hook","runtimeVerified":false,"coverage":"partial"}');
      for (const observed of batch.entities) {
        const spanId = observed.kind === "session" ? session.root_span_id : observed.entityKey.slice(0, 16);
        const priorRow = this.db.query("SELECT projection_sha256,observation_sha256,CASE WHEN length(CAST(data AS BLOB))<=16384 THEN data END data FROM coding_hook_entities WHERE source_key=? AND entity_key=?").get(session.source_key, observed.entityKey) as EntityRow | null;
        const current = this.canonical(session.run_id, spanId);
        if (priorRow ? !current || hookDigest(JSON.stringify(current)) !== priorRow.projection_sha256 : current !== null) refuse("projection_conflict");
        let next = observed;
        if (priorRow) {
          if (!priorRow.data) refuse("corrupt", 503);
          let prior: NormalizedClaudeEntity; try { prior = JSON.parse(priorRow.data); } catch { refuse("corrupt", 503); }
          if (prior.entityKey !== observed.entityKey || prior.kind !== observed.kind) refuse("corrupt", 503);
          const payload = (value: unknown) => value === null || value === undefined ? null : JSON.stringify(value);
          if (payload(prior.body?.input) !== current!.input_payload || payload(prior.body?.output) !== current!.output_payload || prior.name !== current!.name || prior.model !== current!.model) refuse("corrupt", 503);
          if (prior.sourceOffset !== null && observed.sourceOffset !== null) {
            if (prior.incarnationKey !== observed.incarnationKey) refuse("source_changed");
            if (observed.sourceOffset < prior.sourceOffset) continue;
            if (observed.sourceOffset === prior.sourceOffset && authority.row.capture_mode === "metadata") continue;
            if (observed.sourceOffset === prior.sourceOffset && hookDigest(JSON.stringify(observed)) !== priorRow.observation_sha256) refuse("source_changed");
          }
          if (terminal(prior.phase) && observed.phase === "pending" || prior.sourceKind === "transcript" && observed.sourceKind === "hook") continue;
          if (terminal(prior.phase) && terminal(observed.phase) && prior.phase !== observed.phase) next = { ...observed, phase: "conflict", coverageReasons: [...new Set([...prior.coverageReasons, ...observed.coverageReasons, "contradictory_terminal_claims"])] };
          if (authority.row.capture_mode === "metadata" && prior.body) next = { ...next, body: prior.body };
          if (observed.sourceKind === "hook" && prior.sourceKind === "hook" && terminal(prior.phase) && next.phase !== "conflict" && priorRow.observation_sha256 !== hookDigest(JSON.stringify(observed))) continue;
        }
        const retained = JSON.stringify(next); if (Buffer.byteLength(retained) > 16384) refuse("malformed", 400);
        const projection = { id: spanId, run_id: session.run_id, parent_span_id: next.kind === "session" ? null : session.root_span_id, name: next.name, span_type: next.kind === "tool" ? "tool" : next.kind === "assistant" ? "llm" : "agent",
          status: next.kind === "session" ? "UNSET" : ["failure", "interrupted", "conflict"].includes(next.phase) ? "ERROR" : next.phase === "success" ? "OK" : "UNSET", input_payload: next.body?.input === null || !next.body ? null : JSON.stringify(next.body.input), output_payload: next.body?.output === null || !next.body ? null : JSON.stringify(next.body.output),
          start_time_ms: next.reportedAt === null ? null : Date.parse(next.reportedAt), end_time_ms: null, duration_ms: null, model: next.model, provider: "anthropic", input_tokens: next.usage?.freshInputTokens ?? null, output_tokens: next.usage?.outputTokens ?? null,
          attributes: JSON.stringify({ source: "claude_hook", producerVerified: false, runtimeVerified: false, coverage: "partial", coverageReasons: next.coverageReasons, reportedPhase: next.phase, reportedDurationMs: next.reportedDurationMs, usage: next.usage, currentCapturePolicy: authority.row.capture_mode, retainedBody: next.body !== null }), otlp_evidence: null };
        const columns = Object.keys(projection), values = Object.values(projection);
        this.db.query(`INSERT INTO spans(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")}) ON CONFLICT(run_id,id) DO UPDATE SET ${columns.filter(column => !["id", "run_id"].includes(column)).map(column => `${column}=excluded.${column}`).join(",")}`).run(...values);
        this.db.query("INSERT INTO coding_hook_entities VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_key,entity_key) DO UPDATE SET phase=excluded.phase,incarnation_key=excluded.incarnation_key,source_offset=excluded.source_offset,observation_sha256=excluded.observation_sha256,projection_sha256=excluded.projection_sha256,data=excluded.data,updated_at=excluded.updated_at").run(session.source_key, next.entityKey, spanId, next.kind, next.phase, next.incarnationKey, next.sourceOffset, hookDigest(JSON.stringify(observed)), hookDigest(JSON.stringify(projection)), retained, now);
      }
      const encodeSession = () => JSON.stringify({ coverage: "partial", reasons: batch.coverageReasons, unlinkedAssertions: batch.unlinkedAssertions });
      let sessionData = encodeSession();
      if (Buffer.byteLength(sessionData) > 16384) { batch.unlinkedAssertions = null; batch.coverageReasons = [...new Set([...batch.coverageReasons, "body_partial"])]; sessionData = encodeSession(); }
      this.db.query("UPDATE coding_hook_sessions SET state=?,incarnation_key=COALESCE(?,incarnation_key),prefix_sha256=CASE WHEN ? IS NULL THEN prefix_sha256 ELSE ? END,prefix_bytes=COALESCE(?,prefix_bytes),source_cursor=COALESCE(?,source_cursor),observed_file_bytes=COALESCE(?,observed_file_bytes),data=?,updated_at=? WHERE source_key=?").run(batch.sessionClosureClaim || session.state === "closed" ? "closed" : "open", batch.incarnationKey, batch.incarnationKey, batch.prefixSha256, batch.prefixBytes, batch.transcriptCursor, batch.observedFileBytes, sessionData, now, session.source_key);
      this.db.query("UPDATE runs SET last_updated_at=? WHERE id=?").run(now, session.run_id); this.checkQuota();
      return { status: "accepted", runId: session.run_id, entities: batch.entities.length };
    });
  }
}
