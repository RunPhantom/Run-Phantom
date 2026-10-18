import { test, expect } from "./fixtures";
import { captureTrace, captureInput, captureOutput, filterSecret } from "../../tests/fixtures/capture-visibility";

for (const width of [1440, 1280, 1024, 768, 390, 320]) {
  test(`real captured retrieval, embedding and stream evidence at ${width}px`, async ({ page, request, runPhantom }, info) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const source = captureTrace(16000 + width);
    expect((await request.post(runPhantom.url + "/v1/traces", { data: source.body })).status()).toBe(200);
    await page.setViewportSize({ width, height: width >= 768 ? 900 : 844 }); await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${runPhantom.url}/runs`);
    await page.locator(`[data-run-id="${source.id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/runs/${source.id}`));
    await page.screenshot({ path: info.outputPath(`capture-collapsed-${width}.png`), fullPage: true });
    await expect(page.getByText(captureInput, { exact: true })).toBeVisible();
    await expect(page.getByText(captureOutput, { exact: true })).toHaveCount(1);
    const retrieval = page.getByRole("region", { name: "Retrieval evidence", exact: true });
    await expect(retrieval).toBeVisible(); const summary = retrieval.locator("summary").first();
    await summary.focus(); await summary.press("Enter"); await expect(retrieval.locator("details").first()).toHaveAttribute("open", "");
    await expect(retrieval).toContainText("manuals"); await expect(retrieval).toContainText("Top K"); await expect(retrieval).toContainText("Results");
    await expect(retrieval.locator("dd").nth(1)).toHaveText("3"); await expect(retrieval.locator("dd").nth(2)).toHaveText("0");
    await expect(retrieval).toContainText("[REDACTED]"); await expect(retrieval).toContainText("Paris");
    const embedding = page.getByRole("region", { name: "Embedding evidence", exact: true }); await embedding.locator("summary").first().click(); await expect(embedding).toContainText("1536");
    const complete = page.locator(`[data-capture-span="${source.llm.spanId}"]`); await complete.locator("summary").first().click();
    await expect(complete).toContainText("Complete stream capture"); await expect(complete).toContainText("All declared chunks were captured.");
    await expect(complete).toContainText("0 ms"); await complete.getByText("Observed chunks (2)", { exact: true }).click();
    await expect(complete.getByText("Hello ", { exact: true })).toBeVisible(); await expect(complete.getByText("world", { exact: true })).toBeVisible();
    const cancelled = page.locator(`[data-capture-span="${source.cancelled.spanId}"]`); await cancelled.locator("summary").first().click();
    await expect(cancelled).toContainText("Stream cancelled"); await cancelled.getByText("Observed chunks (1)", { exact: true }).click(); await expect(cancelled).toContainText("Partial evidence");
    expect(await page.locator("body").textContent()).not.toContain(filterSecret);
    await page.screenshot({ path: info.outputPath(`capture-overview-${width}.png`), fullPage: true });
    await page.getByRole("tab", { name: "Span Tree", exact: true }).click();
    await page.locator(`[data-span-row="${source.retrieval.spanId}"]`).click();
    const treeCapture = page.getByRole("region", { name: "Retrieval evidence", exact: true }); await treeCapture.locator("summary").first().click(); await expect(treeCapture.locator("dd").nth(2)).toHaveText("0");
    await page.screenshot({ path: info.outputPath(`capture-tree-${width}.png`), fullPage: true });
    const back = page.getByRole("button", { name: "Back to span list", exact: true });
    if (await back.isVisible()) await back.click();
    await page.locator(`[data-span-row="${source.llm.spanId}"]`).click();
    await expect(page.getByText(captureOutput, { exact: true })).toBeVisible();
    await expect(page.getByText(captureInput, { exact: false }).first()).toBeVisible();
    const computed = await page.locator(`[data-capture-span="${source.llm.spanId}"]`).evaluate(element => ({
      background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color,
      summaryHeight: element.querySelector("summary")!.getBoundingClientRect().height,
      overflow: document.documentElement.scrollWidth > innerWidth,
    }));
    expect(computed.summaryHeight).toBeGreaterThanOrEqual(44); expect(computed.overflow).toBe(false);
    expect(computed.color).toBe("rgb(14, 18, 27)"); expect(computed.background).toBe("rgb(255, 255, 255)"); expect(errors).toEqual([]);
    await info.attach("actual-capture-ui.json", { body: JSON.stringify({ width, computed, sourceId: source.id, outputExactlyOnce: true, errors }, null, 2), contentType: "application/json" });
    await page.screenshot({ path: info.outputPath(`capture-output-${width}.png`), fullPage: true });
  });
}

test("unknown, incomplete and error streams retain separate truthful UI states", async ({ page, request, runPhantom }, info) => {
  const states = ["unknown", "incomplete", "error"] as const;
  for (const [index, state] of states.entries()) {
    const source = captureTrace(1680 + index);
    if (state === "unknown") source.llm.events = [];
    else if (state === "incomplete") source.llm.events.pop();
    else source.llm.events[source.llm.events.length - 1].name = "runphantom.stream.error";
    expect((await request.post(runPhantom.url + "/v1/traces", { data: source.body })).status()).toBe(200);
    await page.goto(`${runPhantom.url}/runs/${source.id}`);
    const capture = page.locator(`[data-capture-span="${source.llm.spanId}"]`); await capture.locator("summary").first().click();
    await expect(capture).toContainText({ unknown: "Stream completion unknown", incomplete: "Incomplete stream capture", error: "Stream failed" }[state]);
    await expect(page.getByText(captureOutput, { exact: true })).toHaveCount(1);
    await page.screenshot({ path: info.outputPath(`capture-${state}.png`), fullPage: true });
  }
});
