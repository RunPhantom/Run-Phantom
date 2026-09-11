import { expect, test } from "@playwright/test";
import { FIXTURE_PRIMARY_RUN_ID, seedRunPhantomFixtures } from "./helpers";

// Opt in only against an isolated daemon with synthetic traces and its own provider credentials.
const liveUrl = process.env.RUNPHANTOM_LIVE_URL;
test.use({ screenshot: "off", trace: "off", video: "off" });
test.describe.configure({ timeout: 180_000 });
test.beforeEach(() => {
  test.skip(process.env.RUNPHANTOM_LIVE_TESTS !== "1" || !liveUrl, "Requires an explicitly configured isolated live-provider daemon");
});

test("live providers: OpenAI streams a reply and a follow-up through the demo UI", async ({ page, request }) => {
  const configured = await request.get(`${liveUrl}/api/secrets`);
  expect((await configured.json()).keys.openai.configured).toBe(true);
  await page.goto(`${liveUrl}/demo-chat`);
  for (const prompt of ["In one sentence, what can a local agent trace explain?", "Which single trace detail would you inspect first?"]) {
    const before = await page.locator("#log .assistant").count();
    await page.getByLabel("Prompt", { exact: true }).fill(prompt);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Reply complete.", { timeout: 120_000 });
    expect(await page.locator("#log .assistant").count()).toBe(before + 1);
    expect((await page.locator("#log .assistant").last().textContent())?.trim().length).toBeGreaterThan(10);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  }
});

test("live providers: saving a synthetic run in the UI persists an Anthropic summary", async ({ page, request }) => {
  await seedRunPhantomFixtures(liveUrl!);
  const configured = await request.get(`${liveUrl}/api/secrets`);
  expect((await configured.json()).keys.anthropic.configured).toBe(true);
  await page.goto(`${liveUrl}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  const summaryResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/summarize", { timeout: 120_000 });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const result = await (await summaryResponse).json();
  expect(typeof result.summary).toBe("string");
  expect(result.summary?.length).toBeGreaterThan(10);
  await expect.poll(async () => {
    const response = await request.get(`${liveUrl}/api/saved-runs/events/${FIXTURE_PRIMARY_RUN_ID}`);
    const saved = await response.json();
    return saved.event?.summary === result.summary;
  }, { timeout: 10_000 }).toBe(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
});
