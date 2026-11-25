import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const HOUR = 3_600_000;
const spanHex = (slot: number) => slot.toString(16).padStart(16, "0");

interface FixtureRun {
  id: string;
  agent: string;
  input: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  failed?: boolean;
  startedAgoMs: number;
}

/** One finished agent run with one priced gpt-4o-mini call, exported as OTLP JSON like a real GenAI exporter. */
async function postRun(url: string, run: FixtureRun): Promise<void> {
  const start = Date.now() - run.startedAgoMs;
  const nanos = (ms: number) => String(BigInt(Math.round(ms)) * 1_000_000n);
  const text = (key: string, value: string) => ({ key, value: { stringValue: value } });
  const int = (key: string, value: number) => ({ key, value: { intValue: String(value) } });
  const root = {
    traceId: run.id, spanId: spanHex(1), name: run.agent, startTimeUnixNano: nanos(start), endTimeUnixNano: nanos(start + run.durationMs),
    status: { code: run.failed ? 2 : 1, ...(run.failed ? { message: "Agent stopped" } : {}) },
    attributes: [text("gen_ai.operation.name", "invoke_agent"), text("gen_ai.agent.name", run.agent), text("ai.telemetry.metadata.runphantom.eventName", run.agent)],
  };
  const call = {
    traceId: run.id, spanId: spanHex(2), parentSpanId: spanHex(1), name: "chat gpt-4o-mini",
    startTimeUnixNano: nanos(start + 10), endTimeUnixNano: nanos(start + run.durationMs - 10), status: { code: 1 },
    attributes: [text("gen_ai.operation.name", "chat"), text("gen_ai.provider.name", "openai"), text("gen_ai.request.model", "gpt-4o-mini"),
      text("gen_ai.response.model", "gpt-4o-mini"), int("gen_ai.usage.input_tokens", run.inputTokens), int("gen_ai.usage.output_tokens", run.outputTokens),
      text("gen_ai.input.messages", JSON.stringify([{ role: "user", parts: [{ type: "text", content: run.input }] }]))],
  };
  const response = await fetch(`${url}/v1/traces`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [root, call] }] }] }) });
  expect(response.ok, `POST /v1/traces -> ${response.status}`).toBe(true);
}

const CHEAP = "a1000000000000000000000000000001";
const PRICEY = "a1000000000000000000000000000002";
const BROKEN = "a1000000000000000000000000000003";

async function seedThree(url: string): Promise<void> {
  await postRun(url, { id: CHEAP, agent: "billing_agent", input: "Summarise invoice 17", inputTokens: 100, outputTokens: 10, durationMs: 800, startedAgoMs: 3 * HOUR });
  await postRun(url, { id: PRICEY, agent: "research_agent", input: "Compare three vendors in depth", inputTokens: 90_000, outputTokens: 4_000, durationMs: 9_000, startedAgoMs: 2 * HOUR });
  await postRun(url, { id: BROKEN, agent: "billing_agent", input: "Refund order A1005", inputTokens: 2_000, outputTokens: 200, durationMs: 2_500, failed: true, startedAgoMs: HOUR });
}

