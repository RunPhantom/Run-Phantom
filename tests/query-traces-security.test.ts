import { describe, expect, test } from "bun:test";
import { _queryTracesInternal } from "../src/db";

const validate = (sql: string) => _queryTracesInternal.assertReadOnlyTraceQuery(sql);

describe("query_traces table boundary", () => {
  test("allows only trace-safe tables and views", () => {
    expect(validate("SELECT id FROM runs")).toBe("SELECT id FROM runs");
    expect(validate("SELECT s.id FROM spans s JOIN annotations a ON a.span_id = s.id")).toContain("JOIN annotations");
    expect(validate("SELECT * FROM runs_with_hints")).toContain("runs_with_hints");
    expect(validate("SELECT * FROM (SELECT * FROM live_events) events")).toContain("live_events");
  });

  test("rejects chat, saved, internal, unknown, and schema-qualified tables", () => {
    for (const sql of [
      "SELECT * FROM messages",
      "SELECT * FROM saved_events",
      "SELECT * FROM saved_run_cache",
      "SELECT * FROM sqlite_master",
      "SELECT * FROM secrets",
      "SELECT * FROM main.runs",
      "SELECT * FROM runs, messages",
    ]) {
      expect(() => validate(sql)).toThrow(/trace-safe tables/i);
    }
  });
});
