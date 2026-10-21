import { test as browserTest, expect } from "./accessibility-fixture";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import type { Page, Locator, TestInfo } from "@playwright/test";
import { ACCESSIBILITY_FIXTURE_HTML } from "../../tests/helpers/accessibility-fixture";
import { BROWSER_LIMITS } from "../../src/verification/browser-contract";

const test = browserTest.extend({
  browserTarget: async ({}, use) => {
    const events: Array<{ type: string; trusted: boolean; value?: string }> = [];
    const server = createServer((request, response) => { events.push({ type: "native-http-request", trusted: false, value: request.url }); response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(ACCESSIBILITY_FIXTURE_HTML); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try { await use({ origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, events }); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  },
});
test.skip(!process.env.RUNPHANTOM_TEST_BROWSER_MODULE, "Actual native audit fixture requires the explicitly selected installed runtime.");
const widths = [[1440, 900], [1280, 800], [1024, 768], [768, 1024], [390, 844], [320, 740]];
async function open(page: Page, url: string, origin: string) {
  await page.goto(`${url}/verification`);
  const panel = page.getByRole("region", { name: "Trusted browser", exact: true });
  await panel.getByLabel(/^Browser target URL/).fill(origin); await panel.getByRole("button", { name: "Open browser", exact: true }).click();
  const selected = panel.getByRole("combobox", { name: "Browser connection", exact: true }); await expect(selected).toContainText("ready");
  const audit = panel.getByRole("region", { name: "Accessibility evidence", exact: true });
  return { panel, audit, selected };
}
async function nativeAudit(page: Page, audit: Locator, region: string, status: string) {
  await audit.getByLabel("Audit regions", { exact: true }).fill(region);
  const response = page.waitForResponse(value => value.url().endsWith("/audit") && value.request().method() === "POST");
  await audit.getByRole("button", { name: "Run accessibility audit", exact: true }).click();
  const actual = await response; expect(actual.status()).toBe(200); const body = await actual.json();
  expect(body.source).toBe("host-run-native-engine"); expect(body.engine.version).toBe("4.11.0"); expect(body.status).toBe(status);
  await expect(audit.getByRole("article", { name: "Accessibility audit result", exact: true })).toBeVisible(); return body;
}
async function layoutEvidence(page: Page, audit: Locator, testInfo: TestInfo, stage: string) {
  const rows = [];
  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    const fonts = await page.evaluate(async () => {
      await document.fonts.load('400 16px "Syne"'); await document.fonts.load('400 16px "Inter Variable"'); await document.fonts.ready;
      return [...document.fonts].filter(font => ["Syne", "Inter Variable"].some(name => font.family.replaceAll('"', "") === name)).map(font => ({ family: font.family, status: font.status }));
    });
    expect(fonts.some(font => font.family.includes("Syne") && font.status === "loaded")).toBe(true);
    expect(fonts.some(font => font.family.includes("Inter Variable") && font.status === "loaded")).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const controls = await audit.locator("button,textarea,label:has(input[type=checkbox])").evaluateAll(elements => elements.map(element => ({ name: element.textContent?.trim() || element.getAttribute("placeholder"), height: element.getBoundingClientRect().height })));
    expect(controls.every(control => control.height >= 44)).toBe(true);
    const anchor = stage === "scope" ? audit.getByRole("heading", { name: "Accessibility evidence", exact: true }) : audit.getByRole("article", { name: "Accessibility audit result", exact: true });
    await anchor.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`f35-${stage}-${width}.png`) });
    if (stage === "scope" && width < 400) {
      await audit.getByLabel("Audit regions", { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`f35-scope-controls-${width}.png`) });
    }
    rows.push({ width, height, fonts, controls, horizontalOverflow: false, screenshot: `f35-${stage}-${width}.png` });
  }
  writeFileSync(testInfo.outputPath(`f35-${stage}-layout.json`), JSON.stringify({ source: "actual mounted source UI and genuine native audit", zoomClaim: "none", rows }, null, 2));
}

