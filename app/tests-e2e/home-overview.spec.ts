import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

interface OverviewBody {
  kpis: {
    runs: { value: number | null };
    failed: { value: number | null };
    completedWithErrors: { value: number | null };
    errorRate: { value: number | null };
    inputTokens: { value: number | null };
    outputTokens: { value: number | null };
  };
  recentFailures: Array<{ runId: string; error: { spanId: string } | null }>;
  byAgent: Array<{ agent: string | null; runs: number }>;
}

async function replaySamples(url: string): Promise<void> {
  const response = await fetch(`${url}/api/demo-traces/replay`, { method: "POST" });
  expect(response.ok).toBe(true);
  await waitForFinishedSamples(url);
}

async function waitForFinishedSamples(url: string): Promise<void> {
  await expect.poll(async () => {
    const response = await fetch(`${url}/api/runs`);
    const runs = await response.json() as Array<{ id: string; finished?: number | null }>;
    return runs.filter(run => run.id.startsWith("demo_") && run.finished === 1).length;
  }, { timeout: 30_000 }).toBe(3);
}

async function readOverview(url: string, window = "24h"): Promise<OverviewBody> {
  const response = await fetch(`${url}/api/overview?window=${window}`);
  expect(response.ok).toBe(true);
  return await response.json() as OverviewBody;
}

function kpi(page: Page, id: string) {
  return page.locator(`[data-kpi="${id}"]`);
}

test("Home: an empty workspace teaches setup and fills in after loading sample runs", async ({ page, runPhantom }) => {
  await page.goto(runPhantom.url);

  const setup = page.getByRole("region", { name: "Your first run will appear here." });
  await expect(setup).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("[data-otlp-snippet]")).toContainText(`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:${runPhantom.port}/v1/traces`);
  await expect(page.locator("[data-home-ghost]")).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByText("Waiting for your first run…")).toBeVisible();

  await setup.getByRole("button", { name: "Load sample runs" }).click();
  await waitForFinishedSamples(runPhantom.url);

  await expect(page.locator("[data-home-dashboard]")).toBeVisible({ timeout: 15_000 });
  await expect(setup).toHaveCount(0);
  await expect(kpi(page, "runs").locator("[data-kpi-value]")).toHaveText("3", { timeout: 15_000 });
  await expect(page.locator("[data-home-headline]")).toContainText("3 runs in the last 24 hours.");
});

