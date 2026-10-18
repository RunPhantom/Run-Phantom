import { test, expect } from "./fixtures";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { codexHook, codexJsonl, codexRecords } from "../../tests/fixtures/coding-hooks-codex";

test("installed Codex callback observations appear in Runs without completion or replay authority", async ({ page, runPhantom }, testInfo) => {
  test.skip(process.platform === "win32", "Private POSIX source acquisition is explicitly unavailable on Windows");
  const home = path.dirname(runPhantom.dbPath), workspace = path.join(home, "codex workspace"), codexHome = path.join(home, ".codex"), sessions = path.join(codexHome, "sessions");
  mkdirSync(workspace, { mode: 0o700 }); mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const source = path.join(sessions, "synthetic-rollout.jsonl"); writeFileSync(source, codexJsonl(codexRecords(workspace)), { mode: 0o600 });
  const entry = path.resolve(import.meta.dirname, "../../src/index.ts");
  const bun = execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
  const installed = execFileSync(bun, ["--no-env-file", entry, "hooks", "install", "codex", "--local", "--cwd", workspace, "--full", "--consent-full", "--port", String(runPhantom.port)], { cwd: workspace, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, timeout: 5000, encoding: "utf8" });
  expect(JSON.parse(installed)).toMatchObject({ configuration: "installed", captureVerified: false });
  const config = JSON.parse(readFileSync(path.join(workspace, ".codex/hooks.json"), "utf8")) as { hooks: { Stop: { hooks: { command: string }[] }[] } };
  const child = spawn("/bin/sh", ["-c", "exec " + config.hooks.Stop[0].hooks[0].command], { cwd: workspace, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdio: "pipe" });
  let stdout = "", stderr = ""; child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b); child.stdin.on("error", () => {});
  const ended = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 2500); child.stdin.end(codexHook(workspace, source));
  try { expect(await ended).toBe(0); } finally { clearTimeout(timer); }
  expect(stdout).toBe(""); expect(stderr).toBe("");
  const runs = await (await fetch(runPhantom.url + "/api/runs")).json() as { id: string; name: string }[];
  expect(runs).toHaveLength(1); expect(runs[0].name).toBe("Codex session");
  const detail = await (await fetch(runPhantom.url + "/api/runs/detail/" + runs[0].id)).json() as { spans: { status: string; end_time_ms: number; normalized: { capture?: { contract: string } } }[] };
  expect(detail.spans).toHaveLength(4); expect(detail.spans.every(s => s.status === "UNSET" && s.end_time_ms === 0 && s.normalized.capture?.contract === "runphantom.codex-hook.observation/v1")).toBe(true);
  await page.goto(runPhantom.url + "/runs/" + runs[0].id, { waitUntil: "networkidle" });
  await expect(page.getByText("Find the café result", { exact: true })).toBeVisible();
  await expect(page.getByText("Found the café result", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /producer.reported.*partial.*runtime unverified/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit message and replay run" })).toHaveCount(0);
  await page.getByRole("button", { name: "Expand tool call lookup" }).click();
  await expect(page.locator("[data-tool-span-id]")).toContainText("safe synthetic business result");
  await page.screenshot({ path: testInfo.outputPath("codex-synthetic-capture.png"), fullPage: false });
});
