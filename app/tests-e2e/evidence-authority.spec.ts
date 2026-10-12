import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { Page, Route } from "@playwright/test";
import { test, expect } from "./fixtures";
import { seedEvaluationRuns, EVALUATION_RUNS } from "./evaluation-fixture";

const sentinel = "PRIVATE_CAPTURED_SENTINEL";
async function imported(page: Page) {
  const workspace = page.getByTestId("evidence-workspace");
  const input = workspace.getByLabel("Report files", { exact: true });
  await expect(input).toBeEnabled();
  await input.setInputFiles({ name: "authority.xml", mimeType: "application/xml", buffer: Buffer.from(`<testsuite><testcase name="${sentinel}"/></testsuite>`) });
  await workspace.getByRole("button", { name: "Import reports", exact: true }).click();
  const report = workspace.getByRole("region", { name: "Persisted evidence report", exact: true }); await expect(report).toBeVisible();
  await report.getByRole("article").locator("summary").click(); await expect(report.getByText(sentinel, { exact: true })).toBeVisible();
  return { workspace, report, setId: new URL(page.url()).searchParams.get("evidenceSet")! };
}

test("file selection waits for actual capabilities after attachment authority is ready", async ({ page, request, runPhantom }, testInfo) => {
  await seedEvaluationRuns(request, runPhantom.url);
  const spansBefore = await (await request.get(`${runPhantom.url}/api/runs/${EVALUATION_RUNS.baseline}/spans`)).text();
  const inventory = await request.put(`${runPhantom.url}/api/evaluations/evidence/inventories`, { data: { anchor: { kind: "run", id: EVALUATION_RUNS.baseline }, expectedRevision: 0, expected: [{ shardId: "unit", kind: "junit", constraints: { runnerId: null, commit: null, sourceSha256: null } }] } }); expect(inventory.status()).toBe(201);
  const capabilities = await hold(page, "/api/evaluations/evidence/capabilities");
  try {
    await page.goto(`${runPhantom.url}/evaluations?view=evidence&anchorKind=run&anchorId=${EVALUATION_RUNS.baseline}`); await capabilities.ready;
    const workspace = page.getByTestId("evidence-workspace"), input = workspace.getByLabel("Report files", { exact: true });
    await expect(workspace.getByText("No saved external reports for this attachment yet.", { exact: true })).toBeVisible();
    await expect(workspace.getByText("Revision 1 · retrospective", { exact: true })).toBeVisible();
    const observed = { actualCapabilitiesResponseStatus: 200, responseHeld: true, currentHistoryVisible: true, currentInventoryVisible: true, nativeFileInputDisabled: await input.isDisabled(), importDisabled: await workspace.getByRole("button", { name: "Import reports", exact: true }).isDisabled() };
    writeFileSync(testInfo.outputPath("capabilities-readiness.json"), JSON.stringify(observed, null, 2));
    await input.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath("capabilities-pending.png"), fullPage: true });
    expect(observed.nativeFileInputDisabled).toBe(true); expect(observed.importDisabled).toBe(true);
    capabilities.release(); await capabilities.done; await expect(input).toBeEnabled();
    const { report } = await imported(page); await expect(report.getByText("Reports pass", { exact: true })).toBeVisible();
    expect(await (await request.get(`${runPhantom.url}/api/runs/${EVALUATION_RUNS.baseline}/spans`)).text()).toBe(spansBefore);
    await expect(workspace.getByRole("alert")).toHaveCount(0); await report.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath("capabilities-ready-import.png"), fullPage: true });
  } finally { await capabilities.close(); }
});
async function hold(page: Page, pathname: string) {
  let release!: () => void, acquired!: () => void, delivered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { acquired = resolve; }), done = new Promise<void>(resolve => { delivered = resolve; });
  const matcher = (url: URL) => url.pathname === pathname;
  let captured = false;
  const handler = async (route: Route) => {
    if (captured) { await route.continue(); return; } captured = true;
    const response = await route.fetch(); expect(response.status()).toBe(200); acquired(); await pending;
    try { await route.fulfill({ response }); } catch { /* A revoked read may already be aborted. */ } finally { delivered(); }
  };
  await page.route(matcher, handler);
  return { ready, release, done, close: async () => { release(); await page.unroute(matcher); } };
}
function fixtureSql(dbPath: string, sql: string, params: unknown[] = []) {
  const program = 'import { Database } from "bun:sqlite"; const db=new Database(process.argv[1]); try { console.log(JSON.stringify(db.query(process.argv[2]).all(...JSON.parse(process.argv[3])))); } finally { db.close(); }';
  const result = spawnSync("bun", ["-e", program, dbPath, sql, JSON.stringify(params)], { encoding: "utf8", env: { ...process.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" } });
  expect(result.status, result.stderr).toBe(0); return JSON.parse(result.stdout) as Array<{ active: number }>;
}

for (const width of [1440, 390]) test(`actual deletion/history refusal revokes a disclosed report and delayed reads at ${width}px`, async ({ page, request, runPhantom }, testInfo) => {
  await seedEvaluationRuns(request, runPhantom.url); await page.setViewportSize({ width, height: 900 });
  const roster = await request.put(`${runPhantom.url}/api/evaluations/evidence/inventories`, { data: { anchor: { kind: "run", id: EVALUATION_RUNS.baseline }, expectedRevision: 0, expected: [{ shardId: "unit", kind: "junit", constraints: { runnerId: null, commit: null, sourceSha256: null } }] } }); expect(roster.status()).toBe(201);
  const controlBefore = await (await request.get(`${runPhantom.url}/api/runs/${EVALUATION_RUNS.repaired}/spans`)).text();
  await page.goto(`${runPhantom.url}/evaluations?view=evidence&anchorKind=run&anchorId=${EVALUATION_RUNS.baseline}`);
  const { workspace, report, setId } = await imported(page); await report.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`authority-before-${width}.png`), fullPage: true });
  const delayed = await hold(page, `/api/evaluations/evidence/sets/${setId}`);
  const jobId = new URL(page.url()).searchParams.get("evidenceJob")!, peers = await Promise.all(["/api/evaluations/evidence/inventories", `/api/evaluations/evidence/imports/${jobId}`].map(path => hold(page, path)));
  try {
    await delayed.ready; await Promise.all(peers.map(peer => peer.ready));
    const refusal = page.waitForResponse(response => new URL(response.url()).pathname === "/api/evaluations/evidence/sets" && response.status() === 404);
    const deleted = await request.delete(`${runPhantom.url}/api/runs/${EVALUATION_RUNS.baseline}`); expect(deleted.status()).toBe(200); const denied = await refusal;
    await expect(workspace.getByRole("alert")).toContainText("not found");
    const observed = { deletion: deleted.status(), historyRefusal: denied.status(), priorReportCount: await report.count(), privateLeafVisible: await report.getByText(sentinel, { exact: true }).isVisible(), expectedReportCount: 0 };
    writeFileSync(testInfo.outputPath("actual-authority-refusal.json"), JSON.stringify(observed, null, 2)); await workspace.getByRole("alert").scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`authority-refused-${width}.png`), fullPage: true });
    expect(observed.priorReportCount).toBe(0); expect(observed.privateLeafVisible).toBe(false);
    await expect(workspace.getByRole("region", { name: "Evidence operation", exact: true })).toHaveCount(0); await expect(workspace.getByRole("region", { name: "Evidence export and privacy", exact: true })).toHaveCount(0);
    delayed.release(); await delayed.done; await expect(report).toHaveCount(0); await expect(workspace.getByText(sentinel, { exact: true })).toHaveCount(0);
    for (const peer of peers) { peer.release(); await peer.done; }
    await page.reload(); await expect(report).toHaveCount(0); await expect(workspace.getByRole("alert")).toContainText("not found");
    await workspace.getByRole("combobox", { name: "Evidence attachment", exact: true }).selectOption(EVALUATION_RUNS.repaired);
    await imported(page); await expect(report.getByText("Reports pass", { exact: true })).toBeVisible();
    expect(await (await request.get(`${runPhantom.url}/api/runs/${EVALUATION_RUNS.repaired}/spans`)).text()).toBe(controlBefore);
  } finally { await delayed.close(); await Promise.all(peers.map(peer => peer.close())); }
});

