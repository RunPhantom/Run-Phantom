import { createServer } from "node:http";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { test as base, expect, REPO_ROOT_PATH } from "./fixtures";
import type { PerformanceSnapshot } from "../../src/verification/performance";

const evidence = process.env.RUNPHANTOM_PERFORMANCE_EVIDENCE_DIR;
function record(name: string, value: unknown) { if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(path.join(evidence, name + ".json"), JSON.stringify(value, null, 2) + "\n"); } }
async function stop(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>(resolve => { const timer = setTimeout(() => proc.kill("SIGKILL"), 2500); proc.once("exit", () => { clearTimeout(timer); resolve(); }); proc.kill("SIGTERM"); });
}
interface Daemon { url: string; dbPath: string; restart(): Promise<void>; pids: number[] }
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Native lab fixture</title><style>body{font:18px system-ui;padding:32px}button{padding:12px;margin:8px}#spacer{height:10px}</style><h1>Native lab fixture</h1><button id="slow">Slow interaction</button><button id="healthy">Healthy interaction</button><button id="load">Load resource</button><div id="spacer"></div><p>Stable content</p><output id="status">ready</output><script>
let sequence=0;const busy=ms=>{const start=performance.now();while(performance.now()-start<ms){}};
slow.onclick=()=>{busy(110);requestAnimationFrame(()=>{busy(100);document.querySelector('#status').textContent='slow complete'})};
healthy.onclick=()=>{document.querySelector('#status').textContent='healthy complete'};
load.onclick=async()=>{const response=await fetch('/payload/'+(++sequence)+'?token=synthetic-private');await response.text();document.querySelector('#status').textContent='loaded '+sequence};
window.shift=()=>{spacer.style.height=(spacer.offsetHeight+180)+'px'};
window.nativeOracle=[];for(const type of ['layout-shift','event','long-animation-frame','resource'])if(PerformanceObserver.supportedEntryTypes.includes(type)){new PerformanceObserver(list=>{for(const e of list.getEntries())if(window.nativeOracle.length<100)window.nativeOracle.push({type,start:e.startTime,duration:e.duration,blocking:e.blockingDuration??null,value:e.value??null,recent:e.hadRecentInput??null,interaction:e.interactionId??null,bytes:e.transferSize??null})}).observe({type,buffered:true,...(type==='event'?{durationThreshold:16}:{})})}
</script></html>`;
const test = base.extend<{ lab: string; daemon: Daemon }>({
  lab: async ({}, use) => {
    const server = createServer((req, res) => { if (req.url?.startsWith("/payload/")) { res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }); res.end("local native resource fixture"); } else { res.writeHead(200, { "Content-Type": "text/html" }); res.end(html); } });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try { await use(`http://127.0.0.1:${(server.address() as { port: number }).port}`); }
    finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  },
  daemon: async ({}, use) => {
    const directory = mkdtempSync(path.join(tmpdir(), "rp-performance-source-")); const dbPath = path.join(directory, "evidence.db");
    const reserve = createServer(); await new Promise<void>(resolve => reserve.listen(0, "127.0.0.1", resolve)); const port = (reserve.address() as { port: number }).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RUNPHANTOM_") && !key.includes("API_KEY")));
    const pids: number[] = []; let proc: ChildProcess;
    const url = `http://127.0.0.1:${port}`;
    const start = async () => {
      proc = spawn("bun", ["--no-env-file", "src/index.ts", "serve"], { cwd: REPO_ROOT_PATH, env: { ...env, HOME: directory, USERPROFILE: directory, RUNPHANTOM_DB_PATH: dbPath, RUNPHANTOM_PORT: String(port), RUNPHANTOM_BIND_HOST: "127.0.0.1", RUNPHANTOM_SECRET_STORE_PATH: path.join(directory, "secrets.json"), RUNPHANTOM_CLAUDE_CLI_CHAT: "0", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"] });
      pids.push(proc.pid!); let logs = ""; proc.stdout?.on("data", v => { logs = (logs + String(v)).slice(-4000); }); proc.stderr?.on("data", v => { logs = (logs + String(v)).slice(-4000); });
      for (let i = 0; i < 200; i++) { if (proc.exitCode !== null) throw new Error(`Owned source daemon exited: ${logs}`); try { if ((await fetch(url + "/health")).ok) return; } catch { /* Await owned startup. */ } await new Promise(resolve => setTimeout(resolve, 50)); }
      throw new Error(`Owned source daemon did not start: ${logs}`);
    };
    try { await start(); await use({ url, dbPath, pids, async restart() { await stop(proc); await start(); } }); }
    finally { await stop(proc!); rmSync(directory, { recursive: true, force: true }); record(`process-${pids[0]}`, { pids, directory, directoryAbsent: !existsSync(directory), pidAlive: pids.map(pid => { try { process.kill(pid, 0); return true; } catch { return false; } }) }); }
  },
});
test("actual user opt-in, trusted slow/healthy interactions, numeric identity, six widths and restart", async ({ page, context, request, lab, daemon }) => {
  await page.goto(daemon.url + "/verification"); await page.getByLabel(/^App origin/).fill(lab);
  await page.getByLabel("Include native performance capture in setup (no location metadata)").check(); await page.getByRole("button", { name: "Pair app", exact: true }).click();
  const snippet = await page.getByLabel("Application connection snippet", { exact: true }).innerText(); expect(snippet).toContain('performanceEvidence: { enabled: true, metadata: "none" }');
  const sessionId = /sessionId:\s*"([^"]+)"/.exec(snippet)![1]!, token = /token:\s*"([^"]+)"/.exec(snippet)![1]!;
  const app = await context.newPage();
  try {
    await app.goto(lab); await app.evaluate(async ({ url, sessionId, token }) => { const sdk = await import(url + "/verification/sdk.js"); window.runtime = sdk.connect({ url, sessionId, token, performanceEvidence: { enabled: true, metadata: "none" } }); }, { url: daemon.url, sessionId, token });
    await expect(page.getByRole("button", { name: "Begin lab window", exact: true })).toBeEnabled(); await page.getByRole("button", { name: "Dismiss setup", exact: true }).click();
    const panel = page.getByRole("region", { name: "Native performance lab", exact: true });
    await panel.getByRole("button", { name: "Begin lab window", exact: true }).focus(); await page.keyboard.press("Enter"); await expect(panel.getByText(/^Lab window opened/)).toBeVisible();
    await app.locator("#slow").click(); await expect(app.locator("#status")).toHaveText("slow complete");
    await app.locator("#load").click(); await expect(app.locator("#status")).toHaveText("loaded 1");
    // Wait beyond recent-input exclusion before causing a real observed native layout shift.
    await expect.poll(() => app.evaluate(() => performance.now())).toBeGreaterThan(1000); await app.waitForTimeout(550); await app.evaluate(() => (window as unknown as { shift(): void }).shift());
    await expect.poll(() => app.evaluate(() => (window as unknown as { nativeOracle: { type: string }[] }).nativeOracle.filter(e => e.type === "layout-shift").length)).toBeGreaterThan(0);
    const captureResponse = page.waitForResponse(r => r.url().endsWith(`/sessions/${sessionId}/command`) && r.request().postDataJSON()?.phase === "capture");
    await panel.getByRole("button", { name: "Capture readings", exact: true }).click(); const first = (await (await captureResponse).json()).result as PerformanceSnapshot; record("first-capture-diagnostic", {first,oracle:await app.evaluate(()=>(window as unknown as {nativeOracle:unknown[]}).nativeOracle)}); if(evidence){await panel.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,"first-panel-actual.png")});}
    await expect(panel.getByText(/^Lab window captured/)).toBeVisible(); expect(first.metrics.resourceCount).toBeGreaterThanOrEqual(1); expect(first.metrics.qualifyingInteractionMaxMs).toBeGreaterThanOrEqual(104); expect(first.metrics.longFrameBlockingMaxMs).toBeGreaterThan(0); expect(first.metrics.clsMaxSessionScore).toBeGreaterThan(0);
    const oracle = await app.evaluate(() => (window as unknown as { nativeOracle: unknown[] }).nativeOracle);
    const resources = (oracle as Array<{ type: string; start: number; bytes: number }>).filter(e => e.type === "resource" && e.start >= first.clock.sinceMs! && e.start <= first.clock.capturedAtMs!);
    expect(first.metrics.resourceCount).toBe(resources.length); expect(first.metrics.resourceTransferBytes).toBe(resources.reduce((sum, e) => sum + e.bytes, 0));
    const native = oracle as Array<{ type: string; start: number; duration: number; blocking: number; interaction: number; recent: boolean; value: number }>;
    const inWindow = native.filter(e => e.start >= first.clock.sinceMs! && e.start <= first.clock.capturedAtMs!);
    expect(first.metrics.qualifyingInteractionMaxMs).toBe(Math.max(...inWindow.filter(e => e.type === "event" && e.interaction > 0).map(e => e.duration)));
    expect(first.metrics.longFrameBlockingMaxMs).toBe(Math.max(...inWindow.filter(e => e.type === "long-animation-frame").map(e => e.blocking)));
    expect(first.metrics.clsMaxSessionScore).toBe(inWindow.filter(e => e.type === "layout-shift" && !e.recent).reduce((sum, e) => sum + e.value, 0));
    expect(JSON.stringify(first)).not.toContain("synthetic-private"); expect(first.metadata).toBe("none");
    await panel.getByRole("button", { name: "Use capture as before", exact: true }).click(); await panel.getByRole("button", { name: "Begin lab window", exact: true }).click(); await expect(panel.getByText(/^Lab window opened/)).toBeVisible();
    await app.locator("#healthy").click(); await expect(app.locator("#status")).toHaveText("healthy complete"); await app.locator("#load").click(); await expect(app.locator("#status")).toHaveText("loaded 2");
    await panel.getByRole("button", { name: "Capture readings", exact: true }).click(); await expect(panel.getByLabel("Selected before and after readings")).toBeVisible();
    // Optional check is about the admitted population; unknown native drop information may make it inconclusive.
    await panel.getByRole("combobox", { name: "Native lab metric", exact: true }).selectOption("resourceCount"); await panel.getByLabel("Limit (count)", { exact: true }).fill("100");
    const reportResponse = page.waitForResponse(r => r.url().endsWith(`/sessions/${sessionId}/assert`)); await panel.getByRole("button", { name: "Check lab metric", exact: true }).click(); const report = await (await reportResponse).json();
    expect(["pass", "inconclusive"]).toContain(report.status); expect(report.context.checks[0].performance.snapshot.metrics.resourceCount).toBe(1);
    await expect(page.getByRole("article", { name: `Native lab: Completed resources: ${report.status}`, exact: true })).toBeVisible();
    for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [768, 1024], [390, 844], [320, 740]]) {
      await page.setViewportSize({ width: width!, height: height! }); await panel.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (evidence) await page.screenshot({ path: path.join(evidence, `native-panel-${width}.png`) });
    }
    const sql = spawnSync("bun", ["--no-env-file", "-e", 'import {Database} from "bun:sqlite";const db=new Database(process.argv[1],{readonly:true});console.log(JSON.stringify(db.query("SELECT context FROM verification_reports WHERE id=?").get(process.argv[2])));db.close()', daemon.dbPath, report.id], { cwd: REPO_ROOT_PATH, env: { ...process.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" }, encoding: "utf8" }); expect(sql.status).toBe(0); expect(JSON.parse(JSON.parse(sql.stdout).context)).toEqual(report.context);
    await daemon.restart(); await page.reload(); const reopened = await (await request.get(daemon.url + "/api/verification/reports")).json(); expect(reopened.find((item: { id: string }) => item.id === report.id)).toEqual(report);
    await expect(page.getByRole("article", { name: `Native lab: Completed resources: ${report.status}`, exact: true })).toBeVisible();
    expect((await (await request.post(`${daemon.url}/api/verification/sessions/${sessionId}/assert`, { data: { predicate: { kind: "performance", metric: "resourceCount", op: "lte", value: 100 } } })).json()).error).toBeDefined();
    record("native-output-proof", { first, oracle, report, independentSqlContextSha256: createHash("sha256").update(JSON.parse(sql.stdout).context).digest("hex"), restartedPids: daemon.pids, sixWidths: true, trustedInput: "Playwright mouse click; native Event Timing entries", syntheticActionsClaimedTrusted: false });
  } finally { await app.close(); }
});

