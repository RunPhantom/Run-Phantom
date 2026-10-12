import { SEARCH_FILTER_LIMITS as L } from "./search-protocol";

// This is categorical admission, not a general credential sanitizer. Legacy
// URL/JSON/auth carriers remain unavailable even when their contents look safe.
const whitespace = " \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
const markers = ["[redacted]", "[unavailable]", "[truncated]", "[unserializable]", "[circular]", "__redacted__"];
const authKeys = ["authorization", "proxy-authorization", "x-api-key", "api_key", "api-key", "apikey", "password", "cookie", "set-cookie"];
const alpha = "A-Za-z0-9", extended = "A-Za-z0-9_-";
const families: Array<{ prefix: string; alphabet: string; minimum: number; fold?: boolean }> = [
  ...["sk_live_", "sk_test_", "rk_live_", "rk_test_"].map(prefix => ({ prefix, alphabet: alpha, minimum: 10 })),
  ...["sk-ant-", "sk-proj-", "sk-svcacct-", "sk-admin-"].map(prefix => ({ prefix, alphabet: extended, minimum: 20 })),
  ...["AKIA", "ASIA"].map(prefix => ({ prefix, alphabet: "0-9A-Z", minimum: 16 })),
  ...["ghp_", "gho_", "ghu_", "ghs_", "ghr_"].map(prefix => ({ prefix, alphabet: alpha, minimum: 20 })),
  { prefix: "github_pat_", alphabet: "A-Za-z0-9_", minimum: 22 },
  { prefix: "AIza", alphabet: extended, minimum: 35 },
  ...["xoxb-", "xoxa-", "xoxp-", "xoxr-", "xoxs-"].map(prefix => ({ prefix, alphabet: "A-Za-z0-9-", minimum: 10 })),
  { prefix: "ya29.", alphabet: "A-Za-z0-9._-", minimum: 20 },
  ...["session", "setup", "invite", "ingest"].map(kind => ({ prefix: `rp_team_${kind}_`, alphabet: extended, minimum: 16, fold: true })),
];
const asciiLower = (value: string) => value.replace(/[A-Z]/g, character => character.toLowerCase());
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const secrets = families.map(family => ({ ...family, pattern: new RegExp(`${escapeRegex(family.prefix)}[${family.alphabet}]{${family.minimum},}`) }));
const whitespacePattern = new RegExp(`[${whitespace}]`, "g");
const jwt = new RegExp(`eyJ[${extended}]{4,}.*\\.[${extended}]{4,}.*\\.[${extended}]{4,}`, "s");
const token = /^[A-Za-z0-9+/_=.-]{8}/;

export function isCapturedCategoricalTag(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > L.valueChars || Buffer.byteLength(value) > L.valueBytes
    || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return false;
  const lower = asciiLower(value);
  if (markers.some(marker => lower.includes(marker)) || secrets.some(family => family.pattern.test(family.fold ? lower : value))
    || jwt.test(value) || /(?:https?|wss?):\/\//.test(lower) || ['[', '{', '"'].includes(value.trimStart()[0])) return false;
  const compact = lower.replace(whitespacePattern, "").replace(/["']/g, "");
  if (authKeys.some(key => compact.includes(key + ":") || compact.includes(key + "="))) return false;
  const spaced = lower.replace(whitespacePattern, " ");
  for (const match of spaced.matchAll(/(?:bearer|basic) /g)) {
    if (token.test(spaced.slice(match.index! + match[0].length).replace(/^ +/, ""))) return false;
  }
  return true;
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
// Only fixed constants and a caller-owned column enter this expression.
export function unsupportedTagCarrierSql(value: string): string {
  const lower = `lower(${value})`;
  const predicates = markers.map(marker => `instr(${lower},${literal(marker)})>0`);
  for (const family of families) predicates.push(`${family.fold ? lower : value} GLOB ${literal("*" + family.prefix + `[${family.alphabet}]`.repeat(family.minimum) + "*")}`);
  predicates.push(`${value} GLOB ${literal("*eyJ" + `[${extended}]`.repeat(4) + "*." + `[${extended}]`.repeat(4) + "*." + `[${extended}]`.repeat(4) + "*")}`);
  for (const prefix of ["http://", "https://", "ws://", "wss://"]) predicates.push(`instr(${lower},${literal(prefix)})>0`);
  predicates.push(`substr(ltrim(${value},${literal(whitespace)}),1,1) IN ('[','{','"')`);
  // A bounded character scan avoids deeply nested replace() expressions that
  // overflow SQLite's parser when this admission is composed into a filter.
  const assignments = authKeys.flatMap(key => [":", "="].map(separator => `instr(text,${literal(key + separator)})>0`));
  predicates.push(`EXISTS (WITH RECURSIVE chars(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM chars WHERE i<length(${value})), compact(text) AS MATERIALIZED (SELECT group_concat(c,'') FROM (SELECT substr(${lower},i,1) c FROM chars WHERE instr(${literal(whitespace + '"\'')},substr(${value},i,1))=0 ORDER BY i)) SELECT 1 FROM compact WHERE ${assignments.join(" OR ")})`);
  const bearer = `ltrim(substr(${lower},i+7),${literal(whitespace)}) GLOB ${literal("[A-Za-z0-9+/_=.-]".repeat(8) + "*")}`;
  const basic = `ltrim(substr(${lower},i+6),${literal(whitespace)}) GLOB ${literal("[A-Za-z0-9+/_=.-]".repeat(8) + "*")}`;
  predicates.push(`EXISTS (WITH RECURSIVE positions(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM positions WHERE i<length(${value})) SELECT 1 FROM positions WHERE (substr(${lower},i,6)='bearer' AND instr(${literal(whitespace)},substr(${value},i+6,1))>0 AND ${bearer}) OR (substr(${lower},i,5)='basic' AND instr(${literal(whitespace)},substr(${value},i+5,1))>0 AND ${basic}))`);
  return `(${predicates.join(" OR ")})`;
}
