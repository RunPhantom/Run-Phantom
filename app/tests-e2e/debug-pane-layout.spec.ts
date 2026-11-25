import { expect, test } from "./fixtures";
import { FIXTURE_PRIMARY_RUN_ID, seedRunPhantomFixtures } from "./helpers";

for (const width of [1440, 390, 320]) {
  test(`trace debug composer remains reachable by keyboard at ${width}px`, async ({ page, request, runPhantom }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await seedRunPhantomFixtures(runPhantom.url);
    const detailUrl = `${runPhantom.url}/api/runs/detail/${FIXTURE_PRIMARY_RUN_ID}`;
    const before = await (await request.get(detailUrl)).json();
    const sentMessages: string[] = [];
    page.on("request", message => {
      if (message.method() === "POST" && /\/api\/(agent|claude)\/.*(message|chat)/.test(message.url())) sentMessages.push(message.url());
    });
    await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
    const debug = page.getByRole("button", { name: "Debug", exact: true });
    await debug.focus();
    await page.keyboard.press("Enter");
    const pane = page.locator('aside[aria-label="Coding-agent debug chat"]');
    await expect(pane).toBeVisible();
    const composer = pane.getByRole("combobox", { name: "Ask about this trace", exact: true });
    await expect(composer).toBeInViewport({ ratio: 1 });
    const send = pane.getByRole("button", { name: "Send message", exact: true });
    await expect(send).toBeInViewport({ ratio: 1 });
    await expect(send).toBeDisabled();
    await composer.focus();
    await page.keyboard.type("Inspect the captured output");
    await expect(composer).toHaveValue("Inspect the captured output");
    await expect(send).toBeEnabled();
    await testInfo.attach(`debug-composer-${width}`, { body: await page.screenshot(), contentType: "image/png" });
    const hide = pane.getByRole("button", { name: /^(Hide|Hide chat)$/, exact: true }).first();
    await hide.focus(); await page.keyboard.press("Enter");
    await expect(pane).toBeHidden();
    expect(sentMessages).toEqual([]);
    expect(await (await request.get(detailUrl)).json()).toEqual(before);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });

  test(`closed debug launcher sits in the header and leaves the route full height at ${width}px`, async ({ page, request, runPhantom }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await seedRunPhantomFixtures(runPhantom.url);
    const detailUrl = `${runPhantom.url}/api/runs/detail/${FIXTURE_PRIMARY_RUN_ID}`;
    const before = await (await request.get(detailUrl)).json();
    await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
    await expect(page.locator("[data-connection-status]")).toHaveAttribute("data-connection-status", "connected");
    const header = page.locator("[data-workspace-header]");
    const launcher = header.getByRole("button", { name: /Ask (Claude Code|Codex)$/, exact: true });
    await expect(launcher).toBeVisible();
    await expect(launcher).toHaveAttribute("aria-expanded", "false");
    const route = page.locator("[data-workspace-route]");
    await expect(route).toBeVisible();
    const routeBox = (await route.boundingBox())!;
    const launcherBox = (await launcher.boundingBox())!;
    await testInfo.attach(`closed-debug-${width}`, { body: await page.screenshot(), contentType: "image/png" });
    // The launcher no longer floats over content, so nothing reserves a band at the bottom of the route.
    expect(launcherBox.y + launcherBox.height, "launcher sits above the route").toBeLessThanOrEqual(routeBox.y + 1);
    expect(routeBox.y + routeBox.height, "route reaches the bottom of the viewport").toBeGreaterThanOrEqual(899);
    expect(await page.locator(".rp-launcher-band, .rp-list-scroll").count()).toBe(0);
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
    const launcher = page.locator("[data-workspace-header]").getByRole("button", { name: /Ask (Claude Code|Codex)$/, exact: true });
    await expect(launcher).toBeVisible();
    await launcher.click();
    await expect(launcher).toBeHidden();
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
