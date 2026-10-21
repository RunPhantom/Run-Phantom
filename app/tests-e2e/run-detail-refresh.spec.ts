import type { Page, TestInfo } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";
import { captureTrace } from "../../tests/fixtures/capture-visibility";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

type DetailObservation = { url: string; aborted: boolean; abortStack?: string; failure?: string };
type RefreshWindow = Window & {
  detailObservations: DetailObservation[];
  daemonSockets: Array<{ open(): void; disconnect(): void; emit(data: unknown): void }>;
};

// Same controlled handshake boundary as connection-readiness.spec.ts; HTTP and
// captured data use the actual daemon, and other WebSockets stay native.
async function observeRefresh(page: Page) {
  // A correction build may be isolated from previously frozen app/dist bytes.
  // Only the real built UI files are served here; daemon/API traffic is untouched.
  const ui = process.env.F49_SOURCE_UI_DIR;
  if (ui) await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return route.fallback();
    const pathname = url.pathname;
    if (["/api/", "/v1/", "/verification/"].some(prefix => pathname.startsWith(prefix))) return route.fallback();
    const candidate = path.resolve(ui, "." + pathname);
    const inside = candidate.startsWith(path.resolve(ui) + path.sep);
    const file = inside && path.extname(candidate) && existsSync(candidate) ? candidate : path.join(ui, "index.html");
    const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff": "font/woff", ".woff2": "font/woff2" };
    return route.fulfill({ body: readFileSync(file), contentType: types[path.extname(file)] ?? "application/octet-stream" });
  });
  await page.addInitScript(() => {
    const target = window as unknown as RefreshWindow;
    const nativeFetch = window.fetch.bind(window);
    target.detailObservations = [];
    window.fetch = function (input, init) {
      const url = input instanceof Request ? input.url : String(input);
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const observation: DetailObservation = { url, aborted: false };
      if (url.includes("/api/runs/detail/")) {
        target.detailObservations.push(observation);
        signal?.addEventListener("abort", () => {
          observation.aborted = true;
          observation.abortStack = new Error("original detail signal aborted").stack;
        }, { once: true });
      }
      const response = nativeFetch(input, init);
      // Observe the original promise without replacing its response or failure.
      void response.catch(error => { observation.failure = String(error); });
      return response;
    };
    const NativeWebSocket = window.WebSocket;
    const sockets: RefreshWindow["daemonSockets"] = [];
    target.daemonSockets = sockets;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(native, args: ConstructorParameters<typeof WebSocket>) {
        const url = new URL(String(args[0]), location.href);
        if (url.host !== location.host || url.pathname !== "/ws") return Reflect.construct(native, args);
        class DaemonSocket extends EventTarget {
          readyState: number = NativeWebSocket.CONNECTING;
          onopen: ((event: Event) => void) | null = null;
          onclose: ((event: Event) => void) | null = null;
          onerror: ((event: Event) => void) | null = null;
          onmessage: ((event: MessageEvent) => void) | null = null;
          send() {}
          open() { this.readyState = NativeWebSocket.OPEN; this.onopen?.(new Event("open")); }
          disconnect() { this.close(); }
          close() { this.readyState = NativeWebSocket.CLOSED; this.onclose?.(new Event("close")); }
          emit(data: unknown) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) })); }
        }
        const socket = new DaemonSocket(); sockets.push(socket); return socket;
      },
    });
  });
}

async function socketAction(page: Page, index: number, action: "open" | "disconnect", data?: unknown) {
  await expect.poll(() => page.evaluate(() => (window as unknown as RefreshWindow).daemonSockets.length)).toBeGreaterThan(index);
  await page.evaluate(({ index, action, data }) => {
    const socket = (window as unknown as RefreshWindow).daemonSockets[index]!;
    if (data) socket.emit(data); else socket[action]();
  }, { index, action, data });
}

function trace(index: number, output: string) {
  const captured = captureTrace(index);
  const attribute = captured.llm.attributes.find(item => item.key === "ai.response.text")!;
  attribute.value = { stringValue: output };
  return captured;
}

async function attachObservations(page: Page, info: TestInfo, failed: unknown[], extra: unknown) {
  await info.attach("original-detail-transport-observations", {
    body: JSON.stringify({ failed, extra, signals: await page.evaluate(() => (window as unknown as RefreshWindow).detailObservations) }, null, 2),
    contentType: "application/json",
  });
}

