import type { Database, SQLQueryBindings } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { strictEvidenceJson } from "../evaluations/evidence-reader/json";
import { readerLimits } from "../evaluations/evidence-reader/limits";
import { freezeRateRevision } from "../pricing/rates";
import type { FrozenRateRevision } from "../pricing/protocol";
import { PromptRegistry, type PromptOwner } from "./registry";
import { promptId, promptInteger, promptObject, promptText, type PromptCapability, type PromptFence } from "./protocol";
import { COMPARISON_LIMITS as L, ComparisonError, comparisonJson, parseComparisonRequest, freezeComparisonRequest, type FrozenComparisonRequest, type ComparisonProvider } from "./comparison-protocol";
import { reserveComparisonAttempt, estimateComparisonUsage } from "./spend-ledger";
import type { acquireComparisonOwner, ComparisonOwnerFence } from "./comparison-owner";
import type { ComparisonProviderResult } from "./providers";

type LiveOwner = Awaited<ReturnType<typeof acquireComparisonOwner>>;
export interface ComparisonFence extends PromptFence { readonly comparisonGeneration: number; readonly owner: ComparisonOwnerFence }
export type ComparisonAttemptStatus = "queued" | "running" | "completed" | "failed" | "timeout" | "cancelled" | "unavailable" | "budget_refused" | "interrupted" | "authority_lost";
interface FrozenExecution extends FrozenComparisonRequest { readonly rates: readonly FrozenRateRevision[] }
export interface ComparisonAttempt {
  position: number; provider: ComparisonProvider; model: string; status: ComparisonAttemptStatus; reason: string | null; payload: unknown;
  reserveMicrousd: number; holdMicrousd: number; chargeMicrousd: number; accountingState: string; observedEstimateUsd: string | null;
  budgetBreach: boolean; deadlineAt: number; startedAt: number | null; finishedAt: number | null;
}
export interface ComparisonReceipt { id: string; operationKey: string; createdAt: number; tombstone: boolean; request: FrozenExecution | null; attempts: ComparisonAttempt[] }
interface StoreOptions { readonly budgets: Readonly<Record<ComparisonProvider, number>>; readonly availability: Readonly<Record<ComparisonProvider, boolean>> }
interface Head { id: string; operation_key: string; request_digest: string; frozen_request: string | null; tombstone: number; target_count: number; created_at: number; prompt_generation: number; evidence_generation: number; comparison_generation: number; bounded: number }
interface Row { position: number; provider: ComparisonProvider; model: string; status: ComparisonAttemptStatus; reason: string | null; payload: string | null; reserve_microusd: number; hold_microusd: number; charge_microusd: number; accounting_state: string; observed_estimate_usd: string | null; budget_breach: number; deadline_at: number; started_at: number | null; finished_at: number | null; bounded: number }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const bytes = (column: string) => `length(CAST(${column} AS BLOB))`;
const cell = (column: string, maximum: number) => `CASE WHEN ${column} IS NULL OR typeof(${column})='text' AND ${bytes(column)}<=${maximum} THEN ${column} ELSE NULL END AS ${column}`;
const integer = (column: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => `CASE WHEN typeof(${column})='integer' AND ${column} BETWEEN ${minimum} AND ${maximum} THEN ${column} ELSE NULL END AS ${column}`;
const same = (a: ComparisonFence, b: ComparisonFence) => a.promptGeneration === b.promptGeneration && a.evidenceGeneration === b.evidenceGeneration && a.comparisonGeneration === b.comparisonGeneration && a.owner.birth === b.owner.birth && a.owner.generation === b.owner.generation;
const positionValue = (value: unknown): number => { if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 3) throw new ComparisonError("invalid_request"); return value; };
const chargeCap = 2251799813685;
const attemptContent = ["status", "reason", "payload", "accounting_state", "observed_estimate_usd"];
const contentBytes = (...values: (string | null)[]) => values.reduce((total, value) => total + (value === null ? 0 : Buffer.byteLength(value)), 0);
const reasons = new Set(["provider_error", "invalid_response", "response_limit", "protected_content", "cancelled", "timeout", "authority_lost"]);
const terminal = new Set<ComparisonAttemptStatus>(["completed", "failed", "timeout", "cancelled", "unavailable", "budget_refused", "interrupted", "authority_lost"]);
const headColumns = [cell("id", 36), cell("operation_key", 36), cell("request_digest", 64), cell("frozen_request", L.frozenRequestBytes), integer("tombstone", 0, 1), integer("target_count", 1, 4), integer("created_at"), integer("prompt_generation", 1), integer("evidence_generation", 1), integer("comparison_generation", 1),
  `CASE WHEN frozen_request IS NULL OR typeof(frozen_request)='text' AND ${bytes("frozen_request")}<=${L.frozenRequestBytes} THEN 1 ELSE 0 END AS bounded`].join(",");
