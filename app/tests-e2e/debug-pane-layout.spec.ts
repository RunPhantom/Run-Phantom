import { expect, test } from "./fixtures";
import { FIXTURE_PRIMARY_RUN_ID, seedRunPhantomFixtures } from "./helpers";

for (const width of [1440, 390, 320]) {
  test(`closed debug launcher preserves route space at ${width}px`, async ({ page, request, runPhantom }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await seedRunPhantomFixtures(runPhantom.url);
    const detailUrl = `${runPhantom.url}/api/runs/detail/${FIXTURE_PRIMARY_RUN_ID}`;
    const before = await (await request.get(detailUrl)).json();
    await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
    await expect(page.locator("[data-connection-status]")).toHaveAttribute("data-connection-status", "connected");
    const launcher = page.getByRole("button", { name: /Ask (Claude Code|Codex)$/, exact: true });
    await expect(launcher).toBeVisible();
    const route = page.locator("#runphantom-main > div > div.flex > div.overflow-auto");
    await expect(route).toBeVisible();
    const routeBox = (await route.boundingBox())!;
    const launcherBox = (await launcher.boundingBox())!;
    await testInfo.attach(`closed-debug-${width}`, { body: await page.screenshot(), contentType: "image/png" });
    // The route's final controls remain reachable without scrolling behind an opaque launcher.
    expect(routeBox.y + routeBox.height, "route ends above the closed debug launcher").toBeLessThanOrEqual(launcherBox.y + 1);
    expect(await (await request.get(detailUrl)).json()).toEqual(before);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });

  test(`opened debug chat fits and dismisses at ${width}px`, async ({ page, request, runPhantom }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await seedRunPhantomFixtures(runPhantom.url);
    const detailUrl = `${runPhantom.url}/api/runs/detail/${FIXTURE_PRIMARY_RUN_ID}`;
    const before = await (await request.get(detailUrl)).json();
    await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
    await expect(page.locator("[data-connection-status]")).toHaveAttribute("data-connection-status", "connected");
    const launcher = page.getByRole("button", { name: /Ask (Claude Code|Codex)$/, exact: true });
    await expect(launcher).toBeVisible();
    await launcher.click();
    const pane = page.locator('aside[aria-label="Coding-agent debug chat"]');
    await expect(pane).toBeVisible();
    const paneBox = (await pane.boundingBox())!;
    await testInfo.attach(`open-debug-${width}`, { body: await page.screenshot(), contentType: "image/png" });
    expect(paneBox.y).toBeGreaterThanOrEqual(0);
    expect(paneBox.y + paneBox.height, "debug pane's lower controls fit the viewport").toBeLessThanOrEqual(900);
    const hide = pane.getByRole("button", { name: /^(Hide|Hide chat)$/, exact: true }).first();
    await expect(hide).toBeInViewport({ ratio: 1 });
    await hide.focus();
    await expect(hide).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(pane).toBeHidden();
    await expect(launcher).toBeVisible();
    expect(await (await request.get(detailUrl)).json()).toEqual(before);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
}
