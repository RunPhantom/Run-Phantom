import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { browserDaemon, isReaped } from "./helpers/trusted-browser-daemon";
import { trustedBrowserFixture } from "./helpers/trusted-browser-fixture";
import type { BrowserEngine } from "../src/verification/browser-types";
import { BrowserProvider } from "../src/verification/browser-provider";

describe.skipIf(!process.env.RUNPHANTOM_TEST_BROWSER_MODULE)("registered bounded browser transport", () => {
  for (const engine of ["chromium", "firefox", "webkit"] as BrowserEngine[]) {
    test(`${engine}: original business survives while the original redirect reaches zero foreign requests`, async () => {
      const profile = mkdtempSync(path.join(tmpdir(), `rp-browser-transport-${engine}-`));
      const fixture = trustedBrowserFixture(); let foreignRequests = 0;
      const foreign = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { foreignRequests++; return new Response("foreign navigation", { headers: { "Access-Control-Allow-Origin": "*" } }); } });
      const foreignOrigin = `http://127.0.0.1:${foreign.port}`;
      const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.redirect(`${foreignOrigin}/original-redirect`); } });
      const daemon = await browserDaemon(profile, { RUNPHANTOM_BROWSER_MODULE: process.env.RUNPHANTOM_TEST_BROWSER_MODULE!,
        RUNPHANTOM_BROWSER_ASSET_ORIGINS: foreignOrigin,
        ...(process.env.RUNPHANTOM_TEST_BROWSER_CACHE ? { RUNPHANTOM_BROWSER_CACHE: process.env.RUNPHANTOM_TEST_BROWSER_CACHE } : {}) });
      try {
        const opened = await daemon.api("/browser/sessions", { engine, url: fixture.origin }); expect(opened.status).toBe(201);
        const route = `/browser/sessions/${opened.body.id}`, generation = opened.body.generation;
        const good = await daemon.api(`${route}/check`, { generation, action: { type: "click", target: { kind: "css", selector: "#pay" } },
          predicate: { kind: "allOf", predicates: [{ kind: "network", urlContains: "/accepted", status: 202 }, { kind: "element", selector: "#paid", state: "present" }] } });
        expect(good.status).toBe(200);
        if (good.body.report.status !== "pass") console.info(JSON.stringify({ engine, status: good.body.report.status, reason: good.body.report.reason, sessions: (await daemon.api("/browser/sessions")).body, lossReasons: (await daemon.api(`${route}/events`)).body.events?.filter((event: { type: string }) => event.type === "capture.loss").map((event: { data: { reason: string } }) => event.data.reason), action: good.body.action }));
        expect(good.body.report.status).toBe("pass");
        expect(fixture.events.find(event => event.type === "output")).toEqual({ type: "output", trusted: true, value: "Payment accepted" });
        expect((await daemon.api(`${route}/close`, { generation })).status).toBe(200);
        const redirect = await daemon.api("/browser/sessions", { engine, url: `http://127.0.0.1:${target.port}/redirect` });
        expect(redirect.status).toBe(503); expect(foreignRequests).toBe(0);
        expect(JSON.stringify((await daemon.api("/reports")).body)).toContain("trusted-browser");
      } finally {
        await daemon.stop(); expect(isReaped(daemon.proc)).toBe(true); await fixture.close(); await target.stop(true); await foreign.stop(true); rmSync(profile, { recursive: true, force: true });
      }
    }, 45000);
  }
});

