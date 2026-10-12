import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { browserDaemon, isReaped } from "./helpers/trusted-browser-daemon";
import { trustedBrowserFixture } from "./helpers/trusted-browser-fixture";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runMcpServer } from "../src/mcp/index";

describe("registered trusted browser API", () => {
  test("absent runtime is explicit and original SDK creation remains available", async () => {
    const profile = mkdtempSync(path.join(tmpdir(), "rp-browser-http-absent-")); const daemon = await browserDaemon(profile);
    try {
      const status = await daemon.api("/browser/status"); expect(status.status).toBe(200); expect(status.body.available).toBe(false);
      const open = await daemon.api("/browser/sessions", { engine: "chromium", url: "http://localhost:8765" }); expect(open.status).toBe(503); expect(open.body.error).toContain("not configured");
      const sdk = await daemon.api("/sessions", { origin: "http://localhost:8765" }); expect(sdk.status).toBe(201); expect(sdk.body.token).toBeString();
      expect((await daemon.api("/browser/sessions")).body).toEqual([]);
      for (const field of ["module", "profile", "evaluate", "executable"]) expect((await daemon.api("/browser/sessions", { engine: "chromium", url: "http://localhost:8765", [field]: "unsafe" })).status).toBe(400);
      expect((await daemon.api("/browser/sessions", { engine: "chromium", url: "http://localhost:8765" }, "POST", { Origin: "http://evil.example" })).status).toBe(403);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcp = await runMcpServer({ url: daemon.url, transport: serverTransport }); const client = new Client({ name: "browser-actual-http-control", version: "1" });
      try {
        await client.connect(clientTransport);
        const names = (await client.listTools()).tools.map(tool => tool.name);
        for (const name of ["browser_session", "browser_input", "browser_observe", "browser_artifact", "app_act", "app_assert"]) expect(names).toContain(name);
        expect(new Set(names).size).toBe(names.length);
        const actual = await client.callTool({ name: "browser_session", arguments: { operation: "status" } });
        expect(actual.content).toEqual([{ type: "text", text: JSON.stringify(status.body) }]);
        await Promise.resolve(expect(client.callTool({ name: "browser_session", arguments: { operation: "status", module: "/tmp/code" } })).rejects.toThrow("Unexpected browser field"));
        await Promise.resolve(expect(client.callTool({ name: "browser_input", arguments: { sessionId: "a".repeat(32), generation: 1, action: { type: "evaluate", code: "1" } } })).rejects.toThrow());
        expect((await daemon.api("/browser/sessions")).body).toEqual([]);
      } finally { await client.close(); await mcp.close(); }
    } finally { await daemon.stop(); expect(isReaped(daemon.proc)).toBe(true); rmSync(profile, { recursive: true, force: true }); }
  }, 25000);
});

