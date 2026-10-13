import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect, observe } from "./verification-fixture";
import { REPO_ROOT_PATH } from "./fixtures";
import type { Page, APIRequestContext } from "@playwright/test";
import type { RunPhantomHandle } from "./fixtures";
import type { AppCommand, SemanticResult, VerificationFlow, FlowRepairProposal } from "../../src/verification/protocol";

async function pair(page: Page, request: APIRequestContext, daemon: RunPhantomHandle, origin: string, source = true) {
  const response = await request.post(`${daemon.url}/api/verification/sessions`, { data: { origin } }); const session = await response.json();
  await page.route(`${origin}/durable`, route => route.fulfill({ contentType: "text/html", body: readFileSync(path.join(REPO_ROOT_PATH, "app/tests-e2e/fixtures/flow-anchors.html"), "utf8") }));
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
test("actual app review selects, commits, reloads and separately replays a CSS presentation change", async ({ page, context, request, runPhantom, targetApp }, testInfo) => {
  const session = await pair(page, request, runPhantom, targetApp.origin); const flow = await save(request, runPhantom, targetApp.origin);
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
    for (const width of [360, 390, 768, 1024, 1440, 1920]) {
      await ui.setViewportSize({ width, height: 900 }); await review.scrollIntoViewIfNeeded();
      expect(await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const filename = path.join(screenshotRoot, `flow-repair-${width}.png`); await ui.screenshot({ path: filename, fullPage: true }); await testInfo.attach(`Flow repair ${width}`, { path: filename, contentType: "image/png" });
    }
    await review.getByRole("button", { name: "Commit selected repair" }).click(); await expect(review).toContainText("Reviewed repair saved");
    expect(await effects(page)).toEqual({ clicks: 0, focus: 0, inputs: 0 });
    const saved: VerificationFlow[] = await (await request.get(`${runPhantom.url}/api/verification/flows`)).json(); const current = saved.find(item => item.id === flow.id)!;
    expect(current.revision).not.toBe(flow.revision); expect(current.steps[0].command).toEqual(flow.steps[0].command); expect(current.steps[0].predicate).toEqual(flow.steps[0].predicate);
    expect(current.steps[0].anchor).toMatchObject({ kind: "semantic", query: { kind: "test-id", testId: "order-42" }, source: { file: "src/Checkout.tsx", line: 12 } }); expect(JSON.stringify(current)).not.toContain("rpref_");
    await ui.reload(); await expect(ui.getByText("Order review flow", { exact: true })).toBeVisible();
    await page.locator("#current").evaluate(element => { element.id = "presentation-renamed"; element.className = "new-presentation"; });
    await ui.getByRole("button", { name: "Replay Order review flow" }).click(); await expect.poll(async () => (await effects(page)).clicks).toBe(1);
    await expect(ui.getByRole("status").filter({ hasText: "Order review flow: pass" })).toBeVisible();
    expect((await observe(request, runPhantom, session.id)).events.filter(event => event.type === "action.boundary")).toHaveLength(1);
  } finally { await ui.close(); }
});

test("cancel and changed review/list/document identities preserve bytes and dispatch zero actions", async ({ page, request, runPhantom, targetApp }) => {
  const session = await pair(page, request, runPhantom, targetApp.origin); const flow = await save(request, runPhantom, targetApp.origin);
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

test("source capture default OFF and aggregate source count/deadline remain explicit", async ({ page, request, runPhantom, targetApp }) => {
  const disabled = await pair(page, request, runPhantom, targetApp.origin, false);
  let output = await command(request, runPhantom, disabled.id, { type: "semantic-snapshot" }); expect(output.result!.elements.every(item => item.controlSource === undefined)).toBe(true);
  await page.evaluate(() => window.runtime.disconnect());
  const enabled = await pair(page, request, runPhantom, targetApp.origin, true);
  await page.evaluate(() => { for (let i = 0; i < 40; i++) { const button = document.createElement("button"); button.textContent = `Bounded ${i}`; button.setAttribute("data-runphantom-source", `src/Button.tsx:${i + 1}:1`); document.body.append(button); } });
  output = await command(request, runPhantom, enabled.id, { type: "semantic-snapshot" });
  expect(output.result!.elements.filter(item => item.controlSource?.status === "captured").length).toBeLessThanOrEqual(32);
  expect(output.result!.elements.some(item => item.controlSource?.status === "unavailable" && item.controlSource.reason === "probe-limit")).toBe(true);
  expect(await effects(page)).toEqual({ clicks: 0, focus: 0, inputs: 0 });
});

test("a source probe exceeding the aggregate deadline withholds remaining pointers and grants no action", async ({ page, request, runPhantom, targetApp }) => {
  const session = await pair(page, request, runPhantom, targetApp.origin);
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
