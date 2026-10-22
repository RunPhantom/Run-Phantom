import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BrowserProvider } from "../src/verification/browser-provider";
import { trustedBrowserFixture } from "./helpers/trusted-browser-fixture";
import { createServer } from "node:net";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import type { BrowserAction, BrowserEngine } from "../src/verification/browser-contract";

describe("optional browser runtime boundary", () => {
  test("absent and invalid host closures refuse without allocating authority", async () => {
    const absent = new BrowserProvider({});
    expect(absent.status().available).toBe(false);
    await Promise.resolve(expect(absent.start("owned")).rejects.toThrow("not configured"));
    expect(absent.proofs()).toEqual([]);
    const invalid = new BrowserProvider({ moduleEntry: "/does-not-exist/playwright.mjs" });
    expect(invalid.status().available).toBe(false);
    await Promise.resolve(expect(invalid.start("owned")).rejects.toThrow("unavailable"));
  });
  test("a public artifact directory refuses before any worker or raw spool is allocated", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rp-browser-public-dir-")), moduleEntry = path.join(root, "index.mjs"), artifacts = path.join(root, "artifacts");
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "playwright", version: "1.62.1" })); writeFileSync(moduleEntry, "export const chromium={};"); mkdirSync(artifacts); chmodSync(artifacts, 0o755);
    const provider = new BrowserProvider({ moduleEntry, artifactRoot: artifacts });
    try { await Promise.resolve(expect(provider.start("owned")).rejects.toThrow("Private browser artifact directory")); expect(provider.proofs()).toEqual([]); }
    finally { await provider.close(); rmSync(root, { recursive: true, force: true }); }
  });
  test("actual worker refuses an incompatible host module without path disclosure", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rp-browser-invalid-"));
    const moduleEntry = path.join(root, "runtime", "index.mjs");
    mkdirSync(path.dirname(moduleEntry));
    writeFileSync(path.join(root, "runtime", "package.json"), JSON.stringify({ name: "playwright", version: "1.62.1" }));
    writeFileSync(moduleEntry, "export const chromium = {}; export const firefox = {}; export const webkit = {};\n");
    const provider = new BrowserProvider({ moduleEntry, artifactRoot: path.join(root, "artifacts") });
    try {
      const worker = await provider.start("owned");
      const reply = await worker.request("open", 0, { engine: "chromium", url: "http://127.0.0.1:9999/", recordVideo: false });
      expect(reply.ok).toBe(false);
      expect(JSON.stringify(reply)).not.toContain(root);
      expect(reply.reason).toBe("Optional browser runtime is incompatible");
      await worker.close();
      expect(provider.proofs().every(proof => proof.reaped)).toBe(true);
    } finally { await provider.close(); rmSync(root, { recursive: true, force: true }); }
  }, 20000);
});

