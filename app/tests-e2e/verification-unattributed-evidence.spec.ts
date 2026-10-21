import { execFileSync } from "node:child_process";
import { test, expect, connectTarget, assertRuntime, observe } from "./verification-fixture";
import type { VerificationReport } from "../../src/verification/protocol";

test("physical browser actions preserve complete interval evidence in API, SQL and reloaded UI", async ({ page, context, request, runPhantom, targetApp }) => {
  const session = await connectTarget(page, request, runPhantom, targetApp.origin);
  const before = await observe(request, runPhantom, session.id);
  await page.locator("#increment").click();
  await expect(page.locator("#synchronous-result")).toHaveText("Synchronous result");
  const report = await assertRuntime(request, runPhantom, session.id,
    { kind: "state", store: "checkout", path: "requests", equals: 1 }, before.cursor, "Physical interval observation");
  expect(report.status).toBe("pass");
  expect(report.evidence.length).toBeGreaterThan(0);
  for (const entry of report.evidence) {
    expect(entry.truncated === true).toBe(false);
    expect(Object.hasOwn(entry, "actionId")).toBe(false);
  }
  const live = await observe(request, runPhantom, session.id);
  expect(live.events.filter(entry => entry.type === "state").every(entry => entry.truncated !== true)).toBe(true);
  const stored = execFileSync("bun", ["--no-env-file", "--no-install", "-e",
    'import {Database} from "bun:sqlite"; const [file,id]=process.argv.slice(-2); const db=new Database(file,{readonly:true}); try{const row=db.query("SELECT evidence FROM verification_reports WHERE id = ?").get(id);console.log(JSON.stringify(row));}finally{db.close();}',
    "--", runPhantom.dbPath, report.id], { encoding: "utf8", timeout: 3000, maxBuffer: 64 * 1024 });
  const row = JSON.parse(stored) as { evidence: string } | null;
  expect(row).not.toBeNull();
  expect(JSON.parse(row!.evidence)).toEqual(report.evidence);
  const ui = await context.newPage();
  try {
    await ui.goto(`${runPhantom.url}/verification`);
    const card = ui.getByRole("article", { name: "Physical interval observation: pass", exact: true });
    await expect(card).toBeVisible();
    await expect(card.getByText("Complete capture", { exact: true })).toBeVisible();
    await ui.reload();
    await expect(card.getByText("Complete capture", { exact: true })).toBeVisible();
    const response = await request.get(`${runPhantom.url}/api/verification/reports`);
    expect(response.ok()).toBe(true);
    const reports = await response.json() as VerificationReport[];
    expect(reports.find(entry => entry.id === report.id)).toEqual(report);
  } finally { await ui.close(); }
});
