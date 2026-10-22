import type { WebSocketRoute } from "@playwright/test";
import { test, expect } from "./fixtures";
import { FIXTURE_PRIMARY_RUN_ID, seedRunPhantomFixtures } from "./helpers";

test("a mounted run recovers spans committed during a real daemon socket outage", async ({ page, request, runPhantom }, testInfo) => {
  await seedRunPhantomFixtures(runPhantom.url);
  let socket: WebSocketRoute | undefined;
  let outage = false;
  let receivedFrames = 0;
  await page.routeWebSocket("**/ws", route => {
    if (outage) {
      void route.close({ code: 1013, reason: "Controlled transport outage" });
      return;
    }
    socket = route;
    const server = route.connectToServer();
    server.onMessage(message => {
      receivedFrames++;
      route.send(message);
    });
  });
  const detailUrl = `${runPhantom.url}/api/runs/detail/${FIXTURE_PRIMARY_RUN_ID}`;
  const original = await (await request.get(detailUrl)).json();
  const countBars = (spans: { span_type: string | null }[]) => spans.filter(span =>
    span.span_type === "TRACE" || span.span_type === "TOOL_CALL" || span.span_type?.includes("LLM"),
  ).length;
  const originalBars = countBars(original.spans);
  expect(originalBars).toBeGreaterThan(0);
  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  const bars = page.locator('button.timeline-bar, button[aria-label^="Jump to "]');
  await expect(bars).toHaveCount(originalBars);
  await expect(page.locator("[data-connection-status]")).toHaveAttribute("data-connection-status", "connected");
  await expect.poll(() => receivedFrames).toBeGreaterThan(0);
  const framesBeforeOutage = receivedFrames;
  outage = true;
  await socket!.close({ code: 1001, reason: "Controlled connection interruption" });
  await expect(page.locator("[data-connection-status]")).toHaveAttribute("data-connection-status", "disconnected");

  const answer = "Output captured while the investigation was disconnected.";
  const response = await request.post(`${runPhantom.url}/v1/traces`, { data: {
    resourceSpans: [{ scopeSpans: [{ spans: [{
      traceId: FIXTURE_PRIMARY_RUN_ID,
      spanId: "00000001000000f1",
      parentSpanId: original.spans.find((span: { parent_span_id: string | null }) => !span.parent_span_id).id,
      name: "offline_capture",
      kind: 1,
      startTimeUnixNano: String(BigInt(original.run.started_at + 4000) * 1_000_000n),
      endTimeUnixNano: String(BigInt(original.run.started_at + 4500) * 1_000_000n),
      status: { code: 1 },
      attributes: [
        { key: "ai.operationId", value: { stringValue: "ai.toolCall" } },
        { key: "ai.toolCall.name", value: { stringValue: "offline_capture" } },
        { key: "ai.toolCall.args", value: { stringValue: "{}" } },
        { key: "ai.toolCall.result", value: { stringValue: answer } },
      ],
    }] }] }],
  } });
  expect(response.status()).toBe(200);
  expect((await response.json()).spansIngested).toBe(1);
  const committed = await (await request.get(detailUrl)).json();
  expect(countBars(committed.spans)).toBe(originalBars + 1);
  expect(committed.spans.find((span: { id: string }) => span.id === "00000001000000f1").output_payload).toContain(answer);
  await expect(bars).toHaveCount(originalBars);

  outage = false;
  await expect(page.locator("[data-connection-status]")).toHaveAttribute("data-connection-status", "connected");
  await expect.poll(() => receivedFrames).toBeGreaterThan(framesBeforeOutage);
  // No navigation, replayed fixture event, second ingestion or manual refresh.
  await expect(bars).toHaveCount(originalBars + 1);
  await expect(page.getByRole("alertdialog", { name: "Run Phantom isn't running.", exact: true })).toBeHidden();
  expect(page.url()).toBe(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  await testInfo.attach("recovered-live-trajectory", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
});
