import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { FIXTURE_PRIMARY_RUN_ID, seedRunPhantomFixtures } from "./helpers";

type ControlledSocket = {
  readyState: number;
  open(): void;
  fail(): void;
  disconnect(): void;
  lateEvents(): void;
};
type ControlledWindow = Window & { daemonSockets: ControlledSocket[] };

// Hold only the daemon handshake. HTTP, verification sockets and other WebSockets
// retain their real implementations; no application state or React hooks are mocked.
async function holdDaemonHandshake(page: Page) {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const sockets: ControlledSocket[] = [];
    (window as unknown as ControlledWindow).daemonSockets = sockets;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args: ConstructorParameters<typeof WebSocket>) {
        const url = new URL(String(args[0]), location.href);
        if (url.host !== location.host || url.pathname !== "/ws") {
          return Reflect.construct(target, args);
        }
        class DaemonSocket extends EventTarget {
          readyState: number = NativeWebSocket.CONNECTING;
          onopen: ((event: Event) => void) | null = null;
          onerror: ((event: Event) => void) | null = null;
          onclose: ((event: Event) => void) | null = null;
          onmessage = null;
          retiredOpen: ((event: Event) => void) | null = null;
          retiredClose: ((event: Event) => void) | null = null;
          send() {}
          close() {
            this.retiredOpen ??= this.onopen;
            this.retiredClose ??= this.onclose;
            this.readyState = NativeWebSocket.CLOSED;
            this.onclose?.(new Event("close"));
          }
          open() {
            this.readyState = NativeWebSocket.OPEN;
            this.onopen?.(new Event("open"));
          }
          fail() {
            this.retiredOpen = this.onopen;
            this.retiredClose = this.onclose;
            // Error without a following close must still recover.
            this.onerror?.(new Event("error"));
          }
          disconnect() { this.close(); }
          lateEvents() {
            this.retiredOpen?.(new Event("open"));
            this.retiredClose?.(new Event("close"));
          }
        }
        const socket = new DaemonSocket();
        sockets.push(socket);
        return socket;
      },
    });
  });
}

async function socketAction(page: Page, index: number, action: "open" | "fail" | "disconnect" | "lateEvents") {
  await page.evaluate(({ index, action }) => {
    (window as unknown as ControlledWindow).daemonSockets[index]![action]();
  }, { index, action });
}

async function expectSocketCount(page: Page, count: number) {
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as ControlledWindow).daemonSockets.length)).toBe(count);
}

const offlineDialog = (page: Page) => page.getByRole("alertdialog", { name: "Run Phantom isn't running." });

