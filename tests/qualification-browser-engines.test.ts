import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { accepted, ENGINES, matrix, reportOutcome, summarize, privateEnvironment, type EngineIdentity } from "../scripts/qualification/browser-engines";
const identities: EngineIdentity[] = ENGINES.map(engine => ({ engine, executable: `/installed/${engine}`, executableSha256: "a".repeat(64), nativeBinary: `/installed/${engine}`, nativeSha256: "a".repeat(64), available: true, reason: null }));
const passed = { collected: 5, passed: 5, failed: 0, skipped: 0, retries: 0, exitCode: 0 };
test("an absent engine cannot qualify even with copied green test counts", () => {
  const cells = matrix("darwin-arm64", identities.map(item => item.engine === "firefox" ? { ...item, available: false, reason: "installed-engine-missing" } : item), { firefox: passed }, 5);
  expect(cells.filter(cell => cell.platform === "darwin-arm64" && cell.engine === "firefox").every(cell => cell.status === "BLOCKED")).toBe(true);
  expect(summarize(cells)).toMatchObject({ accepted: false, exitCode: 2 });
});
test("zero collection, skips, retries, expected failures and nonzero process exit fail exact execution", () => {
  expect(accepted(passed, 5)).toBe(true);
  for (const altered of [{ ...passed, collected: 0 }, { ...passed, skipped: 1 }, { ...passed, retries: 1 }, { ...passed, failed: 1 }, { ...passed, exitCode: 2 }, { ...passed, passed: 3 }]) expect(accepted(altered, 5)).toBe(false);
  const result = reportOutcome({ suites: [{ specs: [{ tests: [{ expectedStatus: "failed", results: [{ status: "passed" }] }, { results: [{ status: "failed" }, { status: "passed", retry: 1 }] }, { results: [{ status: "skipped" }] }] }] }] }, 0);
  expect(result).toEqual({ collected: 3, passed: 1, failed: 1, skipped: 1, retries: 1, exitCode: 0 });
});
test("available base success does not fill other native hosts or integrated recordings and new UI cells", () => {
  const cells = matrix("darwin-arm64", identities, { chromium: { ...passed, nativeAudit: true }, firefox: passed, webkit: passed }, 5);
  expect(cells.filter(cell => cell.platform === "darwin-arm64" && cell.capability === "trusted-outcome").map(cell => cell.status)).toEqual(["PASSED", "PASSED", "PASSED"]);
  expect(cells.find(cell => cell.platform === "darwin-arm64" && cell.engine === "chromium" && cell.capability === "native-accessibility")?.status).toBe("PASSED");
  expect(cells.filter(cell => cell.capability === "F37-recordings").every(cell => cell.status === "BLOCKED")).toBe(true);
  expect(cells.filter(cell => cell.platform === "win32-x64").every(cell => cell.status === "BLOCKED")).toBe(true);
  expect(cells.find(cell => cell.platform === "darwin-arm64" && cell.engine === "firefox" && cell.capability === "native-accessibility")?.reason).toBe("product-audit-engine-unsupported");
  expect(summarize(cells).accepted).toBe(false);
});
test("private child environment does not inherit credentials or arbitrary host settings", () => {
  const before = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = "/private/fixture";
  try { const env = privateEnvironment("/owned/profile"); expect(env.HOME).toBe("/owned/profile"); expect(env.USERPROFILE).toBe("/owned/profile"); expect(env.CLAUDE_CONFIG_DIR).toBeUndefined(); expect(Object.keys(env).some(key => key.includes("API_KEY") || key.includes("TOKEN"))).toBe(false); }
  finally { if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before; }
});
test("dedicated journey filenames and config cannot join the original default spec roster", () => {
  const config = readFileSync(new URL("../app/playwright.engines.config.ts", import.meta.url), "utf8");
  expect(config).toContain('testMatch: "**/*.journey.ts"'); expect(config).toContain('testDir: "./tests-e2e/browser-engine-qualification"');
  expect(config).toContain("retries: 0"); expect(config).toContain("workers: 1"); expect(config).toContain("forbidOnly: true");
});

test("direct config invocation refuses missing runtime before any browser journey can start", () => {
  const config = fileURLToPath(new URL("../app/playwright.engines.config.ts", import.meta.url));
  const child = spawnSync(process.execPath, ["--no-env-file", "-e", `await import(${JSON.stringify(config)})`], { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, TMPDIR: process.env.TMPDIR! }, encoding: "utf8", timeout: 10_000 });
  expect(child.status).not.toBe(0); expect(child.stderr).toContain("BLOCKED: dedicated owned browser runner");
});

