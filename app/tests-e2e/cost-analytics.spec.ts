import { test as base, type APIRequestContext, type Page } from "@playwright/test";
import { expect, test as sourceTest } from "./fixtures";
import { clearRunPhantom } from "./helpers";
import { startTeamFixture, type TeamFixture } from "../../tests/helpers/team-server";
import { rateFixture } from "../../tests/fixtures/pricing";

const compiledUrl = process.env.RUNPHANTOM_COMPILED_URL;
if (compiledUrl) {
  const url = new URL(compiledUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) throw new Error("Cost analytics compiled journeys require an isolated loopback daemon");
}
const test = compiledUrl ? sourceTest.extend({ runPhantom: async ({}, use) => { await use({ url: compiledUrl, port: Number(new URL(compiledUrl).port), dbPath: "isolated-compiled-runtime" }); } }) : sourceTest;
const teamTest = base.extend<{ team: TeamFixture }>({ team: async ({}, use) => { const team = await startTeamFixture("cost-analytics-browser", process.env.RUNPHANTOM_TEAM_TEST_BINARY); try { await use(team); } finally { await team.close(); } } });
const traceId = "0000000000000000000000000000f150";
const catalogueUrl = "https://openrouter.ai/api/v1/models";
const catalogue = JSON.stringify({ data: [{ id: "fixture/fixture-model", pricing: { prompt: "0.000003", completion: "0.000015" } }] });
const rates = JSON.stringify([rateFixture()]);

function capture() {
  const now = Date.now() - 1_000;
  return { resourceSpans: [{ scopeSpans: [{ spans: [{ model: "fixture-model", input: 200, output: 300, cost: .123 }, { model: "unpriced-model", input: 100, output: 50, cost: null }, { model: "fixture-model", input: 0, output: 0, cost: 0 }].map((row, index) => ({ traceId, spanId: (0xf150 + index).toString(16).padStart(16, "0"), name: "Synthetic cost analytics", startTimeUnixNano: String(BigInt(now + index * 10) * 1_000_000n), endTimeUnixNano: String(BigInt(now + index * 10 + 5) * 1_000_000n), status: { code: 1 },
    attributes: Object.entries({ "runphantom.span.kind": "llm_call", "gen_ai.response.model": row.model, "gen_ai.provider.name": "fixture-provider", "runphantom.usage.tier": "standard", "gen_ai.usage.input_tokens": row.input, "gen_ai.usage.output_tokens": row.output, ...(row.cost === null ? {} : { "gen_ai.usage.cost_usd": row.cost }) }).map(([key, value]) => ({ key, value: typeof value === "number" ? { doubleValue: value } : { stringValue: value } })),
  })) }] }] };
}
async function seed(request: APIRequestContext, url: string) {
  const response = await request.post(`${url}/v1/traces`, { data: capture() }); expect(response.ok()).toBe(true);
}
async function applyManual(page: Page) {
  await page.getByRole("combobox", { name: "Estimate source", exact: true }).selectOption("manual");
  await page.getByLabel("Frozen rate JSON", { exact: true }).fill(rates);
  await page.getByRole("button", { name: "Apply frozen rates", exact: true }).click();
  await expect(page.getByTestId("estimated-cost")).toContainText("$0.0051");
}
async function outputAssertions(page: Page) {
  await expect(page.getByTestId("reported-cost")).toContainText("$0.123");
  await expect(page.getByTestId("reported-cost")).toContainText("2 known · 1 unavailable");
  await expect(page.getByTestId("estimated-cost")).toContainText("2 known · 1 unavailable");
  await expect(page.getByRole("region", { name: "Cost breakdown table" }).getByRole("rowheader", { name: "unpriced-model", exact: true })).toBeVisible();
  const categories = page.getByRole("region", { name: "Categorized usage" });
  await expect(categories).toContainText("cache read"); await expect(categories).toContainText("reasoning"); await expect(categories).toContainText("audio output");
  await expect(categories).toContainText("0 known · 3 unavailable");
}