async function expectOffline(page: Page) {
  await page.clock.runFor(200);
  await expect(offlineDialog(page)).toBeVisible();
  await page.clock.runFor(50);
  await expect(offlineDialog(page)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(offlineDialog(page)).toBeFocused();
}

test("delayed healthy startup preserves skip focus and entered pairing origin", async ({ page, runPhantom }) => {
  await holdDaemonHandshake(page);
  await page.goto(`${runPhantom.url}/verification`);
  await expectSocketCount(page, 1);
  const origin = page.getByLabel(/^App origin/);
  await expect(origin).toBeVisible();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to trace workspace" });
  await expect(skip).toBeFocused();
  // Cross the old 100 ms offline deadline while the handshake is still pending.
  await page.clock.runFor(500);
  await expect(offlineDialog(page)).toHaveCount(0);
  await expect(skip).toBeFocused();
  await origin.fill("http://localhost:3000");
  await page.clock.runFor(500);
  await expect(origin).toHaveValue("http://localhost:3000");
  await expect(origin).toBeFocused();
  await expect(page.getByRole("button", { name: "Pair app", exact: true })).toBeEnabled();
  await socketAction(page, 0, "open");
  await page.clock.runFor(12_000);
  await expect(offlineDialog(page)).toHaveCount(0);
  await expect(origin).toBeFocused();
  await expect(origin).toHaveValue("http://localhost:3000");
  await expectSocketCount(page, 1);
});

for (const failure of ["fail", "disconnect"] as const) {
  test(`${failure} surfaces offline and stays offline until successful reconnect`, async ({ page, runPhantom }) => {
    await holdDaemonHandshake(page);
    await page.goto(`${runPhantom.url}/verification`);
    await expectSocketCount(page, 1);
    const origin = page.getByLabel(/^App origin/);
    await origin.fill("http://localhost:3000");
    // Cover an initial handshake error and a close after a healthy connection.
    if (failure === "disconnect") await socketAction(page, 0, "open");
    await socketAction(page, 0, failure);
    await expectOffline(page);
    await page.clock.runFor(2_000);
    await expectSocketCount(page, 2);
    await expect(offlineDialog(page)).toBeVisible();
    await socketAction(page, 0, "lateEvents");
    await page.clock.runFor(200);
    await expect(offlineDialog(page)).toBeVisible();
    await socketAction(page, 1, "open");
    await expect(offlineDialog(page)).toHaveCount(0);
    await page.clock.runFor(12_000);
    await expect(origin).toBeFocused();
    await expect(origin).toHaveValue("http://localhost:3000");
    await expectSocketCount(page, 2);
    await expect(offlineDialog(page)).toHaveCount(0);
  });
}

test("never completing handshakes time out, retry once per attempt, and recover", async ({ page, runPhantom }) => {
  await holdDaemonHandshake(page);
  await page.goto(`${runPhantom.url}/verification`);
  await expectSocketCount(page, 1);
  await page.clock.runFor(9_000);
  await expect(offlineDialog(page)).toHaveCount(0);
  await page.clock.runFor(1_000);
  await expectOffline(page);
  expect(await page.evaluate(() => (window as unknown as ControlledWindow).daemonSockets[0]!.readyState)).toBe(3);
  await page.clock.runFor(2_000);
  await expectSocketCount(page, 2);
  await expect(offlineDialog(page)).toBeVisible();
  await page.clock.runFor(10_000);
  await expect(offlineDialog(page)).toBeVisible();
  await page.clock.runFor(2_000);
  await expectSocketCount(page, 3);
  await socketAction(page, 2, "open");
  await expect(offlineDialog(page)).toHaveCount(0);
  await page.clock.runFor(12_000);
  await expectSocketCount(page, 3);
  await expect(offlineDialog(page)).toHaveCount(0);
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function holdProviderHandshake(page: Page) {
  const received = gate();
  let release!: () => void;
  let droppedSpans = 0;
  await page.routeWebSocket("**/ws", socket => {
    const server = socket.connectToServer();
    let held = true;
    server.onMessage(message => {
      const envelope = JSON.parse(message.toString()) as { event?: string };
      if (held && envelope.event === "spans") { droppedSpans++; return; }
      if (held && envelope.event === "agent_provider") {
        release = () => { held = false; socket.send(message); };
        received.release();
        return;
      }
      socket.send(message);
    });
  });
  return { received: received.promise, release: () => release(), droppedSpans: () => droppedSpans };
}

test("a delayed same-provider handshake preserves Debug's message and header", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  const handshake = await holdProviderHandshake(page);
  const detailUrl = `${runPhantom.url}/api/runs/detail/${FIXTURE_PRIMARY_RUN_ID}`;
  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  await handshake.received;
  expect(await page.evaluate(() => localStorage.getItem("runphantom:messagePane:providerIntroSeen"))).toBeNull();
  await page.getByRole("button", { name: "Debug", exact: true }).click();
  const pane = page.getByRole("complementary", { name: "Coding-agent debug chat" });
  const prompt = "What went wrong here?";
  const disabled = page.waitForResponse(response => response.url().endsWith("/api/agent/messages") && response.request().method() === "POST");
  await pane.getByRole("button", { name: prompt, exact: true }).click();
  expect((await disabled).status()).toBe(409);
  const firstMessage = pane.getByRole("log", { name: "Debug chat messages" }).locator(":scope > *").first().locator(":scope > *");
  await expect(firstMessage).toHaveText(prompt);

  const refreshed = page.waitForResponse(detailUrl);
  handshake.release();
  await refreshed;
  await expect(firstMessage).toHaveText(prompt);
  await expect(pane.locator("header")).toBeVisible();
  await expect(pane.getByRole("button", { name: "Hide", exact: true })).toHaveCount(0);
  await expect(pane.getByText("Connect your coding agent", { exact: true })).toHaveCount(0);
});

test("the connection handshake catches up spans whose broadcast was missed", async ({ page, request, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  const detailUrl = `${runPhantom.url}/api/runs/detail/${FIXTURE_PRIMARY_RUN_ID}`;
  const detail = await (await request.get(detailUrl)).json();
  const expectedBars = detail.spans.filter((span: { span_type: string | null }) =>
    span.span_type === "TRACE" || span.span_type === "TOOL_CALL" || span.span_type?.includes("LLM"),
  ).length;
  expect(expectedBars).toBeGreaterThan(0);
  const handshake = await holdProviderHandshake(page);
  let spansArrived = false;
  const activity = "Waiting for the first completed span.";
  await page.route(detailUrl, route => spansArrived ? route.continue() : route.fulfill({ json: {
    ...detail, spans: [], subAgents: [],
    liveEvents: [{ id: 1, trace_id: FIXTURE_PRIMARY_RUN_ID, span_id: null, type: "reasoning", content: activity,
      timestamp: detail.run.started_at, metadata: null }],
  } }));
  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  await handshake.received;
  await expect(page.getByText(activity, { exact: true })).toBeVisible();
  const bars = page.locator('button.timeline-bar, button[aria-label^="Jump to "]');
  await expect(bars).toHaveCount(0);
  spansArrived = true;
  await seedRunPhantomFixtures(runPhantom.url);
  await expect.poll(() => handshake.droppedSpans()).toBeGreaterThan(0);
  await expect(bars).toHaveCount(0);

  const refreshed = page.waitForResponse(detailUrl);
  handshake.release();
  expect((await refreshed).ok()).toBe(true);
  await expect(bars).toHaveCount(expectedBars);
});

test("a genuine provider change clears chat state and supersedes the initial provider GET", async ({ page, request, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  const initialProvider = gate();
  const releaseInitialProvider = gate();
  const handshake = await holdProviderHandshake(page);
  await page.route("**/api/agent/provider", async route => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    initialProvider.release();
    await releaseInitialProvider.promise;
    await route.fulfill({ response });
  });
  try {
    await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
    await initialProvider.promise;
    await handshake.received;
    const initialRefresh = page.waitForResponse(`${runPhantom.url}/api/runs/detail/${FIXTURE_PRIMARY_RUN_ID}`);
    handshake.release();
    await initialRefresh;
    await page.getByRole("button", { name: "Debug", exact: true }).click();
    const pane = page.getByRole("complementary", { name: "Coding-agent debug chat" });
    const disabled = page.waitForResponse(response => response.url().endsWith("/api/agent/messages") && response.request().method() === "POST");
    await pane.getByRole("button", { name: "What went wrong here?", exact: true }).click();
    expect((await disabled).status()).toBe(409);
    await expect(pane.getByRole("log", { name: "Debug chat messages" })).toContainText("What went wrong here?");

    const sessions = page.waitForResponse(response => new URL(response.url()).pathname === "/api/agent/sessions");
    const changed = await request.post(`${runPhantom.url}/api/agent/provider`, { data: { provider: "codex" } });
    expect(changed.ok()).toBe(true);
    expect((await sessions).ok()).toBe(true);
    await expect(pane.getByText("Your Recent Codex Chats", { exact: true })).toBeVisible();
    await expect(pane.getByRole("log", { name: "Debug chat messages" })).toHaveCount(0);

    const staleProvider = page.waitForResponse(`${runPhantom.url}/api/agent/provider`);
    releaseInitialProvider.release();
    await (await staleProvider).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect(pane.getByRole("button", { name: "Connect Codex", exact: true })).toBeVisible();
    await expect(pane.getByText("Your Recent Claude Code Chats", { exact: true })).toHaveCount(0);
  } finally {
    releaseInitialProvider.release();
  }
});
