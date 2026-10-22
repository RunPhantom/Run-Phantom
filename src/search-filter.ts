import { parseJsonEvidence } from "./evaluations/json-evidence";
import { REPORTED_COST_ALIASES } from "./evaluations/snapshot";
import { hasDuplicateJsonKeys } from "./json-keys";
import { unsupportedTagCarrierSql } from "./captured-tags";
import { SEARCH_FILTER_LIMITS, SEARCH_FILTER_FIELDS, type SearchFilterField, type SearchFilterOperator, type SearchFilterClause, type SearchFilter } from "./search-protocol";
export { SEARCH_FILTER_LIMITS, SEARCH_FILTER_FIELDS } from "./search-protocol";
export type { SearchFilterField, SearchFilterOperator, SearchFilterClause, SearchFilter } from "./search-protocol";

export class SearchFilterError extends Error {
  constructor(message: string) { super(message); this.name = "SearchFilterError"; }
}
const invalid = (): never => { throw new SearchFilterError("Typed filters contain an invalid field, operator or value"); };
const numeric = (field: SearchFilterField) => field === "duration_ms" || field === "captured_cost_usd";

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length) return invalid();
  const out: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const item = descriptors[key];
    if (!item || !("value" in item)) return invalid();
    out[key] = item.value;
  }
  return out;
}

