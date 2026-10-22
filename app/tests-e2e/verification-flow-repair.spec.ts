import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { test as base, expect, observe } from "./verification-fixture";
import { REPO_ROOT_PATH } from "./fixtures";
import type { Page, APIRequestContext } from "@playwright/test";
import type { RunPhantomHandle } from "./fixtures";
import type { AppCommand, SemanticResult, VerificationFlow, FlowRepairProposal } from "../../src/verification/protocol";

const test = base.extend<{ flowApp: { origin: string } }>({
  flowApp: async ({}, use) => {
    const server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(readFileSync(path.join(REPO_ROOT_PATH, "app/tests-e2e/fixtures/flow-anchors.html"), "utf8")); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try { await use({ origin }); } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  },
});

async function pair(page: Page, request: APIRequestContext, daemon: RunPhantomHandle, origin: string, source = true) {
  const response = await request.post(`${daemon.url}/api/verification/sessions`, { data: { origin } }); const session = await response.json();
  page.on("requestfailed", request => { if (request.url().endsWith("/verification/sdk.js")) console.info(JSON.stringify({ sdkRequestFailure: request.failure()?.errorText })); });
  page.on("console", message => { if (message.type() === "error") console.info(message.text()); });
  const served = await request.get(session.sdkUrl, { headers: { Origin: origin } }); expect(served.status(), "Actual served SDK").toBe(200);
  await page.goto(`${origin}/durable`);
  await page.evaluate(async ({ url, sessionId, token, sdkUrl, source }) => {
    const sdk = await import(sdkUrl); window.runtime = sdk.connect({ url, sessionId, token, ...(source ? { sourceProvenance: { enabled: true } } : {}) });
    const effects = { clicks: 0, focus: 0, inputs: 0 }; Object.assign(window, { flowEffects: effects });
    document.querySelector<HTMLButtonElement>("#current")!.onclick = () => { effects.clicks++; window.runtime.signal("finished"); };
    document.querySelector<HTMLInputElement>("#note")!.onfocus = () => { effects.focus++; };
    document.querySelector<HTMLInputElement>("#note")!.oninput = () => { effects.inputs++; };
  }, { url: daemon.url, sessionId: session.id, token: session.token, sdkUrl: session.sdkUrl, source });
  await expect.poll(async () => (await observe(request, daemon, session.id)).session.connected).toBe(true); return session;
}
async function command(request: APIRequestContext, daemon: RunPhantomHandle, id: string, command: AppCommand): Promise<{ ok: boolean; result?: SemanticResult; error?: string; truncated?: boolean }> {
  const response = await request.post(`${daemon.url}/api/verification/sessions/${id}/command`, { data: command }); expect(response.ok()).toBe(true); return response.json();
}
const effects = (page: Page) => page.evaluate(() => (window as unknown as { flowEffects: { clicks: number; focus: number; inputs: number } }).flowEffects);
async function save(request: APIRequestContext, daemon: RunPhantomHandle, origin: string) {
  const response = await request.post(`${daemon.url}/api/verification/flows`, { data: { name: "Order review flow", origin, steps: [{ command: { type: "click", selector: "#original" }, predicate: { kind: "signal", name: "finished" } }] } }); expect(response.status()).toBe(201); return response.json() as Promise<VerificationFlow>;
}
test("actual app review selects, commits, reloads and separately replays a CSS presentation change", async ({ page, context, request, runPhantom, flowApp }, testInfo) => {
  const session = await pair(page, request, runPhantom, flowApp.origin); const flow = await save(request, runPhantom, flowApp.origin);
  const ui = await context.newPage();
  try {
    await ui.goto(runPhantom.url); await ui.getByRole("link", { name: "Verification", exact: true }).click();
    await ui.getByRole("button", { name: "Review repair for Order review flow" }).click();
    const review = ui.getByRole("region", { name: "Repair Order review flow" });
    await review.getByRole("button", { name: "Propose repair", exact: true }).click();
    await expect(review.getByLabel("Original anchor matches")).toContainText("Old match: 0");
    await expect(review).toContainText("src/Checkout.tsx:12:5");
    await expect(review.getByRole("button", { name: "Commit selected repair" })).toBeDisabled();
    await review.getByRole("radio", { name: "Select Pay 日本語 ✓", exact: true }).check();
    const screenshotRoot = process.env.RUNPHANTOM_PUBLIC_EVIDENCE_DIR ?? path.join(REPO_ROOT_PATH, ".omx/evidence/F22/screenshots"); mkdirSync(screenshotRoot, { recursive: true });
    const viewportProof = [];
    const commitButton = review.getByRole("button", { name: "Commit selected repair" });
    const cancelButton = review.getByRole("button", { name: "Cancel repair" });
    for (const width of [360, 390, 768, 1024, 1440, 1920]) {
      await ui.setViewportSize({ width, height: 900 }); await review.locator(".flow-repair-actions").scrollIntoViewIfNeeded();
      expect(await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const fonts = await ui.evaluate(async () => (await document.fonts.load('700 14px "Syne"')).map(face => ({ family: face.family, status: face.status })));
      expect(fonts.some(face => face.family === "Syne" && face.status === "loaded")).toBe(true);
      const headingFont = await review.getByRole("heading", { name: "Review a durable anchor" }).evaluate(element => getComputedStyle(element).fontFamily);
      expect(headingFont).toContain("Syne");
      const controls = [];
      for (const control of [commitButton, cancelButton]) {
        await expect(control).toBeVisible();
        const observed = await control.evaluate(element => {
          const rect = element.getBoundingClientRect(); const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return { label: element.textContent, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, unobstructed: !!hit && element.contains(hit), inViewport: rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth };
        });
        expect(await control.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
        expect(observed.unobstructed, `${width}: ${observed.label} unobstructed`).toBe(true); expect(observed.inViewport, `${width}: ${observed.label} reachable after scrolling`).toBe(true); controls.push(observed);
      }
      const background = await review.evaluate(element => getComputedStyle(element).backgroundColor); expect(background).toBe("rgb(255, 255, 255)");
      expect(await review.evaluate(element => getComputedStyle(element).color)).toBe("rgb(14, 18, 27)");
      const accent = await commitButton.evaluate(element => getComputedStyle(element).backgroundColor); expect(accent).toBe("rgb(0, 33, 204)");
      viewportProof.push({ width, height: 900, fonts, headingFont, background, accent, controls });
      const filename = path.join(screenshotRoot, `flow-repair-${width}.png`); await ui.screenshot({ path: filename, fullPage: true }); await testInfo.attach(`Flow repair ${width}`, { path: filename, contentType: "image/png" });
    }
    writeFileSync(path.join(screenshotRoot, "browser-layout-proof.json"), JSON.stringify(viewportProof, null, 2));
    await review.getByRole("button", { name: "Commit selected repair" }).click(); await expect(review).toContainText("Reviewed repair saved");
    expect(await effects(page)).toEqual({ clicks: 0, focus: 0, inputs: 0 });
    const saved: VerificationFlow[] = await (await request.get(`${runPhantom.url}/api/verification/flows`)).json(); const current = saved.find(item => item.id === flow.id)!;
    expect(current.revision).not.toBe(flow.revision); expect(current.steps[0].command).toEqual(flow.steps[0].command); expect(current.steps[0].predicate).toEqual(flow.steps[0].predicate);
    expect(current.steps[0].anchor).toMatchObject({ kind: "semantic", query: { kind: "test-id", testId: "order-42" }, source: { file: "src/Checkout.tsx", line: 12 } }); expect(JSON.stringify(current)).not.toContain("rpref_");
    await ui.reload(); await expect(ui.getByText("Order review flow", { exact: true })).toBeVisible();
    await page.locator("#current").evaluate(element => { element.id = "presentation-renamed"; element.setAttribute("class", "new-presentation"); });
    await ui.getByRole("button", { name: "Replay Order review flow" }).click(); await expect.poll(async () => (await effects(page)).clicks).toBe(1);
    await expect(ui.getByRole("status").filter({ hasText: "Order review flow: pass" })).toBeVisible();
    expect((await observe(request, runPhantom, session.id)).events.filter(event => event.type === "action.boundary")).toHaveLength(1);
  } finally { await ui.close(); }
});

test("cancel and changed review/list/document identities preserve bytes and dispatch zero actions", async ({ page, request, runPhantom, flowApp }) => {
  const session = await pair(page, request, runPhantom, flowApp.origin); const flow = await save(request, runPhantom, flowApp.origin);
  const before = JSON.stringify(await (await request.get(`${runPhantom.url}/api/verification/flows`)).json());
  const propose = async () => { const response = await request.post(`${runPhantom.url}/api/verification/flows/${flow.id}/repair-proposals`, { data: { sessionId: session.id, step: 0 } }); expect(response.status()).toBe(201); return response.json() as Promise<FlowRepairProposal>; };
  const canceled = await propose(); await request.delete(`${runPhantom.url}/api/verification/flows/${flow.id}/repair-proposals/${canceled.id}`);
  expect(JSON.stringify(await (await request.get(`${runPhantom.url}/api/verification/flows`)).json())).toBe(before);
  const proposal = await propose(); const selected = proposal.candidates.find(item => item.anchor.instance.testId === "order-42")!;
  await page.locator("#current").evaluate(element => { element.setAttribute("data-runphantom-source", "src/Other.tsx:12:5"); });
  const commit = await request.post(`${runPhantom.url}/api/verification/flows/${flow.id}/repair-proposals/${proposal.id}/commit`, { data: { candidateId: selected.id, revision: proposal.revision } }); expect(commit.status()).toBe(409);
  const found = await command(request, runPhantom, session.id, { type: "find", query: { kind: "test-id", testId: "order-42" } });
  await page.locator("#current").evaluate(element => { const clone = element.cloneNode(true); element.after(clone); });
  expect((await command(request, runPhantom, session.id, { type: "ref-click", ref: found.result!.ref! })).ok).toBe(false);
  const fresh = await command(request, runPhantom, session.id, { type: "find", query: { kind: "test-id", testId: "note-42" } });
  await page.locator("#note").evaluate(element => { element.setAttribute("aria-label", "Changed label"); });
  expect((await command(request, runPhantom, session.id, { type: "ref-fill", ref: fresh.result!.ref!, value: "must-not-land" })).ok).toBe(false);
  expect(await effects(page)).toEqual({ clicks: 0, focus: 0, inputs: 0 }); expect((await observe(request, runPhantom, session.id)).events.filter(event => event.type === "action.boundary")).toHaveLength(0);
  expect(JSON.stringify(await (await request.get(`${runPhantom.url}/api/verification/flows`)).json())).toBe(before);
});

test("source capture default OFF and aggregate source count/deadline remain explicit", async ({ page, request, runPhantom, flowApp }) => {
  const disabled = await pair(page, request, runPhantom, flowApp.origin, false);
  let output = await command(request, runPhantom, disabled.id, { type: "semantic-snapshot" }); expect(output.result!.elements.every(item => item.controlSource === undefined)).toBe(true);
  await page.evaluate(() => window.runtime.disconnect());
  const enabled = await pair(page, request, runPhantom, flowApp.origin, true);
  await page.evaluate(() => { for (let i = 0; i < 40; i++) { const button = document.createElement("button"); button.textContent = `Bounded ${i}`; button.setAttribute("data-runphantom-source", `src/Button.tsx:${i + 1}:1`); document.body.append(button); } });
  output = await command(request, runPhantom, enabled.id, { type: "semantic-snapshot" });
  expect(output.result!.elements.filter(item => item.controlSource?.status === "captured").length).toBeLessThanOrEqual(16);
  expect(output.result!.elements.some(item => item.controlSource?.status === "unavailable" && item.controlSource.reason === "probe-limit")).toBe(true);
  expect(await effects(page)).toEqual({ clicks: 0, focus: 0, inputs: 0 });
});

test("a source probe exceeding the aggregate deadline withholds remaining pointers and grants no action", async ({ page, request, runPhantom, flowApp }) => {
  const session = await pair(page, request, runPhantom, flowApp.origin);
  await page.evaluate(() => {
    const button = document.querySelector("#current")!;
    Object.defineProperty(button, "__reactFiber$deadline", { value: new Proxy({}, { getOwnPropertyDescriptor(_target, key) {
      const end = performance.now() + 12; while (performance.now() < end) { /* Controlled fixture work. */ }
      return { configurable: true, enumerable: true, writable: false, value: key === "return" ? null : undefined };
    } }) });
    document.querySelector("#other")!.setAttribute("data-runphantom-source", "src/Other.tsx:5:1");
  });
  const output = await command(request, runPhantom, session.id, { type: "semantic-snapshot" });
  expect(output.result!.elements.find(item => item.testId === "order-43")!.controlSource).toMatchObject({ status: "unavailable", reason: "probe-limit" });
  expect(await effects(page)).toEqual({ clicks: 0, focus: 0, inputs: 0 });
});


for (const mode of ["changed", "throwing", "mutating"] as const) test(`${mode} source probe stops before click, focus, fill and boundary`, async ({ page, request, runPhantom, flowApp }) => {
    const session = await pair(page, request, runPhantom, flowApp.origin);
    for (const fill of [false, true]) {
      const testId = fill ? "note-42" : "order-42";
      const target = fill ? "#note" : "#current";
      await page.locator(target).evaluate(element => element.setAttribute("data-runphantom-source", "src/Checkout.tsx:12:5"));
      const found = await command(request, runPhantom, session.id, { type: "find", query: { kind: "test-id", testId } });
      expect(found.result?.status).toBe("unique");
      await page.locator(target).evaluate((element, mode) => {
        if (mode === "changed") { element.setAttribute("data-runphantom-source", "src/Changed.tsx:12:5"); return; }
        const stateNode: { current?: object } = {};
        const fiber = new Proxy({ return: null, stateNode }, { getOwnPropertyDescriptor(value, key) {
          if (mode === "throwing") throw new Error("controlled source reflection failure");
          if (key === "return") element.setAttribute("aria-label", "Changed by source probe");
          return Object.getOwnPropertyDescriptor(value, key);
        } });
        stateNode.current = fiber;
        Object.defineProperty(element, "__reactFiber$safety", { configurable: true, value: fiber });
      }, mode);
      const output = await command(request, runPhantom, session.id, fill ? { type: "ref-fill", ref: found.result!.ref!, value: "must-not-land" } : { type: "ref-click", ref: found.result!.ref! });
      expect(output.ok, `${mode} source, ${fill ? "fill" : "click"}`).toBe(false);
      expect(await effects(page)).toEqual({ clicks: 0, focus: 0, inputs: 0 });
      await page.locator(target).evaluate(element => { Reflect.deleteProperty(element, "__reactFiber$safety"); element.removeAttribute("aria-label"); });
    }
    expect((await observe(request, runPhantom, session.id)).events.filter(event => event.type === "action.boundary")).toHaveLength(0);
    await page.evaluate(() => window.runtime.disconnect());
});

test("repair reply held across disconnect and reconnect cannot restore an obsolete proposal", async ({ page, context, request, runPhantom, flowApp }) => {
  const session = await pair(page, request, runPhantom, flowApp.origin);
  const flow = await save(request, runPhantom, flowApp.origin);
  const ui = await context.newPage();
  const pattern = `**/api/verification/flows/${flow.id}/repair-proposals`;
  let release!: () => void, admitted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { admitted = resolve; });
  const pending = new Set<Promise<void>>();
  const handler = (route: import("@playwright/test").Route) => {
    const work = (async () => {
      const response = await route.fetch(); expect(response.status()).toBe(201); admitted();
      await gate; await route.fulfill({ response });
    })();
    pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
  };
  try {
    await ui.goto(`${runPhantom.url}/verification?section=flows`);
    await ui.getByRole("button", { name: "Review repair for Order review flow", exact: true }).click();
    const review = ui.getByRole("region", { name: "Repair Order review flow", exact: true });
    await ui.route(pattern, handler);
    await review.getByRole("button", { name: "Propose repair", exact: true }).click(); await ready;
    await page.evaluate(() => window.runtime.disconnect());
    await expect(ui.getByText("Disconnected", { exact: true })).toBeVisible();
    await page.evaluate(async ({ url, sdkUrl, id, token }) => {
      const sdk = await import(sdkUrl); window.runtime = sdk.connect({ url, sessionId: id, token, sourceProvenance: { enabled: true } });
    }, { url: runPhantom.url, sdkUrl: session.sdkUrl, id: session.id, token: session.token });
    await expect(review.getByRole("button", { name: "Propose repair", exact: true })).toBeEnabled();
    const delivered = ui.waitForResponse(response => response.url().endsWith(`/flows/${flow.id}/repair-proposals`));
    release(); await delivered; await Promise.all(pending);
    await ui.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect(review.getByLabel("Original anchor", { exact: true })).toHaveCount(0);
    await ui.unroute(pattern, handler);
    await review.getByRole("button", { name: "Propose repair", exact: true }).click();
    await expect(review.getByLabel("Original anchor", { exact: true })).toBeVisible();
    expect(await effects(page)).toEqual({ clicks: 0, focus: 0, inputs: 0 });
    const saved: VerificationFlow[] = await (await request.get(`${runPhantom.url}/api/verification/flows`)).json();
    expect(saved.find(item => item.id === flow.id)?.revision).toBe(flow.revision);
  } finally {
    release(); await Promise.allSettled(pending); await ui.unroute(pattern, handler); await ui.close();
  }
});
