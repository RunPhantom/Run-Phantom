import { describe, expect, test } from "bun:test";
import { _queryTracesInternal } from "../src/db";

const validate = (sql: string) => _queryTracesInternal.assertReadOnlyTraceQuery(sql);

describe("query_traces guards ignore quoted literals", () => {
  // The guards are regexes and used to run over raw SQL, so an ordinary search
  // for the word "delete" in a run name was rejected as a blocked keyword.
  test("a blocked keyword inside a string literal is allowed", () => {
    expect(() => validate("SELECT name FROM runs WHERE name LIKE '%delete%'")).not.toThrow();
    expect(() => validate("SELECT name FROM runs WHERE name = 'drop table'")).not.toThrow();
    expect(() => validate("SELECT id FROM spans WHERE name LIKE '%update%'")).not.toThrow();
  });

  test("a semicolon inside a string literal is not a second statement", () => {
    expect(() => validate("SELECT 'a;b' AS v FROM runs")).not.toThrow();
  });

  test("the word 'with' inside a literal is not a CTE", () => {
    expect(() => validate("SELECT id FROM runs WHERE name = 'with love'")).not.toThrow();
  });

  test("escaped quotes inside a literal do not end it early", () => {
    expect(() => validate("SELECT id FROM runs WHERE name = 'it''s; fine'")).not.toThrow();
  });

  test("real DDL and DML are still rejected", () => {
    for (const sql of [
      "DELETE FROM runs",
      "SELECT id FROM runs; DROP TABLE runs",
      "UPDATE runs SET name = 'x'",
      "WITH t AS (SELECT 1) SELECT * FROM t",
      "INSERT INTO runs VALUES (1)",
    ]) {
      expect(() => validate(sql)).toThrow();
    }
  });

  test("the table allow-list still applies", () => {
    expect(() => validate("SELECT * FROM sqlite_master")).toThrow();
  });
});
