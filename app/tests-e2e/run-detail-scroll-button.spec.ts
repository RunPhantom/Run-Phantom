import { test, expect } from "./fixtures";
import { seedRunPhantomFixtures } from "./helpers";

const RUN = "00000000000000000000000000000003";
const LAST = "consider backoff.";

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`run detail scroll-to-bottom button never covers the last message at ${viewport.width}px`, async ({ page, runPhantom }) => {
    await seedRunPhantomFixtures(runPhantom.url);
    await page.setViewportSize(viewport);
    await page.goto(`${runPhantom.url}/runs/${RUN}`);
    const last = page.getByText(LAST, { exact: false }).last(), button = page.getByRole("button", { name: "Scroll to bottom" });
    await expect(last).toBeAttached({ timeout: 20_000 });
    const panel = page.locator('[role="tabpanel"]').filter({ has: last });
    const scroller = panel.locator(":scope > div").first();
    const max = await scroller.evaluate(element => element.scrollHeight - element.clientHeight);
    expect(max, "the conversation must overflow for the button to appear").toBeGreaterThan(0);
    let checked = 0;
    for (const top of [0, ...Array.from({ length: 12 }, (_, index) => Math.round(max * (index + 1) / 12))]) {
      await scroller.evaluate((element, value) => { element.scrollTop = value; }, top);
      await page.waitForTimeout(150);
      if (!(await button.isVisible())) continue;
      const [buttonBox, lastBox, viewportBox] = [await button.boundingBox(), await last.boundingBox(), await scroller.boundingBox()];
      if (!buttonBox || !lastBox || !viewportBox) continue;
      const lastInView = lastBox.y < viewportBox.y + viewportBox.height && lastBox.y + lastBox.height > viewportBox.y;
      if (!lastInView) continue;
      checked++;
      // Only the part of the message inside the scroll viewport is on screen; the rest is clipped, not covered.
      const visible = { x: lastBox.x, width: lastBox.width, y: Math.max(lastBox.y, viewportBox.y), bottom: Math.min(lastBox.y + lastBox.height, viewportBox.y + viewportBox.height) };
      const intersects = buttonBox.x < visible.x + visible.width && buttonBox.x + buttonBox.width > visible.x && buttonBox.y < visible.bottom && buttonBox.y + buttonBox.height > visible.y;
      expect(intersects, `button ${JSON.stringify(buttonBox)} intersects the visible last message ${JSON.stringify(visible)} at scrollTop ${top}`).toBe(false);
      expect(buttonBox.y, "button must sit below the scroll viewport, not over it").toBeGreaterThanOrEqual(viewportBox.y + viewportBox.height - 1);
    }
    expect(checked, "at least one position must show the button and the last message together").toBeGreaterThan(0);
    await scroller.evaluate(element => { element.scrollTop = 0; });
    await button.click();
    await expect(button).toBeHidden();
    await expect(last).toBeInViewport();
  });
}