test.describe("local cost analytics journeys", () => {
test.beforeEach(async ({ runPhantom }, info) => {
  await clearRunPhantom(runPhantom.url);
  await info.attach("Cost analytics runtime", { body: JSON.stringify({ runtime: compiledUrl ? "copied-compiled" : "source", capture: "synthetic-stored-OTLP", rates: "synthetic-frozen", providerSpendUsd: 0 }), contentType: "application/json" });
});

test("cost analytics: actual navigation/manual rates preserve reported snapshots and unknown rows", async ({ page, runPhantom }, info) => {
  await seed(page.request, runPhantom.url);
  const detailResponse = await page.request.get(`${runPhantom.url}/api/runs/detail/${traceId}`); expect(detailResponse.ok()).toBe(true); const beforeDetail = await detailResponse.json();
  const snapshotResponse = await page.request.get(`${runPhantom.url}/api/evaluations/runs/${traceId}/snapshot`); expect(snapshotResponse.ok()).toBe(true); const beforeSnapshot = await snapshotResponse.json(); expect(beforeSnapshot.metrics.costUsd).toBeNull(); expect(beforeDetail.spans).toHaveLength(3);
  expect(beforeDetail.spans.map((span: { attributes: string }) => JSON.parse(span.attributes)["gen_ai.usage.cost_usd"])).toEqual([.123, undefined, 0]);
  let externalRequests = 0; await page.route(catalogueUrl, async route => { externalRequests++; await route.abort(); });
  await page.goto(`${runPhantom.url}/runs`);
  await page.getByRole("link", { name: "Cost & usage", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Cost & usage", exact: true })).toBeVisible();
  await expect(page.getByTestId("estimated-cost")).toContainText("Unavailable");
  await applyManual(page); await outputAssertions(page);
  await page.getByRole("combobox", { name: "Group by", exact: true }).selectOption("byProvider");
  await expect(page.getByRole("region", { name: "Cost breakdown table" }).getByRole("rowheader", { name: "fixture-provider", exact: true })).toBeVisible();
  await page.getByText("Rate and capture provenance", { exact: true }).click();
  await expect(page.getByText("Revision fixture-rate-1 · runphantom-pricing/1", { exact: true })).toBeVisible();
  expect(externalRequests).toBe(0);
  const afterDetailResponse = await page.request.get(`${runPhantom.url}/api/runs/detail/${traceId}`); expect(afterDetailResponse.ok()).toBe(true); const afterDetail = await afterDetailResponse.json();
  const afterSnapshotResponse = await page.request.get(`${runPhantom.url}/api/evaluations/runs/${traceId}/snapshot`); expect(afterSnapshotResponse.ok()).toBe(true); const afterSnapshot = await afterSnapshotResponse.json();
  expect(afterDetail.spans).toEqual(beforeDetail.spans); expect(afterSnapshot.metrics).toEqual(beforeSnapshot.metrics); expect(afterSnapshot.models).toEqual(beforeSnapshot.models);
  await page.getByTestId("reported-cost").scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath("cost-analytics-manual-desktop.png"), fullPage: true });
});

test("cost analytics: consented nominal quote is explicit and revocation removes it", async ({ page, context, runPhantom }, info) => {
  await seed(page.request, runPhantom.url);
  let catalogueRequests = 0; await page.route(catalogueUrl, async route => { catalogueRequests++; await route.fulfill({ contentType: "application/json", body: catalogue }); });
  await page.goto(`${runPhantom.url}/costs`); await page.getByRole("combobox", { name: "Estimate source", exact: true }).selectOption("nominal");
  await expect(page.getByText(/Public pricing is disabled/)).toBeVisible(); expect(catalogueRequests).toBe(0);
  await page.getByRole("link", { name: /^settings$/i }).click(); await page.getByRole("checkbox", { name: /fetch public model pricing/i }).check();
  await page.getByRole("link", { name: "Cost & usage", exact: true }).click(); await page.getByRole("combobox", { name: "Estimate source", exact: true }).selectOption("nominal");
  await expect(page.getByTestId("estimated-cost")).toContainText("$0.0051"); await outputAssertions(page);
  await page.getByText("Rate and capture provenance", { exact: true }).click(); await expect(page.getByText(/Nominal public input\/output catalogue estimate/)).toBeVisible();
  await expect(page.getByText("fixture/fixture-model", { exact: true })).toBeVisible(); expect(catalogueRequests).toBe(1);
  await page.getByTestId("reported-cost").scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath("cost-analytics-nominal-desktop.png"), fullPage: true });
  const settings = await context.newPage(); await settings.goto(`${runPhantom.url}/settings`); await settings.getByRole("checkbox", { name: /fetch public model pricing/i }).uncheck();
  await expect(page.getByText(/Public pricing is disabled/)).toBeVisible(); await expect(page.getByTestId("estimated-cost")).toHaveCount(0); expect(catalogueRequests).toBe(1); await settings.close();
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
  test(`cost analytics: keyboard and bounded layout ${viewport.width}x${viewport.height}`, async ({ page, runPhantom }, info) => {
    await page.setViewportSize(viewport); await seed(page.request, runPhantom.url); await page.goto(`${runPhantom.url}/costs`); await applyManual(page); await outputAssertions(page);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("combobox", { name: "Time window", exact: true }).focus(); await page.keyboard.press("Tab"); await expect(page.getByRole("combobox", { name: "Estimate source", exact: true })).toBeFocused();
    expect(await page.getByRole("button", { name: "Apply frozen rates", exact: true }).evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await page.emulateMedia({ reducedMotion: "reduce" }); await page.screenshot({ path: info.outputPath(`cost-analytics-controls-${viewport.width}x${viewport.height}.png`), fullPage: true });
    await page.getByTestId("reported-cost").scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`cost-analytics-${viewport.width}x${viewport.height}.png`), fullPage: true });
  });
}
});