test("first handshake queues one fresh snapshot without cancelling the held initial HTTP response", async ({ page, request, runPhantom }, info) => {
  await observeRefresh(page);
  const original = trace(3191, "Before handshake captured answer");
  const updated = trace(3191, "Committed before handshake captured answer");
  expect((await request.post(runPhantom.url + "/v1/traces", { data: original.body })).status()).toBe(200);
  const held = gate(), release = gate();
  const failed: Array<{ url: string; error: string | undefined }> = [];
  page.on("requestfailed", request => failed.push({ url: request.url(), error: request.failure()?.errorText }));
  let requests = 0, active = 0, maximumActive = 0;
  await page.route(`**/api/runs/detail/${original.id}`, async route => {
    const number = ++requests;
    maximumActive = Math.max(maximumActive, ++active);
    try {
      const response = await route.fetch();
      if (number === 1) { held.release(); await release.promise; }
      await route.fulfill({ response });
    } finally { active--; }
  });
  try {
    await page.goto(`${runPhantom.url}/runs/${original.id}`);
    await held.promise;
    expect((await request.post(runPhantom.url + "/v1/traces", { data: updated.body })).status()).toBe(200);
    await socketAction(page, 0, "open");
    await expect(page.getByText("Connected", { exact: true }).first()).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    release.release();
    await expect(page.getByText("Committed before handshake captured answer", { exact: true })).toHaveCount(1);
    expect(failed).toEqual([]);
    expect(maximumActive).toBe(1);
    expect(requests).toBe(2);
    expect(await page.evaluate(() => (window as unknown as RefreshWindow).detailObservations.every(item => !item.aborted))).toBe(true);
  } finally {
    release.release();
    await attachObservations(page, info, failed, { requests, active, maximumActive, initialReplyWasRealPreUpdateDaemonResponse: true });
  }
});

test("missed reconnect updates and repeated refresh demands share one trailing real snapshot", async ({ page, request, runPhantom }, info) => {
  await observeRefresh(page);
  const original = trace(3192, "Before outage captured answer"), updated = trace(3192, "Committed during outage captured answer");
  expect((await request.post(runPhantom.url + "/v1/traces", { data: original.body })).status()).toBe(200);
  const held = gate(), release = gate();
  const failed: Array<{ url: string; error: string | undefined }> = [];
  page.on("requestfailed", request => failed.push({ url: request.url(), error: request.failure()?.errorText }));
  let requests = 0, active = 0, maximumActive = 0, holdNext = false;
  await page.route(`**/api/runs/detail/${original.id}`, async route => {
    requests++; maximumActive = Math.max(maximumActive, ++active);
    const hold = holdNext; holdNext = false;
    try {
      const response = await route.fetch();
      if (hold) { held.release(); await release.promise; }
      await route.fulfill({ response });
    } finally { active--; }
  });
  try {
    await page.goto(`${runPhantom.url}/runs/${original.id}`);
    await socketAction(page, 0, "open");
    await expect(page.getByText("Before outage captured answer", { exact: true })).toHaveCount(1);
    await expect.poll(() => active).toBe(0);
    const before = requests;
    holdNext = true;
    await socketAction(page, 0, "open", { event: "spans", data: { runIds: [original.id] } });
    await held.promise;
    await socketAction(page, 0, "disconnect");
    expect((await request.post(runPhantom.url + "/v1/traces", { data: updated.body })).status()).toBe(200);
    await expect.poll(() => page.evaluate(() => (window as unknown as RefreshWindow).daemonSockets.length)).toBe(2);
    await socketAction(page, 1, "open");
    for (let index = 0; index < 3; index++) await socketAction(page, 1, "open", { event: "spans", data: { runIds: [original.id] } });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(requests).toBe(before + 1);
    release.release();
    await expect(page.getByText("Committed during outage captured answer", { exact: true })).toHaveCount(1);
    await expect.poll(() => active).toBe(0);
    expect(requests).toBe(before + 2);
    expect(maximumActive).toBe(1);
    expect(failed).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as RefreshWindow).detailObservations.every(item => !item.aborted))).toBe(true);
  } finally { release.release(); await attachObservations(page, info, failed, { requests, active, maximumActive }); }
});

