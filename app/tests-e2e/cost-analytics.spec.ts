import { test as base, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { expect, test } from "./fixtures";
import { clearRunPhantom } from "./helpers";
import { startTeamFixture, type TeamFixture } from "../../tests/helpers/team-server";
import { rateFixture } from "../../tests/fixtures/pricing";
import type { CostAnalyticsReport } from "../../src/pricing/analytics";

if (process.env.RUNPHANTOM_COMPILED_URL !== undefined) throw new Error("RUNPHANTOM_COMPILED_URL cannot establish runtime provenance. Use RUNPHANTOM_E2E_RUNTIME=installed with RUNPHANTOM_E2E_BINARY and RUNPHANTOM_E2E_SHA256.");
const teamTest = base.extend<{ team: TeamFixture }>({ team: async ({}, use) => { const team = await startTeamFixture("cost-analytics-browser", process.env.RUNPHANTOM_TEAM_TEST_BINARY); try { await use(team); } finally { await team.close(); } } });
const traceId = "0000000000000000000000000000f150";
const catalogueUrl = "https://openrouter.ai/api/v1/models";
const catalogue = JSON.stringify({ data: [{ id: "fixture/fixture-model", pricing: { prompt: "0.000003", completion: "0.000015" } }] });
const rates = JSON.stringify([rateFixture()]);

function capture(missingParent = false) {
  const now = Date.now() - 1_000;
  return { resourceSpans: [{ scopeSpans: [{ spans: [{ model: "fixture-model", input: 200, output: 300, cost: .123 }, { model: "unpriced-model", input: 100, output: 50, cost: null }, { model: "fixture-model", input: 0, output: 0, cost: 0 }].map((row, index) => ({ traceId, spanId: (0xf150 + index).toString(16).padStart(16, "0"), ...(missingParent && index === 0 ? { parentSpanId: "a".repeat(16) } : {}), name: "Synthetic cost analytics", startTimeUnixNano: String(BigInt(now + index * 10) * 1_000_000n), endTimeUnixNano: String(BigInt(now + index * 10 + 5) * 1_000_000n), status: { code: 1 },
    attributes: Object.entries({ "runphantom.span.kind": "llm_call", "gen_ai.response.model": row.model, "gen_ai.provider.name": "fixture-provider", "runphantom.usage.tier": "standard", "gen_ai.usage.input_tokens": row.input, "gen_ai.usage.output_tokens": row.output, ...(row.cost === null ? {} : { "gen_ai.usage.cost_usd": row.cost }) }).map(([key, value]) => ({ key, value: typeof value === "number" ? { doubleValue: value } : { stringValue: value } })),
  })) }] }] };
}
async function seed(request: APIRequestContext, url: string) {
  const response = await request.post(`${url}/v1/traces`, { data: capture() }); expect(response.ok()).toBe(true);
}
async function applyManual(page: Page) {
  await page.getByRole("combobox", { name: "Estimate source", exact: true }).selectOption("manual");
  await page.getByRole("textbox", { name: "Frozen rate JSON", exact: true }).fill(rates);
  await page.getByRole("button", { name: "Apply frozen rates", exact: true }).click();
  await expect(page.getByTestId("estimated-cost")).toContainText("$0.0051");
}
async function downloadAnalytics(page: Page): Promise<{ filename: string; report: CostAnalyticsReport }> {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON", exact: true }).click();
  const download = await pending;
  return { filename: download.suggestedFilename(), report: JSON.parse(readFileSync((await download.path())!, "utf8")) };
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
  await info.attach("Cost analytics runtime", { body: JSON.stringify({ runtime: runPhantom.runtime.mode, capture: "synthetic-stored-OTLP", rates: "synthetic-frozen", providerSpendUsd: 0 }), contentType: "application/json" });
});

