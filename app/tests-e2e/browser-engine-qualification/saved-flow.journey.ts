import { test, expect } from "./fixtures";
import { writeFileSync } from "node:fs";
import type { VerificationFlow, VerificationReport } from "../../../src/verification/protocol";
test("saved-flow: normal pairing and keyboard replay preserve saved definition and actual pass-to-fail output", async ({ page, context, backend }, info) => {
  await page.goto(backend.url + "/verification"); await page.getByLabel(/^App origin/).fill(backend.target); await page.getByRole("button", { name: "Pair app", exact: true }).click();
  const snippet = page.getByLabel("Application connection snippet", { exact: true }); await expect(snippet).toBeVisible(); const source = await snippet.innerText();
  const sessionId = /["']?sessionId["']?\s*:\s*["']([^"']+)["']/.exec(source)?.[1], token = /["']?token["']?\s*:\s*["']([^"']+)["']/.exec(source)?.[1];
  if (!sessionId || !token) throw new Error("BLOCKED: normal pairing did not provide a usable isolated connection");
  const target = await context.newPage();
  try {
    await target.goto(backend.target);
    await target.evaluate(async ({ url, id, credential }) => {
      const sdk = await import(`${url}/verification/sdk.js`) as { connect(options: { url: string; sessionId: string; token: string }): { disconnect(): void } };
      (window as Window & { f47Runtime?: { disconnect(): void } }).f47Runtime = sdk.connect({ url, sessionId: id, token: credential });
    }, { url: backend.url, id: sessionId, credential: token });
    await expect(page.getByText("Connected", { exact: true }).first()).toBeVisible(); await page.getByRole("button", { name: "Dismiss setup", exact: true }).click();
    const flowName = "F47 retained marker flow";
    // The paired editor and trusted-browser editor deliberately keep independent drafts.
    const editor = page.getByRole("combobox", { name: "Check type", exact: true }).first(); await editor.selectOption("element");
    await page.getByLabel("Element selector", { exact: true }).first().fill("#always");
    await page.getByRole("button", { name: "Add step to flow", exact: true }).click(); await page.getByLabel("Flow name", { exact: true }).fill(flowName); await page.getByRole("button", { name: "Save flow", exact: true }).click();
    const replay = page.getByRole("button", { name: `Replay ${flowName}`, exact: true }); await expect(replay).toBeVisible();
    const flowsBefore = (await backend.api<VerificationFlow[]>("/api/verification/flows")).body; expect(flowsBefore).toHaveLength(1); expect(flowsBefore[0].steps).toEqual([{ predicate: { kind: "element", selector: "#always", state: "present" } }]);
    await replay.focus(); await page.keyboard.press("Enter"); await expect(page.getByRole("article", { name: `${flowName}: pass`, exact: true })).toBeVisible();
    await target.getByRole("button", { name: "Remove marker", exact: true }).click(); await expect(target.locator("#always")).toHaveCount(0);
    await replay.click(); await expect(page.getByRole("article", { name: `${flowName}: fail`, exact: true })).toBeVisible();
    const reports = (await backend.api<VerificationReport[]>("/api/verification/reports")).body; expect(reports.map(report => report.status).sort()).toEqual(["fail", "pass"]); expect(reports.every(report => report.flowId === flowsBefore[0].id)).toBe(true);
    expect(JSON.stringify(reports)).not.toContain(token); expect((await backend.api<VerificationFlow[]>("/api/verification/flows")).body).toEqual(flowsBefore);
    await page.reload(); await expect(page.getByRole("button", { name: `Replay ${flowName}`, exact: true })).toBeVisible(); await expect(page.getByRole("article", { name: `${flowName}: fail`, exact: true })).toBeVisible(); expect((await backend.api<VerificationReport[]>("/api/verification/reports")).body).toEqual(reports);
    await page.getByRole("heading", { name: "Verification reports", exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath("safe-saved-flow-output.png"), mask: [page.getByLabel("Application connection snippet", { exact: true })] });
    writeFileSync(info.outputPath("actual-saved-flow.json"), JSON.stringify({ flowsBefore, reports, executedInputBackend: "paired-sdk", userFacingEngine: info.project.name, causalClaim: false }, null, 2));
  } finally { await target.close(); }
});