for (const destination of ["another run", "another page"] as const) {
  test(`switching to ${destination} aborts the old read and discards its queued refresh`, async ({ page, request, runPhantom }, info) => {
    await observeRefresh(page);
    const original = trace(destination === "another run" ? 3193 : 3194, "Obsolete selected answer"), next = trace(3195, "Current selected answer");
    for (const captured of [original, next]) expect((await request.post(runPhantom.url + "/v1/traces", { data: captured.body })).status()).toBe(200);
    const held = gate(), release = gate(), delivered = gate();
    const failed: Array<{ url: string; error: string | undefined }> = [];
    page.on("requestfailed", request => failed.push({ url: request.url(), error: request.failure()?.errorText }));
    let requests = 0;
    await page.route(`**/api/runs/detail/${original.id}`, async route => {
      requests++;
      try { const response = await route.fetch(); held.release(); await release.promise; await route.fulfill({ response }); }
      finally { delivered.release(); }
    });
    try {
      await page.goto(`${runPhantom.url}/runs/${original.id}`);
      await held.promise;
      await socketAction(page, 0, "open");
      await expect(page.getByText("Connected", { exact: true }).first()).toBeVisible();
      if (destination === "another run") {
        await page.locator(`[data-run-id="${next.id}"]`).click();
        await expect(page.getByText("Current selected answer", { exact: true })).toHaveCount(1);
      } else {
        await page.getByRole("link", { name: "Search", exact: true }).click();
        await expect(page).toHaveURL(/\/search$/);
      }
      await expect.poll(() => page.evaluate(id => (window as unknown as RefreshWindow).detailObservations.find(item => item.url.endsWith(id))?.aborted, original.id)).toBe(true);
      release.release(); await delivered.promise;
      expect(requests).toBe(1);
      await expect(page.getByText("Obsolete selected answer", { exact: true })).toHaveCount(0);
      if (destination === "another run") await expect(page.getByText("Current selected answer", { exact: true })).toHaveCount(1);
      expect(failed).toEqual([{ url: `${runPhantom.url}/api/runs/detail/${original.id}`, error: "net::ERR_ABORTED" }]);
    } finally { release.release(); await attachObservations(page, info, failed, { requests, destination }); }
  });
}

test("deletion aborts and clears pending refreshes; failed deletion resumes a fresh real snapshot", async ({ page, request, runPhantom }, info) => {
  await observeRefresh(page);
  const original = trace(3196, "Before deletion captured answer"), updated = trace(3196, "Retained after failed deletion answer");
  expect((await request.post(runPhantom.url + "/v1/traces", { data: original.body })).status()).toBe(200);
  const held = gate(), release = gate(), delivered = gate(), deleteHeld = gate(), deleteRelease = gate();
  const failed: Array<{ url: string; error: string | undefined }> = [];
  page.on("requestfailed", request => failed.push({ url: request.url(), error: request.failure()?.errorText }));
  let requests = 0, holdNext = false;
  await page.route(`**/api/runs/detail/${original.id}`, async route => {
    requests++;
    const hold = holdNext; holdNext = false;
    try { const response = await route.fetch(); if (hold) { held.release(); await release.promise; } await route.fulfill({ response }); }
    finally { if (hold) delivered.release(); }
  });
  await page.route(`**/api/runs/${original.id}`, async route => {
    expect(route.request().method()).toBe("DELETE"); deleteHeld.release(); await deleteRelease.promise;
    await route.fulfill({ status: 503, json: { error: "Delete temporarily unavailable" } });
  });
  try {
    await page.goto(`${runPhantom.url}/runs/${original.id}`); await socketAction(page, 0, "open");
    await expect(page.getByText("Before deletion captured answer", { exact: true })).toHaveCount(1);
    holdNext = true; await socketAction(page, 0, "open", { event: "spans", data: { runIds: [original.id] } }); await held.promise;
    expect((await request.post(runPhantom.url + "/v1/traces", { data: updated.body })).status()).toBe(200);
    await socketAction(page, 0, "open", { event: "spans", data: { runIds: [original.id] } });
    await page.getByRole("button", { name: "More actions" }).click(); page.once("dialog", dialog => dialog.accept());
    await page.getByRole("menuitem", { name: "Delete run", exact: true }).click(); await deleteHeld.promise;
    const whileDeleting = requests;
    await socketAction(page, 0, "open", { event: "spans", data: { runIds: [original.id] } });
    release.release(); await delivered.promise;
    expect(requests).toBe(whileDeleting);
    await expect(page.getByText("Before deletion captured answer", { exact: true })).toHaveCount(1);
    deleteRelease.release();
    await expect(page.getByRole("alert")).toHaveText("Delete temporarily unavailable");
    await expect(page.getByText("Retained after failed deletion answer", { exact: true })).toHaveCount(1);
    expect(requests).toBe(whileDeleting + 1);
    expect(failed).toEqual([{ url: `${runPhantom.url}/api/runs/detail/${original.id}`, error: "net::ERR_ABORTED" }]);
  } finally { release.release(); deleteRelease.release(); await attachObservations(page, info, failed, { requests }); }
});

test("a missing run still settles to not-found after initial handshake refresh", async ({ page, runPhantom }, info) => {
  await observeRefresh(page);
  const failed: Array<{ url: string; error: string | undefined }> = [];
  page.on("requestfailed", request => failed.push({ url: request.url(), error: request.failure()?.errorText }));
  const missing = "f".repeat(32);
  try {
    await page.goto(`${runPhantom.url}/runs/${missing}`);
    await socketAction(page, 0, "open");
    await expect(page.getByText("Trace not found", { exact: true })).toBeVisible();
    expect(failed).toEqual([]);
  } finally { await attachObservations(page, info, failed, { missingRun: missing, realDaemonNotFound: true }); }
});