const rows = (page: Page) => page.locator("[role=grid] [data-run-id]");
const rowIds = (page: Page) => rows(page).evaluateAll(elements => elements.map(element => element.getAttribute("data-run-id")));

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("runs table sorts on the server and keeps the sort in the URL", async ({ page, runPhantom }) => {
  await seedThree(runPhantom.url);
  await page.goto(`${runPhantom.url}/runs`);
  await expect(rows(page)).toHaveCount(3);
  await expect.poll(() => rowIds(page)).toEqual([BROKEN, PRICEY, CHEAP]);
  await expect(page.getByRole("columnheader", { name: "Agent", exact: true })).toBeVisible();
  const cheapCells = page.locator(`[data-run-id="${CHEAP}"]`).getByRole("gridcell");
  await expect(cheapCells.nth(3)).toHaveText("billing_agent");
  await expect(cheapCells.nth(9)).toContainText("—");
  await expect(page.locator(`[data-run-id="${BROKEN}"]`).getByRole("gridcell").nth(9)).toHaveText("1");

  const cost = page.getByRole("button", { name: /^Sort by cost/ });
  await cost.click();
  await expect(page).toHaveURL(/[?&]sort=cost(?:&|$)/);
  await expect(page.getByRole("columnheader", { name: /cost/i })).toHaveAttribute("aria-sort", "descending");
  await expect.poll(() => rowIds(page)).toEqual([PRICEY, BROKEN, CHEAP]);

  await cost.click();
  await expect(page).toHaveURL(/order=asc/);
  await expect.poll(() => rowIds(page)).toEqual([CHEAP, BROKEN, PRICEY]);

  const priceyCost = rows(page).filter({ has: page.locator(`[data-run-name]`, { hasText: "research_agent" }) });
  await expect(priceyCost).toContainText("est.");
  await page.reload();
  await expect.poll(() => rowIds(page)).toEqual([CHEAP, BROKEN, PRICEY]);
});

test("runs filters live in the URL, survive a reload and clear in one step", async ({ page, runPhantom }) => {
  await seedThree(runPhantom.url);
  await page.goto(`${runPhantom.url}/runs?status=failed`);
  await expect.poll(() => rowIds(page)).toEqual([BROKEN]);
  await expect(page.getByRole("button", { name: "Failed", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(`[data-run-id="${BROKEN}"] [data-run-list-status]`)).toHaveAttribute("data-run-list-status", "failed");

  await page.getByRole("button", { name: "Failed", exact: true }).click();
  await page.getByRole("combobox", { name: "Agent" }).selectOption("billing_agent");
  await expect(page).toHaveURL(/agent=billing_agent/);
  await expect.poll(() => rowIds(page)).toEqual([BROKEN, CHEAP]);

  await page.getByRole("textbox", { name: "Search runs", exact: true }).fill("invoice");
  await expect(page).toHaveURL(/q=invoice/);
  await expect.poll(() => rowIds(page)).toEqual([CHEAP]);

  await page.reload();
  await expect(page.getByRole("textbox", { name: "Search runs", exact: true })).toHaveValue("invoice");
  await expect(page.getByRole("combobox", { name: "Agent" })).toHaveValue("billing_agent");
  await expect.poll(() => rowIds(page)).toEqual([CHEAP]);

  await page.getByRole("textbox", { name: "Search runs", exact: true }).fill("no-such-run-anywhere");
  await expect(page.getByText("No matching runs").first()).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).first().click();
  await expect(page).toHaveURL(new RegExp(`${runPhantom.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/runs$`));
  await expect(rows(page)).toHaveCount(3);
});

test("saved views keep filters and columns, list in the sidebar with a live count, rename and delete", async ({ page, runPhantom }) => {
  await seedThree(runPhantom.url);
  await page.goto(`${runPhantom.url}/runs?agent=billing_agent`);
  await expect(rows(page)).toHaveCount(2);

  await page.getByRole("button", { name: "Columns" }).click();
  await page.getByRole("checkbox", { name: "Input" }).uncheck();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("columnheader", { name: "Input" })).toHaveCount(0);

  await page.getByRole("button", { name: "Save view" }).click();
  const save = page.getByRole("dialog", { name: "Save view" });
  await save.getByRole("textbox", { name: "View name" }).fill("Billing runs");
  await save.getByRole("button", { name: "Save view" }).click();
  await expect(save).toHaveCount(0);
  await expect(page).toHaveURL(/view=/);

  const navigation = page.getByRole("navigation", { name: "Primary navigation" });
  const link = navigation.getByRole("link", { name: "Billing runs", exact: true });
  await expect(link).toHaveAccessibleDescription("2 matching runs");

  await postRun(runPhantom.url, { id: "a1000000000000000000000000000004", agent: "billing_agent", input: "Late fee", inputTokens: 10, outputTokens: 2, durationMs: 300, startedAgoMs: 1000 });
  await expect(link).toHaveAccessibleDescription("3 matching runs", { timeout: 15_000 });

  await page.goto(`${runPhantom.url}/runs`);
  await page.getByRole("button", { name: "Columns" }).click();
  await page.getByRole("checkbox", { name: "Input" }).check();
  await page.keyboard.press("Escape");
  await link.click();
  await expect(page).toHaveURL(/agent=billing_agent/);
  await expect(link).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Billing runs", level: 1 })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Input" })).toHaveCount(0);

  await page.getByRole("button", { name: "Rename" }).click();
  const rename = page.getByRole("dialog", { name: "Rename view" });
  await rename.getByRole("textbox", { name: "View name" }).fill("Billing");
  await rename.getByRole("button", { name: "Rename" }).click();
  await expect(navigation.getByRole("link", { name: "Billing", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Delete view" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete the view Billing?" });
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Delete view" }).click();
  await expect(navigation.getByRole("link", { name: "Billing", exact: true })).toHaveCount(0);
  await expect(page).not.toHaveURL(/view=/);
  expect(await (await fetch(`${runPhantom.url}/api/saved-views`)).json()).toEqual({ views: [] });
});

