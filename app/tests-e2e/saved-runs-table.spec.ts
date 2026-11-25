import { readFileSync } from "node:fs";
import { expect, test } from "./fixtures";
import { FIXTURE_PRIMARY_RUN_ID, FIXTURE_SAVED_SIBLING_RUN_ID, saveRunPhantomRun, seedRunPhantomFixtures } from "./helpers";

const MISSING_ID = "saved-run-no-longer-local";

async function seedSaved(url: string, request: import("@playwright/test").APIRequestContext) {
  await seedRunPhantomFixtures(url);
  await saveRunPhantomRun(url, FIXTURE_PRIMARY_RUN_ID);
  await saveRunPhantomRun(url, FIXTURE_SAVED_SIBLING_RUN_ID);
  expect((await request.put(`${url}/api/saved-runs/events/${MISSING_ID}`, { data: {
    event_name: "deleted_agent", timestamp: new Date().toISOString(), user_input: "A run that was deleted after saving", summary: "Deleted run summary.",
    folder: "Archive", properties: { summary_source: "provider" },
  } })).ok()).toBe(true);
}

test("saved runs: a full-width table shows status, model and cost, filters by status and opens a run", async ({ page, request, runPhantom }) => {
  await seedSaved(runPhantom.url, request);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${runPhantom.url}/saved`);
  await expect(page.getByRole("heading", { name: "Saved runs", exact: true })).toBeVisible();
  const table = page.getByRole("table", { name: "Saved runs", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.getByRole("columnheader")).toHaveText(["", "Status", "Run", "Model", "Cost", "Note", "Folder", "Saved"]);
  const missing = table.locator(`tr[data-saved-id="${MISSING_ID}"]`);
  await expect(missing).toContainText("No longer in Runs");
  await expect(missing).toContainText("Deleted run summary.");
  await expect(missing).toContainText("Archive");
  await expect(table.locator(`tr[data-saved-id="${FIXTURE_PRIMARY_RUN_ID}"] [data-saved-status]`)).toHaveCount(1);
  const summary = page.locator("p", { hasText: "no longer in Runs" });
  await expect(summary).toContainText("3 saved runs");
  await expect(summary).toContainText("1 no longer in Runs");

  await page.getByRole("button", { name: "Open filters" }).click();
  await page.getByRole("combobox", { name: "Filter by status" }).selectOption("missing");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Clear status filter" })).toBeVisible();
  await page.getByRole("button", { name: "Clear status filter" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(3);

  await table.locator(`tr[data-saved-id="${FIXTURE_PRIMARY_RUN_ID}"]`).getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/saved/${FIXTURE_PRIMARY_RUN_ID}$`));
  await expect(page.getByRole("region", { name: "Saved run summary", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "All saved runs", exact: true }).click();
  await expect(page).toHaveURL(new RegExp("/saved$"));
  await expect(table).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
});

test("saved runs: bulk export bundles traces and bulk removal asks first and keeps the runs", async ({ page, request, runPhantom }, testInfo) => {
  await seedSaved(runPhantom.url, request);
  await page.goto(`${runPhantom.url}/saved`);
  const table = page.getByRole("table", { name: "Saved runs", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await table.getByRole("checkbox", { name: "Select all shown saved runs" }).check();
  const bar = page.getByRole("region", { name: "Selected saved runs", exact: true });
  await expect(bar).toContainText("3 saved runs selected");

  const downloading = page.waitForEvent("download");
  await bar.getByRole("button", { name: "Export JSON", exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^runphantom-saved-runs-[\d-]+\.json$/);
  const file = testInfo.outputPath("saved.json");
  await download.saveAs(file);
  const bundle = JSON.parse(readFileSync(file, "utf8")) as { format: string; savedRuns: Array<{ saved: { id: string }; traceSource: string; trace: { format?: string } | null }> };
  expect(bundle.format).toBe("runphantom-saved-runs/v1");
  const byId = new Map(bundle.savedRuns.map(entry => [entry.saved.id, entry]));
  expect(byId.get(FIXTURE_PRIMARY_RUN_ID)).toMatchObject({ traceSource: "local", trace: { format: expect.stringMatching(/^runphantom-trace\//) } });
  expect(byId.get(MISSING_ID)).toMatchObject({ traceSource: "unavailable", trace: null });
  await expect(page.getByRole("status").filter({ hasText: "Exported 3 saved runs; 1 run had no trace left to include" })).toBeAttached();

  await table.locator(`tr[data-saved-id="${MISSING_ID}"]`).getByRole("checkbox").uncheck();
  await bar.getByRole("button", { name: "Remove from Saved", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Remove 2 saved runs?", exact: true });
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await dialog.getByRole("button", { name: "Remove 2 saved runs", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect.poll(async () => (await (await request.get(`${runPhantom.url}/api/saved-runs`)).json()).events.map((event: { id: string }) => event.id)).toEqual([MISSING_ID]);
  expect((await request.get(`${runPhantom.url}/api/runs/detail/${FIXTURE_PRIMARY_RUN_ID}`)).ok()).toBe(true);
});

test("saved runs: the empty page teaches how to save and links to Runs", async ({ page, runPhantom }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${runPhantom.url}/saved`);
  await expect(page.getByRole("heading", { name: "Keep the runs worth coming back to.", exact: true })).toBeVisible();
  for (const step of ["Open a run", "Choose Save", "Come back here"]) await expect(page.getByText(step, { exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Saved runs" })).toHaveCount(0);
  await page.getByRole("link", { name: /^(Open|Go to) Runs$/ }).click();
  await expect(page).toHaveURL(/\/runs$/);
});
