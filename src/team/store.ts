import { Database, type SQLQueryBindings } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SnapshotRun, SnapshotSpan } from "../evaluations/protocol";
import { snapshotRun } from "../evaluations/snapshot";
import { canonicalCaseDefinitions, parseVersion } from "../evaluations/validation";
import { REVIEW_LIMITS as R, type ReviewCounts, type ReviewItemSummary } from "../review-queues/protocol";
import { approvalHash } from "../review-queues/state";
import { canonicalReviewJson, freezeReviewSource, reviewHash, reviewItemId, reviewCaseId, reviewTimestamp } from "../review-queues/validation";
import { assertTeamReviewItem, createTeamReviewItem, mutateTeamReviewItem, promoteTeamReviewItem, compileTeamReviewCase,
  parseTeamReviewQueue, parseTeamReviewDataset, parseTeamReviewInsert, parseTeamReviewPromotion, parseTeamReviewStored, parseTeamReviewCases, parseTeamReviewReceipt,
  TEAM_REVIEW_ITEM_BYTES, TEAM_REVIEW_REVISION_BYTES,
  type TeamReviewQueue, type TeamReviewItem, type TeamReviewDataset, type TeamReviewDatasetRevision, type TeamReviewReceipt } from "./review-queues";
import { initializeTeamSchema } from "./store-schema";
import type { IncomingMessage } from "node:http";
import { TeamEvidence, teamEvidenceAccess, type TeamEvidenceRead, type TeamEvidenceWrite, type TeamEvidenceResponse } from "./evidence";
import { EvidenceStore } from "../evaluations/evidence-store";
import { PromptRegistry } from "../prompts/registry";
import type { PromptCapability, PromptFence } from "../prompts/protocol";
import { createComparisonRuntime, type ComparisonRuntime, type ComparisonRuntimeOptions } from "../prompts/comparison-runtime";
import type { ComparisonFence, ComparisonStore } from "../prompts/comparison-store";
import { readTeamComparison, writeTeamComparison, teamComparisonOperation, type TeamComparisonRead, type TeamComparisonWrite, type TeamComparisonResponse } from "./comparisons";
import { readTeamPrompt, writeTeamPrompt, teamPromptOperation, type TeamPromptRead, type TeamPromptWrite, type TeamPromptResponse } from "./prompts";
import { EvidenceError, type EvidenceCapability, type EvidenceAttachment } from "../evaluations/evidence-protocol";
import type { EvidenceOwner, EvidenceInventoryAnchor, EvidenceAnchorIdentity } from "../evaluations/evidence-inventory";
import { evidenceInteger, parseEvidenceAttachment, parseEvidenceScope } from "../evaluations/evidence-validation";
import { assertTeamIngestBatch, redactTeamText, type TeamIngestBatch } from "./ingest";
import { TeamError } from "./errors";
import { bytes, digest, requiredEmail, requiredHash, requiredId, requiredName, requiredRole, lifetime, pageInput, pageResult, type Paging } from "./store-utils";
import { searchTeamRuns } from "./search";
import { searchSpanHits, searchSuggestions, SearchResourceError, type SearchHitPage, type SearchSuggestionResult } from "../search-resources";
import { TEAM_LIMITS as L, type Account, type Actor, type SessionInfo, type Project, type Role, type PageQuery, type Page, type Member, type Invite, type InviteCreate, type IngestKey, type KeyCreate, type RunSummary, type RunFilters, type RunDetail, type Span, type SpanSummary, type Note, type NoteCreate, type Metrics, type Check, type CheckSummary, type CheckReport, type AuditEvent, type AuditPage } from "./protocol";

export interface SessionContext {
  readonly tokenHash: string;
  readonly user: Readonly<Account>;
  readonly session: Readonly<SessionInfo>;
  readonly requestId: string;
}
export interface ProjectContext extends SessionContext { readonly projectId: string; readonly role: Role }
export interface IngestContext { readonly tokenHash: string; readonly keyId: string; readonly projectId: string; readonly requestId: string }
export interface AccountCredential { user: Account; passwordHash: string }
interface AccountRow { id: string; email: string; password_hash: string; is_owner: number; created_at: number }
interface SessionRow { id: string; account_id: string; token_hash: string; created_at: number; last_active_at: number; expires_at: number; idle_expires_at: number }
interface ProjectRow { id: string; name: string; created_at: number; evidence_bytes: number; run_count: number; span_count: number; check_count: number; audit_pruned: number }
interface InviteRow { id: string; project_id: string; email: string; role: Role; issuer_id: string; token_hash: string; created_at: number; expires_at: number }
interface KeyRow { id: string; project_id: string; label: string; prefix: string; creator_id: string; token_hash: string; created_at: number; expires_at: number; last_used_at: number | null }
interface DataRow { data: string; byte_size: number }
export interface CheckEvidence { author: Actor; acquiredAt: number; runs: Array<{ run: SnapshotRun; spans: SnapshotSpan[] }> }
export const hashTeamToken = digest;
const permission: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };
const unauthorized = () => new TeamError("unauthenticated", "Authentication required");
const missing = () => new TeamError("not_found", "Resource not found");
const quota = () => new TeamError("quota_exceeded", "The project or account storage limit has been reached");
const forbidden = () => new TeamError("forbidden", "This action is not permitted");
const invalidInvite = () => new TeamError("invalid_request", "The invitation cannot be accepted");
const requestId = (id?: string) => id && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : randomUUID();
const accountView = (row: AccountRow): Account => ({ id: row.id, email: row.email, isOwner: row.is_owner === 1, createdAt: row.created_at });
const sessionView = (row: SessionRow, current: string): SessionInfo => ({ id: row.id, current: row.id === current, createdAt: row.created_at, lastActiveAt: row.last_active_at, expiresAt: row.expires_at, idleExpiresAt: row.idle_expires_at });

/** Owns every team SQL operation. No raw connection or unscoped project query is exposed. */
export class TeamStore {
  readonly #db: Database;
  readonly #path: string;
  readonly #now: () => number;
  readonly #evidence: TeamEvidence;
  #comparisons: ComparisonRuntime | null = null;
  #comparisonStart: Promise<void> | undefined;
  #closed = false;