teamTest("cost analytics: actual private project/UI and revoked viewer never fall back to local data", async ({ page, browser, team }, info) => {
  const localRequests: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/") && !path.startsWith("/api/team/")) localRequests.push(path); });
  await page.goto(`${team.url}/team`); await page.getByLabel("Setup code").fill(team.setupCode); await page.getByLabel("Email", { exact: true }).fill("cost-owner@example.test"); await page.getByLabel("Password").fill("Synthetic cost workspace 2026"); await page.getByRole("button", { name: "Create owner account", exact: true }).click();
  await page.getByLabel("Project name", { exact: true }).fill("Synthetic cost project"); await page.getByRole("button", { name: "Create project", exact: true }).click(); await expect(page).toHaveURL(/\/team\/projects\/[^/]+$/);
  const projectId = new URL(page.url()).pathname.split("/")[3];
  const session = await (await page.request.get(`${team.url}/api/team/session`)).json();
  const mutate = (path: string, data?: unknown, method = "POST") => page.request.fetch(`${team.url}/api/team${path}`, { method, headers: { Origin: team.url, "X-RunPhantom-CSRF": session.csrfToken }, ...(data === undefined ? {} : { data }) });
  const keyResponse = await mutate(`/projects/${projectId}/keys`, { label: "Synthetic pricing producer" }); expect(keyResponse.ok()).toBe(true); const key = (await keyResponse.json()).token;
  const ingest = await page.request.post(`${team.url}/api/team/ingest/v1/traces`, { headers: { Authorization: `Bearer ${key}` }, data: capture() }); expect(ingest.ok()).toBe(true);
  await page.getByRole("link", { name: "Cost & usage", exact: true }).click(); await applyManual(page); await outputAssertions(page);
  await page.getByRole("combobox", { name: "Group by", exact: true }).selectOption("byProject"); await expect(page.getByRole("rowheader", { name: projectId, exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("cost-analytics-team-project.png"), fullPage: true });
  const invitation = await mutate(`/projects/${projectId}/invites`, { email: "cost-viewer@example.test", role: "viewer" }); expect(invitation.ok()).toBe(true); const invitationToken = (await invitation.json()).token;
  const viewerContext = await browser.newContext(); const viewer = await viewerContext.newPage();
  const accepted = await viewerContext.request.post(`${team.url}/api/team/invites/accept`, { headers: { Origin: team.url }, data: { token: invitationToken, email: "cost-viewer@example.test", password: "Synthetic viewer password 2026" } }); expect(accepted.ok()).toBe(true); const viewerSession = await accepted.json();
  await viewer.goto(`${team.url}/team/projects/${projectId}/costs`); await expect(viewer.getByTestId("reported-cost")).toContainText("$0.123");
  const revoked = await mutate(`/projects/${projectId}/members/${viewerSession.session.user.id}`, undefined, "DELETE"); expect(revoked.status()).toBe(204);
  await viewer.getByRole("button", { name: "Refresh", exact: true }).click(); await expect(viewer.getByRole("heading", { name: "Cost & usage", exact: true })).toHaveCount(0);
  await expect(viewer.getByTestId("reported-cost")).toHaveCount(0); expect(localRequests).toEqual([]); await viewerContext.close();
  await info.attach("Team analytics runtime", { body: JSON.stringify({ runtime: process.env.RUNPHANTOM_TEAM_TEST_BINARY ? "copied-compiled-private-team" : "source-private-team", capture: "synthetic-stored-OTLP", providerSpendUsd: 0 }), contentType: "application/json" });
});