test("default opt-out has no native API acquisition and unsupported injected observer stays inconclusive", async ({ page, request, lab, daemon }) => {
  for (const enabled of [false, true]) {
    const created = await (await request.post(daemon.url + "/api/verification/sessions", { data: { origin: lab } })).json(); await page.goto(lab);
    await page.evaluate(async ({ url, sessionId, token, enabled }) => {
      const sdk = await import(url + "/verification/sdk.js");
      if (enabled) Object.defineProperty(window, "PerformanceObserver", { configurable: true, value: class { static supportedEntryTypes = []; } });
      else Object.defineProperty(window, "PerformanceObserver", { configurable: true, get() { throw new Error("Default mode must not read native observer API"); } });
      window.runtime = sdk.connect({ url, sessionId, token, ...(enabled ? { performanceEvidence: { enabled: true } } : {}) });
    }, { url: daemon.url, sessionId: created.id, token: created.token, enabled });
    await expect.poll(async () => (await (await request.get(`${daemon.url}/api/verification/sessions`)).json()).find((item: { id: string }) => item.id === created.id)?.connected).toBe(true);
    const begin = await (await request.post(`${daemon.url}/api/verification/sessions/${created.id}/command`, { data: { type: "performance", phase: "begin" } })).json(); expect(begin.ok).toBe(enabled);
    const report = await (await request.post(`${daemon.url}/api/verification/sessions/${created.id}/assert`, { data: { predicate: { kind: "performance", metric: "resourceCount", op: "lte", value: 0 } } })).json(); expect(report.status).toBe("inconclusive");
    if (enabled) expect(report.context.checks[0].performance.snapshot.coverage.resource.state).toBe("unsupported");
    await page.evaluate(() => window.runtime.disconnect());
    record(`fault-${enabled ? "unsupported" : "opt-out"}`, { injected: true, begin, report });
  }
});