  constructor(path: string, options: { bootstrapHash?: string; now?: () => number } = {}) {
    this.#path = resolve(path);
    this.#now = options.now ?? Date.now;
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    this.#db = new Database(this.#path, { create: true, strict: true });
    try {
      chmodSync(this.#path, 0o600);
      this.#db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=1000;");
      initializeTeamSchema(this.#db);
      this.#evidence = new TeamEvidence(this.#db);
      this.#write(() => { /* Startup removes expired bounded credential records. */ });
      if (options.bootstrapHash) this.setBootstrapHash(options.bootstrapHash);
    } catch (error) { this.#db.close(); this.#closed = true; throw error; }
  }
  close(): void {
    if (!this.#closed) {
      if (this.#comparisons) throw new TeamError("conflict", "Comparison work must stop before the database closes");
      const state = this.#evidence.state;
      if (state.active || state.queued || state.acquiringMetadata) throw new TeamError("conflict", "Evidence work must stop before the database closes");
      this.#db.close(); this.#closed = true;
    }
  }
  shutdownEvidence(): Promise<void> { return this.#evidence.close(); }
  /** Trusted server startup only. Native acquisition and recovery happen once before listening. */
  startComparisons(options: ComparisonRuntimeOptions = {}): Promise<void> {
    this.#comparisonStart ??= (async () => {
      if (this.#closed) throw new TeamError("conflict", "The project store is closed");
      try {
        const runtime = await createComparisonRuntime(this.#db, options);
        if (this.#closed) { await runtime.close(); return; }
        this.#comparisons = runtime;
      } catch { this.#comparisons = null; }
    })();
    return this.#comparisonStart;
  }
  async shutdownComparisons(): Promise<void> { await this.#comparisonStart; if (this.#comparisons) { await this.#comparisons.close(); this.#comparisons = null; } }
  #get<T>(sql: string, ...params: SQLQueryBindings[]): T | null { return this.#db.query(sql).get(...params) as T | null; }
  #all<T>(sql: string, ...params: SQLQueryBindings[]): T[] { return this.#db.query(sql).all(...params) as T[]; }
  #run(sql: string, ...params: SQLQueryBindings[]): void { this.#db.query(sql).run(...params); }
  #count(sql: string, ...params: SQLQueryBindings[]): number { return this.#get<{ n: number }>(sql, ...params)?.n ?? 0; }
  #write<T>(operation: () => T): T {
    return this.#db.transaction(() => { this.#cleanup(); return operation(); }).immediate();
  }
  #cleanup(): void {
    const now = this.#now();
    this.#run("DELETE FROM sessions WHERE expires_at<=? OR idle_expires_at<=?", now, now);
    this.#run("DELETE FROM invites WHERE expires_at<=?", now);
    this.#run("DELETE FROM ingest_keys WHERE expires_at<=?", now);
  }
  #operational(action: string, accountId: string | null, id: string): void {
    this.#run("INSERT INTO operational_events(created_at,account_id,action,request_id) VALUES(?,?,?,?)", this.#now(), accountId, action, id);
    this.#run("DELETE FROM operational_events WHERE sequence IN (SELECT sequence FROM operational_events ORDER BY sequence DESC LIMIT -1 OFFSET ?)", L.PROJECT_AUDIT);
  }
  setupRequired(): boolean { return this.#get<{ value: string }>("SELECT value FROM team_meta WHERE key='initialized'")?.value !== "1"; }
  setBootstrapHash(hash: string): void {
    requiredHash(hash);
    this.#write(() => { if (this.setupRequired()) this.#run("INSERT OR IGNORE INTO team_meta(key,value) VALUES('bootstrap_hash',?)", hash); });
  }
  getAccountByEmail(email: string): AccountCredential | null {
    requiredEmail(email);
    const row = this.#get<AccountRow>("SELECT * FROM accounts WHERE email=?", email);
    return row ? { user: accountView(row), passwordHash: row.password_hash } : null;
  }
  #session(hash: string, id: string, touch = false): SessionContext | null {
    const now = this.#now();
    const session = this.#get<SessionRow>("SELECT * FROM sessions WHERE token_hash=? AND expires_at>? AND idle_expires_at>?", hash, now, now);
    if (!session) return null;
    const account = this.#get<AccountRow>("SELECT * FROM accounts WHERE id=?", session.account_id);
    if (!account) return null;
    if (touch) {
      session.last_active_at = now;
      session.idle_expires_at = Math.min(session.expires_at, now + L.SESSION_IDLE_MS);
      this.#run("UPDATE sessions SET last_active_at=?,idle_expires_at=? WHERE id=?", now, session.idle_expires_at, session.id);
    }
    return Object.freeze({ tokenHash: hash, user: Object.freeze(accountView(account)), session: Object.freeze(sessionView(session, session.id)), requestId: id });
  }
  getSession(tokenHash: string, id?: string): SessionContext | null {
    requiredHash(tokenHash);
    return this.#write(() => this.#session(tokenHash, requestId(id), true));
  }
  #authorize(context: SessionContext): SessionContext {
    const current = this.#session(context.tokenHash, context.requestId);
    if (!current || current.user.id !== context.user.id || current.session.id !== context.session.id) throw unauthorized();
    return current;
  }
  #issueSession(accountId: string, hash: string, id: string): SessionContext {
    requiredHash(hash);
    if (this.#count("SELECT COUNT(*) AS n FROM sessions WHERE account_id=?", accountId) >= L.USER_SESSIONS) throw quota();
    const now = this.#now();
    this.#run("INSERT INTO sessions(id,account_id,token_hash,created_at,last_active_at,expires_at,idle_expires_at) VALUES(?,?,?,?,?,?,?)", randomUUID(), accountId, hash, now, now, now + L.SESSION_ABSOLUTE_MS, now + L.SESSION_IDLE_MS);
    return this.#session(hash, id)!;
  }
  setupOwner(input: { setupCodeHash: string; email: string; passwordHash: string; sessionHash: string; requestId?: string }): SessionContext {
    requiredEmail(input.email); requiredHash(input.setupCodeHash);
    return this.#write(() => {
      if (!this.setupRequired()) throw new TeamError("conflict", "Setup has already completed");
      if (this.#get<{ value: string }>("SELECT value FROM team_meta WHERE key='bootstrap_hash'")?.value !== input.setupCodeHash) throw unauthorized();
      const id = randomUUID(), rid = requestId(input.requestId);
      this.#run("INSERT INTO accounts(id,email,password_hash,is_owner,created_at) VALUES(?,?,?,1,?)", id, input.email, input.passwordHash, this.#now());
      this.#run("UPDATE team_meta SET value='1' WHERE key='initialized'");
      this.#run("DELETE FROM team_meta WHERE key='bootstrap_hash'");
      const context = this.#issueSession(id, input.sessionHash, rid);
      this.#operational("setup", id, rid);
      return context;
    });
  }
  loginSession(input: { accountId: string; passwordHash: string; sessionHash: string; requestId?: string }): SessionContext {
    return this.#write(() => {
      const account = this.#get<AccountRow>("SELECT * FROM accounts WHERE id=? AND password_hash=?", input.accountId, input.passwordHash);
      if (!account) throw unauthorized();
      const rid = requestId(input.requestId), context = this.#issueSession(account.id, input.sessionHash, rid);
      this.#operational("login", account.id, rid);
      return context;
    });
  }
  changePassword(context: SessionContext, input: { currentPasswordHash: string; newPasswordHash: string; sessionHash: string }): SessionContext {
    return this.#write(() => {
      const current = this.#authorize(context);
      const account = this.#get<AccountRow>("SELECT * FROM accounts WHERE id=? AND password_hash=?", current.user.id, input.currentPasswordHash);
      if (!account) throw unauthorized();
      this.#run("UPDATE accounts SET password_hash=? WHERE id=?", input.newPasswordHash, account.id);
      this.#run("DELETE FROM sessions WHERE account_id=?", account.id);
      const replacement = this.#issueSession(account.id, input.sessionHash, current.requestId);
      this.#operational("password.changed", account.id, current.requestId);
      return replacement;
    });
  }
  listSessions(context: SessionContext): SessionInfo[] {
    const current = this.#authorize(context), now = this.#now();
    return this.#all<SessionRow>("SELECT * FROM sessions WHERE account_id=? AND expires_at>? AND idle_expires_at>? ORDER BY created_at DESC,id DESC LIMIT ?", current.user.id, now, now, L.USER_SESSIONS).map(row => sessionView(row, current.session.id));
  }
  revokeSession(context: SessionContext, id: string): void {
    requiredId(id);
    this.#write(() => {
      const current = this.#authorize(context);
      if (!this.#get("SELECT id FROM sessions WHERE id=? AND account_id=?", id, current.user.id)) throw missing();
      this.#run("DELETE FROM sessions WHERE id=? AND account_id=?", id, current.user.id);
      this.#operational("session.revoked", current.user.id, current.requestId);
    });
  }
  logout(context: SessionContext): void { this.revokeSession(context, context.session.id); }

  projectScope(context: SessionContext, projectId: string, minRole: Role = "viewer"): ProjectContext {
    requiredId(projectId); requiredRole(minRole);
    const current = this.#authorize(context);
    const membership = this.#get<{ role: Role }>("SELECT m.role FROM memberships m JOIN projects p ON p.id=m.project_id WHERE m.project_id=? AND m.account_id=?", projectId, current.user.id);
    if (!membership) throw missing();
    if (permission[membership.role] < permission[minRole]) throw forbidden();
    return Object.freeze({ ...current, projectId, role: membership.role });
  }
  #project(scope: ProjectContext, role: Role = "viewer"): ProjectContext { return this.projectScope(scope, scope.projectId, role); }
  #evidenceAnchor(context: ProjectContext, value: EvidenceInventoryAnchor): EvidenceAnchorIdentity {
    const scope = this.#project(context);
    if (value.kind === "dataset_revision" || value.kind === "experiment") throw new EvidenceError("This Team evidence attachment is unsupported");
    const anchor = parseEvidenceAttachment(value);
    const row = anchor.kind === "check"
      ? this.#get<{ recordId: string; projectId: string; createdAt: number }>("SELECT json_extract(data,'$.id') AS recordId,json_extract(data,'$.projectId') AS projectId,created_at AS createdAt FROM checks WHERE project_id=? AND id=?", scope.projectId, anchor.id)
      : this.#get<{ recordId: string; createdAt: number }>("SELECT json_extract(data,'$.id') AS recordId,json_extract(data,'$.firstSeenAt') AS createdAt FROM runs WHERE project_id=? AND id=?", scope.projectId, anchor.id);
    if (!row) throw missing();
    if (row.recordId !== anchor.id || "projectId" in row && row.projectId !== scope.projectId) throw new EvidenceError("Stored attachment identity changed", 409);
    return { anchor, createdAt: evidenceInteger(row.createdAt, "attachment creation time") };
  }
  #evidenceOwner(context: ProjectContext): EvidenceOwner {
    const current = this.#project(context), scope = parseEvidenceScope({ kind: "project", id: current.projectId });
    const authorize = (capability: EvidenceCapability, attachment: EvidenceAttachment | null) => {
      const fresh = this.#project(context);
      if (!teamEvidenceAccess(fresh.role).includes(capability)) throw forbidden();
      if (attachment) this.#evidenceAnchor(fresh, attachment);
      return { actorId: fresh.user.id };
    };
    return { database: this.#db, scope, authorize, resolveAnchor: anchor => this.#evidenceAnchor(context, anchor),
      store: new EvidenceStore(this.#db, scope, { now: this.#now, maxRawBytes: 64 * 1024 * 1024, maxNormalizedBytes: 32 * 1024 * 1024,
        authorize: (capability, actualScope, attachment) => {
          if (actualScope.kind !== "project" || actualScope.id !== current.projectId) throw missing();
          return authorize(capability, attachment);
        } }) };
  }
  evidenceAccess(context: ProjectContext, capability: EvidenceCapability = "normalized_read"): void {
    this.#db.transaction(() => this.#evidenceOwner(context).authorize(capability, null)).immediate();
  }
  readEvidence(context: ProjectContext, input: TeamEvidenceRead): TeamEvidenceResponse {
    return this.#db.transaction(() => {
      const fresh = this.#project(context);
      return this.#evidence.read(this.#evidenceOwner(fresh), input, teamEvidenceAccess(fresh.role));
    }).immediate();
  }
  writeEvidence(context: ProjectContext, input: TeamEvidenceWrite): Promise<TeamEvidenceResponse> { return this.#evidence.write(this.#evidenceOwner(context), input); }
  receiveEvidence(context: ProjectContext, request: IncomingMessage): Promise<TeamEvidenceResponse> { return this.#evidence.receive(this.#evidenceOwner(context), request); }
  evidenceGeneration(context: ProjectContext): number { return this.#db.transaction(() => this.#evidence.generation(this.#evidenceOwner(context))).immediate(); }
  assertEvidenceCurrent(context: ProjectContext, generation: number): void { this.#evidence.assertCurrent(this.#evidenceOwner(context), generation); }
  #promptRegistry(context: ProjectContext): PromptRegistry {
    const current = this.#project(context);
    return new PromptRegistry({ database: this.#db, scope: { kind: "project", id: current.projectId }, authorize: capability => {
      this.#project(context, capability === "delete" ? "admin" : capability === "edit" ? "editor" : "viewer");
    } });
  }
  promptGeneration(context: ProjectContext, capability: PromptCapability): PromptFence {
    return teamPromptOperation(() => this.#promptRegistry(context).capture(capability));
  }
  readPrompt(context: ProjectContext, input: TeamPromptRead, generation: PromptFence): TeamPromptResponse {
    return readTeamPrompt(this.#promptRegistry(context), input, generation);
  }
  writePrompt(context: ProjectContext, input: TeamPromptWrite, generation: PromptFence): TeamPromptResponse {
    return writeTeamPrompt(this.#promptRegistry(context), input, generation);
  }
  #comparisonStore(context: ProjectContext): ComparisonStore {
    const current = this.#project(context);
    if (!this.#comparisons) throw new TeamError("conflict", "Model comparisons are unavailable for this native owner");
    return this.#comparisons.scope({ database: this.#db, scope: { kind: "project", id: current.projectId }, authorize: capability => {
      this.#project(context, capability === "delete" ? "admin" : capability === "edit" ? "editor" : "viewer");
    } });
  }
  comparisonGeneration(context: ProjectContext, capability: PromptCapability): ComparisonFence {
    return teamComparisonOperation(() => this.#comparisonStore(context).capture(capability));
  }
  readComparison(context: ProjectContext, input: TeamComparisonRead, fence: ComparisonFence): TeamComparisonResponse {
    return readTeamComparison(this.#comparisonStore(context), input, fence);
  }
  writeComparison(context: ProjectContext, input: TeamComparisonWrite, fence: ComparisonFence): TeamComparisonResponse {
    return writeTeamComparison(this.#comparisonStore(context), this.#comparisons!.coordinator, input, fence);
  }
  async invalidateEvidenceRun(context: ProjectContext, id: string): Promise<void> {
    this.#db.transaction(() => { this.#project(context, "admin"); this.#evidenceAnchor(context, { kind: "run", id }); }).immediate();
    await this.#evidence.invalidateRun(this.#evidenceOwner(context), id);
  }
  #projectView(row: ProjectRow, role: Role): Project { return { id: row.id, name: row.name, createdAt: row.created_at, role }; }
  #paging(query: PageQuery | undefined, project: string, endpoint: string): Paging { return pageInput(query, digest(JSON.stringify([project, endpoint]))); }
  #anchor(paging: Paging, timestamp: string, id: string): { sql: string; args: SQLQueryBindings[] } {
    if (!paging.anchor) return { sql: "", args: [] };
    if (paging.anchor[0] === null) throw new TeamError("invalid_request", "Invalid page cursor");
    return { sql: ` AND (${timestamp}<? OR (${timestamp}=? AND ${id}<?))`, args: [paging.anchor[0], paging.anchor[0], paging.anchor[1]] };
  }
  listProjects(context: SessionContext, query?: PageQuery): Page<Project> {
    const current = this.#authorize(context), paging = this.#paging(query, current.user.id, "projects"), anchor = this.#anchor(paging, "p.created_at", "p.id");
    const rows = this.#all<ProjectRow & { role: Role }>(`SELECT p.*,m.role FROM projects p JOIN memberships m ON m.project_id=p.id WHERE m.account_id=?${anchor.sql} ORDER BY p.created_at DESC,p.id DESC LIMIT ?`, current.user.id, ...anchor.args, paging.limit + 1);
    return pageResult(rows.map(row => this.#projectView(row, row.role)), paging, row => [row.createdAt, row.id]);
  }
  createProject(context: SessionContext, input: { name: string }): Project {
    const name = requiredName(input.name);
    return this.#write(() => {
      const current = this.#authorize(context);
      if (!current.user.isOwner) throw forbidden();
      if (this.#count("SELECT COUNT(*) AS n FROM projects") >= L.PROJECTS) throw quota();
      const id = randomUUID(), now = this.#now();
      this.#run("INSERT INTO projects(id,name,created_at) VALUES(?,?,?)", id, name, now);
      this.#run("INSERT INTO prompt_scope_controls(scope_key,generation) SELECT scope_key,1 FROM evaluation_evidence_scopes WHERE scope_key=?", "project:" + id);
      if (!this.#get("SELECT scope_key FROM prompt_scope_controls WHERE scope_key=?", "project:" + id)) throw new TeamError("conflict", "Team prompt scope is unavailable");
      this.#run("INSERT INTO comparison_scope_controls(scope_key,generation) SELECT p.scope_key,1 FROM prompt_scope_controls p JOIN evaluation_evidence_scopes e USING(scope_key) WHERE p.scope_key=? AND e.active=1", "project:" + id);
      if (!this.#get("SELECT scope_key FROM comparison_scope_controls WHERE scope_key=?", "project:" + id)) throw new TeamError("conflict", "Team comparison scope is unavailable");
      this.#run("INSERT INTO memberships(project_id,account_id,role,joined_at) VALUES(?,?,'admin',?)", id, current.user.id, now);
      this.#audit({ ...current, projectId: id, role: "admin" }, "project.created", { type: "project", id });
      return { id, name, createdAt: now, role: "admin" };
    });
  }
  getProject(context: ProjectContext): Project {
    const scope = this.#project(context);
    return this.#projectView(this.#get<ProjectRow>("SELECT * FROM projects WHERE id=?", scope.projectId)!, scope.role);
  }
  listMembers(context: ProjectContext, query?: PageQuery): Page<Member> {
    const scope = this.#project(context, "admin"), paging = this.#paging(query, scope.projectId, "members"), anchor = this.#anchor(paging, "m.joined_at", "a.id");
    const rows = this.#all<{ id: string; email: string; role: Role; joined_at: number }>(`SELECT a.id,a.email,m.role,m.joined_at FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.project_id=?${anchor.sql} ORDER BY m.joined_at DESC,a.id DESC LIMIT ?`, scope.projectId, ...anchor.args, paging.limit + 1);
    return pageResult(rows.map(row => ({ user: { id: row.id, email: row.email }, role: row.role, joinedAt: row.joined_at })), paging, row => [row.joinedAt, row.user.id]);
  }
  #member(projectId: string, id: string): Member {
    const row = this.#get<{ id: string; email: string; role: Role; joined_at: number }>("SELECT a.id,a.email,m.role,m.joined_at FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.project_id=? AND m.account_id=?", projectId, id);
    if (!row) throw missing();
    return { user: { id: row.id, email: row.email }, role: row.role, joinedAt: row.joined_at };
  }
  #preserveAdmin(projectId: string, old: Role, replacement?: Role): void {
    if (old === "admin" && replacement !== "admin" && this.#count("SELECT COUNT(*) AS n FROM memberships WHERE project_id=? AND role='admin'", projectId) <= 1) throw new TeamError("conflict", "A project must retain an administrator");
  }
  changeMemberRole(context: ProjectContext, id: string, role: Role): Member {
    requiredId(id); requiredRole(role);
    return this.#write(() => {
      const scope = this.#project(context, "admin"), previous = this.#member(scope.projectId, id);
      this.#preserveAdmin(scope.projectId, previous.role, role);
      this.#run("UPDATE memberships SET role=? WHERE project_id=? AND account_id=?", role, scope.projectId, id);
      this.#audit(scope, "member.role_changed", { type: "member", id }, { previousRole: previous.role, role });
      return { ...previous, role };
    });
  }
  removeMember(context: ProjectContext, id: string): void {
    requiredId(id);
    this.#write(() => {
      const scope = this.#project(context, "admin"), previous = this.#member(scope.projectId, id);
      this.#preserveAdmin(scope.projectId, previous.role);
      this.#run("DELETE FROM memberships WHERE project_id=? AND account_id=?", scope.projectId, id);
      this.#audit(scope, "member.removed", { type: "member", id }, { previousRole: previous.role });
    });
  }
  #actor(id: string): Actor {
    const row = this.#get<{ id: string; email: string }>("SELECT id,email FROM accounts WHERE id=?", id);
    if (!row) throw missing();
    return row;
  }
  #inviteView(row: InviteRow): Invite { return { id: row.id, email: row.email, role: row.role, issuedBy: this.#actor(row.issuer_id), createdAt: row.created_at, expiresAt: row.expires_at, status: "pending" }; }
  listInvites(context: ProjectContext, query?: PageQuery): Page<Invite> {
    const scope = this.#project(context, "admin"), paging = this.#paging(query, scope.projectId, "invites"), anchor = this.#anchor(paging, "created_at", "id");
    const rows = this.#all<InviteRow>(`SELECT * FROM invites WHERE project_id=? AND expires_at>?${anchor.sql} ORDER BY created_at DESC,id DESC LIMIT ?`, scope.projectId, this.#now(), ...anchor.args, paging.limit + 1);
    return pageResult(rows.map(row => this.#inviteView(row)), paging, row => [row.createdAt, row.id]);
  }
  createInvite(context: ProjectContext, input: InviteCreate): { invite: Invite; token: string } {
    const email = requiredEmail(input.email), role = requiredRole(input.role), hours = lifetime(input.expiresInHours, L.INVITE_DEFAULT_HOURS, L.INVITE_MAX_HOURS);
    return this.#write(() => {
      const scope = this.#project(context, "admin");
      if (this.#count("SELECT COUNT(*) AS n FROM invites WHERE project_id=?", scope.projectId) >= L.PROJECT_INVITES) throw quota();
      const token = `rp_team_invite_${randomBytes(32).toString("base64url")}`, now = this.#now();
      const row: InviteRow = { id: randomUUID(), project_id: scope.projectId, email, role, issuer_id: scope.user.id, token_hash: digest(token), created_at: now, expires_at: now + hours * 3600000 };
      this.#run("INSERT INTO invites(id,project_id,email,role,issuer_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)", row.id, row.project_id, row.email, row.role, row.issuer_id, row.token_hash, row.created_at, row.expires_at);
      this.#audit(scope, "invite.created", { type: "invite", id: row.id }, { role });
      return { invite: this.#inviteView(row), token };
    });
  }
  revokeInvite(context: ProjectContext, id: string): void {
    requiredId(id);
    this.#write(() => {
      const scope = this.#project(context, "admin");
      if (!this.#get("SELECT id FROM invites WHERE project_id=? AND id=?", scope.projectId, id)) throw missing();
      this.#run("DELETE FROM invites WHERE project_id=? AND id=?", scope.projectId, id);
      this.#audit(scope, "invite.revoked", { type: "invite", id });
    });
  }
  #usableInvite(hash: string, email: string): InviteRow | null {
    return this.#get<InviteRow>("SELECT i.* FROM invites i JOIN memberships m ON m.project_id=i.project_id AND m.account_id=i.issuer_id AND m.role='admin' WHERE i.token_hash=? AND i.email=? AND i.expires_at>?", hash, email, this.#now());
  }
  getInviteForAcceptance(tokenHash: string, email: string): { account: AccountCredential | null } | null {
    requiredHash(tokenHash); requiredEmail(email);
    const invite = this.#usableInvite(tokenHash, email);
    if (!invite) return null;
    const account = this.getAccountByEmail(email);
    return { account };
  }
  acceptInvite(input: { tokenHash: string; email: string; passwordHash: string; expectedAccountId: string | null; sessionHash: string; requestId?: string }): { context: SessionContext; project: Project } {
    requiredHash(input.tokenHash); requiredEmail(input.email);
    return this.#write(() => {
      const invite = this.#usableInvite(input.tokenHash, input.email);
      if (!invite) throw invalidInvite();
      let account = this.getAccountByEmail(input.email);
      if (input.expectedAccountId === null ? account !== null : !account || account.user.id !== input.expectedAccountId || account.passwordHash !== input.passwordHash) throw invalidInvite();
      if (account && this.#get("SELECT account_id FROM memberships WHERE project_id=? AND account_id=?", invite.project_id, account.user.id)) throw new TeamError("conflict", "The account is already a project member");
      if (this.#count("SELECT COUNT(*) AS n FROM memberships WHERE project_id=?", invite.project_id) >= L.PROJECT_MEMBERS) throw quota();
      if (!account) {
        if (this.#count("SELECT COUNT(*) AS n FROM accounts") >= L.ACCOUNTS) throw quota();
        const id = randomUUID(), now = this.#now();
        this.#run("INSERT INTO accounts(id,email,password_hash,is_owner,created_at) VALUES(?,?,?,0,?)", id, input.email, input.passwordHash, now);
        account = { user: { id, email: input.email, isOwner: false, createdAt: now }, passwordHash: input.passwordHash };
      }
      this.#run("INSERT INTO memberships(project_id,account_id,role,joined_at) VALUES(?,?,?,?)", invite.project_id, account.user.id, invite.role, this.#now());
      this.#run("DELETE FROM invites WHERE id=?", invite.id);
      const context = this.#issueSession(account.user.id, input.sessionHash, requestId(input.requestId));
      const scope = this.projectScope(context, invite.project_id);
      this.#audit(scope, "invite.accepted", { type: "invite", id: invite.id }, { role: invite.role });
      this.#operational("invite.accepted", account.user.id, context.requestId);
      return { context, project: this.getProject(scope) };
    });
  }
  #keyView(row: KeyRow): IngestKey { return { id: row.id, label: row.label, prefix: row.prefix, createdBy: this.#actor(row.creator_id), createdAt: row.created_at, expiresAt: row.expires_at, lastUsedAt: row.last_used_at, revokedAt: null }; }
  listKeys(context: ProjectContext, query?: PageQuery): Page<IngestKey> {
    const scope = this.#project(context, "admin"), paging = this.#paging(query, scope.projectId, "keys"), anchor = this.#anchor(paging, "created_at", "id");
    const rows = this.#all<KeyRow>(`SELECT * FROM ingest_keys WHERE project_id=? AND expires_at>?${anchor.sql} ORDER BY created_at DESC,id DESC LIMIT ?`, scope.projectId, this.#now(), ...anchor.args, paging.limit + 1);
    return pageResult(rows.map(row => this.#keyView(row)), paging, row => [row.createdAt, row.id]);
  }
  createKey(context: ProjectContext, input: KeyCreate): { key: IngestKey; token: string } {
    const label = requiredName(input.label), days = lifetime(input.expiresInDays, L.KEY_DEFAULT_DAYS, L.KEY_MAX_DAYS);
    return this.#write(() => {
      const scope = this.#project(context, "admin");
      if (this.#count("SELECT COUNT(*) AS n FROM ingest_keys WHERE project_id=?", scope.projectId) >= L.PROJECT_KEYS) throw quota();
      const token = `rp_team_ingest_${randomBytes(32).toString("base64url")}`, now = this.#now();
      const row: KeyRow = { id: randomUUID(), project_id: scope.projectId, label, prefix: token.slice(0, 22), creator_id: scope.user.id, token_hash: digest(token), created_at: now, expires_at: now + days * 86400000, last_used_at: null };
      this.#run("INSERT INTO ingest_keys(id,project_id,label,prefix,creator_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)", row.id, row.project_id, row.label, row.prefix, row.creator_id, row.token_hash, row.created_at, row.expires_at);
      this.#audit(scope, "key.created", { type: "key", id: row.id });
      return { key: this.#keyView(row), token };
    });
  }
  revokeKey(context: ProjectContext, id: string): void {
    requiredId(id);
    this.#write(() => {
      const scope = this.#project(context, "admin");
      if (!this.#get("SELECT id FROM ingest_keys WHERE project_id=? AND id=?", scope.projectId, id)) throw missing();
      this.#run("DELETE FROM ingest_keys WHERE project_id=? AND id=?", scope.projectId, id);
      this.#audit(scope, "key.revoked", { type: "key", id });
    });
  }
  getIngestContext(tokenHash: string, id?: string): IngestContext | null {
    requiredHash(tokenHash);
    const key = this.#get<KeyRow>("SELECT * FROM ingest_keys WHERE token_hash=? AND expires_at>?", tokenHash, this.#now());
    return key ? Object.freeze({ tokenHash, keyId: key.id, projectId: key.project_id, requestId: requestId(id) }) : null;
  }
  #ingestAuthority(context: IngestContext): IngestContext {
    const current = this.getIngestContext(context.tokenHash, context.requestId);
    if (!current || current.keyId !== context.keyId || current.projectId !== context.projectId) throw unauthorized();
    return current;
  }

  #quotaDelta(projectId: string, amount: number, runs = 0, spans = 0, checks = 0): void {
    const project = this.#get<ProjectRow>("SELECT * FROM projects WHERE id=?", projectId);
    if (!project) throw missing();
    if (Math.max(project.evidence_bytes + amount, this.#telemetryBytes(projectId)) + this.#reviewBytes(projectId) > L.PROJECT_BYTES || project.run_count + runs > L.PROJECT_RUNS
      || project.span_count + spans > L.PROJECT_SPANS || project.check_count + checks > L.PROJECT_CHECKS) throw quota();
    this.#run("UPDATE projects SET evidence_bytes=evidence_bytes+?,run_count=run_count+?,span_count=span_count+?,check_count=check_count+? WHERE id=?", amount, runs, spans, checks, projectId);
  }
  #readRun(projectId: string, id: string): RunSummary {
    const row = this.#get<DataRow>("SELECT data,byte_size FROM runs WHERE project_id=? AND id=?", projectId, id);
    if (!row) throw missing();
    return JSON.parse(row.data) as RunSummary;
  }
  #spanSummaries(projectId: string, runId: string): SpanSummary[] {
    return this.#all<{ data: string }>("SELECT json_remove(data,'$.inputPayload','$.outputPayload','$.attributes') AS data FROM spans WHERE project_id=? AND run_id=? ORDER BY started_at IS NULL,started_at,id LIMIT ?", projectId, runId, L.TRACE_SPANS).map(row => JSON.parse(row.data) as SpanSummary);
  }
  ingest(context: IngestContext, batch: TeamIngestBatch): void {
    assertTeamIngestBatch(batch);
    this.#write(() => {
      const scope = this.#ingestAuthority(context);
      if (!batch.captures.length) return;
      let amount = 0, addedRuns = 0, addedSpans = 0;
      const affected = new Map<string, { metadata: string; eventName: string | null }>();
      for (const capture of batch.captures) {
        const span = capture.span;
        const oldRun = this.#get<DataRow>("SELECT data,byte_size FROM runs WHERE project_id=? AND id=?", scope.projectId, span.runId);
        if (!oldRun) {
          const now = this.#now();
          const run: RunSummary = { id: span.runId, name: span.name, displayName: capture.eventName, firstSeenAt: now, updatedAt: now, startedAt: null, endedAt: null, durationMs: null, status: "running", spanCount: 0, errorCount: 0, model: null, provider: null };
          const searchText = (JSON.parse(capture.searchMetadata) as string[]).join("\n");
          const data = JSON.stringify(run), size = bytes(data) + bytes(capture.searchMetadata) + bytes(searchText) + 128;
          this.#run("INSERT INTO runs(project_id,id,started_at,status,data,search_text,metadata,byte_size) VALUES(?,?,NULL,'running',?,?,?,?)", scope.projectId, span.runId, data, searchText, capture.searchMetadata, size);
          amount += size; addedRuns++;
        }
        const previous = this.#get<{ byte_size: number }>("SELECT byte_size FROM spans WHERE project_id=? AND run_id=? AND id=?", scope.projectId, span.runId, span.id);
        const data = JSON.stringify(span), size = bytes(data) + bytes(span.name) + bytes(span.model ?? "") + bytes(span.provider ?? "") + 128;
        if (size > L.SPAN_BYTES) throw new TeamError("too_large", "Captured span exceeds its storage limit");
        this.#run("INSERT INTO spans(project_id,run_id,id,name,model,provider,started_at,data,byte_size) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,run_id,id) DO UPDATE SET name=excluded.name,model=excluded.model,provider=excluded.provider,started_at=excluded.started_at,data=excluded.data,byte_size=excluded.byte_size", scope.projectId, span.runId, span.id, span.name, span.model, span.provider, span.startedAt, data, size);
        amount += size - (previous?.byte_size ?? 0);
        if (!previous) addedSpans++;
        if (!affected.has(span.runId) || !span.parentSpanId) affected.set(span.runId, { metadata: capture.searchMetadata, eventName: capture.eventName });
      }
      for (const [runId, capture] of affected) {
        const totals = this.#get<{ n: number; size: number }>("SELECT COUNT(*) AS n,COALESCE(SUM(byte_size),0) AS size FROM spans WHERE project_id=? AND run_id=?", scope.projectId, runId)!;
        if (totals.n > L.TRACE_SPANS || totals.size > L.TRACE_BYTES) throw new TeamError("quota_exceeded", "Trace storage limit reached");
        const old = this.#get<DataRow & { metadata: string }>("SELECT data,metadata,byte_size FROM runs WHERE project_id=? AND id=?", scope.projectId, runId)!;
        const previous = JSON.parse(old.data) as RunSummary, spans = this.#spanSummaries(scope.projectId, runId);
        const roots = spans.filter(span => !span.parentSpanId);
        const complete = roots.length > 0 && spans.every(span => span.endedAt !== null && (span.status === "OK" || span.status === "ERROR"));
        const starts = spans.map(span => span.startedAt).filter((value): value is number => value !== null);
        const ends = spans.map(span => span.endedAt).filter((value): value is number => value !== null);
        const start = starts.length ? Math.min(...starts) : null;
        const end = complete && ends.length === spans.length ? Math.max(...ends) : null;
        const errorCount = spans.filter(span => span.status === "ERROR").length;
        const first = roots[0] ?? spans[0];
        const modelSpan = spans.find(span => span.model !== null);
        const run: RunSummary = { ...previous, name: first?.name ?? previous.name, displayName: capture.eventName ?? previous.displayName,
          updatedAt: this.#now(), startedAt: start, endedAt: end, status: complete ? errorCount ? "failed" : "completed" : "running",
          spanCount: spans.length, errorCount, model: modelSpan?.model ?? null, provider: modelSpan?.provider ?? spans.find(span => span.provider !== null)?.provider ?? null,
          durationMs: complete && starts.length === spans.length && start !== null && end !== null && end >= start ? end - start : null };
        const oldMetadata = JSON.parse(old.metadata) as string[];
        const merged = (JSON.parse(capture.metadata) as string[]).map((value, index) => value || oldMetadata[index] || "");
        const metadata = JSON.stringify(merged), searchText = merged.join("\n"), data = JSON.stringify(run), size = bytes(data) + bytes(metadata) + bytes(searchText) + 128;
        if (totals.size + size > L.TRACE_BYTES) throw new TeamError("quota_exceeded", "Trace storage limit reached");
        this.#run("UPDATE runs SET started_at=?,status=?,data=?,search_text=?,metadata=?,byte_size=? WHERE project_id=? AND id=?", run.startedAt, run.status, data, searchText, metadata, size, scope.projectId, runId);
        amount += size - old.byte_size;
      }
      this.#quotaDelta(scope.projectId, amount, addedRuns, addedSpans);
      this.#run("UPDATE ingest_keys SET last_used_at=? WHERE id=? AND project_id=?", this.#now(), scope.keyId, scope.projectId);
      this.#audit(scope, "ingest.committed", { type: "runBatch", id: null }, { spans: batch.captures.length, traces: affected.size, bytes: amount });
    });
  }
  async searchRuns(context: ProjectContext, query: PageQuery & RunFilters = {}, signal?: AbortSignal): Promise<Page<RunSummary> & { elapsedMs: number }> {
    const scope = this.#project(context);
    const project = this.#get<ProjectRow>("SELECT * FROM projects WHERE id=?", scope.projectId)!;
    if (project.evidence_bytes > L.PROJECT_BYTES || project.run_count > L.PROJECT_RUNS || project.span_count > L.PROJECT_SPANS) throw quota();
    const result = await searchTeamRuns(this.#path, scope.projectId, query, signal);
    this.#project(context);
    return result;
  }
  async searchSpanHits(context: ProjectContext, query: PageQuery & RunFilters = {}, signal?: AbortSignal): Promise<SearchHitPage> {
    return this.#searchResource(context, query, searchSpanHits, signal);
  }
  async searchSuggestions(context: ProjectContext, query: {field?: string; prefix?: string; limit?: number} = {}, signal?: AbortSignal): Promise<SearchSuggestionResult> {
    return this.#searchResource(context, query, searchSuggestions, signal);
  }
  async #searchResource<T>(context: ProjectContext, query: unknown, read: (query: unknown, options: { dbPath: string; projectId: string; signal?: AbortSignal }) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const scope = this.#project(context);
    const p = this.#get<ProjectRow>("SELECT * FROM projects WHERE id=?",scope.projectId)!;
    if(p.evidence_bytes>L.PROJECT_BYTES || p.run_count>L.PROJECT_RUNS || p.span_count>L.PROJECT_SPANS) throw quota();
    try {
      const result = await read(query,{dbPath:this.#path,projectId:scope.projectId,signal});
      this.#project(context);
      return result;
    } catch(error) {
      this.#project(context);
      if(error instanceof SearchResourceError) {
        const code = error.code === "invalid_search" ? "invalid_request" : error.code === "search_busy" ? "busy" : error.code === "cancelled" ? "query_timeout" : error.code === "too_large" ? "too_large" : error.code === "quota_exceeded" ? "quota_exceeded" : error.code === "query_timeout" ? "query_timeout" : "internal_error";
        throw new TeamError(code,error.message,undefined,error.status===503||error.status===504?1:undefined);
      }
      throw error;
    }
  }
  getRun(context: ProjectContext, runId: string, query?: PageQuery): RunDetail {
    requiredId(runId);
    const scope = this.#project(context), run = this.#readRun(scope.projectId, runId), paging = this.#paging(query, scope.projectId, `spans:${runId}`);
    let condition = ""; const args: SQLQueryBindings[] = [];
    if (paging.anchor) {
      const [time, id] = paging.anchor;
      if (time === null) { condition = " AND started_at IS NULL AND id>?"; args.push(id); }
      else { condition = " AND (started_at>? OR (started_at=? AND id>?) OR started_at IS NULL)"; args.push(time, time, id); }
    }
    const rows = this.#all<{ data: string }>(`SELECT json_remove(data,'$.inputPayload','$.outputPayload','$.attributes') AS data FROM spans WHERE project_id=? AND run_id=?${condition} ORDER BY started_at IS NULL,started_at,id LIMIT ?`, scope.projectId, runId, ...args, paging.limit + 1).map(row => JSON.parse(row.data) as SpanSummary);
    return { run, spans: pageResult(rows, paging, row => [row.startedAt, row.id]) };
  }
  getSpan(context: ProjectContext, runId: string, spanId: string): Span {
    requiredId(runId); requiredId(spanId);
    const scope = this.#project(context);
    const row = this.#get<DataRow>("SELECT data,byte_size FROM spans WHERE project_id=? AND run_id=? AND id=?", scope.projectId, runId, spanId);
    if (!row) throw missing();
    return JSON.parse(row.data) as Span;
  }
  deleteRun(context: ProjectContext, runId: string): void {
    requiredId(runId);
    this.#write(() => {
      const scope = this.#project(context, "admin");
      this.#readRun(scope.projectId, runId);
      this.#evidence.assertRunInactive(this.#evidenceOwner(scope), runId);
      const amount = this.#count("SELECT byte_size AS n FROM runs WHERE project_id=? AND id=?", scope.projectId, runId)
        + this.#count("SELECT COALESCE(SUM(byte_size),0) AS n FROM spans WHERE project_id=? AND run_id=?", scope.projectId, runId)
        + this.#count("SELECT COALESCE(SUM(byte_size),0) AS n FROM notes WHERE project_id=? AND run_id=?", scope.projectId, runId);
      const spans = this.#count("SELECT COUNT(*) AS n FROM spans WHERE project_id=? AND run_id=?", scope.projectId, runId);
      this.#run("DELETE FROM runs WHERE project_id=? AND id=?", scope.projectId, runId);
      this.#quotaDelta(scope.projectId, -amount, -1, -spans);
      this.#audit(scope, "run.deleted", { type: "run", id: runId }, { spans, bytes: amount });
    });
  }
  listNotes(context: ProjectContext, runId: string, query?: PageQuery): Page<Note> {
    requiredId(runId);
    const scope = this.#project(context), paging = this.#paging(query, scope.projectId, `notes:${runId}`), anchor = this.#anchor(paging, "created_at", "id");
    this.#readRun(scope.projectId, runId);
    const rows = this.#all<{ data: string }>(`SELECT data FROM notes WHERE project_id=? AND run_id=?${anchor.sql} ORDER BY created_at DESC,id DESC LIMIT ?`, scope.projectId, runId, ...anchor.args, paging.limit + 1).map(row => JSON.parse(row.data) as Note);
    return pageResult(rows, paging, row => [row.createdAt, row.id]);
  }
  createNote(context: ProjectContext, runId: string, input: NoteCreate): Note {
    requiredId(runId); if (input.spanId !== undefined) requiredId(input.spanId);
    if (typeof input.text !== "string" || !input.text.trim() || bytes(input.text) > L.NOTE_BYTES || !["note", "issue", "good"].includes(input.kind)) throw new TeamError("invalid_request", "Invalid shared note");
    const text = redactTeamText(input.text);
    return this.#write(() => {
      const scope = this.#project(context, "editor");
      this.#readRun(scope.projectId, runId);
      if (input.spanId !== undefined) this.getSpan(scope, runId, input.spanId);
      if (this.#count("SELECT COUNT(*) AS n FROM notes WHERE project_id=? AND run_id=?", scope.projectId, runId) >= L.RUN_NOTES) throw quota();
      const note: Note = { id: randomUUID(), runId, spanId: input.spanId ?? null, kind: input.kind, text, author: this.#actor(scope.user.id), createdAt: this.#now() };
      const data = JSON.stringify(note), size = bytes(data) + 128;
      this.#quotaDelta(scope.projectId, size);
      this.#run("INSERT INTO notes(project_id,run_id,id,span_id,author_id,created_at,data,byte_size) VALUES(?,?,?,?,?,?,?,?)", scope.projectId, runId, note.id, note.spanId, scope.user.id, note.createdAt, data, size);
      this.#audit(scope, "note.created", { type: "note", id: note.id });
      return note;
    });
  }
  deleteNote(context: ProjectContext, runId: string, noteId: string): void {
    requiredId(runId); requiredId(noteId);
    this.#write(() => {
      const scope = this.#project(context, "editor");
      const row = this.#get<DataRow & { author_id: string }>("SELECT data,byte_size,author_id FROM notes WHERE project_id=? AND run_id=? AND id=?", scope.projectId, runId, noteId);
      if (!row) throw missing();
      if (row.author_id !== scope.user.id) throw forbidden();
      this.#run("DELETE FROM notes WHERE project_id=? AND run_id=? AND id=?", scope.projectId, runId, noteId);
      this.#quotaDelta(scope.projectId, -row.byte_size);
      this.#audit(scope, "note.deleted", { type: "note", id: noteId });
    });
  }
  metrics(context: ProjectContext, selection: Metrics["window"]["selection"] = "24h"): Metrics {
    const scope = this.#project(context), durations = { "1h": 3600000, "24h": 86400000, "7d": 7 * 86400000, "30d": 30 * 86400000 };
    if (!Object.hasOwn(durations, selection)) throw new TeamError("invalid_request", "Invalid metrics window");
    const to = this.#now(), from = to - durations[selection];
    const rows = this.#all<{ status: RunSummary["status"]; duration: number | null }>("SELECT status,json_extract(data,'$.durationMs') AS duration FROM runs WHERE project_id=? AND started_at>=? AND started_at<? ORDER BY started_at LIMIT ?", scope.projectId, from, to, L.PROJECT_RUNS);
    const completed = rows.filter(row => row.status === "completed");
    const known = completed.map(row => row.duration).filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
    const rank = (p: number) => known.length ? known[Math.ceil(p * known.length) - 1] : null;
    return { asOf: to, window: { selection, from, to, field: "startedAt" }, traces: { total: rows.length, completed: completed.length, running: rows.filter(row => row.status === "running").length, failed: rows.filter(row => row.status === "failed").length, terminal: rows.filter(row => row.status !== "running").length }, duration: { population: "completedTraces", knownCount: known.length, unavailableCount: completed.length - known.length, p50Ms: rank(.5), p95Ms: rank(.95) } };
  }

  acquireCheckEvidence(context: ProjectContext, runIds: string[], definitionBytes: number): CheckEvidence {
    if (!Number.isSafeInteger(definitionBytes) || definitionBytes < 0 || definitionBytes > L.CHECK_REQUEST_BYTES || !runIds.length || runIds.length > L.CHECK_CANDIDATES + 1 || new Set(runIds).size !== runIds.length) throw new TeamError("invalid_request", "Invalid check evidence selection");
    runIds.forEach(requiredId);
    return this.#db.transaction(() => {
      const scope = this.#project(context, "editor");
      let amount = definitionBytes, count = 0;
      for (const id of runIds) {
        const run = this.#get<{ size: number }>("SELECT byte_size AS size FROM runs WHERE project_id=? AND id=?", scope.projectId, id);
        if (!run) throw missing();
        const spans = this.#get<{ size: number; n: number }>("SELECT COALESCE(SUM(byte_size),0) AS size,COUNT(*) AS n FROM spans WHERE project_id=? AND run_id=?", scope.projectId, id)!;
        amount += run.size + spans.size; count += spans.n;
      }
      if (amount > L.CHECK_ACQUISITION_BYTES || count > L.CHECK_ACQUISITION_SPANS) throw new TeamError("too_large", "Selected evidence exceeds the check acquisition limit");
      const runs = runIds.map(id => this.#snapshotEvidence(scope.projectId, id));
      return { author: this.#actor(scope.user.id), acquiredAt: this.#now(), runs };
    })();
  }
  #snapshotEvidence(projectId: string, id: string): { run: SnapshotRun; spans: SnapshotSpan[] } {
    const view = this.#readRun(projectId, id);
    const run: SnapshotRun = { id, name: view.name, display_name: view.displayName, started_at: view.startedAt, last_updated_at: view.updatedAt };
    const spans = this.#all<{ data: string }>("SELECT data FROM spans WHERE project_id=? AND run_id=? ORDER BY started_at IS NULL,started_at,id", projectId, id).map(row => {
      const span = JSON.parse(row.data) as Span;
      const snapshot: SnapshotSpan = { id: span.id, run_id: span.runId, parent_span_id: span.parentSpanId, name: span.name, span_type: span.kind, status: span.status,
        input_payload: span.inputPayload, output_payload: span.outputPayload, start_time_ms: span.startedAt, end_time_ms: span.endedAt, duration_ms: span.durationMs,
        model: span.model, provider: span.provider, input_tokens: span.inputTokens, output_tokens: span.outputTokens, attributes: span.attributes, unavailable: span.unavailable };
      return snapshot;
    });
    return { run, spans };
  }
  persistCheck(context: ProjectContext, check: Check, report: CheckReport): Check {
    const data = JSON.stringify(check), reportData = JSON.stringify(report);
    if (bytes(data) > L.CHECK_BYTES || bytes(reportData) > L.CHECK_BYTES) throw new TeamError("too_large", "Saved check exceeds its artifact limit");
    const { definition: _definition, referenceSnapshot: _referenceSnapshot, results: _results, ...summary } = check;
    const summaryData = JSON.stringify(summary), size = bytes(data) + bytes(reportData) + bytes(summaryData) + 128;
    return this.#write(() => {
      const scope = this.#project(context, "editor"), actor = this.#actor(scope.user.id);
      requiredId(check.id);
      if (check.projectId !== scope.projectId || check.author.id !== actor.id || check.author.email !== actor.email
        || report.check.id !== check.id || report.check.projectId !== scope.projectId || report.format !== "runphantom-team-check/v1"
        || JSON.stringify(report.check) !== summaryData) throw new TeamError("invalid_request", "Invalid saved check provenance");
      if (this.#get("SELECT id FROM checks WHERE project_id=? AND id=?", scope.projectId, check.id)) throw new TeamError("conflict", "A saved check is immutable");
      this.#quotaDelta(scope.projectId, size, 0, 0, 1);
      this.#run("INSERT INTO checks(project_id,id,created_at,summary,data,report,byte_size) VALUES(?,?,?,?,?,?,?)", scope.projectId, check.id, check.createdAt, summaryData, data, reportData, size);
      this.#audit(scope, "check.created", { type: "check", id: check.id });
      return JSON.parse(data) as Check;
    });
  }
  listChecks(context: ProjectContext, query?: PageQuery): Page<CheckSummary> {
    const scope = this.#project(context), paging = this.#paging(query, scope.projectId, "checks"), anchor = this.#anchor(paging, "created_at", "id");
    const rows = this.#all<{ summary: string }>(`SELECT summary FROM checks WHERE project_id=?${anchor.sql} ORDER BY created_at DESC,id DESC LIMIT ?`, scope.projectId, ...anchor.args, paging.limit + 1).map(row => JSON.parse(row.summary) as CheckSummary);
    return pageResult(rows, paging, row => [row.createdAt, row.id]);
  }
  getCheck(context: ProjectContext, id: string): Check {
    requiredId(id); const scope = this.#project(context);
    const row = this.#get<{ data: string }>("SELECT data FROM checks WHERE project_id=? AND id=?", scope.projectId, id);
    if (!row) throw missing();
    return JSON.parse(row.data) as Check;
  }
  getCheckReport(context: ProjectContext, id: string): CheckReport {
    requiredId(id); const scope = this.#project(context);
    const row = this.#get<{ report: string }>("SELECT report FROM checks WHERE project_id=? AND id=?", scope.projectId, id);
    if (!row) throw missing();
    return JSON.parse(row.report) as CheckReport;
  }

  #reviewIntegrity(): never { throw new TeamError("conflict", "Frozen project review evidence is invalid; reload its current revision"); }
  #reviewCount(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) return this.#reviewIntegrity(); return value;
  }
  #reviewBytes(project: string): number {
    return this.#reviewCount(this.#count(`SELECT COALESCE(SUM(n),0) AS n FROM (
      SELECT SUM(length(CAST(project_id||id||name||schema_json||schema_hash AS BLOB))+128) AS n FROM team_review_queues WHERE project_id=?
      UNION ALL SELECT SUM(length(CAST(project_id||queue_id||id||source_run_id||source_span_key||data||data_hash AS BLOB))+128) FROM team_review_items WHERE project_id=?
      UNION ALL SELECT SUM(length(CAST(project_id||id||name AS BLOB))+128) FROM team_review_datasets WHERE project_id=?
      UNION ALL SELECT SUM(length(CAST(project_id||dataset_id||cases_json||hash AS BLOB))+128) FROM team_review_dataset_revisions WHERE project_id=?
      UNION ALL SELECT SUM(length(CAST(project_id||queue_id||idempotency_key||request_json||request_hash||result_json||result_hash AS BLOB))+128) FROM team_review_promotions WHERE project_id=?)`, project, project, project, project, project));
  }
  #telemetryBytes(project: string): number {
    return this.#reviewCount(this.#count(`SELECT COALESCE(SUM(n),0) AS n FROM (
      SELECT SUM(length(CAST(data||metadata||search_text AS BLOB))+128) AS n FROM runs WHERE project_id=?
      UNION ALL SELECT SUM(length(CAST(data||name||COALESCE(model,'')||COALESCE(provider,'') AS BLOB))+128) FROM spans WHERE project_id=?
      UNION ALL SELECT SUM(length(CAST(data AS BLOB))+128) FROM notes WHERE project_id=?
      UNION ALL SELECT SUM(length(CAST(data||summary||report AS BLOB))+128) FROM checks WHERE project_id=?)`, project, project, project, project));
  }
  #reviewRetention(project: string): void {
    const reviewBytes = this.#reviewBytes(project), old = this.#count("SELECT evidence_bytes AS n FROM projects WHERE id=?", project);
    const queues = this.#count("SELECT count(*) AS n FROM team_review_queues WHERE project_id=?", project);
    const items = this.#count("SELECT count(*) AS n FROM team_review_items WHERE project_id=?", project);
    const promotions = this.#count("SELECT count(*) AS n FROM team_review_promotions WHERE project_id=?", project);
    const datasets = this.#count("SELECT count(*) AS n FROM team_review_datasets WHERE project_id=?", project);
    if (reviewBytes > R.MAX_RETAINED_BYTES || Math.max(old, this.#telemetryBytes(project)) + reviewBytes > L.PROJECT_BYTES
      || queues > R.MAX_QUEUES || items > R.MAX_ITEMS || promotions > R.MAX_PROMOTIONS || datasets > 50) throw quota();
  }
  #readReviewQueue(project: string, id: string): TeamReviewQueue {
    requiredId(id);
    const row = this.#get<{name: string | null;schema_json: string | null;schema_hash: string;created_at: number;next_ordinal: number}>(`SELECT
      CASE WHEN length(CAST(name AS BLOB))<=512 THEN name END AS name,
      CASE WHEN length(CAST(schema_json AS BLOB))<=8192 THEN schema_json END AS schema_json,
      schema_hash,created_at,next_ordinal FROM team_review_queues WHERE project_id=? AND id=?`, project, id);
    if (!row) throw missing();
    try {
      const parsed = parseTeamReviewQueue({ name: row.name, schema: parseTeamReviewStored(row.schema_json, R.MAX_SCHEMA_BYTES) });
      if (reviewHash(parsed.schema) !== row.schema_hash) return this.#reviewIntegrity(); parseVersion(row.next_ordinal);
      return { ...parsed, projectId: project, id, schemaHash: row.schema_hash, createdAt: reviewTimestamp(row.created_at) };
    } catch { return this.#reviewIntegrity(); }
  }
  #reviewCounts(project: string, queue: string): ReviewCounts {
    const row = this.#get<ReviewCounts>(`SELECT count(*) AS total,COALESCE(sum(state='draft'),0) AS draft,
      COALESCE(sum(state='approved'),0) AS approved,COALESCE(sum(state='promoted'),0) AS promoted FROM team_review_items WHERE project_id=? AND queue_id=?`, project, queue)!;
    for (const value of Object.values(row)) this.#reviewCount(value);
    if (row.total !== row.draft + row.approved + row.promoted || row.total > R.MAX_ITEMS_PER_QUEUE) return this.#reviewIntegrity(); return row;
  }
  listReviewQueues(context: ProjectContext): Array<TeamReviewQueue & {counts: ReviewCounts}> {
    return this.#db.transaction(() => {
      const scope = this.#project(context); this.#reviewRetention(scope.projectId);
      return this.#all<{id: string}>("SELECT id FROM team_review_queues WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT ?", scope.projectId, R.MAX_QUEUES)
        .map(row => ({ ...this.#readReviewQueue(scope.projectId, row.id), counts: this.#reviewCounts(scope.projectId, row.id) }));
    }).immediate();
  }
  createReviewQueue(context: ProjectContext, body: unknown): TeamReviewQueue {
    return this.#write(() => {
      const scope = this.#project(context, "editor"), parsed = parseTeamReviewQueue(body), id = randomUUID(), createdAt = this.#now();
      this.#reviewRetention(scope.projectId);
      if (this.#count("SELECT count(*) AS n FROM team_review_queues WHERE project_id=?", scope.projectId) >= R.MAX_QUEUES) throw quota();
      this.#run("INSERT INTO team_review_queues(project_id,id,name,schema_json,schema_hash,created_at) VALUES(?,?,?,?,?,?)", scope.projectId, id, parsed.name, canonicalReviewJson(parsed.schema), reviewHash(parsed.schema), createdAt);
      this.#reviewRetention(scope.projectId); this.#audit(scope, "review_queue.created", { type: "reviewQueue", id });
      return this.#readReviewQueue(scope.projectId, id);
    });
  }
  deleteReviewQueue(context: ProjectContext, id: string): void {
    this.#write(() => { const scope = this.#project(context, "admin"); this.#readReviewQueue(scope.projectId, id);
      this.#run("DELETE FROM team_review_queues WHERE project_id=? AND id=?", scope.projectId, id); this.#audit(scope, "review_queue.deleted", { type: "reviewQueue", id }); });
  }
  #readReviewItem(project: string, queue: TeamReviewQueue, id: string): TeamReviewItem {
    requiredHash(id);
    const row = this.#get<{data: string | null;data_hash: string;ordinal: number;revision: number;state: string;source_run_id: string;source_span_key: string}>(`SELECT
      CASE WHEN length(CAST(data AS BLOB))<=${TEAM_REVIEW_ITEM_BYTES} THEN data END AS data,data_hash,ordinal,revision,state,source_run_id,source_span_key
      FROM team_review_items WHERE project_id=? AND queue_id=? AND id=?`, project, queue.id, id);
    if (!row) throw missing();
    try {
      const item = parseTeamReviewStored(row.data, TEAM_REVIEW_ITEM_BYTES) as TeamReviewItem;
      assertTeamReviewItem(project, item, queue.schema);
      if (reviewHash(item) !== row.data_hash || item.id !== id || item.queueId !== queue.id || item.ordinal !== row.ordinal
        || item.revision !== row.revision || item.state !== row.state || item.source.runId !== row.source_run_id
        || (item.source.requestedOutputSpanId ?? "") !== row.source_span_key) return this.#reviewIntegrity(); return item;
    } catch { return this.#reviewIntegrity(); }
  }
  insertReviewItem(context: ProjectContext, queueId: string, body: unknown): TeamReviewItem {
    return this.#write(() => {
      const scope = this.#project(context, "editor"), queue = this.#readReviewQueue(scope.projectId, queueId), selected = parseTeamReviewInsert(body);
      const id = reviewItemId(queue.id, selected.runId, selected.outputSpanId);
      if (this.#get("SELECT id FROM team_review_items WHERE project_id=? AND queue_id=? AND id=?", scope.projectId, queue.id, id)) return this.#readReviewItem(scope.projectId, queue, id);
      this.#reviewRetention(scope.projectId);
      if (this.#reviewCounts(scope.projectId, queue.id).total >= R.MAX_ITEMS_PER_QUEUE
        || this.#count("SELECT count(*) AS n FROM team_review_items WHERE project_id=?", scope.projectId) >= R.MAX_ITEMS) throw quota();
      const run = this.#get<{size: number}>("SELECT length(CAST(data AS BLOB)) AS size FROM runs WHERE project_id=? AND id=?", scope.projectId, selected.runId);
      if (!run) throw missing();
      const spans = this.#get<{size: number;n: number}>("SELECT COALESCE(sum(length(CAST(data AS BLOB))),0) AS size,count(*) AS n FROM spans WHERE project_id=? AND run_id=?", scope.projectId, selected.runId)!;
      if (this.#reviewCount(run.size) + this.#reviewCount(spans.size) > L.CHECK_ACQUISITION_BYTES || this.#reviewCount(spans.n) > L.CHECK_ACQUISITION_SPANS) throw new TeamError("too_large", "Selected evidence exceeds the review acquisition limit");
      const evidence = this.#snapshotEvidence(scope.projectId, selected.runId), now = this.#now();
      const source = freezeReviewSource(snapshotRun(evidence.run, evidence.spans, selected.outputSpanId ?? undefined), selected.outputSpanId);
      const ordinal = parseVersion(this.#count("SELECT next_ordinal AS n FROM team_review_queues WHERE project_id=? AND id=?", scope.projectId, queue.id));
      if (ordinal === Number.MAX_SAFE_INTEGER) throw new TeamError("conflict", "Review revision allocator limit reached");
      const item = createTeamReviewItem(scope.projectId, queue.id, queue.schema, source, ordinal, now), data = canonicalReviewJson(item);
      if (bytes(data) > TEAM_REVIEW_ITEM_BYTES) throw new TeamError("too_large", "Frozen review item exceeds its row limit");
      this.#run("INSERT INTO team_review_items VALUES(?,?,?,?,?,?,?,?,?,?)", scope.projectId, queue.id, id, ordinal, source.runId, selected.outputSpanId ?? "", item.revision, item.state, data, reviewHash(item));
      this.#run("UPDATE team_review_queues SET next_ordinal=? WHERE project_id=? AND id=?", ordinal + 1, scope.projectId, queue.id);
      this.#reviewRetention(scope.projectId); this.#audit(scope, "review_item.inserted", { type: "reviewItem", id }); return item;
    });
  }
  #persistReviewItem(scope: ProjectContext, item: TeamReviewItem, expectedRevision: number): void {
    if (item.revision >= Number.MAX_SAFE_INTEGER) throw new TeamError("conflict", "Review revision allocator limit reached");
    const counter = parseVersion(this.#count("SELECT next_ordinal AS n FROM team_review_queues WHERE project_id=? AND id=?", scope.projectId, item.queueId));
    const data = canonicalReviewJson(item);
    if (bytes(data) > TEAM_REVIEW_ITEM_BYTES) throw new TeamError("too_large", "Frozen review item exceeds its row limit");
    const changed = this.#get("UPDATE team_review_items SET revision=?,state=?,data=?,data_hash=? WHERE project_id=? AND queue_id=? AND id=? AND revision=? RETURNING id",
      item.revision, item.state, data, reviewHash(item), scope.projectId, item.queueId, item.id, expectedRevision);
    if (!changed) throw new TeamError("conflict", "Project review changed; retain your draft and reload its current revision");
    this.#run("UPDATE team_review_queues SET next_ordinal=? WHERE project_id=? AND id=?", Math.max(counter, item.revision + 1), scope.projectId, item.queueId);
  }
  mutateReviewItem(context: ProjectContext, queueId: string, id: string, kind: "save" | "approve" | "reopen", body: unknown): TeamReviewItem {
    return this.#write(() => {
      const scope = this.#project(context, "editor"), queue = this.#readReviewQueue(scope.projectId, queueId), item = this.#readReviewItem(scope.projectId, queue, id);
      const changed = mutateTeamReviewItem(scope.projectId, item, queue.schema, kind, body, { accountId: scope.user.id, role: scope.role }, Math.max(this.#now(), item.updatedAt));
      if (changed === item) return item;
      this.#persistReviewItem(scope, changed, item.revision); this.#reviewRetention(scope.projectId);
      this.#audit(scope, kind === "save" ? "review_item.saved" : kind === "approve" ? "review_item.approved" : "review_item.reopened", { type: "reviewItem", id }); return changed;
    });
  }
  deleteReviewItem(context: ProjectContext, queueId: string, id: string, expectedRevision: number): void {
    this.#write(() => {
      const scope = this.#project(context, "admin"), queue = this.#readReviewQueue(scope.projectId, queueId), item = this.#readReviewItem(scope.projectId, queue, id);
      if (parseVersion(expectedRevision) !== item.revision) throw new TeamError("conflict", "Project review changed before deletion");
      this.#run("DELETE FROM team_review_items WHERE project_id=? AND queue_id=? AND id=? AND revision=?", scope.projectId, queue.id, id, expectedRevision);
      this.#audit(scope, "review_item.deleted", { type: "reviewItem", id });
    });
  }
  listReviewItems(context: ProjectContext, queueId: string, query?: PageQuery): Page<ReviewItemSummary> & {counts: ReviewCounts} {
    return this.#db.transaction(() => {
      const scope = this.#project(context), queue = this.#readReviewQueue(scope.projectId, queueId), paging = this.#paging(query, scope.projectId, `review-items:${queue.id}`);
      if (paging.limit > R.MAX_PAGE) throw new TeamError("invalid_request", "Review pages contain at most 50 items");
      const args: SQLQueryBindings[] = [], after = paging.anchor ? " AND (ordinal>? OR (ordinal=? AND id>?))" : "";
      if (paging.anchor) { const ordinal = parseVersion(paging.anchor[0]); requiredHash(paging.anchor[1]); args.push(ordinal, ordinal, paging.anchor[1]); }
      const rows = this.#all<ReviewItemSummary>(`SELECT id,ordinal,revision,state,
        CASE WHEN length(CAST(data AS BLOB))<=${TEAM_REVIEW_ITEM_BYTES} AND json_type(data,'$.draft.name')='text'
          AND length(CAST(json_extract(data,'$.draft.name') AS BLOB))<=512 THEN json_extract(data,'$.draft.name') END AS name
        FROM team_review_items WHERE project_id=? AND queue_id=?${after} ORDER BY ordinal,id LIMIT ?`, scope.projectId, queue.id, ...args, paging.limit + 1);
      for (const row of rows) {
        try { requiredHash(row.id); parseVersion(row.ordinal); parseVersion(row.revision); parseTeamReviewQueue({ name: row.name });
          if (!["draft", "approved", "promoted"].includes(row.state)) return this.#reviewIntegrity(); } catch { return this.#reviewIntegrity(); }
      }
      return { ...pageResult(rows, paging, row => [row.ordinal, row.id]), counts: this.#reviewCounts(scope.projectId, queue.id) };
    }).immediate();
  }
  reviewWindow(context: ProjectContext, queueId: string, centerId: string): TeamReviewItem[] {
    return this.#db.transaction(() => {
      const scope = this.#project(context), queue = this.#readReviewQueue(scope.projectId, queueId), center = this.#readReviewItem(scope.projectId, queue, centerId);
      const before = this.#all<{id: string}>("SELECT id FROM team_review_items WHERE project_id=? AND queue_id=? AND ordinal<? ORDER BY ordinal DESC,id DESC LIMIT 2", scope.projectId, queue.id, center.ordinal).reverse();
      const after = this.#all<{id: string}>("SELECT id FROM team_review_items WHERE project_id=? AND queue_id=? AND ordinal>? ORDER BY ordinal,id LIMIT 2", scope.projectId, queue.id, center.ordinal);
      return [...before.map(row => this.#readReviewItem(scope.projectId, queue, row.id)), center, ...after.map(row => this.#readReviewItem(scope.projectId, queue, row.id))];
    }).immediate();
  }
  #readReviewRevision(project: string, id: string, version: number): TeamReviewDatasetRevision {
    requiredId(id); parseVersion(version);
    const row = this.#get<{name: string;cases_json: string | null;hash: string;created_at: number}>(`SELECT d.name,
      CASE WHEN length(CAST(r.cases_json AS BLOB))<=${TEAM_REVIEW_REVISION_BYTES} THEN r.cases_json END AS cases_json,r.hash,r.created_at
      FROM team_review_datasets d JOIN team_review_dataset_revisions r ON r.project_id=d.project_id AND r.dataset_id=d.id WHERE d.project_id=? AND d.id=? AND r.version=?`, project, id, version);
    if (!row) throw missing();
    try {
      const cases = parseTeamReviewCases(parseTeamReviewStored(row.cases_json, TEAM_REVIEW_REVISION_BYTES));
      if (digest(canonicalCaseDefinitions(cases)) !== row.hash || version > 20) return this.#reviewIntegrity();
      return { projectId: project, datasetId: id, datasetName: parseTeamReviewDataset({name: row.name}).name, version, cases, hash: row.hash, createdAt: reviewTimestamp(row.created_at) };
    } catch { return this.#reviewIntegrity(); }
  }
  createReviewDataset(context: ProjectContext, body: unknown): TeamReviewDatasetRevision {
    return this.#write(() => {
      const scope = this.#project(context, "editor"), {name} = parseTeamReviewDataset(body), id = randomUUID(), now = this.#now(); this.#reviewRetention(scope.projectId);
      if (this.#count("SELECT count(*) AS n FROM team_review_datasets WHERE project_id=?", scope.projectId) >= 50) throw quota();
      this.#run("INSERT INTO team_review_datasets VALUES(?,?,?,1,?)", scope.projectId, id, name, now);
      this.#run("INSERT INTO team_review_dataset_revisions VALUES(?,?,1,'[]',?,?)", scope.projectId, id, digest(canonicalCaseDefinitions([])), now);
      this.#reviewRetention(scope.projectId); this.#audit(scope, "review_dataset.created", {type:"reviewDataset", id}); return this.#readReviewRevision(scope.projectId, id, 1);
    });
  }
  listReviewDatasets(context: ProjectContext): TeamReviewDataset[] {
    return this.#db.transaction(() => {
      const scope = this.#project(context); this.#reviewRetention(scope.projectId);
      return this.#all<{id: string;latest_version: number}>("SELECT id,latest_version FROM team_review_datasets WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 50", scope.projectId).map(row => {
        const revision = this.#readReviewRevision(scope.projectId, row.id, row.latest_version);
        return {projectId:scope.projectId,id:row.id,name:revision.datasetName,latestVersion:revision.version,caseCount:revision.cases.length,createdAt:revision.createdAt};
      });
    }).immediate();
  }
  getReviewDatasetRevision(context: ProjectContext, id: string, version: number): TeamReviewDatasetRevision {
    return this.#db.transaction(() => { const scope = this.#project(context); return this.#readReviewRevision(scope.projectId, id, version); }).immediate();
  }
  deleteReviewDataset(context: ProjectContext, id: string): void {
    this.#write(() => { const scope = this.#project(context, "admin"); requiredId(id);
      if (!this.#get("SELECT id FROM team_review_datasets WHERE project_id=? AND id=?", scope.projectId, id)) throw missing();
      this.#run("DELETE FROM team_review_datasets WHERE project_id=? AND id=?", scope.projectId, id); this.#audit(scope, "review_dataset.deleted", {type:"reviewDataset",id}); });
  }
  #reviewPromotion(project: string, queue: string, key: string): {request: import("../review-queues/protocol").PromotionRequest;receipt: TeamReviewReceipt} | null {
    requiredId(queue); requiredId(key);
    const row = this.#get<{request_json: string | null;request_hash: string;result_json: string | null;result_hash: string}>(`SELECT
      CASE WHEN length(CAST(request_json AS BLOB))<=${R.MAX_RECEIPT_BYTES} THEN request_json END AS request_json,request_hash,
      CASE WHEN length(CAST(result_json AS BLOB))<=${R.MAX_RECEIPT_BYTES} THEN result_json END AS result_json,result_hash FROM team_review_promotions WHERE project_id=? AND queue_id=? AND idempotency_key=?`, project, queue, key);
    if (!row) return null;
    try {
      const request = parseTeamReviewPromotion(parseTeamReviewStored(row.request_json, R.MAX_RECEIPT_BYTES)), receipt = parseTeamReviewReceipt(parseTeamReviewStored(row.result_json, R.MAX_RECEIPT_BYTES));
      if (request.queueId !== queue || request.idempotencyKey !== key || receipt.projectId !== project || receipt.queueId !== queue
        || reviewHash(request) !== row.request_hash || reviewHash(receipt) !== row.result_hash || receipt.promotionId !== reviewHash([project, queue, key])
        || receipt.datasetId !== request.datasetId || receipt.datasetVersion !== request.expectedDatasetVersion + 1
        || canonicalReviewJson(receipt.itemIds) !== canonicalReviewJson(request.items.map(item => item.itemId))
        || canonicalReviewJson(receipt.caseIds) !== canonicalReviewJson(receipt.itemIds.map(item => reviewCaseId(queue, item)))) return this.#reviewIntegrity();
      const revision = this.#readReviewRevision(project, receipt.datasetId, receipt.datasetVersion);
      if (receipt.datasetHash !== revision.hash || receipt.caseIds.some(id => !revision.cases.some(item => item.id === id))) return this.#reviewIntegrity(); return {request,receipt};
    } catch { return this.#reviewIntegrity(); }
  }
  getReviewPromotion(context: ProjectContext, queueId: string, key: string): TeamReviewReceipt {
    return this.#db.transaction(() => { const scope = this.#project(context); return this.#reviewPromotion(scope.projectId, queueId, key)?.receipt ?? (() => {throw missing();})(); }).immediate();
  }
  promoteReviewItems(context: ProjectContext, body: unknown): TeamReviewReceipt {
    return this.#write(() => {
      const scope = this.#project(context, "editor"), request = parseTeamReviewPromotion(body), requestHash = reviewHash(request);
      const previous = this.#reviewPromotion(scope.projectId, request.queueId, request.idempotencyKey);
      if (previous) {
        if (reviewHash(previous.request) !== requestHash) throw new TeamError("conflict", "Promotion retry differs from its original request"); return previous.receipt;
      }
      this.#reviewRetention(scope.projectId);
      const queue = this.#readReviewQueue(scope.projectId, request.queueId), head = this.#get<{latest_version: number}>("SELECT latest_version FROM team_review_datasets WHERE project_id=? AND id=?", scope.projectId, request.datasetId);
      if (!head) throw missing();
      if (head.latest_version !== request.expectedDatasetVersion) throw new TeamError("conflict", "Dataset changed; reload its current revision");
      if (head.latest_version >= 20) throw new TeamError("conflict", "Dataset revision limit reached");
      const revision = this.#readReviewRevision(scope.projectId, request.datasetId, head.latest_version), version = head.latest_version + 1;
      const items = request.items.map(selected => {
        const item = this.#readReviewItem(scope.projectId, queue, selected.itemId);
        if (item.revision !== selected.expectedRevision || item.state !== "approved" || item.approvedHash !== approvalHash(queue.schema, item.sourceHash, item.draftHash)) throw new TeamError("conflict", "Project review changed; approve its current revision before promotion"); return item;
      });
      const added = items.map(item => compileTeamReviewCase(scope.projectId, item, queue.schema)), cases = [...revision.cases, ...added];
      if (cases.length > 50 || new Set(cases.map(item => item.id)).size !== cases.length) throw new TeamError("conflict", "Dataset case limit or duplicate case identity prevents promotion");
      parseTeamReviewCases(cases); const data = canonicalReviewJson(cases), now = this.#now(), hash = digest(canonicalCaseDefinitions(cases));
      if (bytes(data) > TEAM_REVIEW_REVISION_BYTES) throw new TeamError("too_large", "Frozen dataset revision exceeds its row limit");
      if (this.#count("SELECT count(*) AS n FROM team_review_promotions WHERE project_id=?", scope.projectId) >= R.MAX_PROMOTIONS) throw quota();
      this.#run("INSERT INTO team_review_dataset_revisions VALUES(?,?,?,?,?,?)", scope.projectId, revision.datasetId, version, data, hash, now);
      this.#run("UPDATE team_review_datasets SET latest_version=? WHERE project_id=? AND id=? AND latest_version=?", version, scope.projectId, revision.datasetId, head.latest_version);
      for (const item of items) this.#persistReviewItem(scope, promoteTeamReviewItem(scope.projectId, item, queue.schema, item.revision, {datasetId:revision.datasetId,datasetVersion:version}, Math.max(now,item.updatedAt)), item.revision);
      const receipt: TeamReviewReceipt = {projectId:scope.projectId,queueId:queue.id,promotionId:reviewHash([scope.projectId,queue.id,request.idempotencyKey]),datasetId:revision.datasetId,datasetVersion:version,datasetHash:hash,
        itemIds:items.map(item=>item.id),caseIds:added.map(item=>item.id),createdAt:now,actor:{accountId:scope.user.id,role:scope.role}};
      const result = canonicalReviewJson(receipt), requested = canonicalReviewJson(request);
      if (bytes(result) > R.MAX_RECEIPT_BYTES || bytes(requested) > R.MAX_RECEIPT_BYTES) throw new TeamError("too_large", "Promotion receipt exceeds its row limit");
      this.#run("INSERT INTO team_review_promotions VALUES(?,?,?,?,?,?,?)", scope.projectId,queue.id,request.idempotencyKey,requested,requestHash,result,reviewHash(receipt));
      this.#reviewRetention(scope.projectId); this.#audit(scope,"review_items.promoted",{type:"reviewDataset",id:revision.datasetId}); return receipt;
    });
  }

  #audit(scope: ProjectContext | IngestContext, action: AuditEvent["action"], target: AuditEvent["target"], details: AuditEvent["details"] = {}): void {
    const now = this.#now();
    const entry: AuditEvent = { id: randomUUID(), createdAt: now, requestId: scope.requestId, actor: "keyId" in scope ? { type: "ingestKey", id: scope.keyId } : { type: "account", id: scope.user.id }, action, target, outcome: "success", details };
    this.#run("INSERT INTO audit_events(project_id,id,created_at,data) VALUES(?,?,?,?)", scope.projectId, entry.id, now, JSON.stringify(entry));
    if (this.#count("SELECT COUNT(*) AS n FROM audit_events WHERE project_id=?", scope.projectId) > L.PROJECT_AUDIT) {
      this.#run("DELETE FROM audit_events WHERE sequence IN (SELECT sequence FROM audit_events WHERE project_id=? ORDER BY sequence DESC LIMIT -1 OFFSET ?)", scope.projectId, L.PROJECT_AUDIT);
      this.#run("UPDATE projects SET audit_pruned=1 WHERE id=?", scope.projectId);
    }
  }
  listAudit(context: ProjectContext, query?: PageQuery): AuditPage {
    const scope = this.#project(context, "admin"), paging = this.#paging(query, scope.projectId, "audit"), anchor = this.#anchor(paging, "created_at", "id");
    const rows = this.#all<{ data: string }>(`SELECT data FROM audit_events WHERE project_id=?${anchor.sql} ORDER BY created_at DESC,id DESC LIMIT ?`, scope.projectId, ...anchor.args, paging.limit + 1).map(row => JSON.parse(row.data) as AuditEvent);
    return { ...pageResult(rows, paging, row => [row.createdAt, row.id]), retention: { maxEntries: L.PROJECT_AUDIT, oldestAvailableAt: this.#get<{ n: number | null }>("SELECT MIN(created_at) AS n FROM audit_events WHERE project_id=?", scope.projectId)?.n ?? null, hasPrunedHistory: this.#get<ProjectRow>("SELECT * FROM projects WHERE id=?", scope.projectId)?.audit_pruned === 1 } };
  }
}
