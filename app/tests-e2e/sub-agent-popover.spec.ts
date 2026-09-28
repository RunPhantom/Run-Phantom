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

async function openSubAgentPopover(page: Page, url: string): Promise<Locator> {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${url}/runs/${TRACE_ID}`);
  await page.locator("button[aria-haspopup='dialog']", { hasText: "researcher" }).click();
  const popover = page.getByRole("dialog", { name: "researcher sub-agent details" });
  await expect(popover).toBeVisible();
  return popover;
}

test.beforeEach(async ({ runPhantom }) => {
  await clearRunPhantom(runPhantom.url);
});

test("sub-agent popover: a failed tool is marked as an error, not with a success check", async ({ page, runPhantom }) => {
  await seedSubAgentWithFailedTool(runPhantom.url);
  const popover = await openSubAgentPopover(page, runPhantom.url);

  // Every tool in the popover drew the green check, so read_changelog, which
  // failed, read "✓ read_changelog 1.1s" in green.
  const chip = (name: string) => popover.evaluate((root, toolName) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.trim() !== toolName || !node.parentElement) continue;
      const element = node.parentElement;
      const icon = element.querySelector("svg");
      const danger = document.createElement("span");
      danger.style.color = "var(--rp-danger)";
      document.body.append(danger);
      const dangerColor = getComputedStyle(danger).color;
      danger.remove();
      return {
        alert: !!icon?.querySelector("circle"),
        check: !!icon?.querySelector("polyline"),
        stroke: icon?.getAttribute("stroke") ?? null,
        danger: getComputedStyle(element).color === dangerColor,
      };
    }
    return null;
  }, name);

  expect(await chip("read_changelog")).toEqual({ alert: true, check: false, stroke: "var(--rp-danger)", danger: true });
  expect(await chip("list_files")).toEqual({ alert: false, check: true, stroke: "var(--rp-success)", danger: false });
});

test("sub-agent popover: the open button keeps its label on one line at 1280x720", async ({ page, runPhantom }) => {
  await seedSubAgentWithFailedTool(runPhantom.url);
  const popover = await openSubAgentPopover(page, runPhantom.url);

  // The footer's model and token summary squeezed the button, which wrapped
  // as "Open Sub-" over "Agent →".
  const open = popover.getByRole("button", { name: "Open Sub-Agent →" });
  await expect(open).toBeVisible();
  const lines = await open.evaluate((button) => {
    const range = document.createRange();
    range.selectNodeContents(button);
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  });
  expect(lines, "lines in the Open Sub-Agent label").toBe(1);
});
