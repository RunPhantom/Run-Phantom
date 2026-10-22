import { readFileSync } from "node:fs";
import { test, expect, REPO_ROOT_PATH } from "./fixtures";
import { withPortableDestination } from "./portable-destination";

test("portable trace: download annotated failure, import in another local store, inspect and download it again", async ({ page, request, runPhantom }, testInfo) => {
  await withPortableDestination(REPO_ROOT_PATH, async target => {
    const runId = "portable-browser-run";
    const run = { id: runId, name: "payment-agent", event_name: "checkout", event_id: "portable-event", display_name: "Portable checkout failure",
      started_at: 1000, last_updated_at: 1100, metadata: '{"team":"fixture-review"}' };
    const spans = [{ id: "payment-tool", run_id: runId, name: "payment", span_type: "TOOL_CALL", status: "ERROR",
      input_payload: '{"cartId":42}', output_payload: '{"error":"payment rejected"}', start_time_ms: 1000, end_time_ms: 1100, duration_ms: 100 }];
    const seeded = await request.post(`${runPhantom.url}/api/import-run`, { data: { run, spans,
      liveEvents: [{ type: "tool-result", span_id: "payment-tool", content: "payment rejected", timestamp: 1100 }] } });
    expect(seeded.ok()).toBe(true);
    for (const annotation of [
      { kind: "note", note: "Portable reviewer note", span_id: null },
      { kind: "issue", note: "Inspect captured payment input", span_id: "payment-tool" },
    ]) expect((await request.post(`${runPhantom.url}/api/annotations`, { data: { run_id: runId, source: "user", ...annotation } })).status()).toBe(201);

    await page.goto(`${runPhantom.url}/runs/${runId}`);
    await expect(page.getByText("Portable reviewer note", { exact: true })).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    const downloaded = await downloadPromise;
    const file = await downloaded.path();
    if (!file) throw new Error("Trace download has no file");
    const sourceExport = JSON.parse(readFileSync(file, "utf8"));
    expect(sourceExport.format).toBe("runphantom-trace/v1");
    expect(sourceExport.annotations).toHaveLength(2);
    expect(sourceExport.run).toMatchObject({ display_name: run.display_name, event_id: run.event_id });
    expect((await request.get(`${target.url}/api/runs/${runId}/export`)).status()).toBe(404);

    await page.goto(`${target.url}/search`);
    await page.getByLabel("Import trace file", { exact: true }).setInputFiles(file);
    await expect(page).toHaveURL(new RegExp(`/search/${runId}$`));
    await expect(page.getByText("Portable reviewer note", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Span Tree", exact: true }).click();
    await page.locator('[data-span-row="payment-tool"]').click();
    await expect(page.getByRole("img", { name: "issue annotation from You: Inspect captured payment input", exact: true })).toBeVisible();

    // Reimport through the same user control; stable annotation identity prevents duplicates.
    await page.goto(`${target.url}/search`);
    await page.getByLabel("Import trace file", { exact: true }).setInputFiles(file);
    await expect(page).toHaveURL(new RegExp(`/search/${runId}$`));
    await expect(page.getByText("Portable reviewer note", { exact: true })).toHaveCount(1);
    await page.reload();
    await page.getByRole("tab", { name: "Span Tree", exact: true }).click();
    await page.locator('[data-span-row="payment-tool"]').click();
    await expect(page.getByRole("img", { name: "issue annotation from You: Inspect captured payment input", exact: true })).toBeVisible();

    const secondDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    const secondFile = await (await secondDownload).path();
    if (!secondFile) throw new Error("Imported trace download has no file");
    expect(JSON.parse(readFileSync(secondFile, "utf8"))).toEqual(sourceExport);
    const original = await request.get(`${runPhantom.url}/api/runs/${runId}/export`);
    expect(await original.json()).toEqual(sourceExport);

    await page.goto(`${target.url}/search`);
    await page.getByLabel("Import trace file", { exact: true }).setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ...sourceExport, format: "runphantom-trace/v999" })) });
    await expect(page.getByRole("alert").filter({ hasText: "Import failed" })).toBeVisible();
    expect(await (await request.get(`${target.url}/api/runs/${runId}/export`)).json()).toEqual(sourceExport);
  }, async diagnostic => {
    await testInfo.attach("portable-destination-lifecycle", { body: Buffer.from(diagnostic), contentType: "application/json" });
  });
});

test("portable trace: saved cached evidence remains downloadable after clearing the live store", async ({ page, request, runPhantom }) => {
  const runId = "cached-browser-trace";
  const cached = { run: { id: runId, name: "Saved checkout evidence", event_name: "checkout", started_at: 1000, last_updated_at: 1100 },
    spans: [{ id: "cached-tool", run_id: runId, name: "cached_payment", span_type: "TOOL_CALL", status: "ERROR",
      input_payload: '{"cartId":42}', output_payload: '{"error":"saved payment failure"}', start_time_ms: 1000, end_time_ms: 1100, duration_ms: 100 }], liveEvents: [] };
  expect((await request.post(`${runPhantom.url}/api/import-run`, { data: cached })).ok()).toBe(true);
  await page.goto(`${runPhantom.url}/runs/${runId}`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
  // Opening Saved persists the detail cache used when the live store is cleared.
  await page.goto(`${runPhantom.url}/saved/${runId}`);
  await expect(page.getByRole("button", { name: "Download", exact: true })).toBeVisible();
  await expect.poll(async () => (await request.get(`${runPhantom.url}/api/saved-runs/cache/${runId}`)).status()).toBe(200);
  expect((await request.post(`${runPhantom.url}/api/clear`)).ok()).toBe(true);
  await page.goto(`${runPhantom.url}/saved/${runId}`);
  await expect(page.getByRole("button", { name: "Download", exact: true })).toBeVisible();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const file = await (await pending).path();
  if (!file) throw new Error("Saved trace download has no file");
  const evidence = JSON.parse(readFileSync(file, "utf8"));
  expect(evidence.format).toBeUndefined();
  expect(evidence.exportSource).toBe("saved-cache");
  expect(evidence.exportNotice).toContain("may be compacted");
  expect(evidence.run.id).toBe(runId);
  expect(evidence.spans).toHaveLength(1);
  expect(evidence.spans[0].output_payload).toBe(cached.spans[0].output_payload);
  expect((await request.post(`${runPhantom.url}/api/import-run`, { data: evidence })).ok()).toBe(true);
  const restored = await request.get(`${runPhantom.url}/api/runs/${runId}/export`);
  expect((await restored.json()).format).toBe("runphantom-trace/v1");
});
