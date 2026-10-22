import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { test, expect, type RunPhantomHandle } from "./fixtures";
import type { APIRequestContext, Page } from "@playwright/test";

async function pair(page: Page, request: APIRequestContext, daemon: RunPhantomHandle, origin: string, enabled: boolean) {
  const response = await request.post(`${daemon.url}/api/verification/sessions`, { data: { origin } });
  expect(response.ok()).toBe(true);
  const session = await response.json();
  await page.goto(origin);
  await page.evaluate(async ({ url, session, enabled }) => {
    const sdk = await import(new URL(session.sdkUrl, url).href);
    (window as any).runtime = sdk.connect({ url, sessionId: session.id, token: session.token, businessResponses: enabled });
    (window as any).runtime.registerStore("business", () => (window as any).businessState);
    (window as any).cloneCalls = 0;
    const clone = Object.getOwnPropertyDescriptor(Response.prototype, "clone")!.value as (this: Response) => Response;
    Response.prototype.clone = function () { (window as any).cloneCalls++; return clone.call(this); };
  }, { url: daemon.url, session, enabled });
  let connected: any;
  await expect.poll(async () => { connected = (await (await request.get(`${daemon.url}/api/verification/sessions`)).json()).find((s: any) => s.id === session.id); return connected?.connected; }).toBe(true);
  return { ...session, cursor: connected.cursor };
}

