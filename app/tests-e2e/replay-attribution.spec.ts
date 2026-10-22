import { createHash } from "node:crypto";
import { test, expect, replayTelemetry, SOURCE_RUN_ID, SOURCE_OUTPUT, REPLAY_OUTPUT } from "./replay-debugging-fixture";

test.use({ viewport: { width: 1440, height: 900 } });

test("cancelled replay evidence cannot replace a completed concurrent attempt or its source", async ({ page, context, request, runPhantom, localReplayAgent }, testInfo) => {
  const exported = async (id: string) => {
    const response = await request.get(`${runPhantom.url}/api/runs/${id}/export`);
    expect(response.status()).toBe(200);
    return response.json();
  };
  const source = await exported(SOURCE_RUN_ID);
  localReplayAgent.mode = "hold";
  const document = await page.goto(`${runPhantom.url}/runs/${SOURCE_RUN_ID}`);
  expect(document?.status()).toBe(200);
  expect(document?.headers()["content-type"]).toContain("text/html");
  await page.getByRole("button", { name: "Replay", exact: true }).click();
  await expect.poll(() => localReplayAgent.requests.length).toBe(1);
  const cancelled = localReplayAgent.requests[0].replayRunId;
  const other = await context.newPage();
  try {
    localReplayAgent.mode = "success";
    await other.goto(`${runPhantom.url}/runs/${SOURCE_RUN_ID}`);
    await other.getByRole("button", { name: "Replay", exact: true }).click();
    await expect.poll(() => localReplayAgent.traceIds.length).toBe(1);
    const completedId = localReplayAgent.traceIds[0];
    await expect(other).toHaveURL(new RegExp(`/runs/${completedId}$`));
    await expect(other.getByText(REPLAY_OUTPUT, { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Replaying agent…", { exact: true })).toBeVisible();
    await expect(page.getByText(REPLAY_OUTPUT, { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "cancel", exact: true }).click();
    await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
    await expect.poll(() => localReplayAgent.disconnectedRequests).toContain(cancelled);
    await expect.poll(async () => JSON.parse((await exported(cancelled)).run.metadata).replay.error?.code).toBe("replay_cancelled");
    const stopped = await exported(cancelled), completed = await exported(completedId);
    const lateId = "f9000000000000000000000000000002";
    const lateOutput = "Delayed evidence from the cancelled local endpoint fixture";
    const telemetry = replayTelemetry(lateId, "Late cancelled request", cancelled);
    const answer = telemetry.resourceSpans[0].scopeSpans[0].spans[2];
    answer.attributes.find(attribute => attribute.key === "ai.response.text")!.value.stringValue = lateOutput;
    expect((await request.post(`${runPhantom.url}/v1/traces`, { data: telemetry })).status()).toBe(200);

    await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
    await expect(page.getByText(lateOutput, { exact: true })).toHaveCount(0);
    await expect(page.getByText(REPLAY_OUTPUT, { exact: true })).toHaveCount(0);
    await expect(other).toHaveURL(new RegExp(`/runs/${completedId}$`));
    expect(await exported(cancelled)).toEqual(stopped);
    expect(stopped.spans).toHaveLength(0);
    expect(await exported(completedId)).toEqual(completed);
    expect(await exported(SOURCE_RUN_ID)).toEqual(source);
    const late = await exported(lateId);
    expect(late.run.metadata).toBeNull();
    expect(late.spans.some((span: { output_payload: string }) => span.output_payload === lateOutput)).toBe(true);
    await page.getByText("Stopped", { exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByText("Stopped", { exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("replay-cancelled-late.png") });
    await testInfo.attach("controlled-endpoint-attribution", { body: Buffer.from(JSON.stringify({ fixture: "Loopback endpoint; no tool or paid provider execution",
      cancelled, completedId, lateId, cancelledError: JSON.parse(stopped.run.metadata).replay.error.code,
      sourceUnchanged: true, completedDigest: createHash("sha256").update(JSON.stringify(completed)).digest("hex") }, null, 2)), contentType: "application/json" });

    await other.getByRole("button", { name: "compare", exact: true }).click();
    await expect(other.getByRole("separator", { name: "Resize replay comparison" })).toBeVisible();
    await other.getByText(SOURCE_OUTPUT, { exact: true }).first().scrollIntoViewIfNeeded();
    await other.getByText(REPLAY_OUTPUT, { exact: true }).first().scrollIntoViewIfNeeded();
    await expect(other.getByText(SOURCE_OUTPUT, { exact: true }).first()).toBeInViewport({ ratio: 1 });
    await expect(other.getByText(REPLAY_OUTPUT, { exact: true }).first()).toBeInViewport({ ratio: 1 });
    expect(JSON.parse((await exported(completedId)).run.metadata).replay.sourceRunId).toBe(SOURCE_RUN_ID);
    await other.screenshot({ path: testInfo.outputPath("replay-attributed-comparison.png") });
    await other.getByRole("button", { name: "Close original run comparison" }).click();
    const reopened = await other.reload();
    expect(reopened?.status()).toBe(200);
    expect(reopened?.headers()["content-type"]).toContain("text/html");
    await expect(other.getByText(REPLAY_OUTPUT, { exact: true }).first()).toBeVisible();
    await other.getByRole("button", { name: "compare", exact: true }).click();
    await expect(other.getByText(SOURCE_OUTPUT, { exact: true }).first()).toBeVisible();
    await expect(other.getByText(REPLAY_OUTPUT, { exact: true }).first()).toBeVisible();
    expect(await exported(completedId)).toEqual(completed);
    await page.goto(`${runPhantom.url}/runs/${lateId}`);
    await expect(page.getByText(lateOutput, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Replay again", exact: true })).toHaveCount(0);
    expect(await exported(cancelled)).toEqual(stopped);
  } finally { await other.close(); }
});
