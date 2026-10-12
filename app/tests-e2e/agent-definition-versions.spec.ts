import { createHash } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { test, expect } from "./fixtures";
import { agentDefinition, definitionTrace, definitionInput, definitionOutput } from "../../tests/fixtures/agent-definitions";
import type { RunComparison } from "../../src/run-comparison-protocol";

async function capturedPair(request: APIRequestContext, base: string, partial = false) {
  const baseline = definitionTrace(1701), candidate = definitionTrace(1702, agentDefinition(partial ? "[REDACTED]" : "Changed private instructions", .123456790));
  for (const capture of [baseline, candidate]) {
    expect((await request.post(base + "/v1/traces", { data: capture.body })).status()).toBe(200);
    const publicFile = await request.get(`${base}/api/runs/${capture.id}/export`); expect(publicFile.status()).toBe(200); const trace = await publicFile.json();
    expect(JSON.stringify(trace)).not.toContain("Private lookup description");
    // The existing comparison mount requires replay-source metadata. Obtain the
    // original private captured columns through its guarded local diagnostic
    // API, then import the exact observed spans with only this fixture link.
    const raw = await request.post(base + "/api/traces/query", { data: { sql: `SELECT id,attributes,otlp_evidence FROM spans WHERE run_id='${capture.id}'` } });
    expect(raw.status()).toBe(200); const rows = (await raw.json()).rows as Array<{ id: string; attributes: string; otlp_evidence: string }>;
    for (const span of trace.spans) {
      const original = rows.find(row => row.id === span.id)!; expect(original).toBeDefined(); span.attributes = original.attributes; span.otlp_evidence = original.otlp_evidence;
      expect(span.input_payload).toBe(definitionInput); expect(span.output_payload).toBe(definitionOutput);
    }
    if (capture === candidate) trace.run.metadata = JSON.stringify({ replay: { sourceRunId: baseline.id, mode: "local" } });
    expect((await request.post(base + "/api/import-run", { data: trace })).status()).toBe(200);
  }
  const response = await request.get(`${base}/api/runs/compare?baseline=${baseline.id}&candidate=${candidate.id}`); expect(response.status()).toBe(200);
  const comparison = await response.json() as RunComparison; expect(comparison.agentDefinitions?.baseline?.records[0].complete).toBe(true);
  return { baseline, candidate, comparison };
}

for (const width of [1440, 390, 320]) test(`actual captured definition hashes, original output and keyboard details remain usable at ${width}px`, async ({ page, request, runPhantom }, testInfo) => {
  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 }); await page.emulateMedia({ reducedMotion: "reduce" });
  const { baseline, candidate, comparison: original } = await capturedPair(request, runPhantom.url);
  expect(original.counts).toMatchObject({ paired: 1, changed: 0, unchanged: 1 }); expect(original.agentDefinitions?.candidate?.records[0].complete).toBe(true);
  await page.goto(`${runPhantom.url}/runs/${candidate.id}?debugCompare=1`);
  const comparison = page.getByRole("region", { name: "Captured run comparison" }); await expect(comparison.locator('[data-comparison-count="unchanged"]')).toHaveText("1");
  await page.screenshot({ path: testInfo.outputPath(`definition-before-${width}.png`), fullPage: true });
  const definitions = comparison.getByRole("region", { name: "Captured agent definitions" }); await expect(definitions).toBeVisible();
  await expect(definitions.getByRole("heading", { name: "Captured definitions" })).toBeVisible(); await expect(definitions).toContainText("Captured configuration changed");
  const candidateRecord = definitions.locator('[data-definition-side="candidate"] [data-definition-record]'), control = candidateRecord.locator("summary");
  await control.focus(); await control.press("Enter"); await expect(candidateRecord).toHaveAttribute("open", "");
  const firstHash = original.agentDefinitions!.candidate!.records[0].sha256!;
  await expect(candidateRecord.locator('[data-definition-hash="version"]')).toHaveText(firstHash);
  await expect(candidateRecord.locator('[data-definition-hash="prompt"]')).toHaveText(createHash("sha256").update("Changed private instructions").digest("hex"));
  await expect(definitions).toContainText("Prompt, Runtime"); expect(await definitions.textContent()).not.toContain("Private lookup description"); expect(await definitions.textContent()).not.toContain("Changed private instructions");
  await page.evaluate(async () => { await document.fonts.load('600 18px "Syne"'); await document.fonts.load('400 14px "Inter Variable"'); await document.fonts.ready; });
  const visual = await definitions.evaluate(element => {
    const title = element.querySelector("h3")!, summary = element.querySelector('[data-definition-side="candidate"] summary')!;
    return { color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor, headingFont: getComputedStyle(title).fontFamily,
      bodyFont: getComputedStyle(element).fontFamily, fonts: [...document.fonts].filter(face => face.status === "loaded").map(face => face.family), summaryHeight: summary.getBoundingClientRect().height,
      focusColor: getComputedStyle(summary).outlineColor, focusWidth: getComputedStyle(summary).outlineWidth, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  expect(visual.color).toBe("rgb(14, 18, 27)"); expect(visual.background).toBe("rgb(249, 250, 252)"); expect(visual.headingFont).toContain("Syne"); expect(visual.bodyFont).toContain("Inter");
  expect(visual.fonts.some(font => font.includes("Syne"))).toBe(true); expect(visual.fonts.some(font => font.includes("Inter"))).toBe(true); expect(visual.summaryHeight).toBeGreaterThanOrEqual(44);
  expect(visual.focusColor).toBe("rgb(0, 33, 204)"); expect(visual.focusWidth).toBe("2px"); expect(visual.overflow).toBe(false);
  await testInfo.attach("actual-definition-visual.json", { body: JSON.stringify(visual, null, 2), contentType: "application/json" });
  await control.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`definition-focus-${width}.png`), fullPage: true });
  const link = candidateRecord.getByRole("link", { name: "Open candidate definition source span in a new tab" });
  await control.press("Tab"); await expect(link).toBeFocused(); await expect(link).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`definition-source-link-${width}.png`), fullPage: true });
  const [detail] = await Promise.all([page.waitForEvent("popup"), link.click()]);
  try {
    await expect(detail).toHaveURL(new RegExp(`/runs/${candidate.id}/span/${candidate.spanId}$`)); await expect(detail.locator(`[data-span-row="${candidate.spanId}"]`)).toBeVisible();
    await expect(detail.getByText(definitionInput, { exact: true }).first()).toBeVisible();
    await expect(detail.getByText(definitionOutput, { exact: true }).first()).toBeVisible();
  } finally { await detail.close(); }
  const correction = definitionTrace(1702, agentDefinition("Late exact captured correction", .123456791)); expect((await request.post(runPhantom.url + "/v1/traces", { data: correction.body })).status()).toBe(200);
  const updated = await request.get(`${runPhantom.url}/api/runs/compare?baseline=${baseline.id}&candidate=${candidate.id}`); const current = await updated.json() as RunComparison;
  expect(current.agentDefinitions?.candidate?.records[0].sha256).not.toBe(firstHash); expect(current.counts).toEqual(original.counts);
  await comparison.getByRole("button", { name: "Refresh comparison", exact: true }).click(); await expect(candidateRecord.locator('[data-definition-hash="version"]')).toHaveText(current.agentDefinitions!.candidate!.records[0].sha256!);
  await page.reload(); await expect(definitions).toContainText("Captured configuration changed"); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await definitions.getByRole("heading", { name: "Captured definitions" }).scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`definition-current-${width}.png`), fullPage: true });
});