test("actual audit is explicit, shows native findings/fixed/empty/partial coverage and six font-loaded layouts", async ({ page, browserApp, browserTarget, request }, testInfo) => {
  test.skip(!process.env.RUNPHANTOM_TEST_BROWSER_MODULE, "Requires the explicitly selected installed native browser closure.");
  let audits = 0; const errors: string[] = [], foreign: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("request", value => { if (value.url().startsWith("http") && new URL(value.url()).origin !== browserApp.url) foreign.push(value.url()); if (value.url().endsWith("/audit")) audits++; });
  const { audit, selected } = await open(page, browserApp.url, browserTarget.origin);
  await expect(audit.getByRole("button", { name: "Run accessibility audit", exact: true })).toBeDisabled(); expect(audits).toBe(0);
  await audit.getByLabel("Audit regions", { exact: true }).fill("#audit");
  const button = audit.getByRole("button", { name: "Run accessibility audit", exact: true });
  await audit.getByLabel("Audit regions", { exact: true }).focus(); await page.keyboard.press("Tab"); await expect(button).toBeFocused();
  const keyboard = await button.evaluate(element => ({ focusVisible: element.matches(":focus-visible"), height: element.getBoundingClientRect().height, shadow: getComputedStyle(element).boxShadow }));
  expect(keyboard.focusVisible).toBe(true); expect(keyboard.height).toBeGreaterThanOrEqual(44); expect(keyboard.shadow).not.toBe("none");
  writeFileSync(testInfo.outputPath("f35-keyboard-focus.json"), JSON.stringify({ actualKey: "Tab", keyboard }, null, 2));
  await layoutEvidence(page, audit, testInfo, "scope");
  const bad = await nativeAudit(page, audit, "#audit", "findings");
  expect(bad.findings.map((finding: any) => finding.rule)).toEqual(expect.arrayContaining(["button-name", "image-alt", "label"]));
  await expect(audit).toContainText("Coverage complete"); await expect(audit).toContainText("3 findings shown");
  await layoutEvidence(page, audit, testInfo, "findings");
  const selectedId = await selected.inputValue();
  const session = (await (await request.get(`${browserApp.url}/api/verification/browser/sessions`)).json()).find((item: any) => item.id === selectedId);
  const fixed = await request.post(`${browserApp.url}/api/verification/browser/sessions/${session.id}/action`, { data: { generation: session.generation, action: { type: "click", target: { kind: "css", selector: "#fix" } } } }); expect((await fixed.json()).action.dispatch).toBe("completed");
  const good = await nativeAudit(page, audit, "#audit", "no-findings"); expect(good.coverage).toBe("complete"); await expect(audit.getByRole("heading", { name: "No findings in selected scope", exact: true })).toBeVisible();
  const empty = await nativeAudit(page, audit, "#empty", "inconclusive"); expect(empty.loss).toContain("no-applicable-nodes"); await expect(audit).toContainText("No applicable nodes were tested.");
  const partial = await nativeAudit(page, audit, "#opaque", "inconclusive"); expect(partial.loss).toContain("closed-shadow-root"); await expect(audit).toContainText("Coverage partial");
  const unavailable = await nativeAudit(page, audit, "#missing", "inconclusive"); expect(unavailable.coverage).toBe("unavailable"); expect(unavailable.population.total).toBeNull(); await expect(audit).toContainText("Total unknown");
  await selected.selectOption(""); await expect(audit.getByRole("article", { name: "Accessibility audit result", exact: true })).toHaveCount(0);
  await expect(audit.getByLabel("Audit regions", { exact: true })).toHaveValue("#missing");
  await selected.selectOption(selectedId); await expect(audit.getByRole("article", { name: "Accessibility audit result", exact: true })).toHaveCount(0);
  expect(await (await request.get(`${browserApp.url}/api/verification/reports`)).json()).toEqual([]);
  expect(errors).toEqual([]); expect(foreign).toEqual([]); expect(await audit.innerText()).not.toContain("<input");
  writeFileSync(testInfo.outputPath("f35-native-populations.json"), JSON.stringify({ bad, good, empty, partial, unavailable, errors, foreign }, null, 2));
});

