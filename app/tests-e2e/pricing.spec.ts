import { createHash } from "node:crypto";
import { expect, test as sourceTest } from "./fixtures";
import { clearRunPhantom } from "./helpers";
import type { Snapshot } from "../../src/evaluations/protocol";

const compiledUrl = process.env.RUNPHANTOM_COMPILED_URL;
if (compiledUrl) {
  const target = new URL(compiledUrl);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !target.port) {
    throw new Error("Pricing compiled tests require an isolated loopback daemon with an explicit port");
  }
}
const test = compiledUrl ? sourceTest.extend({
  runPhantom: async ({}, use) => {
    await use({ url: compiledUrl, port: Number(new URL(compiledUrl).port), dbPath: "isolated-compiled-runtime" });
  },
}) : sourceTest;

const CATALOGUE_URL = "https://openrouter.ai/api/v1/models";
const RUN_ID = "0000000000000000000000000000f140";
const catalogue = JSON.stringify({ data: [
  { id: "fixture/known", pricing: { prompt: "0.000003", completion: "0.000015" } },
  { id: "fixture/free", pricing: { prompt: "0", completion: "0" } },
] });
const catalogueRevision = `sha256:${createHash("sha256").update(catalogue).digest("hex")}`;

test.use({ hasTouch: true });

