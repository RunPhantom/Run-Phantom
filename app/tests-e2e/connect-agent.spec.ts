import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function modKey(page: Page): Promise<"Meta" | "Control"> {
  return await page.evaluate(() => {
    const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
    return /mac|iphone|ipad|ipod/i.test(platform);
  }) ? "Meta" : "Control";
}

async function runNames(url: string): Promise<string[]> {
  const response = await fetch(`${url}/api/runs`);
  return (await response.json() as Array<{ name: string | null }>).map(run => run.name ?? "");
}

test("the sidebar opens the connect guide with this service's real endpoint and commands", async ({ page, context, runPhantom }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: runPhantom.url });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${runPhantom.url}/runs`);
  await expect(page.getByRole("heading", { name: "No runs captured yet.", exact: true })).toBeVisible({ timeout: 10_000 });

  await page.getByRole("link", { name: "Connect an agent", exact: true }).click();
  await expect(page).toHaveURL(/\/connect$/);
  await expect(page.getByRole("heading", { name: "Connect an agent", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Workspace breadcrumb" })).toContainText("Connect an agent");

  const endpoint = `http://127.0.0.1:${runPhantom.port}/v1/traces`;
  await expect(page.locator("[data-otlp-snippet]")).toHaveText(`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${endpoint}`);
  await expect(page.locator("[data-connect-example]")).toContainText("--provider openai --model gpt-5-nano");

  const tabs = page.getByRole("tablist", { name: "Ways to connect" });
  await tabs.getByRole("tab", { name: "curl", exact: true }).click();
  await expect(page).toHaveURL(/\?tab=curl$/);
  await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", await tabs.getByRole("tab", { name: "curl", exact: true }).getAttribute("id") ?? "");
  await expect(page.locator("[data-connect-curl]")).toContainText(`curl -sS -X POST ${endpoint}`);
  await page.getByRole("button", { name: "Copy curl command", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy curl command", exact: true })).toContainText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`curl -sS -X POST ${endpoint}`);

  await tabs.getByRole("tab", { name: "curl", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "Coding agents", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(tabs.getByRole("tab", { name: "Coding agents", exact: true })).toBeFocused();
  const panel = page.getByRole("tabpanel");
  await expect(panel).toContainText(`RUNPHANTOM_PORT=${runPhantom.port} bun x runphantom-dev hooks install claude`);
  await expect(panel).toContainText(`hooks install codex`);
  await expect(panel).toContainText(`--port ${runPhantom.port}`);
  await expect(panel).toContainText(`RUNPHANTOM_PORT=${runPhantom.port} bun x runphantom-dev setup --global`);
  await expect(panel).toContainText("/instrument-agent");

  await page.reload();
  await expect(tabs.getByRole("tab", { name: "Coding agents", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("a test span goes through the OTLP route and arrives live as a run", async ({ page, runPhantom }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${runPhantom.url}/connect`);
  const check = page.getByRole("complementary", { name: "Check the connection" });
  await expect(check.getByText("Listening for new runs…")).toBeVisible({ timeout: 10_000 });
  const ingest = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/v1/traces");

  await check.getByRole("button", { name: "Send a test span" }).click();
  const request = await ingest;
  const traceId = (request.postDataJSON() as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ traceId: string }> }> }> }).resourceSpans[0].scopeSpans[0].spans[0].traceId;

  const result = check.locator("[data-test-span-result]");
  await expect(result).toHaveAttribute("data-test-span-result", "arrived", { timeout: 10_000 });
  await expect(result).toContainText(/Test span stored and shown live after \d+\sms\./);
  await expect.poll(() => runNames(runPhantom.url)).toContain("Connection test");

  await result.getByRole("link", { name: "Open the test run" }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${traceId}$`));
  await expect(page.getByText("Connection test").first()).toBeVisible();
});

test("the empty Runs page teaches with a labelled sample and fills in when a test span arrives", async ({ page, runPhantom }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${runPhantom.url}/runs`);
  const card = page.getByRole("region", { name: "No runs captured yet." });
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("[data-empty-ghost]")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("[data-empty-ghost]")).toContainText("Sample · not your data");
  await expect(card.getByText("Waiting for your first run…")).toBeVisible();
  await expect(card.locator("[data-otlp-snippet]")).toContainText(`http://127.0.0.1:${runPhantom.port}/v1/traces`);

  await card.getByRole("button", { name: "Send a test span" }).click();
  await expect(page.getByRole("grid", { name: "Runs" }).locator("[data-run-id]")).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByRole("grid", { name: "Runs" })).toContainText("Connection test");
  await expect(card).toHaveCount(0);
});

test("the command palette offers Connect an agent", async ({ page, runPhantom }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${runPhantom.url}/runs`);
  await expect(page.getByRole("heading", { name: "No runs captured yet.", exact: true })).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press(`${await modKey(page)}+k`);
  const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
  await palette.getByRole("combobox").fill("connect");
  await page.getByRole("option", { name: /Connect an agent/ }).click();
  await expect(page).toHaveURL(/\/connect$/);
  await expect(page.getByRole("heading", { name: "Connect an agent", level: 1 })).toBeVisible();
});

test("the connect guide fits a phone without sideways scrolling and keeps 44px targets", async ({ browser, runPhantom }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await page.goto(`${runPhantom.url}/connect?tab=opentelemetry`);
    await expect(page.locator("[data-connect-env]")).toContainText("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf", { timeout: 10_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0);
    for (const control of [
      page.getByRole("tab", { name: "OpenTelemetry", exact: true }),
      page.getByRole("button", { name: "Copy OpenTelemetry variables" }),
      page.getByRole("button", { name: "Send a test span" }),
      page.getByRole("button", { name: "Load sample runs" }),
    ]) {
      const box = (await control.boundingBox())!;
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
    }
  } finally {
    await context.close();
  }
});

test("an empty Playground history shows a sample and returns to the prompt", async ({ page, runPhantom }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${runPhantom.url}/playground`);
  await page.getByRole("button", { name: "History" }).click();
  const dialog = page.getByRole("dialog", { name: "Recent Playground runs" });
  const empty = dialog.getByRole("region", { name: "No Playground runs yet" });
  await expect(empty).toBeVisible({ timeout: 10_000 });
  await expect(dialog.locator("[data-empty-ghost]")).toHaveAttribute("aria-hidden", "true");
  await empty.getByRole("button", { name: "Write a prompt" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("[data-playground-message] textarea").first()).toBeFocused();
});

test("loading sample runs from the connect guide links to the first one", async ({ page, runPhantom }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${runPhantom.url}/connect`);
  const check = page.getByRole("complementary", { name: "Check the connection" });
  await check.getByRole("button", { name: "Load sample runs" }).click();
  const link = check.getByRole("link", { name: "Open the first one" });
  await expect(link).toBeVisible({ timeout: 15_000 });
  await expect(check).toContainText("Loaded 3 sample runs.");
  await link.click();
  await expect(page).toHaveURL(/\/runs\/demo_/);
});
