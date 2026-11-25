import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { FIXTURE_PRIMARY_RUN_ID, listRunPhantomRuns, seedRunPhantomFixtures } from "./helpers";

// The app maps "mod" from the browser's reported platform, which the Playwright device profile may override.
async function modKey(page: Page): Promise<"Meta" | "Control"> {
  return await page.evaluate(() => {
    const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
    return /mac|iphone|ipad|ipod/i.test(platform);
  }) ? "Meta" : "Control";
}

test("command palette opens from the keyboard, filters, navigates and restores focus", async ({ page, runPhantom }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedRunPhantomFixtures(runPhantom.url);
  await page.goto(`${runPhantom.url}/settings`);
  await expect(page.locator("[data-workspace-header]").getByText("Settings", { exact: true })).toBeVisible();

  const trigger = page.getByRole("button", { name: "Search runs, steps, commands", exact: true });
  await trigger.focus();
  await page.keyboard.press(`${await modKey(page)}+k`);
  const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
  await expect(palette).toBeVisible();
  const input = palette.getByRole("combobox", { name: "Search runs, steps, commands", exact: true });
  await expect(input).toBeFocused();
  const listbox = palette.getByRole("listbox", { name: "Commands", exact: true });
  await expect(listbox.getByRole("group", { name: "Go to", exact: true })).toBeVisible();
  for (const name of ["Runs", "Search", "Saved", "Evaluations", "Review queues", "Prompts", "Verification", "Cost & usage"]) {
    await expect(listbox.getByRole("option", { name, exact: true })).toHaveCount(1);
  }
  await expect(listbox.getByRole("group", { name: "Recent runs", exact: true }).getByRole("option")).toHaveCount(3);

  await input.fill("cost");
  const first = listbox.getByRole("option").first();
  await expect(first).toHaveAccessibleName("Cost & usage");
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect(input).toHaveAttribute("aria-activedescendant", (await first.getAttribute("id"))!);
  await testInfo.attach("palette-filtered", { body: await page.screenshot(), contentType: "image/png" });
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect(page).toHaveURL(`${runPhantom.url}/costs`);

  await trigger.click();
  await expect(palette).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(listbox.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(listbox.getByRole("option").last()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await expect(trigger).toBeFocused();

  await page.keyboard.press(`${await modKey(page)}+k`);
  await input.fill("zzzz-no-such-command");
  await expect(palette.getByText("No pages, runs or commands match", { exact: false })).toBeVisible();
  await expect(listbox.getByRole("group", { name: "Search", exact: true })).toBeVisible();
  await input.fill("agent.turn");
  await page.getByRole("option", { name: /^Search steps for/ }).click();
  await expect(page).toHaveURL(/\/search\?/);
  const params = new URL(page.url()).searchParams;
  expect({ q: params.get("q"), resource: params.get("resource") }).toEqual({ q: "agent.turn", resource: "span-hits" });
});

test("palette actions report real results: sample runs load and the OTLP endpoint names the daemon port", async ({ page, context, runPhantom }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: runPhantom.url });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${runPhantom.url}/runs`);
  await expect(page.getByRole("heading", { name: "No runs captured yet.", exact: true })).toBeVisible();

  await page.keyboard.press(`${await modKey(page)}+k`);
  const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
  const input = palette.getByRole("combobox");
  await input.fill("otlp");
  await page.keyboard.press("Enter");
  const endpoint = `http://127.0.0.1:${runPhantom.port}/v1/traces`;
  await expect(palette.getByRole("status")).toHaveText(`Copied ${endpoint}`);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(endpoint);

  await input.fill("load sample");
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect.poll(async () => (await listRunPhantomRuns(runPhantom.url)).length).toBe(3);
  await expect(page).toHaveURL(/\/runs\/demo_/);
  await expect(page.locator("[data-run-id]")).toHaveCount(3);
});