/** The only accepted expression is a bounded conjunction of closed predicates. */
export function parseSearchFilter(value: unknown): SearchFilter {
  if (value === undefined || value === "") return { version: 1, all: [] };
  let decoded: unknown = value;
  if (typeof value === "string") {
    if (value.length > SEARCH_FILTER_LIMITS.bytes || Buffer.byteLength(value) > SEARCH_FILTER_LIMITS.bytes) return invalid();
    try {
      decoded = parseJsonEvidence(value);
      if (hasDuplicateJsonKeys(value)) return invalid();
    } catch { return invalid(); }
  }
  const input = record(decoded, ["version", "all"]);
  if (input.version !== 1 || !Array.isArray(input.all) || input.all.length > SEARCH_FILTER_LIMITS.clauses) return invalid();
  const clauses: SearchFilterClause[] = [];
  for (let index = 0; index < input.all.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input.all, String(index));
    if (!descriptor || !("value" in descriptor)) return invalid();
    const clause = record(descriptor.value, ["field", "op", "value"]);
    if (!SEARCH_FILTER_FIELDS.includes(clause.field as SearchFilterField)) return invalid();
    const field = clause.field as SearchFilterField;
    const allowed = numeric(field) ? ["eq", "ne", "lt", "lte", "gt", "gte"] : ["eq", "ne"];
    if (!allowed.includes(clause.op as string)) return invalid();
    if (numeric(field)) {
      if (typeof clause.value !== "number" || !Number.isFinite(clause.value) || clause.value < 0 || clause.value > Number.MAX_SAFE_INTEGER) return invalid();
    } else {
      if (typeof clause.value !== "string" || !clause.value || clause.value.length > SEARCH_FILTER_LIMITS.valueChars || Buffer.byteLength(clause.value) > SEARCH_FILTER_LIMITS.valueBytes || Array.from(clause.value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return invalid();
      if (field === "status" && !["running", "completed", "failed"].includes(clause.value)) return invalid();
    }
    clauses.push({ field, op: clause.op as SearchFilterOperator, value: clause.value as string | number });
  }
  clauses.sort((a, b) => SEARCH_FILTER_FIELDS.indexOf(a.field) - SEARCH_FILTER_FIELDS.indexOf(b.field)
    || (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0));
  const unique = clauses.filter((item, index) => index === 0 || JSON.stringify(item) !== JSON.stringify(clauses[index - 1]));
  const result: SearchFilter = { version: 1, all: unique };
  if (Buffer.byteLength(JSON.stringify(result)) > SEARCH_FILTER_LIMITS.bytes) return invalid();
  return result;
}

const operators: Record<SearchFilterOperator, string> = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" };

function capturedAttributesSql(scope: "local" | "team"): string {
  const attrs = scope === "local" ? "s.attributes" : "json_extract(s.data,'$.attributes')";
  return `(CASE WHEN length(CAST(${attrs} AS BLOB))<=${SEARCH_FILTER_LIMITS.attributeBytes} AND json_valid(${attrs}) THEN CASE WHEN json_type(${attrs})='object' AND NOT EXISTS (SELECT 1 FROM json_each(${attrs}) member GROUP BY member.key HAVING COUNT(*)>1) THEN ${attrs} END END)`;
}
export function capturedTagsSql(scope: "local" | "team"): string {
  const attrs = capturedAttributesSql(scope), candidate = `json_extract(${attrs},'$.tags')`;
  // SQLite length counts code points; typed values are bounded in UTF16 units.
  const characters = `(WITH RECURSIVE chars(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM chars WHERE i<length(member.value)) SELECT SUM(CASE WHEN unicode(substr(member.value,i,1))>65535 THEN 2 ELSE 1 END) FROM chars)`;
  const control = `(WITH RECURSIVE chars(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM chars WHERE i<length(member.value)) SELECT 1 FROM chars WHERE unicode(substr(member.value,i,1))<32 OR unicode(substr(member.value,i,1))=127)`;
  return `(CASE WHEN json_type(${attrs},'$.tags')='array' THEN CASE WHEN json_array_length(${candidate})<=${SEARCH_FILTER_LIMITS.tags} AND NOT EXISTS (SELECT 1 FROM json_each(${candidate}) member GROUP BY member.value HAVING COUNT(*)>1) AND NOT EXISTS (SELECT 1 FROM json_each(${candidate}) member WHERE CASE WHEN member.type<>'text' OR member.value='' OR length(member.value)>${SEARCH_FILTER_LIMITS.valueChars} OR length(CAST(member.value AS BLOB))>${SEARCH_FILTER_LIMITS.valueBytes} OR instr(member.value,char(0))>0 THEN 1 ELSE ${characters}>${SEARCH_FILTER_LIMITS.valueChars} OR EXISTS ${control} OR ${unsupportedTagCarrierSql("member.value")} END) THEN ${candidate} END END)`;
}

/** Caller-owned aliases are fixed. User values can enter only bound parameters. */
export function compileSearchFilter(filter: SearchFilter, scope: "local" | "team", onSelectedSpan = false): { sql: string; params: (string | number)[] } {
  const checked = parseSearchFilter(filter);
  const runClauses: string[] = [], spanClauses: string[] = [];
  const runParams: (string | number)[] = [], spanParams: (string | number)[] = [];
  // Legacy attributes can contain duplicate keys. Such a record cannot prove
  // an exact captured value or tag absence; bound validation before JSON work.
  const checkedAttrs = capturedAttributesSql(scope);
  const duration = scope === "local" ? "s.duration_ms" : "json_extract(s.data,'$.durationMs')";
  // First present reported-cost alias retains acquisition authority, including
  // an explicit invalid/null value. No nominal rate or unknown-to-zero fallback.
  const costCases = REPORTED_COST_ALIASES.map(key => {
    const jsonPath = `'$."${key}"'`;
    return `WHEN json_type(${checkedAttrs},${jsonPath}) IS NOT NULL THEN json_extract(${checkedAttrs},${jsonPath})`;
  });
  const cost = `(CASE ${costCases.join(" ")} END)`;
  const failed = "EXISTS (SELECT 1 FROM spans fs WHERE fs.run_id=r.id AND fs.status='ERROR')";
  const finished = "(EXISTS (SELECT 1 FROM spans rs WHERE rs.run_id=r.id AND rs.parent_span_id IS NULL) AND NOT EXISTS (SELECT 1 FROM spans rs WHERE rs.run_id=r.id AND rs.parent_span_id IS NULL AND (rs.status IS NULL OR rs.status NOT IN ('OK','ERROR'))))";
  const status = scope === "team" ? "r.status" : `(CASE WHEN ${failed} THEN 'failed' WHEN ${finished} THEN 'completed' ELSE 'running' END)`;
  for (const clause of checked.all) {
    const op = operators[clause.op];
    if (clause.field === "status") { runClauses.push(`${status} ${op} ?`); runParams.push(clause.value); }
    else if (clause.field === "model" || clause.field === "provider") {
      spanClauses.push(`s.${clause.field} IS NOT NULL AND s.${clause.field} ${op} ?`); spanParams.push(clause.value);
    } else if (clause.field === "tag") {
      const tags = capturedTagsSql(scope);
      const contains = `EXISTS (SELECT 1 FROM json_each(${tags}) tag WHERE tag.type='text' AND tag.value=?)`;
      spanClauses.push(`${tags} IS NOT NULL AND ${clause.op === "ne" ? "NOT " : ""}${contains}`);
      spanParams.push(clause.value);
    } else {
      const expression = clause.field === "duration_ms" ? duration : cost;
      spanClauses.push(`typeof(${expression}) IN ('integer','real') AND ${expression}>=0 AND ${expression}<=9007199254740991 AND ${expression} ${op} ?`);
      spanParams.push(clause.value);
    }
  }
  if (spanClauses.length) runClauses.push(onSelectedSpan ? spanClauses.map(item => `(${item})`).join(" AND ") : `EXISTS (SELECT 1 FROM spans s WHERE s.run_id=r.id${scope === "team" ? " AND s.project_id=r.project_id" : ""} AND (${spanClauses.join(") AND (")}))`);
  return { sql: runClauses.length ? runClauses.map(item => `(${item})`).join(" AND ") : "1=1", params: [...runParams, ...spanParams] };
}
