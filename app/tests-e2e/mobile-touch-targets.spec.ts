import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function replaySamples(url: string): Promise<void> {
  expect((await fetch(`${url}/api/demo-traces/replay`, { method: "POST" })).ok).toBe(true);
  await expect.poll(async () => {
    const runs = await (await fetch(`${url}/api/runs`)).json() as Array<{ id: string; finished?: number | null }>;
    return runs.filter(run => run.id.startsWith("demo_") && run.finished === 1).length;
  }, { timeout: 30_000 }).toBe(3);
}

async function expectTouchSized(page: Page, name: string, locator: ReturnType<Page["locator"]>) {
  const count = await locator.count();
  expect(count, `${name} is on the page`).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const box = await locator.nth(index).boundingBox();
    if (!box) continue;
    expect(Math.min(box.width, box.height), `${name} #${index} is ${Math.round(box.width)}x${Math.round(box.height)}`).toBeGreaterThanOrEqual(44);
  }
}

async function expectNoSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0);
}

for (const width of [390, 768]) {
  test(`phone and tablet controls keep 44px targets at ${width}px`, async ({ page, runPhantom }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
    await replaySamples(runPhantom.url);

    await page.goto(runPhantom.url);
    await expect(page.locator("[data-home-dashboard]")).toBeVisible({ timeout: 15_000 });
    await expectNoSidewaysScroll(page);
    await expectTouchSized(page, "Needs a look row", page.locator("[data-needs-a-look]"));
    await expectTouchSized(page, "Latest activity row", page.locator("[data-activity-run]"));
    await expectTouchSized(page, "Window choice", page.getByRole("group", { name: "Time window" }).getByRole("button"));

    await page.goto(`${runPhantom.url}/runs/demo_research`);
    const actions = page.locator("[data-run-actions]");
    await expect(actions).toBeVisible({ timeout: 15_000 });
    await expectNoSidewaysScroll(page);
    for (const name of ["Save", "Debug", "Replay with options", "More actions"]) {
      await expectTouchSized(page, name, actions.getByRole("button", { name, exact: true }));
    }

    await page.goto(`${runPhantom.url}/playground`);
    await expect(page.getByRole("group", { name: "Models to compare" })).toBeVisible({ timeout: 15_000 });
    await expectNoSidewaysScroll(page);
    await expectTouchSized(page, "Compare choice", page.getByRole("group", { name: "Models to compare" }).getByRole("button"));
    await expectTouchSized(page, "Output text toggle", page.getByRole("group", { name: "Output text" }).getByRole("button"));
    await expectTouchSized(page, "Message controls", page.locator("[data-playground-message]").getByRole("button", { name: /^(Move|Remove) message/ }));
  });
}
