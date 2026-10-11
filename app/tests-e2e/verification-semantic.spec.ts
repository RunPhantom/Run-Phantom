import { mkdirSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, observe } from "./verification-fixture";
import { REPO_ROOT_PATH, type RunPhantomHandle } from "./fixtures";
import type { AppCommand, SemanticQuery, SemanticResult, SessionSummary } from "../../src/verification/protocol";

type Reply = { ok: boolean; cursor: number; result?: SemanticResult & { acknowledged?: boolean }; error?: string; truncated?: boolean; unavailable?: boolean };
async function command(request: APIRequestContext, daemon: RunPhantomHandle, sessionId: string, data: AppCommand): Promise<Reply> {
  const response = await request.post(`${daemon.url}/api/verification/sessions/${sessionId}/command`, { data });
  expect(response.ok(), `HTTP ${data.type} accepts its closed command`).toBe(true);
  return response.json() as Promise<Reply>;
}
async function find(request: APIRequestContext, daemon: RunPhantomHandle, sessionId: string, query: SemanticQuery): Promise<SemanticResult> {
  const response = await command(request, daemon, sessionId, { type: "find", query });
  expect(response.ok).toBe(true);
  expect(response.result?.source).toBe("sdk-reported");
  expect(response.result?.nameModel).toBe("partial-aria");
  return response.result!;
}
async function pair(page: Page, request: APIRequestContext, daemon: RunPhantomHandle, origin: string, semanticRefs = true) {
  const response = await request.post(`${daemon.url}/api/verification/sessions`, { data: { origin } });
  expect(response.ok()).toBe(true);
  const paired = await response.json() as SessionSummary & { token: string; sdkUrl: string };
  await page.goto(origin);
  await page.evaluate(async ({ url, id, token, sdkUrl, semanticRefs }) => {
    const sdk = await import(sdkUrl);
    window.runtime = sdk.connect({ url, sessionId: id, token, semanticRefs });
    window.runtime.registerStore("checkout", () => window.checkoutState);
  }, { url: daemon.url, id: paired.id, token: paired.token, sdkUrl: new URL(paired.sdkUrl, daemon.url).href, semanticRefs });
  await expect.poll(async () => (await observe(request, daemon, paired.id)).session.connected).toBe(true);
  return paired;
}
async function controls(page: Page) {
  await page.evaluate(() => {
    document.body.innerHTML = `<h1>Semantic fixture</h1>
      <label id="recipient-label" for="recipient">Café 東京</label><input id="recipient" data-testid="受信者" aria-label="Café 東京">
      <button id="commit" data-testid="確定" aria-label="Café 東京 ✓">Commit</button>
      <span id="linked-label">Résumé Δ</span><button id="linked" aria-labelledby="linked-label">Linked</button>
      <button id="titled" title="Title Ω"></button><input id="placeholder" placeholder="Search λ">
      <img id="portrait" alt="Portrait ε" width="32" height="32">
      <button id="save">Save</button><button id="save-as">Save as</button>
      <button id="disabled" disabled>Disabled action</button><input id="readonly" aria-label="Readonly field" readonly>
      <div id="shadow-host"></div><iframe id="child" title="Child fixture" srcdoc='<label>Frame input<input id="frame-input"></label><button id="frame-button">Frame τ</button>'></iframe>
      <div hidden><button>Hidden proof sentinel</button><span id="hidden-name">Hidden label sentinel</span></div>
      <button id="hidden-linked" aria-labelledby="hidden-name"></button>
      <div data-runphantom-private><button>Private subtree sentinel</button></div>
      <textarea id="private-value" aria-label="Text entry">Form value sentinel</textarea>
      <div id="closed-host"></div><div id="result"></div>`;
    const state = { clicks: 0, inputs: 0, focus: 0 };
    Object.assign(window, { semanticEffects: state });
    document.querySelector<HTMLButtonElement>("#commit")!.onclick = () => { state.clicks++; document.querySelector("#result")!.textContent = `Committed ${state.clicks}`; };
    document.querySelector<HTMLInputElement>("#recipient")!.oninput = () => { state.inputs++; };
    document.querySelector<HTMLInputElement>("#recipient")!.onfocus = () => { state.focus++; };
    const shadow = document.querySelector("#shadow-host")!.attachShadow({ mode: "open" });
    shadow.innerHTML = '<button id="shadow-button">Shadow ν</button><label>Shadow input<input id="shadow-input"></label>';
    document.querySelector("#closed-host")!.attachShadow({ mode: "closed" }).innerHTML = '<button>Closed root sentinel</button>';
    const script = document.createElement("script"); script.type = "application/json"; script.textContent = '"Script proof sentinel"'; document.body.append(script);
    const template = document.createElement("template"); template.innerHTML = '<button>Template proof sentinel</button>'; document.body.append(template);
  });
  await expect(page.frameLocator("#child").getByRole("button", { name: "Frame τ" })).toBeVisible();
}
async function effects(page: Page) { return page.evaluate(() => (window as unknown as { semanticEffects: { clicks: number; inputs: number; focus: number } }).semanticEffects); }

