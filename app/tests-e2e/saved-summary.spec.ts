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
  expect(saved.properties.local_summary).toBe(saved.summary);

  await page.goto(`${runPhantom.url}/saved/${FIXTURE_PRIMARY_RUN_ID}`);
  const summary = page.getByRole("region", { name: "Saved run summary", exact: true });
  await expect(summary).toContainText(saved.summary);
  await expect(summary).toContainText("Nothing was sent to a provider.");
  await expect(summary.getByRole("button", { name: "Summarize with Anthropic…", exact: true })).toBeDisabled();
  await expect(summary.getByRole("link", { name: "Settings", exact: true })).toBeVisible();

  expect((await request.put(`${runPhantom.url}/api/secrets/anthropic`, { data: { value: "sk-ant-placeholder-for-consent-test" } })).ok()).toBe(true);
  await page.reload();
  await summary.getByRole("button", { name: "Summarize with Anthropic…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Send this run to Anthropic?", exact: true });
  await expect(dialog).toContainText("claude-haiku-4-5-20251001");
  await expect(dialog).toContainText("the steps recorded on this machine, signal names, and up to 1,500 characters each of the input and the output");
  const preview = dialog.getByLabel("Content that will be sent", { exact: true });
  await expect(preview).toContainText(`Event: ${saved.event_name}`);
  await expect(preview).toContainText(`Recorded steps: ${saved.summary}`);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const trigger = summary.getByRole("button", { name: "Summarize with Anthropic…", exact: true });
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(summaryCalls).toEqual([]);
});

test("a saved run with a secret in its input previews the excerpt with the secret removed", async ({ page, request, runPhantom }) => {
  const secret = `sk-proj-${"Q7w8E9r0".repeat(4)}`;
  const id = "saved-summary-secret";
  expect((await request.put(`${runPhantom.url}/api/saved-runs/events/${id}`, { data: {
    event_name: "deploy_agent", timestamp: new Date().toISOString(), user_input: `Deploy with key ${secret}`, assistant_output: "Deployed.",
    summary: "Asked “Deploy with key”.", properties: { summary_source: "local", local_summary: "Asked “Deploy with key”." },
  } })).ok()).toBe(true);
  expect((await request.put(`${runPhantom.url}/api/saved-runs/events/legacy-summary`, { data: {
    event_name: "legacy_agent", timestamp: new Date().toISOString(), user_input: "Old question", summary: "Old summary text.",
  } })).ok()).toBe(true);
  expect((await request.put(`${runPhantom.url}/api/secrets/anthropic`, { data: { value: "sk-ant-placeholder-for-consent-test" } })).ok()).toBe(true);

  await page.goto(`${runPhantom.url}/saved/${id}`);
  const summary = page.getByRole("region", { name: "Saved run summary", exact: true });
  await summary.getByRole("button", { name: "Summarize with Anthropic…", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Send this run to Anthropic?", exact: true }).getByLabel("Content that will be sent", { exact: true });
  await expect(preview).toContainText("User: Deploy with key [REDACTED]");
  await expect(preview).not.toContainText(secret);
  await page.keyboard.press("Escape");

  // Summaries saved before the source was recorded may have come from a provider, so make no privacy claim.
  await page.goto(`${runPhantom.url}/saved/legacy-summary`);
  await expect(summary).toContainText("Old summary text.");
  await expect(summary).toContainText("Saved before Run Phantom recorded where summaries come from.");
  await expect(summary).not.toContainText("Nothing was sent to a provider.");
});
