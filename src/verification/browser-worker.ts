/** Optional runtime adapter. Only reviewed fixed helpers execute in the target document. */
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync, readdirSync, statSync, chmodSync, unlinkSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BROWSER_LIMITS as L, browserObject, browserId, parseBrowserAction,
  parseBrowserOpen, parseBrowserTarget, parseWorkerFrame, scrubBrowserSecrets, type BrowserTarget, type WorkerFrame, type BrowserAction } from "./browser-contract";
import { validateOrigin } from "./validation";
import { sanitizeWithReport } from "./serialization";
import { createBrowserTransport, type BrowserTransportRequest, type BrowserTransportRoute } from "./browser-transport";

// The optional package is host-selected, dynamically loaded and checked at this one seam.
// These narrow structural shapes avoid adding a product dependency on its development types.
type PW = Record<string, any>;
interface Host { nonce: string; moduleEntry: string; ownership: "owned" | "attached"; spool: string; cdpEndpoint?: string; assetOrigins: string[]; controlOrigins: string[] }
const emptyCoverage = () => ({ network: false, console: false, dom: false, state: false, signal: false, route: false });
const opaque = () => randomBytes(16).toString("hex");

// Qualified page-world condition only; the independent native navigation
// receipt and current worker authority remain necessary for acknowledgment.
function installOwnedDocumentCondition(key: string): void {
  const doc = document, apply = Reflect.apply,
    descriptor: (object: object, key: PropertyKey) => (Omit<PropertyDescriptor, "get"> & { get?: PropertyDescriptor["get"] }) | undefined = Object.getOwnPropertyDescriptor;
  if (descriptor(window, "document")?.configurable !== false) return;
  const get = (prototype: object, name: string) => descriptor(prototype, name)!.get!;
  const rootGet = get(Document.prototype, "documentElement"), connected = get(Node.prototype, "isConnected"), owner = get(Node.prototype, "ownerDocument"), type = get(Node.prototype, "nodeType");
  const target = get(MutationRecord.prototype, "target"), added = get(MutationRecord.prototype, "addedNodes"), removed = get(MutationRecord.prototype, "removedNodes");
  const length = get(NodeList.prototype, "length"), item = (NodeList.prototype as { item: NodeList["item"] }).item, eventTarget = get(Event.prototype, "target");
  const listen = (EventTarget.prototype as { addEventListener: EventTarget["addEventListener"] }).addEventListener,
    observe = (MutationObserver.prototype as { observe: MutationObserver["observe"] }).observe, take = (MutationObserver.prototype as { takeRecords: MutationObserver["takeRecords"] }).takeRecords;
  let root = apply(rootGet, doc, []), lost = false, loaded = false;
  const process = (records: MutationRecord[]) => { for (let i = 0; i < records.length; i++) {
    const record = records[i]; if (apply(target, record, []) !== doc) continue;
    const removals = apply(removed, record, []); for (let j = 0; j < apply(length, removals, []); j++) if (apply(item, removals, [j]) === root && root) lost = true;
    const additions = apply(added, record, []); for (let j = 0; j < apply(length, additions, []); j++) {
      const node = apply(item, additions, [j]); if (apply(type, node, []) !== 1) continue; if (!root) root = node; else if (node !== root) lost = true;
    }
  } };
  const observer = new MutationObserver(process); apply(observe, observer, [doc, { childList: true }]);
  apply(listen, doc, ["DOMContentLoaded", (event: Event) => {
    const trusted = descriptor(event, "isTrusted");
    if (trusted?.configurable === false && (trusted.get ? apply(trusted.get, event, []) : trusted.value) === true && apply(eventTarget, event, []) === doc) { if (loaded) lost = true; loaded = true; }
  }, { capture: true }]);
  Object.defineProperty(doc, key, { configurable: false, enumerable: false, get() {
    process(apply(take, observer, []));
    return lost ? "lost" : loaded && root && apply(rootGet, doc, []) === root && apply(connected, root, []) && apply(owner, root, []) === doc ? "intact" : "pending";
  } });
}

