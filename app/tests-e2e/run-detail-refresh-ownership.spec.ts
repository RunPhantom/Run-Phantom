import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { APIResponse, Page, Request, Route, WebSocketRoute } from "@playwright/test";
import { test, expect } from "./fixtures";
import { FIXTURE_PRIMARY_RUN_ID as A, FIXTURE_SAVED_SIBLING_RUN_ID as B } from "./helpers";

const coverage = "x-runphantom-live-events";
type Detail = { run: { id: string; name: string; display_name?: string; convo_id?: string | null }; spans: { id: string }[]; liveEvents: { id: number; content: string }[] };
type Observation = { frames: { event: string; data?: { content?: string; persistedId?: number } }[]; reads: { url: string; frame: number }[] };
type ObservedWindow = Window & { detailOwnership: Observation };

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function fixture(phase = 0, id = A) {
  return {
    run: { id, name: `snapshot-${phase}`, display_name: `snapshot-${phase}`, started_at: 1, last_updated_at: 100 + phase },
    spans: Array.from({ length: phase + 1 }, (_, i) => ({
      id: (i + 1).toString(16).padStart(16, "0"), run_id: id, name: `step-${i}`, span_type: "TOOL_CALL", status: "OK",
      start_time_ms: i + 1, end_time_ms: i + 2, duration_ms: 1, input_payload: "{}", output_payload: `completed step ${i}`,
    })),
    liveEvents: [],
  };
}

async function post(url: string, route: string, data?: unknown) {
  const response = await fetch(url + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data ?? {}) });
  expect(response.ok, `${route}: ${response.status}`).toBe(true);
  return response;
}

async function observe(page: Page) {
  await page.addInitScript(() => {
    const observed: Observation = { frames: [], reads: [] };
    (window as unknown as ObservedWindow).detailOwnership = observed;
    // Playwright's routed page socket dispatches here; its underlying native socket is separate.
    // Deliberately capture the original method; Reflect.apply below supplies each actual event target.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const nativeDispatch = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = function (this: EventTarget, event: Event) {
      const socket = this as WebSocket;
      if (event instanceof MessageEvent && typeof socket.url === "string"
        && new URL(socket.url, location.href).pathname === "/ws") {
        observed.frames.push(JSON.parse(event.data));
      }
      return Reflect.apply(nativeDispatch, this, [event]);
    };
    // Deliberately capture fetch before wrapping it; Reflect.apply below preserves the caller's receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const nativeFetch = window.fetch;
    window.fetch = function (...args: Parameters<typeof fetch>) {
      const input = args[0];
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url, location.href).pathname.startsWith("/api/runs/detail/")) {
        observed.reads.push({ url, frame: observed.frames.length });
      }
      return Reflect.apply(nativeFetch, this, args);
    };
  });
}

async function observations(page: Page) {
  return page.evaluate(() => (window as unknown as ObservedWindow).detailOwnership);
}

type Protocol = "native" | "legacy" | "invalid" | "unclassified";

async function handshake(page: Page, protocol: Protocol = "native") {
  let socket!: WebSocketRoute;
  let provider = "";
  let lastLive = "";
  let hold = true;
  const received = gate();
  await page.routeWebSocket("**/ws", client => {
    socket = client;
    const server = client.connectToServer();
    server.onMessage(message => {
      if (JSON.parse(message.toString()).event === "live") lastLive = message.toString();
      if (JSON.parse(message.toString()).event === "agent_provider") {
        provider = message.toString();
        received.release();
        if (hold) return;
      }
      const frame = JSON.parse(message.toString());
      if (frame.event === "live" && protocol !== "native") {
        // Explicit old/partial protocol boundary: retain the genuine payload,
        // omitting the new field or supplying an invalid value, never a fake ID.
        if (protocol === "legacy") delete frame.data.persistedId;
        else if (protocol === "invalid") frame.data.persistedId = "invalid-native-id";
        client.send(JSON.stringify(frame));
      } else client.send(message);
    });
  });
  return {
    received: received.promise,
    release: () => { hold = false; socket.send(provider); },
    replay: () => { expect(provider).not.toBe(""); socket.send(provider); },
    replayLive: () => { expect(lastLive).not.toBe(""); socket.send(lastLive); },
  };
}

type Held = {
  request: Request; response: APIResponse; body: Detail; n: number;
  release(): void; delivered: Promise<void>; deliveryError?: string;
};

