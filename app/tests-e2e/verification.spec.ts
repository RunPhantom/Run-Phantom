import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect, connectTarget, act, assertRuntime } from "./verification-fixture";
import { REPO_ROOT_PATH } from "./fixtures";
import { FIXTURE_PRIMARY_RUN_ID, seedRunPhantomFixtures } from "./helpers";
import type { VerificationFlow, VerificationReport } from "../../src/verification/protocol";

test("runtime verification: user pairs an app, runs a check, and saves and replays a flow through the UI", async ({ page, context, runPhantom, targetApp }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  await page.goto(`${runPhantom.url}/verification`);
  await page.getByLabel(/^App origin/).fill(targetApp.origin);
  await page.getByLabel(/^Link to run \(optional\)/).selectOption(FIXTURE_PRIMARY_RUN_ID);
  await page.getByRole("button", { name: "Pair app", exact: true }).click();
  const snippet = page.getByLabel("Application connection snippet", { exact: true });
  await expect(snippet).toBeVisible();
  const source = await snippet.innerText();
  const sessionId = /["']?sessionId["']?\s*:\s*["']([^"']+)["']/.exec(source)?.[1];
  const token = /["']?token["']?\s*:\s*["']([^"']+)["']/.exec(source)?.[1];
  if (!sessionId || !token) throw new Error("UI setup snippet must include a session ID and one-time credential");
  const app = await context.newPage();
  try {
    await app.goto(targetApp.origin);
    await app.evaluate(async ({ daemon, id, credential }) => {
      const sdk = await import(`${daemon}/verification/sdk.js`);
      window.runtime = sdk.connect({ url: daemon, sessionId: id, token: credential });
      window.runtime.registerStore("checkout", () => window.checkoutState);
    }, { daemon: runPhantom.url, id: sessionId, credential: token });
    await expect(page.getByText("Connected", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Dismiss setup", exact: true }).click();
    await page.getByRole("button", { name: "Run action", exact: true }).click();
    await expect(page.getByRole("region", { name: "App inspection", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Use selector for checkout", exact: true }).click();
    await expect(page.getByLabel(/^Action selector/)).toHaveValue("#checkout");
    await page.getByRole("combobox", { name: "Action", exact: true }).selectOption("click");
    await page.getByRole("combobox", { name: "Check type", exact: true }).selectOption("network");
    await page.getByLabel("Request URL contains", { exact: true }).fill("/api/checkout");
    await page.getByRole("combobox", { name: "Request method", exact: true }).selectOption("POST");
    await page.getByLabel(/^Response status/).fill("200");
    await page.getByLabel("Check name (optional)", { exact: true }).fill("Checkout from user controls");

    await page.getByRole("button", { name: "Run action", exact: true }).click();
    await expect(app.locator("#status")).toHaveText("failed");
    await page.getByRole("button", { name: "Check outcome", exact: true }).click();
    const failedReport = page.getByRole("article", { name: "Checkout from user controls: fail", exact: true });
    await expect(failedReport).toBeVisible({ timeout: 15_000 });
    await expect(failedReport.getByText("POST /api/checkout returns 200", { exact: true })).toBeVisible();
    await expect(failedReport.getByText("Complete capture", { exact: true })).toBeVisible();
    await expect(failedReport.getByText("0 events dropped", { exact: true })).toBeVisible();
    await failedReport.getByText("Capture details", { exact: true }).click();
    await expect(failedReport.getByText(/The starting cursor is excluded/)).toBeVisible();
    await expect(failedReport.getByText("network: observed", { exact: true })).toBeVisible();

    targetApp.setBroken(false);
    await page.getByRole("button", { name: "Run action", exact: true }).click();
    await expect(app.locator("#status")).toHaveText("paid");
    await page.getByRole("button", { name: "Check outcome", exact: true }).click();
    await expect(page.getByRole("article", { name: "Checkout from user controls: pass", exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByLabel("Include current action in step", { exact: true }).check();
    await page.getByRole("button", { name: "Add step to flow", exact: true }).click();
    await page.getByLabel("Flow name", { exact: true }).fill("UI checkout regression");
    await page.getByRole("button", { name: "Save flow", exact: true }).click();
    const replay = page.getByRole("button", { name: "Replay UI checkout regression", exact: true });
    await expect(replay).toBeVisible();
    await replay.focus();
    await replay.press("Enter");
    await expect(page.getByRole("article", { name: "UI checkout regression: pass", exact: true })).toBeVisible({ timeout: 15_000 });
    targetApp.setBroken(true);
    await replay.click();
    await expect(page.getByRole("article", { name: "UI checkout regression: fail", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(`a[href*="${FIXTURE_PRIMARY_RUN_ID}"]`).first()).toBeVisible();

    const screenshotDir = path.join(REPO_ROOT_PATH, "output");
    mkdirSync(screenshotDir, { recursive: true });
    await page.getByRole("heading", { name: "Verification", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(screenshotDir, "verification-desktop.png"), fullPage: true, mask: [snippet] });
    await page.getByRole("heading", { name: "Verification reports", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(screenshotDir, "verification-desktop-reports.png"), fullPage: true, mask: [snippet] });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("heading", { name: "Verification", exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Pair app", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: path.join(screenshotDir, "verification-mobile.png"), fullPage: true, mask: [snippet] });
    await page.getByRole("heading", { name: "Verification reports", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(screenshotDir, "verification-mobile-reports.png"), fullPage: true, mask: [snippet] });
    await page.locator(`a[href="/runs/${FIXTURE_PRIMARY_RUN_ID}"]`).first().click();
    await expect(page).toHaveURL(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
    await expect(page.getByRole("tab", { name: "Overview", exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("runtime verification: real cross-origin SDK observes actions, fails broken checkout, and replays a saved fix", async ({ page, context, request, runPhantom, targetApp }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  const session = await connectTarget(page, request, runPhantom, targetApp.origin, FIXTURE_PRIMARY_RUN_ID);
  const filled = await act(request, runPhantom, session.id, { type: "fill", selector: "#name", value: "Ada" });
  expect(filled).toBeGreaterThanOrEqual(0);
  await expect(page.locator("#name")).toHaveValue("Ada");

  const beforeBroken = await act(request, runPhantom, session.id, { type: "click", selector: "#checkout" });
  await expect(page.locator("#status")).toHaveText("failed");
  const broken = await assertRuntime(request, runPhantom, session.id, { kind: "network", urlContains: "/api/checkout", method: "POST", status: 200 }, beforeBroken, "Broken checkout diagnosis");
  expect(broken.status).toBe("fail");
  expect(broken.runId).toBe(FIXTURE_PRIMARY_RUN_ID);

  targetApp.setBroken(false);
  const beforeFixed = await act(request, runPhantom, session.id, { type: "click", selector: "#checkout" });
  const fixed = await assertRuntime(request, runPhantom, session.id, {
    kind: "allOf", predicates: [
      { kind: "network", urlContains: "/api/checkout", method: "POST", status: 200 },
      { kind: "state", store: "checkout", path: "status", equals: "paid" },
      { kind: "element", selector: "#status", state: "present" },
    ],
  }, beforeFixed, "Checkout fixed in browser");
  expect(fixed.status).toBe("pass");
  expect(fixed.evidence.length).toBeGreaterThan(0);

  const flowResponse = await request.post(`${runPhantom.url}/api/verification/flows`, { data: {
    name: "Checkout regression", origin: targetApp.origin,
    steps: [{ command: { type: "click", selector: "#checkout" }, predicate: { kind: "network", urlContains: "/api/checkout", method: "POST", status: 200 } }],
  } });
  expect(flowResponse.ok()).toBe(true);
  const flow = await flowResponse.json() as VerificationFlow;
  for (const [isBroken, expected] of [[true, "fail"], [false, "pass"]] as const) {
    targetApp.setBroken(isBroken);
    const replayResponse = await request.post(`${runPhantom.url}/api/verification/flows/${flow.id}/run`, { data: { sessionId: session.id } });
    expect(replayResponse.ok()).toBe(true);
    const replay = await replayResponse.json() as VerificationReport;
    expect(replay.status).toBe(expected);
    expect(replay.flowId).toBe(flow.id);
    expect(replay.runId).toBe(FIXTURE_PRIMARY_RUN_ID);
  }

  const ui = await context.newPage();
  try {
    await ui.goto(`${runPhantom.url}/verification`);
    await expect(ui.getByRole("heading", { name: /verification/i }).first()).toBeVisible();
    await expect(ui.getByText("Checkout fixed in browser", { exact: true })).toBeVisible();
    await expect(ui.locator(`a[href*="${FIXTURE_PRIMARY_RUN_ID}"]`).first()).toBeVisible();
    await expect(ui.getByRole("button", { name: /pair|create session|connect app/i }).first()).toBeVisible();
    const actionButtons = ui.getByRole("button", { name: /run flow|replay|run saved/i });
    await expect(actionButtons.first()).toBeVisible();
    await actionButtons.first().focus();
    await expect(actionButtons.first()).toBeFocused();
  } finally {
    await ui.close();
  }
});