test("keyboard selection drives bulk compare through the run comparison", async ({ page, runPhantom }) => {
  await seedThree(runPhantom.url);
  await page.goto(`${runPhantom.url}/runs`);
  await expect(rows(page)).toHaveCount(3);
  await page.getByRole("grid", { name: "Runs" }).focus();
  await page.keyboard.press("x");
  await page.keyboard.press("j");
  await page.keyboard.press("x");
  const bar = page.getByRole("region", { name: "Selected runs" });
  await expect(bar).toContainText("2 runs selected");
  await expect(rows(page).nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(rows(page).nth(1)).toHaveAttribute("aria-selected", "true");

  await bar.getByRole("button", { name: "Compare" }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${BROKEN}\\?compare=${PRICEY}`));
  await expect(page.getByText("Comparing with baseline", { exact: false })).toBeVisible();
  await expect(page.locator("[data-comparison-count='changed']")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Stop comparing" }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${BROKEN}$`));
});

test("bulk delete asks in an accessible dialog and removes only the chosen runs", async ({ page, runPhantom }) => {
  await seedThree(runPhantom.url);
  await page.goto(`${runPhantom.url}/runs`);
  await expect(rows(page)).toHaveCount(3);
  await page.getByRole("checkbox", { name: "Select research_agent" }).check();
  await page.getByRole("region", { name: "Selected runs" }).getByRole("button", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete 1 run?" });
  await expect(confirm).toContainText("research_agent");
  await confirm.getByRole("button", { name: "Delete 1 run" }).click();
  await expect(confirm).toHaveCount(0);
  await expect.poll(() => rowIds(page)).toEqual([BROKEN, CHEAP]);
  const stored = await (await fetch(`${runPhantom.url}/api/runs`)).json() as { id: string }[];
  expect(stored.map(run => run.id).sort()).toEqual([CHEAP, BROKEN].sort());
});

test("bulk export and add to test set use the selected rows", async ({ page, runPhantom }) => {
  await seedThree(runPhantom.url);
  await page.goto(`${runPhantom.url}/runs`);
  await expect(rows(page)).toHaveCount(3);
  await page.getByRole("checkbox", { name: "Select research_agent" }).check();
  await page.getByRole("checkbox", { name: "Select billing_agent" }).first().check();
  const bar = page.getByRole("region", { name: "Selected runs" });

  const download = page.waitForEvent("download");
  await bar.getByRole("button", { name: "Export JSON" }).click();
  const file = await (await download).path();
  const exported = JSON.parse(await readFile(file, "utf8")) as { format: string; runs: { id: string; est_cost_usd: number | null }[] };
  expect(exported.format).toBe("runphantom-runs/v1");
  expect(exported.runs.map(run => run.id).sort()).toEqual([BROKEN, PRICEY].sort());

  await bar.getByRole("button", { name: "Add to test set" }).click();
  const dialog = page.getByRole("dialog", { name: "Add 2 runs to a test set" });
  await dialog.getByRole("textbox", { name: "New test set name" }).fill("Regression picks");
  await dialog.getByRole("button", { name: "Add 2 runs" }).click();
  await expect(dialog.getByText("Added 2 runs to Regression picks.")).toBeVisible();
  const datasets = await (await fetch(`${runPhantom.url}/api/evaluations/datasets`)).json() as { name: string; caseCount: number }[];
  expect(datasets).toEqual([expect.objectContaining({ name: "Regression picks", caseCount: 2 })]);
});

test("live tail streams new runs in, pauses while rows are selected and resumes from the pill", async ({ page, runPhantom }) => {
  await seedThree(runPhantom.url);
  await page.goto(`${runPhantom.url}/runs`);
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByText("Live", { exact: true })).toBeVisible();

  const first = "a1000000000000000000000000000010";
  await postRun(runPhantom.url, { id: first, agent: "triage_agent", input: "New ticket", inputTokens: 50, outputTokens: 5, durationMs: 400, startedAgoMs: 100 });
  await expect.poll(() => rowIds(page), { timeout: 10_000 }).toEqual([first, BROKEN, PRICEY, CHEAP]);

  await page.getByRole("checkbox", { name: "Select billing_agent" }).first().check();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  const second = "a1000000000000000000000000000011";
  await postRun(runPhantom.url, { id: second, agent: "triage_agent", input: "Another ticket", inputTokens: 50, outputTokens: 5, durationMs: 400, startedAgoMs: 50 });
  const pill = page.getByRole("button", { name: "1 new run", exact: true });
  await expect(pill).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(`[data-run-id="${second}"]`)).toHaveCount(0);

  await pill.click();
  await expect.poll(() => rowIds(page), { timeout: 10_000 }).toEqual([second, first, BROKEN, PRICEY, CHEAP]);
  await expect(page.getByRole("region", { name: "Selected runs" })).toHaveCount(0);
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
});