test("partial acquisition cleanup attempts a registered resource after connection failure and rejected close", async () => {
  const { createServer } = await import("node:net");
  const { cleanupStages, preserveFixtureFailure } = await import("../app/tests-e2e/browser-engine-qualification/lifecycle");
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const primary = new Error("failed after server acquisition before connection registration");
  const secondary = new Error("connection close rejected");
  const stages = await cleanupStages([
    { stage: "connection-close", close: () => Promise.reject(secondary) },
    { stage: "registered-server-close", close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) },
  ], 1000);
  expect(stages.map(item => item.completed)).toEqual([false, true]); expect(server.listening).toBe(false);
  let failure: unknown; try { preserveFixtureFailure(primary, stages); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError); expect((failure as AggregateError).errors[0]).toBe(primary);
  expect((failure as AggregateError).errors[1].message).toContain("connection close rejected");
});
test("primary body failure is preserved after successful independently bounded cleanup", async () => {
  const { cleanupStages, preserveFixtureFailure } = await import("../app/tests-e2e/browser-engine-qualification/lifecycle");
  const primary = new Error("body failed"); const visited: number[] = [];
  const stages = await cleanupStages([{ stage: "hung-close", close: () => new Promise(() => {}) }, { stage: "later-close", close: () => { visited.push(2); } }], 25);
  expect(stages.map(item => item.completed)).toEqual([false, true]); expect(visited).toEqual([2]);
  let failure: unknown; try { preserveFixtureFailure(primary, [{ stage: "successful-close", completed: true }]); } catch (error) { failure = error; }
  expect(failure).toBe(primary);
});
test("TERM-resistant daemon and inherited-pipe descendant are escalated and close is boundedly observed", async () => {
  const { spawn } = await import("node:child_process");
  const { reapOwnedProcess, processGone, waitForOwned, cleanupStages, preserveFixtureFailure } = await import("../app/tests-e2e/browser-engine-qualification/lifecycle");
  const script = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});const child=spawn(process.execPath,['--no-env-file','-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit']});console.log(child.pid);setInterval(()=>{},1000);`;
  const daemon = spawn(process.execPath, ["--no-env-file", "-e", script], { stdio: ["ignore", "pipe", "pipe"], detached: true }); let closed = false; daemon.once("close", () => { closed = true; });
  let descendant = 0, primary: Error | undefined;
  try {
    descendant = await new Promise<number>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("control child did not identify descendant")), 2000); daemon.stdout!.once("data", bytes => { clearTimeout(timer); resolve(Number(String(bytes).trim())); }); });
    expect(descendant).toBeGreaterThan(0);
    const result = await reapOwnedProcess(daemon, [descendant], () => closed, 500);
    expect(result).toEqual({ forced: true, closeObserved: true }); expect(processGone(daemon.pid!)).toBe(true); expect(processGone(descendant)).toBe(true);
  } catch (error) { primary = error instanceof Error ? error : new AggregateError([error], "Control primary failure"); }
  const cleanup = await cleanupStages([
    { stage: "control-group-kill", close: () => { if (daemon.pid) { try { process.kill(-daemon.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } } } },
    { stage: "control-reap", close: () => waitForOwned(() => closed && (!daemon.pid || processGone(daemon.pid)) && (!descendant || processGone(descendant)), 1000) },
  ], 1500);
  preserveFixtureFailure(primary, cleanup);
}, 5000);

test("actual Bun HTTP graceful close observes callback, close event and zero sockets without double close", async () => {
  const { createServer } = await import("node:http");
  const { observeOwnedHttpServer, closeOwnedHttpServer, httpServerProof } = await import("../app/tests-e2e/browser-engine-qualification/lifecycle");
  const owned = observeOwnedHttpServer(createServer((_request, response) => response.end("actual owned HTTP response")));
  owned.server.listen(0, "127.0.0.1"); await once(owned.server, "listening");
  try {
    const address = owned.server.address() as { port: number }; const response = await fetch(`http://127.0.0.1:${address.port}`);
    expect(response.status).toBe(200); expect(await response.text()).toBe("actual owned HTTP response"); expect(httpServerProof(owned).listeningObserved).toBe(true);
    expect(await closeOwnedHttpServer(owned)).toEqual({ listeningObserved: true, connectionsObserved: 1, listening: false, closeObserved: true, closeCallbackObserved: true, fallbackUsed: false, liveSockets: 0 });
  } finally { if (owned.server.listening) await closeOwnedHttpServer(owned); }
});
test("unobserved HTTP acquisition cannot manufacture a successful close receipt", async () => {
  const { createServer } = await import("node:http");
  const { observeOwnedHttpServer, closeOwnedHttpServer, httpServerProof } = await import("../app/tests-e2e/browser-engine-qualification/lifecycle");
  const owned = observeOwnedHttpServer(createServer());
  let failure: unknown; try { await closeOwnedHttpServer(owned); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).toContain("HTTP listener acquisition was not observed");
  expect(httpServerProof(owned)).toMatchObject({ listeningObserved: false, closeObserved: false, closeCallbackObserved: false, liveSockets: 0 });
});
