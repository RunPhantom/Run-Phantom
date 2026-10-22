import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect, connectTarget } from "./verification-fixture";
import { REPO_ROOT_PATH } from "./fixtures";
import { FIXTURE_PRIMARY_RUN_ID, seedRunPhantomFixtures } from "./helpers";
import type { VerificationReport } from "../../src/verification/protocol";

const screenshotDir = path.join(REPO_ROOT_PATH, "output", "verification-workspace");

test("verification workspace: deep links retain real outcomes, filters and responsive keyboard access", async ({ page, context, request, runPhantom, targetApp }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  const app = await context.newPage();
  const uiErrors: string[] = [];
  page.on("pageerror", error => uiErrors.push(error.message));
  page.on("response", response => { if (response.status() >= 400 && response.url().startsWith(runPhantom.url)) uiErrors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  try {
    const session = await connectTarget(app, request, runPhantom, targetApp.origin, FIXTURE_PRIMARY_RUN_ID);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${runPhantom.url}/verification?runId=${FIXTURE_PRIMARY_RUN_ID}&section=checks`);
    const navigation = page.getByRole("navigation", { name: "Verification workspace", exact: true });
    await expect(navigation.getByRole("link", { name: "Check outcomes", exact: true })).toHaveAttribute("aria-current", "location");
    await expect(page.locator("#verification-checks")).toBeFocused();
    await page.getByRole("combobox", { name: "Action", exact: true }).selectOption("click");
    await page.getByLabel(/^Action selector/).fill("#checkout");
    await page.getByRole("combobox", { name: "Check type", exact: true }).selectOption("network");
    await page.getByLabel("Request URL contains", { exact: true }).fill("/api/checkout");
    await page.getByRole("combobox", { name: "Request method", exact: true }).selectOption("POST");
    await page.getByLabel(/^Response status/).fill("200");
    await page.getByLabel("Check name (optional)", { exact: true }).fill("Workspace checkout outcome");
    for (const [broken, outcome] of [[true, "fail"], [false, "pass"]] as const) {
      targetApp.setBroken(broken);
      await page.getByRole("button", { name: "Run action", exact: true }).click();
      await expect(app.locator("#status")).toHaveText(broken ? "failed" : "paid");
      await page.getByRole("button", { name: "Check outcome", exact: true }).click();
      await expect(page.getByRole("article", { name: `Workspace checkout outcome: ${outcome}`, exact: true })).toBeVisible({ timeout: 15_000 });
    }
    await app.evaluate(() => window.runtime.disconnect());
    await expect(page.getByRole("region", { name: "Application session", exact: true }).getByRole("status")).toHaveText("Disconnected");
    await page.getByRole("button", { name: "Check outcome", exact: true }).click();
    await expect(page.getByRole("article", { name: "Workspace checkout outcome: inconclusive", exact: true })).toBeVisible({ timeout: 15_000 });
    const saved = await request.get(`${runPhantom.url}/api/verification/reports?runId=${FIXTURE_PRIMARY_RUN_ID}`);
    expect(saved.ok()).toBe(true);
    const reports = await saved.json() as VerificationReport[];
    expect(reports).toHaveLength(3);
    expect(reports.map(report => report.status).sort()).toEqual(["fail", "inconclusive", "pass"]);
    expect(reports.every(report => report.sessionId === session.id && report.runId === FIXTURE_PRIMARY_RUN_ID)).toBe(true);

    await navigation.getByRole("link", { name: /^Reports/ }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`runId=${FIXTURE_PRIMARY_RUN_ID}.*section=reports`));
    await expect(page.locator("#verification-reports")).toBeFocused();
    await page.getByRole("combobox", { name: "Report status", exact: true }).selectOption("fail");
    await expect(page.getByText("Showing 1 of 3 loaded reports.", { exact: true })).toBeVisible();
    await expect(page.getByRole("article", { name: "Workspace checkout outcome: fail", exact: true })).toBeVisible();
    await expect(page.getByRole("article", { name: "Workspace checkout outcome: pass", exact: true })).toHaveCount(0);
    await page.getByLabel("Search reports", { exact: true }).fill("No matching recorded outcome");
    await expect(page.getByText("Showing 0 of 3 loaded reports.", { exact: true })).toBeVisible();
    await expect(page.getByText(/No loaded reports match these filters/)).toBeVisible();
    await page.getByRole("button", { name: "Reset report filters", exact: true }).click();
    await expect(page.getByText("Showing 3 of 3 loaded reports.", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.locator("#verification-reports")).toBeFocused();
    await expect(page.getByText("Showing 3 of 3 loaded reports.", { exact: true })).toBeVisible();
    mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDir, "reports-desktop.png") });
    await navigation.getByRole("link", { name: "Pair app", exact: true }).click();
    await page.getByRole("heading", { name: "Verification", exact: true }).scrollIntoViewIfNeeded();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.getByRole("heading", { name: "Verification", exact: true }).evaluate(element => getComputedStyle(element).fontFamily)).toContain("Syne");
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--rp-accent").trim())).toBe("#0021CC");
    await page.screenshot({ path: path.join(screenshotDir, "workspace-desktop.png") });
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await navigation.getByRole("link", { name: "Pair app", exact: true }).evaluate(element => Number.parseFloat(getComputedStyle(element).transitionDuration))).toBeLessThanOrEqual(0.00001);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.getByRole("heading", { name: "Verification", exact: true }).scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await expect(page.getByRole("button", { name: "Pair app", exact: true })).toBeVisible();
      await page.screenshot({ path: path.join(screenshotDir, `workspace-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => { document.body.style.zoom = "2"; });
    await navigation.getByRole("link", { name: "Pair app", exact: true }).click();
    await expect(page.getByLabel(/^App origin/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
    await page.screenshot({ path: path.join(screenshotDir, "workspace-200-percent.png") });
    expect(uiErrors).toEqual([]);
  } finally { await app.close(); }
});

test("verification workspace: empty deep links preserve optional tools and never imply a clean check", async ({ page, runPhantom }) => {
  await page.goto(`${runPhantom.url}/verification?section=inspect`);
  await expect(page.getByRole("heading", { name: "Connect your first app", exact: true })).toBeVisible();
  await expect(page.locator("#verification-connect-first")).toBeFocused();
  await expect(page.getByRole("button", { name: "Run action", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Trusted browser", exact: true })).toBeVisible();
  await expect(page.getByText("Optional runtime unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open browser", exact: true })).toBeDisabled();
  await page.getByRole("navigation", { name: "Verification workspace", exact: true }).getByRole("link", { name: "Snapshots", exact: true }).click();
  await expect(page.locator("#verification-snapshots")).toBeFocused();
  await expect(page.getByRole("button", { name: "Capture snapshot", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Import snapshots", exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.locator("#verification-snapshots")).toBeFocused();
  await expect(page.getByText(/No saved snapshots/)).toBeVisible();
  mkdirSync(screenshotDir, { recursive: true });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await page.getByRole("heading", { name: "Verification", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(screenshotDir, `empty-${width}.png`) });
  }
});

test("verification workspace: a held real command cannot publish inspection into a different run scope", async ({ page, context, request, runPhantom, targetApp }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  const app = await context.newPage();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let admitted!: () => void;
  const received = new Promise<void>(resolve => { admitted = resolve; });
  const pending = new Set<Promise<void>>();
  let pattern = "";
  const handler = (route: import("@playwright/test").Route) => {
    const work = (async () => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      admitted();
      await held;
      await route.fulfill({ response });
    })();
    pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  };
  try {
    const session = await connectTarget(app, request, runPhantom, targetApp.origin, FIXTURE_PRIMARY_RUN_ID);
    await page.goto(`${runPhantom.url}/verification?runId=${FIXTURE_PRIMARY_RUN_ID}`);
    pattern = `**/api/verification/sessions/${session.id}/command`;
    await page.route(pattern, handler);
    await page.getByRole("button", { name: "Run action", exact: true }).click();
    await received;
    await page.getByRole("link", { name: "Show reports for all runs", exact: true }).click();
    await expect(page).toHaveURL(`${runPhantom.url}/verification`);
    const delivered = page.waitForResponse(response => response.url().endsWith(`/sessions/${session.id}/command`));
    release(); await delivered;
    await Promise.all(pending);
    await page.unroute(pattern, handler);
    await expect(page.getByRole("region", { name: "App inspection", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Run action", exact: true }).click();
    await expect(page.getByRole("region", { name: "App inspection", exact: true })).toBeVisible();
    const sessions = await request.get(`${runPhantom.url}/api/verification/sessions`);
    expect((await sessions.json() as Array<{ id: string; connected: boolean }>).find(item => item.id === session.id)?.connected).toBe(true);
  } finally {
    release(); await Promise.allSettled(pending);
    if (pattern) await page.unroute(pattern, handler);
    await app.close();
  }
});
