import { test, expect, type BrowserType, type JSHandle } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { createSelectedMaskedRecorder, installMaskedRecorder, parseProducerPull, type MaskedProducer, type SelectedRecorderClient } from "../../src/verification/browser/recorder";
import { parseRecordingBatch, type RecordingBatch } from "../../src/verification/recording-types";
import { startRecordingPlayerHost } from "./recording-player-host";
import type { RecordingLease } from "../../src/verification/recording";
import { recordingSourcePins } from "./recording-source-pins";

const privateToken = "SYNTHETIC_RECORDING_SECRET_3917";
const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#f9fafc}#box{width:120px;height:45px;background:rgb(0, 33, 204)}input{margin:15px;width:200px;height:30px}</style><div id="box" data-private="${privateToken}">${privateToken}</div><input id="field" type="password" value="${privateToken}"><a href="https://example.invalid/${privateToken}">${privateToken}</a>`;

test("actual three-engine producer masks before retention and survives later page method poisoning", async ({}, info) => {
  const pins = recordingSourcePins(); await writeFile(info.outputPath("source-pins-before.json"), JSON.stringify(pins, null, 2));
  const moduleEntry = process.env.RUNPHANTOM_TEST_BROWSER_MODULE;
  if (!moduleEntry) throw new Error("An explicit installed native browser package is required");
  const runtime = await import(pathToFileURL(moduleEntry).href) as Record<"chromium" | "firefox" | "webkit", BrowserType>;
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); response.end(html); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Private fixture listener missing");
  const results: { engine: string; version: string; batch: RecordingBatch }[] = [];
  const player = await startRecordingPlayerHost();
  try {
    for (const engine of ["chromium", "firefox", "webkit"] as const) {
      const browser = await runtime[engine].launch({ headless: true });
      try {
        const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
        const config = { key: `__rp_${randomBytes(16).toString("hex")}`, secret: randomBytes(32).toString("hex") };
        await context.addInitScript(installMaskedRecorder, config);
        const page = await context.newPage();
        const pageFaults: string[] = []; page.on("pageerror", error => pageFaults.push(error.message));
        await page.goto(`http://127.0.0.1:${address.port}/`);
        const handle = await page.evaluateHandle(key => (window as unknown as Record<string, MaskedProducer>)[key], config.key) as JSHandle<MaskedProducer>;
        expect(await handle.evaluate(value => typeof value.pull)).toBe("function");
        const beforePull = Date.now();
        const firstPull = parseProducerPull(await handle.evaluate((value, secret) => value.pull(secret, 0, 1, 0), config.secret));
        const afterPull = Date.now();
        const response = await fetch(`${player.origin}/fixture/admit`, { method: "POST", headers: { ...player.headers, "content-type": "application/json" }, body: JSON.stringify({ runId: `fixture-run-${engine}`, sessionId: randomBytes(16).toString("hex"), engine, engineVersion: browser.version(), startedAt: firstPull.clock.anchorEpochMs, clockOffsetMs: (beforePull + afterPull) / 2 - firstPull.clock.nowEpochMs, clockUncertaintyMs: (afterPull - beforePull) / 2 + 1 }) });
        expect(response.status).toBe(200); const lease = await response.json() as RecordingLease;
        let sequence = 0;
        const retain = async (raw: string) => {
          expect(raw).not.toContain(privateToken); const batch = parseRecordingBatch(raw);
          expect(batch.sequence).toBe(sequence);
          const publication = await fetch(`${player.origin}/fixture/recordings/${lease.summary.id}/publish`, { method: "POST", headers: player.headers, body: raw });
          expect(publication.status).toBe(200); expect(await publication.json()).toEqual({ accepted: true, duplicate: false });
          results.push({ engine, version: browser.version(), batch }); sequence++; return batch;
        };
        if (firstPull.batch) await retain(firstPull.batch);
        await expect.poll(async () => {
          const result = parseProducerPull(await handle.evaluate((value, args) => value.pull(args.secret, args.sequence, 1, 0), { secret: config.secret, sequence }));
          if (!result.batch) return false;
          const batch = await retain(result.batch);
          return batch.events.some(event => event.kind === 0 && event.nodes.some(node => node.rect[2] === 120));
        }, { timeout: 5000 }).toBe(true);
        await page.locator("#field").fill(privateToken);
        await page.locator("#box").click();
        await page.locator("#field").focus();
        await page.evaluate(() => {
          document.getElementById("box")!.style.width = "260px";
          Element.prototype.getBoundingClientRect = () => { throw new Error("poisoned page rect"); };
          window.getComputedStyle = () => { throw new Error("poisoned page style"); };
          JSON.stringify = () => "SYNTHETIC_RECORDING_SECRET_3917";
          Array.prototype.push = () => { throw new Error("poisoned page array"); };
          Date.now = () => 0;
          Object.defineProperty(performance, "now", { value: () => NaN });
          Object.defineProperty(Object.prototype, "toJSON", { value: () => "SYNTHETIC_RECORDING_SECRET_3917", configurable: true });
        });
        await page.keyboard.type("native-input");
        await expect.poll(async () => {
          const result = parseProducerPull(await handle.evaluate((value, args) => value.pull(args.secret, args.sequence, 1, 0), { secret: config.secret, sequence }));
          if (!result.batch) return false;
          const batch = await retain(result.batch);
          return batch.events.some(event => event.kind === 0 && event.nodes.some(node => node.rect[2] === 260));
        }, { timeout: 5000 }).toBe(true);
        const kinds = results.filter(result => result.engine === engine).flatMap(result => result.batch.events.map(event => event.kind));
        for (const kind of [0, 2, 3, 7, 8]) expect(kinds).toContain(kind);
        expect(pageFaults).toEqual([]);
        await expect(handle.evaluate(value => value.pull("wrong-token", 0, 1, 0))).rejects.toThrow("Recorder authority refused");
        await handle.evaluate((value, secret) => value.stop(secret), config.secret);
        const stopped = parseProducerPull(await handle.evaluate((value, args) => value.pull(args.secret, args.sequence, 1, 0), { secret: config.secret, sequence }));
        expect(stopped.stopped).toBe(true);
        expect(stopped.reason).toBe("none");
        if (stopped.batch) await retain(stopped.batch);
        const snapshot = await fetch(`${player.origin}/fixture/recordings/${lease.summary.id}`); expect(snapshot.status).toBe(200);
        const saved = await snapshot.json() as { entries: { batch: RecordingBatch; digest: string }[] };
        expect(saved.entries.length).toBe(sequence);
        for (const entry of saved.entries) expect(createHash("sha256").update(JSON.stringify(entry.batch)).digest("hex")).toBe(entry.digest);
        const playerContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
        const viewer = await playerContext.newPage(), viewerFaults: string[] = [], foreignRequests: string[] = [];
        viewer.on("pageerror", error => viewerFaults.push(error.message));
        viewer.on("request", request => { if (!request.url().startsWith(player.origin) && !request.url().startsWith("about:")) foreignRequests.push(request.url()); });
        await viewer.goto(`${player.origin}/?id=${lease.summary.id}`);
        await expect(viewer.getByRole("heading", { name: "Masked layout recording" })).toBeVisible();
        const iframe = viewer.locator("iframe"); await expect(iframe).toHaveAttribute("sandbox", "");
        const savedFrames = saved.entries.flatMap(entry => entry.batch.events.filter(event => event.kind === 0));
        await expect(iframe).toHaveAttribute("data-recorded-frame", String(savedFrames[0].ordinal));
        const baselineFrame = savedFrames.find(frame => frame.nodes.some(node => node.rect[2] === 120))!;
        const changedFrame = savedFrames.find(frame => frame.nodes.some(node => node.rect[2] === 260))!;
        const cursor = viewer.getByRole("slider", { name: "Recording cursor" }), sliderBox = (await cursor.boundingBox())!;
        const retainedEnd = saved.entries[saved.entries.length - 1].batch.events.at(-1)!.epochMs;
        const midpoint = (baselineFrame.epochMs + changedFrame.epochMs) / 2;
        await cursor.click({ position: { x: sliderBox.width * (midpoint - savedFrames[0].epochMs) / (retainedEnd - savedFrames[0].epochMs), y: sliderBox.height / 2 } });
        await expect(viewer.frameLocator("iframe").locator('rect[width="120"]')).toHaveCount(1);
        await cursor.focus(); await cursor.press("End");
        await expect(viewer.frameLocator("iframe").locator('rect[width="260"]')).toHaveCount(1);
        await expect(viewer.locator("[data-cursor-notifications]")).toHaveText("2");
        await viewer.getByRole("button", { name: "External cursor update" }).click(); await expect(viewer.locator("[data-cursor-notifications]")).toHaveText("2");
        await cursor.focus(); await cursor.press("Home"); await viewer.getByRole("button", { name: "Play recording", exact: true }).click();
        await expect.poll(async () => Number(await viewer.locator("[data-cursor-notifications]").textContent())).toBeGreaterThan(2);
        await viewer.getByRole("button", { name: "Stop recording", exact: true }).click();
        await expect(viewer.locator("[data-masked-recording]")).toContainText("complete");
        const download = viewer.waitForEvent("download"); await viewer.getByRole("button", { name: "Export masked data" }).click();
        const exported = await download; const exportPath = info.outputPath(`native-${engine}-export.json`); await exported.saveAs(exportPath);
        const exportSource = await (await import("node:fs/promises")).readFile(exportPath, "utf8"); expect(exportSource).not.toContain(privateToken); expect(JSON.parse(exportSource).entries).toEqual(saved.entries);
        await viewer.evaluate(() => document.fonts.ready);
        const loadedFonts = await viewer.evaluate(() => Array.from(document.fonts).filter(face => face.status === "loaded").map(face => face.family.replaceAll('"', '')));
        expect(loadedFonts).toContain("Inter Variable"); expect(loadedFonts).toContain("Syne");
        for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [768, 1024], [390, 844], [320, 740]]) {
          await viewer.setViewportSize({ width, height }); expect(await viewer.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
          const screenshot = info.outputPath(`native-${engine}-player-${width}.png`); await viewer.screenshot({ path: screenshot, fullPage: true });
        }
        expect(await viewer.locator("[data-masked-recording]").evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgb(255, 255, 255)");
        expect(await viewer.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(249, 250, 252)");
        expect(await viewer.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--rp-accent").trim().toLowerCase())).toBe("#0021cc");
        await viewer.setViewportSize({ width: 1280, height: 800 });
        const unzoomedHeight = await viewer.getByRole("button", { name: "Play recording", exact: true }).evaluate(element => element.getBoundingClientRect().height);
        await viewer.evaluate(() => { document.documentElement.style.zoom = "2"; });
        await expect.poll(() => viewer.getByRole("button", { name: "Play recording", exact: true }).evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(unzoomedHeight * 1.9);
        expect(await viewer.evaluate(() => document.documentElement.scrollWidth)).toBe(1280);
        await cursor.focus(); await cursor.press("Tab"); await expect(viewer.getByRole("button", { name: "Play recording", exact: true })).toBeFocused();
        await expect.poll(() => viewer.getByRole("button", { name: "Play recording", exact: true }).evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(unzoomedHeight * 1.9);
        await viewer.screenshot({ path: info.outputPath(`native-${engine}-css200-keyboard.png`), fullPage: true });
        await viewer.evaluate(() => { document.documentElement.style.zoom = ""; });
        expect(viewerFaults).toEqual([]); expect(foreignRequests).toEqual([]);
        await viewer.getByRole("button", { name: "Delete recording", exact: true }).click(); await expect(iframe).toHaveCount(0);
        expect((await fetch(`${player.origin}/fixture/recordings/${lease.summary.id}`)).status).toBe(410);
        await playerContext.close();
        await handle.dispose(); await context.close();
      } finally { await browser.close(); }
    }
    const proof = info.outputPath("native-masked-recordings.json");
    await writeFile(proof, JSON.stringify(results, null, 2));
    await info.attach("native-masked-recordings.json", { path: proof, contentType: "application/json" });
    const receipt = await fetch(`${player.origin}/fixture/receipt`, { headers: player.headers }); expect(receipt.status).toBe(200);
    const readonly = await receipt.json(); expect(readonly.batches).toEqual({ n: 0, bytes: 0 }); expect(readonly.population).toEqual({ lifetimes: 3, retained: 0 });
    await writeFile(info.outputPath("native-readonly-store-receipt.json"), JSON.stringify(readonly, null, 2));
  } finally { await player.close(info.outputPath("owned-fixture-cleanup.json")); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); const after = recordingSourcePins(); await writeFile(info.outputPath("source-pins-after.json"), JSON.stringify(after, null, 2)); expect(after).toEqual(pins); }
});

test("native traversal, queue pressure and root replacement remain bounded and visibly partial", async ({}, info) => {
  const pins = recordingSourcePins(); await writeFile(info.outputPath("source-pins-before.json"), JSON.stringify(pins, null, 2));
  const moduleEntry = process.env.RUNPHANTOM_TEST_BROWSER_MODULE;
  if (!moduleEntry) throw new Error("Explicit installed native package required");
  const runtime = await import(pathToFileURL(moduleEntry).href) as Record<"chromium" | "firefox" | "webkit", BrowserType>;
  const populationHtml = '<!doctype html><style>body{margin:0}div{height:1px;background:rgb(0,33,204)}</style><input id="entry">' + `<div>${privateToken}</div>`.repeat(4000);
  const target = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end(populationHtml); });
  await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve)); const address = target.address(); if (!address || typeof address === "string") throw new Error("Fixture listener missing");
  const receipts: unknown[] = [];
  try {
    for (const engine of ["chromium", "firefox", "webkit"] as const) {
      const owned = await runtime[engine].launchServer({ headless: true }), process = owned.process();
      const browser = await runtime[engine].connect(owned.wsEndpoint());
      try {
        const context = await browser.newContext({ viewport: { width: 800, height: 600 } }), page = await context.newPage();
        const config = { key: `__rp_${randomBytes(16).toString("hex")}`, secret: randomBytes(32).toString("hex") };
        await page.addInitScript(installMaskedRecorder, config); await page.goto(`http://127.0.0.1:${address.port}`);
        let handle = await page.evaluateHandle(key => (window as unknown as Record<string, MaskedProducer>)[key], config.key) as JSHandle<MaskedProducer>;
        let sequence = 0; const batches: RecordingBatch[] = [];
        const pull = async () => {
          const result = parseProducerPull(await handle.evaluate((producer, args) => producer.pull(args.secret, args.sequence, 1, 0), { secret: config.secret, sequence }));
          if (result.batch) { expect(result.batch).not.toContain(privateToken); const batch = parseRecordingBatch(result.batch); batches.push(batch); sequence++; }
          return result;
        };
        await expect.poll(async () => { await pull(); return batches.some(batch => batch.events.some(event => event.kind === 0 && event.visited === 2000 && event.nodes.length === 256 && event.clipped)); }, { timeout: 5000 }).toBe(true);
        await page.locator("#entry").focus(); await page.keyboard.type("x".repeat(500));
        await handle.evaluate((producer, secret) => producer.stop(secret), config.secret);
        const pressure: ReturnType<typeof parseProducerPull>[] = [];
        for (let count = 0; count < 5; count++) pressure.push(await pull());
        expect(pressure[0]).toMatchObject({ loss: true, reason: "queue", dropped: null });
        expect(pressure.filter(result => result.batch !== null).length).toBeLessThanOrEqual(4);
        expect(pressure.flatMap(result => result.batch ? parseRecordingBatch(result.batch).events : []).length).toBeLessThanOrEqual(256);
        await handle.dispose(); await page.reload();
        handle = await page.evaluateHandle(key => (window as unknown as Record<string, MaskedProducer>)[key], config.key) as JSHandle<MaskedProducer>;
        sequence = 0;
        await expect.poll(async () => { const result = await pull(); return result.batch !== null && parseRecordingBatch(result.batch).events.some(event => event.kind === 0); }, { timeout: 5000 }).toBe(true);
        await page.evaluate(() => document.documentElement.remove());
        await expect.poll(async () => (await pull()).stopped, { timeout: 5000 }).toBe(true);
        const stopped = await pull(); expect(stopped).toMatchObject({ stopped: true, loss: true, reason: "unavailable", dropped: null });
        receipts.push({ engine, version: browser.version(), pid: process.pid, observedNodes: 4000, retained: batches.map(batch => ({ bytes: Buffer.byteLength(JSON.stringify(batch)), sequence: batch.sequence, events: batch.events.length, loss: batch.loss, dropped: batch.dropped })), pressure: { batches: pressure.filter(result => result.batch).length, reason: pressure[0].reason, dropped: pressure[0].dropped } });
        await handle.dispose(); await context.close();
      } finally {
        await browser.close(); await owned.close(); expect(process.exitCode !== null || process.signalCode !== null).toBe(true);
      }
    }
    await writeFile(info.outputPath("native-pressure-readonly-receipts.json"), JSON.stringify(receipts, null, 2));
  } finally { await new Promise<void>(resolve => target.close(() => resolve())); const after = recordingSourcePins(); await writeFile(info.outputPath("source-pins-after.json"), JSON.stringify(after, null, 2)); expect(after).toEqual(pins); }
});

