import { compilePrompt, PromptCompileError, PROMPT_COMPILE_LIMITS } from "./compiler";
import { redactText } from "../verification/serialization";
import { defaultIsSensitiveKey } from "../verification/redaction";

export const PROMPT_POLICY = "literal-v1" as const;
export const PROMPT_LIMITS = Object.freeze({
  ...PROMPT_COMPILE_LIMITS, nameBytes: 256, schemaBytes: 4353,
  promptsPerScope: 100, promptsGlobal: 1000, revisionsPerPrompt: 32,
  revisionsGlobal: 10000, retainedBytes: 33554432,
  listPage: 50, requestBytes: 65536, responseBytes: 131072,
});
const messages = {
  invalid_request: "Prompt request is invalid.", limit_refused: "Prompt request exceeds its limit.",
  credentials: "Prompt content contains protected credentials.",
  operation_conflict: "Prompt operation key conflicts.", revision_conflict: "Prompt head changed. Reload before saving.",
  authority_changed: "Prompt authority changed. Retry with current access.",
  not_found: "Prompt revision not found.", deleted: "Prompt was removed. This operation cannot recreate it.",
  capacity: "Prompt storage capacity reached.", integrity: "Stored prompt integrity check failed.",
  unavailable: "Prompt scope is unavailable.",
} as const;
export type PromptErrorCode = keyof typeof messages;
export class PromptRegistryError extends Error {
  readonly status: number;
  constructor(readonly code: PromptErrorCode) {
    super(messages[code]); this.name = "PromptRegistryError";
    this.status = code === "not_found" ? 404 : code === "unavailable" ? 403
      : ["limit_refused", "capacity"].includes(code) ? 413
        : ["operation_conflict", "revision_conflict", "authority_changed", "deleted", "integrity"].includes(code) ? 409 : 400;
  }
}
export type PromptCapability = "read" | "edit" | "delete";
/** Internal request authority only; never accepted as a public request field. */
export interface PromptFence { readonly promptGeneration: number; readonly evidenceGeneration: number }
export function promptFence(value: unknown): PromptFence {
  const input = promptObject(value, ["promptGeneration", "evidenceGeneration"]);
  return Object.freeze({ promptGeneration: promptInteger(input.promptGeneration), evidenceGeneration: promptInteger(input.evidenceGeneration) });
}
export function samePromptFence(left: PromptFence, right: PromptFence): boolean {
  return left.promptGeneration === right.promptGeneration && left.evidenceGeneration === right.evidenceGeneration;
}
export interface PromptDraft { operationKey: string; name: string; template: string; variableNames: string[] }
export interface PromptRevision {
  id: string; revision: number; name: string; template: string; templateSha256: string;
  variableNames: string[]; policy: typeof PROMPT_POLICY; createdAt: number;
}
export interface PromptSummary { id: string; revision: number; name: string; templateSha256: string; createdAt: number; updatedAt: number }
export interface PromptHistoryEntry { revision: number; name: string; templateSha256: string; createdAt: number }
export interface PromptPage { items: PromptSummary[]; hasMore: boolean; cursor: string | null }
export interface PromptCompilation { id: string; revision: number; templateSha256: string; compiled: string }
export interface PromptExport { format: "runphantom-prompt/v1"; prompt: PromptRevision }

export function promptObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new PromptRegistryError("invalid_request");
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) throw new PromptRegistryError("invalid_request");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new PromptRegistryError("invalid_request");
    result[key] = descriptor.value;
  }
  return result;
}
export function promptInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new PromptRegistryError("invalid_request");
  return value;
}
export function promptId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new PromptRegistryError("invalid_request");
  return value;
}
export function promptText(value: unknown, maximum: number, empty = true): string {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0") || !empty && !value.trim()) throw new PromptRegistryError("invalid_request");
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > maximum || new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== value) throw new PromptRegistryError("limit_refused");
  if (redactText(value, defaultIsSensitiveKey) !== value) throw new PromptRegistryError("credentials");
  return value;
}
/** Compiler validation is reused; schema extraction never interprets substituted text. */
export function promptTemplate(value: unknown): { template: string; variableNames: string[] } {
  const template = promptText(value, PROMPT_LIMITS.templateBytes), names = new Set<string>();
  const variables: Record<string, string> = Object.create(null) as Record<string, string>;
  let cursor = 0, substitutions = 0;
  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start === -1) break;
    const end = template.indexOf("}}", start + 2), name = end === -1 ? "" : template.slice(start + 2, end);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || ["__proto__", "prototype", "constructor"].includes(name)) throw new PromptRegistryError("invalid_request");
    if (defaultIsSensitiveKey(name)) throw new PromptRegistryError("credentials");
    names.add(name);
    if (++substitutions > PROMPT_LIMITS.substitutions || names.size > PROMPT_LIMITS.variables) throw new PromptRegistryError("limit_refused");
    variables[name] = ""; cursor = end + 2;
  }
  try { compilePrompt(template, variables); }
  catch (error) { if (error instanceof PromptCompileError) throw new PromptRegistryError("invalid_request"); throw error; }
  return { template, variableNames: [...names].sort() };
}
export function parsePromptDraft(value: unknown, append = false): PromptDraft & { expectedRevision?: number } {
  const input = promptObject(value, append ? ["operationKey", "name", "template", "expectedRevision"] : ["operationKey", "name", "template"]);
  return { operationKey: promptId(input.operationKey), name: promptText(input.name, PROMPT_LIMITS.nameBytes, false),
    ...promptTemplate(input.template), ...(append ? { expectedRevision: promptInteger(input.expectedRevision, PROMPT_LIMITS.revisionsPerPrompt) } : {}) };
}
export function literalPromptCompilation(template: string, value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new PromptRegistryError("invalid_request");
  const keys = Reflect.ownKeys(value);
  if (keys.length > PROMPT_LIMITS.variables) throw new PromptRegistryError("limit_refused");
  for (const key of keys) {
    if (typeof key !== "string") throw new PromptRegistryError("invalid_request");
    if (defaultIsSensitiveKey(key)) throw new PromptRegistryError("credentials");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new PromptRegistryError("invalid_request");
    promptText(descriptor.value, PROMPT_LIMITS.variableBytes);
  }
  try { return promptText(compilePrompt(template, value as Record<string, string>), PROMPT_LIMITS.outputBytes); }
  catch (error) { if (error instanceof PromptCompileError) throw new PromptRegistryError("invalid_request"); throw error; }
}

/** Count finite generated DTO JSON before allocating its serialized response. */
export function boundedPromptResult<T>(value: T): T {
  let size = 0;
  const add = (count: number) => { size += count; if (size > PROMPT_LIMITS.responseBytes) throw new PromptRegistryError("limit_refused"); };
  function string(text: string): void {
    add(2);
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      if (unit === 34 || unit === 92 || [8, 9, 10, 12, 13].includes(unit)) add(2);
      else if (unit < 32) add(6);
      else if (unit < 128) add(1);
      else if (unit < 2048) add(2);
      else if (unit >= 0xd800 && unit <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { add(4); i++; }
      else add(3);
    }
  }
  function visit(item: unknown): void {
    if (typeof item === "string") { string(item); return; }
    if (item === null || typeof item !== "object") { add(JSON.stringify(item)?.length ?? 4); return; }
    add(2);
    if (Array.isArray(item)) item.forEach((child: unknown, index: number) => { if (index) add(1); visit(child); });
    else Object.entries(item).forEach(([key, child], index) => { if (index) add(1); string(key); add(1); visit(child); });
  }
  visit(value); return value;
}