for (const steering of ["empty selection", "different session", "cancel and close", "target navigation", "app navigation"] as const) {
  test(`held actual native result is fenced by parent ${steering}`, async ({ page, browserApp, browserTarget, request }, testInfo) => {
    test.skip(!process.env.RUNPHANTOM_TEST_BROWSER_MODULE, "Requires the explicitly selected installed native browser closure.");
    const { panel, audit, selected } = await open(page, browserApp.url, browserTarget.origin), first = await selected.inputValue();
    let second = "";
    if (steering === "different session") {
      await panel.getByRole("button", { name: "Open browser", exact: true }).click(); await expect(selected.locator("option")).toHaveCount(3); second = await selected.inputValue(); await selected.selectOption(first);
    }
    await audit.getByLabel("Audit regions", { exact: true }).fill("#audit");
    let held!: () => void, release!: () => void;
    const responseHeld = new Promise<void>(resolve => { held = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
    let actual: any, delivered!: () => void;
    const completed = new Promise<void>(resolve => { delivered = resolve; });
    await page.route(`**/api/verification/browser/sessions/${first}/audit`, async route => {
      const response = await route.fetch(); actual = await response.json(); expect(response.status()).toBe(200); expect(actual.status).toBe("findings"); expect(actual.source).toBe("host-run-native-engine");
      held(); await released; try { await route.fulfill({ response }); } finally { delivered(); }
    });
    try {
      await audit.getByRole("button", { name: "Run accessibility audit", exact: true }).click(); await responseHeld;
      await expect(audit).toContainText("Auditing selected page regions");
      if (steering === "empty selection") await selected.selectOption("");
      if (steering === "different session") await selected.selectOption(second);
      if (steering === "cancel and close") { await panel.getByRole("button", { name: "Cancel and close", exact: true }).click(); await expect(panel.getByRole("status")).toContainText("Browser authority closed"); }
      if (steering === "target navigation") {
        const navigation = await request.post(`${browserApp.url}/api/verification/browser/sessions/${first}/action`, { data: { generation: actual.generation, action: { type: "click", target: { kind: "css", selector: "#navigate" } } } });
        const navigated = await navigation.json(); expect(navigated.action.dispatch).toBe("unknown"); expect(navigated.action.generationAfter).toBeGreaterThan(actual.generation);
        expect(browserTarget.events.some(event => event.type === "native-http-request" && event.value === "/next")).toBe(true);
        await expect(panel).toContainText("Browser generation changed.");
      }
      if (steering === "app navigation") await page.goto(`${browserApp.url}/`);
      release(); await completed;
      if (steering === "app navigation") { await page.goto(`${browserApp.url}/verification`); }
      await expect(page.getByRole("article", { name: "Accessibility audit result", exact: true })).toHaveCount(0);
      const region = page.getByRole("region", { name: "Accessibility evidence", exact: true }); await expect(region).not.toContainText("Auditing selected page regions");
      if (steering !== "app navigation") await expect(region.getByLabel("Audit regions", { exact: true })).toHaveValue("#audit");
      expect(await (await request.get(`${browserApp.url}/api/verification/reports`)).json()).toEqual([]);
      writeFileSync(testInfo.outputPath("f35-held-native-result.json"), JSON.stringify({ steering, actualNativeBody: actual, businessReports: 0, responseSubstitution: false }, null, 2));
    } finally { release(); }
  });
}

test("actual Firefox connection leaves the initial audit disabled without running an engine", async ({ page, browserApp, browserTarget }, testInfo) => {
  test.skip(!process.env.RUNPHANTOM_TEST_BROWSER_MODULE, "Requires the explicitly selected installed native browser closure.");
  await page.goto(`${browserApp.url}/verification`); const panel = page.getByRole("region", { name: "Trusted browser", exact: true });
  await panel.getByLabel(/^Browser target URL/).fill(browserTarget.origin); await panel.getByRole("combobox", { name: "Browser engine", exact: true }).selectOption("firefox");
  const opening = page.waitForResponse(response => response.url() === `${browserApp.url}/api/verification/browser/sessions` && response.request().method() === "POST", { timeout: BROWSER_LIMITS.START_MS + 2000 });
  await panel.getByRole("button", { name: "Open browser", exact: true }).click();
  const response = await opening; expect(response.status()).toBe(201); expect(await response.json()).toMatchObject({ state: "ready", engine: "firefox" });
  await expect(panel.getByRole("combobox", { name: "Browser connection", exact: true })).toContainText("firefox · owned · ready");
  const audit = panel.getByRole("region", { name: "Accessibility evidence", exact: true }); await audit.getByLabel("Audit regions", { exact: true }).fill("#audit");
  await expect(audit).toContainText("Audit adapter unavailable for this connection."); await expect(audit.getByRole("button", { name: "Run accessibility audit", exact: true })).toBeDisabled();
  await audit.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath("f35-native-unsupported.png") });
  writeFileSync(testInfo.outputPath("f35-native-unsupported-scope.json"), JSON.stringify({ engine: "actual Firefox launch", claim: "negative initial-adapter availability only", qualification: "no Firefox accessibility-engine acceptance" }, null, 2));
});

test("mounted held native work blocks parent input and a parent operation fences the eventual audit display", async ({ page, browserApp, browserTarget, auditHost, request }, testInfo) => {
  const { panel, audit } = await open(page, browserApp.url, `${browserTarget.origin}/hold-engine`);
  await audit.getByLabel("Audit regions", { exact: true }).fill("#audit"); await panel.getByLabel(/^Browser control target/).fill("#fix");
  const completed = page.waitForResponse(response => response.url().endsWith("/audit") && response.request().method() === "POST");
  await audit.getByRole("button", { name: "Run accessibility audit", exact: true }).click();
  await expect.poll(() => existsSync(auditHost.held), { timeout: 4000 }).toBe(true);
  await expect(audit).toContainText("Auditing selected page regions"); await expect(audit.getByRole("button", { name: "Run accessibility audit", exact: true })).toBeDisabled();
  const parent = page.waitForResponse(response => response.url().endsWith("/action") && response.request().method() === "POST");
  await panel.getByRole("button", { name: "Send input only", exact: true }).click(); const refused = await parent; expect(refused.status()).toBe(409);
  writeFileSync(auditHost.release, "release"); const actual = await completed; expect(actual.status()).toBe(200); const body = await actual.json(); expect(body.status).toBe("findings");
  await expect(audit.getByRole("article", { name: "Accessibility audit result", exact: true })).toHaveCount(0);
  expect(await (await request.get(`${browserApp.url}/api/verification/reports`)).json()).toEqual([]);
  writeFileSync(testInfo.outputPath("f35-mounted-native-busy.json"), JSON.stringify({ parentInputStatus: refused.status(), heldActualNativeResult: body, inputDispatched: false, businessReports: 0, resultDisplayFenced: true }, null, 2));
});
