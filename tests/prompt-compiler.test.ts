import { describe, expect, test } from "bun:test";
import { compilePrompt, PromptCompileError } from "../src/prompts/compiler";

describe("literal immutable prompt compilation", () => {
  test("substitutes repeated variables without replacement-string interpretation", () => {
    expect(compilePrompt("Hello {{name}}. {{name}} / {{empty}}", { name: "$& $` $' $$", empty: "" }))
      .toBe("Hello $& $` $' $$. $& $` $' $$ / ");
  });
  test("preserves whitespace, Unicode, code and ordinary JSON closing braces", () => {
    const template = '  日本語\n{"a":{"b":1}}\nreturn { value: "{{answer}}" };\n';
    expect(compilePrompt(template, { answer: "🦊 café\nexact" })).toBe('  日本語\n{"a":{"b":1}}\nreturn { value: "🦊 café\nexact" };\n');
  });
  test("never recursively interprets substituted template syntax", () => {
    expect(compilePrompt("{{first}} / {{second}}", { first: "{{second}}", second: "literal" }))
      .toBe("{{second}} / literal");
  });
  test("does not mutate the template or frozen variable map", () => {
    const variables = Object.freeze({ name: "saved" });
    const template = "\n{{name}}\n";
    expect(compilePrompt(template, variables)).toBe("\nsaved\n");
    expect(variables).toEqual({ name: "saved" });
    expect(template).toBe("\n{{name}}\n");
  });
  test("empty templates and maps are valid", () => expect(compilePrompt("", {})).toBe(""));
  test("requires all and only declared variables", () => {
    expect(() => compilePrompt("{{name}}", {})).toThrow(PromptCompileError);
    expect(() => compilePrompt("literal", { name: "unused" })).toThrow(PromptCompileError);
    expect(() => compilePrompt("{{name}}", { name: "used", extra: "unused" })).toThrow(PromptCompileError);
  });
  test.each(["{{name", "{{}}", "{{ name }}", "{{a.b}}", "{{a{b}}", "{{constructor}}", "{{__proto__}}"])("rejects malformed or reserved placeholder %s", template => {
    expect(() => compilePrompt(template, {})).toThrow(PromptCompileError);
  });
  test("does not evaluate expressions or coerce values", () => {
    expect(() => compilePrompt("{{process.exit()}}", {})).toThrow(PromptCompileError);
    for (const value of [0, false, null, [], {}, undefined]) {
      expect(() => compilePrompt("{{value}}", { value } as unknown as Record<string, string>)).toThrow(PromptCompileError);
    }
  });
  test("rejects getters without invoking them", () => {
    let calls = 0;
    const variables = Object.defineProperty({}, "name", { enumerable: true, get() { calls++; return "unsafe"; } });
    expect(() => compilePrompt("{{name}}", variables)).toThrow(PromptCompileError);
    expect(calls).toBe(0);
  });
  test("rejects inherited, hidden and symbol variables", () => {
    expect(() => compilePrompt("{{name}}", Object.create({ name: "inherited" }))).toThrow(PromptCompileError);
    expect(() => compilePrompt("{{name}}", Object.defineProperty({}, "name", { value: "hidden" }))).toThrow(PromptCompileError);
    expect(() => compilePrompt("", { [Symbol("hidden")]: "value" } as Record<string, string>)).toThrow(PromptCompileError);
    expect(compilePrompt("{{name}}", Object.assign(Object.create(null), { name: "literal" }))).toBe("literal");
  });
  test("rejects malformed UTF-8 and NUL without exposing supplied values", () => {
    for (const template of ["\ud800", "literal\0", "\udfff"]) expect(() => compilePrompt(template, {})).toThrow(PromptCompileError);
    for (const value of ["\ud800", "PRIVATE_VALUE\0", "\udfff"]) {
      try { compilePrompt("{{name}}", { name: value }); throw new Error("Expected refusal"); }
      catch (error) { expect(error).toBeInstanceOf(PromptCompileError); expect((error as Error).message).not.toContain("PRIVATE_VALUE"); }
    }
  });
  test("bounds template bytes, including multibyte text", () => {
    expect(compilePrompt("a".repeat(32768), {})).toHaveLength(32768);
    expect(() => compilePrompt("a".repeat(32769), {})).toThrow(PromptCompileError);
    expect(() => compilePrompt("🦊".repeat(8193), {})).toThrow(PromptCompileError);
  });
  test("bounds each variable and the aggregate UTF-8 input", () => {
    expect(compilePrompt("{{name}}", { name: "🦊".repeat(1024) })).toBe("🦊".repeat(1024));
    expect(() => compilePrompt("{{name}}", { name: "🦊".repeat(1025) })).toThrow(PromptCompileError);
    const variables = Object.fromEntries(Array.from({ length: 9 }, (_, i) => ["v" + i, "a".repeat(4096)]));
    expect(() => compilePrompt(Object.keys(variables).map(key => "{{" + key + "}}").join(""), variables)).toThrow(PromptCompileError);
  });
  test("allows 64 exact variable names and refuses a sixty-fifth", () => {
    const variables = Object.fromEntries(Array.from({ length: 64 }, (_, i) => ["v" + i, "x"]));
    const template = Object.keys(variables).map(key => "{{" + key + "}}").join("");
    expect(compilePrompt(template, variables)).toBe("x".repeat(64));
    expect(() => compilePrompt(template + "{{v64}}", { ...variables, v64: "x" })).toThrow(PromptCompileError);
  });
  test("bounds repeated substitutions and expanded output before materialization", () => {
    expect(compilePrompt("{{x}}".repeat(1024), { x: "" })).toBe("");
    expect(() => compilePrompt("{{x}}".repeat(1025), { x: "" })).toThrow(PromptCompileError);
    expect(compilePrompt("{{x}}".repeat(16), { x: "a".repeat(4096) })).toHaveLength(65536);
    expect(() => compilePrompt("{{x}}".repeat(17), { x: "a".repeat(4096) })).toThrow(PromptCompileError);
  });
});
