import { expect, test } from "./fixtures";
import type { Annotation } from "../src/api/annotations";

test("investigation annotations: edited drafts persist through real routes and reload, then delete without changing captured evidence", async ({ page, request, runPhantom }, testInfo) => {
  const runId = "investigation-annotations-run";
  const spanId = "investigation-annotations-failed-payment";
  const runNote = "Review the captured checkout failure.\nKeep the original evidence intact.";
  const spanNote = "This payment attempt was declined.\nInspect its captured input before retrying.";
  const captured = {
    run: { id: runId, name: "Annotated checkout failure", event_name: "checkout", started_at: 1000, last_updated_at: 1200 },
    spans: [
      { id: spanId, run_id: runId, name: "payment", span_type: "TOOL_CALL", status: "ERROR",
        input_payload: "Charge cart-42 exactly once: captured input", output_payload: "Payment declined for cart-42: captured failure",
        start_time_ms: 1000, end_time_ms: 1100, duration_ms: 100 },
      { id: "investigation-annotations-other-payment", run_id: runId, name: "payment", span_type: "TOOL_CALL", status: "OK",
        input_payload: "Inspect cart-99: another captured input", output_payload: "Cart-99 inspection complete: another captured result",
        start_time_ms: 1100, end_time_ms: 1200, duration_ms: 100 },
    ],
    liveEvents: [],
  };
  expect((await request.post(`${runPhantom.url}/api/import-run`, { data: captured })).ok()).toBe(true);
  const exportUrl = `${runPhantom.url}/api/runs/${runId}/export`;
  const annotationsUrl = `${runPhantom.url}/api/annotations`;
  const readTrace = async () => {
    const response = await request.get(exportUrl);
    expect(response.status()).toBe(200);
    return response.json();
  };
  const readAnnotations = async (): Promise<Annotation[]> => {
    const response = await request.get(`${annotationsUrl}?run_id=${runId}`);
    expect(response.status()).toBe(200);
    return response.json();
  };
  const original = await readTrace();
  expect(original.run).toMatchObject(captured.run);
  expect(original.spans).toEqual(captured.spans.map(span => expect.objectContaining(span)));
  expect(await readAnnotations()).toEqual([]);
  const expectCapturedDetail = async () => {
    const detail = page.getByRole("region", { name: "Span details", exact: true });
    await expect(detail).toBeVisible();
    await expect(detail.getByRole("button", { name: `Copy span id ${spanId}`, exact: true })).toBeVisible();
    await expect(detail.getByText("ERROR", { exact: true }).first()).toBeVisible();
    await expect(detail.getByText(captured.spans[0]!.input_payload, { exact: true })).toBeVisible();
    await expect(detail.getByText(captured.spans[0]!.output_payload, { exact: true }).first()).toBeVisible();
    await expect(detail.getByText(captured.spans[1]!.output_payload, { exact: true })).toHaveCount(0);
  };

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${runPhantom.url}/runs/${runId}/span/${spanId}`);
  await expectCapturedDetail();
  await page.getByRole("button", { name: "Annotate", exact: true }).click();
  const runComposer = page.getByRole("dialog", { name: "Annotate run", exact: true });
  await runComposer.getByRole("textbox", { name: "Annotation note", exact: true }).fill("An unfinished run-note draft");
  await runComposer.getByRole("textbox", { name: "Annotation note", exact: true }).fill(runNote);
  const runCreated = page.waitForResponse(response => response.url() === annotationsUrl && response.request().method() === "POST");
  await runComposer.getByRole("button", { name: "Add annotation", exact: true }).click();
  const runResponse = await runCreated;
  expect(runResponse.status()).toBe(201);
  const runAnnotation = await runResponse.json() as Annotation;
  expect(runAnnotation).toMatchObject({ run_id: runId, span_id: null, kind: "note", note: runNote, source: "user" });
  await expect(runComposer).toBeHidden();
  const runAnnotations = page.locator('[aria-label="Run annotations"]');
  await expect(runAnnotations).toContainText(runNote);

  const selectedRow = page.locator(`[data-span-row="${spanId}"]`);
  const openSpanComposer = async () => {
    await selectedRow.focus();
    await page.keyboard.press("Shift+F10");
    const menu = page.getByRole("menu", { name: "Annotate span", exact: true });
    await expect(menu).toBeVisible();
    await page.keyboard.press("End");
    await expect(menu.getByRole("menuitem", { name: /Add note…$/ })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("textbox", { name: "Annotation note", exact: true })).toBeFocused();
  };
  await openSpanComposer();
  await page.getByRole("textbox", { name: "Annotation note", exact: true }).fill("Cancelled draft must not be persisted");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "Annotation note", exact: true })).toBeHidden();
  await expect(selectedRow).toBeFocused();
  expect(await readAnnotations()).toEqual([runAnnotation]);

  await openSpanComposer();
  const spanComposer = page.getByRole("textbox", { name: "Annotation note", exact: true });
  await spanComposer.fill("An unfinished span-note draft");
  await spanComposer.fill(spanNote);
  await page.getByRole("group", { name: "Annotation type", exact: true }).getByRole("button", { name: /issue/ }).click();
  const spanCreated = page.waitForResponse(response => response.url() === annotationsUrl && response.request().method() === "POST");
  await spanComposer.press("ControlOrMeta+Enter");
  const spanResponse = await spanCreated;
  expect(spanResponse.status()).toBe(201);
  const spanAnnotation = await spanResponse.json() as Annotation;
  expect(spanAnnotation).toMatchObject({ run_id: runId, span_id: spanId, kind: "issue", note: spanNote, source: "user" });
  expect(spanAnnotation.id).not.toBe(runAnnotation.id);
  await expect(spanComposer).toBeHidden();
  await expect(selectedRow).toBeFocused();
  const spanBadge = selectedRow.getByRole("img", { name: /^issue annotation from You:/ });
  const spanNoteText = page.getByRole("tabpanel", { name: "Span Tree", exact: true }).getByText(spanNote);
  await expect(spanBadge).toBeVisible();
  await expect(spanBadge).toHaveAttribute("aria-label", `issue annotation from You: ${spanNote}`);
  await expect(spanNoteText).toBeVisible();
  expect(await readAnnotations()).toEqual([runAnnotation, spanAnnotation]);
  await expectCapturedDetail();

  await page.getByRole("link", { name: "Search", exact: true }).click();
  await page.locator(`[data-run-id="${runId}"]`).click();
  await expect(page).toHaveURL(`${runPhantom.url}/search/${runId}`);
  await expect(runAnnotations).toContainText(runNote);
  await page.getByRole("tab", { name: "Span Tree", exact: true }).click();
  await selectedRow.click();
  await expect(page).toHaveURL(`${runPhantom.url}/search/${runId}/span/${spanId}`);
  await page.reload();
  await expect(runAnnotations).toContainText(runNote);
  await expect(spanBadge).toBeVisible();
  await expect(spanNoteText).toBeVisible();
  await expectCapturedDetail();
  expect(await readAnnotations()).toEqual([runAnnotation, spanAnnotation]);

  await expect.poll(async () => {
    const response = await request.get(`${runPhantom.url}/api/saved-runs`);
    expect(response.status()).toBe(200);
    const body = await response.json() as { events: Array<{ id: string }> };
    return body.events.some(event => event.id === runId);
  }).toBe(true);
  await page.goto(`${runPhantom.url}/saved/${runId}/span/${spanId}`);
  await expect(runAnnotations).toContainText(runNote);
  await expect(spanBadge).toBeVisible();
  await expect(spanNoteText).toBeVisible();
  await expectCapturedDetail();
  await testInfo.attach("persisted-investigation-annotations", { body: await page.screenshot(), contentType: "image/png" });

  const spanDeleted = page.waitForResponse(response => response.url() === `${annotationsUrl}/${spanAnnotation.id}` && response.request().method() === "DELETE");
  await page.getByRole("button", { name: "Delete issue annotation", exact: true }).click();
  expect((await spanDeleted).status()).toBe(200);
  await expect(spanBadge).toHaveCount(0);
  await expect(spanNoteText).toHaveCount(0);
  await expect(runAnnotations).toContainText(runNote);
  expect(await readAnnotations()).toEqual([runAnnotation]);
  const runDeleted = page.waitForResponse(response => response.url() === `${annotationsUrl}/${runAnnotation.id}` && response.request().method() === "DELETE");
  await runAnnotations.getByRole("button", { name: "Delete note annotation", exact: true }).click();
  expect((await runDeleted).status()).toBe(200);
  await expect(runAnnotations).toHaveCount(0);
  await page.reload();
  await expect(page).toHaveURL(`${runPhantom.url}/saved/${runId}/span/${spanId}`);
  await expect(runAnnotations).toHaveCount(0);
  await expect(spanBadge).toHaveCount(0);
  await expect(spanNoteText).toHaveCount(0);
  await expectCapturedDetail();
  expect(await readAnnotations()).toEqual([]);
  const after = await readTrace();
  expect(after.run).toEqual(original.run);
  expect(after.spans).toEqual(original.spans);
  expect(after.liveEvents).toEqual(original.liveEvents);
  expect(after.annotations).toEqual([]);
});
