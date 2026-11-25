import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { clearRunPhantom } from "./helpers";

const TRACE_ID = "5ab0000000000000000000000000e009";
const spanId = (slot: number) => `5ab0e009${slot.toString(16).padStart(8, "0")}`;
const SUB_AGENT_ROOT = spanId(3);

type Attr = { key: string; value: { stringValue: string } | { intValue: string } };
const str = (key: string, value: string): Attr => ({ key, value: { stringValue: value } });
const int = (key: string, value: number): Attr => ({ key, value: { intValue: String(value) } });
const llm = (model: string, prompt: string, response: string, inputTokens: number, outputTokens: number) => [
  str("ai.operationId", "ai.generateText"),
  str("ai.model.id", model),
  str("ai.model.provider", "anthropic"),
  str("ai.prompt", JSON.stringify({ messages: [{ role: "user", content: prompt }] })),
  str("ai.response.text", response),
  int("ai.usage.inputTokens", inputTokens),
  int("ai.usage.outputTokens", outputTokens),
];
const tool = (name: string, args: unknown, result: string) => [
  str("ai.operationId", "ai.toolCall"),
  str("ai.toolCall.name", name),
  str("ai.toolCall.args", JSON.stringify(args)),
  str("ai.toolCall.result", result),
];

// TOOL_CALL > LLM_GENERATION > TOOL_CALL is the shape src/agents.ts detects as a
// sub-agent. One of the sub-agent's two tools fails.
async function seedSubAgentWithFailedTool(url: string): Promise<void> {
  const t0 = Date.now() - 60_000;
  const nano = (ms: number) => String(BigInt(t0 + ms) * 1_000_000n);
  const spans = [
    { spanId: spanId(1), name: "agent.turn", start: 0, end: 4000, attrs: [] },
    { spanId: spanId(2), parentSpanId: spanId(1), name: "llm.generate", start: 10, end: 500,
      attrs: llm("claude-sonnet-4-5", "Summarise the release notes for 2.4.0", "Delegating to the researcher.", 64, 8) },
    { spanId: SUB_AGENT_ROOT, parentSpanId: spanId(1), name: "ai.toolCall", start: 520, end: 3400,
      attrs: tool("researcher", { topic: "release notes 2.4.0" }, "The researcher could not read the changelog.") },
    { spanId: spanId(4), parentSpanId: SUB_AGENT_ROOT, name: "llm.generate", start: 540, end: 1500,
      attrs: llm("claude-haiku-4-5", "Research the release notes for 2.4.0", "Reading the changelog.", 58, 6) },
    { spanId: spanId(5), parentSpanId: spanId(4), name: "ai.toolCall", start: 1510, end: 1600,
      attrs: tool("list_files", { dir: "." }, "CONTRIBUTING.md\npackage.json") },
    { spanId: spanId(6), parentSpanId: spanId(4), name: "ai.toolCall", start: 1620, end: 2720, code: 2,
      attrs: tool("read_changelog", { path: "CHANGELOG.md" }, "ENOENT: CHANGELOG.md not found") },
  ];
  const res = await fetch(`${url}/v1/traces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: spans.map((span) => ({
      traceId: TRACE_ID,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      kind: 1,
      startTimeUnixNano: nano(span.start),
      endTimeUnixNano: nano(span.end),
      status: { code: span.code ?? 1 },
      attributes: span.attrs,
    })) }] }] }),
  });
  expect(res.ok, `POST /v1/traces -> ${res.status}`).toBe(true);
  const detail = await (await fetch(`${url}/api/runs/detail/${TRACE_ID}`)).json() as { subAgents: Array<{ root_span_id: string }> };
  expect(detail.subAgents.map((agent) => agent.root_span_id)).toEqual([SUB_AGENT_ROOT]);
}

async function openSubAgentCard(page: Page, url: string, width = 1280, height = 720): Promise<Locator> {
  await page.setViewportSize({ width, height });
  await page.goto(`${url}/runs/${TRACE_ID}`);
  await page.getByRole("button", { name: /^agent\s*researcher/ }).click();
  const details = page.getByRole("region", { name: "researcher sub-agent details" });
  await expect(details).toBeVisible();
  return details;
}

test.beforeEach(async ({ runPhantom }) => {
  await clearRunPhantom(runPhantom.url);
});

test("sub-agent card: a failed tool is marked as an error, not with a success check", async ({ page, runPhantom }, testInfo) => {
  await seedSubAgentWithFailedTool(runPhantom.url);
  const details = await openSubAgentCard(page, runPhantom.url);

  // Every tool in the sub-agent drew the green check, so read_changelog, which
  // failed, read "✓ read_changelog 1.1s" in green.
  const pill = (name: string) => details.getByRole("button", { name: `Expand tool call ${name}` }).evaluate((button) => {
    const icon = button.querySelector("svg");
    const danger = document.createElement("span");
    danger.style.color = "var(--rp-danger)";
    document.body.append(danger);
    const dangerColor = getComputedStyle(danger).color;
    danger.remove();
    return {
      alert: !!icon?.querySelector("circle"),
      check: !!icon?.querySelector("polyline"),
      stroke: icon?.getAttribute("stroke") ?? null,
      danger: getComputedStyle(button).color === dangerColor,
    };
  });

  expect(await pill("read_changelog")).toEqual({ alert: true, check: false, stroke: "var(--rp-danger)", danger: true });
  expect(await pill("list_files")).toEqual({ alert: false, check: true, stroke: "var(--rp-success)", danger: false });
  await details.screenshot({ path: testInfo.outputPath("sub-agent-tool-statuses.png") });
});

test("sub-agent card: the prompt is the parent's task, not a user message, and replies follow it", async ({ page, runPhantom }) => {
  await seedSubAgentWithFailedTool(runPhantom.url);
  const details = await openSubAgentCard(page, runPhantom.url);
  await expect(details.getByText("Prompt from parent agent")).toBeVisible();
  await expect(details.getByText("Research the release notes for 2.4.0")).toBeVisible();
  await expect(details.getByText("Reading the changelog.")).toBeVisible();
  await expect(page.getByText("Research the release notes for 2.4.0")).toHaveCount(1);
  await expect(details).toContainText(/claude-haiku-4-5 · 1 LLM call · 2 tools/);
});

for (const [width, height] of [[1280, 720], [390, 844]] as const) {
  test(`sub-agent card: the open button keeps its label on one line at ${width}x${height}`, async ({ page, runPhantom }, testInfo) => {
    await seedSubAgentWithFailedTool(runPhantom.url);
    await openSubAgentCard(page, runPhantom.url, width, height);

    // A squeezed button wrapped as "Open Sub-" over "Agent →".
    const open = page.getByRole("button", { name: "Open Sub-Agent →" });
    await expect(open).toBeVisible();
    const lines = await open.evaluate((button) => {
      const range = document.createRange();
      range.selectNodeContents(button);
      return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
    });
    expect(lines, "lines in the Open Sub-Agent label").toBe(1);
    await page.locator("[data-sub-agent]").screenshot({ path: testInfo.outputPath(`sub-agent-card-${width}.png`) });
  });
}
