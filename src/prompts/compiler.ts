export const PROMPT_COMPILE_LIMITS = Object.freeze({
  templateBytes: 32768, variables: 64, variableBytes: 4096,
  variableBytesTotal: 32768, substitutions: 1024, outputBytes: 65536,
});
export class PromptCompileError extends Error {
  constructor(message: string) { super(message); this.name = "PromptCompileError"; }
}
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });
const variableName = (name: string) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)
  && !["__proto__", "prototype", "constructor"].includes(name);
function bytes(value: unknown, maximum: number): number {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) {
    throw new PromptCompileError("Prompt text must be bounded literal UTF-8 without NUL.");
  }
  const encoded = encoder.encode(value);
  if (encoded.length > maximum || decoder.decode(encoded) !== value) {
    throw new PromptCompileError("Prompt text must be bounded literal UTF-8 without NUL.");
  }
  return encoded.length;
}

/** Substituted values are literal; only the original template is scanned. */
export function compilePrompt(template: string, variables: Readonly<Record<string, string>>): string {
  const limits = PROMPT_COMPILE_LIMITS;
  bytes(template, limits.templateBytes);
  if (!variables || typeof variables !== "object" || Array.isArray(variables)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(variables))) {
    throw new PromptCompileError("Variables must be a plain map of literal strings.");
  }
  const keys = Reflect.ownKeys(variables);
  if (keys.length > limits.variables) throw new PromptCompileError("Prompt has too many variables.");
  const values = new Map<string, { text: string; bytes: number }>();
  let inputBytes = 0;
  for (const key of keys) {
    if (typeof key !== "string" || !variableName(key)) throw new PromptCompileError("Variable names are invalid.");
    const descriptor = Object.getOwnPropertyDescriptor(variables, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new PromptCompileError("Variable values must be own literal strings.");
    const size = bytes(descriptor.value, limits.variableBytes);
    inputBytes += size;
    if (inputBytes > limits.variableBytesTotal) throw new PromptCompileError("Variable text exceeds the input limit.");
    values.set(key, { text: descriptor.value, bytes: size });
  }
  const used = new Set<string>(), chunks: string[] = [];
  let cursor = 0, substitutions = 0, outputBytes = 0;
  const append = (text: string, size: number) => {
    outputBytes += size;
    if (outputBytes > limits.outputBytes) throw new PromptCompileError("Compiled prompt exceeds the output limit.");
    chunks.push(text);
  };
  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) break;
    const literal = template.slice(cursor, start);
    append(literal, encoder.encode(literal).length);
    const end = template.indexOf("}}", start + 2);
    const name = end === -1 ? "" : template.slice(start + 2, end);
    if (!variableName(name)) throw new PromptCompileError("Template contains a malformed placeholder.");
    if (++substitutions > limits.substitutions) throw new PromptCompileError("Template has too many substitutions.");
    const value = values.get(name);
    if (!value) throw new PromptCompileError("Template requires a missing variable.");
    append(value.text, value.bytes); used.add(name); cursor = end + 2;
  }
  const remainder = template.slice(cursor);
  append(remainder, encoder.encode(remainder).length);
  if (used.size !== values.size) throw new PromptCompileError("Variables include an unused name.");
  return chunks.join("");
}
