import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { ComparisonAccounting } from "../app/src/components/prompts/ComparisonAccounting";
import type { ComparisonAttempt } from "../app/src/components/prompts/comparison-client";
const appRequire = createRequire(new URL("../app/package.json", import.meta.url));
const { renderToStaticMarkup } = appRequire("react-dom/server");
const { createElement } = appRequire("react");

const base = { position: 0, provider: "openai", model: "gpt-5.4", reason: null, payload: null, holdMicrousd: 0, budgetBreach: false, deadlineAt: 2, startedAt: 1, finishedAt: 2 };
const render = (attempt: Partial<ComparisonAttempt>) => renderToStaticMarkup(createElement(ComparisonAccounting, { attempt: { ...base, ...attempt } as ComparisonAttempt, input: null, output: null, rateRevision: "r" })) as string;

test("a cancelled attempt says its charge is the reserved maximum, not an observed cost", () => {
  // Live soak: a gpt-5.4 attempt cancelled mid-flight kept its 18,195 micro-dollar reservation with no usage.
  const html = render({ status: "cancelled", reason: "cancelled", reserveMicrousd: 18195, chargeMicrousd: 18195, accountingState: "conservative", observedEstimateUsd: null });
  expect(html).toContain("$0.018195");
  expect(html).toContain("Charged · reserved maximum");
  expect(html).toContain("This is not the observed cost.");
  expect(html).not.toContain("Retained accounting");
});

test("a completed attempt names its charge as the rounded observed estimate", () => {
  const html = render({ status: "completed", reserveMicrousd: 4875, chargeMicrousd: 448, accountingState: "measured_estimate", observedEstimateUsd: "0.0004475" });
  expect(html).toContain("Charged · observed estimate");
  expect(html).not.toContain("reserved maximum");
});
