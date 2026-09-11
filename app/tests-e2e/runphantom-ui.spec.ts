import { expect, test } from "./fixtures";
import {
  clearRunPhantom,
  expectRunPhantomBranding,
  hasLegacyIdentityKey,
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
