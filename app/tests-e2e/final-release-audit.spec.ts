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

test("release audit: run detail is usable at a 390px viewport", async ({ page, runPhantom }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedRunPhantomFixtures(runPhantom.url);

  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  await expect(page.getByRole("button", { name: "Back to runs" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByPlaceholder("Search runs...")).toBeHidden();
  await expect(page.getByText("Fix the typo in README.md", { exact: true })).toBeVisible();

  const sidebarToggleBox = await page.getByRole("button", { name: "Toggle Sidebar" }).boundingBox();
  const backLabelBox = await page.getByText("Back to runs", { exact: true }).boundingBox();
  expect(sidebarToggleBox).not.toBeNull();
  expect(backLabelBox).not.toBeNull();
  expect(backLabelBox!.x).toBeGreaterThanOrEqual(sidebarToggleBox!.x + sidebarToggleBox!.width + 4);

  for (const name of ["Annotate", "Debug", "Download", "Save", "Replay", "More actions"]) {
    const button = page.getByRole("button", { name, exact: true });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box, `${name} should have a rendered box`).not.toBeNull();
    expect(box!.x, `${name} should start inside the viewport`).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, `${name} should end inside the viewport`).toBeLessThanOrEqual(390);
  }

  const widths = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(widths.document).toBe(widths.viewport);
});

test("release audit: mobile route headings clear the sidebar trigger", async ({ page, runPhantom }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedRunPhantomFixtures(runPhantom.url);

  const routes = [
    { path: "/runs", label: "connected", role: "status" as const },
    { path: "/search", label: "Local Search", role: "heading" as const },
    { path: "/saved", label: "Saved Runs", role: "heading" as const },
    { path: "/settings", label: "Settings", role: "heading" as const },
  ];

  for (const route of routes) {
    await page.goto(`${runPhantom.url}${route.path}`);
    const sidebarToggle = page.getByRole("button", { name: "Toggle Sidebar" });
    const routeLabel = route.role === "status"
      ? page.getByRole("status").filter({ hasText: route.label }).first()
      : page.getByRole("heading", { name: route.label, exact: true }).first();
    await expect(routeLabel).toBeVisible({ timeout: 10_000 });

    const sidebarToggleBox = await sidebarToggle.boundingBox();
    const routeLabelBox = await routeLabel.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const rect = range.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    expect(sidebarToggleBox, `${route.path} sidebar trigger should render`).not.toBeNull();
    expect(routeLabelBox.width, `${route.path} label should render`).toBeGreaterThan(0);
    expect(routeLabelBox.x, `${route.path} label should clear the sidebar trigger`).toBeGreaterThanOrEqual(
      sidebarToggleBox!.x + sidebarToggleBox!.width + 4,
    );
  }
});

test("release audit: mobile span inspection uses the full detail width", async ({ page, runPhantom }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedRunPhantomFixtures(runPhantom.url);

  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}/spans`);
  const spanRow = page.locator("[data-span-row]").filter({ hasText: "llm.generate" }).first();
  await expect(spanRow).toBeVisible({ timeout: 10_000 });
  await spanRow.click();

  const backButton = page.getByRole("button", { name: "Back to span list" });
  await expect(backButton).toBeVisible();
  const detailPanel = page.getByRole("region", { name: "Span details" });
  const detailBox = await detailPanel.boundingBox();
  expect(detailBox).not.toBeNull();
  expect(detailBox!.width).toBeGreaterThanOrEqual(350);

  await backButton.click();
  await expect(spanRow).toBeVisible();
});

test("release audit: run navigation arrows stay scoped to the run list", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}/spans`);

  const spanRow = page.locator("[data-span-row]").first();
  await expect(spanRow).toBeVisible({ timeout: 10_000 });
  await spanRow.focus();
  await page.keyboard.press("ArrowDown");

  await expect(page).toHaveURL(new RegExp(`/runs/${FIXTURE_PRIMARY_RUN_ID}/spans`));
  await expect(spanRow).toBeFocused();
});

test("release audit: mobile search uses a list-to-detail flow", async ({ page, runPhantom }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedRunPhantomFixtures(runPhantom.url);

  await page.goto(`${runPhantom.url}/search`);
  const searchField = page.getByPlaceholder("Search by title, event, user, conversation, or id");
  await expect(searchField).toBeVisible({ timeout: 10_000 });
  await page.locator(`[data-run-id="${FIXTURE_PRIMARY_RUN_ID}"]`).click();
  await expect(page.getByRole("button", { name: "Back to search" })).toBeVisible();
  await expect(searchField).toBeHidden();
  await page.getByRole("button", { name: "Back to search" }).click();
  await expect(searchField).toBeVisible();
});