test("cost analytics: navigation, reload and JSON export preserve reported snapshots and unknown rows", async ({ page, runPhantom }, info) => {
  await seed(page.request, runPhantom.url);
  const detailResponse = await page.request.get(`${runPhantom.url}/api/runs/detail/${traceId}`); expect(detailResponse.ok()).toBe(true); const beforeDetail = await detailResponse.json();
  const snapshotResponse = await page.request.get(`${runPhantom.url}/api/evaluations/runs/${traceId}/snapshot`); expect(snapshotResponse.ok()).toBe(true); const beforeSnapshot = await snapshotResponse.json(); expect(beforeSnapshot.metrics.costUsd).toBeNull(); expect(beforeDetail.spans).toHaveLength(3);
  expect(beforeDetail.spans.map((span: { attributes: string }) => JSON.parse(span.attributes)["gen_ai.usage.cost_usd"])).toEqual([.123, undefined, 0]);
  let externalRequests = 0; await page.route(catalogueUrl, async route => { externalRequests++; await route.abort(); });
  await page.goto(`${runPhantom.url}/runs`);
  await page.getByRole("link", { name: "Cost & usage", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Cost & usage", exact: true })).toBeVisible();
  await expect(page.getByTestId("estimated-cost")).toContainText("Unavailable");
  const manualResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/pricing/analytics" && response.request().method() === "POST" && response.request().postDataJSON().rates.length === 1);
  await applyManual(page); await outputAssertions(page);
  const displayed: CostAnalyticsReport = await (await manualResponse).json();
  const exported = await downloadAnalytics(page);
  expect(exported.filename).toBe(`runphantom-cost-analytics-local-${displayed.window.to}.json`);
  expect(exported.report).toEqual(displayed);
  expect(exported.report.reportedUsd).toMatchObject({ knownSum: .123, knownCount: 2, unavailableCount: 1, zeroCount: 1, completeTotal: null });
  expect(exported.report.rateRevisions).toEqual([rateFixture()]);
  expect(exported.report.rateAuthority).toBe("request-declared");
  await page.getByRole("combobox", { name: "Group by", exact: true }).selectOption("byProvider");
  await expect(page.getByRole("region", { name: "Cost breakdown table" }).getByRole("rowheader", { name: "fixture-provider", exact: true })).toBeVisible();
  await page.getByText("Rate and capture provenance", { exact: true }).click();
  await expect(page.getByText("Revision fixture-rate-1 · runphantom-pricing/1", { exact: true })).toBeVisible();
  expect(externalRequests).toBe(0);
  await page.getByTestId("reported-cost").scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath("cost-analytics-manual-desktop.png"), fullPage: true });
  const reloadedResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/pricing/analytics" && response.request().method() === "POST" && response.request().postDataJSON().rates.length === 0);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Estimate source", exact: true })).toHaveValue("reported");
  await expect(page.getByTestId("reported-cost")).toContainText("$0.123");
  await expect(page.getByTestId("estimated-cost")).toContainText("Unavailable");
  const reloaded: CostAnalyticsReport = await (await reloadedResponse).json();
  expect((await downloadAnalytics(page)).report).toEqual(reloaded);
  expect(reloaded.reportedUsd).toEqual(displayed.reportedUsd);
  expect(reloaded.rateRevisions).toEqual([]);
  const afterDetailResponse = await page.request.get(`${runPhantom.url}/api/runs/detail/${traceId}`); expect(afterDetailResponse.ok()).toBe(true); const afterDetail = await afterDetailResponse.json();
  const afterSnapshotResponse = await page.request.get(`${runPhantom.url}/api/evaluations/runs/${traceId}/snapshot`); expect(afterSnapshotResponse.ok()).toBe(true); const afterSnapshot = await afterSnapshotResponse.json();
  expect(afterDetail.spans).toEqual(beforeDetail.spans); expect(afterSnapshot.metrics).toEqual(beforeSnapshot.metrics); expect(afterSnapshot.models).toEqual(beforeSnapshot.models);
});

