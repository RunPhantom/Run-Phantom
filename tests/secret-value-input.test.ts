import { describe, expect, test } from "bun:test";
import { parseSecretValueInput, SECRET_VALUE_MAX_LENGTH } from "../src/secret-store";

describe("secret value input", () => {
  test("treats a missing or blank value as an explicit clear", () => {
    expect(parseSecretValueInput({})).toEqual({ ok: true, value: "" });
    expect(parseSecretValueInput({ value: "   " })).toEqual({ ok: true, value: "" });
    expect(parseSecretValueInput(null)).toEqual({ ok: true, value: "" });
  });

  test("trims and accepts an ordinary key", () => {
    expect(parseSecretValueInput({ value: "  sk-proj-abc123  " })).toEqual({ ok: true, value: "sk-proj-abc123" });
  });

  test("refuses a non-text value instead of clearing the saved key", () => {
    for (const value of [12345, true, ["sk-x"], { key: "sk-x" }]) {
      expect(parseSecretValueInput({ value }).ok).toBe(false);
    }
  });

  test("refuses keys every provider client would treat as unconfigured", () => {
    expect(parseSecretValueInput({ value: "sk-FAKE\r\nX-Injected: 1" }).ok).toBe(false);
    expect(parseSecretValueInput({ value: "sk-a b" }).ok).toBe(false);
    expect(parseSecretValueInput({ value: "sk-a\u0000b" }).ok).toBe(false);
    expect(parseSecretValueInput({ value: `sk-${"a".repeat(SECRET_VALUE_MAX_LENGTH)}` }).ok).toBe(false);
    expect(parseSecretValueInput({ value: `sk-${"a".repeat(SECRET_VALUE_MAX_LENGTH - 3)}` }).ok).toBe(true);
  });
});
