import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures";
import { clearRunPhantom } from "./helpers";

type Value = string | number;
type SeedSpan = { id: string; parent?: string; name: string; start: number; end: number; attrs: Record<string, Value>; error?: string };

const LEDGER_TRACE = "c0de0000000000000000000000000a01";
const NESTED_TRACE = "c0de0000000000000000000000000a02";
const ledgerSpan = (slot: number) => `c0dea001${slot.toString(16).padStart(8, "0")}`;
const nestedSpan = (slot: number) => `c0dea002${slot.toString(16).padStart(8, "0")}`;

async function seed(url: string, traceId: string, spans: SeedSpan[]): Promise<void> {
  const t0 = Date.now() - 60_000;
  const nano = (ms: number) => String(BigInt(t0 + ms) * 1_000_000n);
  const res = await fetch(`${url}/v1/traces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: spans.map(span => ({
      traceId, spanId: span.id, parentSpanId: span.parent, name: span.name, kind: 1,
      startTimeUnixNano: nano(span.start), endTimeUnixNano: nano(span.end),
      status: span.error ? { code: 2, message: span.error } : { code: 1 },
      attributes: Object.entries(span.attrs).map(([key, value]) => ({ key, value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value } })),
    })) }] }] }),
  });
  expect(res.ok, `POST /v1/traces -> ${res.status}`).toBe(true);
}

const chat = (user: string, text: string, toolCalls: string[] = []): Record<string, Value> => ({
  "gen_ai.operation.name": "chat", "gen_ai.provider.name": "anthropic", "gen_ai.request.model": "claude-haiku-4-5-20251001",
  "gen_ai.input.messages": JSON.stringify([{ role: "user", parts: [{ type: "text", content: user }] }]),
  "gen_ai.output.messages": JSON.stringify([{ role: "assistant", parts: [{ type: "text", content: text }, ...toolCalls.map((name, i) => ({ type: "tool_call", id: `call_${i}`, name, arguments: {} }))] }]),
  "gen_ai.usage.input_tokens": 1200, "gen_ai.usage.output_tokens": 120,
});
const tool = (name: string, result: string): Record<string, Value> => ({
  "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name, "gen_ai.tool.call.arguments": "{}", "gen_ai.tool.call.result": result,
});
const agent = (name: string, input: string, extra: Record<string, Value> = {}): Record<string, Value> => ({
  "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": name, "runphantom.input": input, ...extra,
});

// The Anthropic "Refund stopped by a ledger conflict" run: each tool starts in
// the same millisecond the model call that requested it ends, and the last
// tool fails instantly at the very end of the trace.
async function seedLedgerRun(url: string): Promise<void> {
  await seed(url, LEDGER_TRACE, [
    { id: ledgerSpan(1), name: "invoke_agent support-agent", start: 0, end: 2849, error: "ledger conflict",
      attrs: agent("support-agent", "My speakers were lost by the courier. Please refund me.", { "runphantom.span.kind": "agent_root", "runphantom.event.name": "Refund stopped by a ledger conflict", "gen_ai.request.model": "claude-haiku-4-5-20251001" }) },
    { id: ledgerSpan(2), parent: ledgerSpan(1), name: "chat claude-haiku-4-5-20251001", start: 0, end: 1282,
      attrs: chat("My speakers were lost by the courier. Please refund me.", "I'll look up your order and check the refund policy.", ["lookup_order", "search_kb"]) },
    { id: ledgerSpan(3), parent: ledgerSpan(1), name: "execute_tool lookup_order", start: 1282, end: 1282, attrs: tool("lookup_order", "{\"status\":\"lost\"}") },
    { id: ledgerSpan(4), parent: ledgerSpan(1), name: "execute_tool search_kb", start: 1282, end: 1282, attrs: tool("search_kb", "{\"policy\":\"full refund\"}") },
    { id: ledgerSpan(5), parent: ledgerSpan(1), name: "chat claude-haiku-4-5-20251001", start: 1282, end: 2849,
      attrs: chat("My speakers were lost by the courier. Please refund me.", "Your order qualifies. I'm issuing your $249 refund now.", ["issue_refund"]) },
    { id: ledgerSpan(6), parent: ledgerSpan(1), name: "execute_tool issue_refund", start: 2849, end: 2849, error: "Payments ledger rejected refund",
      attrs: tool("issue_refund", "{\"error\":\"ledger_conflict\"}") },
  ]);
}

// orchestrator (no model call) -> planner -> reader, the agent -> agent hand-off shape.
async function seedNestedRun(url: string): Promise<void> {
  await seed(url, NESTED_TRACE, [
    { id: nestedSpan(1), name: "invoke_agent orchestrator", start: 0, end: 9000, error: "reader failed",
      attrs: agent("orchestrator", "Draft the 2.4.0 release notes.", { "runphantom.span.kind": "agent_root", "runphantom.event.name": "Nested release notes", "runphantom.conversation.id": "conv-nested" }) },
    { id: nestedSpan(2), parent: nestedSpan(1), name: "invoke_agent planner", start: 10, end: 8000, error: "reader failed", attrs: agent("planner", "Outline the 2.4.0 notes.") },
    { id: nestedSpan(3), parent: nestedSpan(2), name: "chat claude-haiku-4-5-20251001", start: 20, end: 1000, attrs: chat("Outline the 2.4.0 notes.", "I'll ask the reader for the changelog.") },
    { id: nestedSpan(4), parent: nestedSpan(2), name: "invoke_agent reader", start: 1000, end: 7000, error: "ENOENT", attrs: agent("reader", "Read CHANGELOG.md.") },
    { id: nestedSpan(5), parent: nestedSpan(4), name: "chat claude-haiku-4-5-20251001", start: 1010, end: 3000, attrs: chat("Read CHANGELOG.md.", "Opening the changelog.", ["open_file"]) },
    { id: nestedSpan(6), parent: nestedSpan(4), name: "execute_tool open_file", start: 3000, end: 3000, error: "ENOENT", attrs: tool("open_file", "{\"error\":\"ENOENT\"}") },
  ]);
  const detail = await (await fetch(`${url}/api/runs/detail/${NESTED_TRACE}`)).json() as { subAgents: Array<{ root_span_id: string }> };
  expect(detail.subAgents.map(item => item.root_span_id)).toEqual([nestedSpan(2), nestedSpan(4)]);
}

/** Vertical order of the given locators' first matches, top to bottom. */
async function tops(locators: Locator[]): Promise<number[]> {
  return Promise.all(locators.map(async locator => (await locator.first().boundingBox())!.y));
}

async function insideTrack(bar: Locator): Promise<{ inside: boolean; width: number }> {
  return bar.evaluate(element => {
    const track = element.closest("[data-trace-track]")!.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return { inside: box.left >= track.left - 0.5 && box.right <= track.right + 0.5, width: box.width };
  });
}

test.beforeEach(async ({ runPhantom }) => {
  await clearRunPhantom(runPhantom.url);
});

test("overview conversation: each reply comes before the tools it requested, so the failed tool is last", async ({ page, runPhantom }, testInfo) => {
  await seedLedgerRun(runPhantom.url);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${runPhantom.url}/runs/${LEDGER_TRACE}`);
  const panel = page.getByRole("tabpanel", { name: "Overview" });
  const firstReply = panel.getByText("I'll look up your order and check the refund policy.");
  const lookup = panel.getByRole("button", { name: "Expand tool call lookup_order" });
  const secondReply = panel.getByText("Your order qualifies. I'm issuing your $249 refund now.");
  const refund = panel.getByRole("button", { name: "Expand tool call issue_refund" });
  await expect(refund).toBeVisible();
  const [a, b, c, d] = await tops([firstReply, lookup, secondReply, refund]);
  expect(a).toBeLessThan(b);
  expect(b).toBeLessThan(c);
  expect(c).toBeLessThan(d);
  await testInfo.attach("overview-causal-order", { body: await page.screenshot({ animations: "disabled" }), contentType: "image/png" });
});