async function seed(url: string, mode: "mixed" | "zero" | "missing") {
  const now = Date.now() - 1000;
  const rows = mode === "mixed" ? [{ model: "known", input: 200, output: 300 }, { model: "fixture/missing-price", input: 100, output: 50 }]
    : mode === "zero" ? [{ model: "fixture/free", input: 0, output: 0 }] : [{ model: "fixture/known", input: 200, output: null }];
  const spans = rows.map((row, index) => ({
    traceId: RUN_ID, spanId: (0xf140 + index).toString(16).padStart(16, "0"), name: "pricing.fixture.generation", kind: 1,
    startTimeUnixNano: String(BigInt(now + index * 10) * 1_000_000n), endTimeUnixNano: String(BigInt(now + index * 10 + 5) * 1_000_000n), status: { code: 1 },
    attributes: [
      { key: "ai.operationId", value: { stringValue: "ai.generateText" } },
      { key: "ai.model.id", value: { stringValue: row.model } },
      { key: "ai.model.provider", value: { stringValue: "fixture-provider" } },
      { key: "ai.telemetry.metadata.runphantom.eventName", value: { stringValue: "Controlled pricing capture" } },
      { key: "ai.usage.inputTokens", value: { intValue: String(row.input) } },
      ...(row.output === null ? [] : [{ key: "ai.usage.outputTokens", value: { intValue: String(row.output) } }]),
      { key: "gen_ai.usage.cost_usd", value: { doubleValue: 0.123 } },
    ],
  }));
  const response = await fetch(`${url}/v1/traces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] }) });
  expect(response.ok).toBe(true);
  const detail = await fetch(`${url}/api/runs/detail/${RUN_ID}`);
  expect(detail.ok).toBe(true);
  return await detail.json() as { spans: { model: string; input_tokens: number | null; output_tokens: number | null; attributes: string }[] };
}

test.beforeEach(async ({ runPhantom }, testInfo) => {
  await clearRunPhantom(runPhantom.url);
  await testInfo.attach("Pricing runtime profile", {
    body: JSON.stringify({ runtime: compiledUrl ? "compiled-daemon" : "source-daemon", catalogue: "controlled-synthetic", providerSpendUsd: 0 }),
    contentType: "application/json",
  });
});

test("pricing: real Settings consent refreshes an open run with exact source and unavailable rows", async ({ page, runPhantom }, testInfo) => {
  const before = await seed(runPhantom.url, "mixed");
  const readReportedSnapshot = async (): Promise<Snapshot> => {
    const response = await fetch(`${runPhantom.url}/api/evaluations/runs/${RUN_ID}/snapshot`);
    expect(response.ok).toBe(true);
    return await response.json() as Snapshot;
  };
  const reportedSnapshot = await readReportedSnapshot();
  expect(reportedSnapshot.metrics.costUsd).toBe(0.246);
  let requests = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(CATALOGUE_URL, async route => { requests++; await held; await route.fulfill({ contentType: "application/json", body: catalogue }); });
  await page.goto(`${runPhantom.url}/runs/${RUN_ID}`);
  const unavailable = page.getByRole("button", { name: "Estimate unavailable", exact: true });
  await expect(unavailable).toBeVisible();
  expect(requests).toBe(0);
  await unavailable.click();
  await expect(page.getByRole("region", { name: "Nominal cost estimates" })).toContainText("Public pricing is disabled");
  await page.screenshot({ path: testInfo.outputPath("pricing-desktop-before-consent.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(unavailable).toBeFocused();

  await page.getByRole("link", { name: /^settings$/i }).click();
  await page.getByRole("checkbox", { name: /fetch public model pricing/i }).check();
  await expect.poll(() => requests).toBe(1);
  await page.getByRole("link", { name: /^runs$/i }).click();
  await page.locator(`[data-run-id="${RUN_ID}"]`).click();
  await expect(page.getByRole("button", { name: "Estimate unavailable", exact: true })).toBeVisible();
  release();

  const summary = page.getByRole("button", { name: "Known estimates $0.0051 · 1 unavailable", exact: true });
  await expect(summary).toBeVisible();
  await summary.focus();
  await page.keyboard.press("Enter");
  const details = page.getByRole("region", { name: "Nominal cost estimates" });
  await expect(details).toContainText("200 input @ $3/M");
  await expect(details).toContainText("300 output @ $15/M");
  await expect(details).toContainText("Catalogue ID: fixture/known");
  await expect(details).toContainText(catalogueRevision);
  await expect(details).toContainText("fixture/missing-price");
  await expect(details).toContainText("No unambiguous exact catalogue price");
  await expect(details).toContainText("Reported cost stays separate");
  await page.screenshot({ path: testInfo.outputPath("pricing-desktop-controlled-catalogue.png"), fullPage: true });
  await testInfo.attach("Controlled catalogue and output contract", { body: JSON.stringify({ kind: "controlled-catalogue", catalogueRevision, expectedKnownEstimateUsd: 0.0051, unavailableModels: 1, providerSpendUsd: 0 }), contentType: "application/json" });

  await page.keyboard.press("Escape");
  await expect(summary).toBeFocused();
  const afterResponse = await fetch(`${runPhantom.url}/api/runs/detail/${RUN_ID}`);
  expect(afterResponse.ok).toBe(true);
  const after = await afterResponse.json() as typeof before;
  expect(after.spans.map(span => ({ model: span.model, input: span.input_tokens, output: span.output_tokens, attributes: span.attributes }))).toEqual(before.spans.map(span => ({ model: span.model, input: span.input_tokens, output: span.output_tokens, attributes: span.attributes })));
  const afterReportedSnapshot = await readReportedSnapshot();
  expect(afterReportedSnapshot.metrics).toEqual(reportedSnapshot.metrics);
  expect(afterReportedSnapshot.models).toEqual(reportedSnapshot.models);

  const settingsPage = await page.context().newPage();
  await settingsPage.goto(`${runPhantom.url}/settings`);
  await settingsPage.getByRole("checkbox", { name: /fetch public model pricing/i }).uncheck();
  await expect(page.getByRole("button", { name: "Estimate unavailable", exact: true })).toBeVisible();
  await settingsPage.close();
  expect(requests).toBe(1);
});

test("pricing: mobile free zero is visible and cost disclosure fits the viewport", async ({ page, runPhantom }, testInfo) => {
  await seed(runPhantom.url, "zero");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => { localStorage.setItem("runphantom:modelPricingConsent", "1"); });
  await page.route(CATALOGUE_URL, route => route.fulfill({ contentType: "application/json", body: catalogue }));
  await page.goto(`${runPhantom.url}/runs/${RUN_ID}`);
  const button = page.getByRole("button", { name: "Estimated cost $0.00", exact: true });
  await expect(button).toBeVisible();
  const trigger = await button.boundingBox();
  expect(trigger!.height).toBeGreaterThanOrEqual(44);
  await button.tap();
  const details = page.getByRole("region", { name: "Nominal cost estimates" });
  await expect(details).toContainText("0 input @ $0/M");
  await expect(details).toContainText("0 output @ $0/M");
  const bounds = await details.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(16);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(374);
  expect(bounds!.y).toBeGreaterThanOrEqual(16);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(828);
  await page.screenshot({ path: testInfo.outputPath("pricing-mobile-free-controlled-catalogue.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(button).toBeFocused();
});

test("pricing: incomplete backend token capture never becomes a complete estimate", async ({ page, runPhantom }) => {
  const captured = await seed(runPhantom.url, "missing");
  expect(captured.spans).toHaveLength(1);
  expect(captured.spans[0].output_tokens).toBeNull();
  await page.addInitScript(() => { localStorage.setItem("runphantom:modelPricingConsent", "1"); });
  await page.route(CATALOGUE_URL, route => route.fulfill({ contentType: "application/json", body: catalogue }));
  await page.goto(`${runPhantom.url}/runs/${RUN_ID}`);
  const button = page.getByRole("button", { name: "Estimate unavailable", exact: true });
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.getByRole("region", { name: "Nominal cost estimates" })).toContainText("Input or output token capture is unavailable");
  await expect(page.getByRole("button", { name: /^Estimated cost \$/ })).toHaveCount(0);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 320, height: 740 }]) {
  test(`pricing: disclosure remains reachable at ${viewport.width}x${viewport.height}`, async ({ page, runPhantom }, testInfo) => {
    await seed(runPhantom.url, "mixed");
    await page.setViewportSize(viewport);
    await page.addInitScript(() => { localStorage.setItem("runphantom:modelPricingConsent", "1"); });
    await page.route(CATALOGUE_URL, route => route.fulfill({ contentType: "application/json", body: catalogue }));
    await page.goto(`${runPhantom.url}/runs/${RUN_ID}`);
    const button = page.getByRole("button", { name: "Known estimates $0.0051 · 1 unavailable", exact: true });
    await expect(button).toBeVisible();
    await button.tap();
    const region = page.getByRole("region", { name: "Nominal cost estimates" });
    await expect(region).toBeVisible();
    const bounds = await region.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(16);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width - 16);
    expect(bounds!.y).toBeGreaterThanOrEqual(16);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height - 16);
    await page.screenshot({ path: testInfo.outputPath(`pricing-${viewport.width}x${viewport.height}-controlled-catalogue.png`), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(button).toBeFocused();
  });
}