async function detailGate(page: Page, url: string, protocol: Protocol = "native") {
  const requests: Request[] = [];
  const held: Held[] = [];
  const active = new Set<Promise<void>>();
  let enabled = false;
  let closing = false;
  let disposal: Promise<void> | undefined;
  const handler = (route: Route): Promise<void> => {
    // Register the original callback promise before any fetch or body await can run.
    const invocation = Promise.resolve().then(async () => {
      const request = route.request();
      const n = requests.push(request);
      const response = await route.fetch();
      const headers = { ...response.headers() };
      if (protocol === "legacy") delete headers[coverage];
      if (protocol === "invalid" || protocol === "unclassified") headers[coverage] = "unknown-producer";
      if (!enabled) return route.fulfill({ response, headers });
      const release = gate(), delivered = gate();
      const item: Held = { request, response, body: await response.json() as Detail, n,
        release: release.release, delivered: delivered.promise };
      held.push(item);
      // Disposal can start while the genuine response body is being read.
      if (closing) item.release();
      await release.promise;
      try { await route.fulfill({ response, headers }); }
      catch (error) { item.deliveryError = String(error); }
      finally { delivered.release(); }
    });
    active.add(invocation);
    void invocation.then(() => { active.delete(invocation); }, () => { active.delete(invocation); });
    return invocation;
  };
  await page.route(url, handler);
  const dispose = (): Promise<void> => {
    if (!disposal) {
      closing = true;
      enabled = false;
      for (const item of held) item.release();
      disposal = Promise.resolve().then(async () => {
        let unrouteFailed = false;
        try { await page.unroute(url, handler); }
        catch { unrouteFailed = true; }
        // Joining observes settlement; the original promise still reports rejection to Playwright.
        await Promise.allSettled([...active]);
        // A cleanup failure must fail the test without replacing an in-flight body exception.
        expect.soft(unrouteFailed, "owned detail route must unregister before disposal completes").toBe(false);
      });
    }
    return disposal;
  };
  return {
    requests, held, enable: () => { if (!closing) enabled = true; },
    next: async (index: number) => { await expect.poll(() => held.length).toBeGreaterThan(index); return held[index]; },
    dispose,
  };
}

async function finished(request: Request) {
  const response = await request.response();
  expect(response).not.toBeNull();
  expect(await response!.finished()).toBeNull();
  expect(response!.ok()).toBe(true);
  return response!;
}

async function settled(page: Page, url: string, protocol: Protocol = "native") {
  await observe(page);
  const ws = await handshake(page, protocol);
  const initial = page.waitForRequest(url + `/api/runs/detail/${A}`);
  await page.goto(url + `/runs/${A}`);
  await finished(await initial);
  await ws.received;
  const refreshed = page.waitForRequest(url + `/api/runs/detail/${A}`);
  ws.release();
  await finished(await refreshed);
  await expect(page.getByRole("button", { name: "More actions" })).toBeVisible();
  return ws;
}

test.afterEach(async ({ page }, info) => {
  if (!page.isClosed()) await info.attach("actual-frame-and-fetch-order", { contentType: "application/json", body: JSON.stringify(await observations(page).catch(() => null)) });
});

test("same-run completed reads publish progress during three ongoing refresh rounds without redundant aborts", async ({ page, runPhantom }) => {
  await post(runPhantom.url, "/api/import-run", fixture());
  const url = runPhantom.url + `/api/runs/detail/${A}`;
  const ws = await settled(page, runPhantom.url);
  const failures: Request[] = [];
  page.on("requestfailed", request => failures.push(request));
  const readOffset = (await observations(page)).reads.length;
  const reads = await detailGate(page, url);
  reads.enable();
  try {
    await post(runPhantom.url, "/api/import-run", fixture(1));
    let current = await reads.next(0);
    for (let round = 0; round < 3; round++) {
      expect(current.body.run.display_name).toBe(`snapshot-${round + 1}`);
      await post(runPhantom.url, "/api/import-run", fixture(round + 2));
      const content = `progress-${round}|`;
      for (let i = 0; i < 2; i++) await post(runPhantom.url, "/v1/live", { traceId: A, type: "reasoning", content, timestamp: 200 + round });
      await expect.poll(async () => (await observations(page)).frames.filter(frame => frame.event === "live" && frame.data?.content === content).length).toBe(2);
      const trigger = (await observations(page)).frames.length;
      ws.replay(); ws.replay();
      await expect.poll(async () => (await observations(page)).frames.length).toBeGreaterThan(trigger);
      expect(reads.held, "one active read must remain the sole read until it settles").toHaveLength(round + 1);
      expect(failures).toEqual([]);
      current.release();
      await current.delivered;
      await finished(current.request);
      const next = await reads.next(round + 1);
      expect(next.request).not.toBe(current.request);
      expect(next.n).toBe(current.n + 1);
      expect((await observations(page)).reads[readOffset + next.n - 1]?.frame).toBeGreaterThanOrEqual(trigger);
      await expect(page.getByRole("button", { name: `Rename snapshot-${round + 1}`, exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: `step-${round + 1}`, exact: true })).toBeVisible();
      await expect.poll(async () => (await page.getByRole("tabpanel", { name: "Overview", exact: true }).innerText()).split(content).length - 1).toBe(2);
      await expect(page.getByText("Loading", { exact: true })).toHaveCount(0);
      expect(failures).toEqual([]);
      current = next;
    }
    current.release(); await current.delivered; await finished(current.request);
    await expect(page.getByRole("button", { name: "Rename snapshot-4", exact: true })).toBeVisible();
    expect(failures).toEqual([]);
  } finally { await reads.dispose(); }
});

