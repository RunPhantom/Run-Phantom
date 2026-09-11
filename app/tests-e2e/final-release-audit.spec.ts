import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  clearRunPhantom,
  FIXTURE_LIVE_RUN_ID,
  FIXTURE_PRIMARY_RUN_ID,
  listRunPhantomRuns,
  seedRunPhantomFixtures,
} from "./helpers";

function monitorLocalRuntimeIssues(page: Page): string[] {
  const issues: string[] = [];

  page.on("pageerror", (error) => issues.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      issues.push(`console ${message.type()}: ${message.text()}`);
    }
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      issues.push(`request failed: ${request.method()} ${url.pathname} (${request.failure()?.errorText ?? "unknown"})`);
    }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      url.pathname.startsWith("/api/") &&
      response.status() >= 400
    ) {
      issues.push(`http ${response.status()}: ${response.request().method()} ${url.pathname}`);
    }
  });

  return issues;
}

test.beforeEach(async ({ page, runPhantom }) => {
  await clearRunPhantom(runPhantom.url);
  await page.route("https://openrouter.ai/**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: [] }),
  }));
});

test("release audit: visible save and delete stay local and error-free", async ({ page, runPhantom }) => {
  const issues = monitorLocalRuntimeIssues(page);
  await seedRunPhantomFixtures(runPhantom.url);

  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  const saveButton = page.getByRole("button", { name: /^save$/i });
  await expect(saveButton).toBeVisible({ timeout: 10_000 });
  await saveButton.click();
  await expect(page.getByRole("button", { name: /^saved$/i })).toBeVisible({ timeout: 5_000 });

  await expect.poll(async () => {
    const response = await fetch(`${runPhantom.url}/api/saved-runs`);
    const body = await response.json() as { events?: Array<{ id?: string }> };
    return body.events?.some((event) => event.id === FIXTURE_PRIMARY_RUN_ID) ?? false;
  }).toBe(true);

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "More actions" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("menuitem", { name: "Delete run" }).click();

  await expect(page.locator(`[data-run-id="${FIXTURE_PRIMARY_RUN_ID}"]`)).toHaveCount(0, { timeout: 5_000 });
  await expect.poll(async () => (await listRunPhantomRuns(runPhantom.url)).length).toBe(2);
  expect(issues).toEqual([]);
});

test("release audit: status is explicit without relying on color", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  const liveResponse = await fetch(`${runPhantom.url}/v1/live`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      traceId: FIXTURE_LIVE_RUN_ID,
      type: "message",
      content: "Still working",
      timestamp: Date.now(),
    }),
  });
  expect(liveResponse.ok).toBe(true);

  await page.goto(`${runPhantom.url}/runs/${FIXTURE_LIVE_RUN_ID}`);
  const liveRow = page.locator(`[data-run-id="${FIXTURE_LIVE_RUN_ID}"]`);
  await expect(liveRow.getByText("Run live", { exact: true })).toBeAttached();
  await expect(page.getByText("Run live", { exact: true }).last()).toBeVisible();

  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  await expect(page.getByText("Run complete", { exact: true }).last()).toBeVisible();
});
