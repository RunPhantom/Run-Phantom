import { test, expect, connectTarget, act, assertRuntime } from "./verification-fixture";
import { seedEvaluationRuns, EVALUATION_RUNS } from "./evaluation-fixture";
import type { VerificationReport } from "../../src/verification/protocol";
import type { EvidenceSetView } from "../../src/evaluations/evidence-protocol";
import type { Snapshot } from "../../src/evaluations/protocol";

test("evidence workspace: real saved checks and inspections retain their original output across report imports", async ({ page, context, request, runPhantom, targetApp }, testInfo) => {
  await seedEvaluationRuns(request, runPhantom.url);
  const session = await connectTarget(page, request, runPhantom, targetApp.origin, EVALUATION_RUNS.baseline);
  targetApp.setBroken(false);
  const before = await act(request, runPhantom, session.id, { type: "click", selector: "#checkout" });
  await expect(page.locator("#status")).toHaveText("paid");
  const original = await assertRuntime(request, runPhantom, session.id, { kind: "network", urlContains: "/api/checkout", method: "POST", status: 200 }, before, "Original runtime check");
  expect(original.status).toBe("pass");
  const beforeReports = await (await request.get(`${runPhantom.url}/api/verification/reports`)).json() as VerificationReport[];
  const beforeCheck = JSON.stringify(beforeReports.find(report => report.id === original.id));
  const beforeInspection = await (await request.get(`${runPhantom.url}/api/evaluations/runs/${EVALUATION_RUNS.baseline}/snapshot`)).json() as Snapshot;
  const spans = await request.get(`${runPhantom.url}/api/runs/${EVALUATION_RUNS.baseline}/spans`); expect(spans.ok()).toBe(true);
  const beforeSpans = await spans.text();
  const ui = await context.newPage();
  try {
    await ui.goto(`${runPhantom.url}/evaluations?view=evidence&anchorKind=check&anchorId=${original.id}`);
    const workspace = ui.getByTestId("evidence-workspace");
    await expect(workspace.getByRole("combobox", { name: "Evidence attachment", exact: true })).toHaveValue(original.id);
    await workspace.getByLabel("Report files", { exact: true }).setInputFiles({ name: "check.xml", mimeType: "application/xml", buffer: Buffer.from('<testsuite><testcase name="external failure"><failure>Report assertion</failure></testcase></testsuite>') });
    await workspace.getByRole("button", { name: "Import reports", exact: true }).click();
    const report = workspace.getByRole("region", { name: "Persisted evidence report", exact: true });
    await expect(report.getByText("Reports failure", { exact: true })).toBeVisible();
    let setId = new URL(ui.url()).searchParams.get("evidenceSet")!;
    const saved = await (await request.get(`${runPhantom.url}/api/evaluations/evidence/sets/${setId}`)).json() as EvidenceSetView;
    expect(saved.revision.attachment).toEqual({ kind: "check", id: original.id });
    expect(saved.revision.sources[0].leafCounts).toMatchObject({ executed: "1", failed: "1" });
    const afterReports = await (await request.get(`${runPhantom.url}/api/verification/reports`)).json() as VerificationReport[];
    expect(JSON.stringify(afterReports.find(entry => entry.id === original.id))).toBe(beforeCheck);
    await report.scrollIntoViewIfNeeded(); await ui.screenshot({ path: testInfo.outputPath("evidence-saved-check.png"), fullPage: true });
    await workspace.getByRole("combobox", { name: "Context type", exact: true }).selectOption("inspection");
    await workspace.getByRole("combobox", { name: "Evidence attachment", exact: true }).selectOption(EVALUATION_RUNS.baseline);
    await expect(report).toHaveCount(0);
    await workspace.getByLabel("Report files", { exact: true }).setInputFiles({ name: "inspection.xml", mimeType: "application/xml", buffer: Buffer.from('<testsuite><testcase name="inspection external pass"/></testsuite>') });
    await workspace.getByRole("button", { name: "Import reports", exact: true }).click();
    await expect(report.getByText("Reports pass", { exact: true })).toBeVisible();
    setId = new URL(ui.url()).searchParams.get("evidenceSet")!;
    const inspection = await (await request.get(`${runPhantom.url}/api/evaluations/evidence/sets/${setId}`)).json() as EvidenceSetView;
    expect(inspection.revision.attachment).toEqual({ kind: "inspection", id: EVALUATION_RUNS.baseline });
    expect(inspection.revision.coverage).toBe("not_declared");
    const afterInspection = await (await request.get(`${runPhantom.url}/api/evaluations/runs/${EVALUATION_RUNS.baseline}/snapshot`)).json() as Snapshot;
    // Live inspection time advances on every read; all captured output and source bytes stay unchanged.
    expect(afterInspection.capturedAt).toBeGreaterThanOrEqual(beforeInspection.capturedAt);
    expect({ ...afterInspection, capturedAt: beforeInspection.capturedAt }).toEqual(beforeInspection);
    expect(await (await request.get(`${runPhantom.url}/api/runs/${EVALUATION_RUNS.baseline}/spans`)).text()).toBe(beforeSpans);
    await report.scrollIntoViewIfNeeded(); await ui.screenshot({ path: testInfo.outputPath("evidence-inspection.png"), fullPage: true });
  } finally { await ui.close(); }
});
