import { expect, test } from "./fixtures";
import { clearRunPhantom } from "./helpers";

const TRACE_ID = "5ab0000000000000000000000000d005";
const spanId = (slot: number) => `5ab00000${slot.toString(16).padStart(8, "0")}`;
const ROOT = spanId(1);
const PARENT_LLM = spanId(2);
const SUB_AGENT_ROOT = spanId(3);
const SUB_AGENT_LLM = spanId(4);
const SUB_AGENT_FAILED_TOOL = spanId(5);

type Attr = { key: string; value: { stringValue: string } };
const str = (key: string, value: string): Attr => ({ key, value: { stringValue: value } });
const meta = [str("ai.telemetry.metadata.runphantom.eventName", "research-agent")];
const llm = (prompt: string, response: string) => [
  str("ai.operationId", "ai.generateText"),
  str("ai.model.id", "claude-sonnet-4-5"),
  str("ai.model.provider", "anthropic"),
  str("ai.prompt", JSON.stringify({ messages: [{ role: "user", content: prompt }] })),
  str("ai.response.text", response),
];
const tool = (name: string, args: unknown, result: string) => [
  str("ai.operationId", "ai.toolCall"),
  str("ai.toolCall.name", name),
  str("ai.toolCall.args", JSON.stringify(args)),
  str("ai.toolCall.result", result),
];

// TOOL_CALL > LLM_GENERATION > TOOL_CALL is the shape src/agents.ts detects as a
// sub-agent; the grandchild tool fails, as in a failure hidden one level down.
async function seedSubAgentTrace(url: string): Promise<void> {
  const t0 = Date.now() - 10_000;
  const nano = (ms: number) => String(BigInt(t0 + ms) * 1_000_000n);
  const spans = [
    { spanId: ROOT, name: "agent.turn", start: 0, end: 4000, attrs: meta },
    { spanId: PARENT_LLM, parentSpanId: ROOT, name: "llm.generate", start: 10, end: 500,
      attrs: [...meta, ...llm("Summarise the release notes", "Delegating to the researcher.")] },
    { spanId: SUB_AGENT_ROOT, parentSpanId: ROOT, name: "ai.toolCall", start: 520, end: 3400,
      attrs: [...meta, ...tool("researcher", { topic: "release notes" }, "The researcher could not read the changelog.")] },
    { spanId: SUB_AGENT_LLM, parentSpanId: SUB_AGENT_ROOT, name: "llm.generate", start: 540, end: 1500,
      attrs: [...meta, ...llm("Research the release notes", "Reading the changelog.")] },
    { spanId: SUB_AGENT_FAILED_TOOL, parentSpanId: SUB_AGENT_LLM, name: "ai.toolCall", start: 1520, end: 2600, code: 2,
      attrs: [...meta, ...tool("read_changelog", { path: "CHANGELOG.md" }, "ENOENT: CHANGELOG.md not found")] },
    { spanId: spanId(6), parentSpanId: ROOT, name: "llm.generate", start: 3420, end: 3990,
      attrs: [...meta, ...llm("The researcher failed", "The researcher could not read the changelog.")] },
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

test.beforeEach(async ({ runPhantom }) => {
  await clearRunPhantom(runPhantom.url);
  await seedSubAgentTrace(runPhantom.url);
});

test("Run Phantom UI: clicking a sub-agent's Trajectory bar in the parent view focuses that sub-agent", async ({ page, runPhantom }) => {
  await page.goto(`${runPhantom.url}/runs/${TRACE_ID}`);
  const chip = page.getByRole("button", { name: /^agent\s*researcher/ });
  const details = page.getByRole("dialog", { name: "researcher sub-agent details" });
  await expect(chip).toBeVisible();
  await expect(details).toBeHidden();

  const bar = (id: string) => page.locator(`button.timeline-bar[data-meridian-key="${id}"]`);
  for (const id of [SUB_AGENT_FAILED_TOOL, SUB_AGENT_ROOT, SUB_AGENT_LLM]) {
    await bar(id).click();
    await expect(details, `bar ${id} opens the sub-agent details`).toBeVisible();
    await expect(chip).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(details).toBeHidden();
  }

  // The parent's own LLM bars stay inspect-only.
  await bar(PARENT_LLM).click();
  await expect(details).toBeHidden();
  await page.mouse.move(2, 2);
  await expect(page.locator("[data-span-tooltip]")).toBeHidden();

  // The row label jumps to the first tool of that name, which lives in the sub-agent.
  await page.getByTitle("read_changelog - jump to first tool call").click();
  await expect(details).toBeVisible();

  await details.getByRole("button", { name: /Open Sub-Agent/ }).click();
  await expect(page.getByRole("button", { name: /Show Parent Agent/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Expand tool call read_changelog" })).toBeVisible();
});

test("Run Phantom UI: a sub-agent's Trajectory bar opens it from the keyboard", async ({ page, runPhantom }) => {
  await page.goto(`${runPhantom.url}/runs/${TRACE_ID}`);
  const chip = page.getByRole("button", { name: /^agent\s*researcher/ });
  const details = page.getByRole("dialog", { name: "researcher sub-agent details" });
  await expect(chip).toBeVisible();

  const failedBar = page.locator(`button.timeline-bar[data-meridian-key="${SUB_AGENT_FAILED_TOOL}"]`);
  await failedBar.focus();
  await page.keyboard.press("Enter");
  await expect(details).toBeVisible();
  await expect(chip).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(details.getByRole("button", { name: /Open Sub-Agent/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /Show Parent Agent/ })).toBeVisible();
});
