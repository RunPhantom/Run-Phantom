import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureTrace, captureOutput, filterSecret } from "../../tests/fixtures/capture-visibility";

const executable = process.env.F16_ARTIFACT_EXECUTABLE;
test.skip(!executable, "Requires the actual copied native Run Phantom executable");
const source = captureTrace(1699);
let directory: string, base: string, daemon: ChildProcess;
const owned: ChildProcess[] = [], reaped = new Map<ChildProcess, Promise<unknown>>(), logs: string[] = [];
async function boot() {
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RUNPHANTOM_") && !["OPENAI_API_KEY", "ANTHROPIC_API_KEY"].includes(key)));
  daemon = spawn(executable!, ["serve"], { cwd: path.dirname(executable!), env: { ...inherited,
    HOME: directory, USERPROFILE: directory, RUNPHANTOM_DB_PATH: path.join(directory, "capture.db"), RUNPHANTOM_SECRET_STORE_PATH: path.join(directory, "secrets.json"),
    RUNPHANTOM_PORT: String(port), RUNPHANTOM_BIND_HOST: "127.0.0.1", RUNPHANTOM_CLAUDE_CLI_CHAT: "0", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"] });
  daemon.stdout?.on("data", data => logs.push(String(data))); daemon.stderr?.on("data", data => logs.push(String(data)));
  owned.push(daemon); reaped.set(daemon, once(daemon, "close")); base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error("Copied native process exited before health");
    try { const response = await fetch(base + "/health"); if (response.ok && (await response.json()).pid === daemon.pid) return; } catch { /* Await owned listener. */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Copied native process did not become healthy");
}
async function stop(process: ChildProcess) {
  if (process.exitCode === null && process.signalCode === null) process.kill("SIGTERM");
  const force = setTimeout(() => process.kill("SIGKILL"), 2500);
  try { await reaped.get(process); } finally { clearTimeout(force); }
}
test.beforeAll(async () => { directory = mkdtempSync(path.join(realpathSync(tmpdir()), "rp-native-capture-ui-")); await boot(); });
test.afterAll(async () => { await Promise.all(owned.map(stop)); if (directory) rmSync(directory, { recursive: true, force: true }); });
test("actual copied executable preserves capture evidence and UI through separate process boots", async ({ page, request }, info) => {
  const browserErrors: string[] = [], failed: string[] = [];
  page.on("pageerror", error => browserErrors.push(error.message)); page.on("requestfailed", request => failed.push(request.url()));
  await page.route("**/*", route => ["127.0.0.1", "localhost"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  expect((await request.post(base + "/v1/traces", { data: source.body })).status()).toBe(200);
  const first = await (await request.get(`${base}/api/runs/detail/${source.id}`)).json();
  const firstPid = daemon.pid;
  for (const bootNumber of [1, 2]) {
    if (bootNumber === 2) { await page.goto("about:blank"); await stop(daemon); await boot(); expect(daemon.pid).not.toBe(firstPid); }
    await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(`${base}/runs/${source.id}`);
    await expect(page.getByText(captureOutput, { exact: true })).toHaveCount(1);
    const retrieval = page.getByRole("region", { name: "Retrieval evidence", exact: true }); await retrieval.locator("summary").first().click();
    await expect(retrieval.locator("dd").nth(2)).toHaveText("0"); await expect(retrieval).toContainText("[REDACTED]");
    const stream = page.locator(`[data-capture-span="${source.llm.spanId}"]`); await stream.locator("summary").first().click();
    await expect(stream).toContainText("Complete stream capture"); await expect(stream).toContainText("0 ms");
    expect(await page.locator("body").textContent()).not.toContain(filterSecret);
    const current = await (await request.get(`${base}/api/runs/detail/${source.id}`)).json(); expect(current.spans).toEqual(first.spans);
    const sql = await request.post(base + "/api/traces/query", { data: { sql: `SELECT id,span_type FROM spans WHERE run_id='${source.id}'` } }); expect(sql.status()).toBe(200); expect((await sql.json()).rows).toHaveLength(4);
    await page.screenshot({ path: info.outputPath(`native-capture-boot-${bootNumber}.png`), fullPage: true });
  }
  expect(browserErrors).toEqual([]); expect(failed).toEqual([]); expect(logs.join("")).not.toContain(filterSecret);
  await info.attach("actual-native-two-boot-ui.json", { body: JSON.stringify({ executable, firstPid, secondPid: daemon.pid, host: { platform: process.platform, arch: process.arch, node: process.versions.node }, equalPersistedSpans: true, browserErrors, failed, artifactLogsContainSecret: false }, null, 2), contentType: "application/json" });
});