for (const boundary of ["inventory", "report", "job"] as const) test(`actual ${boundary} authority refusal fences previous bodies/actions and refresh recovers only fresh authorized data`, async ({ page, request, runPhantom }, testInfo) => {
  await seedEvaluationRuns(request, runPhantom.url);
  const spansBefore = await (await request.get(`${runPhantom.url}/api/runs/${EVALUATION_RUNS.baseline}/spans`)).text();
  const inventory = await request.put(`${runPhantom.url}/api/evaluations/evidence/inventories`, { data: { anchor: { kind: "run", id: EVALUATION_RUNS.baseline }, expectedRevision: 0, expected: [{ shardId: "unit", kind: "junit", constraints: { runnerId: null, commit: null, sourceSha256: null } }] } }); expect(inventory.status()).toBe(201);
  await page.goto(`${runPhantom.url}/evaluations?view=evidence&anchorKind=run&anchorId=${EVALUATION_RUNS.baseline}`);
  const { workspace, report, setId } = await imported(page), jobId = new URL(page.url()).searchParams.get("evidenceJob")!;
  const original = await (await request.get(`${runPhantom.url}/api/evaluations/evidence/sets/${setId}`)).text();
  const paths = { inventory: "/api/evaluations/evidence/inventories", report: `/api/evaluations/evidence/sets/${setId}`, job: `/api/evaluations/evidence/imports/${jobId}`, history: "/api/evaluations/evidence/sets" };
  const delayedReads = await Promise.all(Object.entries(paths).filter(([name]) => name !== boundary).map(([, pathname]) => hold(page, pathname)));
  const exportPath = `/api/evaluations/evidence/sets/${setId}/export`, delayedExport = await hold(page, exportPath), downloads: string[] = []; page.on("download", item => downloads.push(item.suggestedFilename()));
  try {
    await workspace.getByRole("button", { name: "Export JSON", exact: true }).click(); await delayedExport.ready; await Promise.all(delayedReads.map(read => read.ready));
    const deniedRead = page.waitForResponse(response => new URL(response.url()).pathname === paths[boundary] && response.status() === 404);
    expect(fixtureSql(runPhantom.dbPath, "UPDATE evaluation_evidence_scopes SET active=0 RETURNING active")[0].active).toBe(0);
    const denied = await deniedRead; await expect(workspace.getByRole("alert")).toContainText("unavailable");
    const observed = { refusedBoundary: boundary, actualHttpStatus: denied.status(), reportCount: await report.count(), operationCount: await workspace.getByRole("region", { name: "Evidence operation", exact: true }).count(), privateLeafCount: await workspace.getByText(sentinel, { exact: true }).count() };
    writeFileSync(testInfo.outputPath("actual-scope-refusal.json"), JSON.stringify(observed, null, 2)); await workspace.getByRole("alert").scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`authority-${boundary}-refused.png`), fullPage: true });
    expect(observed.reportCount).toBe(0); expect(observed.operationCount).toBe(0); expect(observed.privateLeafCount).toBe(0);
    await expect(workspace.getByRole("region", { name: "Evidence export and privacy", exact: true })).toHaveCount(0);
    expect(fixtureSql(runPhantom.dbPath, "UPDATE evaluation_evidence_scopes SET active=1 RETURNING active")[0].active).toBe(1);
    expect(await (await request.get(`${runPhantom.url}/api/evaluations/evidence/sets/${setId}`)).text()).toBe(original);
    await workspace.getByRole("button", { name: "Refresh evidence", exact: true }).click(); await expect(report).toBeVisible();
    await expect(report.getByText(sentinel, { exact: true })).toHaveCount(0);
    for (const read of delayedReads) { read.release(); await read.done; }
    const completedExport = page.waitForResponse(response => new URL(response.url()).pathname === exportPath); delayedExport.release(); const response = await completedExport; await response.finished(); await delayedExport.done;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))); expect(downloads).toEqual([]);
    await report.getByRole("article").locator("summary").click(); await expect(report.getByText(sentinel, { exact: true })).toBeVisible();
    await page.reload(); await expect(report).toBeVisible(); await expect(report.getByText(sentinel, { exact: true })).toHaveCount(0);
    expect(await (await request.get(`${runPhantom.url}/api/runs/${EVALUATION_RUNS.baseline}/spans`)).text()).toBe(spansBefore);
    await report.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`authority-${boundary}-recovered.png`), fullPage: true });
  } finally { fixtureSql(runPhantom.dbPath, "UPDATE evaluation_evidence_scopes SET active=1 RETURNING active"); await Promise.all(delayedReads.map(read => read.close())); await delayedExport.close(); }
});