test("actual source transport refuses injected loss/overflow/invalid populations and full navigation clears live authority", async ({ page, request, lab, daemon }) => {
  const created = await (await request.post(daemon.url + "/api/verification/sessions", { data: { origin: lab } })).json(); await page.goto(lab);
  await page.evaluate(async ({ url, sessionId, token }) => {
    type Fault = { callback: (list: unknown, self: unknown, options: unknown) => void; records: unknown[]; ended: boolean };
    const observers = new Map<string, Fault>();
    class Observer {
      static supportedEntryTypes = ["resource"];
      records: unknown[] = []; ended = false;
      constructor(public callback: (list: unknown, self: unknown, options: unknown) => void) {}
      observe(options: { type: string }) { observers.set(options.type, this); }
      takeRecords() { const records = this.records; this.records = []; return records; }
      disconnect() { this.ended = true; }
    }
    Object.defineProperty(window, "PerformanceObserver", { configurable: true, value: Observer });
    (window as unknown as { injectFault(mode: string): void }).injectFault = mode => {
      const observer = observers.get("resource")!, startTime = performance.now();
      const entry = (transferSize = 0, duration = 1) => ({ startTime, duration, transferSize });
      const deliver = (entries: unknown[], count?: number) => observer.callback({ getEntries: () => entries }, observer, count === undefined ? {} : { droppedEntriesCount: count });
      if (mode === "overflow") deliver([entry(Number.MAX_SAFE_INTEGER), entry(1)], 0);
      if (mode === "invalid") deliver([entry(0, NaN)], 0);
      if (mode === "positive-loss") { deliver([entry()], 3); deliver([entry()], undefined); deliver([entry()], 0); }
      if (mode === "drain") { deliver([entry()], 0); observer.records = [entry()]; }
      if (mode === "buffer-full") performance.dispatchEvent(new Event("resourcetimingbufferfull"));
      if (mode === "callback-limit") deliver(Array.from({ length: 1001 }, () => entry()), 0);
    };
    const sdk = await import(url + "/verification/sdk.js"); window.runtime = sdk.connect({ url, sessionId, token, performanceEvidence: { enabled: true, metadata: "none" } });
  }, { url: daemon.url, sessionId: created.id, token: created.token });
  await expect.poll(async () => (await (await request.get(daemon.url + "/api/verification/sessions")).json()).find((item: { id: string }) => item.id === created.id)?.connected).toBe(true);
  const observations: unknown[] = [];
  for (const mode of ["overflow", "invalid", "drain", "buffer-full", "callback-limit", "positive-loss"]) {
    const begin = await (await request.post(`${daemon.url}/api/verification/sessions/${created.id}/command`, { data: { type: "performance", phase: "begin" } })).json(); expect(begin.ok).toBe(true);
    await page.evaluate(mode => (window as unknown as { injectFault(mode: string): void }).injectFault(mode), mode);
    const report = await (await request.post(`${daemon.url}/api/verification/sessions/${created.id}/assert`, { data: { predicate: { kind: "performance", metric: "resourceCount", op: "lte", value: Number.MAX_SAFE_INTEGER } } })).json(); expect(report.status).toBe("inconclusive");
    const snapshot = report.context.checks[0].performance.snapshot as PerformanceSnapshot;
    if (mode === "overflow") expect(snapshot.coverage.resource.overflow).toBe(true);
    if (mode === "invalid") expect(snapshot.coverage.resource.invalid).toBe(1);
    if (mode === "positive-loss") expect(snapshot.coverage.resource.nativeDropped).toBe(3);
    if (mode === "drain") expect(snapshot.coverage.resource.nativeDropped).toBeNull();
    if (mode === "buffer-full") expect(snapshot.coverage.resource.omitted).toBe(1);
    if (mode === "callback-limit") { expect(snapshot.coverage.resource.omitted).toBe(1); expect(snapshot.metrics.resourceCount).toBe(1000); }
    observations.push({ mode, snapshot, reportId: report.id, status: report.status });
  }
  await page.goto(lab + "?new-document"); await expect.poll(async () => (await (await request.get(daemon.url + "/api/verification/sessions")).json()).find((item: { id: string }) => item.id === created.id)?.connected).toBe(false);
  const after = await (await request.post(`${daemon.url}/api/verification/sessions/${created.id}/command`, { data: { type: "performance", phase: "capture" } })).json(); expect(after.ok).toBe(false);
  record("injected-source-faults", { injected: true, nativeMeasurementClaimed: false, observations, navigationDisconnected: true, after });
});
