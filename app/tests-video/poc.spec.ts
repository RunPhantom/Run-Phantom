import { expect, test } from "../tests-e2e/fixtures";

/**
 * Proof-of-concept capture: seeds demo traces into an isolated daemon, then
 * walks the core inspection flow at watchable pace. Exists to prove the
 * recording harness produces a usable artifact before the full catalog is
 * built against it.
 */

// Deliberate on-camera pauses. Playwright's slowMo covers action latency but
// not "let the viewer read this", which is what makes a demo followable.
async function beat(ms = 1100): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

test("core trace inspection walkthrough", async ({ page, runPhantom }) => {
  const seeded = await fetch(`${runPhantom.url}/api/demo-traces/replay`, { method: "POST" });
  expect(seeded.ok).toBe(true);

  await page.goto(`${runPhantom.url}/runs`, { waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle("Run Phantom");
  await beat(1500);

  const firstRun = page.locator("[data-run-id]").first();
  await expect(firstRun).toBeVisible();
  await beat();

  await firstRun.click();
  await expect(page).toHaveURL(/\/runs\/[^/?#]+/);
  await beat(1500);

  // Assert, do not probe. The earlier version matched /spans/i against a tab whose
  // accessible name is "Span Tree", found nothing, and skipped the shot behind an
  // `if (count())` guard — so the take passed while silently missing a third of it.
  const spansTab = page.getByRole("tab", { name: "Span Tree" });
  await expect(spansTab).toBeVisible();
  await spansTab.click();
  await beat(1500);

  const convoTab = page.getByRole("tab", { name: "Conversation" });
  await expect(convoTab).toBeVisible();
  await convoTab.click();
  await beat(1500);

  await page.setViewportSize({ width: 390, height: 844 });
  await beat(1600);
});