const attemptColumns = [integer("position", 0, 3), cell("provider", 16), cell("model", 128), cell("status", 32), cell("reason", 64), cell("payload", L.attemptPayloadBytes), integer("reserve_microusd", 0, L.providerBudgetMicrousd), integer("hold_microusd", 0, L.providerBudgetMicrousd), integer("charge_microusd", 0, chargeCap), cell("accounting_state", 32), cell("observed_estimate_usd", 64), integer("budget_breach", 0, 1), integer("deadline_at"),
  "CASE WHEN started_at IS NULL OR typeof(started_at)='integer' AND started_at BETWEEN 0 AND 9007199254740991 THEN started_at ELSE -1 END AS started_at",
  "CASE WHEN finished_at IS NULL OR typeof(finished_at)='integer' AND finished_at BETWEEN 0 AND 9007199254740991 THEN finished_at ELSE -1 END AS finished_at",
  `CASE WHEN (payload IS NULL OR typeof(payload)='text' AND ${bytes("payload")}<=${L.attemptPayloadBytes}) AND (reason IS NULL OR typeof(reason)='text' AND ${bytes("reason")}<=64) AND (observed_estimate_usd IS NULL OR typeof(observed_estimate_usd)='text' AND ${bytes("observed_estimate_usd")}<=64) THEN 1 ELSE 0 END AS bounded`].join(",");

