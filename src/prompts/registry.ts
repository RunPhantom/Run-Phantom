import type { Database, SQLQueryBindings } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { EvidenceScope } from "../evaluations/evidence-protocol";
import { strictEvidenceJson } from "../evaluations/evidence-reader/json";
import { readerLimits } from "../evaluations/evidence-reader/limits";
import { PROMPT_LIMITS as L, PROMPT_POLICY, PromptRegistryError, boundedPromptResult,
  literalPromptCompilation, parsePromptDraft, promptId, promptInteger, promptObject, promptTemplate, promptText,
  type PromptCapability, type PromptCompilation, type PromptDraft, type PromptExport, type PromptHistoryEntry,
  type PromptPage, type PromptRevision, type PromptSummary } from "./protocol";

/** Trusted owner only: local $client or a closure over the actual private TeamStore database. */
export interface PromptOwner { readonly database: Database; readonly scope: EvidenceScope; authorize(capability: PromptCapability): void }
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const blobLength = (column: string) => `length(cast(${column} AS BLOB))`;
const textColumn = (column: string, maximum: number) => `CASE WHEN typeof(${column})='text' AND ${blobLength(column)}<=${maximum} THEN ${column} ELSE NULL END AS ${column}`;
const integerColumn = (column: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER) => `CASE WHEN typeof(${column})='integer' AND ${column} BETWEEN ${minimum} AND ${maximum} THEN ${column} ELSE NULL END AS ${column}`;
const headColumns = [textColumn("id", 36), integerColumn("revision", 1, 32), integerColumn("deleted", 0, 1), textColumn("create_operation_key", 36), textColumn("create_request_digest", 64), integerColumn("created_at", 0), integerColumn("updated_at", 0)].join(",");
const revisionColumns = [textColumn("id", 36), integerColumn("revision", 1, 32), textColumn("name", 256), textColumn("template", 32768), textColumn("template_sha256", 64), textColumn("variable_names", 4353), textColumn("policy", 32), textColumn("operation_key", 36), textColumn("request_digest", 64), integerColumn("created_at", 0)].join(",");
interface Head { id: string; revision: number; deleted: number; create_operation_key: string; create_request_digest: string; created_at: number; updated_at: number }
interface Revision { id: string; revision: number; name: string; template: string; template_sha256: string; variable_names: string; policy: string; operation_key: string; request_digest: string; created_at: number }
interface Totals { heads: number; scopeHeads: number; revisions: number; bytes: number }
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export class PromptRegistry {
  readonly #database: Database;
  readonly #scopeKey: string;
  readonly #owner: PromptOwner;
  constructor(owner: PromptOwner) {
    if (owner.scope.kind === "project") promptId(owner.scope.id);
    else if (owner.scope.kind !== "local" || owner.scope.id !== "local") throw new PromptRegistryError("unavailable");
    this.#owner = owner; this.#database = owner.database; this.#scopeKey = `${owner.scope.kind}:${owner.scope.id}`;
  }
  #get<T>(sql: string, ...params: SQLQueryBindings[]): T | null { return this.#database.query(sql).get(...params) as T | null; }
  #generation(capability: PromptCapability): number {
    this.#owner.authorize(capability);
    const row = this.#get<{ generation: number | null; active: number }>(`SELECT ${integerColumn("generation", 1)},active FROM evaluation_evidence_scopes WHERE scope_key=?`, this.#scopeKey);
    if (!row || row.active !== 1 || row.generation === null) throw new PromptRegistryError("unavailable");
    return row.generation;
  }
  capture(capability: PromptCapability): number { return this.#database.transaction(() => this.#generation(capability)).immediate(); }
  #transaction<T>(capability: PromptCapability, fence: number | undefined, work: (generation: number) => T): T {
    if (fence !== undefined) promptInteger(fence);
    return this.#database.transaction(() => {
      const generation = this.#generation(capability);
      if (fence !== undefined && generation !== fence) throw new PromptRegistryError("authority_changed");
      const result = boundedPromptResult(work(generation));
      if (this.#generation(capability) !== generation) throw new PromptRegistryError("authority_changed");
      return result;
    }).immediate();
  }
  #totals(): Totals {
    const heads = this.#get<{ n: number }>("SELECT count(*) AS n FROM prompt_heads")!.n;
    const revisions = this.#get<{ n: number }>("SELECT count(*) AS n FROM prompt_revisions")!.n;
    const scopeHeads = this.#get<{ n: number }>("SELECT count(*) AS n FROM prompt_heads WHERE scope_key=?", this.#scopeKey)!.n;
    if (heads > L.promptsGlobal || revisions > L.revisionsGlobal || scopeHeads > L.promptsPerScope) throw new PromptRegistryError("integrity");
    const headBytes = ["scope_key", "id", "create_operation_key", "create_request_digest"].map(blobLength).join("+");
    const revisionBytes = ["scope_key", "id", "name", "template", "template_sha256", "variable_names", "policy", "operation_key", "request_digest"].map(blobLength).join("+");
    const sizes = this.#get<{ bytes: number }>(`SELECT (SELECT coalesce(sum(${headBytes}),0) FROM prompt_heads)+(SELECT coalesce(sum(${revisionBytes}),0) FROM prompt_revisions) AS bytes`)!;
    if (!Number.isSafeInteger(sizes.bytes) || sizes.bytes < 0 || sizes.bytes > L.retainedBytes) throw new PromptRegistryError("integrity");
    return { heads, scopeHeads, revisions, bytes: sizes.bytes };
  }
  #head(id: string, includeDeleted = false): Head {
    const row = this.#get<Head>(`SELECT ${headColumns} FROM prompt_heads WHERE scope_key=? AND id=?`, this.#scopeKey, id);
    if (!row) throw new PromptRegistryError("not_found");
    try {
      if (Object.values(row).some(value => value === null) || row.id !== id || !hash(row.create_request_digest) || row.updated_at < row.created_at) throw new Error();
      promptId(row.id); promptId(row.create_operation_key);
    } catch { throw new PromptRegistryError("integrity"); }
    if (!includeDeleted && row.deleted) throw new PromptRegistryError("not_found");
    return row;
  }
  #revision(id: string, revision: number): PromptRevision {
    const row = this.#get<Revision>(`SELECT ${revisionColumns} FROM prompt_revisions WHERE scope_key=? AND id=? AND revision=?`, this.#scopeKey, id, revision);
    if (!row) throw new PromptRegistryError("not_found");
    try {
      if (Object.values(row).some(value => value === null) || row.id !== id || row.revision !== revision || row.policy !== PROMPT_POLICY || !hash(row.template_sha256) || !hash(row.request_digest)) throw new Error();
      promptId(row.operation_key); promptText(row.name, L.nameBytes, false);
      const template = promptTemplate(row.template);
      const names = strictEvidenceJson(row.variable_names, readerLimits({ maxDepth: 2 }));
      if (digest(row.template) !== row.template_sha256 || JSON.stringify(names) !== JSON.stringify(template.variableNames)) throw new Error();
      return { id, revision, name: row.name, template: row.template, templateSha256: row.template_sha256,
        variableNames: template.variableNames, policy: PROMPT_POLICY, createdAt: row.created_at };
    } catch { throw new PromptRegistryError("integrity"); }
  }
  #metadata(id: string, revision: number): PromptHistoryEntry {
    const row = this.#get<{ name: string | null; template_sha256: string | null; created_at: number | null; bounded: number }>(
      `SELECT ${textColumn("name", L.nameBytes)},${textColumn("template_sha256", 64)},${integerColumn("created_at", 0)},
      CASE WHEN typeof(template)='text' AND ${blobLength("template")}<=${L.templateBytes}
        AND typeof(variable_names)='text' AND ${blobLength("variable_names")}<=${L.schemaBytes} AND json_valid(variable_names)
        AND policy='literal-v1' THEN 1 ELSE 0 END AS bounded
      FROM prompt_revisions WHERE scope_key=? AND id=? AND revision=?`, this.#scopeKey, id, revision);
    try {
      if (!row || row.bounded !== 1 || row.name === null || row.template_sha256 === null || row.created_at === null || !hash(row.template_sha256)) throw new Error();
      const name = promptText(row.name, L.nameBytes, false);
      return { revision, name, templateSha256: row.template_sha256, createdAt: row.created_at };
    } catch { throw new PromptRegistryError("integrity"); }
  }
  #requestDigest(kind: "create" | "append", draft: PromptDraft, id?: string, expectedRevision?: number): string {
    return digest(JSON.stringify({ kind, scope: this.#scopeKey, ...(id === undefined ? {} : { id, expectedRevision }),
      name: draft.name, template: draft.template, variableNames: draft.variableNames, policy: PROMPT_POLICY }));
  }
  #operation(operationKey: string): { id: string; revision: number; digest: string; kind: "create" | "append"; deleted: boolean } | null {
    const head = this.#get<Head>(`SELECT ${headColumns} FROM prompt_heads WHERE scope_key=? AND create_operation_key=?`, this.#scopeKey, operationKey);
    if (head) { const verified = this.#head(head.id, true); return { id: verified.id, revision: 1, digest: verified.create_request_digest, kind: "create", deleted: verified.deleted === 1 }; }
    const row = this.#get<{ id: string; revision: number; request_digest: string }>(`SELECT ${textColumn("id", 36)},${integerColumn("revision", 1, 32)},${textColumn("request_digest", 64)} FROM prompt_revisions WHERE scope_key=? AND operation_key=?`, this.#scopeKey, operationKey);
    if (!row) return null;
    try { promptId(row.id); promptInteger(row.revision, 32); if (!hash(row.request_digest)) throw new Error(); } catch { throw new PromptRegistryError("integrity"); }
    const verified = this.#head(row.id, true);
    return { id: row.id, revision: row.revision, digest: row.request_digest, kind: "append", deleted: verified.deleted === 1 };
  }
  #retry(kind: "create" | "append", input: PromptDraft, requestDigest: string): PromptRevision | null {
    const existing = this.#operation(input.operationKey);
    if (!existing) return null;
    if (existing.kind !== kind || existing.digest !== requestDigest) throw new PromptRegistryError("operation_conflict");
    if (existing.deleted) throw new PromptRegistryError("deleted");
    return this.#revision(existing.id, existing.revision);
  }
  #insert(draft: PromptDraft, id: string, revision: number, requestDigest: string, createdAt: number): PromptRevision {
    const schema = JSON.stringify(draft.variableNames), templateHash = digest(draft.template);
    this.#database.query("INSERT INTO prompt_revisions(scope_key,id,revision,name,template,template_sha256,variable_names,policy,operation_key,request_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(this.#scopeKey, id, revision, draft.name, draft.template, templateHash, schema, PROMPT_POLICY, draft.operationKey, requestDigest, createdAt);
    return { id, revision, name: draft.name, template: draft.template, templateSha256: templateHash, variableNames: draft.variableNames, policy: PROMPT_POLICY, createdAt };
  }
  #incomingBytes(draft: PromptDraft, extraHead: boolean): number {
    const revision = Buffer.byteLength(this.#scopeKey) + 36 + Buffer.byteLength(draft.name) + Buffer.byteLength(draft.template) + 64
      + Buffer.byteLength(JSON.stringify(draft.variableNames)) + Buffer.byteLength(PROMPT_POLICY) + 36 + 64;
    return revision + (extraHead ? Buffer.byteLength(this.#scopeKey) + 36 + 36 + 64 : 0);
  }
  create(value: unknown, fence: number): PromptRevision {
    promptInteger(fence); const input = parsePromptDraft(value);
    return this.#transaction("edit", fence, () => {
      const totals = this.#totals(), requestDigest = this.#requestDigest("create", input), replay = this.#retry("create", input, requestDigest);
      if (replay) return replay;
      if (totals.scopeHeads >= L.promptsPerScope || totals.heads >= L.promptsGlobal || totals.revisions >= L.revisionsGlobal || totals.bytes + this.#incomingBytes(input, true) > L.retainedBytes) throw new PromptRegistryError("capacity");
      const id = randomUUID(), now = Date.now();
      this.#database.query("INSERT INTO prompt_heads(scope_key,id,revision,deleted,create_operation_key,create_request_digest,created_at,updated_at) VALUES(?,?,1,0,?,?,?,?)")
        .run(this.#scopeKey, id, input.operationKey, requestDigest, now, now);
      return this.#insert(input, id, 1, requestDigest, now);
    });
  }
  append(idValue: unknown, value: unknown, fence: number): PromptRevision {
    promptInteger(fence); const id = promptId(idValue), input = parsePromptDraft(value, true), expected = input.expectedRevision!;
    return this.#transaction("edit", fence, () => {
      const totals = this.#totals(), requestDigest = this.#requestDigest("append", input, id, expected), replay = this.#retry("append", input, requestDigest);
      if (replay) return replay;
      const head = this.#head(id);
      if (head.revision !== expected) throw new PromptRegistryError("revision_conflict");
      if (head.revision >= L.revisionsPerPrompt || totals.revisions >= L.revisionsGlobal || totals.bytes + this.#incomingBytes(input, false) > L.retainedBytes) throw new PromptRegistryError("capacity");
      const now = Math.max(Date.now(), head.updated_at);
      this.#database.query("UPDATE prompt_heads SET revision=revision+1,updated_at=? WHERE scope_key=? AND id=? AND revision=? AND deleted=0").run(now, this.#scopeKey, id, expected);
      return this.#insert(input, id, expected + 1, requestDigest, now);
    });
  }
  get(idValue: unknown, revisionValue: unknown, fence?: number): PromptRevision {
    const id = promptId(idValue), revision = promptInteger(revisionValue, L.revisionsPerPrompt);
    return this.#transaction("read", fence, () => { this.#totals(); this.#head(id); return this.#revision(id, revision); });
  }
  compile(idValue: unknown, revisionValue: unknown, variables: unknown, fence: number): PromptCompilation {
    promptInteger(fence); const id = promptId(idValue), revision = promptInteger(revisionValue, L.revisionsPerPrompt);
    return this.#transaction("read", fence, () => {
      this.#totals(); this.#head(id); const prompt = this.#revision(id, revision);
      return { id, revision, templateSha256: prompt.templateSha256, compiled: literalPromptCompilation(prompt.template, variables) };
    });
  }
  export(idValue: unknown, revisionValue: unknown, fence?: number): PromptExport {
    return boundedPromptResult({ format: "runphantom-prompt/v1", prompt: this.get(idValue, revisionValue, fence) });
  }
  history(idValue: unknown, fence?: number): { items: PromptHistoryEntry[] } {
    const id = promptId(idValue);
    return this.#transaction("read", fence, () => {
      this.#totals(); const head = this.#head(id), items: PromptHistoryEntry[] = [];
      for (let revision = head.revision; revision > 0; revision--) {
        items.push(this.#metadata(id, revision));
      }
      return { items };
    });
  }
  list(cursor?: unknown, fence?: number): PromptPage {
    let anchor: [number, string] | null = null;
    if (cursor !== undefined) {
      if (typeof cursor !== "string" || cursor.length > 128) throw new PromptRegistryError("invalid_request");
      const pieces = cursor.split(":");
      if (pieces.length !== 2 || !/^(0|[1-9][0-9]*)$/.test(pieces[0])) throw new PromptRegistryError("invalid_request");
      const timestamp = Number(pieces[0]); if (!Number.isSafeInteger(timestamp)) throw new PromptRegistryError("invalid_request");
      anchor = [timestamp, promptId(pieces[1])];
    }
    return this.#transaction("read", fence, () => {
      this.#totals();
      const rows = this.#database.query(`SELECT ${headColumns} FROM prompt_heads WHERE scope_key=? AND deleted=0${anchor ? " AND (updated_at<? OR (updated_at=? AND id<?))" : ""} ORDER BY updated_at DESC,id DESC LIMIT 51`)
        .all(this.#scopeKey, ...(anchor ? [anchor[0], anchor[0], anchor[1]] : [])) as Head[];
      const items: PromptSummary[] = rows.slice(0, L.listPage).map(row => {
        const head = this.#head(row.id), prompt = this.#metadata(head.id, head.revision);
        return { id: head.id, revision: prompt.revision, name: prompt.name, templateSha256: prompt.templateSha256, createdAt: head.created_at, updatedAt: head.updated_at };
      });
      const last = items.at(-1), hasMore = rows.length > L.listPage;
      return { items, hasMore, cursor: hasMore && last ? `${last.updatedAt}:${last.id}` : null };
    });
  }
  delete(idValue: unknown, expectedValue: unknown, fence: number): { removed: true } {
    promptInteger(fence); const id = promptId(idValue), expected = promptInteger(expectedValue, L.revisionsPerPrompt);
    return this.#transaction("delete", fence, () => {
      const head = this.#head(id);
      if (head.revision !== expected) throw new PromptRegistryError("revision_conflict");
      this.#database.query("DELETE FROM prompt_revisions WHERE scope_key=? AND id=?").run(this.#scopeKey, id);
      this.#database.query("UPDATE prompt_heads SET deleted=1 WHERE scope_key=? AND id=? AND revision=?").run(this.#scopeKey, id, expected);
      return { removed: true };
    });
  }
  clear(value: unknown, fence: number): { removed: true; generation: number } {
    const input = promptObject(value, ["expectedGeneration", "operationKey"]), expected = promptInteger(input.expectedGeneration);
    promptId(input.operationKey); promptInteger(fence);
    return this.#database.transaction(() => {
      const generation = this.#generation("delete");
      if (generation !== expected || generation !== fence) throw new PromptRegistryError("authority_changed");
      if (generation === Number.MAX_SAFE_INTEGER) throw new PromptRegistryError("capacity");
      this.#database.query("UPDATE evaluation_evidence_scopes SET generation=generation+1 WHERE scope_key=? AND generation=? AND active=1").run(this.#scopeKey, generation);
      this.#database.query("DELETE FROM prompt_revisions WHERE scope_key=?").run(this.#scopeKey);
      this.#database.query("DELETE FROM prompt_heads WHERE scope_key=?").run(this.#scopeKey);
      if (this.#generation("delete") !== generation + 1) throw new PromptRegistryError("authority_changed");
      return { removed: true as const, generation: generation + 1 };
    }).immediate();
  }
}

export function createLocalPromptRegistry(database: Database): PromptRegistry {
  return new PromptRegistry({ database, scope: { kind: "local", id: "local" }, authorize: () => {} });
}
