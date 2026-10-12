import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { compileSearchFilter, parseSearchFilter, SEARCH_FILTER_LIMITS } from "../src/search-filter";

const ast = (field: string, op: string, value: unknown) => ({ version: 1, all: [{ field, op, value }] });

describe("closed typed investigation filters", () => {
  test("preserves finite zero and literal punctuation without SQL interpolation", () => {
    for (const value of ["' OR 1=1 --", "%_", "東京🌈", "a\\b"]) {
      const filter = parseSearchFilter(ast("model", "eq", value));
      const compiled = compileSearchFilter(filter, "local");
      expect(compiled.params).toEqual([value]);
      expect(compiled.sql).not.toContain(value);
    }
    expect(parseSearchFilter(ast("duration_ms", "eq", 0)).all[0].value).toBe(0);
    expect(parseSearchFilter(ast("captured_cost_usd", "gte", 0)).all[0].value).toBe(0);
  });

  test("refuses unknown fields/operators, coercion, malformed or unbounded values", () => {
    const malformed = [null, [], { version: 2, all: [] }, { version: 1, all: [], sql: "SELECT 1" },
      ast("s.model", "eq", "x"), ast("model", "regex", "x"), ast("status", "gt", "failed"),
      ast("duration_ms", "gte", "2"), ast("duration_ms", "gt", -1), ast("captured_cost_usd", "eq", Infinity),
      ast("model", "eq", ""), ast("provider", "eq", "\0"), ast("tag", "eq", []),
      ast("model", "eq", "x".repeat(257)), ast("model", "eq", "界".repeat(256)),
      { version: 1, all: Array(SEARCH_FILTER_LIMITS.clauses + 1).fill({ field: "model", op: "eq", value: "x" }) },
      { version: 1, all: [{ field: "model", op: "eq", value: "x", column: "id" }] }];
    for (const input of malformed) expect(() => parseSearchFilter(input)).toThrow();
    for (const input of ['{"version":1,"version":1,"all":[]}', '{"version":1,"all":[],"__proto__":{}}', "x".repeat(8193)]) {
      expect(() => parseSearchFilter(input)).toThrow();
    }
  });

  test("conjoins all span conditions within one scoped captured occurrence", () => {
    const input = parseSearchFilter({ version: 1, all: [
      { field: "model", op: "eq", value: "m" }, { field: "provider", op: "eq", value: "p" },
      { field: "duration_ms", op: "gt", value: 2000 }, { field: "status", op: "eq", value: "failed" },
    ] });
    const compiled = compileSearchFilter(input, "team");
    expect(compiled.params).toEqual(["failed", "m", "p", 2000]);
    expect(compiled.sql.match(/EXISTS\s*\(/g)).toHaveLength(1);
    expect(compiled.sql).toContain("s.project_id=r.project_id");
    expect(compiled.sql).toContain("s.run_id=r.id");
  });

  test("canonical conjunction removes order-sensitive recent-query duplication", () => {
    const first = { field: "model", op: "eq", value: "m" };
    const second = { field: "provider", op: "eq", value: "p" };
    expect(parseSearchFilter({ version: 1, all: [first, second, first] }))
      .toEqual(parseSearchFilter(JSON.stringify({ version: 1, all: [second, first] })));
    expect(parseSearchFilter(undefined)).toEqual({ version: 1, all: [] });
  });

  test("actual SQLite excludes unknown numerics and tags instead of inventing zero or absence", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE runs(id TEXT PRIMARY KEY); CREATE TABLE spans(run_id TEXT,id TEXT,parent_span_id TEXT,status TEXT,model TEXT,provider TEXT,duration_ms REAL,attributes TEXT)");
      for (const [id, duration, attrs] of [
        ["zero", 0, '{"gen_ai.usage.cost_usd":0,"tags":["safe%_tag"]}'],
        ["known", 2001, '{"gen_ai.usage.cost_usd":0.25,"tags":[]}'],
        ["missing", null, null], ["invalid", -1, "not-json"],
        ["string", null, '{"gen_ai.usage.cost_usd":"0","tags":"safe%_tag"}'],
        ["first-invalid", 10, '{"gen_ai.usage.cost_usd":null,"gen_ai.usage.cost":0}'],
      ] as const) {
        db.query("INSERT INTO runs VALUES(?)").run(id);
        db.query("INSERT INTO spans VALUES(?,?,NULL,'OK','m','p',?,?)").run(id, "root", duration, attrs);
      }
      const ids = (field: string, op: string, value: unknown) => {
        const compiled = compileSearchFilter(parseSearchFilter(ast(field, op, value)), "local");
        return db.query(`SELECT r.id FROM runs r WHERE ${compiled.sql} ORDER BY r.id`).all(...compiled.params).map(row => (row as { id: string }).id);
      };
      expect(ids("duration_ms", "eq", 0)).toEqual(["zero"]);
      expect(ids("duration_ms", "gt", 2000)).toEqual(["known"]);
      expect(ids("captured_cost_usd", "eq", 0)).toEqual(["zero"]);
      expect(ids("captured_cost_usd", "ne", 0)).toEqual(["known"]);
      expect(ids("tag", "eq", "safe%_tag")).toEqual(["zero"]);
      expect(ids("tag", "ne", "safe%_tag")).toEqual(["known"]);
    } finally { db.close(); }
  });

  test("ambiguous attributes and malformed tag members cannot establish matches or absence", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE runs(id TEXT PRIMARY KEY); CREATE TABLE spans(run_id TEXT,id TEXT,parent_span_id TEXT,status TEXT,model TEXT,provider TEXT,duration_ms REAL,attributes TEXT)");
      const fixtures = [
        ["mixed", '{"tags":[42]}'],
        ["empty-member", '{"tags":[""]}'],
        ["oversized-member", JSON.stringify({ tags: ["x".repeat(513)] })],
        ["duplicate-tags", '{"tags":[],"tags":["target"]}'],
        ["duplicate-cost", '{"gen_ai.usage.cost_usd":0,"gen_ai.usage.cost_usd":1}'],
      ];
      for (const [id, attributes] of fixtures) {
        db.query("INSERT INTO runs VALUES(?)").run(id);
        db.query("INSERT INTO spans VALUES(?,?,NULL,'OK','m','p',1,?)").run(id, "root", attributes);
      }
      for (const [field, op, value] of [["tag", "eq", "target"], ["tag", "ne", "target"], ["captured_cost_usd", "eq", 0], ["captured_cost_usd", "ne", 0]] as const) {
        const compiled = compileSearchFilter(parseSearchFilter(ast(field, op, value)), "local");
        expect(db.query(`SELECT r.id FROM runs r WHERE ${compiled.sql}`).all(...compiled.params)).toEqual([]);
      }
    } finally { db.close(); }
  });
});