function controlledRuntime(directory: string, engine: BrowserEngine, stage: string, marker: string): string {
  mkdirSync(directory); writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "playwright", version: "1.62.1" }));
  const entry = path.join(directory, "index.mjs");
  writeFileSync(entry, `import * as real from ${JSON.stringify(process.env.RUNPHANTOM_TEST_BROWSER_MODULE)};
import {appendFileSync} from 'node:fs';
const marker=${JSON.stringify(marker)}, stage=${JSON.stringify(stage)};
const mark=value=>appendFileSync(marker,value+'\\n');
const selected=real[${JSON.stringify(engine)}];
const adapter={...selected,connectOverCDP:real.chromium.connectOverCDP.bind(real.chromium),launchServer:selected.launchServer.bind(selected),connect:async(...args)=>{
 const browser=await selected.connect(...args), newContext=browser.newContext.bind(browser);
 browser.newContext=async(...options)=>{
  const context=await newContext(...options), newPage=context.newPage.bind(context), baseRoute=context.route.bind(context); let page, main=0, first=true;
  context.newPage=async(...options)=>{page=await newPage(...options);let commits=0;page.on('framenavigated',frame=>{if(frame===page.mainFrame())mark('native-main-commit-'+(++commits))});page.on('request',request=>{if(request.isNavigationRequest()&&request.frame()===page.mainFrame()){main++;mark('native-main-request-'+main)}});return page};
  context.route=async(pattern,handler)=>baseRoute(pattern,async route=>{
   const request=route.request();
   if(stage==='before-event-open'&&request.url().endsWith('/hold.js')){mark('trigger-'+stage);await page.evaluate(()=>{document.open();document.write('<html><body>before replacement</body></html>');document.close()});}
   if(first&&request.isNavigationRequest()){
    first=false;const trigger=async()=>{mark('trigger-'+stage);if(stage==='close')await page.close();else if(stage==='document-replacement'||stage==='after-event-open')await page.evaluate(()=>{document.open();document.write('<html><body>replacement</body></html>');document.close()});else if(stage==='root-restore')await page.evaluate(()=>{const root=document.documentElement;document.removeChild(root);document.appendChild(root)});else if(stage==='double-commit')await page.goto('about:blank',{waitUntil:'domcontentloaded',timeout:1500});else {void page.goto(request.url(),{waitUntil:'domcontentloaded',timeout:1500}).catch(()=>{});await new Promise(resolve=>setTimeout(resolve,150));}};
    if(stage==='cancel'||stage==='clear'){const headers=request.headersArray.bind(request);request.headersArray=async()=>{const values=await headers();mark('trigger-'+stage);await new Promise(resolve=>setTimeout(resolve,1000));return values};}
    else if(stage==='held-headers'){const headers=request.headersArray.bind(request);request.headersArray=async()=>{const values=await headers();await trigger();return values};}
    else if(stage!=='before-event-open'){const fulfill=route.fulfill.bind(route);route.fulfill=async options=>{const loaded=['after-event-open','root-restore','double-commit','same-url-after-event'].includes(stage)?page.waitForEvent('domcontentloaded',{timeout:3000}):null;const pending=fulfill(options);if(stage==='document-replacement'||loaded)await pending;if(loaded){await loaded;mark('actual-domcontentloaded');}await trigger();await pending;};}
   }
   return handler(route);
  });return context;
 };return browser;
}};
export const chromium=${engine === "chromium" ? "adapter" : "real.chromium"};
export const firefox=${engine === "firefox" ? "adapter" : "real.firefox"};
export const webkit=${engine === "webkit" ? "adapter" : "real.webkit"};`);
  return entry;
}