test.describe("actual touch definition navigation", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test("coarse pointer can tap, scroll the local definition viewport and open unchanged captured output", async ({ page, request, runPhantom }, testInfo) => {
    const { candidate, comparison: original } = await capturedPair(request, runPhantom.url);
    await page.goto(`${runPhantom.url}/runs/${candidate.id}?debugCompare=1`);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const comparison = page.getByRole("region", { name: "Captured run comparison" }), definitions = comparison.getByRole("region", { name: "Captured agent definitions" });
    const record = definitions.locator('[data-definition-side="candidate"] [data-definition-record]'), summary = record.locator("summary");
    await summary.tap(); await expect(record).toHaveAttribute("open", ""); expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(record.locator('[data-definition-hash="version"]')).toHaveText(original.agentDefinitions!.candidate!.records[0].sha256!);
    const before = await comparison.evaluate(element => element.scrollTop), box = (await comparison.boundingBox())!, touch = await page.context().newCDPSession(page);
    try { await touch.send("Input.synthesizeScrollGesture", { x: box.x + box.width / 2, y: box.y + box.height - 24, yDistance: -1000, speed: 800, gestureSourceType: "touch", preventFling: true }); }
    finally { await touch.detach(); }
    await expect.poll(() => comparison.evaluate(element => element.scrollTop)).toBeGreaterThan(before);
    const link = record.getByRole("link", { name: "Open candidate definition source span in a new tab" }); await expect(link).toBeVisible();
    const target = (await link.boundingBox())!; expect(target.height).toBeGreaterThanOrEqual(44);
    expect(await link.evaluate(element => { const rect = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: testInfo.outputPath("definition-touch-local-scroll.png"), fullPage: true });
    const [detail] = await Promise.all([page.waitForEvent("popup"), link.tap()]);
    try { await expect(detail).toHaveURL(new RegExp(`/runs/${candidate.id}/span/${candidate.spanId}$`)); await expect(detail.getByText(definitionInput, { exact: true }).first()).toBeVisible(); await expect(detail.getByText(definitionOutput, { exact: true }).first()).toBeVisible(); }
    finally { await detail.close(); }
    await testInfo.attach("actual-touch-receipt.json", { body: JSON.stringify({ pointer: "coarse", beforeScroll: before, afterScroll: await comparison.evaluate(element => element.scrollTop), sourceTargetHeight: target.height, originalOutputVerified: true }), contentType: "application/json" });
  });
});

test("actual partial capture cannot show a complete definition version or hide unchanged output", async ({ page, request, runPhantom }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); const { candidate, comparison: original } = await capturedPair(request, runPhantom.url, true);
  expect(original.agentDefinitions?.candidate?.records[0].sha256).toBeNull(); expect(original.counts.changed).toBe(0);
  await testInfo.attach("actual-partial-comparison.json", { body: JSON.stringify(original, null, 2), contentType: "application/json" });
  await page.goto(`${runPhantom.url}/runs/${candidate.id}?debugCompare=1`); const definitions = page.getByRole("region", { name: "Captured agent definitions" }); await expect(definitions).toBeVisible();
  await expect(definitions).toContainText("Complete configuration comparison unavailable");
  await expect(definitions.locator('[data-definition-side="baseline"]')).toContainText("Complete capture");
  const record = definitions.locator('[data-definition-side="candidate"] [data-definition-record]'); await record.locator("summary").click();
  await expect(record).toContainText("Partial capture"); await expect(record.locator('[data-definition-hash="version"]')).toHaveText("Unavailable"); await expect(record).toContainText("Capture redacted");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await record.locator("summary").scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath("definition-partial-mobile.png"), fullPage: true });
});