test.describe("semantic discovery through actual SDK user actions", () => {
  test("role, name, label and test-id Unicode names resolve the same exact element", async ({ page, request, runPhantom, targetApp }) => {
    const session = await pair(page, request, runPhantom, targetApp.origin); await controls(page);
    const queries: SemanticQuery[] = [{ kind: "role", role: "button", name: "Café\u00a0東京 ✓" }, { kind: "name", name: "Café 東京 ✓" }, { kind: "test-id", testId: "確定" }];
    let sameRef = "";
    for (const query of queries) {
      const result = await find(request, runPhantom, session.id, query);
      expect(result.status).toBe("unique"); expect(result.coverage.complete).toBe(true); expect(result.elements[0].name).toBe("Café 東京 ✓");
      if (sameRef) expect(result.ref).toBe(sameRef); else sameRef = result.ref!;
      expect(result.query).toMatchObject({ ...query, ...(query.kind === "test-id" ? {} : { exact: true }), ...(query.kind === "role" || query.kind === "name" ? { name: "Café 東京 ✓" } : {}) });
    }
    const clicked = await command(request, runPhantom, session.id, { type: "ref-click", ref: sameRef });
    expect(clicked.ok).toBe(true); expect(clicked.result).toEqual({ acknowledged: true, source: "sdk-reported" });
    await expect(page.getByText("Committed 1", { exact: true })).toBeVisible();
    const byLabel = await find(request, runPhantom, session.id, { kind: "label", label: "Café 東京" });
    const byId = await find(request, runPhantom, session.id, { kind: "test-id", testId: "受信者" });
    expect(byLabel.status).toBe("unique"); expect(byLabel.ref).toBe(byId.ref);
    const filled = await command(request, runPhantom, session.id, { type: "ref-fill", ref: byLabel.ref!, value: "semantic-live-private-entry" });
    expect(filled.ok).toBe(true); await expect(page.locator("#recipient")).toHaveValue("semantic-live-private-entry");
    expect(await effects(page)).toEqual({ clicks: 1, inputs: 1, focus: 1 });
    for (const name of ["Résumé Δ", "Title Ω", "Search λ", "Portrait ε"]) expect((await find(request, runPhantom, session.id, { kind: "name", name })).status).toBe("unique");
    const events = await observe(request, runPhantom, session.id);
    expect(events.events.filter(event => event.type === "action.boundary")).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("semantic-live-private-entry");
  });

  test("open shadow and same-origin frame actions use the target's actual realm", async ({ page, request, runPhantom, targetApp }) => {
    const session = await pair(page, request, runPhantom, targetApp.origin); await controls(page);
    await page.evaluate(() => {
      const shadow = document.querySelector("#shadow-host")!.shadowRoot!;
      shadow.querySelector<HTMLButtonElement>("button")!.onclick = () => { shadow.querySelector("button")!.textContent = "Shadow clicked"; };
      const child = document.querySelector<HTMLIFrameElement>("#child")!.contentDocument!;
      child.querySelector<HTMLButtonElement>("button")!.onclick = () => { child.querySelector("button")!.textContent = "Frame clicked"; };
    });
    for (const [name, changed] of [["Shadow ν", "Shadow clicked"], ["Frame τ", "Frame clicked"]]) {
      const result = await find(request, runPhantom, session.id, { kind: "role", role: "button", name });
      expect(result.status).toBe("unique"); expect(result.coverage.openShadowRoots).toBe(1); expect(result.coverage.sameOriginFrames).toBe(1);
      expect((await command(request, runPhantom, session.id, { type: "ref-click", ref: result.ref! })).ok).toBe(true);
      await expect(changed.startsWith("Shadow") ? page.getByRole("button", { name: changed }) : page.frameLocator("#child").getByRole("button", { name: changed })).toBeVisible();
    }
    for (const [label, selector] of [["Shadow input", "#shadow-input"], ["Frame input", "#frame-input"]]) {
      const result = await find(request, runPhantom, session.id, { kind: "label", label }); expect(result.status).toBe("unique");
      expect((await command(request, runPhantom, session.id, { type: "ref-fill", ref: result.ref!, value: `owner-realm-${label}` })).ok).toBe(true);
      const value = await page.evaluate(selector => {
        const owner = selector === "#shadow-input" ? document.querySelector("#shadow-host")!.shadowRoot! : document.querySelector<HTMLIFrameElement>("#child")!.contentDocument!;
        return owner.querySelector<HTMLInputElement>(selector)!.value;
      }, selector);
      expect(value).toBe(`owner-realm-${label}`);
    }
  });

  test("ambiguous literals and invisible/private text never select a causal-looking target", async ({ page, request, runPhantom, targetApp }) => {
    const session = await pair(page, request, runPhantom, targetApp.origin); await controls(page);
    const partial = await find(request, runPhantom, session.id, { kind: "name", name: "Save", exact: false });
    expect(partial.status).toBe("ambiguous"); expect(partial.count).toBe(2); expect(partial.ref).toBeUndefined();
    expect((await find(request, runPhantom, session.id, { kind: "name", name: ".*", exact: false })).status).toBe("not-found");
    for (const name of ["Hidden proof sentinel", "Hidden label sentinel", "Private subtree sentinel", "Script proof sentinel", "Template proof sentinel", "Form value sentinel", "Closed root sentinel"]) {
      const result = await find(request, runPhantom, session.id, { kind: "name", name }); expect(result.count).toBe(0); expect(result.ref).toBeUndefined();
      expect(result.coverage.closedShadowRoots).toBe("unobservable");
    }
    const snapshot = await command(request, runPhantom, session.id, { type: "semantic-snapshot" });
    const wire = JSON.stringify(snapshot);
    for (const secret of ["Hidden proof sentinel", "Hidden label sentinel", "Private subtree sentinel", "Script proof sentinel", "Template proof sentinel", "Form value sentinel", "Closed root sentinel"]) expect(wire).not.toContain(secret);
    expect(await effects(page)).toEqual({ clicks: 0, inputs: 0, focus: 0 });
    expect((await observe(request, runPhantom, session.id)).events.filter(event => event.type === "action.boundary")).toHaveLength(0);
  });

  test("detached, hidden, disabled, readonly and foreign references cause zero focus or mutations", async ({ page, context, request, runPhantom, targetApp }) => {
    const session = await pair(page, request, runPhantom, targetApp.origin); await controls(page);
    const found = await find(request, runPhantom, session.id, { kind: "test-id", testId: "受信者" });
    await page.evaluate(() => { const original = document.querySelector("#recipient")!; const replacement = original.cloneNode(true); Object.assign(window, { detachedRecipient: original }); original.replaceWith(replacement); });
    const stale = await command(request, runPhantom, session.id, { type: "ref-fill", ref: found.ref!, value: "must-not-land" });
    expect(stale.ok).toBe(false); expect(stale.error).toContain("stale"); await expect(page.locator("#recipient")).toHaveValue("");
    await page.evaluate(() => { document.querySelector("#recipient")!.replaceWith((window as unknown as { detachedRecipient: Element }).detachedRecipient); });
    const rediscovered = await find(request, runPhantom, session.id, { kind: "test-id", testId: "受信者" });
    expect(rediscovered.ref).not.toBe(found.ref);
    expect((await command(request, runPhantom, session.id, { type: "ref-fill", ref: found.ref!, value: "must-not-land" })).ok).toBe(false);
    for (const [name, mutation] of [["Disabled action", "click"], ["Readonly field", "fill"]]) {
      const result = await find(request, runPhantom, session.id, { kind: "name", name });
      const refused = await command(request, runPhantom, session.id, mutation === "click" ? { type: "ref-click", ref: result.ref! } : { type: "ref-fill", ref: result.ref!, value: "must-not-land" });
      expect(refused.ok).toBe(false); expect(refused.error).toMatch(/disabled|readonly/);
    }
    const hidden = await find(request, runPhantom, session.id, { kind: "name", name: "Café 東京 ✓" });
    await page.locator("#commit").evaluate(element => { (element as HTMLElement).style.display = "none"; });
    expect((await command(request, runPhantom, session.id, { type: "ref-click", ref: hidden.ref! })).ok).toBe(false);
    const other = await context.newPage();
    try {
      const foreign = await pair(other, request, runPhantom, targetApp.origin); await controls(other);
      const refused = await command(request, runPhantom, foreign.id, { type: "ref-fill", ref: found.ref!, value: "must-not-land" }); expect(refused.ok).toBe(false);
      await expect(other.locator("#recipient")).toHaveValue(""); expect(await effects(other)).toEqual({ clicks: 0, inputs: 0, focus: 0 });
      expect((await observe(request, runPhantom, foreign.id)).events.filter(event => event.type === "action.boundary")).toHaveLength(0);
    } finally { await other.close(); }
    expect(await effects(page)).toEqual({ clicks: 0, inputs: 0, focus: 0 });
    expect((await observe(request, runPhantom, session.id)).events.filter(event => event.type === "action.boundary")).toHaveLength(0);
  });

  test("frame replacement, expiry and full reload never revive an old handle", async ({ page, request, runPhantom, targetApp }) => {
    await page.clock.install();
    const session = await pair(page, request, runPhantom, targetApp.origin); await controls(page);
    const frame = await find(request, runPhantom, session.id, { kind: "name", name: "Frame τ" });
    await page.locator("#child").evaluate(element => { (element as HTMLIFrameElement).srcdoc = '<button>Frame replacement</button>'; });
    await expect(page.frameLocator("#child").getByRole("button", { name: "Frame replacement" })).toBeVisible();
    const changed = await command(request, runPhantom, session.id, { type: "ref-click", ref: frame.ref! }); expect(changed.ok).toBe(false);
    const old = await find(request, runPhantom, session.id, { kind: "test-id", testId: "確定" });
    await page.clock.fastForward(60_001);
    const expired = await command(request, runPhantom, session.id, { type: "ref-click", ref: old.ref! }); expect(expired.ok).toBe(false); expect(expired.error).toContain("expired");
    const newer = await find(request, runPhantom, session.id, { kind: "test-id", testId: "確定" }); expect(newer.ref).not.toBe(old.ref);
    expect((await command(request, runPhantom, session.id, { type: "ref-click", ref: old.ref! })).ok).toBe(false);
    expect(await effects(page)).toEqual({ clicks: 0, inputs: 0, focus: 0 });
    await page.reload();
    await expect.poll(async () => (await observe(request, runPhantom, session.id)).session.connected).toBe(false);
    expect((await command(request, runPhantom, session.id, { type: "ref-click", ref: newer.ref! })).ok).toBe(false);
  });

  test("no capability refuses before dispatch and ephemeral references refuse before saved rows", async ({ page, context, request, runPhantom, targetApp }, testInfo) => {
    const session = await pair(page, request, runPhantom, targetApp.origin, false); await controls(page);
    for (const data of [{ type: "find", query: { kind: "name", name: "Café 東京 ✓" } }, { type: "semantic-snapshot" }, { type: "ref-click", ref: `rpref_${"a".repeat(32)}` }, { type: "ref-fill", ref: `rpref_${"a".repeat(32)}`, value: "must-not-land" }] as AppCommand[]) {
      const refused = await command(request, runPhantom, session.id, data); expect(refused.ok).toBe(false); expect(refused.error).toContain("no action was executed");
    }
    expect(await effects(page)).toEqual({ clicks: 0, inputs: 0, focus: 0 });
    expect((await observe(request, runPhantom, session.id)).events.filter(event => event.type === "action.boundary")).toHaveLength(0);
    const before = await (await request.get(`${runPhantom.url}/api/verification/flows`)).json();
    const rejected = await request.post(`${runPhantom.url}/api/verification/flows`, { data: { name: "Cannot save ephemeral identity", origin: targetApp.origin, steps: [{ command: { type: "ref-click", ref: `rpref_${"a".repeat(32)}` }, predicate: { kind: "signal", name: "done" } }] } });
    expect(rejected.status()).toBe(400); expect(await rejected.text()).toContain("cannot be saved");
    expect(await (await request.get(`${runPhantom.url}/api/verification/flows`)).json()).toEqual(before);
    const ui = await context.newPage();
    try {
      await ui.goto(`${runPhantom.url}/verification`);
      const inspector = ui.getByRole("region", { name: "Find a live element", exact: true });
      await expect(inspector).toContainText("This runtime has no semantic reference capability");
      await expect(inspector.getByRole("button", { name: "Find element", exact: true })).toBeDisabled();
      const screenshotRoot = process.env.RUNPHANTOM_PUBLIC_EVIDENCE_DIR;
      if (screenshotRoot) { await inspector.scrollIntoViewIfNeeded(); const filename = path.join(screenshotRoot, "semantic-capability-refusal.png"); await ui.screenshot({ path: filename, fullPage: true }); await testInfo.attach("Semantic capability refusal", { path: filename, contentType: "image/png" }); }
    } finally { await ui.close(); }
  });

  test("work, output and inaccessible-root limits retain explicit coverage and no unique choice", async ({ page, request, runPhantom, targetApp }) => {
    const session = await pair(page, request, runPhantom, targetApp.origin); await controls(page);
    await page.evaluate(() => {
      const extra = document.createElement("div"); extra.id = "budget";
      for (let index = 0; index < 10_100; index++) { const child = document.createElement("span"); child.textContent = `node ${index}`; extra.append(child); }
      document.body.append(extra);
    });
    const bounded = await find(request, runPhantom, session.id, { kind: "test-id", testId: "確定" });
    expect(bounded.coverage.visitedNodes).toBe(10_000); expect(bounded.coverage.reasons).toContain("node-limit"); expect(bounded.status).toBe("inconclusive"); expect(bounded.ref).toBeUndefined();
    await page.locator("#budget").evaluate(element => element.remove());
    await page.evaluate(() => {
      let current = document.createElement("div"); current.id = "depth-budget"; document.body.append(current);
      for (let depth = 0; depth < 70; depth++) { const child = document.createElement("div"); current.append(child); current = child; }
      const button = document.createElement("button"); button.textContent = "Too deep"; current.append(button);
    });
    const deep = await find(request, runPhantom, session.id, { kind: "name", name: "Café 東京 ✓" }); expect(deep.coverage.reasons).toContain("depth-limit"); expect(deep.ref).toBeUndefined();
    await page.locator("#depth-budget").evaluate(element => element.remove());
    await page.evaluate(() => {
      const output = document.createElement("div"); output.id = "summaries";
      for (let index = 0; index < 110; index++) { const button = document.createElement("button"); button.textContent = `Output ${index} ${"x".repeat(200)}`; output.append(button); }
      document.body.append(output);
    });
    const summaries = await command(request, runPhantom, session.id, { type: "semantic-snapshot" });
    expect(summaries.result?.coverage.complete).toBe(false); expect(summaries.result?.coverage.reasons).toContain("summary-limit");
    expect(summaries.result!.elements.length).toBeLessThanOrEqual(100); expect(new TextEncoder().encode(JSON.stringify(summaries.result)).byteLength).toBeLessThanOrEqual(32768);
    expect(summaries.result?.coverage.reasons.some(reason => ["output-byte-limit", "transport-budget-limit"].includes(reason))).toBe(true);
    await page.locator("#summaries").evaluate(element => element.remove());
    await page.evaluate(() => { const frame = document.createElement("iframe"); frame.id = "inaccessible"; frame.setAttribute("sandbox", ""); frame.srcdoc = "<button>Opaque origin sentinel</button>"; document.body.append(frame); });
    await expect(page.frameLocator("#inaccessible").getByRole("button", { name: "Opaque origin sentinel" })).toBeVisible();
    const inaccessible = await find(request, runPhantom, session.id, { kind: "name", name: "Café 東京 ✓" });
    expect(inaccessible.coverage.inaccessibleFrames).toBe(1); expect(inaccessible.coverage.reasons).toContain("inaccessible-frame"); expect(inaccessible.ref).toBeUndefined();
    expect(JSON.stringify(inaccessible)).not.toContain("Opaque origin sentinel"); expect(await effects(page)).toEqual({ clicks: 0, inputs: 0, focus: 0 });
  });

  test("the actual UI discovers, fills, clicks and clears the old session's selection", async ({ page, context, request, runPhantom, targetApp }, testInfo) => {
    const app = await context.newPage();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    try {
      const session = await pair(app, request, runPhantom, targetApp.origin); await controls(app);
      await page.goto(`${runPhantom.url}/verification`);
      const inspector = page.getByRole("region", { name: "Find a live element", exact: true });
      await expect(inspector).toBeVisible(); await inspector.getByLabel(/^Element name/).fill("Café 東京 ✓");
      await inspector.getByRole("button", { name: "Find element", exact: true }).focus(); await inspector.getByRole("button", { name: "Find element", exact: true }).press("Enter");
      await expect(inspector.getByText("Selected: Café 東京 ✓", { exact: true })).toBeVisible();
      await expect(inspector.getByLabel("Normalized semantic query")).toContainText("Café 東京 ✓");
      const screenshotRoot = process.env.RUNPHANTOM_PUBLIC_EVIDENCE_DIR;
      if (screenshotRoot) { mkdirSync(screenshotRoot, { recursive: true }); const filename = path.join(screenshotRoot, "semantic-inspector-desktop.png"); await inspector.getByText("Selected: Café 東京 ✓", { exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: filename, fullPage: true }); await testInfo.attach("Semantic inspector desktop", { path: filename, contentType: "image/png" }); }
      await inspector.getByRole("button", { name: "Click selected element", exact: true }).click(); await expect(app.getByText("Committed 1", { exact: true })).toBeVisible();
      await inspector.getByRole("combobox", { name: "Find by", exact: true }).selectOption("name"); await inspector.getByLabel(/^Element name/).fill("Save"); await inspector.getByLabel("Exact text match", { exact: true }).uncheck();
      await inspector.getByRole("button", { name: "Find element", exact: true }).click(); await expect(inspector).toContainText("Multiple matches. Use a more precise query before acting."); await expect(inspector.getByText(/^Selected:/)).toHaveCount(0);
      expect((await effects(app)).clicks).toBe(1);
      if (screenshotRoot) { const filename = path.join(screenshotRoot, "semantic-ambiguous-refusal.png"); await inspector.getByText("Multiple matches. Use a more precise query before acting.", { exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: filename, fullPage: true }); await testInfo.attach("Semantic ambiguity refusal", { path: filename, contentType: "image/png" }); }
      await inspector.getByLabel("Exact text match", { exact: true }).check();
      await inspector.getByRole("combobox", { name: "Find by", exact: true }).selectOption("label"); await inspector.getByLabel(/^Element label/).fill("Café 東京");
      await inspector.getByRole("button", { name: "Find element", exact: true }).click(); await expect(inspector.getByText("Selected: Café 東京", { exact: true })).toBeVisible();
      await inspector.getByLabel(/^Live element fill value/).fill("ui-private-live-value"); await inspector.getByRole("button", { name: "Fill selected element", exact: true }).click();
      await expect(app.locator("#recipient")).toHaveValue("ui-private-live-value"); await expect(inspector.getByLabel(/^Live element fill value/)).toHaveCount(0);
      await inspector.getByRole("button", { name: "Find element", exact: true }).click(); await expect(inspector.getByText("Selected: Café 東京", { exact: true })).toBeVisible();
      const disconnected = await request.post(`${runPhantom.url}/api/verification/sessions`, { data: { origin: targetApp.origin } }); const other = await disconnected.json() as SessionSummary;
      await expect(page.getByRole("combobox", { name: "Active session", exact: true }).locator("option")).toHaveCount(2);
      await page.getByRole("combobox", { name: "Active session", exact: true }).selectOption(other.id);
      await expect(inspector.getByText(/^Selected:/)).toHaveCount(0); await expect(inspector.getByRole("button", { name: "Find element", exact: true })).toBeDisabled();
      await page.getByRole("combobox", { name: "Active session", exact: true }).selectOption(session.id);
      await expect(inspector.getByText(/^Selected:/)).toHaveCount(0);
      await page.setViewportSize({ width: 390, height: 844 });
      await inspector.getByRole("button", { name: "Find element", exact: true }).click(); await expect(inspector.getByText("Selected: Café 東京", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (screenshotRoot) { const filename = path.join(screenshotRoot, "semantic-inspector-mobile.png"); await page.screenshot({ path: filename, fullPage: true }); await testInfo.attach("Semantic inspector mobile", { path: filename, contentType: "image/png" }); }
      await inspector.getByLabel(/^Live element fill value/).fill("mobile-private-live-value");
      await inspector.getByRole("button", { name: "Fill selected element", exact: true }).click(); await expect(app.locator("#recipient")).toHaveValue("mobile-private-live-value");
      expect(errors).toEqual([]);
    } finally { await app.close(); }
  });

  test("stdio MCP returns actual discovery, refuses ambiguity and mutates only the exact returned ref", async ({ page, request, runPhantom, targetApp }) => {
    const session = await pair(page, request, runPhantom, targetApp.origin); await controls(page);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("RUNPHANTOM_") && key !== "ANTHROPIC_API_KEY" && key !== "OPENAI_API_KEY")) as Record<string, string>;
    const transport = new StdioClientTransport({ command: "bun", args: ["src/index.ts", "mcp"], cwd: REPO_ROOT_PATH, env: { ...env, RUNPHANTOM_URL: runPhantom.url, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" } });
    const client = new Client({ name: "semantic-browser-user", version: "1" });
    try {
      await client.connect(transport);
      const parse = (output: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((output.content as Array<{ text: string }>)[0].text) as Reply;
      const call = async (data: AppCommand) => parse(await client.callTool({ name: "app_act", arguments: { sessionId: session.id, command: data } }));
      const ambiguous = await call({ type: "find", query: { kind: "name", name: "Save", exact: false } }); expect(ambiguous.result?.status).toBe("ambiguous"); expect(ambiguous.result?.ref).toBeUndefined(); expect((await effects(page)).clicks).toBe(0);
      const unique = await call({ type: "find", query: { kind: "role", role: "button", name: "Café 東京 ✓" } }); expect(unique.result?.source).toBe("sdk-reported"); expect(unique.result?.query).toMatchObject({ name: "Café 東京 ✓", exact: true });
      const clicked = await call({ type: "ref-click", ref: unique.result!.ref! }); expect(clicked.ok).toBe(true); await expect(page.getByText("Committed 1", { exact: true })).toBeVisible();
      const field = await call({ type: "find", query: { kind: "label", label: "Café 東京" } }); const filled = await call({ type: "ref-fill", ref: field.result!.ref!, value: "mcp-live-private-value" }); expect(filled.ok).toBe(true); await expect(page.locator("#recipient")).toHaveValue("mcp-live-private-value");
      await page.locator("#commit").evaluate(element => element.remove()); const stale = await call({ type: "ref-click", ref: unique.result!.ref! }); expect(stale.ok).toBe(false); expect(stale.error).toContain("stale");
      const observed = await client.callTool({ name: "app_observe", arguments: { sessionId: session.id } }); expect(JSON.stringify(observed)).not.toContain("mcp-live-private-value");
      await page.evaluate(() => window.runtime.disconnect());
      const incapable = await pair(page, request, runPhantom, targetApp.origin, false); await controls(page);
      for (const data of [{ type: "find", query: { kind: "name", name: "Café 東京 ✓" } }, { type: "ref-click", ref: unique.result!.ref! }, { type: "ref-fill", ref: field.result!.ref!, value: "must-not-land" }] as AppCommand[]) {
        const refused = parse(await client.callTool({ name: "app_act", arguments: { sessionId: incapable.id, command: data } })); expect(refused.ok).toBe(false); expect(refused.error).toContain("no action was executed");
      }
      expect(await effects(page)).toEqual({ clicks: 0, inputs: 0, focus: 0 });
    } finally { await client.close(); await transport.close(); }
  });

  test("a forced browser nonce collision after expiry cannot reuse a handed-out handle", async ({ page, request, runPhantom, targetApp }) => {
    await page.addInitScript(() => {
      const native = crypto.getRandomValues.bind(crypto);
      const overrides: string[] = []; Object.assign(window, { semanticNonceOverrides: overrides });
      Object.defineProperty(crypto, "getRandomValues", { configurable: true, value(array: ArrayBufferView) {
        if (array instanceof Uint8Array && array.byteLength === 16 && overrides.length) {
          const next = overrides.shift()!;
          for (let index = 0; index < 16; index++) array[index] = parseInt(next.slice(index * 2, index * 2 + 2), 16);
          return array;
        }
        return native(array);
      } });
    });
    await page.clock.install();
    const session = await pair(page, request, runPhantom, targetApp.origin); await controls(page);
    const original = await find(request, runPhantom, session.id, { kind: "test-id", testId: "確定" });
    await page.clock.fastForward(60_001);
    const replacementNonce = "b".repeat(32);
    await page.evaluate(({ previous, replacement }) => { (window as unknown as { semanticNonceOverrides: string[] }).semanticNonceOverrides.push(previous, replacement); }, { previous: original.ref!.slice(6), replacement: replacementNonce });
    const fresh = await find(request, runPhantom, session.id, { kind: "test-id", testId: "確定" });
    expect(fresh.status).toBe("unique"); expect(fresh.ref).toBe(`rpref_${replacementNonce}`); expect(fresh.ref).not.toBe(original.ref);
    expect(await page.evaluate(() => (window as unknown as { semanticNonceOverrides: string[] }).semanticNonceOverrides.length)).toBe(0);
    const refused = await command(request, runPhantom, session.id, { type: "ref-click", ref: original.ref! }); expect(refused.ok).toBe(false);
    expect(await effects(page)).toEqual({ clicks: 0, inputs: 0, focus: 0 });
    expect((await command(request, runPhantom, session.id, { type: "ref-click", ref: fresh.ref! })).ok).toBe(true); await expect(page.getByText("Committed 1", { exact: true })).toBeVisible();
  });

  test("the actual connection refuses lifetime issuance exhaustion without rebinding old tokens", async ({ page, request, runPhantom, targetApp }) => {
    const session = await pair(page, request, runPhantom, targetApp.origin); await controls(page);
    let oldRef = "";
    for (let batch = 0; batch < 34; batch++) {
      await page.evaluate(batch => {
        document.querySelector("#capacity")?.remove(); const group = document.createElement("div"); group.id = "capacity";
        for (let index = 0; index < 30; index++) { const button = document.createElement("button"); button.textContent = `Capacity ${batch} ${index}`; group.append(button); }
        document.body.append(group);
      }, batch);
      const result = await find(request, runPhantom, session.id, { kind: "role", role: "button", name: "Capacity", exact: false });
      expect(result.count).toBe(30);
      if (!oldRef) oldRef = result.elements[0].ref!;
      if (batch < 33) { expect(result.status).toBe("ambiguous"); expect(result.elements.filter(item => item.ref)).toHaveLength(30); }
      else { expect(result.status).toBe("inconclusive"); expect(result.coverage.reasons).toContain("reference-capacity-exhausted"); expect(result.elements.filter(item => item.ref)).toHaveLength(10); expect(result.ref).toBeUndefined(); }
    }
    expect((await command(request, runPhantom, session.id, { type: "ref-click", ref: oldRef })).ok).toBe(false);
    const exhausted = await find(request, runPhantom, session.id, { kind: "test-id", testId: "確定" }); expect(exhausted.ref).toBeUndefined(); expect(exhausted.coverage.reasons).toContain("reference-capacity-exhausted");
    expect(await effects(page)).toEqual({ clicks: 0, inputs: 0, focus: 0 });
  });

  test("a late old-session response and malformed SDK summary cannot repopulate the inspector", async ({ page, context, request, runPhantom, targetApp }) => {
    const app = await context.newPage();
    let release: (() => void) | undefined;
    let capture: (() => void) | undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const captured = new Promise<void>(resolve => { capture = resolve; });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    try {
      const session = await pair(app, request, runPhantom, targetApp.origin); await controls(app);
      const other = await (await request.post(`${runPhantom.url}/api/verification/sessions`, { data: { origin: targetApp.origin } })).json() as SessionSummary;
      await page.goto(`${runPhantom.url}/verification`);
      const inspector = page.getByRole("region", { name: "Find a live element", exact: true });
      await page.getByRole("combobox", { name: "Active session", exact: true }).selectOption(session.id);
      await inspector.getByLabel(/^Element name/).fill("Café 東京 ✓");
      const endpoint = `**/api/verification/sessions/${session.id}/command`;
      await page.route(endpoint, async route => { const response = await route.fetch(); capture!(); await held; await route.fulfill({ response }); });
      await inspector.getByRole("button", { name: "Find element", exact: true }).click(); await captured;
      await page.getByRole("combobox", { name: "Active session", exact: true }).selectOption(other.id); release!();
      await expect(inspector.getByText(/^Selected:/)).toHaveCount(0); await expect(inspector.getByLabel("Semantic discovery")).toHaveCount(0);
      await page.unroute(endpoint);
      await page.getByRole("combobox", { name: "Active session", exact: true }).selectOption(session.id);
      await page.route(endpoint, async route => { await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, cursor: 1, result: { source: "sdk-reported", nameModel: "partial-aria", documentGeneration: "a".repeat(32), count: 1, countExact: true, elements: [null], coverage: { complete: true, reasons: [] } } }) }); });
      await inspector.getByRole("button", { name: "Find element", exact: true }).click();
      await expect(inspector.getByRole("alert")).toContainText("unsupported semantic discovery"); await expect(inspector.getByText(/^Selected:/)).toHaveCount(0);
      await page.unroute(endpoint); await inspector.getByRole("button", { name: "Find element", exact: true }).click(); await expect(inspector.getByText("Selected: Café 東京 ✓", { exact: true })).toBeVisible();
      expect(errors).toEqual([]); expect(await effects(app)).toEqual({ clicks: 0, inputs: 0, focus: 0 });
    } finally { release?.(); await app.close(); }
  });
});

