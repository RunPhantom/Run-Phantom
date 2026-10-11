import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test, expect } from "./fixtures";
import { createEvaluationDataset, EVALUATION_INPUT, EVALUATION_RUNS, seedEvaluationRuns, startEvaluation } from "./evaluation-fixture";
import type { DatasetRevision, Experiment } from "../../src/evaluations/protocol";
import type { EvaluationReport } from "../../src/evaluations/report";
import type { Page } from "@playwright/test";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

test("protected evaluations: user sees missing graph/modality evidence and downloads unchanged frozen reports after source edits", async ({ page, request, runPhantom }, testInfo) => {
  await seedEvaluationRuns(request, runPhantom.url);
  const reference = await createEvaluationDataset(request, runPhantom.url, [{ kind: "output", operation: "equals", value: '{"status":"paid"}' }], "Protected checkout");
  const complete = await startEvaluation(request, runPhantom.url, reference, EVALUATION_RUNS.baseline, "Complete text control");
  const text = (key: string, value: string) => ({ key, value: { stringValue: value } });
  const stamp = (offset: number) => String((1_780_000_000_000n + BigInt(offset)) * 1_000_000n);
  const spansFor = (traceId: string, input: string) => [{ traceId, spanId: "0000000000000001", name: "Protected capture", kind: 1,
    startTimeUnixNano: stamp(0), endTimeUnixNano: stamp(100), status: { code: 1 }, attributes: [
      text("runphantom.span.kind", "agent_root"), text("runphantom.input", input), text("runphantom.output", '{"status":"paid"}'),
    ] }];
  const incompleteId = "0000000000000000000000000000f001";
  const incompleteSpans = [...spansFor(incompleteId, EVALUATION_INPUT), {
    ...spansFor(incompleteId, EVALUATION_INPUT)[0], spanId: "0000000000000002", parentSpanId: "ffffffffffffffff",
    name: "Orphaned captured tool", attributes: [text("ai.operationId", "ai.toolCall"), text("ai.toolCall.name", "checkout")],
  }];
  const imageId = "0000000000000000000000000000f002";
  const imageInput = JSON.stringify([{ role: "user", content: [{ type: "text", text: EVALUATION_INPUT }, { type: "image", image: "different-image.png" }] }]);
  for (const spans of [incompleteSpans, spansFor(imageId, imageInput)]) {
    expect((await request.post(`${runPhantom.url}/v1/traces`, { data: { resourceSpans: [{ scopeSpans: [{ spans }] }] } })).ok()).toBe(true);
  }
  const incomplete = await startEvaluation(request, runPhantom.url, reference, incompleteId, "Incomplete graph preserved");
  const image = await startEvaluation(request, runPhantom.url, reference, imageId, "Image identity unavailable");
  expect(incomplete.results[0]).toMatchObject({ inputMatch: "match", status: "inconclusive", snapshot: { complete: false } });
  expect(image.results[0]).toMatchObject({ inputMatch: "unavailable", status: "inconclusive", snapshot: { input: null } });
  const loaded = await page.goto(`${runPhantom.url}/evaluations`);
  expect(loaded?.status(), "The completed production build must serve the evaluation document").toBe(200);
  expect(loaded?.headers()["content-type"]).toContain("text/html");
  await expect(page.getByRole("heading", { name: "Evaluations", exact: true })).toBeVisible();
  const results = page.getByRole("region", { name: "Experiment results", exact: true });
  const before = new Map<string, string>();
  for (const experiment of [complete, incomplete, image]) {
    await page.getByRole("combobox", { name: "View experiment", exact: true }).selectOption(experiment.id);
    await expect(results.getByRole("article", { name: `Checkout result: ${experiment.verdict}`, exact: true })).toBeVisible();
    await expect(results.getByText(new RegExp(`${experiment.summary.pass} / 1 cases passed`))).toBeVisible();
    const pending = page.waitForEvent("download");
    await results.getByRole("button", { name: "Download JSON report", exact: true }).click();
    const download = await pending, destination = testInfo.outputPath(`${experiment.id}.before.json`);
    await download.saveAs(destination);
    const content = await readFile(destination, "utf8"), exported = JSON.parse(content) as EvaluationReport;
    before.set(experiment.id, hash(content));
    expect(exported.summary).toEqual(experiment.summary);
    expect(exported.gate.pass).toBe(experiment.id === complete.id);
    expect(exported.cases[0].checks[0].evaluatorVersion).toBe("code:2");
    expect(content).not.toContain(EVALUATION_INPUT);
  }
  const unavailable = results.getByText("Input unavailable: exact comparison is impossible. No model judge was called for this case.", { exact: true });
  await results.evaluate(element => element.scrollIntoView({ block: "start", behavior: "instant" }));
  await expect(unavailable).toBeVisible();
  await expect(unavailable).toBeInViewport({ ratio: 1 });
  await expect(results.getByRole("button", { name: "Download JSON report", exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath("protected-evidence-unknown-desktop.png") });
  await testInfo.attach("protected-evidence-unknown-desktop", { path: testInfo.outputPath("protected-evidence-unknown-desktop.png"), contentType: "image/png" });
  const baselineRoot = spansFor(EVALUATION_RUNS.baseline, "Edited source request")[0];
  baselineRoot.spanId = `${EVALUATION_RUNS.baseline.slice(-8)}00000001`;
  baselineRoot.attributes[2] = text("runphantom.output", "Edited source response");
  expect((await request.post(`${runPhantom.url}/v1/traces`, { data: { resourceSpans: [{ scopeSpans: [{ spans: [baselineRoot] }] }] } })).ok()).toBe(true);
  const edit = await request.put(`${runPhantom.url}/api/evaluations/datasets/${reference.datasetId}`, { data: {
    expectedVersion: reference.version, cases: [{ id: reference.cases[0].id, name: "Edited later", input: "Edited source request",
      rules: [{ kind: "output", operation: "equals", value: "Edited source response" }] }],
  } });
  expect(edit.status()).toBe(201);
  expect((await edit.json() as DatasetRevision).version).toBe(reference.version + 1);
  const reopened = await page.reload();
  expect(reopened?.status(), "Reload requires the production assets to remain available throughout acceptance").toBe(200);
  expect(reopened?.headers()["content-type"]).toContain("text/html");
  await expect(page.getByRole("heading", { name: "Evaluations", exact: true })).toBeVisible();
  const datasets = page.getByRole("combobox", { name: "Dataset", exact: true });
  await datasets.selectOption(reference.datasetId);
  await expect(datasets).toHaveValue(reference.datasetId);
  const revisions = page.getByRole("combobox", { name: "Revision", exact: true });
  await expect(revisions).toHaveValue(String(reference.version + 1));
  await revisions.selectOption(String(reference.version));
  await expect(revisions).toHaveValue(String(reference.version));
  const cases = page.getByRole("region", { name: "Dataset cases", exact: true });
  await expect(cases.getByText("This is an immutable historical revision. Select the latest revision to make changes.", { exact: true })).toBeVisible();
  await expect(cases.getByRole("heading", { name: "Checkout result", exact: true })).toBeVisible();
  const savedExperiments = page.getByRole("combobox", { name: "View experiment", exact: true });
  await expect(savedExperiments.locator("option")).toHaveCount(4);
  for (const frozen of [complete, incomplete, image]) {
    await expect(savedExperiments.locator("option").filter({ hasText: frozen.name })).toHaveAttribute("value", frozen.id);
    await savedExperiments.selectOption(frozen.id);
    await expect(savedExperiments).toHaveValue(frozen.id);
    await expect(results.getByRole("heading", { name: frozen.name, exact: true })).toBeVisible();
    await expect(results.getByRole("article", { name: `Checkout result: ${frozen.verdict}`, exact: true })).toBeVisible();
    const pending = page.waitForEvent("download");
    await results.getByRole("button", { name: "Download JSON report", exact: true }).click();
    const download = await pending, destination = testInfo.outputPath(`${frozen.id}.after.json`);
    await download.saveAs(destination);
    expect(hash(await readFile(destination, "utf8"))).toBe(before.get(frozen.id));
    const persisted = await request.get(`${runPhantom.url}/api/evaluations/experiments/${frozen.id}`);
    expect(await persisted.json() as Experiment).toEqual(frozen);
  }
  await page.getByRole("combobox", { name: "View experiment", exact: true }).selectOption(complete.id);
  await page.setViewportSize({ width: 390, height: 844 });
  const passedArticle = results.getByRole("article", { name: "Checkout result: pass", exact: true });
  await results.evaluate(element => {
    element.scrollIntoView({ block: "start", behavior: "instant" });
    let scroller = element.parentElement;
    while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
    scroller?.scrollBy({ top: -56, behavior: "instant" });
  });
  await expect(results.getByRole("heading", { name: "Complete text control", exact: true })).toBeInViewport({ ratio: 1 });
  await expect(passedArticle).toBeVisible();
  await expect(passedArticle.getByText("Pass", { exact: true })).toBeInViewport({ ratio: 1 });
  await expect(passedArticle.getByLabel("Code check score", { exact: true })).toHaveText("Score: 1");
  await expect(passedArticle.getByLabel("Code check score", { exact: true })).toBeInViewport({ ratio: 1 });
  await expect(results.getByRole("button", { name: "Download JSON report", exact: true })).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: testInfo.outputPath("protected-evidence-frozen-mobile.png") });
  await testInfo.attach("protected-evidence-frozen-mobile", { path: testInfo.outputPath("protected-evidence-frozen-mobile.png"), contentType: "image/png" });
});