describe.skipIf(!process.env.RUNPHANTOM_TEST_BROWSER_MODULE)("exact initial native navigation receipt", () => {
  for (const engine of ["chromium", "firefox", "webkit"] as BrowserEngine[]) for (const stage of ["held-headers", "held-fulfillment", "close", "document-replacement", "before-event-open", "after-event-open", "root-restore", "double-commit", "same-url-after-event"]) {
    test(`${engine}: ${stage} cannot acknowledge a canceled or replaced initial goto`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), "rp-initial-receipt-")), marker = path.join(root, "native.log");
      let requests = 0;
      const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { if (new URL(request.url).pathname === "/hold.js") return new Response("", { headers: { "content-type": "text/javascript" } }); requests++; return new Response(`<!doctype html><html><body>initial${stage === "before-event-open" ? '<script src="/hold.js"></script>' : ""}</body></html>`, { headers: { "content-type": "text/html" } }); } });
      const provider = new BrowserProvider({ moduleEntry: controlledRuntime(path.join(root, "runtime"), engine, stage, marker), artifactRoot: path.join(root, "artifacts") });
      let worker: Awaited<ReturnType<BrowserProvider["start"]>> | undefined;
      try {
        worker = await provider.start("owned");
        const opened = await worker.request("open", 0, { engine, url: `http://127.0.0.1:${target.port}/initial`, recordVideo: false }, 15000);
        expect(opened.ok).toBe(false);
        const markers = readFileSync(marker, "utf8"); expect(markers).toContain(`trigger-${stage}`);
        if (["after-event-open", "root-restore", "double-commit", "same-url-after-event"].includes(stage)) expect(markers).toContain("actual-domcontentloaded");
        if (stage.startsWith("held-") || stage === "same-url-after-event") expect(markers).toContain("native-main-request-2");
        if (stage === "double-commit") expect(markers).toContain("native-main-commit-2");
        expect(requests).toBe(stage === "held-headers" ? 0 : 1);
      } finally { await provider.close(); if (worker) expect(worker.proof.reaped).toBe(true); await target.stop(true); rmSync(root, { recursive: true, force: true }); }
    }, 25000);
  }
});

async function waitForNativeMarker(marker: string, value: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (existsSync(marker) && readFileSync(marker, "utf8").includes(value)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Native fixture did not reach the held operation");
}

describe.skipIf(!process.env.RUNPHANTOM_TEST_BROWSER_MODULE)("current initial cancellation authority", () => {
  for (const engine of ["chromium", "firefox", "webkit"] as BrowserEngine[]) {
    test(`${engine}: closing during native headers cancels the exact initial operation before its socket`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), "rp-initial-cancel-")), marker = path.join(root, "native.log"); let requests = 0;
      const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return new Response("<html><body>initial</body></html>"); } });
      const provider = new BrowserProvider({ moduleEntry: controlledRuntime(path.join(root, "runtime"), engine, "cancel", marker), artifactRoot: path.join(root, "artifacts") });
      try {
        const worker = await provider.start("owned");
        const pending = worker.request("open", 0, { engine, url: `http://127.0.0.1:${target.port}`, recordVideo: false }, 15000).then(reply => reply.ok, () => false);
        await waitForNativeMarker(marker, "trigger-cancel"); await worker.close();
        expect(await pending).toBe(false); expect(requests).toBe(0); expect(worker.proof.reaped).toBe(true);
      } finally { await provider.close(); await target.stop(true); rmSync(root, { recursive: true, force: true }); }
    }, 25000);
    test(`${engine}: registered clear during native headers cannot restore the canceled initial session`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), "rp-initial-clear-")), marker = path.join(root, "native.log"); let requests = 0;
      const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return new Response("<html><body>initial</body></html>"); } });
      const daemon = await browserDaemon(root, { RUNPHANTOM_BROWSER_MODULE: controlledRuntime(path.join(root, "runtime"), engine, "clear", marker) });
      let pending: Promise<{ status: number }> | undefined;
      try {
        pending = daemon.api("/browser/sessions", { engine, url: `http://127.0.0.1:${target.port}` });
        await waitForNativeMarker(marker, "trigger-clear");
        const clear = await fetch(`${daemon.url}/api/clear`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        expect(clear.status).toBe(200); expect((await pending).status).toBe(503); expect(requests).toBe(0);
        expect((await daemon.api("/browser/sessions")).body.every((session: { state: string }) => session.state === "closed" || session.state === "unavailable")).toBe(true);
      } finally { await daemon.stop(); await pending; expect(isReaped(daemon.proc)).toBe(true); await target.stop(true); rmSync(root, { recursive: true, force: true }); }
    }, 30000);
  }
});

