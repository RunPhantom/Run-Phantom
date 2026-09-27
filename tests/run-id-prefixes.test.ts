import { describe, expect, test } from "bun:test";
import { uniqueRunIdPrefixes } from "../app/src/utils/helpers";

describe("unique run id prefixes", () => {
  // Every demo id starts "demo_", so a fixed five-character slice gave all
  // three sidebar rows the same "(demo_)" suffix.
  test("demo ids grow past their shared prefix", () => {
    const prefixes = uniqueRunIdPrefixes(["demo_triage", "demo_review", "demo_research"]);
    expect(prefixes.get("demo_triage")).toBe("demo_t…");
    expect(prefixes.get("demo_review")).toBe("demo_rev…");
    expect(prefixes.get("demo_research")).toBe("demo_res…");
  });

  test("hex trace ids keep five characters when those already differ", () => {
    const prefixes = uniqueRunIdPrefixes([
      "0a1b2c3d4e5f60718293a4b5c6d7e8f9",
      "f9e8d7c6b5a4938271605f4e3d2c1b0a",
      "7c3e1a90b2d44f6e8a1b2c3d4e5f6071",
    ]);
    expect(prefixes.get("0a1b2c3d4e5f60718293a4b5c6d7e8f9")).toBe("0a1b2…");
    expect(prefixes.get("f9e8d7c6b5a4938271605f4e3d2c1b0a")).toBe("f9e8d…");
    expect(prefixes.get("7c3e1a90b2d44f6e8a1b2c3d4e5f6071")).toBe("7c3e1…");
  });

  test("a single run shows the minimum length", () => {
    expect(uniqueRunIdPrefixes(["0a1b2c3d4e5f"]).get("0a1b2c3d4e5f")).toBe("0a1b2…");
  });

  test("ids no longer than the minimum are shown whole, without an ellipsis", () => {
    const prefixes = uniqueRunIdPrefixes(["abc", "abcde"]);
    expect(prefixes.get("abc")).toBe("abc");
    expect(prefixes.get("abcde")).toBe("abcde");
  });

  test("identical prefixes extend until the ids differ", () => {
    const prefixes = uniqueRunIdPrefixes(["0a1b2c3d4e-aaaa", "0a1b2c3d4e-aaab", "0a1b2c3d4e-b"]);
    expect(prefixes.get("0a1b2c3d4e-aaaa")).toBe("0a1b2c3d4e-aaaa");
    expect(prefixes.get("0a1b2c3d4e-aaab")).toBe("0a1b2c3d4e-aaab");
    expect(prefixes.get("0a1b2c3d4e-b")).toBe("0a1b2c3d4e-b");
  });

  test("an id that is a prefix of another is shown whole and the longer one gets one more character", () => {
    const prefixes = uniqueRunIdPrefixes(["run_12345", "run_123456789"]);
    expect(prefixes.get("run_12345")).toBe("run_12345");
    expect(prefixes.get("run_123456789")).toBe("run_123456…");
  });

  test("duplicate ids and input order do not change the result", () => {
    const forward = uniqueRunIdPrefixes(["demo_review", "demo_research", "demo_review"]);
    const reverse = uniqueRunIdPrefixes(["demo_research", "demo_review"]);
    expect([...forward.entries()].sort()).toEqual([...reverse.entries()].sort());
  });
});