/** Trusted actual owner connection only. This store remains unregistered pending canonical14/Teamv5. */
export class ComparisonStore {
  readonly #db: Database; readonly #scope: string; readonly #owner: PromptOwner; readonly #live: LiveOwner;
  readonly #options: StoreOptions; readonly #prompts: PromptRegistry;
  constructor(owner: PromptOwner, live: LiveOwner, options: StoreOptions) {
    if (!live.ownsDatabase(owner.database.filename)) throw new ComparisonError("unavailable");
    this.#prompts = new PromptRegistry(owner); this.#owner = owner; this.#db = owner.database; this.#scope = `${owner.scope.kind}:${owner.scope.id}`; this.#live = live;
    this.#options = Object.freeze({ budgets: Object.freeze({ ...options.budgets }), availability: Object.freeze({ ...options.availability }) });
    for (const provider of ["openai", "anthropic"] as const) if (!Number.isSafeInteger(options.budgets[provider]) || options.budgets[provider] < 0 || options.budgets[provider] > L.providerBudgetMicrousd || typeof options.availability[provider] !== "boolean") throw new ComparisonError("invalid_request");
  }
  #get<T>(sql: string, ...parameters: SQLQueryBindings[]): T | null { return this.#db.query(sql).get(...parameters) as T | null; }
  #generation(capability: PromptCapability): ComparisonFence {
    this.#owner.authorize(capability); const owner = this.#live.capture();
    const row = this.#get<{ comparisonGeneration: number; promptGeneration: number; evidenceGeneration: number; active: number }>(
      "SELECT CASE WHEN typeof(c.generation)='integer' AND c.generation BETWEEN 1 AND 9007199254740991 THEN c.generation ELSE NULL END comparisonGeneration, CASE WHEN typeof(p.generation)='integer' AND p.generation BETWEEN 1 AND 9007199254740991 THEN p.generation ELSE NULL END promptGeneration, CASE WHEN typeof(e.generation)='integer' AND e.generation BETWEEN 1 AND 9007199254740991 THEN e.generation ELSE NULL END evidenceGeneration, CASE WHEN typeof(e.active)='integer' AND e.active=1 THEN 1 ELSE NULL END active FROM comparison_scope_controls c JOIN prompt_scope_controls p USING(scope_key) JOIN evaluation_evidence_scopes e USING(scope_key) WHERE c.scope_key=?", this.#scope);
    if (!row || row.active !== 1) throw new ComparisonError("unavailable");
    try { return Object.freeze({ comparisonGeneration: promptInteger(row.comparisonGeneration), promptGeneration: promptInteger(row.promptGeneration), evidenceGeneration: promptInteger(row.evidenceGeneration), owner }); }
    catch { throw new ComparisonError("integrity"); }
  }
  capture(capability: PromptCapability): ComparisonFence { return this.#db.transaction(() => this.#generation(capability)).immediate(); }
  #transaction<T>(capability: PromptCapability, fence: ComparisonFence, work: (current: ComparisonFence) => T): T {
    return this.#db.transaction(() => {
      const current = this.#generation(capability); if (!same(current, fence)) throw new ComparisonError("authority_changed");
      this.#totals(); const result = work(current); this.#totals(); if (!same(current, this.#generation(capability))) throw new ComparisonError("authority_changed"); comparisonJson(result); return result;
    }).immediate();
  }
  #totals() {
    const count = (table: string) => this.#get<{ n: number }>(`SELECT count(*) n FROM ${table}`)!.n;
    const operations = count("prompt_comparisons"), attempts = count("prompt_comparison_attempts"), controls = count("comparison_scope_controls");
    const scoped = this.#get<{ n: number }>("SELECT count(*) n FROM prompt_comparisons WHERE scope_key=?", this.#scope)!.n;
    if (operations > L.operationsGlobal || attempts > L.attemptsGlobal || controls > L.controlsGlobal || scoped > L.operationsPerScope) throw new ComparisonError("integrity");
    const invalid = this.#get<{ n: number }>(`SELECT EXISTS(SELECT 1 FROM prompt_comparison_attempts WHERE typeof(charge_microusd)<>'integer' OR charge_microusd NOT BETWEEN 0 AND ${chargeCap} OR typeof(hold_microusd)<>'integer' OR hold_microusd NOT BETWEEN 0 AND ${L.providerBudgetMicrousd} OR hold_microusd<>0 AND charge_microusd<>0 LIMIT 1) n`)!.n;
    if (invalid) throw new ComparisonError("integrity");
    const sums = (columns: string[]) => columns.map(column => `coalesce(${bytes(column)},0)`).join("+");
    const total = this.#get<{ n: number }>(`SELECT (SELECT coalesce(sum(${sums(["scope_key", "id", "operation_key", "request_digest", "prompt_id", "frozen_request"])}+80),0) FROM prompt_comparisons)+(SELECT coalesce(sum(${sums(["scope_key", "comparison_id", "provider", "model", "status", "reason", "payload", "accounting_state", "observed_estimate_usd"])}+96),0) FROM prompt_comparison_attempts)+(SELECT coalesce(sum(${bytes("scope_key")}+8),0) FROM comparison_scope_controls) n`)!.n;
    if (!Number.isSafeInteger(total) || total < 0 || total > L.retainedBytes) throw new ComparisonError("integrity");
    return { operations, attempts, scoped, bytes: total };
  }
  #pendingRetention() {
    // Reserve every pending replacement, including its terminal reason and accounting cells.
    const current = attemptContent.map(column => `coalesce(${bytes(column)},0)`).join("+");
    return this.#get<{ n: number }>(`SELECT coalesce(sum(${L.attemptPayloadBytes + 32 + 64 + 32 + 64}-(${current})),0) n FROM prompt_comparison_attempts WHERE status IN('queued','running')`)!.n;
  }
  #cleanupRetention(id: string, position: number | null) {
    return this.#get<{ n: number }>(`SELECT coalesce(sum(max(0,${Buffer.byteLength("authority_lost") + Buffer.byteLength("privacy_removed")}-${bytes("status")}-coalesce(${bytes("reason")},0))),0) n FROM prompt_comparison_attempts WHERE status IN('queued','running') AND NOT(scope_key=? AND comparison_id=? AND (? IS NULL OR position=?))`, this.#scope, id, position, position)!.n;
  }
  #budgetTotals() {
    const totals = {} as Record<ComparisonProvider, { chargeMicrousd: number; holdMicrousd: number; breached: boolean; ceilingMicrousd: number }>;
    for (const provider of ["openai", "anthropic"] as const) {
      const row = this.#get<{ charge: number; hold: number; breach: number }>("SELECT coalesce(sum(charge_microusd),0) charge,coalesce(sum(hold_microusd),0) hold,coalesce(max(budget_breach),0) breach FROM prompt_comparison_attempts WHERE provider=?", provider)!;
      if (!Number.isSafeInteger(row.charge + row.hold)) throw new ComparisonError("integrity");
      totals[provider] = { chargeMicrousd: row.charge, holdMicrousd: row.hold, breached: row.breach === 1, ceilingMicrousd: this.#options.budgets[provider] };
    }
    return totals;
  }
  /** Internal owner admission accounting, never a cross-project HTTP response. */
  budgetTotals() { const owner = this.#live.capture(); return this.#db.transaction(() => { this.#live.assertCurrent(owner); this.#totals(); return this.#budgetTotals(); }).immediate(); }
  #head(id: string): Head {
    const row = this.#get<Head>(`SELECT ${headColumns} FROM prompt_comparisons WHERE scope_key=? AND id=?`, this.#scope, id);
    if (!row) throw new ComparisonError("not_found");
    if (row.bounded !== 1 || Object.entries(row).some(([key, value]) => key !== "frozen_request" && value === null) || !/^[a-f0-9]{64}$/.test(row.request_digest)) throw new ComparisonError("integrity");
    try { promptId(row.id); promptId(row.operation_key); } catch { throw new ComparisonError("integrity"); }
    if ((row.tombstone === 1) !== (row.frozen_request === null)) throw new ComparisonError("integrity"); return row;
  }
  #request(head: Head): FrozenExecution | null {
    if (head.frozen_request === null) return null;
    try {
      const raw = strictEvidenceJson(promptText(head.frozen_request, L.frozenRequestBytes), readerLimits({ maxDepth: 16 })) as FrozenExecution;
      const parsed = parseComparisonRequest({ operationKey: raw.operationKey, promptId: raw.promptId, revision: raw.revision, variables: raw.variables, targets: raw.targets, options: raw.options, operationBudgetMicrousd: raw.operationBudgetMicrousd, expectedGeneration: raw.expectedGeneration });
      if (!raw.prompt || raw.prompt.id !== parsed.promptId || raw.prompt.revision !== parsed.revision || raw.targets.length !== head.target_count || raw.operationKey !== head.operation_key || !Array.isArray(raw.rates) || raw.rates.length !== head.target_count || raw.policy !== "runphantom-model-comparison/v1") throw new Error();
      const { expectedGeneration: _expected, ...semantic } = parsed;
      if (hash(comparisonJson({ scope: this.#scope, request: semantic })) !== head.request_digest) throw new Error();
      promptText(raw.prompt.name, 256, false); if (!/^[a-f0-9]{64}$/.test(raw.prompt.templateSha256)) throw new Error();
      promptText(raw.compiled, L.inputBytes); for (const rate of raw.rates) freezeRateRevision(rate); comparisonJson(raw, L.frozenRequestBytes); return raw;
    } catch { throw new ComparisonError("integrity"); }
  }
  #receipt(head: Head): ComparisonReceipt {
    const rows = this.#db.query(`SELECT ${attemptColumns} FROM prompt_comparison_attempts WHERE scope_key=? AND comparison_id=? ORDER BY position LIMIT 5`).all(this.#scope, head.id) as Row[];
    if (rows.length !== head.target_count) throw new ComparisonError("integrity");
    const request = this.#request(head);
    const attempts = rows.map((row, position): ComparisonAttempt => {
      const optional = new Set(["reason", "payload", "observed_estimate_usd", "started_at", "finished_at"]);
      if (row.bounded !== 1 || row.position !== position || Object.entries(row).some(([key, value]) => !optional.has(key) && value === null) || row.started_at === -1 || row.finished_at === -1 || !["openai", "anthropic"].includes(row.provider) || !terminal.has(row.status) && !["queued", "running"].includes(row.status) || head.tombstone === 1 && row.payload !== null) throw new ComparisonError("integrity");
      let payload: unknown = null;
      if (row.payload !== null) { try { payload = strictEvidenceJson(promptText(row.payload, L.attemptPayloadBytes), readerLimits({ maxDepth: 16 })); } catch { throw new ComparisonError("integrity"); } }
      if (request && (row.provider !== request.targets[position].provider || row.model !== request.targets[position].model)) throw new ComparisonError("integrity");
      return { position, provider: row.provider, model: row.model, status: row.status, reason: row.reason, payload, reserveMicrousd: row.reserve_microusd, holdMicrousd: row.hold_microusd, chargeMicrousd: row.charge_microusd, accountingState: row.accounting_state, observedEstimateUsd: row.observed_estimate_usd, budgetBreach: row.budget_breach === 1, deadlineAt: row.deadline_at, startedAt: row.started_at, finishedAt: row.finished_at };
    });
    const result = { id: head.id, operationKey: head.operation_key, createdAt: head.created_at, tombstone: head.tombstone === 1, request, attempts }; comparisonJson(result); return result;
  }
  submit(value: unknown, fence: ComparisonFence): ComparisonReceipt {
    const input = parseComparisonRequest(value), { expectedGeneration: _expected, ...semantic } = input;
    const requestDigest = hash(comparisonJson({ scope: this.#scope, request: semantic }));
    return this.#transaction("edit", fence, current => {
      if (input.expectedGeneration !== current.comparisonGeneration) throw new ComparisonError("authority_changed");
      const previous = this.#get<{ id: string }>(`SELECT ${cell("id", 36)} FROM prompt_comparisons WHERE scope_key=? AND operation_key=?`, this.#scope, input.operationKey);
      if (previous) { const head = this.#head(previous.id); if (head.request_digest !== requestDigest) throw new ComparisonError("operation_conflict"); return this.#receipt(head); }
      const totals = this.#totals(); if (totals.operations >= L.operationsGlobal || totals.scoped >= L.operationsPerScope || totals.attempts + input.targets.length > L.attemptsGlobal) throw new ComparisonError("capacity");
      const source = this.#prompts.get(input.promptId, input.revision, { promptGeneration: current.promptGeneration, evidenceGeneration: current.evidenceGeneration });
      const frozen = freezeComparisonRequest(input, source), reservations = input.targets.map(target => reserveComparisonAttempt(frozen.compiled, target, input.options.maxOutputTokens));
      const execution = { ...frozen, rates: reservations.map(reservation => reservation.rate) }, serialized = comparisonJson(execution, L.frozenRequestBytes);
      const scopeBytes = Buffer.byteLength(this.#scope), headBytes = scopeBytes + 36 + 36 + 64 + 36 + Buffer.byteLength(serialized) + 80;
      const targetBytes = input.targets.reduce((total, target) => total + scopeBytes + 36 + Buffer.byteLength(target.provider) + Buffer.byteLength(target.model) + 32 + 64 + L.attemptPayloadBytes + 32 + 64 + 96, 0);
      if (totals.bytes + this.#pendingRetention() + headBytes + targetBytes > L.retainedBytes) throw new ComparisonError("capacity");
      const budget = this.#budgetTotals(), queue = this.#get<{ n: number }>("SELECT count(*) n FROM (SELECT scope_key,comparison_id FROM prompt_comparison_attempts WHERE status='queued' GROUP BY scope_key,comparison_id)")!.n;
      const held = { openai: 0, anthropic: 0 }; let operationHold = 0;
      input.targets.forEach((target, index) => { if (this.#options.availability[target.provider]) { held[target.provider] += reservations[index].microusd; operationHold += reservations[index].microusd; } });
      const refused = queue >= L.queued || operationHold > input.operationBudgetMicrousd || (["openai", "anthropic"] as const).some(provider => held[provider] > 0 && (budget[provider].breached || budget[provider].holdMicrousd + budget[provider].chargeMicrousd + held[provider] > budget[provider].ceilingMicrousd));
      const id = randomUUID(), now = Date.now();
      this.#db.query("INSERT INTO prompt_comparisons(scope_key,id,operation_key,request_digest,prompt_id,frozen_request,prompt_generation,evidence_generation,comparison_generation,target_count,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(this.#scope, id, input.operationKey, requestDigest, input.promptId, serialized, current.promptGeneration, current.evidenceGeneration, current.comparisonGeneration, input.targets.length, now);
      input.targets.forEach((target, position) => {
        const status = !this.#options.availability[target.provider] ? "unavailable" : refused ? "budget_refused" : "queued", hold = status === "queued" ? reservations[position].microusd : 0;
        this.#db.query("INSERT INTO prompt_comparison_attempts(scope_key,comparison_id,position,provider,model,status,reason,reserve_microusd,hold_microusd,charge_microusd,accounting_state,deadline_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,0,'not_started',?,?)").run(this.#scope, id, position, target.provider, target.model, status, status === "queued" ? null : status, reservations[position].microusd, hold, now + L.attemptMs, status === "queued" ? null : now);
      });
      return this.#receipt(this.#head(id));
    });
  }
  get(idValue: unknown, fence: ComparisonFence): ComparisonReceipt { const id = promptId(idValue); return this.#transaction("read", fence, () => this.#receipt(this.#head(id))); }
  export(idValue: unknown, fence: ComparisonFence) { return { format: "runphantom-model-comparison/v1" as const, operation: this.get(idValue, fence) }; }
  start(idValue: unknown, positionInput: unknown, fence: ComparisonFence): { request: FrozenExecution; position: number; remainingMs: number } | null {
    const id = promptId(idValue), position = positionValue(positionInput);
    return this.#transaction("edit", fence, current => {
      const head = this.#head(id); if (head.tombstone) throw new ComparisonError("deleted"); const receipt = this.#receipt(head), attempt = receipt.attempts[position];
      if (!attempt) throw new ComparisonError("invalid_request"); if (attempt.status !== "queued") return null;
      const now = Date.now(), budget = this.#budgetTotals();
      const status = head.prompt_generation !== current.promptGeneration || head.evidence_generation !== current.evidenceGeneration || head.comparison_generation !== current.comparisonGeneration ? "authority_lost" : attempt.deadlineAt <= now ? "timeout" : budget[attempt.provider].breached ? "budget_refused" : null;
      if (status) { this.#db.query("UPDATE prompt_comparison_attempts SET status=?,reason=?,hold_microusd=0,finished_at=? WHERE scope_key=? AND comparison_id=? AND position=? AND status='queued'").run(status, status, now, this.#scope, id, position); return null; }
      const running = this.#get<{ n: number }>("SELECT count(*) n FROM prompt_comparison_attempts WHERE status='running'")!.n; if (running >= L.active) return null;
      this.#prompts.get(receipt.request!.promptId, receipt.request!.revision, { promptGeneration: current.promptGeneration, evidenceGeneration: current.evidenceGeneration });
      this.#db.query("UPDATE prompt_comparison_attempts SET status='running',hold_microusd=0,charge_microusd=reserve_microusd,accounting_state='conservative',started_at=? WHERE scope_key=? AND comparison_id=? AND position=? AND status='queued'").run(now, this.#scope, id, position);
      return { request: receipt.request!, position, remainingMs: attempt.deadlineAt - now };
    });
  }
  finish(idValue: unknown, positionInput: unknown, fence: ComparisonFence, outcome: { status: "completed"; result: ComparisonProviderResult } | { status: "failed" | "timeout" | "cancelled"; reason: string }): ComparisonReceipt {
    const id = promptId(idValue), position = positionValue(positionInput);
    return this.#transaction("edit", fence, () => {
      const head = this.#head(id); if (head.tombstone) throw new ComparisonError("deleted"); const receipt = this.#receipt(head), row = receipt.attempts[position];
      if (!row || row.status !== "running") throw new ComparisonError("operation_conflict");
      let charge = row.reserveMicrousd, state = "conservative", observed: string | null = null, breach = 0, payload: string | null = null, reason: string | null = null;
      let status: ComparisonAttemptStatus = outcome.status;
      if (outcome.status === "completed") {
        promptText(outcome.result.output, L.attemptPayloadBytes); const priced = estimateComparisonUsage(receipt.request!.targets[position], outcome.result.usage, receipt.request!.rates[position]);
        const total = priced.estimate.totalUsd;
        const observations = outcome.result.usage, reservation = reserveComparisonAttempt(receipt.request!.compiled, receipt.request!.targets[position], receipt.request!.options.maxOutputTokens);
        const known = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
        let inputMinimum = known(observations.inputTokens) ? observations.inputTokens : 0;
        if (row.provider === "anthropic") for (const value of [observations.cacheReadTokens, observations.cacheWriteTokens]) if (known(value)) inputMinimum += value;
        if (!Number.isSafeInteger(inputMinimum) || inputMinimum > reservation.inputTokenCeiling || known(observations.outputTokens) && observations.outputTokens > receipt.request!.options.maxOutputTokens) breach = 1;
        if (total !== null && Number.isFinite(total) && total >= 0) {
          observed = String(total); const amount = Math.ceil(total * 1000000); breach = breach || (amount > row.reserveMicrousd ? 1 : 0);
          if (Number.isSafeInteger(amount) && amount <= chargeCap) { charge = amount; state = "measured_estimate"; }
          else { state = "unrepresentable_overage"; breach = 1; }
        }
        try { payload = comparisonJson({ ...outcome.result, ...priced }, L.attemptPayloadBytes); }
        catch (error) {
          if (!(error instanceof ComparisonError) || error.code !== "limit_refused") throw error;
          status = "failed"; reason = "response_limit";
        }
      } else { if (!reasons.has(outcome.reason)) throw new ComparisonError("invalid_request"); reason = outcome.reason; }
      const currentBytes = this.#get<{ n: number }>(`SELECT ${attemptContent.map(column => `coalesce(${bytes(column)},0)`).join("+")} n FROM prompt_comparison_attempts WHERE scope_key=? AND comparison_id=? AND position=?`, this.#scope, id, position)!.n;
      const retained = this.#totals().bytes - currentBytes;
      const cleanupBytes = this.#cleanupRetention(id, position);
      if (retained + contentBytes(status, reason, payload, state, observed) + cleanupBytes > L.retainedBytes && payload !== null) {
        status = "failed"; reason = "response_limit"; payload = null;
      }
      const projected = retained + contentBytes(status, reason, payload, state, observed), purge = projected + cleanupBytes > L.retainedBytes;
      if (purge) {
        // Historical receipts may predate reservation. Remove only this operation's content,
        // after preserving its terminal accounting, rather than stranding charged running work.
        const removed = this.#get<{ n: number }>(`SELECT coalesce(${bytes("frozen_request")},0)+coalesce(${bytes("prompt_id")},0) n FROM prompt_comparisons WHERE scope_key=? AND id=?`, this.#scope, id)!.n;
        const cleanup = this.#get<{ n: number }>(`SELECT coalesce(sum(CASE WHEN position=? THEN 0 ELSE CASE WHEN status IN('queued','running') THEN ${Buffer.byteLength("authority_lost") + Buffer.byteLength("privacy_removed")}-${bytes("status")}-coalesce(${bytes("reason")},0) ELSE 0 END-coalesce(${bytes("payload")},0) END),0) n FROM prompt_comparison_attempts WHERE scope_key=? AND comparison_id=?`, position, this.#scope, id)!.n;
        if (projected - removed + cleanup + this.#cleanupRetention(id, null) > L.retainedBytes) throw new ComparisonError("capacity");
      }
      this.#db.query("UPDATE prompt_comparison_attempts SET status=?,reason=?,payload=?,charge_microusd=?,accounting_state=?,observed_estimate_usd=?,budget_breach=?,finished_at=? WHERE scope_key=? AND comparison_id=? AND position=? AND status='running'").run(status, reason, payload, charge, state, observed, breach, Date.now(), this.#scope, id, position);
      if (purge) this.#db.query("UPDATE prompt_comparisons SET tombstone=1,frozen_request=NULL,prompt_id=NULL WHERE scope_key=? AND id=? AND tombstone=0").run(this.#scope, id);
      return this.#receipt(this.#head(id));
    });
  }
  cancel(idValue: unknown, fence: ComparisonFence): ComparisonReceipt {
    const id = promptId(idValue); return this.#transaction("edit", fence, () => {
      this.#head(id); this.#db.query("UPDATE prompt_comparison_attempts SET status='cancelled',reason='cancelled',hold_microusd=0,finished_at=? WHERE scope_key=? AND comparison_id=? AND status IN('queued','running')").run(Date.now(), this.#scope, id); return this.#receipt(this.#head(id));
    });
  }
  clear(value: unknown, fence: ComparisonFence): { removed: true; generation: number } {
    const input = promptObject(value, ["operationKey", "expectedGeneration", "confirmRemoval"]); promptId(input.operationKey);
    if (input.confirmRemoval !== true || promptInteger(input.expectedGeneration) !== fence.comparisonGeneration) throw new ComparisonError("invalid_request");
    return this.#db.transaction(() => {
      const current = this.#generation("delete"); if (!same(current, fence)) throw new ComparisonError("authority_changed"); this.#totals();
      if (current.comparisonGeneration === Number.MAX_SAFE_INTEGER) throw new ComparisonError("capacity");
      this.#db.query("UPDATE comparison_scope_controls SET generation=generation+1 WHERE scope_key=? AND generation=?").run(this.#scope, current.comparisonGeneration);
      this.#db.query("UPDATE prompt_comparisons SET tombstone=1,frozen_request=NULL,prompt_id=NULL WHERE scope_key=? AND tombstone=0").run(this.#scope);
      this.#totals();
      const next = this.#generation("delete"); if (!same({ ...current, comparisonGeneration: current.comparisonGeneration + 1 }, next)) throw new ComparisonError("authority_changed");
      return { removed: true as const, generation: next.comparisonGeneration };
    }).immediate();
  }
  /** Internal coordinator scope comparison; no caller string or database handle is exposed. */
  sameScope(other: ComparisonStore): boolean { return this.#db === other.#db && this.#scope === other.#scope && this.#live.ownsDatabase(other.#db.filename) && other.#live.ownsDatabase(this.#db.filename); }
  /** Native owner cleanup only: publication may lose user authority, but uncertain charge must remain. */
  terminatePending(idValue: unknown): void {
    const id = promptId(idValue), owner = this.#live.capture(); this.#db.transaction(() => {
      this.#live.assertCurrent(owner); if (!this.#live.ownsDatabase(this.#db.filename)) throw new ComparisonError("unavailable"); this.#totals();
      this.#db.query("UPDATE prompt_comparison_attempts SET status='authority_lost',reason='authority_lost',payload=NULL,hold_microusd=0,finished_at=? WHERE scope_key=? AND comparison_id=? AND status IN('queued','running')").run(Date.now(), this.#scope, id);
      this.#totals();
      this.#live.assertCurrent(owner);
    }).immediate();
  }
  /** Trusted startup only, after exclusive live lease; no retry or route can invoke recovery. */
  recoverPending(): void {
    const owner = this.#live.capture(); this.#db.transaction(() => {
      this.#live.assertCurrent(owner); this.#totals();
      this.#db.query("UPDATE prompt_comparison_attempts SET status='interrupted',reason='interrupted',hold_microusd=0,finished_at=? WHERE status IN('queued','running')").run(Date.now()); this.#totals(); this.#live.assertCurrent(owner);
    }).immediate();
  }
}