describe.skipIf(!process.env.RUNPHANTOM_TEST_BROWSER_MODULE)("qualified native cookie subset", () => {
  for (const engine of ["chromium", "firefox", "webkit"] as BrowserEngine[]) {
    test(`${engine}: native controlled HttpOnly Strict subset has explicit positive or unavailable result`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), "rp-native-cookie-")); let actualCookie = "", received = 0;
      const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        if (new URL(request.url).pathname === "/cookie-check") { received++; actualCookie = request.headers.get("cookie") ?? ""; return new Response("accepted"); }
        return new Response('<html><body><button id="send">Send</button><script>document.querySelector("#send").onclick=e=>{if(e.isTrusted)fetch("/cookie-check")}</script></body></html>', { headers: { "content-type": "text/html", "set-cookie": "qualified=opaque; HttpOnly; SameSite=Strict; Path=/" } });
      } });
      const provider = new BrowserProvider({ moduleEntry: process.env.RUNPHANTOM_TEST_BROWSER_MODULE!, artifactRoot: path.join(root, "artifacts") });
      try {
        const worker = await provider.start("owned");
        const opened = await worker.request("open", 0, { engine, url: `http://127.0.0.1:${target.port}`, recordVideo: false }, 20000);
        expect(opened.ok).toBe(engine !== "webkit");
        if (opened.ok) {
          const action = await worker.request("action", opened.generation, { action: { type: "click", target: { kind: "css", selector: "#send" } }, actionId: "a".repeat(32) });
          expect(action.ok).toBe(true);
          for (let wait = 0; received === 0 && wait < 50; wait++) await new Promise(resolve => setTimeout(resolve, 20));
          expect(received).toBe(1); expect(actualCookie).toBe("qualified=opaque");
        } else expect(received).toBe(0);
      } finally { await provider.close(); expect(provider.proofs().every(proof => proof.reaped)).toBe(true); await target.stop(true); rmSync(root, { recursive: true, force: true }); }
    }, 25000);
    test(`${engine}: native unqualified Set-Cookie fields never reach fulfillment`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), "rp-native-cookie-refusal-"));
      const cases = ["qualified=opaque; Path=/; SameSite=Strict", "qualified=opaque; Path=/; HttpOnly; SameSite=Lax", "qualified=opaque; Path=/private; HttpOnly; SameSite=Strict", "qualified=opaque; Path=/; HttpOnly; SameSite=Strict; Domain=127.0.0.1", "qualified=opaque; Path=/; HttpOnly; SameSite=Strict; Secure", "qualified=opaque; Path=/; HttpOnly; SameSite=Strict, other=opaque"];
      const provider = new BrowserProvider({ moduleEntry: process.env.RUNPHANTOM_TEST_BROWSER_MODULE!, artifactRoot: path.join(root, "artifacts") });
      let cookie = cases[0], fields = 1;
      const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { const headers = new Headers({ "content-type": "text/html", "set-cookie": cookie }); if (fields === 2) headers.append("set-cookie", "other=opaque; Path=/; HttpOnly; SameSite=Strict"); return new Response("<html><body>unqualified</body></html>", { headers }); } });
      try {
        for (const value of [...cases, "qualified=opaque; Path=/; HttpOnly; SameSite=Strict"]) {
          cookie = value; if (value === cases.at(-1)) fields = 1; else if (value === "qualified=opaque; Path=/; HttpOnly; SameSite=Strict") fields = 2;
          const worker = await provider.start("owned"), reasons: string[] = [];
          worker.onEvent = (_generation, event) => { const e = event as { type?: string; data?: { reason?: string } }; if (e.type === "capture.loss" && e.data?.reason) reasons.push(e.data.reason); };
          const opened = await worker.request("open", 0, { engine, url: `http://127.0.0.1:${target.port}`, recordVideo: false }, 20000);
          expect(opened.ok).toBe(false); expect(reasons).toContain("set-cookie-profile-unavailable"); await worker.close(); expect(worker.proof.reaped).toBe(true);
        }
      } finally { await provider.close(); await target.stop(true); rmSync(root, { recursive: true, force: true }); }
    }, 45000);
  }
});
