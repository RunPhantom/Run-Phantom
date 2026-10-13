import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Database } from "bun:sqlite";
import type { NormalizedClaudeBatch, NormalizedClaudeEntity } from "./claude";
import { CATALOG_VERSION, CATALOG_CONTEXT_VERSION, encodeInstallationCatalog, registrationForBinding, selectRegistration, sourceRootKey, validateCatalog, type CatalogVersion, type SourceRegistration } from "./catalog";
import type { HookSourceClaims } from "./protocol";
import { parseBoundedHookJson } from "./shared";
import { claudeEntityProjection } from "./projection";
import { validateLegacySource } from "./retained-version";
import { assertHookCanonicalQuota } from "./context-integrity";
import { HookRefusal, hookDigest, isHex, refuse, validateClaudeBatch, validateClaudeRetainedEntity } from "./protocol";

export const STORE_LIMITS = Object.freeze({ installations: 64, registrations: 64, sessions: 10000, sessionEntities: 1000, entities: 100000, bytes: 33554432 });
type StoreLimits = { [Key in keyof typeof STORE_LIMITS]: number };
export interface InstallationBinding { installationId: string; scope: "global" | "local"; captureMode: "metadata" | "full"; workspace: string | null; registeredWorkspace: string; transcriptRoot: string; projectDirectory: string; homeDirectory: string; settingsPath: string; executable: string; }
interface InstallationRow { id: string; generation: string; capture_mode: "metadata" | "full"; state: "active" | "disabled"; source_root_key: string; token_sha256: string; config_sha256: string; data: string | null; }
export interface HookAdmission { ownerGeneration: string; installationGeneration: string; sourceKey: string; runId: string; rootSpanId: string; captureMode: "metadata" | "full"; transcriptCursor: number; incarnationKey: string | null; prefixBytes: number; prefixSha256: string | null; observedFileBytes: number; binding: InstallationBinding; }
interface SessionRow { source_key: string; source_root_key: string; run_id: string; root_span_id: string; state: "open" | "closed" | "unknown" | "suppressed"; incarnation_key: string | null; prefix_sha256: string | null; prefix_bytes: number; source_cursor: number; observed_file_bytes: number; data: string | null; }
interface EntityRow { data: string | null; projection_sha256: string; observation_sha256: string; span_id: string; kind: NormalizedClaudeEntity["kind"]; phase: NormalizedClaudeEntity["phase"]; incarnation_key: string | null; source_offset: number | null; }
const random = () => randomBytes(16).toString("hex");
const rootKey = sourceRootKey;
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
  constructor(readonly db: Database, limits: Partial<StoreLimits> = {}, private readonly ownerActive: () => boolean = () => false, readonly contextOptions: { contextTransport: boolean } = { contextTransport: false }) {
    this.limits = { ...STORE_LIMITS, ...limits };
    for (const key of Object.keys(STORE_LIMITS) as (keyof typeof STORE_LIMITS)[]) if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 1 || this.limits[key] > STORE_LIMITS[key]) refuse("malformed", 400);
  }
  private transaction<T>(work: () => T): T {
    let prior: number | undefined;
    try {
      prior = (this.db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
      // Hook transactions cannot spend the host callback lifetime waiting on an external writer.
      this.db.exec("PRAGMA busy_timeout=0"); return this.db.transaction(work).immediate();
    } catch (error) { if (error instanceof HookRefusal) throw error; return refuse("unavailable", 503); }
    finally { if (prior !== undefined) this.db.exec(`PRAGMA busy_timeout=${prior}`); }
  }
  beginOwner(): void { this.transaction(() => { this.requireOwner(); this.db.query("INSERT INTO coding_hook_owner VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,updated_at=excluded.updated_at").run(random(), random(), Date.now()); this.checkQuota(); }); }
  rotateOwner(): void { this.transaction(() => { this.owner(); this.db.query("UPDATE coding_hook_owner SET generation=?,updated_at=? WHERE id=1").run(random(), Date.now()); }); }
  private owner(): { generation: string; source_epoch: string } {
    this.requireOwner();
    const row = this.db.query("SELECT CASE WHEN length(generation)=32 THEN generation END generation,CASE WHEN length(source_epoch)=32 THEN source_epoch END source_epoch FROM coding_hook_owner WHERE id=1").get() as { generation: string; source_epoch: string } | null;
    if (!row || !isHex(row.generation, 32) || !isHex(row.source_epoch, 32)) refuse("inactive", 503); return row;
  }
  private requireOwner(): void { if (!this.ownerActive()) refuse("inactive", 503); }
  isOwnerActive(): boolean { try { this.owner(); return true; } catch { return false; } }
  currentOwnerGeneration(): string { return this.owner().generation; }
  private installation(id: string): InstallationRow | null {
    if (!isHex(id, 32)) refuse("malformed", 400);
    return this.db.query("SELECT id,generation,capture_mode,state,source_root_key,token_sha256,config_sha256,CASE WHEN length(CAST(data AS BLOB))<=16384 THEN data END data FROM coding_hook_installations WHERE id=?").get(id) as InstallationRow | null;
  }
  readInstallation(id: string): { row: InstallationRow; binding: InstallationBinding; registrations: SourceRegistration[]; catalogVersion: CatalogVersion } | null {
    this.checkQuota(); const row = this.installation(id); if (!row) return null;
    if (!row.data || !isHex(row.generation, 32) || !isHex(row.source_root_key, 64) || !isHex(row.token_sha256, 64) || !isHex(row.config_sha256, 64)) refuse("corrupt", 503);
    let binding: InstallationBinding, registrations: SourceRegistration[], catalogVersion: CatalogVersion;
    try {
      const parsed = parseBoundedHookJson(row.data, 16384); if (parsed.status !== "accepted" || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value) || Object.keys(parsed.value).sort().join(",") !== "binding,registrations,version" || parsed.value.version !== CATALOG_VERSION && (!this.contextOptions.contextTransport || parsed.value.version !== CATALOG_CONTEXT_VERSION)) refuse("corrupt", 503);
      catalogVersion = parsed.value.version; binding = validateInstallationBinding(parsed.value.binding as unknown as InstallationBinding); registrations = validateCatalog(binding, parsed.value.registrations as unknown as SourceRegistration[]);
      if (encodeInstallationCatalog(binding, registrations, catalogVersion) !== row.data) refuse("corrupt", 503);
    } catch { refuse("corrupt", 503); }
    if (binding.installationId !== id || binding.captureMode !== row.capture_mode || rootKey(binding) !== row.source_root_key || !["active", "disabled"].includes(row.state)) refuse("corrupt", 503);
    return { row, binding, registrations, catalogVersion };
  }
  authenticate(token: string): { row: InstallationRow; binding: InstallationBinding; registrations: SourceRegistration[]; catalogVersion: CatalogVersion; ownerGeneration: string; sourceEpoch: string } {
    if (!isHex(token, 64)) refuse("unauthorized", 401);
    this.checkQuota();
    const found = this.db.query("SELECT id FROM coding_hook_installations WHERE token_sha256=?").get(hookDigest(token)) as { id: string } | null;
    if (!found) refuse("unauthorized", 401);
    const installed = this.readInstallation(found.id); if (!installed || installed.row.state !== "active") refuse("inactive", 409);
    const owner = this.owner(); return { ...installed, ownerGeneration: owner.generation, sourceEpoch: owner.source_epoch };
  }
  prepareInstallation(binding: InstallationBinding, token: string, configSha256: string, input: SourceRegistration[] = [registrationForBinding(binding)]): { installationGeneration: string; ownerGeneration: string; unchanged: boolean } {
    binding = validateInstallationBinding(binding); const registrations = validateCatalog(binding, input); if (!isHex(token, 64) || !isHex(configSha256, 64)) refuse("malformed", 400);
    return this.transaction(() => {
      const data = encodeInstallationCatalog(binding, registrations, this.sharedCatalogVersion(binding.installationId, registrations));
      const owner = this.owner(); this.checkQuota(); const before = this.readInstallation(binding.installationId), tokenSha256 = hookDigest(token);
      if (before?.row.state === "active" && before.row.data === data && before.row.config_sha256 === configSha256 && before.row.token_sha256 === tokenSha256) return { installationGeneration: before.row.generation, ownerGeneration: owner.generation, unchanged: true };
      const generation = random();
      this.db.query("INSERT INTO coding_hook_installations VALUES(?,1,?,?,'disabled',?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,token_sha256=excluded.token_sha256,state='disabled',capture_mode=excluded.capture_mode,scope=excluded.scope,workspace=excluded.workspace,transcript_root=excluded.transcript_root,source_root_key=excluded.source_root_key,config_sha256=excluded.config_sha256,data=excluded.data,updated_at=excluded.updated_at").run(binding.installationId, generation, tokenSha256, binding.captureMode, binding.scope, binding.workspace, binding.transcriptRoot, rootKey(binding), configSha256, data, Date.now());
      this.checkQuota(); return { installationGeneration: generation, ownerGeneration: owner.generation, unchanged: false };
    });
  }
  /** Trusted management registrations inherit eligibility; callback/request bodies cannot select a version. */
  sharedCatalogVersion(id: string, registrations: SourceRegistration[]): CatalogVersion {
    if (!this.contextOptions.contextTransport) return CATALOG_VERSION;
    const ids = this.db.query("SELECT id FROM coding_hook_installations LIMIT 65").all() as { id: string }[];
    if (ids.length > 64) refuse("quota", 507);
    const shared = new Set<CatalogVersion>();
    for (const current of ids) {
      const installed = this.readInstallation(current.id); if (!installed) refuse("corrupt", 503);
      for (const root of installed.registrations) for (const candidate of registrations) {
        if (root.registrationId === candidate.registrationId && JSON.stringify(root) !== JSON.stringify(candidate)
          || root.registrationId !== candidate.registrationId && root.registeredWorkspace === candidate.registeredWorkspace) refuse("unknown_scope");
      }
      if (current.id === id || installed.registrations.some(root => registrations.some(candidate => root.registrationId === candidate.registrationId))) shared.add(installed.catalogVersion);
    }
    if (shared.size > 1) refuse("unknown_scope");
    return shared.has(CATALOG_CONTEXT_VERSION) ? CATALOG_CONTEXT_VERSION : CATALOG_VERSION;
  }
  commitInstallation(id: string, generation: string, token: string, configSha256: string, ownerGeneration: string): void {
    this.transaction(() => { if (!isHex(ownerGeneration, 32) || this.owner().generation !== ownerGeneration) refuse("stale"); const installed = this.readInstallation(id); if (!installed || installed.row.generation !== generation || installed.row.token_sha256 !== hookDigest(token) || installed.row.config_sha256 !== configSha256) refuse("stale");
      this.db.query("UPDATE coding_hook_installations SET state='active',updated_at=? WHERE id=?").run(Date.now(), id); this.checkQuota(); });
  }
  disableInstallation(id: string): void {
    this.transaction(() => { const before = this.readInstallation(id); if (!before) return;
      const binding = { ...before.binding, captureMode: "metadata" as const };
      this.db.query("UPDATE coding_hook_installations SET state='disabled',capture_mode='metadata',generation=?,token_sha256=?,data=?,updated_at=? WHERE id=?").run(random(), hookDigest(randomBytes(32).toString("hex")), encodeInstallationCatalog(binding, before.registrations, before.catalogVersion), Date.now(), id); });
  }
  fenceInstallationPreservingPolicy(id: string): void {
    this.contextTransaction(() => { const before = this.readInstallation(id); if (!before) return;
      this.db.query("UPDATE coding_hook_installations SET state='disabled',generation=?,token_sha256=?,updated_at=? WHERE id=?").run(random(), hookDigest(randomBytes(32).toString("hex")), Date.now(), id);
    });
  }
  private session(sourceKey: string): SessionRow | null {
    if (!isHex(sourceKey, 64)) refuse("malformed", 400);
    const row = this.db.query("SELECT source_key,source_root_key,run_id,root_span_id,state,incarnation_key,prefix_sha256,prefix_bytes,source_cursor,observed_file_bytes,CASE WHEN length(CAST(data AS BLOB))<=16384 THEN data END data FROM coding_hook_sessions WHERE source_key=?").get(sourceKey) as SessionRow | null;
    if (row && (row.data === null || !isHex(row.run_id, 32) || !isHex(row.root_span_id, 16) || !isHex(row.source_root_key, 64))) refuse("corrupt", 503);
    return row;
  }
  admit(token: string, identity: string, claims: HookSourceClaims): HookAdmission {
    if (!isHex(identity, 64)) refuse("malformed", 400);
    const started = performance.now(), checkDeadline = () => { if (performance.now() - started > 250) refuse("deadline", 503); };
    return this.transaction(() => {
      const authority = this.authenticate(token), registration = selectRegistration(authority.registrations, claims), sourceKey = hookDigest(JSON.stringify(["runphantom.claude.session/v1", authority.sourceEpoch, registration.registrationId, identity]));
      if (this.contextOptions.contextTransport) {
        const retainedVersion = validateLegacySource(this.db, sourceKey, registration.registrationId);
        if (retainedVersion === "context-v2" || retainedVersion === "absent" && authority.catalogVersion === CATALOG_CONTEXT_VERSION) refuse("unavailable", 409);
        assertHookCanonicalQuota(this, checkDeadline);
      }
      let session = this.session(sourceKey);
      if (!session) {
        const runId = sourceKey.slice(0, 32), rootSpanId = hookDigest(sourceKey + "root").slice(0, 16);
        this.db.query("INSERT INTO coding_hook_sessions VALUES(?,1,?,?,?,'open',NULL,NULL,0,0,0,?, ?,?)").run(sourceKey, registration.registrationId, runId, rootSpanId, '{"coverage":"partial","producerVerified":false}', Date.now(), Date.now());
        this.checkQuota(); session = this.session(sourceKey)!;
      }
      if (session.state === "suppressed") refuse("suppressed");
      if (this.contextOptions.contextTransport) { assertHookCanonicalQuota(this, checkDeadline); checkDeadline(); }
      return { ownerGeneration: authority.ownerGeneration, installationGeneration: authority.row.generation, sourceKey, runId: session.run_id, rootSpanId: session.root_span_id, captureMode: authority.row.capture_mode,
        transcriptCursor: session.source_cursor, incarnationKey: session.incarnation_key, prefixBytes: session.prefix_bytes, prefixSha256: session.prefix_sha256, observedFileBytes: session.observed_file_bytes, binding: { ...authority.binding, registeredWorkspace: registration.registeredWorkspace, transcriptRoot: registration.transcriptRoot, projectDirectory: registration.projectDirectory, homeDirectory: registration.homeDirectory } };
    });
  }
  contextTransaction<T>(work: () => T): T {
    if (!this.contextOptions.contextTransport) refuse("inactive", 503);
    return this.transaction(work);
  }
  assertContextQuota(canonicalBytes: number): void {
    if (!this.contextOptions.contextTransport || !Number.isSafeInteger(canonicalBytes) || canonicalBytes < 0) refuse("inactive", 503);
    if (this.checkQuota() + canonicalBytes > this.limits.bytes) refuse("quota", 507);
  }
  private checkQuota(): number {
    const count = (table: string) => (this.db.query(`SELECT count(*) count FROM ${table}`).get() as { count: number }).count;
    if (count("coding_hook_installations") > this.limits.installations || count("coding_hook_sessions") > this.limits.sessions || count("coding_hook_entities") > this.limits.entities) refuse("quota", 507);
    const registrations = this.db.query("SELECT COALESCE(sum(CASE WHEN length(CAST(data AS BLOB))>16384 OR NOT json_valid(data) THEN 65 WHEN json_type(data,'$.registrations')='array' THEN json_array_length(data,'$.registrations') ELSE 65 END),0) count FROM coding_hook_installations").get() as { count: number };
    if (!Number.isSafeInteger(registrations.count) || registrations.count > this.limits.registrations) refuse("quota", 507);
    if (this.db.query("SELECT source_key FROM coding_hook_entities GROUP BY source_key HAVING count(*)>? LIMIT 1").get(this.limits.sessionEntities)) refuse("quota", 507);
    // Actual UTF8 state includes repeated indexed identities and paths; this is not the physical pages/WAL quota.
    const total = this.db.query(`SELECT
      COALESCE((SELECT sum(80) FROM coding_hook_owner),0)+
      COALESCE((SELECT sum(2*length(CAST(id AS BLOB))+2*length(CAST(token_sha256 AS BLOB))+length(CAST(generation||state||capture_mode||scope||COALESCE(workspace,'')||transcript_root||source_root_key||config_sha256||data AS BLOB))+8) FROM coding_hook_installations),0)+
      COALESCE((SELECT sum(2*length(CAST(source_key AS BLOB))+3*length(CAST(run_id AS BLOB))+length(CAST(source_root_key||root_span_id||state||COALESCE(incarnation_key,'')||COALESCE(prefix_sha256,'')||data AS BLOB))+40) FROM coding_hook_sessions),0)+
      COALESCE((SELECT sum(3*length(CAST(source_key AS BLOB))+2*length(CAST(entity_key AS BLOB))+2*length(CAST(span_id AS BLOB))+length(CAST(kind||phase||COALESCE(incarnation_key,'')||observation_sha256||projection_sha256||data AS BLOB))+16) FROM coding_hook_entities),0) bytes`).get() as { bytes: number };
    if (!Number.isSafeInteger(total.bytes) || total.bytes > this.limits.bytes) refuse("quota", 507);
    return total.bytes;
  }
  private canonical(runId: string, spanId: string): Record<string, unknown> | null {
    const columns = ["id", "run_id", "parent_span_id", "name", "span_type", "status", "input_payload", "output_payload", "start_time_ms", "end_time_ms", "duration_ms", "model", "provider", "input_tokens", "output_tokens", "attributes", "otlp_evidence"];
    const bytes = columns.map(column => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join("+");
    const row = this.db.query(`SELECT (${bytes})<=65536 bounded,${columns.map(column => `CASE WHEN (${bytes})<=65536 THEN ${column} END ${column}`).join(",")} FROM spans WHERE run_id=? AND id=?`).get(runId, spanId) as Record<string, unknown> | null;
    if (!row) return null; if (!row.bounded) refuse("projection_conflict"); delete row.bounded; return row;
  }
  private validatePrior(row: EntityRow, current: Record<string, unknown>, session: SessionRow, entityKey: string): NormalizedClaudeEntity {
    if (!row.data || !isHex(row.observation_sha256, 64) || !isHex(row.projection_sha256, 64)) refuse("corrupt", 503);
    if (hookDigest(JSON.stringify(current)) !== row.projection_sha256) refuse("projection_conflict");
    const prior = validateClaudeRetainedEntity(row.data, session.source_key, session.incarnation_key, session.source_cursor);
    const spanId = prior.kind === "session" ? session.root_span_id : prior.entityKey.slice(0, 16);
    if (prior.entityKey !== entityKey || row.span_id !== spanId || row.kind !== prior.kind || row.phase !== prior.phase
      || row.incarnation_key !== prior.incarnationKey || row.source_offset !== prior.sourceOffset) refuse("corrupt", 503);
    const attrs = parseBoundedHookJson(current.attributes, 16384);
    if (attrs.status !== "accepted" || !attrs.value || typeof attrs.value !== "object" || Array.isArray(attrs.value)
      || !isHex(attrs.value.retainedEntitySha256, 64) || attrs.value.retainedEntitySha256 !== hookDigest(row.data)) refuse("corrupt", 503);
    return prior;
  }
  private upgradeLegacyProjections(session: SessionRow, checkDeadline: () => void): void {
    const rows = this.db.query("SELECT entity_key,span_id,kind,phase,incarnation_key,source_offset,projection_sha256,observation_sha256,CASE WHEN length(CAST(data AS BLOB))<=16384 THEN data END data FROM coding_hook_entities WHERE source_key=? ORDER BY entity_key LIMIT 1001").all(session.source_key) as (EntityRow & { entity_key: string })[];
    if (rows.length > 1000) refuse("quota", 507);
    for (const row of rows) {
      checkDeadline(); const current = this.canonical(session.run_id, row.span_id); if (!current) refuse("projection_conflict");
      const prior = this.validatePrior(row, current, session, row.entity_key); checkDeadline();
      if (!['tool', 'llm', 'agent'].includes(current.span_type as string)) continue;
      const decoded = parseBoundedHookJson(current.attributes, 16384);
      if (decoded.status !== "accepted" || !decoded.value || typeof decoded.value !== "object" || Array.isArray(decoded.value)) refuse("corrupt", 503);
      const mode = decoded.value.currentCapturePolicy;
      if (mode !== "full" && mode !== "metadata") refuse("corrupt", 503);
      const projection = claudeEntityProjection(prior, { runId: session.run_id, rootSpanId: session.root_span_id }, mode, row.data!);
      const oldAttrs = JSON.parse(projection.attributes);
      delete oldAttrs.captureContract; delete oldAttrs.entityKind; delete oldAttrs.sourceKind; delete oldAttrs.captureModel;
      const expected = { ...projection, span_type: prior.kind === "tool" ? "tool" : prior.kind === "assistant" ? "llm" : "agent", attributes: JSON.stringify(oldAttrs) };
      // The old canonical projection must agree with every retained field, not only a self-reported type label.
      if (JSON.stringify(expected) !== JSON.stringify(current)) refuse("corrupt", 503);
      checkDeadline();
      const columns = Object.keys(projection).filter(column => !["id", "run_id"].includes(column));
      this.db.query(`UPDATE spans SET ${columns.map(column => `${column}=?`).join(",")} WHERE run_id=? AND id=?`).run(...columns.map(column => projection[column as keyof typeof projection]), session.run_id, row.span_id);
      this.db.query("UPDATE coding_hook_entities SET projection_sha256=? WHERE source_key=? AND entity_key=?").run(hookDigest(JSON.stringify(projection)), session.source_key, row.entity_key);
      checkDeadline();
    }
  }
  publish(token: string, admission: Pick<HookAdmission, "ownerGeneration" | "installationGeneration" | "sourceKey">, input: NormalizedClaudeBatch): { status: "accepted"; runId: string; entities: number } {
    const started = performance.now(), checkDeadline = () => { if (performance.now() - started > 250) refuse("deadline", 503); };
    return this.transaction(() => {
      checkDeadline();
      const authority = this.authenticate(token), session = this.session(admission.sourceKey);
      if (authority.ownerGeneration !== admission.ownerGeneration || authority.row.generation !== admission.installationGeneration) refuse("stale");
      if (!session || !authority.registrations.some(registration => registration.registrationId === session.source_root_key)) refuse("unauthorized", 401); if (session.state === "suppressed") refuse("suppressed");
      if (this.contextOptions.contextTransport && validateLegacySource(this.db, session.source_key, session.source_root_key) === "context-v2") refuse("corrupt", 503);
      if (this.contextOptions.contextTransport) assertHookCanonicalQuota(this, checkDeadline);
      const batch = validateClaudeBatch(JSON.stringify(input), admission.sourceKey, authority.row.capture_mode);
      this.upgradeLegacyProjections(session, checkDeadline);
      if (session.incarnation_key !== null && batch.incarnationKey !== null && (batch.incarnationKey !== session.incarnation_key || session.prefix_bytes > 0 && (batch.prefixBytes !== session.prefix_bytes || batch.prefixSha256 !== session.prefix_sha256) || batch.transcriptCursor! < session.source_cursor || batch.observedFileBytes! < session.observed_file_bytes)) refuse("source_changed");
      const run = this.db.query("SELECT id FROM runs WHERE id=?").get(session.run_id);
      const entityCount = (this.db.query("SELECT count(*) count FROM coding_hook_entities WHERE source_key=?").get(session.source_key) as { count: number }).count;
      if (run && entityCount === 0) refuse("projection_conflict");
      const now = Date.now(); if (!run) this.db.query("INSERT INTO runs(id,name,started_at,last_updated_at,metadata) VALUES(?,'Claude session',?,?,?)").run(session.run_id, now, now, '{"source":"claude_hook","runtimeVerified":false,"coverage":"partial"}');
      for (const observed of batch.entities) {
        checkDeadline();
        const spanId = observed.kind === "session" ? session.root_span_id : observed.entityKey.slice(0, 16);
        const priorRow = this.db.query("SELECT span_id,kind,phase,incarnation_key,source_offset,projection_sha256,observation_sha256,CASE WHEN length(CAST(data AS BLOB))<=16384 THEN data END data FROM coding_hook_entities WHERE source_key=? AND entity_key=?").get(session.source_key, observed.entityKey) as EntityRow | null;
        const current = this.canonical(session.run_id, spanId);
        if (priorRow ? !current || hookDigest(JSON.stringify(current)) !== priorRow.projection_sha256 : current !== null) refuse("projection_conflict");
        let next = observed;
        if (priorRow) {
          const prior = this.validatePrior(priorRow, current!, session, observed.entityKey);
          if (prior.kind !== observed.kind) refuse("corrupt", 503);
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
        const projection = claudeEntityProjection(next, { runId: session.run_id, rootSpanId: session.root_span_id }, authority.row.capture_mode, retained);
        const columns = Object.keys(projection), values = Object.values(projection);
        this.db.query(`INSERT INTO spans(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")}) ON CONFLICT(run_id,id) DO UPDATE SET ${columns.filter(column => !["id", "run_id"].includes(column)).map(column => `${column}=excluded.${column}`).join(",")}`).run(...values);
        this.db.query("INSERT INTO coding_hook_entities VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_key,entity_key) DO UPDATE SET phase=excluded.phase,incarnation_key=excluded.incarnation_key,source_offset=excluded.source_offset,observation_sha256=excluded.observation_sha256,projection_sha256=excluded.projection_sha256,data=excluded.data,updated_at=excluded.updated_at").run(session.source_key, next.entityKey, spanId, next.kind, next.phase, next.incarnationKey, next.sourceOffset, hookDigest(JSON.stringify(observed)), hookDigest(JSON.stringify(projection)), retained, now);
      }
      const encodeSession = () => JSON.stringify({ coverage: "partial", reasons: batch.coverageReasons, unlinkedAssertions: batch.unlinkedAssertions });
      let sessionData = encodeSession();
      if (Buffer.byteLength(sessionData) > 16384) { batch.unlinkedAssertions = null; batch.coverageReasons = [...new Set([...batch.coverageReasons, "body_partial"])]; sessionData = encodeSession(); }
      this.db.query("UPDATE coding_hook_sessions SET state=?,incarnation_key=COALESCE(?,incarnation_key),prefix_sha256=CASE WHEN ? IS NULL THEN prefix_sha256 ELSE ? END,prefix_bytes=COALESCE(?,prefix_bytes),source_cursor=COALESCE(?,source_cursor),observed_file_bytes=COALESCE(?,observed_file_bytes),data=?,updated_at=? WHERE source_key=?").run(batch.sessionClosureClaim || session.state === "closed" ? "closed" : "open", batch.incarnationKey, batch.incarnationKey, batch.prefixSha256, batch.prefixBytes, batch.transcriptCursor, batch.observedFileBytes, sessionData, now, session.source_key);
      this.db.query("UPDATE runs SET last_updated_at=? WHERE id=?").run(now, session.run_id); this.checkQuota(); if (this.contextOptions.contextTransport) assertHookCanonicalQuota(this, checkDeadline); checkDeadline();
      return { status: "accepted", runId: session.run_id, entities: batch.entities.length };
    });
  }
}