async function fixture() {
  const streams = new Set<ServerResponse>();
  let override: string | undefined;
  let status = 200;
  let mime = "application/json";
  const original = JSON.stringify({ operationId: "order-21", result: "rejected", errors: [{ message: "stock unavailable" }], password: "synthetic-private-21" });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/business/incomplete-sse") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end('data: {"operationId":"order-21","result":"paid"}'); return;
    }
    if (url.pathname === "/business/secret-stream") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"operationId":"order-21","result":"paid","api\\u004bey":"synthetic-split-key","note":"sk_li');
      const timer = setTimeout(() => response.end('ve_abcdefghijklmnopqrstuv"}'), 25);
      response.on("close", () => clearTimeout(timer)); return;
    }
    if (url.pathname === "/business/stream") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write('data: {"operationId":"order-21","result":"pending"}\n\n');
      streams.add(response); response.on("close", () => streams.delete(response)); return;
    }
    if (url.pathname === "/business/json") { response.writeHead(status, { "Content-Type": mime }); response.end(override ?? original); return; }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end('<!doctype html><html><body><button id="json">Order</button><button id="stream">Stream</button><pre id="output"></pre><script>window.businessState={operationId:"order-21",result:"accepted"};document.querySelector("#json").onclick=async()=>{const r=await fetch("/business/json");document.querySelector("#output").textContent=await r.text();};document.querySelector("#stream").onclick=()=>{void fetch("/business/stream");};</script></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture port missing");
  return { origin: `http://127.0.0.1:${address.port}`, original,
    set(value: unknown, responseStatus = 200, responseMime = "application/json") { override = typeof value === "string" ? value : JSON.stringify(value); status = responseStatus; mime = responseMime; },
    end() { for (const response of streams) response.end('data: {"operationId":"order-21","result":"done"}\n\n'); },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

async function events(request: APIRequestContext, daemon: RunPhantomHandle, id: string) {
  const response = await request.get(`${daemon.url}/api/verification/sessions/${id}/events`);
  expect(response.ok()).toBe(true); return (await response.json()).events as any[];
}

test("opt-in actual HTTP200 body failure is visible without changing the app response", async ({ page, request, runPhantom }) => {
  const app = await fixture();
  try {
    const session = await pair(page, request, runPhantom, app.origin, true);
    await page.locator("#json").click();
    await expect(page.locator("#output")).toHaveText(app.original);
    await expect.poll(async () => (await events(request, runPhantom, session.id)).some(e => e.type === "network.body" && e.data.state === "complete")).toBe(true);
    const captured = await events(request, runPhantom, session.id);
    const body = captured.find(e => e.type === "network.body" && e.data.state === "complete");
    expect(body.data.body.password).toBe("[REDACTED]");
    expect(body.data.body.errors).toEqual([{ message: "stock unavailable" }]);
    expect(JSON.stringify(captured)).not.toContain("synthetic-private-21");
    expect(await page.evaluate(() => (window as any).cloneCalls)).toBe(1);
  } finally { await app.close(); }
});

test("actual streamed response stays pending through headers and completes only at EOF", async ({ page, request, runPhantom }) => {
  const app = await fixture();
  try {
    const session = await pair(page, request, runPhantom, app.origin, true);
    await page.locator("#stream").click();
    await expect.poll(async () => (await events(request, runPhantom, session.id)).some(e => e.type === "network.body" && e.data.state === "pending")).toBe(true);
    expect((await events(request, runPhantom, session.id)).some(e => e.type === "network.body" && e.data.state === "complete")).toBe(false);
    app.end();
    await expect.poll(async () => (await events(request, runPhantom, session.id)).some(e => e.type === "network.body" && e.data.state === "complete")).toBe(true);
  } finally { await app.close(); }
});

test("disabled response capture performs no clone or body work and preserves exact output", async ({ page, request, runPhantom }) => {
  const app = await fixture();
  try {
    const session = await pair(page, request, runPhantom, app.origin, false);
    await page.locator("#json").click();
    await expect(page.locator("#output")).toHaveText(app.original);
    await expect.poll(async () => (await events(request, runPhantom, session.id)).some(e => e.type === "network")).toBe(true);
    expect((await events(request, runPhantom, session.id)).some(e => e.type === "network.body")).toBe(false);
    expect(await page.evaluate(() => (window as any).cloneCalls)).toBe(0);
  } finally { await app.close(); }
});

const declared = { kind: "business-response", urlContains: "/business/json", operationId: "order-21", operationPath: "operationId", path: "result", equals: "paid", phase: "response" };
async function check(request: APIRequestContext, daemon: RunPhantomHandle, id: string, predicate: unknown, since = 0) {
  const response = await request.post(`${daemon.url}/api/verification/sessions/${id}/assert`, { data: { predicate, since, name: "Business fixture contract" } });
  expect(response.ok()).toBe(true); return response.json();
}

test("actual response contracts persist healthy, disagreement, accepted202 and final-pending reports", async ({ page, request, runPhantom }) => {
  const app = await fixture();
  app.set({ operationId: "order-21", result: "paid", errors: [] });
  try {
    const session = await pair(page, request, runPhantom, app.origin, true);
    await page.locator("#json").click();
    const healthy = await check(request, runPhantom, session.id, declared, session.cursor);
    expect(healthy.status).toBe("pass");
    expect(healthy.reason).toContain("SDK-reported");
    const disagreement = await check(request, runPhantom, session.id, { ...declared, witness: { kind: "state", store: "business", operationPath: "operationId", path: "result" } }, session.cursor);
    expect(disagreement.status).toBe("fail");
    expect(disagreement.reason).toContain("disagree");
    const final = await check(request, runPhantom, session.id, { ...declared, phase: "final" }, session.cursor);
    expect(final.status).toBe("inconclusive");
    expect(final.reason).toContain("cannot authenticate");
    app.set({ operationId: "order-21", result: "accepted" }, 202);
    const since = (await events(request, runPhantom, session.id)).at(-1)!.t;
    await page.locator("#json").click();
    const accepted = await check(request, runPhantom, session.id, { ...declared, equals: "accepted", phase: "acceptance" }, since);
    expect(accepted.status).toBe("pass");
    expect(accepted.reason).toContain("final persistence is still unverified");
    const reports = await (await request.get(`${runPhantom.url}/api/verification/reports`)).json();
    for (const report of [healthy, disagreement, final, accepted]) expect(reports.find((entry: any) => entry.id === report.id)).toEqual(report);
  } finally { await app.close(); }
});

test("actual response caps and unsupported payloads withhold complete body while preserving app output", async ({ page, request, runPhantom }) => {
  const app = await fixture();
  const huge = JSON.stringify({ password: "synthetic-oversize-secret", operationId: "order-21", result: "paid", note: "x".repeat(40000) });
  app.set(huge);
  try {
    const session = await pair(page, request, runPhantom, app.origin, true);
    await page.locator("#json").click();
    await expect(page.locator("#output")).toHaveText(huge);
    await expect.poll(async () => (await events(request, runPhantom, session.id)).some(e => e.type === "network.body" && e.data.state === "truncated")).toBe(true);
    let all = await events(request, runPhantom, session.id);
    expect(all.filter(e => e.type === "network.body").every(e => !Object.hasOwn(e.data, "body"))).toBe(true);
    expect(JSON.stringify(all)).not.toContain("synthetic-oversize-secret");
    expect(all.filter(e => e.type === "network.body").every(e => e.data.bytes <= 32768 && e.data.chunks <= 128)).toBe(true);
    app.set("binary fixture", 200, "application/octet-stream");
    await page.locator("#json").click();
    await expect(page.locator("#output")).toHaveText("binary fixture");
    await expect.poll(async () => (await events(request, runPhantom, session.id)).some(e => e.type === "network.body" && e.data.state === "unsupported")).toBe(true);
    all = await events(request, runPhantom, session.id);
    expect(all.some(e => e.data.state === "complete")).toBe(false);
  } finally { await app.close(); }
});

test("actual open streams time out honestly without blocking the existing metadata check", async ({ page, request, runPhantom }) => {
  const app = await fixture();
  try {
    const session = await pair(page, request, runPhantom, app.origin, true);
    await page.locator("#stream").click();
    const metadata = await check(request, runPhantom, session.id, { kind: "network", urlContains: "/business/stream", status: 200 }, session.cursor);
    expect(metadata.status).toBe("pass");
    expect((await events(request, runPhantom, session.id)).some(e => e.type === "network.body" && e.data.state === "complete")).toBe(false);
    await expect.poll(async () => (await events(request, runPhantom, session.id)).some(e => e.type === "network.body" && e.data.state === "timeout")).toBe(true);
    const body = await check(request, runPhantom, session.id, { ...declared, urlContains: "/business/stream", operationPath: "0.operationId", path: "0.result" }, session.cursor);
    expect(body.status).toBe("inconclusive");
    expect(JSON.stringify(await events(request, runPhantom, session.id))).not.toContain('"result":"pending"');
  } finally { await app.close(); }
});

test("real chunk boundaries and decoded credential keys redact before any body retention", async ({ page, request, runPhantom }) => {
  const app = await fixture();
  try {
    const session = await pair(page, request, runPhantom, app.origin, true);
    const original = await page.evaluate(async () => (await fetch("/business/secret-stream")).text());
    expect(original).toContain("synthetic-split-key");
    await expect.poll(async () => (await events(request, runPhantom, session.id)).some(e => e.type === "network.body" && e.data.state === "complete")).toBe(true);
    let all = await events(request, runPhantom, session.id);
    const captured = all.find(e => e.type === "network.body" && e.data.state === "complete");
    expect(captured.data.body.apiKey).toBe("[REDACTED]"); expect(captured.data.body.note).toBe("[REDACTED]");
    expect(JSON.stringify(all)).not.toContain("synthetic-split-key"); expect(JSON.stringify(all)).not.toContain("sk_live_abcdefghijklmnopqrstuv");
    app.set({ operationId: "order-21", result: "paid", password: "s".repeat(12000) });
    await page.locator("#json").click();
    await expect.poll(async () => (await events(request, runPhantom, session.id)).filter(e => e.type === "network.body" && e.data.state === "complete").length).toBe(2);
    all = await events(request, runPhantom, session.id);
    const last = all.filter(e => e.type === "network.body" && e.data.state === "complete").at(-1)!;
    expect(last.data.body.password).toBe("[REDACTED]"); expect(last.truncated).toBe(true);
    expect(JSON.stringify(last).length).toBeLessThan(8192);
  } finally { await app.close(); }
});

test("actual aborted, malformed, NDJSON and reader-pressure responses keep independent request identities", async ({ page, request, runPhantom }) => {
  const app = await fixture();
  try {
    const session = await pair(page, request, runPhantom, app.origin, true);
    app.set('{"operationId":', 200);
    await page.locator("#json").click();
    await expect.poll(async () => (await events(request, runPhantom, session.id)).some(e => e.type === "network.body" && e.data.state === "unavailable")).toBe(true);
    app.set('{"operationId":"order-21","result":"pending"}\n{"operationId":"order-21","result":"paid"}\n', 200, "application/x-ndjson");
    await page.locator("#json").click();
    await expect.poll(async () => (await events(request, runPhantom, session.id)).some(e => e.type === "network.body" && e.data.state === "complete")).toBe(true);
    const complete = (await events(request, runPhantom, session.id)).find(e => e.type === "network.body" && e.data.state === "complete");
    expect(complete.data.body).toEqual([{ operationId: "order-21", result: "pending" }, { operationId: "order-21", result: "paid" }]);
    await page.evaluate(async () => { const controller = new AbortController(); await fetch("/business/stream", { signal: controller.signal }); controller.abort(); });
    await expect.poll(async () => (await events(request, runPhantom, session.id)).some(e => e.type === "network.body" && e.data.state === "aborted")).toBe(true);
    await page.evaluate(async () => { await Promise.all(Array.from({ length: 5 }, () => fetch("/business/stream"))); });
    await expect.poll(async () => (await events(request, runPhantom, session.id)).some(e => e.type === "network.body" && e.data.state === "unavailable" && e.data.format === "sse")).toBe(true);
    const pending = (await events(request, runPhantom, session.id)).filter(e => e.type === "network.body" && e.data.state === "pending");
    expect(new Set(pending.map(e => e.data.requestId)).size).toBe(pending.length);
    app.end();
    await expect.poll(async () => (await events(request, runPhantom, session.id)).filter(e => e.type === "network.body" && e.data.state === "complete" && e.data.format === "sse").length).toBe(4);
  } finally { await app.close(); }
});

test("user opts in, diagnoses the actual failed response, replays a healthy contract and inspects safe responsive evidence", async ({ page, context, request, runPhantom }) => {
  const app = await fixture();
  const literal = '<img src="https://example.invalid/foreign.png" onerror="window.injected=true">';
  const failedBody = { operationId: "order-21", result: "rejected", errors: [{ message: "stock unavailable" }], note: literal };
  app.set(failedBody);
  const target = await context.newPage();
  let foreign = 0;
  context.on("request", r => { if (!new URL(r.url()).hostname.match(/^(localhost|127\.0\.0\.1|\[::1\])$/)) foreign++; });
  try {
    await page.goto(`${runPhantom.url}/verification`);
    const optIn = page.getByRole("checkbox", { name: /^Capture response evidence/ });
    await expect(optIn).not.toBeChecked();
    await page.getByLabel(/^App origin/).fill(app.origin);
    await page.getByRole("button", { name: "Pair app", exact: true }).click();
    const setup = page.getByLabel("Application connection snippet", { exact: true });
    await expect(setup).toBeVisible();
    expect(await setup.innerText()).not.toContain("businessResponses");
    await page.getByRole("button", { name: "Dismiss setup", exact: true }).click();
    await optIn.check();
    await page.getByRole("button", { name: "Pair app", exact: true }).click();
    await expect(setup).toContainText("businessResponses: true");
    const source = await setup.innerText();
    const id = /sessionId:\s*"([^"]+)"/.exec(source)?.[1];
    const token = /token:\s*"([^"]+)"/.exec(source)?.[1];
    if (!id || !token) throw new Error("UI connection snippet is incomplete");
    await target.goto(app.origin);
    await target.evaluate(async ({ url, id, token }) => {
      const sdk = await import(`${url}/verification/sdk.js`);
      (window as any).runtime = sdk.connect({ url, sessionId: id, token, businessResponses: true });
      (window as any).runtime.registerStore("business", () => (window as any).businessState);
    }, { url: runPhantom.url, id, token });
    await expect(page.getByText("Connected", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Dismiss setup", exact: true }).click();
    await page.getByRole("combobox", { name: "Action", exact: true }).selectOption("click");
    await page.getByLabel(/^Action selector/).fill("#json");
    await page.getByRole("combobox", { name: "Check type", exact: true }).selectOption("business-response");
    await page.getByLabel("Request URL contains", { exact: true }).fill("/business/json");
    await page.getByLabel("Operation identity", { exact: true }).fill("order-21");
    await page.getByLabel("Response value path", { exact: true }).fill("result");
    await page.getByLabel("Expected value", { exact: true }).fill("paid");
    await page.getByLabel("Check name (optional)", { exact: true }).fill("Order response contract");
    await page.getByRole("button", { name: "Run action", exact: true }).click();
    await expect(target.locator("#output")).toHaveText(JSON.stringify(failedBody));
    const live = page.getByRole("region", { name: "Response evidence", exact: true }).first();
    await expect(live).toContainText("Capture enabled");
    await expect(live).toContainText("Possible business failure");
    await live.getByText("Redacted response body", { exact: true }).click();
    await expect(live.locator("pre")).toContainText(JSON.stringify(literal).slice(1, -1));
    expect(await live.locator("img").count()).toBe(0);
    await page.getByRole("button", { name: "Check outcome", exact: true }).click();
    const failed = page.getByRole("article", { name: "Order response contract: fail", exact: true });
    await expect(failed).toBeVisible({ timeout: 15000 });
    await expect(failed).toContainText("Response contract for order-21");
    await expect(failed).toContainText("Possible business failure");
    const frozen = (await (await request.get(`${runPhantom.url}/api/verification/reports`)).json()).find((r: any) => r.name === "Order response contract" && r.status === "fail");
    app.set({ operationId: "order-21", result: "paid", errors: [] });
    await page.getByRole("button", { name: "Run action", exact: true }).click();
    await page.getByRole("button", { name: "Check outcome", exact: true }).click();
    await expect(page.getByRole("article", { name: "Order response contract: pass", exact: true })).toBeVisible({ timeout: 15000 });
    await page.getByLabel("Include current action in step", { exact: true }).check();
    await page.getByRole("button", { name: "Add step to flow", exact: true }).click();
    await page.getByLabel("Flow name", { exact: true }).fill("Order response replay");
    await page.getByRole("button", { name: "Save flow", exact: true }).click();
    const replay = page.getByRole("button", { name: "Replay Order response replay", exact: true });
    await replay.click();
    await expect(page.getByRole("article", { name: "Order response replay: pass", exact: true })).toBeVisible({ timeout: 15000 });
    const saved = await (await request.get(`${runPhantom.url}/api/verification/reports`)).json();
    expect(saved.find((r: any) => r.id === frozen.id)).toEqual(frozen);
    expect(foreign).toBe(0);
    expect(await target.evaluate(() => Boolean((window as any).injected))).toBe(false);
    const directory = process.env.F21_SCREEN_DIR ?? path.resolve("../output/f21-business");
    mkdirSync(directory, { recursive: true });
    const inspections = [];
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await live.scrollIntoViewIfNeeded();
      await expect(live.getByRole("heading", { name: "Response evidence", exact: true })).toBeVisible();
      const metrics = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth,
        accent: getComputedStyle(document.documentElement).getPropertyValue("--rp-accent").trim(), canvas: getComputedStyle(document.documentElement).getPropertyValue("--rp-canvas").trim(),
        headingFont: getComputedStyle(document.querySelector("h1")!).fontFamily, bodyFont: getComputedStyle(document.body).fontFamily }));
      expect(metrics.scroll).toBeLessThanOrEqual(width);
      expect(metrics.accent.toLowerCase()).toBe("#0021cc");
      expect(metrics.canvas.toLowerCase()).toBe("#f9fafc");
      expect(metrics.headingFont).toContain("Syne");
      expect(metrics.bodyFont).toContain("Inter");
      inspections.push({ width, ...metrics });
      await page.screenshot({ path: path.join(directory, `response-${width}.png`), fullPage: false });
    }
    for (const percent of [150, 200]) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(value => { document.documentElement.style.zoom = `${value}%`; }, percent);
      await live.scrollIntoViewIfNeeded();
      await expect(live.getByRole("heading", { name: "Response evidence", exact: true })).toBeVisible();
      const metrics = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth, zoom: getComputedStyle(document.documentElement).zoom }));
      expect(metrics.scroll).toBeLessThanOrEqual(metrics.viewport);
      inspections.push({ cssZoom: percent, nativeToolbarZoom: false, ...metrics });
      await page.screenshot({ path: path.join(directory, `response-css-${percent}.png`), fullPage: false });
    }
    writeFileSync(path.join(directory, "responsive-inspections.json"), JSON.stringify(inspections, null, 2));
  } finally { await target.close(); await app.close(); }
});

