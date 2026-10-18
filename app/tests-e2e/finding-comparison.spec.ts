import { test, expect } from "./fixtures";
import { readFileSync, writeFileSync } from "node:fs";
import type { Page, Route, TestInfo } from "@playwright/test";
import { createEvaluationDataset, EVALUATION_RUNS, seedEvaluationRuns, startEvaluation } from "./evaluation-fixture";

function producer(snapshot: string, count = 1, message = "unexpected retry(2)") {
  return { format: "runphantom-findings/v1", repositoryId: "fixture-repository", sourceSnapshot: snapshot,
    checker: { id: "fixture-checker", version: "1.0.0", rulesSha256: "a".repeat(64), configurationSha256: "b".repeat(64) },
    declaredScope: ["src/a.ts"], reportedExecution: { status: "completed", files: [{ path: "src/a.ts", status: "completed" }] },
    findings: Array.from({ length: count }, (_, index) => ({ id: `occurrence-${index}`, path: "src/a.ts", ruleId: "R1", message, severity: "error", startLine: 10 + index, endLine: 10 + index })) };
}
async function importFile(page: Page, side: "baseline" | "candidate", body: unknown) {
  const input = page.getByLabel(`${side === "baseline" ? "Baseline" : "Candidate"} finding JSON`, { exact: true });
  await expect(input).toBeEnabled(); await input.setInputFiles({ name: `${side}.json`, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(body)) });
  await page.getByRole("button", { name: `Import ${side} findings`, exact: true }).click();
  const select = page.getByRole("combobox", { name: `${side === "baseline" ? "Baseline" : "Candidate"} finding snapshot`, exact: true }); await expect(select).not.toHaveValue("");
  await expect(page.getByRole("button", { name: `Import ${side} findings`, exact: true })).toBeEnabled();
  return JSON.parse(await select.inputValue()) as { setId: string; revision: number; sourceId: string };
}
async function compare(page: Page) {
  const response = page.waitForResponse(item => new URL(item.url()).pathname === "/api/evaluations/findings/comparisons" && item.request().method() === "POST");
  await page.getByRole("button", { name: "Compare selected findings", exact: true }).click(); const created = await response; expect(created.status()).toBe(201);
  const value = await created.json(); await expect(page.getByRole("region", { name: "Persisted finding comparison", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Saved finding comparison", exact: true })).toHaveValue(value.comparison.id); return value;
}
async function hold(page: Page, pathname: string, all = false) {
  let release!: () => void, acquired!: () => void; const pending = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { acquired = resolve; });
  const statuses: number[] = [], inFlight: Promise<void>[] = []; let captured = false;
  const matcher = (url: URL) => url.pathname === pathname;
  const handler = async (route: Route) => {
    if (route.request().method() !== "GET" || captured && !all) { await route.continue(); return; }
    const first = !captured; captured = true;
    const work = (async () => { const response = await route.fetch(); statuses.push(response.status()); if (first) { expect(response.status()).toBe(200); acquired(); } await pending;
      try { await route.fulfill({ response }); } catch { /* Current-generation fencing may abort the genuine deferred body. */ } })();
    inFlight.push(work); await work;
  };
  await page.route(matcher, handler);
  return { ready, release, statuses, close: async () => { release(); await page.unroute(matcher); await Promise.all(inFlight); } };
}
async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(name), fullPage: true });
}

