import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { test as base, expect, REPO_ROOT_PATH, type RunPhantomHandle } from "./fixtures";
import { observe, assertRuntime } from "./verification-fixture";
import { VERIFICATION_LIMITS as L, type AppCommand, type RetainedControlSource, type SemanticResult, type SessionSummary, type VerificationReport } from "../../src/verification/protocol";

const appRequire = createRequire(path.join(REPO_ROOT_PATH, "app/package.json"));
const vite = path.join(path.dirname(appRequire.resolve("vite/package.json")), "dist/node/index.js");
const reactPlugin = path.join(path.dirname(appRequire.resolve("@vitejs/plugin-react-swc")), "index.js");
const fixtureToken = "F20_DEV_GATED_PAIR_TOKEN_FIXTURE_ONLY";
const fixtureRuntime = "F20_DEV_GATED_RUNTIME_FIXTURE_ONLY";
const source = `import React, { useState } from "react";
import { createRoot } from "react-dom/client";
function Checkout() {
  const [count, setCount] = useState(0); const [removed, setRemoved] = useState(false);
  return <main><h1>React {React.version} checkout</h1>
    <button id="pay" onClick={() => setCount(count + 1)}>Pay {count}</button>
    <label>Note<input id="note" /></label>
    {!removed && <button id="remove" onClick={() => setRemoved(true)}>Remove control</button>}
    {removed && <p id="removed">Control removed</p>}
    <button id="route" onClick={() => history.pushState({}, "", "/confirmed")}>Open confirmation</button>
    <button id="navigate" onClick={() => location.assign("/landing")}>Navigate document</button>
    <button id="error" onClick={() => console.error("Observed checkout error")}>Observe error</button>
    <output id="output">{count}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Checkout/>);
if (import.meta.env.DEV) { window.fixtureToken = "${fixtureToken}"; window.fixtureRuntime = "${fixtureRuntime}"; }
`;
const q = (value: string) => JSON.stringify(value);
interface ReactApp { origin: string; root: string; legacy18: boolean; production: boolean }
async function stop(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => proc.kill("SIGKILL"), 2500);
    proc.once("exit", () => { clearTimeout(timer); resolve(); }); proc.kill("SIGTERM");
  });
}
const test = base.extend<{ reactApp: ReactApp; production: boolean }>({
  production: [false, { option: true }],
  reactApp: async ({ production }, use) => {
    const root = mkdtempSync(path.join(realpathSync(tmpdir()), "rp-react-source-"));
    const helper = mkdtempSync(path.join(REPO_ROOT_PATH, ".omx/react-source-"));
    mkdirSync(path.join(root, "src")); mkdirSync(path.join(root, "public"));
    writeFileSync(path.join(root, "src/Checkout.tsx"), source);
    writeFileSync(path.join(root, "index.html"), '<!doctype html><html lang="en"><meta charset="utf-8"><title>React source fixture</title><style>body{font:18px system-ui;padding:32px}button,input{margin:8px;padding:12px}output{display:block}</style><div id="root"></div><script type="module" src="/src/Checkout.tsx"></script></html>');
    const compile = (entry: string, target: "node" | "browser", output: string) => {
      const result = spawnSync("bun", ["build", entry, `--target=${target}`, "--format=esm", "--external=typescript", "--define=process.env.NODE_ENV=\"development\"", `--outfile=${output}`], { cwd: REPO_ROOT_PATH, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`Fixture compilation refused: ${result.stderr}`);
    };
    const adapter = path.join(helper, "adapter.mjs"); compile(path.join(REPO_ROOT_PATH, "src/verification/build/vite.ts"), "node", adapter);
    const probe = path.join(helper, "probe.ts");
    writeFileSync(probe, `export { identifyReactControl } from ${q(path.join(REPO_ROOT_PATH, "src/verification/browser/framework/react.ts"))};`);
    compile(probe, "browser", path.join(root, "public/probe.js"));
    const store = path.join(realpathSync(path.join(REPO_ROOT_PATH, "node_modules")), ".bun");
    const legacy = readdirSync(store).find(name => name.startsWith("react-dom@18.3.1+"));
    if (legacy) {
      const dom = path.join(store, legacy, "node_modules/react-dom"); const require18 = createRequire(path.join(dom, "package.json"));
      const entry = path.join(root, "src/Legacy.tsx");
      writeFileSync(entry, `import React from ${q(require18.resolve("react"))};\nimport { createRoot } from ${q(path.join(dom, "client.js"))};\nimport { jsxDEV } from ${q(require18.resolve("react/jsx-dev-runtime"))};\nfunction Legacy() { return jsxDEV("button", { id:"legacy", children:"Legacy pay", onClick:()=>{document.querySelector("#output").textContent="paid"} }, undefined, false, {fileName:${q(entry)},lineNumber:4,columnNumber:27}, undefined); }\nwindow.actualReactVersion=React.version;\ncreateRoot(document.querySelector("#root")).render(jsxDEV(Legacy, {}, undefined, false, {fileName:${q(entry)},lineNumber:6,columnNumber:50}, undefined));`);
      compile(entry, "browser", path.join(root, "public/legacy.js"));
      writeFileSync(path.join(root, "legacy.html"), '<!doctype html><html lang="en"><h1>Real React 18 checkout</h1><div id="root"></div><output id="output">idle</output><script type="module" src="/legacy.js"></script></html>');
    }
    const script = path.join(helper, "server.mjs");
    writeFileSync(script, `import {createServer as portProbe} from "node:net"; import * as vite from ${q(vite)}; import react from ${q(reactPlugin)}; import {runPhantomSourceProvenance} from ${q(adapter)};
const reservation=portProbe();await new Promise((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',resolve)});const port=reservation.address().port;await new Promise((resolve,reject)=>reservation.close(error=>error?reject(error):resolve()));
const config={root:${q(root)},configFile:false,logLevel:"silent",plugins:[runPhantomSourceProvenance({enabled:true,renderer:"react-dom",include:["src/Checkout.tsx"]}),react()],resolve:{alias:${JSON.stringify({ "react-dom": path.dirname(appRequire.resolve("react-dom/package.json")), react: path.dirname(appRequire.resolve("react/package.json")) })}},optimizeDeps:{noDiscovery:true,include:["react","react-dom/client","react/jsx-dev-runtime"]}};
${production ? "await vite.build({...config,build:{sourcemap:true}});const server=await vite.preview({...config,preview:{host:'127.0.0.1',port,strictPort:true}});" : "const server=await vite.createServer({...config,server:{host:'127.0.0.1',port,strictPort:true}});await server.listen();"}
process.stdout.write(JSON.stringify({origin:'http://127.0.0.1:'+server.httpServer.address().port})+'\\n');
process.on('SIGTERM',async()=>{${production ? "await new Promise(resolve=>server.httpServer.close(resolve));" : "await server.close();"}process.exit(0)});`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.includes("API_KEY") && !key.startsWith("RUNPHANTOM_")));
    const proc = spawn("node", [script], { cwd: REPO_ROOT_PATH, env: { ...env, NODE_ENV: production ? "production" : "development" }, stdio: ["ignore", "pipe", "pipe"] });
    let raw = ""; let errors = ""; proc.stderr!.on("data", value => { errors += value; });
    try {
      const origin = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Fixture did not start: ${errors}`)), 25_000);
        proc.once("exit", code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${errors}`)); });
        proc.stdout!.on("data", value => { raw += value; if (raw.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(raw.split("\n")[0]).origin); } });
      });
      await use({ origin, root, legacy18: Boolean(legacy), production });
    } finally { await stop(proc); rmSync(root, { recursive: true, force: true }); rmSync(helper, { recursive: true, force: true }); }
  },
});
async function pair(page: Page, request: APIRequestContext, daemon: RunPhantomHandle, app: ReactApp, pathName = "/", enabled: boolean | "absent" = true) {
  const response = await request.post(`${daemon.url}/api/verification/sessions`, { data: { origin: app.origin } }); expect(response.ok()).toBe(true);
  const session = await response.json() as SessionSummary & { token: string; sdkUrl: string };
  await page.goto(`${app.origin}${pathName}`); await expect(page.locator("button").first()).toBeVisible();
  await page.evaluate(async ({ url, sessionId, token, sdkUrl, root, enabled }) => {
    const sdk = await import(sdkUrl); window.runtime = sdk.connect({ url, sessionId, token, ...(enabled === "absent" ? {} : { sourceProvenance: { enabled, repoRoot: root } }) });
  }, { url: daemon.url, sessionId: session.id, token: session.token, sdkUrl: new URL(session.sdkUrl, daemon.url).href, root: app.root, enabled });
  await expect.poll(async () => (await observe(request, daemon, session.id)).session.connected).toBe(true); return session;
}
type Reply = { ok: boolean; cursor: number; controlSource?: RetainedControlSource; result?: SemanticResult; error?: string };
async function command(request: APIRequestContext, daemon: RunPhantomHandle, sessionId: string, data: AppCommand): Promise<Reply> {
  const response = await request.post(`${daemon.url}/api/verification/sessions/${sessionId}/command`, { data }); expect(response.ok()).toBe(true); return response.json();
}
function safe(report: unknown, root: string, token: string, extra: string[] = []) { const raw = JSON.stringify(report); for (const value of [root, token, fixtureToken, fixtureRuntime, ...extra]) expect(raw.includes(value)).toBe(false); }

