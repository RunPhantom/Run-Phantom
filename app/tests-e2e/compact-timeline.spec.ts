import { test, expect } from "./fixtures";
import { FIXTURE_PRIMARY_RUN_ID, seedRunPhantomFixtures } from "./helpers";
import type { Span } from "../src/utils/types";

test("timeline baseline: exact span population, tool action and captured output survive layout work", async ({ page, request, runPhantom }, testInfo) => {
  await seedRunPhantomFixtures(runPhantom.url);
  const detailUrl = `${runPhantom.url}/api/runs/detail/${FIXTURE_PRIMARY_RUN_ID}`;
  const response = await request.get(detailUrl);
  expect(response.ok()).toBe(true);
  const before = await response.json() as { spans: Span[] };
  const eligible = before.spans.filter(span => span.span_type === "TRACE" || span.span_type === "TOOL_CALL" || span.span_type?.includes("LLM"));
  const tool = eligible.find(span => span.span_type === "TOOL_CALL")!;
  expect(tool.output_payload).toBeTruthy();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  const bars = page.locator('button.timeline-bar, button[aria-label^="Jump to "]');
  await expect(bars).toHaveCount(eligible.length);
  const bar = page.locator(`button[data-meridian-key="${tool.id}"]`).first();
  await bar.scrollIntoViewIfNeeded();
  await bar.hover();
  await expect(page.locator("[data-span-tooltip]")).toContainText(tool.name);
  await bar.click();
  const pill = page.locator(`[data-tool-span-id="${tool.id}"]`);
  await expect(pill.getByRole("button").first()).toHaveAttribute("aria-expanded", "true");
  await expect(pill).toContainText("A traec viewer for AI agents.");
  await page.mouse.move(2, 2);
  await expect(page.locator("[data-span-tooltip]")).toBeHidden();
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(viewport);
    await bars.first().scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    const screenshot = testInfo.outputPath(`timeline-preserved-${viewport.width}.png`);
    await page.screenshot({ path: screenshot });
    await testInfo.attach(`timeline-preserved-${viewport.width}`, { path: screenshot, contentType: "image/png" });
  }
  expect((await (await request.get(detailUrl)).json()).spans).toEqual(before.spans);
  expect(errors).toEqual([]);
});