export async function runBrowserWorker(): Promise<void> {
  let host: Host;
  try {
    const b = browserObject(JSON.parse(process.env.RUNPHANTOM_BROWSER_WORKER ?? "null"), ["nonce", "moduleEntry", "ownership", "spool", "cdpEndpoint", "assetOrigins", "controlOrigins"]);
    if (typeof b.nonce !== "string" || !/^[0-9a-f]{64}$/.test(b.nonce) || !path.isAbsolute(b.moduleEntry as string) || !path.isAbsolute(b.spool as string)
      || !["owned", "attached"].includes(b.ownership as string) || !Array.isArray(b.assetOrigins) || !Array.isArray(b.controlOrigins)) throw new Error();
    host = b as unknown as Host;
  } catch { process.exitCode = 1; return; }
  delete process.env.RUNPHANTOM_BROWSER_WORKER;
  let runtime: PW | null = null, server: PW | null = null, browser: PW | null = null, context: PW | null = null, page: PW | null = null, recording: PW | null = null;
  let generation = 0, origin: string | null = null, currentAction: string | undefined, busy = false, closing = false;
  let documentEpoch = 0, transport: ReturnType<typeof createBrowserTransport> | undefined;
  let lastNavigation: BrowserTransportRequest | undefined;
  let ownedDocumentKey: string | undefined;
  interface InitialNavigation {
    token: string; selected: PW; context: PW; url: string; generation: number; epoch: number;
    request?: BrowserTransportRequest; response?: PW; commits: number; loads: number; superseded: boolean; acknowledged: boolean;
    receipt: Promise<boolean>; settle(result: boolean): void;
    transportReceipt: Promise<boolean>; finish(result: boolean): void;
  }
  let initialNavigation: InitialNavigation | undefined;
  let engine = "chromium", engineVersion = "", loss = false, video = "off", revision = opaque();
  let recorderTimer: ReturnType<typeof setTimeout> | undefined, spoolTimer: ReturnType<typeof setInterval> | undefined;
  let lastActivity = Date.now();
  const secrets: string[] = [], pages = new Map<string, PW>(), requests = new Map<object, { id: string; actionId?: string; generation: number; url: string; method: string; status?: number }>();
  const listeners: Array<{ target: PW; event: string; fn: (...args: any[]) => void }> = [];
  const finalArtifacts: Array<{ file: string; kind: "video"; raw: true }> = [];
  let coverage = emptyCoverage();
  const foreignQualified = () => host.ownership === "owned" && engine === "chromium" && engineVersion === "151.0.7922.34" && !!context;
  const compatibility = () => ({ qualification: "initial-only", sameOrigin: host.ownership === "owned" && engine !== "webkit" ? "cookie-free-or-controlled-cookies" : "cookie-free",
    foreign: foreignQualified() ? "conditional-cookie-free-get-head" : "unavailable", webSocket: host.ownership === "owned" ? "denied" : "unqualified", redirects: "unavailable" });
  const send = (payload: Record<string, unknown>, event = false): void => {
    if (event && process.stdout.writableLength > 1024 * 1024) { loss = true; return; }
    const raw = JSON.stringify({ formatVersion: 1, nonce: host.nonce, generation, ...payload }) + "\n";
    if (Buffer.byteLength(raw) > L.FRAME_BYTES) { loss = true; return; }
    process.stdout.write(raw);
  };
  const state = (stateName = page && !page.isClosed() ? "ready" : "closed") => send({ kind: "state", state: { origin, engine, engineVersion, state: stateName, coverage, pending: requests.size, loss, video, lastActivity, networkProfile: "bounded-http-v1", compatibility: compatibility() } });
  const event = (type: string, data: Record<string, unknown>, actionId = currentAction): void => {
    const sanitized = sanitizeWithReport(data, { scrubString: text => scrubBrowserSecrets(text, secrets) });
    const safeData = sanitized.value as Record<string, unknown>;
    // Recorder discriminators are not page values. A filled word such as "error"
    // must not erase an error level and invert a console-absence verdict.
    for (const key of type === "console" ? ["level"] : type.startsWith("network") ? ["requestId", "method", "status", "failed", "resourceType"] : type === "dom" ? ["count"] : []) {
      if (Object.hasOwn(data, key)) safeData[key] = data[key];
    }
    const e = { type, data: safeData, ...(actionId ? { actionId } : {}), ...(sanitized.redacted || sanitized.truncation ? { truncated: true } : {}) };
    if (Buffer.byteLength(JSON.stringify(e)) > 16 * 1024) { loss = true; state(); return; }
    if (type !== "dom") lastActivity = Date.now(); send({ kind: "event", event: e }, true);
  };
  const listen = (target: PW, name: string, fn: (...args: any[]) => void) => { target.on(name, fn); listeners.push({ target, event: name, fn }); };
  const allowed = (raw: string, navigation = false): boolean => {
    try {
      const url = new URL(raw);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !host.controlOrigins.includes(url.origin)
        && (url.origin === origin || !navigation && host.assetOrigins.includes(url.origin));
    } catch { return false; }
  };
  let routeHandler: ((route: PW) => Promise<void>) | undefined;
  const install = async (selected: PW): Promise<void> => {
    page = selected;
    const selectedContext: PW = selected.context();
    coverage = { network: host.ownership === "owned", console: true, dom: true, state: false, signal: false, route: true };
    listen(selected, "request", (request: PW) => {
      if (request.isNavigationRequest() && request.frame() === selected.mainFrame()) {
        lastNavigation = request as BrowserTransportRequest;
        if (initialNavigation) {
          if (!initialNavigation.request && String(request.url()) === initialNavigation.url) initialNavigation.request = request as BrowserTransportRequest;
          else if (initialNavigation.request !== request) { initialNavigation.superseded = true; initialNavigation.settle(false); transport?.fence(); }
        }
      }
      if (requests.size >= L.REQUESTS) { loss = true; event("capture.loss", { reason: "request-limit" }); state(); return; }
      const info = { id: opaque(), generation, url: String(request.url()), method: String(request.method()), ...(currentAction ? { actionId: currentAction } : {}) };
      requests.set(request, info); event("network.start", { requestId: info.id, url: info.url, method: info.method }, info.actionId); state();
    });
    const finish = (request: PW, status?: number) => {
      const info = requests.get(request); if (!info) return;
      requests.delete(request);
      const record = initialNavigation;
      const finishEvent = () => {
        // The exact worker-created initial goto has one native commit. Its
        // receipt acknowledges bookkeeping only; no request authority survives.
        const ownInitial = record && record.request === request && !info.actionId && info.generation === record.generation && record.acknowledged
          && !record.superseded && record.commits === 1 && generation === record.generation + 1 && documentEpoch === record.epoch + 1
          && lastNavigation === request && page === selected && selected.context() === selectedContext && !selected.isClosed() && selected.url() === record.url;
        if (info.generation === generation || ownInitial) event("network", { requestId: info.id, url: info.url, method: info.method, ...(status === undefined ? { failed: true } : { status }), resourceType: String(request.resourceType()) }, info.actionId);
        else { loss = true; event("capture.loss", { reason: "request-generation-change" }); }
        state();
      };
      if (record?.request === request && !record.acknowledged) void record.receipt.then(finishEvent);
      else finishEvent();
    };
    listen(selected, "response", (response: PW) => {
      const info = requests.get(response.request()); if (info) info.status = Number(response.status());
      if (initialNavigation && initialNavigation.request === response.request()) initialNavigation.response = response;
    });
    listen(selected, "requestfinished", (request: PW) => finish(request, requests.get(request)?.status));
    listen(selected, "requestfailed", (request: PW) => finish(request));
    listen(selected, "domcontentloaded", () => {
      if (!initialNavigation) return;
      initialNavigation.loads++;
      if (initialNavigation.loads > 1) { initialNavigation.superseded = true; initialNavigation.settle(false); transport?.fence(); }
    });
    listen(selected, "console", (message: PW) => event("console", { level: message.type() === "warning" ? "warn" : String(message.type()), message: String(message.text()) }));
    listen(selected, "pageerror", () => event("console", { level: "error", message: "Uncaught target application error" }));
    listen(selected, "framenavigated", (frame: PW) => {
      if (frame !== selected.mainFrame()) return;
      generation++; documentEpoch++; currentAction = undefined;
      const url = String(frame.url());
      if (initialNavigation) {
        const ownCommit = initialNavigation.selected === selected && initialNavigation.context === selectedContext && initialNavigation.request === lastNavigation
          && initialNavigation.response?.request() === initialNavigation.request && initialNavigation.commits === 0 && url === initialNavigation.url;
        if (ownCommit) initialNavigation.commits++;
        else { initialNavigation.superseded = true; initialNavigation.settle(false); }
      }
      transport?.fence();
      if (!allowed(url, true)) { loss = true; coverage = emptyCoverage(); event("capture.loss", { reason: "navigation-policy" }); }
      else event("route", { url });
      state();
    });
    listen(selected, "close", () => { transport?.close(); initialNavigation?.settle(false); generation++; documentEpoch++; currentAction = undefined; coverage = emptyCoverage(); state("closed"); });
    listen(selected, "popup", (popup: PW) => {
      // Popup is created by this owned action, never an enumerated attached sibling.
      void popup.close().catch(() => {}); loss = true; event("capture.loss", { reason: "popup-denied" }); state();
    });
    listen(selected, "download", (download: PW) => { void download.cancel().catch(() => {}); loss = true; event("capture.loss", { reason: "download-denied" }); state(); });
    listen(selected, "filechooser", () => { loss = true; event("capture.loss", { reason: "file-input-denied" }); state(); });
    transport = createBrowserTransport({ origin: origin!, assets: host.assetOrigins, controlOrigins: host.controlOrigins,
      engine: engine as "chromium" | "firefox" | "webkit", ownership: host.ownership, foreignQualified: foreignQualified(), cookies: url => selectedContext.cookies(url),
      onRefusal: reason => { loss = true; event("capture.loss", { reason: reason === "origin-policy" ? "request-policy" : reason }); state(); },
      authority: request => {
        const capturedGeneration = generation, capturedEpoch = documentEpoch, capturedOrigin = origin;
        const initial = initialNavigation?.request === request ? initialNavigation : undefined;
        const initialToken = initial?.token;
        const sameSelection = () => !closing && page === selected && !selected.isClosed() && selected.context() === selectedContext && origin === capturedOrigin;
        const current = () => {
          try {
            const native = request as unknown as PW;
            return sameSelection() && generation === capturedGeneration && documentEpoch === capturedEpoch && native.frame().page() === selected
              && (!initial || !initial.superseded && lastNavigation === request)
              && (allowed(String(selected.url()), true) || !!initial && selected.url() === "about:blank");
          } catch { return false; }
        };
        const pendingCommit = () => !!initial && sameSelection() && initialNavigation === initial && initial.token === initialToken && !initial.superseded && initial.request === request
          && lastNavigation === request && initial.commits <= 1 && generation === initial.generation + initial.commits && documentEpoch === initial.epoch + initial.commits
          && (initial.commits === 0 || initial.response?.request() === request && selected.url() === initial.url);
        return { current, ...(initial ? { initial: { pendingCommit, acknowledge: async () => {
          if (!await initial.receipt || !pendingCommit() || initial.commits !== 1 || initial.loads !== 1 || !ownedDocumentKey) return false;
          const key = ownedDocumentKey;
          const condition: unknown = await selected.evaluate((key: string) => (document as unknown as Record<string, unknown>)[key], key);
          return condition === "intact" && ownedDocumentKey === key && pendingCommit() && initial.commits === 1 && initial.loads === 1;
        }, finish: completed => initial.finish(completed) } } : {}) };
      } });
    routeHandler = route => transport!.handler(route as unknown as BrowserTransportRoute);
    // Attached policy touches only the explicitly selected page; no context init or routing.
    if (host.ownership === "owned") await context!.route("**/*", routeHandler);
    else await selected.route("**/*", routeHandler);
    if (host.ownership === "owned") {
      if (typeof selectedContext.routeWebSocket !== "function") throw new Error("websocket");
      await selectedContext.routeWebSocket("**/*", (route: PW) => { route.close(); loss = true; event("capture.loss", { reason: "websocket-denied" }); state(); });
    }
  };
  let startup: Promise<unknown> | undefined;
  let closePromise: Promise<boolean> | undefined;
  const closeRuntime = (): Promise<boolean> => closePromise ??= (async () => {
    transport?.close(); initialNavigation?.settle(false);
    closing = true; generation++; currentAction = undefined; coverage = emptyCoverage();
    // Startup may have created an owned process before its promise resolves. Fence first,
    // then await that one bounded startup before confirming its teardown.
    await startup?.catch(() => {});
    if (recorderTimer) clearTimeout(recorderTimer); if (spoolTimer) clearInterval(spoolTimer);
    for (const item of listeners.splice(0)) item.target.off(item.event, item.fn);
    let confirmed = true;
    if (host.ownership === "attached" && page && routeHandler && !page.isClosed()) await page.unroute("**/*", routeHandler).catch(() => { confirmed = false; });
    if (host.ownership === "owned" && context) {
      await context.close().catch(() => {});
      if (video !== "off") {
        video = "stopped";
        // The owned BrowserServer is a remote Playwright connection. Its artifact
        // must be transferred with saveAs after flush, not inferred from a path.
        const file = `${randomUUID()}.webm`, destination = path.join(host.spool, file);
        try {
          if (!recording) throw new Error("recording");
          await recording.saveAs(destination); chmodSync(destination, 0o600);
          const bytes = statSync(destination).size;
          if (bytes <= L.VIDEO_BYTES && bytes > 0) finalArtifacts.push({ file, kind: "video", raw: true });
          else { unlinkSync(destination); loss = true; }
          await recording.delete();
        } catch { loss = true; try { unlinkSync(destination); } catch {} }
      }
    }
    await browser?.close().catch(() => { if (host.ownership === "attached") confirmed = false; }); // Attached client disconnects; its preexisting contexts survive.
    if (server) {
      try { await server.close(); } catch { try { await server.kill(); } catch { confirmed = false; } }
      const child = server.process();
      if (child.exitCode === null && child.signalCode === null) confirmed = false;
    }
    browser = null; context = null; page = null; requests.clear(); state("closed");
    return confirmed;
  })();
  const locator = (target: BrowserTarget): PW => {
    if (!page || page.isClosed()) throw new Error("page");
    switch (target.kind) {
      case "css": return page.locator(target.selector);
      case "role": return page.getByRole(target.role, { name: target.name, exact: true });
      case "label": return page.getByLabel(target.label, { exact: true });
      case "test-id": return page.getByTestId(target.testId);
    }
  };
  const resolve = async (target: BrowserTarget): Promise<PW> => {
    const found = locator(target);
    if (await found.count() !== 1) throw new Error("target");
    const handle = await found.elementHandle({ timeout: L.ACTION_MS });
    if (!handle || await handle.ownerFrame() !== page!.mainFrame() || !await handle.isVisible() || !await handle.isEnabled()) { await handle?.dispose(); throw new Error("target"); }
    const eligible = await handle.evaluate((element: Element) => {
      const get = Element.prototype.getAttribute.bind(element);
      return element.isConnected && element.ownerDocument === document && !element.closest("[data-runphantom-private],[data-private]")
        && !(element.tagName === "INPUT" && get("type")?.toLowerCase() === "file");
    });
    if (!eligible) { await handle.dispose(); throw new Error("target"); }
    return handle;
  };
  const action = async (command: BrowserAction, expected: number, actionId: string): Promise<Record<string, unknown>> => {
    let handle: PW | null = null, destination: PW | null = null, dispatched = false;
    const deadline = Date.now() + L.ACTION_MS;
    const timeout = () => ({ timeout: Math.max(1, deadline - Date.now()) });
    try {
      if (closing || expected !== generation || !page || page.isClosed() || !allowed(String(page.url()), true)) throw new Error("generation");
      if (command.type === "fill") {
        if (secrets.length >= L.SECRET_COUNT || secrets.reduce((n, s) => n + Buffer.byteLength(s), 0) + Buffer.byteLength(command.value) > L.SECRET_BYTES) throw new Error("privacy");
        if (command.value && !secrets.includes(command.value)) secrets.push(command.value);
      }
      handle = await resolve(command.target);
      let selection: { label: string } | undefined;
      if (command.type === "fill") {
        const writable = await handle.evaluate((element: Element) => {
          if (element.tagName === "TEXTAREA") return !(element as HTMLTextAreaElement).readOnly;
          if (element.tagName !== "INPUT") return false;
          const input = element as HTMLInputElement;
          return ["text", "password", "email", "search", "tel", "url"].includes(input.type) && !input.readOnly;
        });
        if (!writable) throw new Error("control");
      }
      if (command.type === "select") {
        selection = await handle.evaluate((element: Element, value: string) => {
          if (element.tagName !== "SELECT") return null;
          const select = element as HTMLSelectElement;
          if (select.multiple || select.options.length > 100 || select.options.length === 0) return null;
          const options = Array.from(select.options);
          const matching = options.filter(option => option.value === value && !option.disabled && !option.parentElement?.hasAttribute("disabled"));
          if (matching.length !== 1) return null;
          const label = matching[0].label.trim();
          // Native typeahead cannot reliably disambiguate duplicate/prefix labels.
          if (!/^[A-Za-z0-9 ._-]{1,64}$/.test(label) || options.some(option => option !== matching[0] && option.label.trim().toLowerCase().startsWith(label.toLowerCase()))) return null;
          return { label };
        }, command.value) as { label: string } | undefined;
        if (!selection) throw new Error("control");
      }
      if (command.type === "drag") destination = await resolve(command.to);
      if (closing || expected !== generation || !await handle.evaluate((e: Element) => e.isConnected && e.ownerDocument === document)) throw new Error("generation");
      currentAction = actionId; event("action.boundary", { source: "trusted-browser" }, actionId);
      // Mark conservatively before calling input: a timeout may follow partial dispatch.
      if (command.type !== "focus") dispatched = true;
      switch (command.type) {
        case "click": await handle.click(timeout()); break;
        case "hover": await handle.hover(timeout()); break;
        case "focus": await handle.focus(); break;
        case "fill": await handle.fill(command.value, timeout()); break;
        case "press": await handle.press(command.key, timeout()); break;
        case "select": {
          await handle.focus();
          // Reset the browser's finite typeahead interval before the next owned input.
          await new Promise(resolve => setTimeout(resolve, 750));
          if (closing || expected !== generation || !await handle.evaluate((e: Element) => e.isConnected && document.activeElement === e)) throw new Error("generation");
          // Native keyboard only. No selectOption/dispatchEvent/value assignment fallback.
          await handle.type(selection!.label, { ...timeout(), delay: 10 });
          if (await handle.inputValue() !== command.value) throw new Error("select-unavailable");
          break;
        }
        case "drag": {
          const from = await handle.boundingBox(), to = await destination!.boundingBox();
          if (!from || !to) throw new Error("target");
          await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
          await page.mouse.down();
          try { await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 }); }
          finally { await page.mouse.up(); }
          if (Date.now() > deadline) throw new Error("timeout");
          break;
        }
      }
      if (closing || expected !== generation) throw new Error("generation");
      event("action.result", { source: "trusted-browser", dispatch: "completed" }, actionId);
      return { actionId, generationBefore: expected, generationAfter: generation, dispatch: "completed", inputMode: command.type === "focus" ? "none" : "trusted-browser" };
    } catch {
      return { actionId, generationBefore: expected, generationAfter: generation, dispatch: dispatched ? "unknown" : "not-dispatched", inputMode: dispatched ? "unknown" : "none",
        reason: dispatched ? "Input may have started; browser operation did not complete. It was not retried." : "Target, control, privacy budget or current generation unavailable; no input dispatched." };
    } finally { await handle?.dispose().catch(() => {}); await destination?.dispose().catch(() => {}); state(); }
  };
  const handle = async (frame: WorkerFrame): Promise<unknown> => {
    switch (frame.operation) {
      case "open": {
        if (host.ownership !== "owned" || browser) throw new Error("configuration");
        if (closing) throw new Error("closing");
        const open = parseBrowserOpen(frame.data); engine = open.engine; origin = new URL(open.url).origin;
        if (host.controlOrigins.includes(origin)) throw new Error("policy");
        server = await runtime![engine].launchServer({ headless: true, timeout: L.START_MS, host: "127.0.0.1", artifactsDir: host.spool });
        const pid = server!.process()?.pid as unknown;
        if (typeof pid === "number") send({ kind: "process", browserPid: pid });
        if (closing) throw new Error("closing");
        browser = await runtime![engine].connect(server!.wsEndpoint(), { timeout: L.START_MS }); engineVersion = String(browser!.version());
        if (closing) throw new Error("closing");
        context = await browser!.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, serviceWorkers: "block", acceptDownloads: false,
          ...(open.recordVideo ? { recordVideo: { dir: host.spool, size: { width: 1280, height: 720 } } } : {}) });
        if (open.recordVideo) {
          video = "recording";
          recorderTimer = setTimeout(() => { void closeRuntime().catch(() => {}); }, L.VIDEO_MS);
          spoolTimer = setInterval(() => {
            try { if (readdirSync(host.spool).some(file => file.endsWith(".webm") && statSync(path.join(host.spool, file)).size > L.VIDEO_BYTES)) void closeRuntime().catch(() => {}); }
            catch { loss = true; void closeRuntime().catch(() => {}); }
          }, 250);
        }
        if (closing) throw new Error("closing");
        const selected = await context!.newPage();
        if (closing) throw new Error("closing");
        ownedDocumentKey = `rp_${opaque()}`;
        await selected.addInitScript(installOwnedDocumentCondition, ownedDocumentKey);
        if (closing || context !== selected.context() || selected.isClosed() || selected.url() !== "about:blank") throw new Error("closing");
        recording = open.recordVideo ? selected.video() : null; await install(selected);
        if (closing) throw new Error("closing");
        let settle!: (result: boolean) => void;
        let cancel!: (error: Error) => void;
        const cancelled = new Promise<never>((_resolve, reject) => { cancel = reject; }); void cancelled.catch(() => {});
        const receipt = new Promise<boolean>(resolve => { settle = result => { if (!result) cancel(new Error("navigation")); resolve(result); }; });
        let finish!: (result: boolean) => void;
        const transportReceipt = new Promise<boolean>(resolve => { finish = result => { if (!result) cancel(new Error("navigation")); resolve(result); }; });
        const initial: InitialNavigation = { token: opaque(), selected, context: context!, url: open.url, generation, epoch: documentEpoch, commits: 0, loads: 0, superseded: false, acknowledged: false, receipt, settle, transportReceipt, finish };
        initialNavigation = initial;
        const navigation = await Promise.race([selected.goto(open.url, { timeout: L.START_MS, waitUntil: "domcontentloaded" }), cancelled]);
        const committed = !initial.superseded && initialNavigation === initial && initial.request === navigation?.request() && initial.response === navigation
          && lastNavigation === initial.request && initial.commits === 1 && generation === initial.generation + 1 && documentEpoch === initial.epoch + 1 && selected.url() === initial.url;
        initial.acknowledged = committed; initial.settle(committed); if (!committed || !await Promise.race([initial.transportReceipt, cancelled]) || initial.superseded || initial.loads !== 1) throw new Error("navigation"); state();
        if (closing || loss || !allowed(String(selected.url()), true)) throw new Error("policy");
        return { origin, engine, engineVersion, state: "ready", coverage, pending: requests.size, loss, video, lastActivity, networkProfile: "bounded-http-v1", compatibility: compatibility() };
      }
      case "list": {
        browserObject(frame.data, []);
        if (closing) throw new Error("closing");
        if (host.ownership !== "attached" || browser || !host.cdpEndpoint) throw new Error("configuration");
        browser = await runtime!.chromium.connectOverCDP(host.cdpEndpoint, { timeout: L.START_MS, noDefaults: true }); engineVersion = String(browser!.version());
        if (closing) throw new Error("closing");
        const all = browser!.contexts().flatMap((ctx: PW) => ctx.pages()) as PW[];
        pages.clear(); revision = opaque();
        const summaries: Array<{ pageId: string; origin: string }> = [];
        for (const selected of all.slice(0, L.PAGES)) {
          try {
            const url = new URL(String(selected.url())); validateOrigin(url.origin);
            if (host.controlOrigins.includes(url.origin)) continue;
            const pageId = opaque(); pages.set(pageId, selected); summaries.push({ pageId, origin: url.origin });
          } catch { /* Unsafe pages are never selectable. */ }
        }
        return { revision, pages: summaries, capped: all.length > L.PAGES, engineVersion };
      }
      case "select": {
        const b = browserObject(frame.data, ["revision", "pageId"]);
        if (host.ownership !== "attached" || page || b.revision !== revision) throw new Error("selection");
        const selected = pages.get(browserId(b.pageId));
        if (!selected || selected.isClosed()) throw new Error("selection");
        const url = new URL(String(selected.url())); validateOrigin(url.origin); origin = url.origin;
        if (!allowed(url.href, true)) throw new Error("policy");
        generation++; await install(selected);
        if (closing) throw new Error("closing");
        state();
        return { origin, engine, engineVersion, state: "ready", coverage, pending: requests.size, loss, video, lastActivity, networkProfile: "bounded-http-v1", compatibility: compatibility() };
      }
      case "action": {
        const b = browserObject(frame.data, ["action", "actionId"]);
        return await action(parseBrowserAction(b.action), frame.generation, browserId(b.actionId));
      }
      case "read": {
        const b = browserObject(frame.data, ["selectors"]);
        if (!Array.isArray(b.selectors) || b.selectors.length > 50) throw new Error("selectors");
        if (frame.generation !== generation || !page || closing) throw new Error("generation");
        for (const selector of b.selectors) {
          const target = parseBrowserTarget({ kind: "css", selector });
          try { const count = await locator(target).count(); event("dom", { selector, count }); }
          catch { event("observer.error", { observer: "dom", reason: "selector-unavailable" }); }
        }
        return { pending: requests.size, loss, lastActivity };
      }
      case "observe": browserObject(frame.data, []); state(); return { pending: requests.size, loss, lastActivity };
      case "capture": {
        const b = browserObject(frame.data, ["raw", "rawConsent"]);
        if (b.raw !== undefined && typeof b.raw !== "boolean" || b.raw && b.rawConsent !== true || b.rawConsent !== undefined && b.rawConsent !== true) throw new Error("consent");
        if (!page || closing || frame.generation !== generation) throw new Error("generation");
        const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
        if (viewport.width < 1 || viewport.width > L.WIDTH || viewport.height < 1 || viewport.height > L.HEIGHT) throw new Error("viewport");
        const masks: PW[] = [];
        if (!b.raw) {
          const privacy = page.locator("input,textarea,[contenteditable],[data-runphantom-private],[data-private]");
          if (await privacy.count() > 1000) throw new Error("mask-limit");
          masks.push(privacy);
          for (const secret of secrets) { const mask = page.getByText(secret, { exact: false }); if (await mask.count() > 1000) throw new Error("mask-limit"); masks.push(mask); }
          // Bound text inspection before claiming the documented mask scope complete.
          const bounded = await page.evaluate(() => {
            const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
            let nodes = 0, text = 0; while (walker.nextNode()) { nodes++; if (walker.currentNode.nodeType === Node.TEXT_NODE) text += (walker.currentNode.textContent ?? "").length; if (nodes > 10000 || text > 1024 * 1024) return false; } return true;
          });
          if (!bounded) throw new Error("mask-limit");
        }
        const bytes: Buffer = await page.screenshot({ type: "png", fullPage: false, scale: "css", mask: masks, maskColor: "#000000", animations: "disabled", caret: "hide", timeout: L.ACTION_MS });
        if (bytes.length > L.PNG_BYTES || frame.generation !== generation || closing) throw new Error("capture");
        const file = `${randomUUID()}.png`; writeFileSync(path.join(host.spool, file), bytes, { mode: 0o600, flag: "wx" });
        return { file, kind: "screenshot", raw: b.raw === true, maskScope: b.raw ? "none" : "inputs-editable-private-known-secrets" };
      }
      case "close": browserObject(frame.data, []); return { closed: await closeRuntime(), artifacts: finalArtifacts };
    }
  };
  try {
    runtime = await import(pathToFileURL(host.moduleEntry).href) as PW;
    if (["chromium", "firefox", "webkit"].some(name => typeof runtime![name]?.launchServer !== "function") || typeof runtime.chromium?.connectOverCDP !== "function") runtime = null;
  } catch { runtime = null; }
  let input = Buffer.alloc(0), exiting = false;
  const stop = () => {
    if (exiting) return; exiting = true;
    const ownedFallback = setTimeout(() => { if (host.ownership === "owned" && server) void server.kill().catch(() => {}); }, 2500);
    void closeRuntime().finally(() => { clearTimeout(ownedFallback); process.exit(0); });
  };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  process.stdin.on("end", stop);
  process.stdin.on("data", (chunk: Buffer) => {
    if (input.length + chunk.length > L.FRAME_BYTES * 2) { stop(); return; }
    input = Buffer.concat([input, chunk]); let index: number;
    while ((index = input.indexOf(10)) !== -1) {
      const raw = input.subarray(0, index).toString("utf8"); input = input.subarray(index + 1);
      let frame: WorkerFrame; try { frame = parseWorkerFrame(raw, host.nonce); } catch { stop(); return; }
      if (closing && frame.operation !== "close") { send({ kind: "reply", id: frame.id, ok: false, reason: "Browser connection is closing" }); continue; }
      if (busy && frame.operation !== "close") { send({ kind: "reply", id: frame.id, ok: false, reason: "Browser operation is already in progress" }); continue; }
      if (!runtime && frame.operation !== "close") { send({ kind: "reply", id: frame.id, ok: false, reason: "Optional browser runtime is incompatible" }); continue; }
      if (frame.operation !== "open" && frame.operation !== "list" && frame.operation !== "close" && frame.generation !== generation) { send({ kind: "reply", id: frame.id, ok: false, reason: "Browser generation is stale" }); continue; }
      busy = true;
      const operation = handle(frame);
      if (["open", "list", "select"].includes(frame.operation)) startup = operation;
      void operation.then(result => send({ kind: "reply", id: frame.id, ok: true, result })).catch(async () => {
        if (frame.operation === "open" || frame.operation === "list") await closeRuntime();
        send({ kind: "reply", id: frame.id, ok: false, reason: frame.operation === "open" || frame.operation === "list" ? "Browser engine or policy is unavailable" : "Browser operation is unavailable" });
      }).finally(() => { busy = false; });
    }
    if (input.length > L.FRAME_BYTES) stop();
  });
  // stdin keeps this worker alive; shutdown is bounded by the parent lease.
  await new Promise<void>(() => {});
}