test("finding workspace: existing evaluation workspaces remain available before the new comparison entry", async ({ page, request, runPhantom }, testInfo) => {
  await seedEvaluationRuns(request, runPhantom.url);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 950 });
    await page.goto(`${runPhantom.url}/evaluations`);
    await expect(page.getByRole("heading", { name: "Evaluations", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "External reports", exact: true }).click();
    await expect(page.getByRole("heading", { name: "External reports", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Regression workbench", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`prior-workspace-${width}.png`), fullPage: true });
  }
  await expect(page.getByRole("button", { name: "Finding comparison", exact: true })).toBeVisible();
});

test("real File imports, conditional duplicate counts, export and reload preserve a failed frozen experiment and captured output", async ({ page, request, runPhantom }, testInfo) => {
  await seedEvaluationRuns(request, runPhantom.url);
  const dataset = await createEvaluationDataset(request, runPhantom.url, [{ kind: "output", operation: "contains", value: "paid" }], "Finding invariance control");
  const failed = await startEvaluation(request, runPhantom.url, dataset, EVALUATION_RUNS.rejected, "Failed output remains failed");
  const frozenBefore = await (await request.get(`${runPhantom.url}/api/evaluations/experiments/${failed.id}`)).text();
  const spansBefore = await (await request.get(`${runPhantom.url}/api/runs/${EVALUATION_RUNS.rejected}/spans`)).text();
  const rootId = EVALUATION_RUNS.rejected.slice(-8) + "00000001", payloadUrl = `${runPhantom.url}/api/spans/${rootId}/payload`;
  const inputBefore = await (await request.get(payloadUrl + "?target=input")).text(), outputBefore = await (await request.get(payloadUrl + "?target=output")).text();
  await page.goto(`${runPhantom.url}/evaluations?view=findings&anchorKind=experiment&anchorId=${failed.id}`);
  await importFile(page, "baseline", producer("snapshot-a", 2)); await importFile(page, "candidate", producer("snapshot-b", 3));
  const created = await compare(page), region = page.getByRole("region", { name: "Persisted finding comparison", exact: true });
  expect(created.comparison.difference).toMatchObject({ interpretation: "conditional", authentication: "not_authenticated", counts: { retained: 2, introduced: 1, removed: 0, unresolved: 0 } });
  await expect(region.getByText("Conditional delta", { exact: true })).toBeVisible(); await expect(region.getByText(/no test-pass verdict is inferred/)).toBeVisible();
  const downloaded = page.waitForEvent("download"); await region.getByRole("button", { name: "Export finding comparison JSON", exact: true }).click(); const file = await downloaded;
  const target = testInfo.outputPath("real-finding-export.json"); await file.saveAs(target);
  const saved = JSON.parse(readFileSync(target, "utf8")), direct = await (await request.get(`${runPhantom.url}/api/evaluations/findings/comparisons/${created.comparison.id}/export`)).json(); expect(saved).toEqual(direct);
  await page.reload(); await expect(region).toBeVisible(); expect(await (await request.get(`${runPhantom.url}/api/evaluations/experiments/${failed.id}`)).text()).toBe(frozenBefore);
  expect(await (await request.get(`${runPhantom.url}/api/runs/${EVALUATION_RUNS.rejected}/spans`)).text()).toBe(spansBefore);
  expect(await (await request.get(payloadUrl + "?target=input")).text()).toBe(inputBefore); expect(await (await request.get(payloadUrl + "?target=output")).text()).toBe(outputBefore);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 950 }); await region.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect.poll(() => page.evaluate(() => document.fonts.check('700 28px Syne') && document.fonts.check('400 14px "Inter Variable"'))).toBe(true);
    await capture(page, testInfo, `conditional-${width}.png`);
  }
});