test("opening a run keeps a collapsible run rail with the table's filters", async ({ page, runPhantom }) => {
  await seedThree(runPhantom.url);
  await page.goto(`${runPhantom.url}/runs?agent=billing_agent`);
  await expect(rows(page)).toHaveCount(2);
  await rows(page).first().click();
  await expect(page).toHaveURL(new RegExp(`/runs/${BROKEN}$`));
  const rail = page.getByRole("navigation", { name: "Run list" });
  await expect(rail.locator("[data-run-id]")).toHaveCount(2);
  await expect(page.locator(`[data-run-id="${BROKEN}"]`)).toHaveCount(1);
  await rail.getByRole("button", { name: "Hide run list" }).click();
  await expect(rail).toHaveCount(0);
  await page.getByRole("button", { name: "Show run list" }).click();
  await expect(page.getByRole("navigation", { name: "Run list" }).getByRole("link", { name: "2 matching runs" })).toBeVisible();
  await page.getByRole("navigation", { name: "Run list" }).getByRole("link", { name: "2 matching runs" }).click();
  await expect(page).toHaveURL(/\/runs\?agent=billing_agent$/);
});

test("mobile shows run cards instead of the table", async ({ page, runPhantom }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedThree(runPhantom.url);
  await page.goto(`${runPhantom.url}/runs`);
  const cards = page.getByRole("list", { name: "Runs" }).locator("[data-run-id]");
  await expect(cards).toHaveCount(3);
  await expect(page.getByRole("grid")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await cards.first().getByRole("button").click();
  await expect(page).toHaveURL(new RegExp(`/runs/${BROKEN}$`));
  await expect(page.getByRole("button", { name: "Back to runs" })).toBeVisible();
});