test("cost analytics: export refuses draft rates, pending calculations and changed captures", async ({ page, runPhantom }) => {
  const original = capture();
  const seeded = await page.request.post(`${runPhantom.url}/v1/traces`, { data: original }); expect(seeded.ok()).toBe(true);
  await page.goto(`${runPhantom.url}/costs`); await applyManual(page);
  const exportButton = page.getByRole("button", { name: "Export JSON", exact: true });
  await expect(exportButton).toBeEnabled();
  await page.getByRole("textbox", { name: "Frozen rate JSON", exact: true }).fill("invalid draft");
  await expect(exportButton).toBeDisabled();
  await page.getByRole("button", { name: "Apply frozen rates", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Nothing was applied.");
  await expect(exportButton).toBeDisabled();
  const changedRates = JSON.stringify([{ ...rateFixture(), revision: "fixture-rate-2" }]);
  await page.getByRole("textbox", { name: "Frozen rate JSON", exact: true }).fill(changedRates);
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const pending = new Promise<void>(resolve => { entered = resolve; });
  await page.route(`${runPhantom.url}/api/pricing/analytics`, async route => {
    const response = await route.fetch();
    entered(); await held;
    await route.fulfill({ response });
  }, { times: 1 });
  await page.getByRole("button", { name: "Apply frozen rates", exact: true }).click();
  await pending;
  try {
    await expect(page.getByText("Loading captured cost and usage…", { exact: true })).toBeVisible();
    await expect(page.locator("button:enabled").filter({ hasText: /^Export JSON$/ })).toHaveCount(0);
  } finally { release(); }
  await expect(exportButton).toBeEnabled();
  const downloads: string[] = [];
  page.on("download", download => { downloads.push(download.suggestedFilename()); });
  const reported = original.resourceSpans[0].scopeSpans[0].spans[0].attributes.find(attribute => attribute.key === "gen_ai.usage.cost_usd");
  if (!reported) throw new Error("Synthetic capture must contain a reported cost");
  reported.value = { doubleValue: .234 };
  const changed = await page.request.post(`${runPhantom.url}/v1/traces`, { data: original }); expect(changed.ok()).toBe(true);
  await exportButton.click();
  await expect(page.getByRole("alert")).toHaveText("Captured cost and usage changed. Refresh this view before exporting.");
  expect(downloads).toEqual([]);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByTestId("reported-cost")).toContainText("$0.234");
  const refreshed = await downloadAnalytics(page);
  expect(refreshed.report.reportedUsd.knownSum).toBe(.234);
  expect(refreshed.report.rateRevisions[0].revision).toBe("fixture-rate-2");
  expect(downloads).toHaveLength(1);
});

test("cost analytics: unavailable ancestry is labelled as timed generation candidates", async ({ page, runPhantom }, info) => {
  const captured = await page.request.post(`${runPhantom.url}/v1/traces`, { data: capture(true) }); expect(captured.ok()).toBe(true);
  const beforeDetail = await (await page.request.get(`${runPhantom.url}/api/runs/detail/${traceId}`)).json();
  const to = Date.now();
  const analytics = await page.request.post(`${runPhantom.url}/api/pricing/analytics`, { data: { from: to - 86_400_000, to, bucket: "hour", estimateMode: "captured", rates: [] } }); expect(analytics.ok()).toBe(true);
  const report = await analytics.json();
  expect(report.population).toMatchObject({ selectedGenerations: 3, nestedExcluded: 0, ancestryUnavailable: 1 });
  expect(report.reportedUsd).toMatchObject({ eligibleCount: 3, knownCount: 1, unavailableCount: 2, zeroCount: 1, knownSum: 0, completeTotal: null });
  await page.goto(`${runPhantom.url}/costs`);
  await expect(page.getByText("3 timed generation candidates · 0 nested generations excluded · 0 with unavailable timestamps · 1 with unavailable ancestry", { exact: true })).toBeVisible();
  await expect(page.getByText(/timed top-level generations/)).toHaveCount(0);
  await expect(page.getByTestId("reported-cost")).toContainText("1 known · 2 unavailable");
  await expect(page.getByText("Known subtotal; complete reported spend unavailable.", { exact: false })).toBeVisible();
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`cost-analytics-ancestry-${viewport.width}x${viewport.height}.png`), fullPage: true });
  }
  const afterDetail = await (await page.request.get(`${runPhantom.url}/api/runs/detail/${traceId}`)).json(); expect(afterDetail.spans).toEqual(beforeDetail.spans);
  await info.attach("Unavailable ancestry population", { body: JSON.stringify({ population: report.population, reportedUsd: report.reportedUsd, originalCapturePreserved: true, providerSpendUsd: 0 }), contentType: "application/json" });
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
  const ownerExport = await downloadAnalytics(page);
  expect(ownerExport.report.scope).toEqual({ kind: "team", projectId });
  expect(ownerExport.report.rateRevisions).toEqual([rateFixture()]);
  await page.screenshot({ path: info.outputPath("cost-analytics-team-project.png"), fullPage: true });
  const invitation = await mutate(`/projects/${projectId}/invites`, { email: "cost-viewer@example.test", role: "viewer" }); expect(invitation.ok()).toBe(true); const invitationToken = (await invitation.json()).token;
  const viewerContext = await browser.newContext(); const viewer = await viewerContext.newPage();
  try {
    const viewerLocalRequests: string[] = [];
    viewer.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/") && !path.startsWith("/api/team/")) viewerLocalRequests.push(path); });
    const detectorProbe = "/api/local-fallback-observer-probe";
    await viewer.route(`${team.url}${detectorProbe}`, route => route.fulfill({ contentType: "application/json", body: "{}" }));
    const accepted = await viewerContext.request.post(`${team.url}/api/team/invites/accept`, { headers: { Origin: team.url }, data: { token: invitationToken, email: "cost-viewer@example.test", password: "Synthetic viewer password 2026" } }); expect(accepted.ok()).toBe(true); const viewerSession = await accepted.json();
    await viewer.goto(`${team.url}/team/projects/${projectId}/costs`); await expect(viewer.getByTestId("reported-cost")).toContainText("$0.123");
    const viewerExport = await downloadAnalytics(viewer);
    expect(viewerExport.report.scope).toEqual({ kind: "team", projectId });
    expect(viewerExport.report.reportedUsd).toEqual(ownerExport.report.reportedUsd);
    expect(viewerExport.report.rateRevisions).toEqual([]);
    await viewer.evaluate(async path => { await fetch(path); }, detectorProbe);
    expect(viewerLocalRequests).toEqual([detectorProbe]);
    viewerLocalRequests.length = 0; await viewer.unroute(`${team.url}${detectorProbe}`);
    const revokedDownloads: string[] = [];
    viewer.on("download", download => { revokedDownloads.push(download.suggestedFilename()); });
    const revoked = await mutate(`/projects/${projectId}/members/${viewerSession.session.user.id}`, undefined, "DELETE"); expect(revoked.status()).toBe(204);
    const refusal = viewer.waitForResponse(response => new URL(response.url()).pathname === `/api/team/projects/${projectId}/pricing/analytics` && response.request().method() === "POST");
    await viewer.getByRole("button", { name: "Export JSON", exact: true }).click(); expect((await refusal).status()).toBe(404);
    await expect(viewer.getByRole("heading", { name: "Cost & usage", exact: true })).toHaveCount(0);
    await expect(viewer.getByTestId("reported-cost")).toHaveCount(0); expect(revokedDownloads).toEqual([]); expect(localRequests).toEqual([]); expect(viewerLocalRequests).toEqual([]);
    await viewer.screenshot({ path: info.outputPath("cost-analytics-revoked-viewer.png"), fullPage: true });
    await info.attach("Scoped request observers", { body: JSON.stringify({ probeCaughtOnActualViewer: true, ownerLocalRequests: localRequests, viewerLocalRequests, revokedAnalyticsStatus: 404, revokedCapturedContentRemoved: true }), contentType: "application/json" });
  } finally { await viewerContext.close(); }
  await info.attach("Team analytics runtime", { body: JSON.stringify({ runtime: process.env.RUNPHANTOM_TEAM_TEST_BINARY ? "copied-compiled-private-team" : "source-private-team", capture: "synthetic-stored-OTLP", providerSpendUsd: 0 }), contentType: "application/json" });
});
