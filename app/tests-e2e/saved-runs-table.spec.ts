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
  await expect(page.getByRole("textbox", { name: "Search saved runs" })).toBeFocused();
  await expect.poll(async () => (await (await request.get(`${runPhantom.url}/api/saved-runs`)).json()).events.map((event: { id: string }) => event.id)).toEqual([MISSING_ID]);
  expect((await request.get(`${runPhantom.url}/api/runs/detail/${FIXTURE_PRIMARY_RUN_ID}`)).ok()).toBe(true);
});

test("saved runs: status stays unknown until the run list loads instead of calling runs deleted", async ({ page, request, runPhantom }) => {
  await seedSaved(runPhantom.url, request);
  await page.setViewportSize({ width: 1440, height: 900 });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/api\/runs$/, async route => { await held; await route.continue(); });
  await page.goto(`${runPhantom.url}/saved`);
  const table = page.getByRole("table", { name: "Saved runs", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.locator('[data-saved-status="unknown"]')).toHaveCount(3);
  await expect(page.getByText("No longer in Runs", { exact: true })).toHaveCount(0);
  await expect(page.locator("p", { hasText: "3 saved runs" })).not.toContainText("no longer in Runs");
  await page.getByRole("button", { name: "Open filters" }).click();
  await expect(page.getByRole("combobox", { name: "Filter by status" })).toBeDisabled();
  await page.getByRole("button", { name: "Open filters" }).click();
  release();
  await expect(table.locator(`tr[data-saved-id="${MISSING_ID}"]`)).toContainText("No longer in Runs");
  await expect(table.locator('[data-saved-status="unknown"]')).toHaveCount(0);
});

test("saved runs: a failed removal keeps the dialog open and bulk move files the selection", async ({ page, request, runPhantom }) => {
  await seedSaved(runPhantom.url, request);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${runPhantom.url}/saved`);
  const table = page.getByRole("table", { name: "Saved runs", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await table.locator(`tr[data-saved-id="${FIXTURE_PRIMARY_RUN_ID}"]`).getByRole("checkbox").check();
  await table.locator(`tr[data-saved-id="${FIXTURE_SAVED_SIBLING_RUN_ID}"]`).getByRole("checkbox").check();
  const bar = page.getByRole("region", { name: "Selected saved runs", exact: true });

  await bar.getByRole("button", { name: "Move to folder", exact: true }).click();
  const popover = page.getByRole("dialog", { name: "Move saved run to folder" });
  await popover.getByRole("button", { name: "New folder…" }).click();
  await popover.getByRole("textbox", { name: "New folder name" }).fill("Regressions");
  await popover.getByRole("button", { name: "Move", exact: true }).click();
  await expect(table.locator(`tr[data-saved-id="${FIXTURE_PRIMARY_RUN_ID}"]`)).toContainText("Regressions");
  await expect(table.locator(`tr[data-saved-id="${FIXTURE_SAVED_SIBLING_RUN_ID}"]`)).toContainText("Regressions");
  await expect.poll(async () => ((await (await request.get(`${runPhantom.url}/api/saved-runs`)).json()).events as Array<{ id: string; folder?: string | null }>)
    .filter(event => event.folder === "Regressions").map(event => event.id).sort()).toEqual([FIXTURE_PRIMARY_RUN_ID, FIXTURE_SAVED_SIBLING_RUN_ID].sort());

  await page.route(new RegExp(`/api/saved-runs/events/${FIXTURE_SAVED_SIBLING_RUN_ID}$`), route =>
    route.request().method() === "DELETE" ? route.fulfill({ status: 500, json: { error: "disk full" } }) : route.continue());
  await bar.getByRole("button", { name: "Remove from Saved", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Remove 2 saved runs?", exact: true });
  await dialog.getByRole("button", { name: "Remove 2 saved runs", exact: true }).click();
  const stillOpen = page.getByRole("alertdialog", { name: "Remove 1 saved run?", exact: true });
  await expect(stillOpen.getByRole("alert")).toHaveText("1 of 2 saved runs could not be removed. They are still saved; try again.");
  await stillOpen.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(table.locator(`tr[data-saved-id="${FIXTURE_SAVED_SIBLING_RUN_ID}"]`)).toHaveCount(1);
  await expect(table.locator(`tr[data-saved-id="${FIXTURE_PRIMARY_RUN_ID}"]`)).toHaveCount(0);
  await expect(bar).toContainText("1 saved run selected");
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
