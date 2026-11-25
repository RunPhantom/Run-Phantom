import { expect, test } from "./fixtures";
import { FIXTURE_PRIMARY_RUN_ID, seedRunPhantomFixtures } from "./helpers";

test("saving a run writes a local summary and never calls a provider without consent", async ({ page, request, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  const summaryCalls: string[] = [];
  page.on("request", sent => { if (new URL(sent.url()).pathname === "/api/summarize") summaryCalls.push(sent.url()); });
  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
  const savedUrl = `${runPhantom.url}/api/saved-runs/events/${FIXTURE_PRIMARY_RUN_ID}`;
  await expect.poll(async () => (await (await request.get(savedUrl)).json()).event?.properties?.summary_source).toBe("local");
  const saved = (await (await request.get(savedUrl)).json()).event;
  expect(saved.summary).toMatch(/^(Asked “|agent\.turn run\.)/);

  await page.goto(`${runPhantom.url}/saved/${FIXTURE_PRIMARY_RUN_ID}`);
  const summary = page.getByRole("region", { name: "Saved run summary", exact: true });
  await expect(summary).toContainText(saved.summary);
  await expect(summary).toContainText("Nothing was sent to a provider.");
  await expect(summary.getByRole("button", { name: "Summarize with Anthropic…", exact: true })).toBeDisabled();
  await expect(summary.getByRole("link", { name: "Add one in Settings", exact: true })).toBeVisible();

  expect((await request.put(`${runPhantom.url}/api/secrets/anthropic`, { data: { value: "sk-ant-placeholder-for-consent-test" } })).ok()).toBe(true);
  await page.reload();
  await summary.getByRole("button", { name: "Summarize with Anthropic…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Send this run to Anthropic?", exact: true });
  await expect(dialog).toContainText("claude-haiku-4-5-20251001");
  await expect(dialog).toContainText("up to 1,500 characters each of the input and the output");
  await expect(dialog.getByLabel("Content that will be sent", { exact: true })).toContainText(`Event: ${saved.event_name}`);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(summaryCalls).toEqual([]);
});
