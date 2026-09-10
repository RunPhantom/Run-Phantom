import { describe, expect, test } from "bun:test";
import { redosRisk } from "../src/db";

describe("search pattern ReDoS guard", () => {
  test("rejects star height 2, which is what backtracks exponentially", () => {
    for (const p of ["(a+)+$", "(a*)*b", "([a-z]+)*x", "(\\d{2,})+", "((a+)+)+"]) {
      expect(redosRisk(p)).toBeTruthy();
    }
  });

  test("accepts the patterns people actually search with", () => {
    for (const p of ["error", "tool_.*", "(foo|bar)+", "\\bGET /api/[a-z]+\\b", "[(]+", "\\(a+\\)+"]) {
      expect(redosRisk(p)).toBeNull();
    }
  });

  test("rejects an over-long pattern", () => {
    expect(redosRisk("a".repeat(1001))).toContain("1000");
  });
});