test("Home: KPIs, headline and tables match /api/overview", async ({ page, runPhantom }) => {
  await replaySamples(runPhantom.url);
  const overview = await readOverview(runPhantom.url);
  const runs = overview.kpis.runs.value!;
  expect(runs).toBe(3);

  await page.goto(runPhantom.url);
  await expect(page.getByRole("link", { name: "Home", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(kpi(page, "runs").locator("[data-kpi-value]")).toHaveText(String(runs), { timeout: 15_000 });
  const rate = overview.kpis.errorRate.value!;
  await expect(kpi(page, "error-rate").locator("[data-kpi-value]")).toHaveText(String(Math.round(rate * 100)));
  await expect(kpi(page, "error-rate")).toContainText(`${overview.kpis.failed.value} failed · ${overview.kpis.completedWithErrors.value} with errors`);
  const tokens = (overview.kpis.inputTokens.value ?? 0) + (overview.kpis.outputTokens.value ?? 0);
  await expect(kpi(page, "tokens").locator("[data-kpi-value]")).toHaveText(tokens < 10_000 ? tokens.toLocaleString("en-US") : String(Math.round(tokens / 100) / 10));
  await expect(kpi(page, "cost")).toContainText("Est. cost");

  await expect(page.locator("[data-home-headline]")).toContainText(`${runs} runs in the last 24 hours.`);

  const agents = page.getByRole("table", { name: /^Agents in the last 24 hours/ });
  await expect(agents.getByRole("row")).toHaveCount(overview.byAgent.length + 1);
  for (const agent of overview.byAgent) await expect(agents.getByRole("link", { name: agent.agent!, exact: true })).toBeVisible();

  const chart = page.locator('[data-home-panel="runs-over-time"]');
  const plot = chart.getByRole("group", { name: new RegExp(`^Runs per hour in the last 24 hours: ${runs} in total`) });
  await expect(plot).toBeVisible();
  await expect(plot).toHaveAttribute("aria-roledescription", "chart");
  await expect(chart.getByRole("img")).toHaveCount(0);
  await chart.getByRole("button", { name: "View as table" }).click();
  await expect(chart.getByRole("table", { name: "Runs per hour" })).toBeVisible();
  await chart.getByRole("button", { name: "View as chart" }).click();
  await expect(plot).toBeVisible();
});

test("Home: the runs chart reads each bar aloud from the keyboard and Enter opens its runs", async ({ page, runPhantom }) => {
  await replaySamples(runPhantom.url);
  const { timeseries } = await (await fetch(`${runPhantom.url}/api/overview?window=24h`)).json() as { timeseries: Array<{ runs: number }> };
  const busiest = timeseries.map(bucket => bucket.runs).lastIndexOf(Math.max(...timeseries.map(bucket => bucket.runs)));
  await page.goto(runPhantom.url);
  const plot = page.locator('[data-home-panel="runs-over-time"]').getByRole("group", { name: /^Runs per hour/ });
  await expect(plot).toBeVisible({ timeout: 15_000 });
  await plot.focus();
  await page.keyboard.press("End");
  for (let step = timeseries.length - 1; step > busiest; step--) await page.keyboard.press("ArrowLeft");
  const readout = plot.locator("[data-chart-readout]");
  await expect(readout).toHaveAttribute("aria-live", "polite");
  await expect(readout).toContainText(/^\d{2}:\d{2}–\d{2}:\d{2}: No errors \d+, With errors \d+, Failed \d+\./);
  await expect(readout).toContainText("Press Enter to open these runs.");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/runs\?since=\d+&until=\d+$/);
});

test("Home: running runs lead the activity list and nothing flashes on first load", async ({ page, runPhantom }) => {
  await replaySamples(runPhantom.url);
  await page.goto(runPhantom.url);
  const activity = page.locator('[data-home-panel="home-activity"]');
  await expect(activity.locator("[data-activity-run]")).toHaveCount(3, { timeout: 15_000 });
  await expect(activity.locator("li.rp-flash")).toHaveCount(0);
  await expect(activity).toContainText("Nothing running");
});

test("Home: the window selector is kept in the URL and drives the numbers", async ({ page, runPhantom }) => {
  await replaySamples(runPhantom.url);
  await page.goto(runPhantom.url);
  await expect(kpi(page, "runs").locator("[data-kpi-value]")).toHaveText("3", { timeout: 15_000 });

  const windows = page.getByRole("group", { name: "Time window" });
  await expect(windows.getByRole("button", { name: "Last 24 hours" })).toHaveAttribute("aria-pressed", "true");
  const request = page.waitForRequest(request => request.url().includes("/api/overview?window=7d"));
  await windows.getByRole("button", { name: "Last 7 days" }).click();
  await request;
  await expect(page).toHaveURL(/\/\?window=7d$/);
  await expect(windows.getByRole("button", { name: "Last 7 days" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Overview / Last 7 days")).toBeVisible();
  await expect(page.locator("[data-home-headline]")).toContainText("3 runs in the last 7 days.");
  await expect(page.locator('[data-home-panel="runs-over-time"]').getByRole("heading")).toHaveText("Runs per 6 hours");

  await page.reload();
  await expect(windows.getByRole("button", { name: "Last 7 days" })).toHaveAttribute("aria-pressed", "true");

  await page.locator("[data-command-palette-trigger]").click();
  const palette = page.locator("[data-command-palette]");
  await palette.getByRole("combobox", { name: "Search runs, steps, commands" }).fill("show last hour");
  await palette.getByRole("option", { name: /Show last hour/ }).click();
  await expect(page).toHaveURL(/\/\?window=1h$/);
  await expect(page.locator("[data-home-headline]")).toContainText("in the last hour.");
});

test("Home: tiles, failures and agents deep-link into Runs with filters", async ({ page, runPhantom }) => {
  await replaySamples(runPhantom.url);
  const overview = await readOverview(runPhantom.url);
  const failure = overview.recentFailures.find(item => item.runId === "demo_review");
  expect(failure?.error).not.toBeNull();

  await page.goto(runPhantom.url);
  await page.locator(`[data-needs-a-look="demo_review"]`).click();
  await expect(page).toHaveURL(new RegExp(`/runs/demo_review/span/${failure!.error!.spanId}$`));

  await page.goto(runPhantom.url);
  await kpi(page, "error-rate").getByRole("link").click();
  await expect(page).toHaveURL(/\/runs\?status=failed%2Ccompleted_with_errors&window=24h$/);

  await page.goto(runPhantom.url);
  await page.getByRole("table", { name: /^Agents in the last 24 hours/ }).getByRole("link", { name: "code_review_agent", exact: true }).click();
  await expect(page).toHaveURL(/\/runs\?agent=code_review_agent&window=24h$/);

  await page.goto(`${runPhantom.url}/runs`);
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("g");
  await page.keyboard.press("h");
  await expect(page).toHaveURL(new RegExp(`${runPhantom.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?$`));
  await expect(page.locator("[data-home-dashboard]")).toBeVisible();
});