describe.skipIf(!process.env.RUNPHANTOM_TEST_BROWSER_MODULE)("actual source daemon browser outcomes", () => {
  test("daemon shutdown fences every live generation before any real browser teardown await", async () => {
    const profile = mkdtempSync(path.join(tmpdir(), "rp-browser-http-shutdown-")), fixture = trustedBrowserFixture();
    const runtime = path.join(profile, "controlled-runtime"); mkdirSync(runtime); const pidFile = path.join(profile, "owned-browser-pids");
    writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ name: "playwright", version: "1.62.1", type: "module" }));
    // The installed runtime still dispatches and observes real browsers. Only
    // owned server teardown is delayed to expose a cross-session fence race.
    writeFileSync(path.join(runtime, "index.mjs"), `import * as real from ${JSON.stringify(process.env.RUNPHANTOM_TEST_BROWSER_MODULE)};import {appendFileSync} from 'node:fs';export const firefox=real.firefox;export const webkit=real.webkit;export const chromium={...real.chromium,connectOverCDP:real.chromium.connectOverCDP.bind(real.chromium),connect:real.chromium.connect.bind(real.chromium),launchServer:async(options)=>{const server=await real.chromium.launchServer(options);appendFileSync(${JSON.stringify(pidFile)},String(server.process().pid)+'\\n');return {process:()=>server.process(),wsEndpoint:()=>server.wsEndpoint(),close:async()=>{await new Promise(resolve=>setTimeout(resolve,1000));return server.close()},kill:()=>server.kill()}}};`);
    const environment = { RUNPHANTOM_BROWSER_MODULE: path.join(runtime, "index.mjs"), ...(process.env.RUNPHANTOM_TEST_BROWSER_CACHE ? { RUNPHANTOM_BROWSER_CACHE: process.env.RUNPHANTOM_TEST_BROWSER_CACHE } : {}) };
    const daemon = await browserDaemon(profile, environment); let reopened: Awaited<ReturnType<typeof browserDaemon>> | undefined;
    let firstPending: Promise<any> | undefined, secondPending: Promise<any> | undefined;
    try {
      const first = (await daemon.api("/browser/sessions", { engine: "chromium", url: fixture.origin })).body;
      const second = (await daemon.api("/browser/sessions", { engine: "chromium", url: fixture.origin })).body;
      firstPending = daemon.api(`/browser/sessions/${first.id}/check`, { generation: first.generation, action: { type: "click", target: { kind: "css", selector: "#covered" } }, predicate: { kind: "element", selector: "#paid", state: "present" }, name: "First interrupted connection" }).catch(() => null);
      const deadline = Date.now() + 2000; let boundary = false;
      while (Date.now() < deadline) { if ((await daemon.api(`/browser/sessions/${first.id}/events`)).body.events.some((event: { type: string }) => event.type === "action.boundary")) { boundary = true; break; } await new Promise(resolve => setTimeout(resolve, 10)); }
      expect(boundary).toBe(true);
      secondPending = daemon.api(`/browser/sessions/${second.id}/check`, { generation: second.generation, predicate: { kind: "element", selector: "#always", state: "present" }, name: "Second interrupted connection" }).catch(() => null);
      let secondBusy = false; const busyDeadline = Date.now() + 2000;
      while (Date.now() < busyDeadline) { if ((await daemon.api("/browser/sessions")).body.find((session: { id: string }) => session.id === second.id)?.state === "busy") { secondBusy = true; break; } await new Promise(resolve => setTimeout(resolve, 10)); }
      expect(secondBusy).toBe(true);
      await daemon.stop(); await Promise.all([firstPending, secondPending]); expect(isReaped(daemon.proc)).toBe(true);
      for (const pid of readFileSync(pidFile, "utf8").trim().split("\n").map(Number)) expect(() => process.kill(pid, 0)).toThrow();
      reopened = await browserDaemon(profile, environment);
      const reports = (await reopened.api("/reports")).body; expect(reports).toHaveLength(2);
      expect(new Set(reports.map((report: { name: string }) => report.name))).toEqual(new Set(["First interrupted connection", "Second interrupted connection"]));
      for (const report of reports) { expect(report.status).toBe("inconclusive"); expect(report.context.checks[0].complete).toBe(false); }
      expect((await reopened.api("/browser/sessions")).body).toEqual([]); expect(fixture.events).toEqual([]);
      const retained = new Map(reports.map((report: { id: string }) => [report.id, JSON.stringify(report)]));
      const fresh = (await reopened.api("/browser/sessions", { engine: "chromium", url: fixture.origin })).body;
      const positive = await reopened.api(`/browser/sessions/${fresh.id}/check`, { generation: fresh.generation, action: { type: "click", target: { kind: "css", selector: "#pay" } }, predicate: { kind: "element", selector: "#paid", state: "present" } }); expect(positive.body.report.status).toBe("pass");
      const after = (await reopened.api("/reports")).body; expect(after).toHaveLength(3);
      for (const report of after.filter((report: { id: string }) => retained.has(report.id))) expect(JSON.stringify(report)).toBe(retained.get(report.id));
      expect(fixture.events.filter(event => event.type === "output").at(-1)).toEqual({ type: "output", trusted: true, value: "Payment accepted" });
    } finally { await daemon.stop(); await Promise.all([firstPending, secondPending]); await reopened?.stop(); await fixture.close(); rmSync(profile, { recursive: true, force: true }); }
  }, 45000);
  test("pending operation plus clear fences late completion, permits a fresh session and retains private artifacts", async () => {
    const profile = mkdtempSync(path.join(tmpdir(), "rp-browser-http-clear-")), fixture = trustedBrowserFixture();
    const daemon = await browserDaemon(profile, { RUNPHANTOM_BROWSER_MODULE: process.env.RUNPHANTOM_TEST_BROWSER_MODULE!, ...(process.env.RUNPHANTOM_TEST_BROWSER_CACHE ? { RUNPHANTOM_BROWSER_CACHE: process.env.RUNPHANTOM_TEST_BROWSER_CACHE } : {}) });
    let pending: Promise<any> | undefined;
    try {
      const opened = (await daemon.api("/browser/sessions", { engine: "chromium", url: fixture.origin })).body;
      const route = `/browser/sessions/${opened.id}`, generation = opened.generation;
      const capture = await daemon.api(`${route}/capture`, { generation }); expect(capture.status).toBe(201);
      const retained = JSON.stringify((await daemon.api(`/browser/artifacts/${capture.body.id}`)).body);
      pending = daemon.api(`${route}/check`, { generation, action: { type: "click", target: { kind: "css", selector: "#covered" } }, predicate: { kind: "element", selector: "#paid", state: "present" }, name: "Cancelled covered input" }).catch(() => null);
      const deadline = Date.now() + 2000; let boundary = false;
      while (Date.now() < deadline) { if ((await daemon.api(`${route}/events`)).body.events.some((event: { type: string }) => event.type === "action.boundary")) { boundary = true; break; } await new Promise(resolve => setTimeout(resolve, 10)); }
      expect(boundary).toBe(true);
      expect((await daemon.api(`${route}/action`, { generation, action: { type: "click", target: { kind: "css", selector: "#pay" } } })).status).toBe(409);
      const clear = await fetch(`${daemon.url}/api/clear`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); expect(clear.status).toBe(200);
      const old = (await daemon.api("/browser/sessions")).body.find((session: { id: string }) => session.id === opened.id); expect(old.state).toBe("closed"); expect(old.generation).toBeGreaterThan(generation);
      const late = await pending; expect(late.body.report.status).toBe("inconclusive"); expect((await daemon.api("/reports")).body).toEqual([]);
      expect(fixture.events.filter(event => event.type === "covered")).toEqual([]);
      expect(JSON.stringify((await daemon.api(`/browser/artifacts/${capture.body.id}`)).body)).toBe(retained);
      const fresh = (await daemon.api("/browser/sessions", { engine: "chromium", url: fixture.origin })).body;
      const verified = await daemon.api(`/browser/sessions/${fresh.id}/check`, { generation: fresh.generation, action: { type: "click", target: { kind: "css", selector: "#pay" } }, predicate: { kind: "element", selector: "#paid", state: "present" } });
      expect(verified.body.report.status).toBe("pass"); expect((await daemon.api("/reports")).body).toHaveLength(1);
    } finally { await daemon.stop(); await pending; await fixture.close(); rmSync(profile, { recursive: true, force: true }); }
  }, 45000);
  test("clear during real delayed launch cannot create browser authority after the clear response", async () => {
    const profile = mkdtempSync(path.join(tmpdir(), "rp-browser-http-opening-")), fixture = trustedBrowserFixture();
    const runtime = path.join(profile, "controlled-runtime"); mkdirSync(runtime);
    writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ name: "playwright", version: "1.62.1", type: "module" }));
    writeFileSync(path.join(runtime, "index.mjs"), `import * as real from ${JSON.stringify(process.env.RUNPHANTOM_TEST_BROWSER_MODULE)}; export const firefox=real.firefox; export const webkit=real.webkit; export const chromium={...real.chromium,connectOverCDP:real.chromium.connectOverCDP.bind(real.chromium),connect:real.chromium.connect.bind(real.chromium),launchServer:async(options)=>{const server=await real.chromium.launchServer(options);await new Promise(resolve=>setTimeout(resolve,700));return server}};`);
    const daemon = await browserDaemon(profile, { RUNPHANTOM_BROWSER_MODULE: path.join(runtime, "index.mjs"), ...(process.env.RUNPHANTOM_TEST_BROWSER_CACHE ? { RUNPHANTOM_BROWSER_CACHE: process.env.RUNPHANTOM_TEST_BROWSER_CACHE } : {}) });
    let pending: Promise<any> | undefined;
    try {
      pending = daemon.api("/browser/sessions", { engine: "chromium", url: fixture.origin });
      let opening: { id: string; state: string } | undefined; const deadline = Date.now() + 2000;
      while (Date.now() < deadline) { opening = (await daemon.api("/browser/sessions")).body[0]; if (opening) break; await new Promise(resolve => setTimeout(resolve, 10)); }
      expect(opening?.state).toBe("opening");
      await new Promise(resolve => setTimeout(resolve, 250));
      const clear = await fetch(`${daemon.url}/api/clear`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); expect(clear.status).toBe(200);
      const late = await pending; expect(late.status).toBe(503);
      expect((await daemon.api("/browser/sessions")).body.some((session: { state: string }) => session.state === "ready" || session.state === "opening")).toBe(false);
      expect(fixture.events).toEqual([]);
    } finally { await daemon.stop(); await pending; expect(isReaped(daemon.proc)).toBe(true); await fixture.close(); rmSync(profile, { recursive: true, force: true }); }
  }, 35000);
  test("unconfirmed real browser teardown refuses clear and preserves saved outcomes", async () => {
    const profile = mkdtempSync(path.join(tmpdir(), "rp-browser-http-close-failure-")), fixture = trustedBrowserFixture();
    const runtime = path.join(profile, "controlled-runtime"); mkdirSync(runtime); const pidFile = path.join(profile, "owned-browser-pid");
    writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ name: "playwright", version: "1.62.1", type: "module" }));
    // Fault injection wraps the actual installed browser server, not manufactured report results.
    writeFileSync(path.join(runtime, "index.mjs"), `import * as real from ${JSON.stringify(process.env.RUNPHANTOM_TEST_BROWSER_MODULE)};import {writeFileSync} from 'node:fs'; export const firefox=real.firefox;export const webkit=real.webkit;export const chromium={...real.chromium,connectOverCDP:real.chromium.connectOverCDP.bind(real.chromium),connect:real.chromium.connect.bind(real.chromium),launchServer:async(options)=>{const server=await real.chromium.launchServer(options);writeFileSync(${JSON.stringify(pidFile)},String(server.process().pid));return {process:()=>server.process(),wsEndpoint:()=>server.wsEndpoint(),close:async()=>{throw new Error('Controlled close fault')},kill:async()=>{throw new Error('Controlled close fault')}}}};`);
    const daemon = await browserDaemon(profile, { RUNPHANTOM_BROWSER_MODULE: path.join(runtime, "index.mjs"), ...(process.env.RUNPHANTOM_TEST_BROWSER_CACHE ? { RUNPHANTOM_BROWSER_CACHE: process.env.RUNPHANTOM_TEST_BROWSER_CACHE } : {}) });
    try {
      const open = await daemon.api("/browser/sessions", { engine: "chromium", url: fixture.origin }); expect(open.status).toBe(201); const opened = open.body;
      const report = await daemon.api(`/browser/sessions/${opened.id}/check`, { generation: opened.generation, predicate: { kind: "element", selector: "#always", state: "present" } }); expect(report.body.report.status).toBe("pass");
      const before = JSON.stringify((await daemon.api("/reports")).body);
      const clear = await fetch(`${daemon.url}/api/clear`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); expect(clear.status).toBe(503);
      expect(JSON.stringify((await daemon.api("/reports")).body)).toBe(before);
      expect(JSON.stringify(await clear.json())).not.toContain(profile);
      const pid = Number(readFileSync(pidFile, "utf8"));
      const deadline = Date.now() + 2000; while (Date.now() < deadline) { try { process.kill(pid, 0); } catch { break; } await new Promise(resolve => setTimeout(resolve, 25)); }
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { await daemon.stop(); expect(isReaped(daemon.proc)).toBe(true); await fixture.close(); rmSync(profile, { recursive: true, force: true }); }
  }, 40000);
  test("actual private video flushes before admission while default capture stays masked and inert", async () => {
    const profile = mkdtempSync(path.join(tmpdir(), "rp-browser-http-video-")), fixture = trustedBrowserFixture();
    const daemon = await browserDaemon(profile, { RUNPHANTOM_BROWSER_MODULE: process.env.RUNPHANTOM_TEST_BROWSER_MODULE!, ...(process.env.RUNPHANTOM_TEST_BROWSER_CACHE ? { RUNPHANTOM_BROWSER_CACHE: process.env.RUNPHANTOM_TEST_BROWSER_CACHE } : {}) });
    try {
      expect((await daemon.api("/browser/sessions", { engine: "chromium", url: fixture.origin, recordVideo: true })).status).toBe(400);
      const opened = await daemon.api("/browser/sessions", { engine: "chromium", url: fixture.origin, recordVideo: true, rawConsent: true }); expect(opened.status).toBe(201); expect(opened.body.video).toBe("recording");
      expect((await daemon.api("/browser/sessions", { engine: "chromium", url: fixture.origin, recordVideo: true, rawConsent: true })).status).toBe(409);
      const route = `/browser/sessions/${opened.body.id}`, generation = opened.body.generation;
      expect((await daemon.api(`${route}/action`, { generation, action: { type: "fill", target: { kind: "css", selector: "#name" }, value: "PRIVATE CONTROLLED INPUT" } })).body.action.dispatch).toBe("completed");
      const capture = await daemon.api(`${route}/capture`, { generation }); expect(capture.status).toBe(201); expect(capture.body).toMatchObject({ width: 1280, height: 720, raw: false });
      const png = Buffer.from(await (await fetch(`${daemon.url}/api/verification/browser/artifacts/${capture.body.id}/content`)).arrayBuffer()); expect(createHash("sha256").update(png).digest("hex")).toBe(capture.body.sha256);
      expect((await daemon.api(`${route}/capture`, { generation, raw: true })).status).toBe(400);
      const closed = await daemon.api(`${route}/close`, { generation }); expect(closed.status).toBe(200); expect(closed.body.artifacts).toHaveLength(1);
      const video = closed.body.artifacts[0]; expect(video).toMatchObject({ kind: "video", raw: true, maskScope: "none", ownership: "owned", mime: "video/webm" }); expect(video.bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
      const contentUrl = `${daemon.url}/api/verification/browser/artifacts/${video.id}/content`;
      expect((await fetch(contentUrl)).status).toBe(400); const content = await fetch(`${contentUrl}?rawConsent=true`); expect(content.status).toBe(200); expect(content.headers.get("cache-control")).toBe("no-store");
      const bytes = Buffer.from(await content.arrayBuffer()); expect(createHash("sha256").update(bytes).digest("hex")).toBe(video.sha256);
      const file = path.join(profile, "qualification.webm"); writeFileSync(file, bytes, { mode: 0o600 });
      const decoder = spawnSync(process.env.RUNPHANTOM_TEST_FFPROBE ?? "ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,width,height", "-of", "json", file], { timeout: 5000, maxBuffer: 16384 }); expect(decoder.status).toBe(0);
      const decoded = JSON.parse(decoder.stdout.toString()); expect(Number(decoded.format.duration)).toBeGreaterThan(0); expect(Number(decoded.format.duration)).toBeLessThanOrEqual(60); expect(decoded.streams).toContainEqual(expect.objectContaining({ codec_name: "vp8", width: 1280, height: 720 }));
      expect((await daemon.api("/reports")).body).toEqual([]);
      if (process.env.RUNPHANTOM_BROWSER_PROOF_DIR) { mkdirSync(process.env.RUNPHANTOM_BROWSER_PROOF_DIR, { recursive: true }); writeFileSync(path.join(process.env.RUNPHANTOM_BROWSER_PROOF_DIR, "masked-target-source.png"), png); writeFileSync(path.join(process.env.RUNPHANTOM_BROWSER_PROOF_DIR, "video-source-proof.json"), JSON.stringify({ execution: "source runtime actual worker", artifact: video, decoder: { status: decoder.status, ...decoded }, retainedRawVideo: false, providers: "blank" }, null, 2)); }
    } finally { await daemon.stop(); expect(isReaped(daemon.proc)).toBe(true); await fixture.close(); rmSync(profile, { recursive: true, force: true }); }
  }, 45000);
  test("host asset consent never authorizes foreign navigation, popups or the daemon control origin", async () => {
    const profile = mkdtempSync(path.join(tmpdir(), "rp-browser-http-policy-")); let foreignRequests = 0, control = "";
    const foreign = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { foreignRequests++; return new Response("asset", { headers: { "Access-Control-Allow-Origin": "*" } }); } }); const foreignOrigin = `http://127.0.0.1:${foreign.port}`;
    const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      if (new URL(request.url).pathname === "/redirect") return Response.redirect(`${foreignOrigin}/navigation`);
      return new Response(`<html><body><button id="asset">Allowed asset</button><button id="control">Daemon control</button><button id="popup">Foreign popup</button><output id="original">Original Café 東京</output><script>document.querySelector('#asset').onclick=async()=>{await fetch(${JSON.stringify(foreignOrigin + "/asset")});document.body.insertAdjacentHTML('beforeend','<div id="asset-done">Asset loaded</div>')};document.querySelector('#control').onclick=()=>fetch(${JSON.stringify(control + "/health")}).catch(()=>{});document.querySelector('#popup').onclick=()=>window.open(${JSON.stringify(foreignOrigin + "/popup")},'_blank');</script></body></html>`, { headers: { "Content-Type": "text/html" } });
    } }); const origin = `http://127.0.0.1:${target.port}`;
    const daemon = await browserDaemon(profile, { RUNPHANTOM_BROWSER_MODULE: process.env.RUNPHANTOM_TEST_BROWSER_MODULE!, RUNPHANTOM_BROWSER_ASSET_ORIGINS: foreignOrigin, ...(process.env.RUNPHANTOM_TEST_BROWSER_CACHE ? { RUNPHANTOM_BROWSER_CACHE: process.env.RUNPHANTOM_TEST_BROWSER_CACHE } : {}) }); control = daemon.url;
    try {
      const opened = (await daemon.api("/browser/sessions", { engine: "chromium", url: origin })).body; const route = `/browser/sessions/${opened.id}`, generation = opened.generation;
      const asset = await daemon.api(`${route}/check`, { generation, action: { type: "click", target: { kind: "css", selector: "#asset" } }, predicate: { kind: "allOf", predicates: [{ kind: "network", urlContains: "/asset", status: 200 }, { kind: "element", selector: "#asset-done", state: "present" }] } }); expect(asset.body.report.status).toBe("pass"); expect(foreignRequests).toBe(1);
      const blocked = await daemon.api(`${route}/check`, { generation, action: { type: "click", target: { kind: "css", selector: "#control" } }, predicate: { kind: "console", level: "error", absent: true } }); expect(blocked.body.report.status).toBe("inconclusive");
      expect((await daemon.api(`${route}/events`)).body.events).toContainEqual(expect.objectContaining({ type: "capture.loss", data: { reason: "request-policy" } }));
      await daemon.api(`${route}/close`, { generation });
      const popup = (await daemon.api("/browser/sessions", { engine: "chromium", url: origin })).body;
      expect((await daemon.api(`/browser/sessions/${popup.id}/check`, { generation: popup.generation, action: { type: "click", target: { kind: "css", selector: "#popup" } }, predicate: { kind: "console", level: "error", absent: true } })).body.report.status).toBe("inconclusive"); expect(foreignRequests).toBe(1);
      await daemon.api(`/browser/sessions/${popup.id}/close`, { generation: popup.generation });
      const redirect = await daemon.api("/browser/sessions", { engine: "chromium", url: `${origin}/redirect` }); expect(redirect.status).toBe(503); expect(foreignRequests).toBe(1);
      for (const url of ["file:///tmp/x", "data:text/html,x", "javascript:1", "http://u:p@localhost:8765"]) expect((await daemon.api("/browser/sessions", { engine: "chromium", url })).status).toBe(400);
    } finally { await daemon.stop(); expect(isReaped(daemon.proc)).toBe(true); await target.stop(true); await foreign.stop(true); rmSync(profile, { recursive: true, force: true }); }
  }, 45000);
  test("request-object identity survives reverse completions and absence waits for the response body", async () => {
    const profile = mkdtempSync(path.join(tmpdir(), "rp-browser-http-identity-")), fixture = trustedBrowserFixture();
    const daemon = await browserDaemon(profile, { RUNPHANTOM_BROWSER_MODULE: process.env.RUNPHANTOM_TEST_BROWSER_MODULE!, ...(process.env.RUNPHANTOM_TEST_BROWSER_CACHE ? { RUNPHANTOM_BROWSER_CACHE: process.env.RUNPHANTOM_TEST_BROWSER_CACHE } : {}) });
    try {
      const opened = (await daemon.api("/browser/sessions", { engine: "chromium", url: fixture.origin })).body;
      const route = `/browser/sessions/${opened.id}`, generation = opened.generation;
      const duplicate = await daemon.api(`${route}/check`, { generation, action: { type: "click", target: { kind: "css", selector: "#duplicates" } }, predicate: { kind: "allOf", predicates: [{ kind: "network", urlContains: "/duplicate", status: 201 }, { kind: "network", urlContains: "/duplicate", status: 202 }, { kind: "element", selector: "#duplicates-done", state: "present" }] } });
      expect(duplicate.status).toBe(200); expect(duplicate.body.report.status).toBe("pass");
      const events = (await daemon.api(`${route}/events`)).body.events as Array<{ type: string; data: { url?: string; requestId: string; status?: number } }>;
      const starts = events.filter(event => event.type === "network.start" && event.data.url?.endsWith("/duplicate"));
      const finished = events.filter(event => event.type === "network" && event.data.url?.endsWith("/duplicate"));
      expect(starts).toHaveLength(2); expect(finished).toHaveLength(2);
      expect(starts[0].data.requestId).not.toBe(starts[1].data.requestId);
      expect(finished.map(event => event.data.status)).toEqual([202, 201]);
      expect(finished.map(event => event.data.requestId)).toEqual([starts[1].data.requestId, starts[0].data.requestId]);
      const began = Date.now();
      const delayed = await daemon.api(`${route}/check`, { generation, action: { type: "click", target: { kind: "css", selector: "#delayed" } }, predicate: { kind: "console", level: "error", absent: true } });
      expect(delayed.body.report.status).toBe("fail"); expect(Date.now() - began).toBeGreaterThanOrEqual(900);
      expect(delayed.body.report.evidence).toContainEqual(expect.objectContaining({ type: "console", data: expect.objectContaining({ level: "error", message: "Delayed controlled error" }) }));
      // A filled word equal to a discriminator is private data; it must not turn error absence into a pass.
      const secret = await daemon.api(`${route}/check`, { generation, action: { type: "fill", target: { kind: "css", selector: "#name" }, value: "error" }, predicate: { kind: "console", level: "error", absent: true } });
      expect(secret.body.report.status).not.toBe("pass");
      const latest = (await daemon.api(`${route}/events`)).body.events;
      expect(latest).toContainEqual(expect.objectContaining({ type: "console", data: { level: "error", message: "[REDACTED]" }, truncated: true }));
      expect(JSON.stringify(secret.body.report)).not.toContain('"message":"error"');
    } finally { await daemon.stop(); expect(isReaped(daemon.proc)).toBe(true); await fixture.close(); rmSync(profile, { recursive: true, force: true }); }
  }, 40000);
  test("trusted input proves declared facts, missing final output fails, unsupported checks remain inconclusive and restart is inert", async () => {
    const profile = mkdtempSync(path.join(tmpdir(), "rp-browser-http-runtime-")); const fixture = trustedBrowserFixture();
    const environment = { RUNPHANTOM_BROWSER_MODULE: process.env.RUNPHANTOM_TEST_BROWSER_MODULE!, ...(process.env.RUNPHANTOM_TEST_BROWSER_CACHE ? { RUNPHANTOM_BROWSER_CACHE: process.env.RUNPHANTOM_TEST_BROWSER_CACHE } : {}) };
    let daemon = await browserDaemon(profile, environment);
    try {
      const open = await daemon.api("/browser/sessions", { engine: "chromium", url: fixture.origin }); expect(open.status).toBe(201);
      const { id, generation } = open.body;
      const path = `/browser/sessions/${id}`;
      const outcome = { kind: "allOf", predicates: [{ kind: "network", urlContains: "/accepted", status: 202 }, { kind: "element", selector: "#paid", state: "present" }] };
      const broken = await daemon.api(`${path}/check`, { generation, action: { type: "click", target: { kind: "css", selector: "#broken" } }, predicate: outcome, name: "Final payment output" });
      expect(broken.status).toBe(200); expect(broken.body.action.dispatch).toBe("completed"); expect(broken.body.report.status).toBe("fail");
      expect(fixture.events.find(event => event.type === "broken")?.value).toBe("Original output Café 東京");
      const good = await daemon.api(`${path}/check`, { generation, action: { type: "click", target: { kind: "role", role: "button", name: "Pay" } }, predicate: outcome, name: "Payment complete" });
      expect(good.body.report.status).toBe("pass");
      expect(fixture.events.find(event => event.type === "output")).toEqual({ type: "output", trusted: true, value: "Payment accepted" }); expect(good.body.report.context.execution).toMatchObject({ backend: "trusted-browser", ownership: "owned", inputMode: "trusted-browser", dispatch: "completed", generation });
      const unsupported = await daemon.api(`${path}/check`, { generation, predicate: { kind: "state", store: "cart", path: "paid", equals: true } }); expect(unsupported.body.report.status).toBe("inconclusive");
      const stale = await daemon.api(`${path}/action`, { generation: generation - 1, action: { type: "click", target: { kind: "css", selector: "#pay" } } }); expect(stale.status).toBe(409);
      expect((await daemon.api("/browser/sessions", { engine: "chromium", url: daemon.url })).status).toBe(400);
      const capture = await daemon.api(`${path}/capture`, { generation }); expect(capture.status).toBe(201); expect(capture.body.raw).toBe(false); expect(capture.body.maskScope).toBe("inputs-editable-private-known-secrets");
      const reports = (await daemon.api("/reports")).body; const preserved = JSON.stringify(reports);
      expect((await daemon.api(`${path}/close`, { generation })).status).toBe(200);
      await daemon.stop(); expect(isReaped(daemon.proc)).toBe(true);
      daemon = await browserDaemon(profile, environment);
      expect(JSON.stringify((await daemon.api("/reports")).body)).toBe(preserved);
      expect((await daemon.api("/browser/sessions")).body).toEqual([]);
      expect((await daemon.api(`/browser/artifacts/${capture.body.id}`)).body).toMatchObject({ sha256: capture.body.sha256, bytes: capture.body.bytes, availability: "available" });
      expect(reports.find((report: { id: string }) => report.id === good.body.report.id).status).toBe("pass");
    } finally { await daemon.stop(); await fixture.close(); rmSync(profile, { recursive: true, force: true }); }
  }, 40000);
});