test("fresh retained-source discovery revokes disclosed details and held export before deferred bodies arrive, then explicit reload permits a new import", async ({ page, request, runPhantom }, testInfo) => {
  await seedEvaluationRuns(request, runPhantom.url); await page.setViewportSize({ width: 390, height: 950 });
  await page.goto(`${runPhantom.url}/evaluations?view=findings&anchorKind=run&anchorId=${EVALUATION_RUNS.baseline}`);
  const baseline = await importFile(page, "baseline", producer("snapshot-a")), candidate = await importFile(page, "candidate", producer("snapshot-b", 2, "PRIVATE_CAPTURED_FINDING"));
  const created = await compare(page), region = page.getByRole("region", { name: "Persisted finding comparison", exact: true });
  await expect(region.getByText("PRIVATE_CAPTURED_FINDING", { exact: true }).first()).toBeVisible(); await capture(page, testInfo, "authority-before-390.png");
  const report = await hold(page, `/api/evaluations/findings/comparisons/${created.comparison.id}`, true), exported = await hold(page, `/api/evaluations/findings/comparisons/${created.comparison.id}/export`), downloads: string[] = [];
  page.on("download", item => downloads.push(item.suggestedFilename()));
  try {
    await region.getByRole("button", { name: "Export finding comparison JSON", exact: true }).click(); await exported.ready; await report.ready;
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/evaluations/findings/batches" && response.status() === 200);
    expect((await request.delete(`${runPhantom.url}/api/evaluations/evidence/sets/${candidate.setId}/retention/normalized?revision=1`, { data: {} })).status()).toBe(200);
    const roster = await (await refreshed).json(); expect(roster.items.some((item: { reference: { setId: string } }) => item.reference.setId === candidate.setId)).toBe(false);
    await expect(region).toHaveCount(0); await expect(page.getByRole("alert")).toBeVisible();
    await exported.close(); await report.close(); expect(downloads).toEqual([]); await expect(page.getByText("PRIVATE_CAPTURED_FINDING", { exact: true })).toHaveCount(0);
    expect((await request.get(`${runPhantom.url}/api/evaluations/findings/comparisons/${created.comparison.id}/export`)).status()).toBe(404);
    await capture(page, testInfo, "authority-refused-390.png");
    await page.getByRole("button", { name: "Reload authorized findings", exact: true }).click(); await expect(page.getByLabel("Candidate finding JSON", { exact: true })).toBeEnabled();
    await importFile(page, "candidate", producer("fresh-authorized", 3)); await page.getByRole("combobox", { name: "Baseline finding snapshot", exact: true }).selectOption(JSON.stringify(baseline));
    const fresh = await compare(page); expect(fresh.comparison.difference.counts).toEqual({ retained: 1, introduced: 2, removed: 0, unresolved: 0 });
    await capture(page, testInfo, "authority-recovered-390.png"); writeFileSync(testInfo.outputPath("authority-observation.json"), JSON.stringify({ actualRetainedDelete: 200, oldExportAfterDelete: 404, oldReportResponses: report.statuses, heldExportResponses: exported.statuses, downloads, newId: fresh.comparison.id }, null, 2));
  } finally { await exported.close(); await report.close(); }
});

test("saved comparison selection fences a late genuine successful response from the previous selection", async ({ page, request, runPhantom }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await seedEvaluationRuns(request, runPhantom.url);
  await page.goto(`${runPhantom.url}/evaluations?view=findings&anchorKind=run&anchorId=${EVALUATION_RUNS.baseline}`);
  await importFile(page, "baseline", producer("same-a")); await importFile(page, "candidate", producer("same-b", 1, "FIRST_PRIVATE_FINDING")); const first = await compare(page);
  await importFile(page, "candidate", producer("different-c", 1, "SECOND_CURRENT_FINDING")); const second = await compare(page);
  await page.getByRole("combobox", { name: "Saved finding comparison", exact: true }).selectOption(first.comparison.id);
  const region = page.getByRole("region", { name: "Persisted finding comparison", exact: true }); await expect(region.getByText("FIRST_PRIVATE_FINDING", { exact: true })).toBeVisible();
  const delayed = await hold(page, `/api/evaluations/findings/comparisons/${first.comparison.id}`);
  try {
    await delayed.ready; await page.getByRole("combobox", { name: "Saved finding comparison", exact: true }).selectOption(second.comparison.id);
    await expect(region.getByText("SECOND_CURRENT_FINDING", { exact: true })).toBeVisible();
    await page.evaluate(() => {
      const findings: string[] = []; const observer = new MutationObserver(() => { if (document.querySelector('[aria-label="Persisted finding comparison"]')?.textContent?.includes("FIRST_PRIVATE_FINDING")) findings.push("previous selection returned after current details were visible"); });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true }); Object.assign(window, { f07PreviousSelectionObservation: { findings, observer } });
    });
    await delayed.close();
    const flashes = await page.evaluate(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const observation = (window as unknown as { f07PreviousSelectionObservation: { findings: string[]; observer: MutationObserver } }).f07PreviousSelectionObservation; observation.observer.disconnect(); return observation.findings;
    });
    writeFileSync(testInfo.outputPath("late-selection-observation.json"), JSON.stringify({ actualHeldStatuses: delayed.statuses, previousSelectionFlashes: flashes }, null, 2)); expect(flashes).toEqual([]);
    await expect(region.getByText("SECOND_CURRENT_FINDING", { exact: true })).toBeVisible(); await expect(region.getByText("FIRST_PRIVATE_FINDING", { exact: true })).toHaveCount(0);
    await capture(page, testInfo, "current-selection-1440.png");
  } finally { await delayed.close(); }
});

