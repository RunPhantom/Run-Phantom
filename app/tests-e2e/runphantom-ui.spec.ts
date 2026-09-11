import { expect, test } from "./fixtures";
import {
  clearRunPhantom,
  expectRunPhantomBranding,
  FIXTURE_LIVE_RUN_ID,
  FIXTURE_PRIMARY_RUN_ID,
  hasLegacyIdentityKey,
  listRunPhantomRuns,
  readLocalStorageKeys,
  seedRunPhantomFixtures,
} from "./helpers";

test.beforeEach(async ({ runPhantom }) => {
  await clearRunPhantom(runPhantom.url);
});

test("Run Phantom UI: clean-break branding and setup state use Run Phantom keys", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);

  await page.goto(runPhantom.url);
  await expectRunPhantomBranding(page);
  await expect
    .poll(async () => page.evaluate(() => localStorage.getItem("runphantom:firstTimeSetupDismissed")), {
      timeout: 10_000,
    })
    .toBe("1");

  const localStorageKeys = await readLocalStorageKeys(page);
  expect(hasLegacyIdentityKey(localStorageKeys)).toBe(false);
});

test("Run Phantom UI: initial runs view avoids optional-provider request failures", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);

  const failingResponses: Array<{ url: string; status: number }> = [];
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/")) return;
    failingResponses.push({ url: url.pathname, status: response.status() });
  });

  await page.goto(`${runPhantom.url}/runs`, { waitUntil: "networkidle" });

  expect(failingResponses).toEqual([]);
});

test("Run Phantom UI: mobile layout exposes a visible sidebar toggle", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  await page.setViewportSize({ width: 430, height: 932 });

  await page.goto(`${runPhantom.url}/runs`, { waitUntil: "networkidle" });

  const sidebarToggle = page.getByRole("button", { name: /toggle sidebar/i });
  await expect(sidebarToggle).toBeVisible({ timeout: 10_000 });
  await sidebarToggle.click();
  await expect(page.getByRole("link", { name: /^search$/i })).toBeVisible({ timeout: 5_000 });
});

test("Run Phantom UI: mobile viewport keeps the runs list usable when chat is expanded", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem("runphantom:messagePane:collapsed", "0");
    localStorage.setItem("runphantom:messagePane:width", "460");
  });

  await page.goto(`${runPhantom.url}/runs`, { waitUntil: "networkidle" });

  const row = page.locator(`[data-run-id="${FIXTURE_PRIMARY_RUN_ID}"]`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  const box = await row.boundingBox();
  expect(box, "expected the primary run row to render in the mobile list").not.toBeNull();
  expect(box!.width, "mobile chat must not squeeze the runs list below a usable width").toBeGreaterThan(300);
});

test("Run Phantom UI: clear button empties runs list and database", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);

  const before = await listRunPhantomRuns(runPhantom.url);
  expect(before.length).toBeGreaterThanOrEqual(3);

  await page.goto(runPhantom.url);
  page.on("dialog", (dialog) => dialog.accept());

  const clearButton = page.getByRole("button", { name: /^clear all runs$/i });
  await expect(clearButton).toBeVisible({ timeout: 10_000 });
  await clearButton.click();

  await expect.poll(async () => (await listRunPhantomRuns(runPhantom.url)).length, {
    timeout: 10_000,
  }).toBe(0);
});

test("Run Phantom UI: seeded runs appear live without a reload", async ({ page, runPhantom }) => {
  await page.goto(runPhantom.url);
  await expect(page.getByText(/no runs/i).first()).toBeVisible({ timeout: 10_000 });

  await seedRunPhantomFixtures(runPhantom.url);

  await expect(page.locator(`[data-run-id="${FIXTURE_PRIMARY_RUN_ID}"]`)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(`[data-run-id="${FIXTURE_LIVE_RUN_ID}"]`)).toBeVisible({ timeout: 10_000 });
});
