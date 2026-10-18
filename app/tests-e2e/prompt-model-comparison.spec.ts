import { test as base, expect, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startComparisonFixture } from "./comparison-fixture";
const test = base.extend<{ comparison: Awaited<ReturnType<typeof startComparisonFixture>> }>({ comparison: async ({}, use, info) => {
  const fixture = await startComparisonFixture(info.title.includes("Team") ? "team" : "local"); try { await use(fixture); } finally { await fixture.close(); }
} });
async function source(page: Page, fixture: Awaited<ReturnType<typeof startComparisonFixture>>) {
  await page.goto(fixture.url + (fixture.mode === "team" ? "/team" : "/prompts"));
  if (fixture.mode === "team") {
    await page.getByLabel("Setup code").fill(fixture.setupCode); await page.getByLabel("Email", { exact: true }).fill("owner@example.test"); await page.getByLabel("Password").fill("Browser comparison password 2026"); await page.getByRole("button", { name: "Create owner account", exact: true }).click();
    await page.getByLabel("Project name", { exact: true }).fill("Model review"); await page.getByRole("button", { name: "Create project", exact: true }).click(); await expect(page).toHaveURL(/\/team\/projects\/[^/]+$/); await page.getByRole("link", { name: "Prompts", exact: true }).click();
  }
  await expect(page.getByRole("button", { name: "New prompt", exact: true })).toBeEnabled();
  await page.getByLabel("Prompt name", { exact: true }).fill("Release comparison"); await page.getByLabel("Template", { exact: true }).fill("Review {{topic}}."); await page.getByRole("button", { name: "Save prompt", exact: true }).click();
  await expect(page.getByRole("button", { name: "Compile revision 1", exact: true })).toBeEnabled(); await page.getByLabel("topic", { exact: true }).fill("Literal $& {{next}} <img src='https://untrusted.invalid/pixel'>");
  await page.getByRole("button", { name: "Compare models", exact: true }).click(); await expect(page.getByTestId("comparison-workspace").getByLabel("gpt-4.1", { exact: false })).toBeVisible();
}
for (const mode of ["local", "Team"] as const) test(`actual ${mode} saved-revision comparison confirms four native targets, exports output and fits six widths`, async ({ page, comparison }) => {
  test.setTimeout(180000); const errors: string[] = [], foreign: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("request", request => { if (new URL(request.url()).origin !== comparison.url && !request.url().startsWith("blob:")) foreign.push(request.url()); });
  await source(page, comparison); const pane = page.getByTestId("comparison-workspace");
  await expect(pane.getByRole("checkbox", { checked: true })).toHaveCount(0); await expect(pane.getByRole("button", { name: "Run comparison", exact: true })).toBeDisabled();
  for (const model of ["gpt-5.4", "gpt-4.1", "claude-opus-4-6", "claude-sonnet-4-6"]) await pane.getByRole("checkbox", { name: new RegExp(model) }).check();
  await page.getByLabel("Template", { exact: true }).fill("Unsaved replacement is excluded");
  await pane.getByRole("button", { name: "Run comparison", exact: true }).click(); await expect(page.getByRole("alertdialog")).toContainText("Send revision 1"); await expect(page.getByRole("button", { name: "Keep working", exact: true })).toBeFocused(); await page.keyboard.press("Escape"); await expect(pane.getByRole("button", { name: "Run comparison", exact: true })).toBeFocused();
  await pane.getByRole("button", { name: "Run comparison", exact: true }).click(); await page.getByRole("button", { name: "Confirm run comparison", exact: true }).click();
  for (let position = 0; position < 4; position++) await expect(pane.getByTestId(`comparison-output-${position}`)).toContainText("Review Literal $& {{next}} <img");
  await expect(pane.getByText("Controlled HTTP fixture · no paid provider call", { exact: true })).toHaveCount(4); await expect(pane.getByRole("complementary", { name: "Comparison history", exact: true }).getByRole("button", { name: /Release comparison/ })).toContainText("completed / completed / completed / completed"); await expect(page.locator("img[src*='untrusted.invalid']")).toHaveCount(0);
  await pane.getByText("Frozen input and settings", { exact: true }).click(); await expect(pane.locator(".comparison-frozen pre")).not.toContainText("Unsaved replacement");
  const pendingDownload = page.waitForEvent("download"); await pane.getByRole("button", { name: "Export comparison", exact: true }).click(); const exported = JSON.parse(readFileSync((await (await pendingDownload).path())!, "utf8"));
  expect(exported.operation.attempts).toHaveLength(4); expect(exported.operation.request.compiled).toContain("Review Literal $& {{next}}"); expect(exported.operation.attempts.every((row: { payload: { provenance: string; invoiceUsd: null } }) => row.payload.provenance === "controlled-http-fixture" && row.payload.invoiceUsd === null)).toBe(true);
  mkdirSync(comparison.artifactRoot, { recursive: true }); const widths = [360, 390, 768, 1024, 1440, 1920], measurements = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 }); await pane.locator(".comparison-heading").scrollIntoViewIfNeeded(); await page.evaluate(async () => { await document.fonts.ready; }); await page.screenshot({ path: path.join(comparison.artifactRoot, `${comparison.mode}-comparison-${width}.png`), fullPage: true });
    await pane.getByRole("article", { name: "Result gpt-4.1", exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(comparison.artifactRoot, `${comparison.mode}-comparison-results-${width}.png`), fullPage: true });
    const measured = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, accent: getComputedStyle(document.documentElement).getPropertyValue("--rp-accent").trim(), headingFont: getComputedStyle(document.querySelector(".comparison-heading h2")!).fontFamily, minControlHeight: Math.min(...Array.from(document.querySelectorAll(".comparison-workspace button,input:not([type=checkbox])")).map(element => element.getBoundingClientRect().height)) }));
    expect(measured.scrollWidth).toBeLessThanOrEqual(width); expect(measured.accent.toLowerCase()).toBe("#0021cc"); expect(measured.headingFont).toContain("Syne"); expect(measured.minControlHeight).toBeGreaterThanOrEqual(44); measurements.push(measured);
  }
  writeFileSync(path.join(comparison.artifactRoot, `${comparison.mode}-measurements.json`), JSON.stringify({ measurements, errors, foreign, provenance: "Current actual source owner/router/SQLite/default built UI with explicit controlled HTTP provider transport; zero paid calls." }, null, 2));
  await pane.getByRole("button", { name: "Clear comparison content", exact: true }).click(); await expect(page.getByRole("alertdialog")).toContainText("Saved prompts and captured reports remain available"); await page.getByRole("button", { name: "Permanently clear comparisons", exact: true }).click();
  await expect(pane.getByText("Content removed", { exact: true })).toBeVisible(); await expect(pane.getByTestId("comparison-output-0")).toHaveCount(0); await expect(page.getByLabel("Template", { exact: true })).toHaveValue("Unsaved replacement is excluded"); expect(errors).toEqual([]); expect(foreign).toEqual([]);
});
test("actual local held native comparison cancels all targets without refunding started work and source changes discard old results", async ({ page, comparison }) => {
  test.setTimeout(90000); await source(page, comparison); const pane = page.getByTestId("comparison-workspace"); await page.getByLabel("topic", { exact: true }).fill("[hold] bounded native request");
  for (const model of ["gpt-5.4", "gpt-4.1", "claude-opus-4-6", "claude-sonnet-4-6"]) await pane.getByRole("checkbox", { name: new RegExp(model) }).check();
  await pane.getByRole("button", { name: "Run comparison", exact: true }).click(); await page.getByRole("button", { name: "Confirm run comparison", exact: true }).click(); await expect(pane.getByRole("button", { name: "Cancel comparison", exact: true })).toBeVisible();
  await pane.getByRole("button", { name: "Cancel comparison", exact: true }).click(); await expect(pane.locator(".comparison-state")).toHaveText(["cancelled", "cancelled", "cancelled", "cancelled"]); await expect(pane.getByTestId("comparison-output-0")).toHaveCount(0);
  await page.getByLabel("Template", { exact: true }).fill("New immutable {{topic}}"); await page.getByRole("button", { name: "Save new revision", exact: true }).click(); await expect(page.getByRole("button", { name: "Compile revision 2", exact: true })).toBeEnabled(); await expect(pane.getByRole("region", { name: "Comparison results", exact: true })).toHaveCount(0);
});