test("protected evaluations: two user tabs reject a stale save and reload the accepted revision without overwriting it", async ({ page, request, runPhantom }, testInfo) => {
  await seedEvaluationRuns(request, runPhantom.url);
  const revision = await createEvaluationDataset(request, runPhantom.url, [{ kind: "output", operation: "equals", value: '{"status":"paid"}' }], "Two client edits");
  const other = await page.context().newPage();
  try {
    for (const tab of [page, other]) {
      await tab.goto(`${runPhantom.url}/evaluations`);
      await tab.getByRole("combobox", { name: "Dataset", exact: true }).selectOption(revision.datasetId);
      await expect(tab.getByRole("combobox", { name: "Revision", exact: true })).toHaveValue(String(revision.version));
      await tab.getByRole("button", { name: "Edit case Checkout result", exact: true }).click();
      await tab.getByRole("textbox", { name: "Case name", exact: true }).fill(tab === page ? "Client A accepted" : "Client B stale");
      await tab.getByRole("button", { name: "Update case draft", exact: true }).click();
    }
    async function save(tab: Page) {
      const response = tab.waitForResponse(reply => reply.request().method() === "PUT" && reply.url().endsWith(`/api/evaluations/datasets/${revision.datasetId}`));
      await tab.getByRole("button", { name: "Save new revision", exact: true }).click();
      return response;
    }
    expect((await save(page)).status()).toBe(201);
    await expect(page.getByRole("combobox", { name: "Revision", exact: true })).toHaveValue(String(revision.version + 1));
    expect((await save(other)).status()).toBe(409);
    const editor = other.getByRole("region", { name: "Dataset cases", exact: true });
    const conflict = editor.getByRole("alert"), staleDraft = editor.getByRole("heading", { name: "Client B stale", exact: true });
    await expect(conflict).toHaveText("Dataset changed; reload before saving");
    await expect(staleDraft).toBeVisible();
    const accepted = await request.get(`${runPhantom.url}/api/evaluations/datasets/${revision.datasetId}`);
    const current = await accepted.json() as DatasetRevision;
    expect(current.version).toBe(revision.version + 1);
    expect(current.cases[0].name).toBe("Client A accepted");
    await editor.evaluate(element => element.scrollIntoView({ block: "start", behavior: "instant" }));
    await expect(conflict).toBeVisible();
    await expect(conflict).toBeInViewport({ ratio: 1 });
    await expect(staleDraft).toBeInViewport({ ratio: 1 });
    await other.screenshot({ path: testInfo.outputPath("protected-revision-conflict.png") });
    await testInfo.attach("protected-revision-conflict", { path: testInfo.outputPath("protected-revision-conflict.png"), contentType: "image/png" });
    await other.reload();
    await expect(other.getByRole("combobox", { name: "Revision", exact: true })).toHaveValue(String(current.version));
    await expect(editor.getByRole("heading", { name: "Client A accepted", exact: true })).toBeVisible();
    await expect(editor.getByRole("heading", { name: "Client B stale", exact: true })).toHaveCount(0);
    expect((await request.get(`${runPhantom.url}/api/evaluations/datasets/${revision.datasetId}?version=${current.version + 1}`)).status()).toBe(404);
  } finally { await other.close(); }
});
