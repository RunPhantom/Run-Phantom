import { guardEvent, guardHarmless, guardOutput, guardRequest, guardSecrets, guardSpanId, guardTraceId } from "../../tests/fixtures/guard-evidence";
import { expect, test } from "./fixtures";

const noSecret = (text: string) => { for (const secret of Object.values(guardSecrets)) expect(text).not.toContain(secret); };
for (const width of [320, 390, 768, 1024, 1440, 1920]) test(`advisory guard observations remain inert, keyboard accessible and bounded at ${width}px`, async ({ page, request, runPhantom }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const body = guardRequest() as any;
  body.resourceSpans[0].scopeSpans[0].spans[0].events[3] = guardEvent("deny", {
    "guard.explanation": `<script>window.guardExecuted=true</script> ${guardSecrets.npm} ${guardSecrets.hf} ${guardSecrets.pem} password=${guardSecrets.password} ${guardHarmless}` });
  expect((await request.post(`${runPhantom.url}/v1/traces`, { data: body })).status()).toBe(200);
  const response = await request.get(`${runPhantom.url}/api/runs/detail/${guardTraceId}`); expect(response.status()).toBe(200);
  const actual = await response.json(); noSecret(JSON.stringify(actual));
  expect(actual.spans[0]).toMatchObject({ status: "OK", output_payload: guardOutput, guardEvidence: { advisory: true, execution: "unknown" } });
  await page.setViewportSize({ width, height: 1000 }); await page.goto(`${runPhantom.url}/runs/${guardTraceId}/span/${guardSpanId}`);
  const region = page.getByRole("region", { name: "Captured guard decisions" }); await expect(region).toBeVisible();
  await expect(region.getByText("Partial capture", { exact: true })).toBeVisible();
  await expect(region.getByText(/Captured producer actions are advisory/)).toBeVisible();
  await expect(region.locator("details")).toHaveCount(5);
  const summary = region.locator("summary").first(); await summary.focus(); await page.keyboard.press("Enter");
  await expect(region.locator("details").first()).toHaveAttribute("open", "");
  await expect(region.locator("details").first().getByText("0 ms", { exact: true })).toBeVisible();
  await expect(region.locator("details").first().getByText("false", { exact: true })).toBeVisible();
  await expect(region.locator("details").first().getByText("1770000000000000002", { exact: true })).toBeVisible();
  const focus = await summary.evaluate(element => ({ focused: document.activeElement === element,
    width: getComputedStyle(element).outlineWidth, color: getComputedStyle(element).outlineColor }));
  expect(focus).toMatchObject({ focused: true, width: "2px", color: "rgb(0, 33, 204)" });
  await page.keyboard.press("Enter"); await expect(region.locator("details").first()).not.toHaveAttribute("open");
  const denied = region.locator("details").nth(3); await denied.locator("summary").click();
  await expect(denied.getByText(/<script>window.guardExecuted=true<\/script>/)).toBeVisible();
  await expect(denied.getByText(/\[REDACTED\]/).first()).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { guardExecuted?: boolean }).guardExecuted)).toBeUndefined();
  noSecret(await page.locator("body").innerText()); await denied.locator("summary").click();
  const error = region.locator("details").last(); await error.locator("summary").click();
  await expect(error.getByText("Producer error reported", { exact: true }).first()).toBeVisible();
  await expect(error.getByText("Reported allow", { exact: true })).toBeVisible();
  await expect(page.getByText("Run failed", { exact: true })).toHaveCount(0);
  await error.locator("summary").click();
  const heading = region.getByRole("heading", { name: "Captured guard decisions" });
  await heading.scrollIntoViewIfNeeded(); await expect(heading).toBeInViewport({ ratio: 1 });
  await expect(region.getByText(/Captured producer actions are advisory/)).toBeInViewport({ ratio: 1 });
  const geometry = await region.evaluate(element => { const rectangle = element.getBoundingClientRect(); return {
    viewport: innerWidth, left: rectangle.left, right: rectangle.right, width: rectangle.width,
    contentWidth: element.scrollWidth, clientWidth: element.clientWidth, documentWidth: document.documentElement.scrollWidth,
    documentClientWidth: document.documentElement.clientWidth,
  }; });
  expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(width);
  expect(geometry.contentWidth).toBeLessThanOrEqual(geometry.clientWidth + 1); expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.documentClientWidth + 1);
  expect(errors).toEqual([]);
  if ([320, 390, 1024, 1440].includes(width)) { const file = testInfo.outputPath(`guard-advisory-${width}.png`); await page.screenshot({ path: file });
    await testInfo.attach(`guard-advisory-${width}`, { path: file, contentType: "image/png" }); }
  await testInfo.attach("guard-browser-proof", { contentType: "application/json", body: Buffer.from(JSON.stringify({ width, geometry, focus, actual, errors, providerCalls: 0 }, null, 2)) });
});

test("unknown, duplicate and lossy guard capture remains distinct from span status and body values", async ({ page, request, runPhantom }, testInfo) => {
  const body = guardRequest() as any, span = body.resourceSpans[0].scopeSpans[0].spans[0], event = guardEvent("invalid", { "guard.score": -1 });
  event.attributes.push({ key: "guard.action", value: { stringValue: "allow" } }); delete (event as any).droppedAttributesCount;
  span.events = [{ name: "", attributes: [] }, event]; span.droppedEventsCount = 2;
  expect((await request.post(`${runPhantom.url}/v1/traces`, { data: body })).status()).toBe(200);
  await page.goto(`${runPhantom.url}/runs/${guardTraceId}/span/${guardSpanId}`);
  const region = page.getByRole("region", { name: "Captured guard decisions" }); await expect(region).toBeVisible();
  await expect(region.getByText("Action unknown", { exact: true })).toBeVisible();
  await expect(region.getByText(/Exporter dropped 2 events · Receiver omitted 1 events/)).toBeVisible();
  await expect(region.getByTestId("guard-capture-reasons")).toContainText("Duplicate fields are ambiguous");
  await expect(region.getByTestId("guard-capture-reasons")).toContainText("Exporter attribute loss is unknown");
  await region.locator("summary").click();
  await expect(region.getByText("guard.action: Duplicate fields are ambiguous", { exact: true })).toBeVisible();
  await expect(region.getByText("guard.score: Fields are invalid", { exact: true })).toBeVisible();
  const response = await request.get(`${runPhantom.url}/api/runs/detail/${guardTraceId}`), actual = await response.json();
  expect(actual.spans[0]).toMatchObject({ status: "OK", output_payload: guardOutput, guardEvidence: { execution: "unknown", state: "unknown",
    counts: { duplicateFields: 1, invalidNumericFields: 1, receiverDroppedEvents: 1 }, decisions: [{ sourceEventIndex: null }] } });
  const missing = guardRequest() as any; missing.resourceSpans[0].scopeSpans[0].spans[0].events = []; delete missing.resourceSpans[0].scopeSpans[0].spans[0].droppedEventsCount;
  expect((await request.post(`${runPhantom.url}/v1/traces`, { data: missing })).status()).toBe(200); await page.reload();
  await expect(region.getByText(/Exporter dropped unknown events/)).toBeVisible();
  await expect(region.getByText(/No retained guard decision can be displayed/)).toBeVisible();
  await expect(region.locator("details")).toHaveCount(0); noSecret(await page.locator("body").innerText());
  await testInfo.attach("guard-unknown-source-proof", { contentType: "application/json", body: Buffer.from(JSON.stringify(actual, null, 2)) });
});
