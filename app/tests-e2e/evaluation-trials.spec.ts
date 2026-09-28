import { readFile } from "node:fs/promises";
import { test, expect } from "./fixtures";
import { seedEvaluationRuns, createEvaluationDataset, EVALUATION_RUNS } from "./evaluation-fixture";
import type { DatasetRevision, Experiment } from "../../src/evaluations/protocol";

for (const caseCount of [1, 2]) test(`explicit repeated trials preserve mixed outcomes and export the displayed selection (${caseCount} cases)`, async ({ page, request, runPhantom }, testInfo) => {
  await seedEvaluationRuns(request, runPhantom.url);
  let revision = await createEvaluationDataset(request, runPhantom.url, [{ kind: "output", operation: "equals", value: '{"status":"paid"}' }]);
  if (caseCount === 2) {
    const response = await request.put(`${runPhantom.url}/api/evaluations/datasets/${revision.datasetId}`, { data: {
      expectedVersion: revision.version,
      cases: ["Checkout result", "Second checkout result"].map(name => ({ name, sourceRunId: EVALUATION_RUNS.baseline, rules: revision.cases[0].rules })),
    } });
    expect(response.status()).toBe(201);
    revision = await response.json() as DatasetRevision;
  }
  const trials: Array<{ id: string; name: string }> = [];
  for (const [index, runId] of [EVALUATION_RUNS.baseline, EVALUATION_RUNS.rejected, EVALUATION_RUNS.mismatch, EVALUATION_RUNS.baseline].entries()) {
    const name = `Trial ${index + 1}`;
    const response = await request.post(`${runPhantom.url}/api/evaluations/experiments`, { data: { datasetId: revision.datasetId, name, assignments: revision.cases.map(item => ({ caseId: item.id, runId })) } });
    expect(response.status()).toBe(202); const value = await response.json() as Experiment;
    await expect.poll(async () => (await (await request.get(`${runPhantom.url}/api/evaluations/experiments/${value.id}`)).json() as Experiment).status).toBe("completed");
    trials.push({ id: value.id, name });
  }
  await page.goto(`${runPhantom.url}/evaluations`);
  const panel = page.getByRole("region", { name: "Repeated trial analysis" });
  for (const trial of trials.slice(0, 3)) await panel.getByRole("checkbox", { name: new RegExp(`^${trial.name} ·`) }).check();
  await panel.getByRole("button", { name: "Analyze selected trials" }).click();
  const result = panel.getByLabel("Repeated trial results");
  await expect(result).toContainText(`3 selected trials · ${caseCount === 1 ? "1 case" : "2 cases"} · ${3 * caseCount} case-trial outcomes`);
  await expect(result).toContainText(`Pass: ${caseCount} · Fail: ${caseCount} · Inconclusive: ${caseCount}`);
  await expect(result).toContainText("not a confidence interval");
  const downloadPromise = page.waitForEvent("download"); await panel.getByRole("button", { name: "Download trial analysis JSON" }).click();
  const download = await downloadPromise; const file = testInfo.outputPath(download.suggestedFilename()); await download.saveAs(file);
  const text = await readFile(file, "utf8"); const report = JSON.parse(text);
  expect(report.format).toBe("runphantom-repeated-trial-analysis/v1"); expect(report.trials.map((item: { experimentId: string }) => item.experimentId)).toEqual(trials.slice(0, 3).map(item => item.id));
  expect(report.summary).toMatchObject({ pass: caseCount, fail: caseCount, inconclusive: caseCount, total: 3 * caseCount }); expect(text).not.toContain("Describe the result of this checkout.");
  await result.getByRole("button", { name: "Trial 1: pass", exact: true }).first().click();
  await expect(page.getByRole("combobox", { name: "View experiment", exact: true })).toHaveValue(trials[0].id);
  await expect(page.getByRole("region", { name: "Experiment results", exact: true })).toContainText(caseCount === 1 ? "1 / 1 case passed" : "2 / 2 cases passed");
  await panel.getByRole("checkbox", { name: /^Trial 4 ·/ }).check();
  await expect(panel.getByLabel("Repeated trial results")).toHaveCount(0);
  await panel.getByRole("button", { name: "Analyze selected trials" }).click();
  await expect(panel.getByRole("alert")).toContainText("same captured run");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
