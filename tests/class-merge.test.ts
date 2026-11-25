import { describe, expect, test } from "bun:test";
import { cn } from "../app/src/lib/utils";

describe("cn", () => {
  test("keeps a type-scale size next to a token colour", () => {
    expect(cn("font-mono text-11 text-rp-ink-subtle")).toBe("font-mono text-11 text-rp-ink-subtle");
  });

  test("a later size still replaces an earlier one", () => {
    expect(cn("text-[13px] text-rp-ink", "text-12")).toBe("text-rp-ink text-12");
  });
});
