import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { capturedTagsSql, compileSearchFilter, parseSearchFilter } from "../src/search-filter";
import { parseOtlpRequest } from "../src/parse";

const array = (tags: string[]) => ({ arrayValue: { values: tags.map(stringValue => ({ stringValue })) } });
function parsed(attributes: unknown[], droppedAttributesCount?: unknown) {
  return parseOtlpRequest({ resourceSpans: [{ scopeSpans: [{ spans: [{
    traceId: "1".repeat(32), spanId: "2".repeat(16), name: "Population admission",
    startTimeUnixNano: "1800000000000000000", endTimeUnixNano: "1800000000000000000",
    attributes: [...attributes, { key: "business", value: { stringValue: "exact payload" } }], droppedAttributesCount,
  }] }] }] })[0];
}
const families = [
  ["sk_live_", "A", 10], ["sk_test_", "A", 10], ["rk_live_", "A", 10], ["rk_test_", "A", 10], ["sk-ant-", "A", 20], ["sk-proj-", "A", 20],
  ["sk-svcacct-", "A", 20], ["sk-admin-", "A", 20], ["AKIA", "A", 16], ["ASIA", "A", 16],
  ...["ghp_", "gho_", "ghu_", "ghs_", "ghr_"].map(prefix => [prefix, "A", 20] as const),
  ["github_pat_", "A", 22], ["AIza", "A", 35],
  ...["xoxb-", "xoxa-", "xoxp-", "xoxr-", "xoxs-"].map(prefix => [prefix, "A", 10] as const),
  ["ya29.", "A", 20], ...["session", "setup", "invite", "ingest"].map(kind => [`rp_team_${kind}_`, "A", 16] as const),
] as const;
const safe = ["東京%_🌈", "quoted'value", "' OR 1=1 --", "a\\b", "Bearer cat", "monkeyJump", "sk-proj-category", "x".repeat(256), "🌈".repeat(128), "界".repeat(170) + "aa"];
const unavailable = [
  ...families.map(([prefix, character, length]) => `before ${prefix}${character.repeat(length)} after`),
  "before [REDACTED] after", "[unavailable]", "[TRUNCATED]", "[UNSERIALIZABLE]",
  "eyJAAAA.AAAA.AAAA", "Bearer abcdefgh", "Basic\u00a0abcdefgh", "Bearer\u3000  abcdefgh", "RP_TEAM_INGEST_" + "A".repeat(16), "Password = category", '"api_key" : "category"',
  "https://safe.example.test/category", "prefix HTTP://safe.example.test/category", "wss://safe.example.test/category",
  '{"safe":"category"}', "\u3000[\"safe\"]", '"safe category"',
];

test("native local and Team SQL admit only complete categorical populations before projection", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE spans(attributes TEXT,data TEXT)");
    const sql = ["local", "team"].map(scope => db.query(`SELECT ${capturedTagsSql(scope as "local" | "team")} tags FROM spans s`));
    for (const [tags, admitted] of [
      ...safe.map(tag => [[tag], true] as const), ...families.map(([prefix, character, length]) => [[prefix + character.repeat(length - 1)], true] as const),
      [[], true], [["safe", "other"], true], [Array.from({ length: 64 }, (_, i) => `category-${i}`), true],
      [Array.from({ length: 65 }, (_, i) => `category-${i}`), false], ...unavailable.map(tag => [["safe", tag], false] as const), [["safe", "safe"], false],
      [["safe", "x".repeat(257)], false], [["safe", "🌈".repeat(129)], false], [["safe", "界".repeat(171)], false], [["safe", "x\u0000y"], false],
    ] as const) {
      db.exec("DELETE FROM spans");
      const attributes = JSON.stringify({ tags });
      db.query("INSERT INTO spans VALUES(?,?)").run(attributes, JSON.stringify({ attributes: { tags } }));
      for (const statement of sql) expect((statement.get() as { tags: string | null }).tags).toBe(admitted ? JSON.stringify(tags) : null);
      const span = parsed([{ key: "tags", value: array([...tags]) }]);
      expect(span.attributes.tags).toEqual(admitted ? [...tags] : "[UNAVAILABLE]");
      expect(span.attributes.business).toBe("exact payload");
    }
  } finally { db.close(); }
});

test("original duplicate or dropped span populations never acquire last-occurrence authority", () => {
  const tag = { key: "tags", value: array(["safe"]) };
  for (const attributes of [
    [tag, tag], [{ key: "tags", value: array(["sk-proj-" + "A".repeat(20)]) }, tag],
    [tag, { key: "tags", value: { stringValue: "legacy scalar" } }],
    [{ key: "tags", value: { arrayValue: { values: [{ intValue: "1" }] } } }, tag],
  ]) expect(parsed(attributes).attributes.tags).toBe("[UNAVAILABLE]");
  for (const count of [1, -1, "0", NaN, null, Number.MAX_SAFE_INTEGER + 1]) expect(parsed([tag], count).attributes.tags).toBe("[UNAVAILABLE]");
  for (const count of [undefined, 0]) expect(parsed([tag], count).attributes.tags).toEqual(["safe"]);
  expect(parsed([{ key: "tags", value: { stringValue: '["safe"]' } }]).attributes.tags).toBe('["safe"]');
});

test("an explicitly malformed array does not certify an empty population", () => {
  for (const arrayValue of [{ values: null }, { values: "not-an-array" }, { values: [], omitted: true }, []]) {
    expect(parsed([{ key: "tags", value: { arrayValue } }]).attributes.tags).toBe("[UNAVAILABLE]");
  }
  expect(parsed([{ key: "tags", value: { arrayValue: {} } }]).attributes.tags).toEqual([]);
});

test("maximum closed tag conjunction stays composable in native SQLite", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE runs(id TEXT); CREATE TABLE spans(run_id TEXT,attributes TEXT)");
    db.query("INSERT INTO runs VALUES('safe')").run();
    db.query("INSERT INTO spans VALUES('safe',?)").run(JSON.stringify({ tags: Array.from({ length: 64 }, (_, i) => `category-${i}`) }));
    const compiled = compileSearchFilter(parseSearchFilter({ version: 1, all: Array.from({ length: 12 }, (_, i) => ({ field: "tag", op: "ne", value: `absent-${i}` })) }), "local");
    expect(db.query(`SELECT r.id FROM runs r WHERE ${compiled.sql}`).all(...compiled.params)).toEqual([{ id: "safe" }]);
  } finally { db.close(); }
});