test("selected Chromium uses an isolated native realm and closes only its own observer", async ({}, info) => {
  const pins = recordingSourcePins(); await writeFile(info.outputPath("source-pins-before.json"), JSON.stringify(pins, null, 2));
  const moduleEntry = process.env.RUNPHANTOM_TEST_BROWSER_MODULE; if (!moduleEntry) throw new Error("Explicit native package required");
  const runtime = await import(pathToFileURL(moduleEntry).href) as { chromium: BrowserType };
  const target = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end(html); });
  await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve)); const address = target.address(); if (!address || typeof address === "string") throw new Error("Private target missing");
  const owned = await runtime.chromium.launchServer({ headless: true }), nativeProcess = owned.process(), browser = await runtime.chromium.connect(owned.wsEndpoint());
  try {
    const context = await browser.newContext(), page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
    await page.locator("#field").focus();
    await page.evaluate(() => {
      Element.prototype.getBoundingClientRect = () => { throw new Error("existing page rect poison"); };
      window.getComputedStyle = () => { throw new Error("existing page style poison"); };
      JSON.stringify = () => "SYNTHETIC_RECORDING_SECRET_3917";
      Array.prototype.push = () => { throw new Error("existing page array poison"); };
      Date.now = () => 0; Object.defineProperty(performance, "now", { value: () => NaN });
      Object.defineProperty(Object.prototype, "toJSON", { value: () => "SYNTHETIC_RECORDING_SECRET_3917", configurable: true });
    });
    const client = await context.newCDPSession(page);
    // A controlled single-frame fixture establishes the actual native frame; production discovery is a shared seam.
    const tree = await client.send("Page.getFrameTree"), frameId = tree.frameTree.frame.id;
    let current = true;
    const config = { key: `__rp_${randomBytes(16).toString("hex")}`, secret: randomBytes(32).toString("hex") };
    const observer = await createSelectedMaskedRecorder(client as SelectedRecorderClient, { mainFrameId: frameId, assertCurrent() { if (!current) throw new Error("selected authority revoked"); } }, config);
    let sequence = 0; const batches: RecordingBatch[] = [];
    const pull = async () => { const result = await observer.pull(sequence, 1, 0); if (result.batch) { expect(result.batch).not.toContain(privateToken); batches.push(parseRecordingBatch(result.batch)); sequence++; } return result; };
    await page.keyboard.type("isolated-native-input");
    await expect.poll(async () => { await pull(); return batches.some(batch => batch.events.some(event => event.kind === 0 && event.nodes.some(node => node.rect[2] === 120))); }).toBe(true);
    expect(batches.flatMap(batch => batch.events).some(event => event.kind === 7)).toBe(true);
    expect(await page.evaluate(key => typeof (window as unknown as Record<string, unknown>)[key], config.key)).toBe("undefined");
    const closed = await observer.close(); expect(closed).toEqual({ discarded: true, released: true, joined: true });
    await expect(observer.pull(sequence, 1, 0)).rejects.toThrow("authority closed");
    expect(page.isClosed()).toBe(false); expect(browser.isConnected()).toBe(true); expect(context.pages()).toContain(page);
    // A second actual isolated observer is fenced by current authority before retained data can return.
    const second = await createSelectedMaskedRecorder(client as SelectedRecorderClient, { mainFrameId: frameId, assertCurrent() { if (!current) throw new Error("selected authority revoked"); } }, config);
    current = false; await expect(second.pull(0, 1, 0)).rejects.toThrow("authority changed");
    const revokedClose = await second.close(); expect(revokedClose).toEqual({ discarded: true, released: true, joined: true });
    expect(page.isClosed()).toBe(false);
    current = true;
    let release!: () => void, arrived!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), observed = new Promise<void>(resolve => { arrived = resolve; });
    let pullDispatches = 0;
    const paused: SelectedRecorderClient = { async send(method, params) {
      if (method === "Runtime.callFunctionOn" && typeof params.functionDeclaration === "string" && params.functionDeclaration.includes("return this.pull")) pullDispatches++;
      const actual = await (client as SelectedRecorderClient).send(method, params);
      if (method === "Runtime.callFunctionOn" && typeof params.functionDeclaration === "string" && params.functionDeclaration.includes("return this.pull")) { arrived(); await held; }
      return actual;
    } };
    const late = await createSelectedMaskedRecorder(paused, { mainFrameId: frameId, assertCurrent() { if (!current) throw new Error("selected authority revoked"); } }, config);
    const response = late.pull(0, 1, 0); void response.catch(() => {}); await observed;
    const parallel = late.pull(0, 1, 0).then(() => "accepted", (cause: Error) => cause.message);
    const parallelOutcome = await Promise.race([parallel, new Promise<string>(resolve => setTimeout(() => resolve("native pending"), 200))]);
    current = false; release();
    await expect(response).rejects.toThrow("authority changed");
    const lateClose = await late.close(); expect(lateClose).toEqual({ discarded: true, released: true, joined: true }); await parallel;
    expect(parallelOutcome).toBe("Selected recorder operation is busy"); expect(pullDispatches).toBe(1);
    expect(page.isClosed()).toBe(false); current = true;
    let finishInstall!: () => void, installed!: () => void, installedObject = "";
    const installationHeld = new Promise<void>(resolve => { finishInstall = resolve; }), installationObserved = new Promise<void>(resolve => { installed = resolve; });
    const pausedInstall: SelectedRecorderClient = { async send(method, params) {
      const actual = await (client as SelectedRecorderClient).send(method, params);
      if (method === "Runtime.evaluate") { installedObject = (actual as { result: { objectId: string } }).result.objectId; installed(); await installationHeld; }
      return actual;
    } };
    const lateInstallation = createSelectedMaskedRecorder(pausedInstall, { mainFrameId: frameId, assertCurrent() { if (!current) throw new Error("selected authority revoked"); } }, config); void lateInstallation.catch(() => {});
    await installationObserved; await expect(lateInstallation).rejects.toThrow("response timed out"); current = false; finishInstall();
    await expect.poll(async () => {
      try { await client.send("Runtime.callFunctionOn", { objectId: installedObject, functionDeclaration: "function(){return 1}", returnByValue: true }); return false; } catch { return true; }
    }, { timeout: 5000 }).toBe(true);
    expect(page.isClosed()).toBe(false); current = true;
    const third = await createSelectedMaskedRecorder(client as SelectedRecorderClient, { mainFrameId: frameId, assertCurrent() { if (!current) throw new Error("selected authority revoked"); } }, config);
    await page.evaluate(() => document.documentElement.remove());
    await expect.poll(async () => (await third.pull(0, 1, 0)).stopped).toBe(true);
    expect((await third.pull(1, 1, 0)).reason).toBe("unavailable");
    expect(await third.close()).toEqual({ discarded: true, released: true, joined: true }); await client.detach();
    expect(page.isClosed()).toBe(false); expect(browser.isConnected()).toBe(true);
    await writeFile(info.outputPath("selected-isolated-native-receipt.json"), JSON.stringify({ engine: "chromium", version: browser.version(), pid: nativeProcess.pid, frameId, windowPropertyPublished: false, batches, close: closed, revokedClose, lateClose, lateTimedOutInstallationReleased: true, externalPageAlive: !page.isClosed(), externalBrowserAlive: browser.isConnected(), scope: "controlled Chromium selected-realm component; production discovery not yet registered" }, null, 2));
    await context.close();
  } finally { await browser.close(); await owned.close(); expect(nativeProcess.exitCode !== null || nativeProcess.signalCode !== null).toBe(true); await new Promise<void>(resolve => target.close(() => resolve())); const after = recordingSourcePins(); await writeFile(info.outputPath("source-pins-after.json"), JSON.stringify(after, null, 2)); expect(after).toEqual(pins); }
});
