import { describe, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import path from "node:path";
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

interface ObserverState {
  created: number; scopes: number[]; observes: Array<{ id: number; root: string }>;
  disconnects: number[]; deliveries: Record<string, number>; traversalRefusals: number;
  scopeAbsent: boolean; engineAbsent: boolean;
}
async function withObserverProbe(page: any, callback: (probe: {
  page: AccessibilityPage; worlds: Set<number>; mutate(): Promise<ObserverState>;
  control(): Promise<number>; refuseShadowTraversal(): Promise<void>;
}) => Promise<void>) {
  const inspect: AccessibilityCDP = await page.context().newCDPSession(page), worlds = new Set<number>();
  let world: number | undefined;
  const evaluate = async (expression: string, awaitPromise = false) => {
    const result = await inspect.send("Runtime.evaluate", { contextId: world, expression, awaitPromise, returnByValue: true });
    if (result.exceptionDetails) throw new Error("Native observer probe failed");
    return result.result.value;
  };
  const proxy: AccessibilityPage = { isClosed: () => page.isClosed(), context: () => ({ newCDPSession: async () => {
    const real: AccessibilityCDP = await page.context().newCDPSession(page);
    return { detach: () => real.detach(), send: async (method, params) => {
      const setup = method === "Runtime.evaluate" && typeof params?.expression === "string" && params.expression.startsWith("globalThis.__rpAudit=");
      if (setup) await evaluate("globalThis.__rpObserverProbe.constructingScope=true");
      let result: Record<string, any>;
      try { result = await real.send(method, params); }
      finally { if (setup) await evaluate("globalThis.__rpObserverProbe.constructingScope=false"); }
      if (method === "Page.createIsolatedWorld") {
        world = result.executionContextId; worlds.add(world!);
        // Weak identity and numeric logs never retain the observer objects being measured.
        await evaluate(`if(!globalThis.__rpObserverProbe){const Native=MutationObserver,ids=new WeakMap,observe=Native.prototype.observe,disconnect=Native.prototype.disconnect,walk=document.createTreeWalker;const state=globalThis.__rpObserverProbe={created:0,scopes:[],observes:[],disconnects:[],deliveries:{},traversalRefusals:0,constructingScope:false,failShadowTraversal:false};function Wrapped(callback){const id=++state.created;const observer=new Native((records,owner)=>{state.deliveries[id]=(state.deliveries[id]||0)+1;return callback(records,owner)});ids.set(observer,id);if(state.constructingScope)state.scopes.push(id);return observer}Wrapped.prototype=Native.prototype;Object.setPrototypeOf(Wrapped,Native);globalThis.MutationObserver=Wrapped;Native.prototype.observe=function(...args){const result=observe.apply(this,args);state.observes.push({id:ids.get(this),root:args[0] instanceof ShadowRoot?'shadow':'document'});return result};Native.prototype.disconnect=function(...args){const result=disconnect.apply(this,args);state.disconnects.push(ids.get(this));return result};document.createTreeWalker=function(...args){if(state.failShadowTraversal&&args[0] instanceof ShadowRoot){state.traversalRefusals++;throw new Error('Owned traversal refusal')}return walk.apply(this,args)}}`);
      }
      return result;
    } };
  } }) };
  try {
    await callback({ page: proxy, worlds,
      control: () => evaluate("(()=>{const observer=new MutationObserver(()=>{});observer.observe(document,{attributes:true,subtree:true});globalThis.__rpObserverControl=new WeakRef(observer);return globalThis.__rpObserverProbe.created})()"),
      refuseShadowTraversal: () => evaluate("globalThis.__rpObserverProbe.failShadowTraversal=true"),
      mutate: async () => {
        await inspect.send("HeapProfiler.collectGarbage");
        return evaluate("(async()=>{const root=document.querySelector('#audit');root.setAttribute('data-native-observer-proof',String(Date.now()));root.querySelector('#open')?.shadowRoot?.append(document.createElement('span'));await new Promise(resolve=>setTimeout(resolve,25));return {...JSON.parse(JSON.stringify(globalThis.__rpObserverProbe)),scopeAbsent:typeof globalThis.__rpAudit==='undefined',engineAbsent:typeof globalThis.axe==='undefined'}})()", true);
      } });
  } finally {
    if (world !== undefined && !page.isClosed()) await evaluate("globalThis.__rpObserverControl?.deref()?.disconnect();delete globalThis.__rpObserverControl").catch(() => {});
    await inspect.detach().catch(() => {});
  }
}
function recordObserverProof(name: string, state: ObserverState, server: any) {
  const directory = process.env.RUNPHANTOM_ACCESSIBILITY_OBSERVER_PROOF_DIR;
  if (directory) writeFileSync(path.join(directory, `${name}.json`), JSON.stringify({ instrumentation: "native observer calls, WeakMap identities, numeric logs, native GC and real DOM mutation", providerCalls: 0, ownedPid: server.process().pid, state }, null, 2) + "\n");
}

describe.skipIf(!installed)("actual owned Chromium accessibility engine adapter", () => {
  for (const [name, css, hidden] of [
    ["display", "#audit{display:none!important}", true],
    ["visibility", "#audit{visibility:hidden!important}", true],
    ["unchanged selected style", "#not-selected{display:none!important}", false],
  ] as const) test(`native CSSOM ${name} preserves the current rendered-scope fence for a held genuine result`, async () => withPage(async (page, _audit, server) => {
    await page.setContent(html(fixed));
    let holdNext = false, world: number | undefined, held!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { held = resolve; }), resumed = new Promise<void>(resolve => { release = resolve; });
    const inspect: AccessibilityCDP = await page.context().newCDPSession(page), worlds = new Set<number>();
    const proxy: AccessibilityPage = { isClosed: () => page.isClosed(), context: () => ({ newCDPSession: async () => {
      const real: AccessibilityCDP = await page.context().newCDPSession(page);
      return { detach: () => real.detach(), send: async (method, params) => {
        const result = await real.send(method, params);
        if (method === "Page.createIsolatedWorld") { world = result.executionContextId; worlds.add(world!); }
        if (holdNext && method === "Runtime.evaluate" && params?.awaitPromise === true) { held(); await resumed; }
        return result;
      } };
    } }) };
    const authority = { current: () => !page.isClosed(), terminate: async () => { await page.close(); } };
    try {
      const baseline = await scanAccessibility(proxy, request, identity, authority);
      expect(baseline.status).toBe("no-findings"); expect(baseline.coverage).toBe("complete");
      holdNext = true;
      const pending = scanAccessibility(proxy, request, identity, authority);
      try {
        await ready;
        const witness = await page.evaluate((css: string) => {
          const root = document.querySelector("#audit")!, beforeHtml = root.outerHTML, beforeLocation = location.href, beforeDocument = root.ownerDocument;
          const visible = () => { const style = getComputedStyle(root); return style.display !== "none" && style.visibility === "visible" && root.getClientRects().length > 0; };
          const beforeVisible = visible(), sheet = document.styleSheets[0], beforeRules = sheet.cssRules.length;
          sheet.insertRule(css, beforeRules);
          return { beforeVisible, afterVisible: visible(), htmlUnchanged: beforeHtml === root.outerHTML,
            nodeUnchanged: root === document.querySelector("#audit"), documentUnchanged: beforeDocument === root.ownerDocument,
            locationUnchanged: beforeLocation === location.href, ruleAdded: sheet.cssRules.length === beforeRules + 1 };
        }, css);
        const current = await inspect.send("Runtime.evaluate", { contextId: world, expression: "globalThis.__rpAudit.current()", returnByValue: true });
        holdNext = false; release();
        const result = await pending, fresh = await scanAccessibility(proxy, request, identity, authority);
        const directory = process.env.RUNPHANTOM_ACCESSIBILITY_OBSERVER_PROOF_DIR;
        if (directory) writeFileSync(path.join(directory, `cssom-${name.replaceAll(" ", "-")}.json`), JSON.stringify({ mechanism: "held untouched real native engine reply; native insertRule; no DOM change, fake output or retained HTML/styles", ownedPid: server.process().pid, providerCalls: 0, witness, currentAfterCssom: current.result.value, baseline, held: result, fresh }, null, 2) + "\n");
        expect(witness).toEqual({ beforeVisible: true, afterVisible: !hidden, htmlUnchanged: true, nodeUnchanged: true, documentUnchanged: true, locationUnchanged: true, ruleAdded: true });
        expect(fresh.status).toBe(hidden ? "inconclusive" : "no-findings"); expect(fresh.coverage).toBe(hidden ? "unavailable" : "complete");
        if (hidden) { expect(fresh.loss).toContain("region-unavailable"); expect(fresh.population.total).toBeNull(); }
        expect(current.result.value).toBe(!hidden);
        expect(result.generation).toBe(1); expect(result.source).toBe("host-run-native-engine"); expect(result.status).toBe(hidden ? "inconclusive" : "no-findings");
        expect(result.coverage).toBe(hidden ? "unavailable" : "complete"); expect(result.findings).toEqual([]);
        if (hidden) { expect(result.loss).toContain("document-changed"); expect(result.population.total).toBeNull(); }
        expect(page.isClosed()).toBe(false); expect(worlds.size).toBe(1);
      } finally { holdNext = false; release(); await pending; }
    } finally { await inspect.detach().catch(() => {}); }
  }), 20000);
  test("refused scope setup disconnects observers before post-GC native mutation on the reused page", async () => withPage(async (page, _audit, server) => {
    await page.setContent(html(fixed + '<div id="duplicate"></div><div id="duplicate"></div><div id="hidden" hidden></div>'));
    await withObserverProbe(page, async probe => {
      for (let repeat = 0; repeat < 3; repeat++) for (const region of ["#missing", "#duplicate", "#hidden", "["]) {
        const result = await scanAccessibility(probe.page, { ...request, regions: ["#audit", region] }, identity,
          { current: () => !page.isClosed(), terminate: async () => { await page.close(); } });
        expect(result.status).toBe("inconclusive"); expect(result.coverage).toBe("unavailable"); expect(result.loss).toContain("region-unavailable");
      }
      const control = await probe.control(), state = await probe.mutate(); recordObserverProof("refused-roots", state, server);
      expect(state.deliveries[control]).toBe(1); expect(state.scopes).toHaveLength(12);
      expect(state.scopeAbsent).toBe(true); expect(state.engineAbsent).toBe(true);
      expect(state.scopes.map(id => state.deliveries[id] ?? 0)).toEqual(Array(12).fill(0));
      for (const id of state.scopes) { expect(state.observes.filter(item => item.id === id)).toHaveLength(1); expect(state.disconnects.filter(item => item === id)).toHaveLength(1); }
      expect(page.isClosed()).toBe(false); expect(probe.worlds.size).toBe(1);
    });
  }), 20000);
  test("successful scopes dispose their own native observers without counting engine observers", async () => withPage(async (page, _audit, server) => {
    await page.setContent(html(fixed));
    await withObserverProbe(page, async probe => {
      for (let repeat = 0; repeat < 3; repeat++) {
        const result = await scanAccessibility(probe.page, request, identity,
          { current: () => !page.isClosed(), terminate: async () => { await page.close(); } });
        expect(result.status).toBe("no-findings"); expect(result.coverage).toBe("complete");
      }
      const control = await probe.control(), state = await probe.mutate(); recordObserverProof("successful-scopes", state, server);
      expect(state.deliveries[control]).toBe(1); expect(state.scopes).toHaveLength(3);
      expect(state.scopeAbsent).toBe(true); expect(state.engineAbsent).toBe(true);
      expect(state.scopes.map(id => state.deliveries[id] ?? 0)).toEqual([0, 0, 0]);
      for (const id of state.scopes) expect(state.disconnects.filter(item => item === id)).toHaveLength(1);
      expect(page.isClosed()).toBe(false); expect(probe.worlds.size).toBe(1);
    });
  }), 20000);
  test("construction failure after a real shadow observation disconnects that same native observer", async () => withPage(async (page, _audit, server) => {
    await page.setContent(html(fixed + '<div id="open"></div>'));
    await page.evaluate(() => { document.querySelector("#open")!.attachShadow({ mode: "open" }).innerHTML = "<button>Shadow action</button>"; });
    await withObserverProbe(page, async probe => {
      // Initialize the private world through a refused selector before injecting a later construction fault.
      await scanAccessibility(probe.page, { ...request, regions: ["#missing"] }, identity,
        { current: () => !page.isClosed(), terminate: async () => { await page.close(); } });
      await probe.refuseShadowTraversal();
      for (let repeat = 0; repeat < 3; repeat++) {
        const result = await scanAccessibility(probe.page, request, identity,
          { current: () => !page.isClosed(), terminate: async () => { await page.close(); } });
        expect(result.status).toBe("inconclusive"); expect(result.loss).toContain("region-unavailable");
      }
      const control = await probe.control(), state = await probe.mutate(); recordObserverProof("refused-shadow-traversal", state, server);
      expect(state.deliveries[control]).toBe(1); expect(state.scopes).toHaveLength(4); expect(state.traversalRefusals).toBe(3);
      expect(state.scopeAbsent).toBe(true); expect(state.engineAbsent).toBe(true);
      expect(state.scopes.map(id => state.deliveries[id] ?? 0)).toEqual([0, 0, 0, 0]);
      for (const id of state.scopes.slice(1)) expect(state.observes.filter(item => item.id === id).map(item => item.root)).toEqual(["document", "shadow"]);
      for (const id of state.scopes) expect(state.disconnects.filter(item => item === id)).toHaveLength(1);
      expect(page.isClosed()).toBe(false); expect(probe.worlds.size).toBe(1);
    });
  }), 20000);
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
  test("completed audits dispose actual isolated observers and release engine and selected-node globals", async () => withPage(async (page) => {
    await page.setContent(html(fixed)); let cleaned = 0; const worlds = new Set<number>();
    const proxy: AccessibilityPage = { isClosed: () => page.isClosed(), context: () => ({ newCDPSession: async () => {
      const real: AccessibilityCDP = await page.context().newCDPSession(page);
      return { detach: () => real.detach(), send: async (method, params) => {
        const result = await real.send(method, params);
        if (method === "Page.createIsolatedWorld") worlds.add(result.executionContextId);
        if (method === "Runtime.evaluate" && typeof params?.expression === "string" && params.expression.includes("delete globalThis.axe")) {
          const state = await real.send("Runtime.evaluate", { contextId: params.contextId, expression: "typeof globalThis.axe==='undefined'&&typeof globalThis.__rpAudit==='undefined'", returnByValue: true });
          expect(state.result.value).toBe(true); cleaned++;
          const window = await real.send("Runtime.evaluate", { contextId: params.contextId, expression: "globalThis", objectGroup: "audit-cleanup-test" });
          const listeners = await real.send("DOMDebugger.getEventListeners", { objectId: window.result.objectId, depth: 0, pierce: false });
          expect(listeners.listeners.filter((listener: any) => listener.type === "message")).toHaveLength(0);
          await real.send("Runtime.releaseObjectGroup", { objectGroup: "audit-cleanup-test" });
        }
        return result;
      } };
    } }) };
    for (let index = 0; index < 3; index++) {
      const result = await scanAccessibility(proxy, request, identity, { current: () => !page.isClosed(), terminate: async () => { await page.close(); } });
      expect(result.status).toBe("no-findings");
    }
    expect(cleaned).toBe(3); expect(worlds.size).toBe(1);
  }), 20000);
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