describe.skipIf(!process.env.RUNPHANTOM_TEST_BROWSER_MODULE)("actual optional browser worker qualification", () => {
  test("configured runtime with an absent engine refuses and reaps its actual worker", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rp-browser-missing-engine-")); const cache = path.join(root, "empty-cache"); mkdirSync(cache);
    const provider = new BrowserProvider({ moduleEntry: process.env.RUNPHANTOM_TEST_BROWSER_MODULE, cachePath: cache, artifactRoot: path.join(root, "artifacts") });
    try {
      expect(provider.status().available).toBe(true); expect(provider.status().qualification).toBe("launch-required");
      const worker = await provider.start("owned"); const reply = await worker.request("open", 0, { engine: "chromium", url: "http://127.0.0.1:8765", recordVideo: false }, 20000);
      expect(reply.ok).toBe(false); expect(reply.reason).toBe("Browser engine or policy is unavailable"); expect(JSON.stringify(reply)).not.toContain(root);
      await worker.close(); expect(worker.proof.reaped).toBe(true); expect(() => process.kill(worker.proof.workerPid, 0)).toThrow();
    } finally { await provider.close(); rmSync(root, { recursive: true, force: true }); }
  }, 25000);
  test("explicit attached opaque page selects one identical tab and detach preserves the user browser", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rp-browser-attach-")), fixture = trustedBrowserFixture(), sentinelFixture = trustedBrowserFixture(), staleFixture = trustedBrowserFixture();
    const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening"); const port = (reservation.address() as { port: number }).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
    // This harness owns the user-browser stand-in independently from the product worker.
    const runtime = await import(pathToFileURL(process.env.RUNPHANTOM_TEST_BROWSER_MODULE!).href);
    const userServer = await runtime.chromium.launchServer({ headless: true, args: [`--remote-debugging-port=${port}`] });
    const userPid = userServer.process().pid; const browser = await runtime.chromium.connect(userServer.wsEndpoint());
    const context = await browser.newContext(); const first = await context.newPage(), second = await context.newPage(), sentinel = await context.newPage();
    for (const page of [first, second]) await page.goto(fixture.origin); await sentinel.goto(sentinelFixture.origin);
    await first.evaluate(() => { document.body.insertAdjacentHTML("beforeend", '<div id="first-tab">Other twin</div>'); });
    await second.evaluate(() => { document.body.insertAdjacentHTML("beforeend", '<div id="second-tab">Selected twin</div>'); });
    const provider = new BrowserProvider({ moduleEntry: process.env.RUNPHANTOM_TEST_BROWSER_MODULE, cachePath: process.env.RUNPHANTOM_TEST_BROWSER_CACHE, cdpEndpoint: `http://127.0.0.1:${port}`, artifactRoot: path.join(root, "artifacts") });
    try {
      const worker = await provider.start("attached"), captured: any[] = []; worker.onEvent = (_generation, event) => captured.push(event);
      const listed = await worker.request("list", 0, {}, 20000); expect(listed.ok).toBe(true); const listing = listed.result as { revision: string; pages: { pageId: string; origin: string }[] };
      expect(listing.pages).toHaveLength(3); expect(new Set(listing.pages.map(page => page.pageId)).size).toBe(3);
      const twins = listing.pages.filter(page => page.origin === fixture.origin); expect(twins).toHaveLength(2); expect(listing.pages.filter(page => page.origin === sentinelFixture.origin)).toHaveLength(1);
      expect((await worker.request("select", 0, { revision: "f".repeat(32), pageId: twins[1].pageId })).ok).toBe(false);
      const chosen = await worker.request("select", 0, { revision: listing.revision, pageId: twins[1].pageId }); expect(chosen.ok).toBe(true); expect(chosen.result).toMatchObject({ coverage: { network: false }, state: "ready" });
      // CDP enumeration is not tab-strip order. Observe the exact selected opaque
      // page, then require dispatch to mutate only that physical twin.
      expect((await worker.request("read", chosen.generation, { selectors: ["#first-tab", "#second-tab"] })).ok).toBe(true);
      const markers = captured.filter(event => event.type === "dom" && ["#first-tab", "#second-tab"].includes(event.data.selector));
      expect(markers.map(event => event.data.count).sort()).toEqual([0, 1]);
      const physicalChosen = markers.find(event => event.data.selector === "#second-tab")!.data.count === 1 ? second : first;
      const otherTwin = physicalChosen === first ? second : first;
      expect((await worker.request("action", chosen.generation, { actionId: "a".repeat(32), action: { type: "click", target: { kind: "css", selector: "#pay" } } })).result).toMatchObject({ dispatch: "completed", inputMode: "trusted-browser" });
      await physicalChosen.waitForSelector("#paid"); expect(await otherTwin.locator("#paid").count()).toBe(0); expect(await sentinel.locator("#paid").count()).toBe(0);
      const stalePage = await context.newPage(); await stalePage.goto(staleFixture.origin);
      const staleWorker = await provider.start("attached"); const staleListing = (await staleWorker.request("list", 0, {}, 20000)).result as typeof listing;
      expect(staleListing.pages).toHaveLength(4); const staleId = staleListing.pages.find(item => item.origin === staleFixture.origin)!.pageId; await stalePage.close();
      const replacement = await context.newPage(); await replacement.goto(staleFixture.origin);
      expect((await staleWorker.request("select", 0, { revision: staleListing.revision, pageId: staleId })).ok).toBe(false);
      expect(await replacement.locator("#paid").count()).toBe(0); await staleWorker.close();
      const closed = await worker.request("close", chosen.generation, {}); expect(closed.result).toMatchObject({ closed: true }); await worker.close();
      expect(worker.proof.reaped).toBe(true); expect(worker.proof.browserPid).toBeUndefined(); expect(browser.isConnected()).toBe(true); expect(() => process.kill(userPid, 0)).not.toThrow();
      for (const page of [first, second, sentinel]) { expect(page.isClosed()).toBe(false); expect(await page.locator("#result").textContent()).toBe(page === physicalChosen ? "Payment accepted" : "Original output Café 東京"); }
      await otherTwin.locator("#pay").click(); await otherTwin.waitForSelector("#paid"); expect(fixture.events.filter(event => event.type === "click")).toHaveLength(2); expect(sentinelFixture.events).toEqual([]);
    } finally { await provider.close(); await browser.close(); await userServer.close(); expect(() => process.kill(userPid, 0)).toThrow(); await fixture.close(); await sentinelFixture.close(); await staleFixture.close(); rmSync(root, { recursive: true, force: true }); }
  }, 45000);
  for (const engine of ["chromium", "firefox", "webkit"] as BrowserEngine[]) {
    test(`${engine}: actual trusted input, initial listeners, refusal and owned process reaping`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), `rp-browser-${engine}-`));
      const fixture = trustedBrowserFixture();
      const provider = new BrowserProvider({ moduleEntry: process.env.RUNPHANTOM_TEST_BROWSER_MODULE, cachePath: process.env.RUNPHANTOM_TEST_BROWSER_CACHE, artifactRoot: path.join(root, "artifacts") });
      const captured: unknown[] = [];
      try {
        const worker = await provider.start("owned"); worker.onEvent = (_generation, event) => captured.push(event);
        const opened = await worker.request("open", 0, { engine, url: fixture.origin, recordVideo: false }, 20000);
        expect(opened.ok).toBe(true); expect(opened.generation).toBeGreaterThan(0);
        const generation = opened.generation;
        expect(JSON.stringify(captured)).toContain("initial controlled capture");
        expect(JSON.stringify(captured)).toContain('"type":"network.start"');
        const run = async (action: BrowserAction) => {
          const reply = await worker.request("action", generation, { action, actionId: "a".repeat(32) });
          expect(reply.ok).toBe(true); return reply.result as { dispatch: string; inputMode: string };
        };
        expect(await run({ type: "click", target: { kind: "css", selector: "#pay" } })).toMatchObject({ dispatch: "completed", inputMode: "trusted-browser" });
        expect(await run({ type: "fill", target: { kind: "css", selector: "#name" }, value: "replacement controlled value" })).toMatchObject({ dispatch: "completed", inputMode: "trusted-browser" });
        expect(await run({ type: "press", target: { kind: "css", selector: "#name" }, key: "Tab" })).toMatchObject({ dispatch: "completed", inputMode: "trusted-browser" });
        expect(await run({ type: "hover", target: { kind: "css", selector: "#hover" } })).toMatchObject({ dispatch: "completed", inputMode: "trusted-browser" });
        expect(await run({ type: "select", target: { kind: "css", selector: "#plan" }, value: "a" })).toMatchObject({ dispatch: "completed", inputMode: "trusted-browser" });
        expect(await run({ type: "drag", target: { kind: "css", selector: "#from" }, to: { kind: "css", selector: "#to" } })).toMatchObject({ dispatch: "completed", inputMode: "trusted-browser" });
        expect(await run({ type: "focus", target: { kind: "css", selector: "#name" } })).toMatchObject({ dispatch: "completed", inputMode: "none" });
        for (const selector of ["button", "#file", "#missing"]) expect(await run({ type: "click", target: { kind: "css", selector } })).toMatchObject({ dispatch: "not-dispatched", inputMode: "none" });
        expect(await run({ type: "fill", target: { kind: "css", selector: "#readonly" }, value: "forbidden" })).toMatchObject({ dispatch: "not-dispatched", inputMode: "none" });
        await new Promise(resolve => setTimeout(resolve, 100));
        for (const type of ["click", "input", "key", "hover", "select", "drag-start", "drag-end"]) {
          const events = fixture.events.filter(event => event.type === type);
          expect(events.length).toBeGreaterThan(0); expect(events.every(event => event.trusted)).toBe(true);
        }
        expect(fixture.events.filter(event => event.type === "input").at(-1)?.value).toBe("replacement controlled value");
        expect(fixture.events.filter(event => event.type === "select").at(-1)?.value).toBe("a");
        expect(fixture.events.filter(event => event.type === "output").at(-1)).toEqual({ type: "output", trusted: true, value: "Payment accepted" });
        expect(JSON.stringify(captured)).not.toContain("replacement controlled value");
        const read = await worker.request("read", generation, { selectors: ["#paid"] }); expect(read.ok).toBe(true);
        expect(captured).toContainEqual(expect.objectContaining({ type: "dom", data: expect.objectContaining({ selector: "#paid", count: 1 }) }));
        expect(await run({ type: "fill", target: { kind: "css", selector: "#name" }, value: "猫" })).toMatchObject({ dispatch: "completed", inputMode: "trusted-browser" });
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(JSON.stringify(captured)).not.toContain("猫");
        await worker.close(generation);
        expect(provider.proofs()).toHaveLength(1); expect(provider.proofs()[0].browserPid).toBeGreaterThan(0); expect(provider.proofs()[0].reaped).toBe(true);
        for (const pid of [provider.proofs()[0].workerPid, provider.proofs()[0].browserPid!]) expect(() => process.kill(pid, 0)).toThrow();
        if (process.env.RUNPHANTOM_BROWSER_PROOF_DIR) {
          mkdirSync(process.env.RUNPHANTOM_BROWSER_PROOF_DIR, { recursive: true });
          writeFileSync(path.join(process.env.RUNPHANTOM_BROWSER_PROOF_DIR, `worker-${engine}.json`), JSON.stringify({ engine, opened, trustedEventTypes: fixture.events.map(event => ({ type: event.type, trusted: event.trusted })), proofs: provider.proofs() }, null, 2));
        }
      } finally { await provider.close(); await fixture.close(); rmSync(root, { recursive: true, force: true }); }
    }, 45000);
  }
});
