import type { WebSocketRoute } from "@playwright/test";
import { test, expect } from "./fixtures";
import { FIXTURE_PRIMARY_RUN_ID, seedRunPhantomFixtures } from "./helpers";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

for (const firstStatus of [200, 503]) {
  test(`same-run recovery and captured updates queue one fresh read after a held ${firstStatus} snapshot`, async ({ page, request, runPhantom }, info) => {
    await seedRunPhantomFixtures(runPhantom.url);
    const detailUrl = `${runPhantom.url}/api/runs/detail/${FIXTURE_PRIMARY_RUN_ID}`;
    const original = await (await request.get(detailUrl)).json();
    const held = gate(), release = gate(), broadcast = gate();
    const healthyFailures: string[] = [];
    const snapshots: Array<{ spans: Array<{ id: string; output_payload: string | null }> }> = [];
    let reads = 0;
    let socket: WebSocketRoute | undefined;
    page.on("requestfailed", failed => {
      if (failed.url() === detailUrl) healthyFailures.push(failed.failure()?.errorText ?? "unknown");
    });
    await page.routeWebSocket("**/ws", route => {
      socket = route;
      const server = route.connectToServer();
      server.onMessage(message => {
        route.send(message);
        const frame = JSON.parse(message.toString());
        if (frame.event === "spans" && frame.data?.runIds?.includes(FIXTURE_PRIMARY_RUN_ID)) broadcast.release();
      });
    });
    await page.route(detailUrl, async route => {
      const number = ++reads;
      const response = await route.fetch();
      const snapshot = await response.json();
      if (number === 1) {
        held.release();
        await release.promise;
      }
      snapshots.push(snapshot);
      if (number === 1 && firstStatus === 503) await route.fulfill({ status: 503, json: { error: "Controlled held read failure" } });
      else await route.fulfill({ response });
    });
    const answer = `Fresh captured answer after held ${firstStatus} read.`;
    const spanId = firstStatus === 200 ? "000000010000f201" : "000000010000f202";
    try {
      await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
      await held.promise;
      await expect(page.locator("[data-connection-status]")).toHaveAttribute("data-connection-status", "connected");
      expect(socket).toBeDefined();
      const ingested = await request.post(`${runPhantom.url}/v1/traces`, { data: {
        resourceSpans: [{ scopeSpans: [{ spans: [{
          traceId: FIXTURE_PRIMARY_RUN_ID, spanId,
          parentSpanId: original.spans.find((span: { parent_span_id: string | null }) => !span.parent_span_id).id,
          name: "queued_refresh_answer", kind: 1,
          startTimeUnixNano: String(BigInt(original.run.started_at + 4000) * 1_000_000n),
          endTimeUnixNano: String(BigInt(original.run.started_at + 4500) * 1_000_000n),
          status: { code: 1 },
          attributes: [
            { key: "ai.operationId", value: { stringValue: "ai.generateText" } },
            { key: "ai.prompt.messages", value: { stringValue: JSON.stringify([{ role: "user", content: "Queued captured request" }]) } },
            { key: "ai.response.text", value: { stringValue: answer } },
          ],
        }] }] }],
      } });
      expect(ingested.status()).toBe(200);
      expect((await ingested.json()).spansIngested).toBe(1);
      await broadcast.promise;
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      // The real handshake and new-span notification must not replace a healthy held read.
      expect(reads).toBe(1);
      expect(healthyFailures).toEqual([]);
      release.release();
      await expect(page.getByText(answer, { exact: true })).toBeVisible();
      await expect.poll(() => reads).toBe(2);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[0].spans.some(span => span.id === spanId)).toBe(false);
      expect(snapshots[1].spans.find(span => span.id === spanId)?.output_payload).toBe(answer);
      expect(healthyFailures).toEqual([]);
      expect(page.url()).toBe(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
      await info.attach("held-read-and-queued-source-refresh", { body: JSON.stringify({ firstStatus, reads, healthyFailures, exactCapturedOutput: answer }), contentType: "application/json" });
    } finally { release.release(); }
  });
}
