import { test, expect } from "bun:test";
import { randomUUID, createHash } from "node:crypto";
import { parseComparisonRequest, freezeComparisonRequest } from "../src/prompts/comparison-protocol";
import { reserveComparisonAttempt, estimateComparisonUsage } from "../src/prompts/spend-ledger";
import type { PromptRevision } from "../src/prompts/protocol";

const request = () => ({ operationKey: randomUUID(), promptId: randomUUID(), revision: 1, variables: { topic: "$& $$ {{other}} <img>" }, targets: [{ provider: "openai", model: "gpt-5.4" }], options: { maxOutputTokens: 128, temperature: 0 }, operationBudgetMicrousd: 100000, expectedGeneration: 1 });
const source = (input: ReturnType<typeof request>): PromptRevision => {
  const template = 'Review {{topic}}. {"outer":{"value":true}}';
  return { id: input.promptId, revision: 1, name: "Frozen execution", template, templateSha256: createHash("sha256").update(template).digest("hex"), variableNames: ["topic"], policy: "literal-v1", createdAt: 1 };
};

test("freezes the exact historical revision, one-pass literal input, target roster and options", () => {
  const input = request(), original = source(input), frozen = freezeComparisonRequest(parseComparisonRequest(input), original);
  expect(frozen.compiled).toBe('Review $& $$ {{other}} <img>. {"outer":{"value":true}}');
  input.variables.topic = "changed"; input.targets[0].model = "gpt-4.1"; input.options.maxOutputTokens = 1024; original.name = "mutable caller";
  expect(frozen.prompt.name).toBe("Frozen execution"); expect(frozen.targets[0].model).toBe("gpt-5.4"); expect(frozen.options.maxOutputTokens).toBe(128);
  expect(Object.isFrozen(frozen)).toBe(true); expect(Object.isFrozen(frozen.targets[0])).toBe(true);
});

test("refuses mutable latest, foreign source revision, template digest mismatch and credential fragments", () => {
  const input = request();
  expect(() => freezeComparisonRequest(parseComparisonRequest(input), { ...source(input), revision: 2 })).toThrow();
  expect(() => freezeComparisonRequest(parseComparisonRequest(input), { ...source(input), templateSha256: "a".repeat(64) })).toThrow();
  expect(() => parseComparisonRequest({ ...input, revision: "latest" })).toThrow();
  expect(() => freezeComparisonRequest(parseComparisonRequest({ ...input, variables: { topic: "password=hunter2" } }), source(input))).toThrow();
});

test("public requests cannot provide endpoint, scope, database, credentials, fallback or rate authority", () => {
  for (const field of ["url", "scope", "projectId", "database", "apiKey", "retry", "fallback", "rateRevision"]) expect(() => parseComparisonRequest({ ...request(), [field]: "untrusted" })).toThrow();
  const input = request(); let reads = 0;
  Object.defineProperty(input.options, "temperature", { get: () => { reads++; return 0; }, enumerable: true });
  expect(() => parseComparisonRequest(input)).toThrow(); expect(reads).toBe(0);
});

test("retains a finite explicit population and refuses duplicate, unknown, sparse and over-bound targets/options", () => {
  const input = request();
  for (const targets of [[], Array(5).fill(input.targets[0]), [input.targets[0], input.targets[0]], [{ provider: "openai", model: "arbitrary" }], Array(2)]) expect(() => parseComparisonRequest({ ...input, targets })).toThrow();
  for (const maxOutputTokens of [0, 1025, 1.5, Infinity]) expect(() => parseComparisonRequest({ ...input, options: { ...input.options, maxOutputTokens } })).toThrow();
  for (const operationBudgetMicrousd of [0, 1000001, 0.5, Infinity]) expect(() => parseComparisonRequest({ ...input, operationBudgetMicrousd })).toThrow();
  expect(() => freezeComparisonRequest(parseComparisonRequest({ ...input, variables: { topic: "😀".repeat(4096) } }), source(input))).toThrow();
});

test("reserves an integer upper estimate before execution and keeps absent usage distinct from measured zero", () => {
  const target = { provider: "openai", model: "gpt-5.4" } as const;
  const reserve = reserveComparisonAttempt("é".repeat(100), target, 128);
  expect(Number.isSafeInteger(reserve.microusd)).toBe(true); expect(reserve.microusd).toBeGreaterThan(0); expect(reserve.inputTokenCeiling).toBe(1224);
  const missing = estimateComparisonUsage(target, { model: "gpt-5.4" });
  expect(missing.estimate.totalUsd).toBeNull(); expect(missing.invoiceUsd).toBeNull();
  const zero = estimateComparisonUsage(target, { model: "gpt-5.4", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, contextTokens: 0 });
  expect(zero.estimate.totalUsd).toBe(0); expect(zero.invoiceUsd).toBeNull();
  const mismatch = estimateComparisonUsage(target, { model: "unexpected-model", inputTokens: 1, outputTokens: 1 });
  expect(mismatch.estimate.totalUsd).toBeNull();
});
