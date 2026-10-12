import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { test as base, expect, REPO_ROOT_PATH, type RunPhantomHandle } from "./fixtures";
import type { SessionSummary } from "../../src/verification/protocol";

export const test = base.extend<{ storeApp: { origin: string; realPinia: boolean } }>({
  storeApp: async ({}, use) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "runphantom-f23-app-"));
    const privateRoot = process.env.RUNPHANTOM_F23_PINIA_FIXTURE_ROOT;
    const realPinia = Boolean(privateRoot);
    if (privateRoot) {
      const manifest = JSON.parse(readFileSync(path.join(privateRoot, "fixture-manifest.json"), "utf8")) as { direct_versions: Record<string, string>; lifecycle_scripts_executed: boolean; actual_total_private_bytes: number };
      if (manifest.direct_versions.pinia !== "4.0.3" || manifest.direct_versions.vue !== "3.5.43"
        || manifest.lifecycle_scripts_executed || manifest.actual_total_private_bytes > 50 * 1024 * 1024) throw new Error("Unqualified private Pinia fixture");
    }
    const entry = path.join(directory, "app.ts");
    const output = path.join(directory, "app.js");
    writeFileSync(entry, `
import { QueryClient } from ${JSON.stringify(path.join(REPO_ROOT_PATH, "app/node_modules/@tanstack/react-query/build/modern/index.js"))};
${privateRoot ? `import { createPinia, setActivePinia, defineStore } from ${JSON.stringify(path.join(privateRoot, "node_modules/pinia/dist/pinia.js"))};\nimport { createApp, h } from ${JSON.stringify(path.join(privateRoot, "node_modules/vue/dist/vue.runtime.esm-bundler.js"))};` : ""}
const state = { count: 1, nested: { total: 2 }, body: 'unselected business body' };
const listeners = new Set();
const stats = { shapeSubscribed: 0, shapeReleased: 0, querySubscribed: 0, queryReleased: 0, piniaSubscribed: 0, piniaReleased: 0, getters: 0, shapeReads: 0 };
const shape = { getState: () => { stats.shapeReads++; return state; }, subscribe(listener) { stats.shapeSubscribed++; listeners.add(listener); listener(); return () => { stats.shapeReleased++; listeners.delete(listener); }; } };
const client = new QueryClient(); const key = ['counter', { unit: 'widgets', page: 1 }];
client.setQueryData(key, { count: 1, body: 'unselected query body' });
const cache = client.getQueryCache(), originalSubscribe = cache.subscribe.bind(cache);
cache.subscribe = listener => { stats.querySubscribed++; const stop = originalSubscribe(listener); return () => { stats.queryReleased++; stop(); }; };
let sdk, runtime, queryRelease, shapeRelease, piniaRelease, component;
const pinia = ${privateRoot ? `(() => { setActivePinia(createPinia()); const useCounter = defineStore('f23', { state: () => ({ count: 1, nested: { total: 2 }, body: 'unselected pinia body' }) }); const value = useCounter(); const original = value.$subscribe.bind(value); value.$subscribe = (listener, options) => { stats.piniaSubscribed++; const stop = original(listener, options); return () => { stats.piniaReleased++; stop(); }; }; return value; })()` : "{ $state: { count: 1, nested: { total: 2 } }, $subscribe(listener) { stats.piniaSubscribed++; piniaListeners.add(listener); return () => { stats.piniaReleased++; piniaListeners.delete(listener); }; } }"};
const piniaListeners = new Set();
const render = () => { document.querySelector('#count').textContent = String(state.count); document.querySelector('#query-count').textContent = String(client.getQueryData(key).count); document.querySelector('#pinia-count').textContent = String(${privateRoot ? "pinia.count" : "pinia.$state.count"}); };
const notify = () => { for (const listener of [...listeners]) listener(); };
document.querySelector('#increment').onclick = () => { state.count++; state.nested.total++; notify(); render(); };
document.querySelector('#noop').onclick = () => {};
document.querySelector('#query-update').onclick = () => { client.setQueryData(key, { count: client.getQueryData(key).count + 1, body: 'unselected query body' }); render(); };
document.querySelector('#invalidate').onclick = () => client.invalidateQueries({ queryKey: key, refetchType: 'none' });
document.querySelector('#pinia-increment').onclick = () => { ${privateRoot ? "pinia.count++; pinia.nested.total++;" : "pinia.$state.count++; pinia.$state.nested.total++; for (const l of [...piniaListeners]) l();"} render(); };
document.querySelector('#unmount').onclick = () => { component?.unmount(); document.querySelector('#component-status').textContent = 'Component unmounted'; };
document.querySelector('#spa').onclick = () => { history.pushState({}, '', '/next'); document.querySelector('#route-status').textContent = 'Local route changed'; };
document.querySelector('#data-optin').onclick = () => { queryRelease(); queryRelease = runtime.registerStore('queries', sdk.queryStore(client, { keys: [{ queryKey: key, select: { count: 'count' } }] })); document.querySelector('#data-status').textContent = 'Selected query count exposed'; };
document.querySelector('#private-key').onclick = () => {
  const privateClient = new QueryClient();
  const privateKey = ['profile', { nested: { password: 'f23-private-password', apiKey: 'f23-private-api-key', token: 'f23-private-token' }, ordinary: 'sk-proj-' + 'test'.repeat(12) }];
  privateClient.setQueryData(privateKey, { count: 1, body: 'private key business body' });
  runtime.registerStore('private-query', sdk.queryStore(privateClient, { keys: [{ queryKey: privateKey, select: { count: 'count' } }] }));
  document.querySelector('#private-status').textContent = 'Private key metadata registered';
};
document.querySelector('#text').oninput = event => { state.text = event.target.value; notify(); };
window.storeFixture = {
  sourceKind: ${JSON.stringify(realPinia ? "pinia-4.0.3/vue-3.5.43" : "pinia-shaped-app-fixture")}, stats, state,
  async connect(options) {
    sdk = await import(options.sdkUrl); runtime = sdk.connect(options); window.storeRuntime = runtime;
    shapeRelease = runtime.registerStore('shape', sdk.shapeStore(shape, { select: { count: 'count', nested: 'nested.total' } }));
    queryRelease = runtime.registerStore('queries', sdk.queryStore(client, { keys: [{ queryKey: key }] }));
    ${privateRoot ? `component = createApp({ setup() { piniaRelease = runtime.registerStore('pinia', sdk.piniaStore(pinia, { select: { count: 'count', nested: 'nested.total' } })); return () => h('p', 'Mounted Pinia count ' + pinia.count); } }); component.mount('#component');` : "piniaRelease = runtime.registerStore('pinia', sdk.piniaStore(pinia, { select: { count: 'count', nested: 'nested.total' } }));"}
    const nestedGetter = Object.defineProperty({}, 'count', { enumerable: true, get() { stats.getters++; return 1; } });
    const cyclic = {}; cyclic.self = cyclic;
    runtime.registerStore('getter', sdk.shapeStore({ getState: () => nestedGetter, subscribe: () => () => {} }, { select: { count: 'count' } }));
    runtime.registerStore('cycle', sdk.shapeStore({ getState: () => cyclic, subscribe: () => () => {} }, { select: { root: '' } }));
    runtime.registerStore('large', sdk.shapeStore({ getState: () => ({ value: Array.from({ length: 100 }, () => Array(100).fill(1)) }), subscribe: () => () => {} }, { select: { root: '' } }));
    document.querySelector('#connection').textContent = 'Runtime connected';
  },
  release() { shapeRelease(); queryRelease(); piniaRelease(); },
  exposeText() { shapeRelease(); shapeRelease = runtime.registerStore('shape', sdk.shapeStore(shape, { select: { text: 'text' } })); },
  duplicate() { return runtime.registerStore('shape', sdk.shapeStore(shape, { select: { count: 'count', nested: 'nested.total' } })); },
  rejectCredentialSelection() { const before = stats.shapeReads; let refused = false; try { sdk.shapeStore(shape, { select: { ordinary: 'password' } }); } catch { refused = true; } return { refused, reads: stats.shapeReads - before }; },
  notify,
}; render();
`);
    execFileSync("bun", ["build", entry, "--target=browser", `--outfile=${output}`, "--define", 'process.env.NODE_ENV="development"'],
      { cwd: REPO_ROOT_PATH, env: { PATH: process.env.PATH, NODE_ENV: "development" }, timeout: 20_000, maxBuffer: 256 * 1024 });
    const script = readFileSync(output);
    const server = createServer((request, response) => {
      if (new URL(request.url ?? "/", "http://localhost").pathname === "/app.js") {
        response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(script); return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Explicit selected application state</title></head><body>
<h1>Selected state fixture</h1><p id="connection">Ready to pair</p>
<button id="increment">Increment state</button><button id="noop">Do nothing</button><output id="count">1</output>
<button id="query-update">Update query count</button><button id="invalidate">Invalidate query</button><output id="query-count">1</output>
<button id="data-optin">Expose selected query count</button><p id="data-status">Query metadata only</p>
<button id="private-key">Inspect private query metadata</button><p id="private-status">Private key not registered</p>
<button id="pinia-increment">Increment Pinia state</button><output id="pinia-count">1</output>
<button id="unmount">Unmount component</button><p id="component-status">Component mounted</p><div id="component"></div>
<button id="spa">Change local route</button><p id="route-status">Original route</p><label>Live text<input id="text"></label>
<script type="module" src="/app.js"></script></body></html>`);
    });
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address(); if (!address || typeof address === "string") throw new Error("State fixture not bound");
      await use({ origin: `http://127.0.0.1:${address.port}`, realPinia });
    } finally {
      server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  },
});
export { expect };
export async function pairStoreApp(page: Page, request: APIRequestContext, daemon: RunPhantomHandle, origin: string): Promise<SessionSummary> {
  const response = await request.post(`${daemon.url}/api/verification/sessions`, { data: { origin } });
  expect(response.ok()).toBe(true);
  const paired = await response.json() as SessionSummary & { token: string; sdkUrl: string };
  await page.goto(origin);
  await expect(page.getByRole("heading", { name: "Selected state fixture" })).toBeVisible();
  await page.waitForFunction(() => Boolean((window as unknown as { storeFixture?: unknown }).storeFixture));
  await page.evaluate(async options => {
    const fixture = (window as unknown as { storeFixture: { connect(options: unknown): Promise<void> } }).storeFixture;
    await fixture.connect(options);
  }, { url: daemon.url, sessionId: paired.id, token: paired.token, sdkUrl: new URL(paired.sdkUrl, daemon.url).href });
  await expect.poll(async () => {
    const response = await request.get(`${daemon.url}/api/verification/sessions`);
    return (await response.json() as SessionSummary[]).find(session => session.id === paired.id)?.connected;
  }).toBe(true);
  return paired;
}
export function readStoredReport(dbPath: string, id: string): { status: string; evidence: unknown; context: unknown } {
  const script = 'import {Database} from "bun:sqlite"; const db=new Database(process.argv[1],{readonly:true}); const row=db.query("SELECT status,evidence,context FROM verification_reports WHERE id=?").get(process.argv[2]); db.close(); console.log(JSON.stringify(row));';
  const row = JSON.parse(execFileSync("bun", ["-e", script, dbPath, id], { cwd: REPO_ROOT_PATH,
    env: { PATH: process.env.PATH }, timeout: 5000, maxBuffer: 128 * 1024 }).toString()) as { status: string; evidence: string; context: string };
  return { status: row.status, evidence: JSON.parse(row.evidence) as unknown, context: JSON.parse(row.context) as unknown };
}