test("EOF cannot authenticate an unterminated SSE data record as complete business evidence", async ({ page, request, runPhantom }) => {
  const app = await fixture();
  try {
    const session = await pair(page, request, runPhantom, app.origin, true);
    expect(await page.evaluate(async () => (await fetch("/business/incomplete-sse")).text())).toBe('data: {"operationId":"order-21","result":"paid"}');
    await expect.poll(async () => (await events(request, runPhantom, session.id)).some(e => e.type === "network.body" && e.data.state !== "pending")).toBe(true);
    const captured = (await events(request, runPhantom, session.id)).filter(e => e.type === "network.body");
    expect(captured.some(e => e.data.state === "complete")).toBe(false);
    expect(captured.at(-1)?.data.state).toBe("unavailable");
    expect(captured.every(e => !Object.hasOwn(e.data, "body"))).toBe(true);
    const report = await check(request, runPhantom, session.id, { ...declared, urlContains: "/business/incomplete-sse", operationPath: "0.operationId", path: "0.result" }, session.cursor);
    expect(report.status).toBe("inconclusive");
  } finally { await app.close(); }
});

test("actual opaque fetch and XHR preserve unavailable boundaries and default-disabled processing", async ({ page, request, runPhantom }) => {
  const app = await fixture();
  const other = await fixture();
  try {
    for (const enabled of [false, true]) {
      const session = await pair(page, request, runPhantom, app.origin, enabled);
      expect(await page.evaluate(async origin => (await fetch(`${origin}/business/json`, { mode: "no-cors" })).type, other.origin)).toBe("opaque");
      const output = await page.evaluate(() => new Promise<string>((resolve, reject) => {
        const xhr = new XMLHttpRequest(); xhr.open("GET", "/business/json");
        xhr.onload = () => resolve(xhr.responseText); xhr.onerror = () => reject(new Error("fixture XHR failed")); xhr.send();
      }));
      expect(output).toBe(app.original);
      await expect.poll(async () => (await events(request, runPhantom, session.id)).filter(e => e.type === "network").length).toBe(2);
      if (enabled) {
        await expect.poll(async () => (await events(request, runPhantom, session.id)).some(e => e.type === "network.body" && e.data.state === "complete")).toBe(true);
        const captured = await events(request, runPhantom, session.id);
        const opaque = captured.find(e => e.type === "network.body" && e.data.state === "opaque");
        expect(opaque).toBeTruthy(); expect(Object.hasOwn(opaque.data, "body")).toBe(false);
        const xhr = captured.find(e => e.type === "network.body" && e.data.state === "complete");
        expect(xhr.data.body.password).toBe("[REDACTED]");
        expect(JSON.stringify(captured)).not.toContain("synthetic-private-21");
        const report = await check(request, runPhantom, session.id, { ...declared, urlContains: other.origin }, session.cursor);
        expect(report.status).toBe("inconclusive");
      } else expect((await events(request, runPhantom, session.id)).some(e => e.type === "network.body")).toBe(false);
      expect(await page.evaluate(() => (window as any).cloneCalls)).toBe(0);
    }
  } finally { await other.close(); await app.close(); }
});