test("compiled SDK: semantic discovery and inspector act on an exact native-served live handle", async ({ page, context, request, targetApp }, testInfo) => {
  const url = process.env.RUNPHANTOM_COMPILED_URL;
  test.skip(!url, "RUNPHANTOM_COMPILED_URL is required for packaged semantic verification");
  const daemon = { url: url!, port: Number(new URL(url!).port), dbPath: "" };
  const session = await pair(page, request, daemon, targetApp.origin); await controls(page);
  const found = await find(request, daemon, session.id, { kind: "role", role: "button", name: "Café 東京 ✓" });
  expect(found.status).toBe("unique"); expect(found.query).toMatchObject({ name: "Café 東京 ✓", exact: true });
  expect((await command(request, daemon, session.id, { type: "ref-click", ref: found.ref! })).ok).toBe(true); await expect(page.getByText("Committed 1", { exact: true })).toBeVisible();
  const field = await find(request, daemon, session.id, { kind: "label", label: "Café 東京" });
  expect((await command(request, daemon, session.id, { type: "ref-fill", ref: field.ref!, value: "installed-private-live-value" })).ok).toBe(true); await expect(page.locator("#recipient")).toHaveValue("installed-private-live-value");
  const ui = await context.newPage();
  try {
    await ui.goto(`${url}/verification`);
    const inspector = ui.getByRole("region", { name: "Find a live element", exact: true });
    await inspector.getByLabel(/^Element name/).fill("Café 東京 ✓"); await inspector.getByRole("button", { name: "Find element", exact: true }).click(); await expect(inspector.getByText("Selected: Café 東京 ✓", { exact: true })).toBeVisible();
    const screenshotRoot = process.env.RUNPHANTOM_PUBLIC_EVIDENCE_DIR;
    if (screenshotRoot) { await inspector.getByText("Selected: Café 東京 ✓", { exact: true }).scrollIntoViewIfNeeded(); const filename = path.join(screenshotRoot, "semantic-installed-inspector.png"); await ui.screenshot({ path: filename, fullPage: true }); await testInfo.attach("Installed semantic inspector", { path: filename, contentType: "image/png" }); }
    await inspector.getByRole("button", { name: "Click selected element", exact: true }).click(); await expect(page.getByText("Committed 2", { exact: true })).toBeVisible();
    expect(JSON.stringify(await observe(request, daemon, session.id))).not.toContain("installed-private-live-value");
  } finally { await ui.close(); await page.evaluate(() => window.runtime.disconnect()); await request.delete(`${url}/api/verification/sessions/${session.id}`); }
});

