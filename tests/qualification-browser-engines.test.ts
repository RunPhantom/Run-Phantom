import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { VERIFICATION_LIMITS } from "../src/verification/protocol";
import { fileURLToPath } from "node:url";
import { accepted, ENGINES, matrix, reportOutcome, summarize, privateEnvironment, runEngineSeries, type EngineIdentity } from "../scripts/qualification/browser-engines";
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

test("a terminal failed engine child fences the next admission without fabricated results", () => {
  for (const failedEngine of ["chromium", "firefox"]) {
    const admitted: string[] = [], reaped: number[] = [];
    const outcomes = runEngineSeries(identities, identity => {
      admitted.push(identity.engine);
      const failed = identity.engine === failedEngine;
      const report = { specs: Array.from({ length: 5 }, (_unused, index) => ({ tests: [{ expectedStatus: "passed", results: [{ status: failed && index === 4 ? "failed" : "passed", retry: 0 }] }] })) };
      const child = spawnSync(process.execPath, ["--no-env-file", "-e", `process.stdout.write(${JSON.stringify(JSON.stringify(report))});process.exit(${failed ? 1 : 0});`], { encoding: "utf8", timeout: 2000 });
      expect(child.signal).toBeNull(); expect(() => process.kill(child.pid, 0)).toThrow(); reaped.push(child.pid);
      return reportOutcome(JSON.parse(child.stdout) as Parameters<typeof reportOutcome>[0], child.status);
    }, 5);
    expect(admitted).toEqual(failedEngine === "chromium" ? ["chromium"] : ["chromium", "firefox"]); expect(reaped).toHaveLength(admitted.length);
    expect(outcomes[failedEngine as "chromium" | "firefox"]).toMatchObject({ collected: 5, passed: 4, failed: 1, skipped: 0, retries: 0, exitCode: 1 });
    expect(outcomes.webkit).toBeUndefined();
    const pending = matrix("darwin-arm64", identities, outcomes, 5).filter(cell => cell.platform === "darwin-arm64" && cell.engine === "webkit");
    expect(pending.every(cell => cell.status === "BLOCKED")).toBe(true); expect(summarize(matrix("darwin-arm64", identities, outcomes, 5)).exitCode).toBe(1);
  }
});

function syntheticMarkerObservation(zero: number[], one: number[]): import("../src/verification/browser-types").BrowserObservation {
  return { session: { id: "component-session", origin: "http://127.0.0.1:5949", runId: null, ownership: "attached", engine: "chromium", providerVersion: "component", engineVersion: "component", generation: 1, state: "ready", coverage: { network: false, console: true, dom: true, state: false, signal: false, route: true }, history: "from-selection", loss: false, pending: 0, video: "off", networkProfile: "bounded-http-v1", compatibility: { qualification: "initial-only", sameOrigin: "cookie-free", foreign: "unavailable", webSocket: "denied", redirects: "unavailable" } }, events: [...zero.map((count, index) => ({ t: index * VERIFICATION_LIMITS.POLL_MS, type: "dom", data: { selector: "#physical0", count } })), ...one.map((count, index) => ({ t: index * VERIFICATION_LIMITS.POLL_MS, type: "dom", data: { selector: "#physical1", count } }))].sort((a, b) => a.t - b.t), cursor: zero.length + one.length, complete: true, dropped: 0 };
}
test("temporal marker sampling accepts every consistent sample within the existing check bound", async () => {
  const { selectedPhysicalIndex, MAX_SELECTED_MARKER_SAMPLES } = await import("../app/tests-e2e/browser-engine-qualification/selected-marker-observation");
  const expected = { id: "component-session", generation: 1, origin: "http://127.0.0.1:5949" };
  for (const count of [1, 3, MAX_SELECTED_MARKER_SAMPLES - 1, MAX_SELECTED_MARKER_SAMPLES]) {
    expect(selectedPhysicalIndex(syntheticMarkerObservation(Array.from({ length: count }, () => 0), Array.from({ length: count }, () => 1)), expected)).toBe(1);
    expect(selectedPhysicalIndex(syntheticMarkerObservation(Array.from({ length: count }, () => 1), Array.from({ length: count }, () => 0)), expected)).toBe(0);
  }
});
test("missing, drifting, unavailable or ambiguous marker observations cannot choose a physical page", async () => {
  const { selectedPhysicalIndex, MAX_SELECTED_MARKER_SAMPLES } = await import("../app/tests-e2e/browser-engine-qualification/selected-marker-observation");
  const expected = { id: "component-session", generation: 1, origin: "http://127.0.0.1:5949" };
  const invalid = [syntheticMarkerObservation([], []), syntheticMarkerObservation([0], []), syntheticMarkerObservation([], [1]), syntheticMarkerObservation([0, 1, 0], [1, 1, 1]), syntheticMarkerObservation([0], [2]), syntheticMarkerObservation([0], [NaN]), syntheticMarkerObservation([0], [0]), syntheticMarkerObservation([1], [1]), syntheticMarkerObservation(Array.from({ length: MAX_SELECTED_MARKER_SAMPLES + 1 }, () => 0), [1])];
  for (const change of ["complete", "dropped", "loss", "dom", "network", "observer.error", "capture.loss", "truncated", "unexpected-selector", "wrong-id", "wrong-generation", "wrong-origin", "wrong-engine", "wrong-ownership", "wrong-history", "wrong-state", "non-numeric", "time-regression"]) {
    const value = syntheticMarkerObservation([0, 0], [1, 1]);
    if (change === "complete") value.complete = false;
    if (change === "dropped") value.dropped = 1;
    if (change === "loss") value.session.loss = true;
    if (change === "dom") value.session.coverage.dom = false;
    if (change === "network") value.session.coverage.network = true;
    if (change === "observer.error" || change === "capture.loss") value.events.push({ t: 2 * VERIFICATION_LIMITS.POLL_MS, type: change, data: { reason: "component-unavailable" } });
    if (change === "truncated") value.events[0].truncated = true;
    if (change === "unexpected-selector") value.events.push({ t: 2 * VERIFICATION_LIMITS.POLL_MS, type: "dom", data: { selector: "#unrequested", count: 1 } });
    if (change === "wrong-id") value.session.id = "other-session";
    if (change === "wrong-generation") value.session.generation++;
    if (change === "wrong-origin") value.session.origin = "http://127.0.0.1:5950";
    if (change === "wrong-engine") value.session.engine = "firefox";
    if (change === "wrong-ownership") value.session.ownership = "owned";
    if (change === "wrong-history") value.session.history = "from-open";
    if (change === "wrong-state") value.session.state = "closed";
    if (change === "non-numeric") value.events[0].data.count = "0";
    if (change === "time-regression") value.events[2].t = -1;
    invalid.push(value);
  }
  for (const value of invalid) expect(() => selectedPhysicalIndex(value, expected)).toThrow();
});
