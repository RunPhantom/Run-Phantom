import { describe, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import { scanAccessibility, type AccessibilityPage, type AccessibilityCDP } from "../src/verification/accessibility";

const installed = process.env.RUNPHANTOM_TEST_BROWSER_MODULE;
const request = { generation: 1, rules: ["button-name", "image-alt", "label", "color-contrast"], regions: ["#audit"] };
const identity = { sessionId: "a".repeat(32), generation: 1, capturedAt: 1000 };
const html = (body: string) => `<!doctype html><html lang="en"><head><title>Local audit fixture</title><style>body{background:white;color:black;font:16px Arial}button,input{min-height:44px}#audit{background:white;color:black}</style></head><body><main id="audit">${body}</main></body></html>`;
const fixed = '<button id="action" type="button">Save</button><img id="image" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" alt="One pixel"><label for="entry">Name</label><input id="entry"><p>Readable text</p>';

async function withPage(callback: (page: any, audit: (value?: unknown) => ReturnType<typeof scanAccessibility>, server: any) => Promise<void>) {
  if (!installed) throw new Error("Actual native qualification requires the selected installed browser module");
  const runtime = await import(pathToFileURL(installed).href), server = await runtime.chromium.launchServer({ headless: true });
  const pid = server.process().pid, browser = await runtime.chromium.connect(server.wsEndpoint());
  const context = await browser.newContext(), page = await context.newPage(); let current = true;
  const audit = (value: unknown = request) => scanAccessibility(page as AccessibilityPage, value, identity,
    { current: () => current && !page.isClosed(), terminate: async () => { current = false; await browser.close(); await server.close(); } });
  try { await callback(page, audit, server); }
  finally { current = false; await browser.close().catch(() => {}); await server.close().catch(() => {}); expect(() => process.kill(pid, 0)).toThrow(); }
}

describe.skipIf(!installed)("actual owned Chromium accessibility engine adapter", () => {
  test("real invalid findings become scoped no-findings only after the actual fixture is fixed", async () => withPage(async (page, audit) => {
    await page.setContent(html('<button id="action"></button><img id="image"><input id="entry"><p>Readable text</p>'));
    const bad = await audit(); expect(bad.status).toBe("findings"); expect(bad.engine.version).toBe("4.11.0");
    expect(bad.findings.map(item => item.rule)).toEqual(expect.arrayContaining(["button-name", "image-alt", "label"]));
    await page.setContent(html(fixed));
    const good = await audit(); expect(good.status).toBe("no-findings"); expect(good.coverage).toBe("complete");
    expect(good.population).toEqual({ total: 0, retained: 0, dropped: 0 });
    expect(JSON.stringify(good)).not.toContain("<input"); expect(JSON.stringify(good)).not.toContain("data:image");
  }), 30000);
  test("actual empty selected region is inconclusive rather than clean", async () => withPage(async (page, audit) => {
    await page.setContent(html("")); const result = await audit(); expect(result.status).toBe("inconclusive");
    expect(result.loss).toContain("no-applicable-nodes");
  }), 15000);
  test("native closed shadow roots preserve a gap despite zero engine violations", async () => withPage(async (page, audit) => {
    await page.setContent(html(fixed + '<div id="closed"></div>'));
    await page.evaluate(() => { document.querySelector("#closed")!.attachShadow({ mode: "closed" }).innerHTML = '<button></button>'; });
    const result = await audit(); expect(result.status).toBe("inconclusive"); expect(result.coverage).toBe("partial");
    expect(result.loss).toContain("closed-shadow-root");
  }), 15000);
  test("frame exclusion and cap cannot establish absence", async () => withPage(async (page, audit) => {
    await page.setContent(html(fixed + '<iframe title="Opaque child" srcdoc="<button></button>"></iframe>'));
    const frame = await audit(); expect(frame.status).toBe("inconclusive"); expect(frame.loss).toContain("iframe-excluded");
    await page.setContent(html(fixed)); await page.evaluate(() => { const root = document.querySelector("#audit")!; for (let i = 0; i < 2001; i++) root.append(document.createElement("span")); });
    const capped = await audit(); expect(capped.status).toBe("inconclusive"); expect(capped.loss).toContain("root-inventory-limit");
  }), 20000);
  test("page supplied axe replacement cannot supply engine authority", async () => withPage(async (page, audit) => {
    await page.setContent(html('<button id="action"></button>'));
    await page.evaluate(() => { (window as any).axe = { version: "4.11.0", run: () => Promise.resolve({ violations: [], passes: [] }) }; });
    const result = await audit(); expect(result.status).toBe("findings"); expect(result.findings.some(item => item.rule === "button-name")).toBe(true);
  }), 15000);
  test("same-document mutation fences a held real engine response without a navigation change", async () => withPage(async (page) => {
    await page.setContent(html(fixed));
    let release!: () => void, held!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { held = resolve; });
    const proxy: AccessibilityPage = { isClosed: () => page.isClosed(), context: () => ({ newCDPSession: async () => {
      const real: AccessibilityCDP = await page.context().newCDPSession(page);
      return { detach: () => real.detach(), send: async (method, params) => {
        const result = await real.send(method, params);
        if (method === "Runtime.evaluate" && params?.awaitPromise === true) { held(); await released; }
        return result;
      } };
    } }) };
    const pending = scanAccessibility(proxy, request, identity, { current: () => !page.isClosed(), terminate: async () => { await page.close(); } });
    await started; await page.evaluate(() => { document.querySelector("#audit")!.append(document.createElement("button")); }); release();
    const result = await pending; expect(result.generation).toBe(1); expect(result.status).toBe("inconclusive");
    expect(result.findings).toEqual([]); expect(result.loss).toContain("document-changed");
  }), 15000);
  test("selected root replacement fences held findings from the original actual root", async () => withPage(async (page) => {
    await page.setContent(html('<button id="action"></button>'));
    let release!: () => void, held!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { held = resolve; });
    const proxy: AccessibilityPage = { isClosed: () => page.isClosed(), context: () => ({ newCDPSession: async () => {
      const real: AccessibilityCDP = await page.context().newCDPSession(page);
      return { detach: () => real.detach(), send: async (method, params) => {
        const result = await real.send(method, params);
        if (method === "Runtime.evaluate" && params?.awaitPromise === true) { held(); await released; }
        return result;
      } };
    } }) };
    const pending = scanAccessibility(proxy, request, identity, { current: () => !page.isClosed(), terminate: async () => { await page.close(); } });
    await started; await page.evaluate(() => { const old = document.querySelector("#audit")!; old.replaceWith(old.cloneNode(true)); }); release();
    const result = await pending; expect(result.status).toBe("inconclusive"); expect(result.findings).toEqual([]); expect(result.loss).toContain("document-changed");
  }), 15000);
  test("execution deadline reaps the real owned browser before a held response can return", async () => withPage(async (page, _audit, server) => {
    await page.setContent(html(fixed)); const pid = server.process().pid; let active = true, release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const proxy: AccessibilityPage = { isClosed: () => page.isClosed(), context: () => ({ newCDPSession: async () => {
      const real: AccessibilityCDP = await page.context().newCDPSession(page);
      return { detach: () => real.detach(), send: async (method, params) => {
        const result = await real.send(method, params);
        if (method === "Runtime.evaluate" && params?.awaitPromise === true) await released;
        return result;
      } };
    } }) };
    try {
      const result = await scanAccessibility(proxy, request, identity, { current: () => active && !page.isClosed(), terminate: async () => { active = false; await server.close(); } });
      expect(result.status).toBe("inconclusive"); expect(result.loss).toContain("engine-timeout"); expect(active).toBe(false);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { release(); }
  }), 20000);
});