test("a valid exact comparison direct link remains usable beyond the bounded fifty-item attachment history", async ({ page, request, runPhantom }, testInfo) => {
  await seedEvaluationRuns(request, runPhantom.url);
  await page.goto(`${runPhantom.url}/evaluations?view=findings&anchorKind=run&anchorId=${EVALUATION_RUNS.baseline}`);
  const baseline = await importFile(page, "baseline", producer("old-a")), candidate = await importFile(page, "candidate", producer("old-b", 2)); const old = await compare(page);
  for (let index = 0; index < 51; index++) expect((await request.post(`${runPhantom.url}/api/evaluations/findings/comparisons`, { data: { baseline, candidate, operationKey: `later-actual-${index}` } })).status()).toBe(201);
  const query = new URLSearchParams({ attachment: JSON.stringify({ kind: "run", id: EVALUATION_RUNS.baseline }) });
  const history = await (await request.get(`${runPhantom.url}/api/evaluations/findings/comparisons?${query}`)).json(); expect(history.items).toHaveLength(50); expect(history.truncated).toBe(true); expect(history.items.some((item: { id: string }) => item.id === old.comparison.id)).toBe(false);
  expect((await request.get(`${runPhantom.url}/api/evaluations/findings/comparisons/${old.comparison.id}/authority?${query}`)).status()).toBe(200);
  await page.goto(`${runPhantom.url}/evaluations?view=findings&anchorKind=run&anchorId=${EVALUATION_RUNS.baseline}&findingComparison=${old.comparison.id}`);
  await expect(page.getByRole("region", { name: "Persisted finding comparison", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0); await capture(page, testInfo, "direct-link-outside-history.png");
});

test("actual empty and unexecuted candidate reports remain distinct in mounted comparison details", async ({ page, request, runPhantom }, testInfo) => {
  await seedEvaluationRuns(request, runPhantom.url);
  await page.goto(`${runPhantom.url}/evaluations?view=findings&anchorKind=run&anchorId=${EVALUATION_RUNS.baseline}`);
  await importFile(page, "baseline", producer("covered-baseline")); await importFile(page, "candidate", producer("covered-empty", 0));
  const empty = await compare(page), region = page.getByRole("region", { name: "Persisted finding comparison", exact: true });
  expect(empty.comparison.difference.counts).toEqual({ retained: 0, introduced: 0, removed: 1, unresolved: 0 }); await expect(region.getByText("Conditional delta", { exact: true })).toBeVisible();
  const notRun = producer("not-executed", 0); notRun.reportedExecution.status = "not_run"; notRun.reportedExecution.files[0].status = "not_run";
  await importFile(page, "candidate", notRun); const unknown = await compare(page);
  expect(unknown.comparison.difference).toMatchObject({ observed: { baseline: 1, candidate: 0 }, counts: { retained: null, introduced: null, removed: null } });
  await expect(region.getByText("Delta unavailable", { exact: true })).toBeVisible(); await expect(region.getByText(/reported_execution_incomplete/)).toBeVisible();
  expect(await region.getByText("Unavailable", { exact: true }).count()).toBe(3); await capture(page, testInfo, "unexecuted-candidate.png");
});

test("an operator reviews the exact imported rename and checker pair through real mounted controls", async ({ page, request, runPhantom }, testInfo) => {
  await seedEvaluationRuns(request, runPhantom.url);
  await page.goto(`${runPhantom.url}/evaluations?view=findings&anchorKind=run&anchorId=${EVALUATION_RUNS.baseline}`);
  await importFile(page, "baseline", producer("before-move")); const renamed = producer("after-move");
  renamed.checker.version = "2.0.0"; renamed.declaredScope[0] = "src/renamed.ts"; renamed.reportedExecution.files[0].path = "src/renamed.ts"; renamed.findings[0].path = "src/renamed.ts"; renamed.findings[0].startLine = 80; renamed.findings[0].endLine = 80;
  await importFile(page, "candidate", renamed); const incompatible = await compare(page); expect(incompatible.comparison.difference.counts.retained).toBeNull();
  await page.locator("summary").filter({ hasText: "Review an exact rename or checker compatibility mapping" }).click();
  const save = page.getByRole("button", { name: "Save operator-reviewed mapping", exact: true }); await expect(save).toBeDisabled();
  await page.getByLabel("Reviewed baseline path", { exact: true }).fill("src/a.ts"); await page.getByLabel("Reviewed candidate path", { exact: true }).fill("src/renamed.ts");
  await page.getByLabel("Mapping review reason", { exact: true }).fill("Reviewed these exact two snapshots and checker configurations");
  await page.getByLabel("I reviewed these exact snapshots and checker configurations", { exact: true }).check();
  const mappingResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/evaluations/findings/mappings" && response.request().method() === "POST"); await save.click();
  const mapping = await mappingResponse; expect(mapping.status()).toBe(201); const reviewed = await mapping.json(); expect(reviewed.actor).toBe("local_operator");
  await expect(page.getByText("Exact reviewed mapping selected.", { exact: true })).toBeVisible();
  const result = await compare(page); expect(result.comparison.mappingId).toBe(reviewed.id); expect(result.comparison.difference.counts).toEqual({ retained: 1, introduced: 0, removed: 0, unresolved: 0 });
  await expect(page.getByRole("region", { name: "Persisted finding comparison", exact: true }).getByRole("heading", { name: "retained · location moved", exact: true })).toBeVisible();
  await capture(page, testInfo, "operator-reviewed-pair.png");
});

test("real persisted occurrence pagination is keyboard usable and exports the complete approved finite report", async ({ page, request, runPhantom }, testInfo) => {
  await seedEvaluationRuns(request, runPhantom.url);
  await page.goto(`${runPhantom.url}/evaluations?view=findings&anchorKind=run&anchorId=${EVALUATION_RUNS.baseline}`);
  await importFile(page, "baseline", producer("pagination-before", 1)); await importFile(page, "candidate", producer("pagination-after", 150)); const created = await compare(page);
  const region = page.getByRole("region", { name: "Persisted finding comparison", exact: true }); expect(created.page.items).toHaveLength(100); await expect(region.locator("ol > li")).toHaveCount(100);
  const next = region.getByRole("button", { name: "Next finding page", exact: true }); await next.focus(); await page.keyboard.press("Enter"); await expect(region.getByText("Showing 101–150 of 150 observed occurrences.", { exact: true })).toBeVisible();
  await expect(region.locator("ol > li")).toHaveCount(50); await expect(next).toBeDisabled();
  const downloaded = page.waitForEvent("download"); await region.getByRole("button", { name: "Export finding comparison JSON", exact: true }).click(); const file = await downloaded, target = testInfo.outputPath("all-occurrences.json"); await file.saveAs(target);
  const report = JSON.parse(readFileSync(target, "utf8")); expect(report.comparison.difference.occurrences).toHaveLength(150); expect(report.candidate.findings).toHaveLength(150);
  await capture(page, testInfo, "keyboard-pagination.png");
});
