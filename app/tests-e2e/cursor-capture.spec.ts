import { test, expect } from "./fixtures";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { capabilityOwnerKey } from "../../src/coding-hooks/capability";
import { cursorHook } from "../../tests/fixtures/coding-hooks-cursor";

test("synthetic native Cursor hooks reach actual Runs with original output and unverified completion", async ({ page, runPhantom }, testInfo) => {
  test.skip(process.platform === "win32", "Native Windows private hook capability ownership is not supported by the current installation contract");
  const profile = path.dirname(runPhantom.dbPath), workspace = path.join(profile, "Cursor workspace with spaces"); mkdirSync(workspace);
  const installed = await fetch(runPhantom.url + "/api/coding-hooks/claude/manage", { method: "POST", headers: { "content-type": "application/json", "x-runphantom-hook-owner": capabilityOwnerKey(runPhantom.dbPath) }, body: JSON.stringify({ action: "install", vendor: "cursor", scope: "local", workspace, captureMode: "full", fullConsent: true }) });
  expect(installed.status).toBe(200); const receipt = await installed.json() as { installationId: string; captureVerified: boolean }; expect(receipt.captureVerified).toBe(false);
  const settings = JSON.parse(readFileSync(path.join(workspace, ".cursor/hooks.json"), "utf8")) as { hooks: Record<string, { command: string }[]> };
  for (const event of ["sessionStart", "beforeSubmitPrompt", "postToolUse", "afterAgentResponse", "stop", "sessionEnd"]) {
    const command = settings.hooks[event].find(h => h.command.includes(receipt.installationId))!.command;
    const child = spawn("/bin/sh", ["-c", command], { detached: true, env: { PATH: process.env.PATH, HOME: profile, USERPROFILE: profile, TMPDIR: profile, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", RUNPHANTOM_CLAUDE_CLI_CHAT: "0" }, stdio: "pipe" });
    let stdout = "", stderr = ""; child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; }); child.stdin.on("error", () => {});
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* Already terminal. */ } }, 2500);
    try { child.stdin.end(cursorHook(event, { cwd: workspace, workspace_roots: [workspace] })); const code = await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); }); expect(code).toBe(0); expect(stdout).toBe(""); expect(stderr).toBe(""); }
    finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* Already terminal. */ } await new Promise<void>(resolve => child.once("close", () => resolve())); } }
  }
  const runs = await (await fetch(runPhantom.url + "/api/runs")).json() as { id: string; finished: number }[]; expect(runs).toHaveLength(1); expect(runs[0].finished).toBe(0);
  const detail = await (await fetch(runPhantom.url + "/api/runs/detail/" + runs[0].id)).json() as { run: { name: string }; spans: { provider: string | null; input_tokens: number | null; output_tokens: number | null; end_time_ms: number | null; duration_ms: number | null; normalized: { capture: { contract: string; runtimeVerified: boolean; producerVerified: boolean; coverage: string } } }[] };
  expect(detail.run.name).toBe("Cursor session"); expect(detail.spans).toHaveLength(4);
  for (const span of detail.spans) { expect(span.provider).toBeNull(); expect(span.input_tokens).toBeNull(); expect(span.output_tokens).toBeNull(); expect(span.end_time_ms).toBeNull(); expect(span.duration_ms).toBeNull(); expect(span.normalized.capture).toMatchObject({ contract: "runphantom.cursor-hook.observation/v1", coverage: "partial", runtimeVerified: false, producerVerified: false }); }
  await page.goto(runPhantom.url.replace("localhost", "127.0.0.1") + "/runs/" + runs[0].id);
  await expect(page.getByText("Explain the synthetic result", { exact: true })).toBeVisible();
  await expect(page.getByText("Captured synthetic Cursor answer", { exact: true })).toBeVisible();
  await expect(page.getByText(/producer.reported.*partial/i).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit message and replay run" })).toHaveCount(0);
  await page.getByRole("button", { name: "Expand tool call Shell", exact: true }).click();
  await expect(page.locator("[data-tool-span-id]").locator("pre").first()).toContainText("synthetic command");
  await expect(page.locator("[data-tool-span-id]").locator("pre").nth(1)).toContainText("synthetic result");
  for (const width of [320, 1440]) { await page.setViewportSize({ width, height: 1000 }); await page.evaluate(() => document.fonts.ready); await expect(page.getByText("Captured synthetic Cursor answer", { exact: true })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: testInfo.outputPath(`cursor-synthetic-capture-${width}.png`), fullPage: true }); }
});