test("real React 19 stamps survive rerender, semantic fill, unmount and SPA routes without verdict authority", async ({ page, context, request, runPhantom, reactApp }, testInfo) => {
  const session = await pair(page, request, runPhantom, reactApp); await expect(page.getByRole("heading", { name: "React 19.2.6 checkout" })).toBeVisible();
  expect((await observe(request, runPhantom, session.id)).session.capabilities).toContain("control-source");
  for (const count of [1, 2]) {
    const acted = await command(request, runPhantom, session.id, { type: "click", selector: "#pay" }); expect(acted.ok).toBe(true);
    expect(acted.controlSource?.observation).toMatchObject({ status: "captured", mechanism: "dev-stamp", scope: "control", file: "src/Checkout.tsx", line: 6, column: 5, component: "Checkout" });
    await expect(page.locator("#output")).toHaveText(String(count)); safe(acted, reactApp.root, session.token);
  }
  const found = await command(request, runPhantom, session.id, { type: "find", query: { kind: "label", label: "Note" } }); expect(found.result?.status).toBe("unique");
  const secret = "F20_PRIVATE_FORM_VALUE_NEVER_RETAIN";
  const filled = await command(request, runPhantom, session.id, { type: "ref-fill", ref: found.result!.ref! , value: secret }); expect(filled.ok).toBe(true);
  expect(filled.controlSource?.observation).toMatchObject({ status: "captured", file: "src/Checkout.tsx", line: 7, mechanism: "dev-stamp" }); await expect(page.locator("#note")).toHaveValue(secret);
  const boundariesBefore = (await observe(request, runPhantom, session.id)).events.filter(event => event.type === "action.boundary").length;
  await page.locator("#note").evaluate(element => {
    HTMLInputElement.prototype.blur.call(element);
    const effects = { focus: 0, input: 0 }; Object.assign(window, { sourceRefEffects: effects });
    element.addEventListener("focus", () => effects.focus++); element.addEventListener("input", () => effects.input++);
  });
  await page.locator("#note").evaluate((element, secret) => element.setAttribute("data-runphantom-source", `src/${secret}.tsx:7:16`), secret);
  const stale = await command(request, runPhantom, session.id, { type: "ref-fill", ref: found.result!.ref!, value: secret }); expect(stale.ok).toBe(false); expect(stale.controlSource).toBeUndefined();
  expect(await page.evaluate(() => Reflect.get(window, "sourceRefEffects"))).toEqual({ focus: 0, input: 0 });
  expect((await observe(request, runPhantom, session.id)).events.filter(event => event.type === "action.boundary")).toHaveLength(boundariesBefore); await expect(page.locator("#note")).toHaveValue(secret); safe(stale, reactApp.root, session.token, [secret]);
  const rediscovered = await command(request, runPhantom, session.id, { type: "find", query: { kind: "label", label: "Note" } }); expect(rediscovered.result?.status).toBe("unique"); expect(rediscovered.result!.ref).not.toBe(found.result!.ref);
  const redacted = await command(request, runPhantom, session.id, { type: "ref-fill", ref: rediscovered.result!.ref!, value: secret }); expect(redacted.ok).toBe(true);
  expect(redacted.controlSource?.observation).toEqual({ source: "sdk-reported", framework: "react", status: "unavailable", reason: "redacted" }); safe(redacted, reactApp.root, session.token, [secret]); await expect(page.locator("#note")).toHaveValue(secret);
  expect(await page.evaluate(() => Reflect.get(window, "sourceRefEffects"))).toEqual({ focus: 1, input: 1 });
  expect((await observe(request, runPhantom, session.id)).events.filter(event => event.type === "action.boundary")).toHaveLength(boundariesBefore + 1);
  const removed = await command(request, runPhantom, session.id, { type: "click", selector: "#remove" }); expect(removed.ok).toBe(true); await expect(page.locator("#removed")).toBeVisible(); await expect(page.locator("#remove")).toHaveCount(0);
  const unmounted = await assertRuntime(request, runPhantom, session.id, { kind: "element", selector: "#removed", state: "present" }, removed.cursor, "Source retained before unmount"); expect(unmounted.status).toBe("pass"); expect(unmounted.context?.checks[0].controlSource).toEqual(removed.controlSource);
  const routed = await command(request, runPhantom, session.id, { type: "click", selector: "#route" }); expect(routed.ok).toBe(true); await expect(page).toHaveURL(`${reactApp.origin}/confirmed`); expect(routed.controlSource?.observation).toMatchObject({ line: 10, status: "captured" });
  const ambiguous = await command(request, runPhantom, session.id, { type: "click", selector: "button" }); expect(ambiguous.ok).toBe(false); expect(ambiguous.controlSource).toBeUndefined(); await expect(page.locator("#output")).toHaveText("2");
  const error = await command(request, runPhantom, session.id, { type: "click", selector: "#error" });
  const report = await assertRuntime(request, runPhantom, session.id, { kind: "console", level: "error", absent: true }, error.cursor, "Observed failure keeps source context"); expect(report.status).toBe("fail"); expect(report.context?.checks[0].controlSource).toEqual(error.controlSource); safe(report, reactApp.root, session.token, [secret]);
  const persisted = await request.get(`${runPhantom.url}/api/verification/reports`); expect((await persisted.json()).find((item: VerificationReport) => item.id === report.id)).toEqual(report);
  writeFileSync(testInfo.outputPath("source-reports.json"), JSON.stringify({ unmounted, failed: report }, null, 2) + "\n");
  const ui = await context.newPage(); try {
    await ui.goto(`${runPhantom.url}/verification`); await expect(ui.getByText(report.name, { exact: true })).toBeVisible();
    const article = ui.getByRole("article", { name: `${report.name}: fail`, exact: true }); const sourceContext = article.getByLabel("Control source context");
    await article.scrollIntoViewIfNeeded(); await expect(sourceContext).toBeVisible();
    await expect(sourceContext.getByText("SDK-reported React source · Before dispatch", { exact: true })).toBeVisible();
    await expect(sourceContext.getByText("src/Checkout.tsx:12:5", { exact: true })).toBeVisible(); await expect(article.getByText("Fail", { exact: true })).toBeVisible();
    await ui.screenshot({ path: testInfo.outputPath("react-source-report.png"), mask: [ui.locator("pre")] });
    await ui.setViewportSize({ width: 390, height: 844 }); await article.scrollIntoViewIfNeeded(); await sourceContext.scrollIntoViewIfNeeded();
    await expect(sourceContext.getByText("src/Checkout.tsx:12:5", { exact: true })).toBeVisible(); await expect(article.getByText("Fail", { exact: true })).toBeVisible();
    expect(await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await ui.screenshot({ path: testInfo.outputPath("react-source-mobile.png"), mask: [ui.locator("pre")] });
  } finally { await ui.close(); }
});


test("actual twenty-click React flow reports unavailable source when the whole context budget is spent", async ({ page, context, request, runPhantom, reactApp }, testInfo) => {
  const session = await pair(page, request, runPhantom, reactApp);
  const firstAction = await command(request, runPhantom, session.id, { type: "click", selector: "#pay" }); expect(firstAction.ok).toBe(true);
  const generation = firstAction.controlSource!.generation; await expect(page.locator("#output")).toHaveText("1");
  // A registered application store and native click listener produce actual synchronous transitions.
  await page.evaluate(() => {
    const payload = { value: "0".repeat(1900) }; window.runtime.registerStore("payload", () => payload);
    let count = 0; document.querySelector("#pay")!.addEventListener("click", () => { count++; payload.value = String(count % 2).repeat(1900); });
  });
  const predicate = { kind: "relative", target: { kind: "state", store: "payload", path: "value" }, relation: "changed" };
  const saved = await request.post(`${runPhantom.url}/api/verification/flows`, { data: { name: "Source omitted within report budget", origin: reactApp.origin, steps: Array.from({ length: 20 }, () => ({ command: { type: "click", selector: "#pay" }, predicate })) } }); expect(saved.ok()).toBe(true);
  const flow = await saved.json(); const ran = await request.post(`${runPhantom.url}/api/verification/flows/${flow.id}/run`, { data: { sessionId: session.id } }); expect(ran.ok()).toBe(true);
  const report = await ran.json() as VerificationReport; expect(report.status).toBe("pass"); await expect(page.locator("#output")).toHaveText("21");
  expect(report.context?.checks).toHaveLength(20); expect(report.context?.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(report.context))).toBeLessThanOrEqual(L.MAX_CONTEXT_BYTES);
  expect(report.context?.checks.every(check => check.status === "pass" && check.generation === generation && check.complete && check.settled && check.controlSource === undefined && check.controlSourceOmitted === "context-limit")).toBe(true);
  const persisted = await request.get(`${runPhantom.url}/api/verification/reports`); expect((await persisted.json()).find((item: VerificationReport) => item.id === report.id)).toEqual(report); safe(report, reactApp.root, session.token);
  writeFileSync(testInfo.outputPath("source-context-budget-report.json"), JSON.stringify(report, null, 2) + "\n");
  const ui = await context.newPage(); try {
    await ui.goto(`${runPhantom.url}/verification`); const article = ui.getByRole("article", { name: `${report.name}: pass`, exact: true });
    await article.scrollIntoViewIfNeeded(); const firstCheck = article.getByRole("list", { name: "Saved expected outcomes" }).locator(":scope > li").first();
    const unavailable = firstCheck.getByLabel("Control source context"); await unavailable.scrollIntoViewIfNeeded();
    await expect(unavailable.getByText("Source unavailable. Location omitted to keep the saved report within its size limit.", { exact: true })).toBeVisible();
    await expect(firstCheck.getByText("Passed", { exact: true })).toBeVisible();
    await ui.screenshot({ path: testInfo.outputPath("react-source-budget-desktop.png"), mask: [ui.locator("pre")] });
    await ui.setViewportSize({ width: 390, height: 844 }); await unavailable.scrollIntoViewIfNeeded();
    await expect(unavailable).toBeVisible(); expect(await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await ui.screenshot({ path: testInfo.outputPath("react-source-budget-mobile.png"), mask: [ui.locator("pre")] });
  } finally { await ui.close(); }
});


test("synthetic CJK display context saved through the real store remains readable without changing the report verdict", async ({ context, request, runPhantom }, testInfo) => {
  // This storage/display fixture is synthetic; real authenticated React execution is qualified separately.
  const helper = mkdtempSync(path.join(REPO_ROOT_PATH, ".omx/react-source-context-")); const script = path.join(helper, "seed.ts");
  try {
    writeFileSync(script, `import {randomUUID,createHash} from "node:crypto";
import {closeDb,getDrizzleDb} from ${q(path.join(REPO_ROOT_PATH, "src/db.ts"))};
import {saveReport} from ${q(path.join(REPO_ROOT_PATH, "src/verification/store.ts"))};
import {evaluatePredicate} from ${q(path.join(REPO_ROOT_PATH, "src/verification/predicates.ts"))};
import {parseControlSourceObservation} from ${q(path.join(REPO_ROOT_PATH, "src/verification/build/source.ts"))};
const coverage={network:true,console:true,dom:true,state:true,signal:true,route:true};const predicate={kind:"console",level:"error",absent:true};
const verdict=evaluatePredicate(predicate,{events:[],coverage,complete:true,settled:true});
const observation=parseControlSourceObservation({source:"sdk-reported",framework:"react",status:"captured",mechanism:"dev-stamp",scope:"control",file:"src/"+String.fromCharCode(34).repeat(260)+".tsx",line:1,column:1,component:String.fromCharCode(34).repeat(128)});
const source={actionId:randomUUID(),commandCursor:1,cursor:2,generation:1,capture:"before-dispatch",observation};
const report=saveReport({...verdict,id:randomUUID(),sessionId:randomUUID(),runId:null,flowId:null,name:"Synthetic CJK saved-context fixture",createdAt:Date.now(),context:{origin:"http://localhost:4812",quietMs:300,redacted:false,truncated:false,checks:Array.from({length:20},(_,i)=>({step:i+1,predicate,status:verdict.status,reason:"汉".repeat(1000),since:1,through:5,generation:1,coverage,complete:true,dropped:0,settled:true,controlSource:source}))}});
const read=()=>getDrizzleDb().$client.query("SELECT context FROM verification_reports WHERE id = ?").get(report.id).context;
const before=read();closeDb();getDrizzleDb();const after=read();if(before!==after)throw new Error("Stored bytes changed after reopen");closeDb();
process.stdout.write(JSON.stringify({report,liveVerdict:verdict,contextBytes:Buffer.byteLength(after),contextSha256:createHash("sha256").update(after).digest("hex"),fileReopenEqual:true}));`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.includes("API_KEY") && !key.startsWith("RUNPHANTOM_")));
    const result = spawnSync("bun", [script], { cwd: REPO_ROOT_PATH, env: { ...env, RUNPHANTOM_DB_PATH: runPhantom.dbPath }, encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
    expect(result.status, result.stderr).toBe(0); const proof = JSON.parse(result.stdout) as { report: VerificationReport; liveVerdict: { status: string; reason: string }; contextBytes: number; contextSha256: string; fileReopenEqual: boolean };
    const report = proof.report; expect(proof.fileReopenEqual).toBe(true); expect(proof.contextBytes).toBeLessThanOrEqual(L.MAX_CONTEXT_BYTES);
    expect(report.status).toBe(proof.liveVerdict.status); expect(report.reason).toBe(proof.liveVerdict.reason); expect(report.context!.checks).toHaveLength(20);
    expect(report.context!.checks.filter(check => check.reason === "[TRUNCATED]")).toHaveLength(1);
    const response = await request.get(`${runPhantom.url}/api/verification/reports`); expect(response.ok()).toBe(true);
    expect((await response.json()).find((item: VerificationReport) => item.id === report.id)).toEqual(report);
    writeFileSync(testInfo.outputPath("synthetic-cjk-storage-report.json"), JSON.stringify(proof, null, 2) + "\n");
    const ui = await context.newPage(); try {
      await ui.goto(`${runPhantom.url}/verification`); const article = ui.getByRole("article", { name: `${report.name}: pass`, exact: true });
      const firstCheck = article.getByRole("list", { name: "Saved expected outcomes" }).locator(":scope > li").first();
      await firstCheck.scrollIntoViewIfNeeded(); await expect(firstCheck.getByText("[TRUNCATED]", { exact: true })).toBeVisible();
      await expect(firstCheck.getByText("Passed", { exact: true })).toBeVisible();
      await expect(firstCheck.getByLabel("Control source context").getByText("Source unavailable. Location omitted to keep the saved report within its size limit.", { exact: true })).toBeVisible();
      await expect(article.getByText(report.reason, { exact: true })).toBeVisible();
      await ui.screenshot({ path: testInfo.outputPath("synthetic-cjk-context-desktop.png"), mask: [ui.locator("pre")] });
      await ui.setViewportSize({ width: 390, height: 844 }); await firstCheck.scrollIntoViewIfNeeded();
      await expect(firstCheck.getByText("[TRUNCATED]", { exact: true })).toBeVisible(); expect(await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await ui.screenshot({ path: testInfo.outputPath("synthetic-cjk-context-mobile.png"), mask: [ui.locator("pre")] });
    } finally { await ui.close(); }
  } finally { rmSync(helper, { recursive: true, force: true }); }
});

test("real React 18 debug source and native attribute reads never invoke own accessors or private getters", async ({ page, request, runPhantom, reactApp }, testInfo) => {
  test.skip(!reactApp.legacy18, "React 18.3.1 is not installed; no dependency download is authorized");
  const session = await pair(page, request, runPhantom, reactApp, "/legacy.html");
  expect(await page.evaluate(() => (window as unknown as { actualReactVersion: string }).actualReactVersion)).toBe("18.3.1");
  const acted = await command(request, runPhantom, session.id, { type: "click", selector: "#legacy" }); expect(acted.ok).toBe(true); await expect(page.locator("#output")).toHaveText("paid");
  expect(acted.controlSource?.observation).toMatchObject({ status: "captured", mechanism: "react-debug-source", file: "src/Legacy.tsx", line: 4, column: 27, component: "Legacy" }); safe(acted, reactApp.root, session.token);
  const proof = await page.evaluate(async root => {
    const moduleUrl = "/probe.js"; const { identifyReactControl } = await import(moduleUrl); const target = document.querySelector("#legacy")!;
    let invoked = 0; Object.defineProperty(target, "getAttribute", { configurable: true, get() { invoked++; throw new Error("own method must not be read"); } });
    const key = Object.getOwnPropertyNames(target).find(name => name.startsWith("__reactFiber$"))!;
    const fiber = Object.getOwnPropertyDescriptor(target, key)!.value; const props = Object.getOwnPropertyDescriptor(fiber, "memoizedProps")!;
    Object.defineProperty(fiber, "memoizedProps", { configurable: true, get() { invoked++; throw new Error("private props must not be read"); } });
    try { return { observed: identifyReactControl(target, root), noConsent: identifyReactControl(target), invoked }; }
    finally { delete (target as unknown as { getAttribute?: unknown }).getAttribute; Object.defineProperty(fiber, "memoizedProps", props); }
  }, reactApp.root);
  expect(proof.invoked).toBe(0); expect(proof.observed).toEqual(acted.controlSource!.observation);
  expect(proof.noConsent).toEqual({ source: "sdk-reported", framework: "react", status: "unavailable", reason: "unsafe-source" });
  writeFileSync(testInfo.outputPath("source-react18.json"), JSON.stringify({ acted, proof }, null, 2) + "\n");
});

test("real unstamped React 19 fails soft and absent or disabled capture negotiates no source capability", async ({ page, context, request, runPhantom, reactApp }, testInfo) => {
  const session = await pair(page, request, runPhantom, reactApp);
  await page.locator("#pay").evaluate(element => element.removeAttribute("data-runphantom-source"));
  const unstamped = await command(request, runPhantom, session.id, { type: "click", selector: "#pay" }); expect(unstamped.ok).toBe(true); await expect(page.locator("#output")).toHaveText("1");
  expect(unstamped.controlSource?.observation).toEqual({ source: "sdk-reported", framework: "react", status: "unavailable", reason: "source-unavailable" });
  const unavailable = await assertRuntime(request, runPhantom, session.id, { kind: "element", selector: "#pay", state: "present" }, unstamped.cursor, "Unstamped source stays unavailable"); expect(unavailable.status).toBe("pass"); expect(unavailable.context?.checks[0].controlSource).toEqual(unstamped.controlSource);
  writeFileSync(testInfo.outputPath("source-unavailable-report.json"), JSON.stringify(unavailable, null, 2) + "\n");
  const ui = await context.newPage(); try { await ui.goto(`${runPhantom.url}/verification`); const article = ui.getByRole("article", { name: `${unavailable.name}: pass`, exact: true }); await article.scrollIntoViewIfNeeded(); await expect(article.getByLabel("Control source context").getByText("Source unavailable. No development location was available.", { exact: true })).toBeVisible(); await ui.screenshot({ path: testInfo.outputPath("react-source-unavailable.png"), mask: [ui.locator("pre")] }); } finally { await ui.close(); }
  for (const enabled of [false, "absent"] as const) {
    await page.evaluate(() => window.runtime.disconnect()); const disabled = await pair(page, request, runPhantom, reactApp, "/", enabled);
    expect((await observe(request, runPhantom, disabled.id)).session.capabilities).not.toContain("control-source");
    await page.evaluate(() => {
      const target = document.querySelector("#pay")!; const key = Object.getOwnPropertyNames(target).find(name => name.startsWith("__reactFiber$"))!;
      const descriptor = Object.getOwnPropertyDescriptor(target, key)!; const counter = { count: 0 }; Object.assign(window, { sourceDescriptorCounter: counter });
      Object.defineProperty(target, key, { ...descriptor, value: new Proxy(descriptor.value, { getOwnPropertyDescriptor() { counter.count++; throw new Error("disabled source must not inspect fibers"); } }) });
    });
    const acted = await command(request, runPhantom, disabled.id, { type: "click", selector: "#pay" }); expect(acted.ok).toBe(true); expect(acted.controlSource).toBeUndefined(); await expect(page.locator("#output")).toHaveText("1");
    expect(await page.evaluate(() => (window as unknown as { sourceDescriptorCounter: { count: number } }).sourceDescriptorCounter.count)).toBe(0);
    const report = await assertRuntime(request, runPhantom, disabled.id, { kind: "element", selector: "#pay", state: "present" }, acted.cursor); expect(report.status).toBe("pass"); expect(report.context?.checks[0].controlSource).toBeUndefined();
  }
});

test("actual document navigation freezes old-generation source and reconnect cannot make it current", async ({ page, context, request, runPhantom, reactApp }, testInfo) => {
  const session = await pair(page, request, runPhantom, reactApp);
  const before = await command(request, runPhantom, session.id, { type: "click", selector: "#pay" }); expect(before.ok).toBe(true);
  const generation = before.controlSource!.generation;
  const created = await request.post(`${runPhantom.url}/api/verification/flows`, { data: { name: "Source before document navigation", origin: reactApp.origin, steps: [{ command: { type: "click", selector: "#navigate" }, predicate: { kind: "signal", name: "never-emitted" } }] } }); expect(created.ok()).toBe(true); const flow = await created.json();
  const ran = await request.post(`${runPhantom.url}/api/verification/flows/${flow.id}/run`, { data: { sessionId: session.id } }); expect(ran.ok()).toBe(true); const report = await ran.json() as VerificationReport;
  await expect(page).toHaveURL(`${reactApp.origin}/landing`); expect(report.status).toBe("inconclusive"); expect(report.context?.checks[0].complete).toBe(false);
  expect(report.context?.checks[0].controlSource).toMatchObject({ generation, capture: "before-dispatch", observation: { file: "src/Checkout.tsx", line: 11, status: "captured" } }); safe(report, reactApp.root, session.token);
  const ui = await context.newPage(); try {
    await ui.goto(`${runPhantom.url}/verification`); const article = ui.getByRole("article", { name: `${report.name}: inconclusive`, exact: true }); await article.scrollIntoViewIfNeeded();
    await expect(article.getByLabel("Control source context").getByText("src/Checkout.tsx:11:5", { exact: true })).toBeVisible(); await expect(article.getByText("Inconclusive", { exact: true }).first()).toBeVisible();
    await expect(article.getByText("Capture is incomplete. This source was retained before the action; it cannot establish the outcome.", { exact: true })).toBeVisible();
    await ui.screenshot({ path: testInfo.outputPath("react-source-navigation.png"), mask: [ui.locator("pre")] });
  } finally { await ui.close(); }
  await page.evaluate(async ({ daemon, id, token, root }) => { const sdk = await import(`${daemon}/verification/sdk.js`); window.runtime = sdk.connect({ url: daemon, sessionId: id, token, sourceProvenance: { enabled: true, repoRoot: root } }); }, { daemon: runPhantom.url, id: session.id, token: session.token, root: reactApp.root });
  await expect.poll(async () => (await observe(request, runPhantom, session.id)).session.connected).toBe(true);
  const freshCursor = (await observe(request, runPhantom, session.id)).cursor;
  const fresh = await assertRuntime(request, runPhantom, session.id, { kind: "element", selector: "#pay", state: "present" }, freshCursor); expect(fresh.status).toBe("pass"); expect(fresh.context?.checks[0].controlSource).toBeUndefined();
  const current = await command(request, runPhantom, session.id, { type: "click", selector: "#pay" }); expect(current.ok).toBe(true); expect(current.controlSource!.generation).toBeGreaterThan(generation);
  writeFileSync(testInfo.outputPath("source-navigation-report.json"), JSON.stringify({ before, report, fresh, current }, null, 2) + "\n");
});

test.describe("real consumer production", () => {
  test.use({ production: true });
  test("production strips static stamps and dev connection values while the real React output still works", async ({ page, request, reactApp }) => {
    await page.goto(reactApp.origin); await expect(page.getByRole("heading", { name: "React 19.2.6 checkout" })).toBeVisible();
    expect(await page.locator("[data-runphantom-source]").count()).toBe(0); await page.getByRole("button", { name: "Pay 0", exact: true }).click(); await expect(page.locator("#output")).toHaveText("1");
    expect(await page.evaluate(() => ({ token: (window as unknown as { fixtureToken?: string }).fixtureToken, runtime: (window as unknown as { fixtureRuntime?: string }).fixtureRuntime }))).toEqual({ token: undefined, runtime: undefined });
    const html = await (await request.get(reactApp.origin)).text(); const script = /src="([^"]+\.js)"/.exec(html)?.[1]; expect(script).toBeTruthy();
    const js = await (await request.get(new URL(script!, reactApp.origin).href)).text(); for (const value of [fixtureToken, fixtureRuntime, "data-runphantom-source", reactApp.root]) expect(js.includes(value)).toBe(false);
  });
});