test("compiled SDK: stale and incapable handles refuse without focus, writes or saved identity", async ({ page, request, targetApp }) => {
  const url = process.env.RUNPHANTOM_COMPILED_URL;
  test.skip(!url, "RUNPHANTOM_COMPILED_URL is required for packaged semantic refusals");
  const daemon = { url: url!, port: Number(new URL(url!).port), dbPath: "" };
  const session = await pair(page, request, daemon, targetApp.origin); await controls(page);
  let incapable: SessionSummary | undefined;
  try {
    const field = await find(request, daemon, session.id, { kind: "test-id", testId: "受信者" });
    await page.locator("#recipient").evaluate(element => element.replaceWith(element.cloneNode(true)));
    const stale = await command(request, daemon, session.id, { type: "ref-fill", ref: field.ref!, value: "must-not-land" }); expect(stale.ok).toBe(false); expect(stale.error).toContain("stale");
    await expect(page.locator("#recipient")).toHaveValue(""); expect(await effects(page)).toEqual({ clicks: 0, inputs: 0, focus: 0 });
    await page.evaluate(() => window.runtime.disconnect());
    incapable = await pair(page, request, daemon, targetApp.origin, false); await controls(page);
    const refused = await command(request, daemon, incapable.id, { type: "ref-fill", ref: field.ref!, value: "must-not-land" }); expect(refused.ok).toBe(false); expect(refused.error).toContain("no action was executed");
    const before = await (await request.get(`${url}/api/verification/flows`)).json();
    const saved = await request.post(`${url}/api/verification/flows`, { data: { name: "Cannot persist native live handle", origin: targetApp.origin, steps: [{ command: { type: "ref-click", ref: field.ref! }, predicate: { kind: "signal", name: "done" } }] } }); expect(saved.status()).toBe(400);
    expect(await (await request.get(`${url}/api/verification/flows`)).json()).toEqual(before); expect(await effects(page)).toEqual({ clicks: 0, inputs: 0, focus: 0 });
  } finally { await page.evaluate(() => window.runtime.disconnect()); await request.delete(`${url}/api/verification/sessions/${session.id}`); if (incapable) await request.delete(`${url}/api/verification/sessions/${incapable.id}`); }
});