test("a held pre-selection snapshot cannot redirect the newer span route or reset Debug", async ({ page, runPhantom }) => {
  await post(runPhantom.url, "/api/import-run", fixture());
  const ws = await settled(page, runPhantom.url);
  const reads = await detailGate(page, runPhantom.url + `/api/runs/detail/${A}`);
  reads.enable();
  try {
    ws.replay();
    const old = await reads.next(0);
    await post(runPhantom.url, "/api/import-run", fixture(1));
    await page.getByRole("button", { name: "Debug", exact: true }).click();
    const chat = page.getByRole("complementary", { name: "Coding-agent debug chat" });
    const rejected = page.waitForResponse(response => response.url().endsWith("/api/agent/messages") && response.request().method() === "POST");
    await chat.getByRole("button", { name: "What went wrong here?", exact: true }).click();
    expect((await rejected).status()).toBe(409);
    await page.evaluate(({ id, span }) => {
      history.pushState(null, "", `/runs/${id}/span/${span}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, { id: A, span: "0000000000000002" });
    await expect(page).toHaveURL(new RegExp("/span/0000000000000002$"));
    old.release(); await old.delivered; await finished(old.request);
    const fresh = await reads.next(1);
    await expect(page).toHaveURL(new RegExp("/span/0000000000000002$"));
    await expect(chat.getByRole("log", { name: "Debug chat messages" })).toContainText("What went wrong here?");
    await expect(chat.locator("header")).toBeVisible();
    fresh.release(); await fresh.delivered; await finished(fresh.request);
    await expect(page).toHaveURL(new RegExp("/span/0000000000000002$"));
    await expect(page.getByRole("tab", { name: "Span Tree", exact: true })).toHaveAttribute("aria-selected", "true");
  } finally { await reads.dispose(); }
});

test("A1 retires immediately through B and A2 and its old finally cannot own A2", async ({ page, runPhantom }) => {
  await post(runPhantom.url, "/api/import-run", fixture());
  await post(runPhantom.url, "/api/import-run", fixture(2, B));
  const ws = await settled(page, runPhantom.url);
  const reads = await detailGate(page, runPhantom.url + `/api/runs/detail/${A}`);
  const failures: Request[] = [];
  page.on("requestfailed", request => failures.push(request));
  reads.enable();
  try {
    ws.replay(); const a1 = await reads.next(0);
    const before = (await observations(page)).frames.length;
    ws.replay(); await expect.poll(async () => (await observations(page)).frames.length).toBeGreaterThan(before);
    const bRequest = page.waitForRequest(runPhantom.url + `/api/runs/detail/${B}`);
    await page.locator(`[data-run-id="${B}"]`).click();
    await finished(await bRequest);
    await expect.poll(() => failures.includes(a1.request)).toBe(true);
    const beforeReturn = reads.held.length;
    const a2Started = page.waitForRequest(runPhantom.url + `/api/runs/detail/${A}`);
    await page.locator(`[data-run-id="${A}"]`).click();
    const a2Request = await a2Started;
    const a2 = await reads.next(beforeReturn);
    expect(a2.request).toBe(a2Request);
    expect(a2.request).not.toBe(a1.request);
    a1.release(); await a1.delivered;
    await expect(page.getByText("Loading", { exact: true })).toBeVisible();
    expect(reads.held).toHaveLength(beforeReturn + 1);
    a2.release(); await a2.delivered; await finished(a2.request);
    await expect(page.getByRole("button", { name: "Rename snapshot-0", exact: true })).toBeVisible();
    expect(failures).toEqual([a1.request]);
  } finally { await reads.dispose(); }
});

for (const fault of ["403", "404", "503", "json", "transport"] as const) {
  test(`a queued refresh keeps the current ${fault} failure observable before actual recovery`, async ({ page, runPhantom }) => {
    await post(runPhantom.url, "/api/import-run", fixture());
    const ws = await settled(page, runPhantom.url);
    const reads = await detailGate(page, runPhantom.url + `/api/runs/detail/${A}`);
    const errorReady = gate(), releaseError = gate();
    let first = true;
    await page.route(runPhantom.url + `/api/runs/detail/${A}`, async route => {
      if (!first) return route.fallback();
      first = false; errorReady.release(); await releaseError.promise;
      if (fault === "transport") await route.abort("connectionreset");
      else await route.fulfill({ status: fault === "json" ? 200 : Number(fault), contentType: "application/json", body: fault === "json" ? "{" : '{"error":"controlled failure"}' });
    });
    reads.enable();
    try {
      ws.replay(); await errorReady.promise;
      const before = (await observations(page)).frames.length;
      ws.replay(); await expect.poll(async () => (await observations(page)).frames.length).toBeGreaterThan(before);
      releaseError.release();
      const recovered = await reads.next(0);
      await expect(page.getByText("This trace is not available in the current workspace.", { exact: false })).toBeVisible();
      await expect(page.getByText("Loading", { exact: true })).toHaveCount(0);
      recovered.release(); await recovered.delivered; await finished(recovered.request);
      await expect(page.getByRole("button", { name: "Rename snapshot-0", exact: true })).toBeVisible();
    } finally { releaseError.release(); await reads.dispose(); }
  });
}

test("a post-frame live-only cached read covers native IDs and saved-only history still reloads", async ({ page, runPhantom }) => {
  await post(runPhantom.url, "/api/import-run", fixture());
  const detailUrl = runPhantom.url + `/api/runs/detail/${A}`;
  const cached = await (await fetch(detailUrl)).json() as Detail;
  await fetch(`${runPhantom.url}/api/saved-runs/cache/${A}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cached) });
  const ws = await settled(page, runPhantom.url);
  const saved = page.waitForResponse(response => response.url().endsWith(`/api/saved-runs/events/${A}`) && response.request().method() === "PUT");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
  await post(runPhantom.url, "/api/clear");
  await post(runPhantom.url, "/v1/live", { traceId: A, type: "reasoning", content: "pre-request native progress", timestamp: 300 });
  await expect.poll(async () => (await observations(page)).frames.some(frame => frame.data?.content === "pre-request native progress")).toBe(true);
  const request = page.waitForRequest(detailUrl);
  ws.replay();
  const actualRequest = await request;
  const response = await finished(actualRequest);
  const data = await response.json() as Detail;
  const frame = (await observations(page)).frames.find(frame => frame.data?.content === "pre-request native progress")!;
  expect(data.liveEvents.map(row => row.id)).toContain(frame.data!.persistedId);
  expect(await response.headerValue(coverage)).toBe("current-store");
  expect(await page.evaluate(async url => (await fetch(url)).headers.get("x-runphantom-live-events"), detailUrl)).toBe("current-store");
  await expect(page.getByText("pre-request native progress", { exact: true })).toBeVisible();
  expect(await (await fetch(`${runPhantom.url}/api/saved-runs/cache/${A}`)).json()).toEqual(cached);
  await post(runPhantom.url, "/api/clear");
  const historical = await fetch(detailUrl);
  expect(historical.headers.get(coverage)).toBe("saved-cache");
  expect(await historical.json()).toEqual(cached);
  await page.goto(`${runPhantom.url}/saved/${A}`);
  await page.reload();
  await expect(page.getByRole("heading", { name: "snapshot-0", level: 2, exact: true })).toBeVisible();
  await expect(page.getByText("pre-request native progress", { exact: true })).toHaveCount(0);
});


test("genuine repeated live frames dedupe only their native ID and preserve identical distinct rows", async ({ page, runPhantom }) => {
  await post(runPhantom.url, "/api/import-run", fixture());
  const ws = await settled(page, runPhantom.url);
  for (let i = 0; i < 2; i++) await post(runPhantom.url, "/v1/live", { traceId: A, type: "reasoning", content: "identical|", timestamp: 400 });
  await expect.poll(async () => (await observations(page)).frames.filter(frame => frame.event === "live").length).toBe(2);
  const ids = (await observations(page)).frames.filter(frame => frame.event === "live").map(frame => frame.data?.persistedId);
  expect(ids.every(id => Number.isSafeInteger(id))).toBe(true);
  expect(new Set(ids).size).toBe(2);
  await expect(page.getByText("identical|identical|", { exact: true })).toBeVisible();
  ws.replayLive();
  await expect.poll(async () => (await observations(page)).frames.filter(frame => frame.event === "live").length).toBe(3);
  await expect(page.getByText("identical|identical|", { exact: true })).toBeVisible();
  await expect(page.getByText("identical|identical|identical|", { exact: true })).toHaveCount(0);
  const fresh = page.waitForRequest(runPhantom.url + `/api/runs/detail/${A}`);
  ws.replay();
  await finished(await fresh);
  await expect(page.getByText("identical|identical|", { exact: true })).toBeVisible();
});

async function earlierDatabaseHistory(): Promise<Detail> {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "rp-earlier-history-")));
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const proc = spawn("bun", ["--no-env-file", "tests/fixtures/live-demo-identity.ts", "history"], {
    cwd: repo, env: { ...process.env, HOME: directory, USERPROFILE: directory,
      RUNPHANTOM_DB_PATH: path.join(directory, "earlier.db"), RUNPHANTOM_SECRET_STORE_PATH: path.join(directory, "secrets.json") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "", stderr = "";
  proc.stdout?.on("data", chunk => { output += chunk.toString(); });
  proc.stderr?.on("data", chunk => { stderr += chunk.toString(); });
  const exited = once(proc, "exit");
  const deadline = setTimeout(() => proc.kill("SIGTERM"), 4000);
  const errors: unknown[] = [];
  let result: Detail | undefined;
  try {
    expect((await exited)[0], stderr).toBe(0);
    const line = output.split("\n").find(line => line.startsWith("HISTORY_IDENTITY "));
    expect(line, "real earlier daemon must return its persisted detail body").toBeTruthy();
    result = JSON.parse(line!.slice(17)) as Detail;
  } catch (error) { errors.push(error); }
  finally {
    clearTimeout(deadline);
    try { if (proc.exitCode === null && proc.signalCode === null) { proc.kill("SIGKILL"); await exited; } } catch (error) { errors.push(error); }
    try { rmSync(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Earlier real database fixture failed", { cause: errors[0] });
  return result!;
}

async function overviewOccurrences(page: Page, content: string) {
  return (await page.getByRole("tabpanel", { name: "Overview", exact: true }).innerText()).split(content).length - 1;
}

test("saved history and a genuine other-database native suffix retain their colliding numeric IDs separately", async ({ page, runPhantom }) => {
  const historical = await earlierDatabaseHistory();
  expect(historical.liveEvents).toHaveLength(1);
  expect(Number.isSafeInteger(historical.liveEvents[0].id)).toBe(true);
  await post(runPhantom.url, "/api/import-run", fixture());
  const ws = await settled(page, runPhantom.url);
  const detailUrl = runPhantom.url + `/api/runs/detail/${A}`;
  expect((await fetch(`${runPhantom.url}/api/saved-runs/cache/${A}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(historical) })).ok).toBe(true);
  const reads = await detailGate(page, detailUrl);
  reads.enable();
  try {
    await post(runPhantom.url, "/api/clear");
    const saved = await reads.next(0);
    expect(saved.response.headers()[coverage]).toBe("saved-cache");
    expect(saved.body).toEqual(historical);
    await post(runPhantom.url, "/v1/live", { traceId: A, type: "reasoning", content: "native collision|", timestamp: 11 });
    await expect.poll(async () => (await observations(page)).frames.some(frame => frame.data?.content === "native collision|")).toBe(true);
    const nativeFrame = (await observations(page)).frames.find(frame => frame.data?.content === "native collision|")!;
    const nativeBody = await (await fetch(detailUrl)).json() as Detail;
    expect(nativeBody.liveEvents).toHaveLength(1);
    expect(nativeBody.liveEvents[0].id).toBe(historical.liveEvents[0].id);
    expect(nativeFrame.data!.persistedId).toBe(nativeBody.liveEvents[0].id);
    ws.replay();
    saved.release(); await saved.delivered; await finished(saved.request);
    const native = await reads.next(1);
    expect(native.request).not.toBe(saved.request);
    expect(native.response.headers()[coverage]).toBe("current-store");
    await expect.poll(() => overviewOccurrences(page, "historical collision|")).toBe(1);
    await expect.poll(() => overviewOccurrences(page, "native collision|")).toBe(1);
    native.release(); await native.delivered; await finished(native.request);
    await expect.poll(() => overviewOccurrences(page, "historical collision|")).toBe(0);
    await expect.poll(() => overviewOccurrences(page, "native collision|")).toBe(1);
    expect(await (await fetch(`${runPhantom.url}/api/saved-runs/cache/${A}`)).json()).toEqual(historical);
  } finally { await reads.dispose(); }
});

for (const protocol of ["legacy", "invalid", "unclassified"] as const) {
  test(`${protocol} protocol advances real HTTP-only progress and removal without claiming native coverage`, async ({ page, runPhantom }) => {
    await post(runPhantom.url, "/api/import-run", fixture());
    await post(runPhantom.url, "/api/import-run", fixture(0, B));
    const ws = await settled(page, runPhantom.url, protocol);
    const url = runPhantom.url + `/api/runs/detail/${A}`;
    const reads = await detailGate(page, url, protocol);
    reads.enable();
    try {
      await post(runPhantom.url, "/v1/live", { traceId: A, type: "reasoning", content: "legacy immediate|", timestamp: 50 });
      await expect.poll(async () => (await observations(page)).frames.some(frame => frame.data?.content === "legacy immediate|")).toBe(true);
      const frame = (await observations(page)).frames.find(frame => frame.data?.content === "legacy immediate|")!;
      expect(Number.isSafeInteger(frame.data?.persistedId)).toBe(protocol === "unclassified");
      await expect.poll(() => overviewOccurrences(page, "legacy immediate|")).toBe(1);
      await post(runPhantom.url, "/api/import-run", { ...fixture(1), liveEvents: [{ type: "reasoning", content: "HTTP-only progress|", timestamp: 51 }] });
      const changed = await reads.next(0);
      expect(changed.body.liveEvents.map(row => row.content)).toEqual(["HTTP-only progress|"]);
      await post(runPhantom.url, "/v1/live", { traceId: A, type: "reasoning", content: "ambiguous suffix|", timestamp: 52 });
      await expect.poll(async () => (await observations(page)).frames.some(frame => frame.data?.content === "ambiguous suffix|")).toBe(true);
      changed.release(); await changed.delivered; await finished(changed.request);
      await expect.poll(() => overviewOccurrences(page, "HTTP-only progress|")).toBe(1);
      await expect.poll(() => overviewOccurrences(page, "legacy immediate|")).toBe(0);
      await expect.poll(() => overviewOccurrences(page, "ambiguous suffix|")).toBe(1);
      ws.replay(); const successor = await reads.next(1);
      await expect.poll(() => overviewOccurrences(page, "HTTP-only progress|")).toBe(1);
      successor.release(); await successor.delivered; await finished(successor.request);
      await post(runPhantom.url, "/api/import-run", fixture(2));
      const removed = await reads.next(2);
      expect(removed.body.liveEvents).toEqual([]);
      removed.release(); await removed.delivered; await finished(removed.request);
      await expect.poll(() => overviewOccurrences(page, "HTTP-only progress|")).toBe(0);
      await expect.poll(() => overviewOccurrences(page, "ambiguous suffix|")).toBe(0);
      const b = page.waitForRequest(runPhantom.url + `/api/runs/detail/${B}`);
      await page.locator(`[data-run-id="${B}"]`).click(); await finished(await b);
      await expect.poll(() => overviewOccurrences(page, "legacy immediate|")).toBe(0);
      await expect.poll(() => overviewOccurrences(page, "HTTP-only progress|")).toBe(0);
    } finally { await reads.dispose(); }
  });
}

for (const view of ["span/0000000000000009", "convo"] as const) {
  test(`a context-only ${view} choice receives a real covering GET before missing-object normalization`, async ({ page, runPhantom }) => {
    await post(runPhantom.url, "/api/import-run", fixture());
    await settled(page, runPhantom.url);
    const reads = await detailGate(page, runPhantom.url + `/api/runs/detail/${A}`);
    reads.enable();
    try {
      await page.evaluate(url => { history.pushState(null, "", url); dispatchEvent(new PopStateEvent("popstate")); }, `/runs/${A}/${view}`);
      const verifying = await reads.next(0);
      await expect(page).toHaveURL(runPhantom.url + `/runs/${A}/${view}`);
      expect(verifying.body.spans.map(span => span.id)).not.toContain("0000000000000009");
      verifying.release(); await verifying.delivered; await finished(verifying.request);
      await expect(page).toHaveURL(runPhantom.url + `/runs/${A}${view === "convo" ? "" : "/spans"}`);
      expect(reads.held).toHaveLength(1);
      await expect(page.getByRole("button", { name: "Rename snapshot-0", exact: true })).toBeVisible();
    } finally { await reads.dispose(); }
  });
}

type SchedulingWindow = Window & { detailScheduling: { hold: boolean; queued: number; released: number; release(): void } };
async function controlReactScheduling(page: Page) {
  await page.addInitScript(() => {
    const pending: (() => void)[] = [];
    const state = { hold: false, queued: 0, released: 0, release: () => {
      state.hold = false;
      for (const task of pending.splice(0)) { state.released++; task(); }
    } };
    (window as unknown as SchedulingWindow).detailScheduling = state;
    const NativeChannel = window.MessageChannel;
    window.MessageChannel = class extends NativeChannel {
      constructor() {
        super();
        // Deliberately capture this port's original method; Reflect.apply below supplies that same port.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const port = this.port2, send = port.postMessage;
        port.postMessage = function (message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
          const task = () => Reflect.apply(send, port, options === undefined ? [message] : [message, options]);
          if (state.hold) { pending.push(task); state.queued++; } else task();
        };
      }
    };
  });
}

test("actual pending React work preserves interleaved native frames through commit and obsolete-owner retirement", async ({ page, runPhantom }) => {
  await controlReactScheduling(page);
  await post(runPhantom.url, "/api/import-run", fixture());
  await post(runPhantom.url, "/api/import-run", fixture(0, B));
  const ws = await settled(page, runPhantom.url);
  const reads = await detailGate(page, runPhantom.url + `/api/runs/detail/${A}`);
  reads.enable();
  try {
    await post(runPhantom.url, "/api/import-run", fixture(1));
    const first = await reads.next(0);
    await page.evaluate(() => { (window as unknown as SchedulingWindow).detailScheduling.hold = true; });
    first.release(); await first.delivered; await finished(first.request);
    await expect.poll(() => page.evaluate(() => (window as unknown as SchedulingWindow).detailScheduling.queued)).toBeGreaterThan(0);
    // A real response has settled but actual React scheduler tasks are withheld.
    await expect(page.getByRole("button", { name: "Rename snapshot-0", exact: true })).toBeVisible();
    for (let i = 0; i < 2; i++) await post(runPhantom.url, "/v1/live", { traceId: A, type: "reasoning", content: "between publication|", timestamp: 60 });
    await expect.poll(async () => (await observations(page)).frames.filter(frame => frame.data?.content === "between publication|").length).toBe(2);
    ws.replay(); const successor = await reads.next(1);
    await page.evaluate(() => (window as unknown as SchedulingWindow).detailScheduling.release());
    await expect(page.getByRole("button", { name: "Rename snapshot-1", exact: true })).toBeVisible();
    await expect.poll(() => overviewOccurrences(page, "between publication|")).toBe(2);
    const b = page.waitForRequest(runPhantom.url + `/api/runs/detail/${B}`);
    await page.locator(`[data-run-id="${B}"]`).click(); await finished(await b);
    successor.release(); await successor.delivered;
    await expect.poll(() => overviewOccurrences(page, "between publication|")).toBe(0);
    const returning = page.waitForRequest(runPhantom.url + `/api/runs/detail/${A}`);
    await page.locator(`[data-run-id="${A}"]`).click();
    const actualReturn = await returning;
    const resumed = await reads.next(2);
    expect(resumed.request).toBe(actualReturn);
    resumed.release(); await resumed.delivered; await finished(actualReturn);
    expect(resumed.body.liveEvents).toHaveLength(2);
    await expect.poll(() => overviewOccurrences(page, "between publication|")).toBe(2);
    expect(await page.evaluate(() => (window as unknown as SchedulingWindow).detailScheduling.released)).toBeGreaterThan(0);
  } finally {
    await page.evaluate(() => (window as unknown as SchedulingWindow).detailScheduling.release()).catch(() => {});
    await reads.dispose();
  }
});

function conversationFixture() {
  const data = fixture();
  return { ...data, run: { ...data.run, convo_id: "owned-conversation" } };
}

function subAgentFixture() {
  const data = fixture(2);
  return { ...data, spans: data.spans.map((span, i) => ({
    ...span,
    name: i === 0 ? "worker" : i === 1 ? "agent.subagent" : "worker tool",
    parent_span_id: i === 0 ? null : data.spans[i - 1].id,
    span_type: i === 1 ? "LLM_GENERATION" : "TOOL_CALL",
  })) };
}

test("a stale no-conversation response cannot erase the newly selected genuine conversation pane", async ({ page, runPhantom }, info) => {
  await post(runPhantom.url, "/api/import-run", conversationFixture());
  await settled(page, runPhantom.url);
  const reads = await detailGate(page, runPhantom.url + `/api/runs/detail/${A}`);
  reads.enable();
  let missingPhase: Awaited<ReturnType<typeof detailGate>> | undefined;
  const phaseWitnesses: { n: number; url: string; requestStart: number; convoId: string | null | undefined; coverage: string; browserStatus: number | null; completion: string | null; requestFailure: string | null }[] = [];
  try {
    await post(runPhantom.url, "/api/import-run", fixture());
    const old = await reads.next(0);
    expect(old.body.run.convo_id).toBeNull();
    expect(old.response.headers()[coverage]).toBe("current-store");
    await post(runPhantom.url, "/api/import-run", conversationFixture());
    await page.getByRole("tab", { name: "Conversation", exact: true }).click();
    await expect(page).toHaveURL(runPhantom.url + `/runs/${A}/convo`);
    old.release(); await old.delivered; await finished(old.request);
    const covering = await reads.next(1);
    expect(covering.body.run.convo_id).toBe("owned-conversation");
    expect(covering.response.headers()[coverage]).toBe("current-store");
    await expect(page.getByRole("tab", { name: "Conversation", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(runPhantom.url + `/runs/${A}/convo`);
    covering.release(); await covering.delivered; await finished(covering.request);
    await expect(page.getByRole("tab", { name: "Conversation", exact: true })).toHaveAttribute("aria-selected", "true");
    // ConvoDetail has its own same-URL query. Drain the earlier phase instead
    // of mistaking a pre-removal ordinal for the coordinator's covering read.
    await reads.dispose();
    const removal = await detailGate(page, runPhantom.url + `/api/runs/detail/${A}`);
    missingPhase = removal;
    removal.enable();
    const beforeRemovalFrame = (await observations(page)).frames.filter(frame => frame.event === "spans").length;
    await post(runPhantom.url, "/api/import-run", fixture());
    await expect.poll(async () => (await observations(page)).frames.filter(frame => frame.event === "spans").length).toBeGreaterThan(beforeRemovalFrame);
    await expect.poll(async () => {
      // Release every genuine native candidate in this phase, including late
      // older conversation bodies, so another query cannot block the owner.
      // Only a completed real null-conversation body counts as missing evidence.
      for (const read of removal.held) {
        const source = read.response.headers()[coverage];
        if (source !== "current-store" || read.body.run.id !== A
          || (read.body.run.convo_id !== null && read.body.run.convo_id !== "owned-conversation")) continue;
        read.release();
        await read.delivered;
        if (phaseWitnesses.some(witness => witness.n === read.n)) continue;
        const response = await read.request.response();
        const completion = response ? await response.finished() : null;
        phaseWitnesses.push({ n: read.n, url: read.request.url(), requestStart: read.request.timing().startTime,
          convoId: read.body.run.convo_id, coverage: source, browserStatus: response?.status() ?? null,
          completion: completion ? completion.message : null, requestFailure: read.request.failure()?.errorText ?? null });
      }
      const completedMissing = phaseWitnesses.some(witness => witness.convoId === null && witness.browserStatus === 200
        && witness.completion === null && witness.requestFailure === null);
      // URL normalization is owned by RunDetail, not the extra query. Requiring
      // it together with real completion prevents that query posing as owner.
      return { completedMissing, url: page.url() };
    }).toEqual({ completedMissing: true, url: runPhantom.url + `/runs/${A}` });
    await expect(page).toHaveURL(runPhantom.url + `/runs/${A}`);
    await expect(page.getByRole("tab", { name: "Conversation", exact: true })).toHaveCount(0);
  } finally {
    await Promise.all([missingPhase?.dispose(), reads.dispose()]);
    await info.attach("genuine-native-removal-phase-reads", { contentType: "application/json", body: JSON.stringify(phaseWitnesses) });
  }
});

test("a stale no-agent response keeps a newer selected real sub-agent until its context-covering read", async ({ page, runPhantom }) => {
  await post(runPhantom.url, "/api/import-run", subAgentFixture());
  const native = await (await fetch(runPhantom.url + `/api/runs/detail/${A}`)).json();
  expect(native.subAgents).toHaveLength(1);
  expect(native.subAgents[0].root_span_id).toBe("0000000000000001");
  await settled(page, runPhantom.url);
  const reads = await detailGate(page, runPhantom.url + `/api/runs/detail/${A}`);
  reads.enable();
  try {
    await post(runPhantom.url, "/api/import-run", fixture());
    const old = await reads.next(0);
    await post(runPhantom.url, "/api/import-run", subAgentFixture());
    await page.getByRole("button", { name: /agent worker/ }).click();
    await page.getByRole("dialog", { name: "worker sub-agent details" }).getByRole("button", { name: /Open Sub-Agent/ }).click();
    await expect(page.getByRole("tablist", { name: "Sub-agent views" })).toBeVisible();
    old.release(); await old.delivered; await finished(old.request);
    const covering = await reads.next(1);
    await expect(page.getByRole("tablist", { name: "Sub-agent views" })).toBeVisible();
    covering.release(); await covering.delivered; await finished(covering.request);
    await expect(page.getByRole("tablist", { name: "Sub-agent views" })).toBeVisible();
    await post(runPhantom.url, "/api/import-run", fixture());
    const missing = await reads.next(2);
    missing.release(); await missing.delivered; await finished(missing.request);
    await expect(page.getByRole("tablist", { name: "Sub-agent views" })).toHaveCount(0);
    await expect(page.getByRole("tablist", { name: "Run views" })).toBeVisible();
  } finally { await reads.dispose(); }
});

test("failed-delete retirement keeps its committed prefix until a held resumed read replaces it and retains the newer frame", async ({ page, runPhantom }) => {
  await post(runPhantom.url, "/api/import-run", fixture());
  const ws = await settled(page, runPhantom.url);
  const detailUrl = runPhantom.url + `/api/runs/detail/${A}`;
  for (let i = 0; i < 2; i++) await post(runPhantom.url, "/v1/live", { traceId: A, type: "reasoning", content: "committed before delete|", timestamp: 70 });
  await expect.poll(() => overviewOccurrences(page, "committed before delete|")).toBe(2);
  const priorFrames = (await observations(page)).frames.filter(frame => frame.data?.content === "committed before delete|");
  expect(new Set(priorFrames.map(frame => frame.data!.persistedId)).size).toBe(2);
  expect(priorFrames.every(frame => Number.isSafeInteger(frame.data?.persistedId))).toBe(true);
  const reads = await detailGate(page, detailUrl);
  const failures: Request[] = [];
  page.on("requestfailed", request => failures.push(request));
  const deleteReady = gate(), releaseDelete = gate();
  await page.route(runPhantom.url + `/api/runs/${A}`, async route => {
    if (route.request().method() !== "DELETE") return route.continue();
    deleteReady.release(); await releaseDelete.promise;
    await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Delete temporarily unavailable"}' });
  });
  reads.enable();
  try {
    ws.replay(); const retired = await reads.next(0);
    expect(retired.body.liveEvents.map(row => row.content)).toEqual(["committed before delete|", "committed before delete|"]);
    // Give the retiring owner a genuine queued notice; its finally must never drain it later.
    const beforeQueuedNotice = (await observations(page)).frames.length;
    ws.replay();
    await expect.poll(async () => (await observations(page)).frames.length).toBeGreaterThan(beforeQueuedNotice);
    await page.getByRole("button", { name: "More actions" }).click();
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("menuitem", { name: "Delete run" }).click();
    await deleteReady.promise;
    await expect.poll(() => failures.includes(retired.request)).toBe(true);
    // Actual import deliberately removes the old active rows while the UI is suspended.
    // A reset receipt sequence must not resurrect that prefix after the resumed response.
    await post(runPhantom.url, "/api/import-run", { ...fixture(1), liveEvents: [{ type: "reasoning", content: "replacement before resume|", timestamp: 71 }] });
    await post(runPhantom.url, "/v1/live", { traceId: A, type: "reasoning", content: "persisted during deletion|", timestamp: 72 });
    await expect.poll(async () => (await observations(page)).frames.some(frame => frame.data?.content === "persisted during deletion|")).toBe(true);
    const beforeResumedRead = (await observations(page)).frames.length;
    await expect.poll(() => overviewOccurrences(page, "committed before delete|")).toBe(2);
    expect(reads.held).toHaveLength(1);
    const deleteResponse = page.waitForResponse(response => response.url() === runPhantom.url + `/api/runs/${A}` && response.request().method() === "DELETE");
    releaseDelete.release(); expect((await deleteResponse).status()).toBe(503);
    const resumed = await reads.next(1);
    expect(resumed.request).not.toBe(retired.request);
    expect(resumed.n).toBe(retired.n + 1);
    expect((await observations(page)).reads.at(-1)?.frame).toBeGreaterThanOrEqual(beforeResumedRead);
    expect(resumed.response.headers()[coverage]).toBe("current-store");
    expect(resumed.body.liveEvents.map(row => row.content)).toEqual(["replacement before resume|", "persisted during deletion|"]);
    await expect(page.getByRole("alert")).toHaveText("Delete temporarily unavailable");
    await expect(page).toHaveURL(runPhantom.url + `/runs/${A}`);
    // This real frame arrives after retirement, while the actual resumed body is held.
    await post(runPhantom.url, "/v1/live", { traceId: A, type: "reasoning", content: "after failure suffix|", timestamp: 73 });
    await expect.poll(async () => (await observations(page)).frames.some(frame => frame.data?.content === "after failure suffix|")).toBe(true);
    const suffix = (await observations(page)).frames.find(frame => frame.data?.content === "after failure suffix|")!;
    expect(Number.isSafeInteger(suffix.data?.persistedId)).toBe(true);
    expect(resumed.body.liveEvents.map(row => row.id)).not.toContain(suffix.data!.persistedId);
    await expect.poll(() => overviewOccurrences(page, "committed before delete|")).toBe(2);
    await expect.poll(() => overviewOccurrences(page, "after failure suffix|")).toBe(1);
    await expect(page.getByRole("button", { name: "Rename snapshot-0", exact: true })).toBeVisible();
    retired.release(); await retired.delivered;
    expect(reads.held).toHaveLength(2);
    await expect.poll(() => overviewOccurrences(page, "committed before delete|")).toBe(2);
    resumed.release(); await resumed.delivered; await finished(resumed.request);
    await expect(page.getByRole("button", { name: "Rename snapshot-1", exact: true })).toBeVisible();
    await expect.poll(() => overviewOccurrences(page, "committed before delete|")).toBe(0);
    for (const content of ["replacement before resume|", "persisted during deletion|", "after failure suffix|"]) {
      await expect.poll(() => overviewOccurrences(page, content)).toBe(1);
    }
    ws.replay(); const covering = await reads.next(2);
    expect(covering.body.liveEvents.map(row => row.id)).toContain(suffix.data!.persistedId);
    covering.release(); await covering.delivered; await finished(covering.request);
    await expect.poll(() => overviewOccurrences(page, "committed before delete|")).toBe(0);
    for (const content of ["replacement before resume|", "persisted during deletion|", "after failure suffix|"]) {
      await expect.poll(() => overviewOccurrences(page, content)).toBe(1);
    }
    expect(failures).toEqual([retired.request]);
  } finally { releaseDelete.release(); await reads.dispose(); }
});