test("g-sequences and ? navigate and open the shortcut sheet, but never while typing", async ({ page, runPhantom }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedRunPhantomFixtures(runPhantom.url);
  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  await expect(page.getByRole("tab", { name: "Span Tree", exact: true })).toBeVisible();

  await page.locator("body").press("g");
  await page.keyboard.press("e");
  await expect(page).toHaveURL(`${runPhantom.url}/evaluations`);

  const name = page.getByRole("textbox", { name: "Dataset name", exact: true });
  await name.click();
  await page.keyboard.type("g s ?");
  await expect(name).toHaveValue("g s ?");
  await expect(page).toHaveURL(`${runPhantom.url}/evaluations`);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await name.blur();
  await page.keyboard.press("Control+g");
  await page.keyboard.press("s");
  await expect(page).toHaveURL(`${runPhantom.url}/evaluations`);

  await page.keyboard.press("Shift+?");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Open the command palette", { exact: true })).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Go to", exact: true })).toBeVisible();
  await page.keyboard.press("g");
  await page.keyboard.press("r");
  await expect(page).toHaveURL(`${runPhantom.url}/evaluations`);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  await page.keyboard.press("g");
  await page.keyboard.press(",");
  await expect(page).toHaveURL(`${runPhantom.url}/settings`);
});

test("dark theme is opt-in, persists across reloads before first paint, and light stays the default", async ({ page, runPhantom }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedRunPhantomFixtures(runPhantom.url);
  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  const root = page.locator("html");
  await expect(root).not.toHaveAttribute("data-theme", /.+/);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("light");

  const toggle = page.locator("[data-workspace-header]").getByRole("button", { name: "Theme: Light", exact: true });
  await toggle.click();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("[data-workspace-header]").getByRole("button", { name: "Theme: Dark", exact: true })).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem("runphantom:theme"))).toBe("dark");
  const dark = await page.evaluate(() => ({
    scheme: getComputedStyle(document.documentElement).colorScheme,
    body: getComputedStyle(document.body).backgroundColor,
    ink: getComputedStyle(document.body).color,
    accent: getComputedStyle(document.documentElement).getPropertyValue("--rp-accent").trim(),
  }));
  expect(dark).toEqual({ scheme: "dark", body: "rgb(11, 13, 18)", ink: "rgb(232, 235, 242)", accent: "#8C9EFF" });
  await testInfo.attach("dark-run-detail", { body: await page.screenshot(), contentType: "image/png" });

  await page.addInitScript(() => {
    new MutationObserver(() => {
      if (document.body && !(window as unknown as { __firstBodyTheme?: string | null }).__firstBodyTheme) {
        (window as unknown as { __firstBodyTheme?: string | null }).__firstBodyTheme = document.documentElement.getAttribute("data-theme") ?? "none";
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => (window as unknown as { __firstBodyTheme?: string }).__firstBodyTheme)).toBe("dark");

  await page.locator("[data-workspace-header]").getByRole("button", { name: "Theme: Dark", exact: true }).click();
  await page.locator("[data-workspace-header]").getByRole("button", { name: "Theme: System", exact: true }).click();
  await expect(root).not.toHaveAttribute("data-theme", /.+/);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("light");
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(249, 250, 252)");
});

test("grouped navigation keeps pinned names and shows counts only for loaded data", async ({ page, runPhantom }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${runPhantom.url}/runs`);
  const navigation = page.getByRole("navigation", { name: "Primary navigation", exact: true });
  for (const group of ["Debug", "Improve", "Ship"]) await expect(navigation.getByText(group, { exact: true })).toBeVisible();
  const runs = navigation.getByRole("link", { name: "Runs", exact: true });
  await expect(runs).not.toHaveAttribute("aria-describedby", /.+/);

  await seedRunPhantomFixtures(runPhantom.url);
  await expect(runs).toHaveAccessibleDescription("3 runs", { timeout: 10_000 });
  const box = (await runs.boundingBox())!;
  expect(box.height).toBe(32);
});

test("runs page prompts for a run instead of showing onboarding when only sample runs exist", async ({ page, request, runPhantom }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  expect((await request.post(`${runPhantom.url}/api/demo-traces/replay`)).ok()).toBe(true);
  await page.goto(`${runPhantom.url}/runs`);
  await expect(page.locator("[data-run-id]")).toHaveCount(3);
  await expect(page.getByRole("heading", { name: "Pick a run to inspect", exact: true })).toBeVisible();
  await expect(page.getByText("No runs captured yet.")).toHaveCount(0);
  await expect(page.getByText("These are sample runs.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Open most recent run", exact: true }).click();
  await expect(page).toHaveURL(/\/runs\/demo_/);
  await expect(page.getByRole("tab", { name: "Span Tree", exact: true })).toBeVisible();
});