test("span tree: an instant failure at the end of the trace keeps a visible bar inside its track", async ({ page, runPhantom }) => {
  await seedLedgerRun(runPhantom.url);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${runPhantom.url}/runs/${LEDGER_TRACE}/spans`);
  const failed = page.locator(`[data-span-row="${ledgerSpan(6)}"] [data-trace-bar]`);
  await expect(failed).toBeVisible();
  const { inside, width } = await insideTrack(failed);
  expect(inside, "failed bar inside the track").toBe(true);
  expect(width).toBeGreaterThanOrEqual(6);
  expect((await insideTrack(page.locator(`[data-span-row="${ledgerSpan(3)}"] [data-trace-bar]`))).inside).toBe(true);
});

test("span tree: a step's name keeps its room and the model chip gives way first", async ({ page, runPhantom }) => {
  await seedLedgerRun(runPhantom.url);
  for (const width of [768, 1440]) {
    await page.setViewportSize({ width, height: 1024 });
    await page.goto(`${runPhantom.url}/runs/${LEDGER_TRACE}/spans`);
    const cell = page.locator(`[data-span-row="${ledgerSpan(1)}"] [data-span-name-cell]`);
    await expect(cell).toBeVisible();
    const layout = await cell.evaluate(element => {
      const name = element.firstElementChild as HTMLElement;
      const chip = element.querySelector<HTMLElement>("[data-span-chip]");
      const chipShown = !!chip && chip.offsetTop < element.clientHeight;
      return { truncated: name.scrollWidth > name.clientWidth + 1, chipShown };
    });
    expect(layout.truncated && layout.chipShown, `at ${width}px the name is cut while the chip is shown`).toBe(false);
  }
});

for (const viewport of [{ width: 768, height: 1024 }, { width: 390, height: 844 }]) {
  test(`overview trajectory: the failed step is in view at ${viewport.width}px`, async ({ page, runPhantom }, testInfo) => {
    await seedLedgerRun(runPhantom.url);
    await page.setViewportSize(viewport);
    await page.goto(`${runPhantom.url}/runs/${LEDGER_TRACE}`);
    const timeline = page.locator("[data-trace-timeline]");
    const axis = timeline.getByRole("region", { name: "Trace time axis", exact: true });
    const marker = timeline.locator(`[data-timeline-span-id="${ledgerSpan(6)}"]`);
    await expect(marker).toBeVisible();
    const axisHandle = await axis.elementHandle();
    await expect.poll(() => marker.evaluate((element, axisEl) => {
      const box = element.getBoundingClientRect(), view = (axisEl as HTMLElement).getBoundingClientRect();
      return box.left >= view.left - 0.5 && box.right <= view.right + 0.5 && box.top >= view.top - 0.5 && box.bottom <= view.bottom + 0.5;
    }, axisHandle)).toBe(true);
    if (await axis.evaluate(element => element.scrollWidth > element.clientWidth)) {
      await expect(timeline.locator("[data-timeline-overflow]").first()).toBeAttached();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    await testInfo.attach(`trajectory-${viewport.width}`, { body: await timeline.screenshot({ animations: "disabled" }), contentType: "image/png" });
  });
}

test("nested hand-offs: each sub-agent is a card inside its parent and no sub-agent prompt is the user's message", async ({ page, runPhantom }, testInfo) => {
  await seedNestedRun(runPhantom.url);
  await page.setViewportSize({ width: 1440, height: 900 });

  for (const route of ["", "/convo"]) {
    await page.goto(`${runPhantom.url}/runs/${NESTED_TRACE}${route}`);
    const panel = page.getByRole("tabpanel");
    await expect(panel.getByText("Draft the 2.4.0 release notes.", { exact: true })).toBeVisible();
    await expect(panel.getByText("Outline the 2.4.0 notes.", { exact: true })).toHaveCount(0);
    await expect(panel.getByText("Read CHANGELOG.md.", { exact: true })).toHaveCount(0);

    const planner = panel.getByRole("button", { name: /^agent\s*planner/ });
    await expect(planner).toContainText("failed");
    await expect(planner).toContainText("1 tool");
    await expect(panel.getByRole("button", { name: /^agent\s*reader/ })).toHaveCount(0);
    await planner.click();
    const plannerBody = panel.getByRole("region", { name: "planner sub-agent details" });
    await expect(plannerBody.getByText("Prompt from parent agent").first()).toBeVisible();
    await expect(plannerBody.getByText("Outline the 2.4.0 notes.", { exact: true })).toBeVisible();
    await plannerBody.getByRole("button", { name: /^agent\s*reader/ }).click();
    const readerBody = plannerBody.getByRole("region", { name: "reader sub-agent details" });
    await expect(readerBody.getByText("Read CHANGELOG.md.", { exact: true })).toBeVisible();
    await expect(readerBody.getByRole("button", { name: "Expand tool call open_file" })).toBeVisible();
    await expect(readerBody).toContainText(/1 LLM call · 1 tool/);
    await testInfo.attach(`nested-cards${route || "-overview"}`, { body: await page.screenshot({ animations: "disabled" }), contentType: "image/png" });
  }
});
