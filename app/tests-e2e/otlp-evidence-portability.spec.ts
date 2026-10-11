import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import { fidelityOutput, fidelityRequest, fidelitySpanId, fidelityTraceId } from "../../tests/fixtures/otlp-evidence";
import { expect, test, REPO_ROOT_PATH } from "./fixtures";

async function independentStore() {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "rp-fidelity-browser-"));
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("RUNPHANTOM_") && key !== "OPENAI_API_KEY" && key !== "ANTHROPIC_API_KEY"));
  const proc: ChildProcess = spawn("bun", ["src/index.ts", "serve"], { cwd: REPO_ROOT_PATH, stdio: "ignore",
    env: { ...inherited, HOME: directory, USERPROFILE: directory, RUNPHANTOM_PORT: String(port), RUNPHANTOM_BIND_HOST: "127.0.0.1",
      RUNPHANTOM_DB_PATH: path.join(directory, "destination.db"), RUNPHANTOM_SECRET_STORE_PATH: path.join(directory, "secrets.json"),
      RUNPHANTOM_CLAUDE_CLI_CHAT: "0", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" } });
  const close = async () => {
    if (proc.exitCode === null && proc.signalCode === null) await new Promise<void>(resolve => {
      const timer = setTimeout(() => proc.kill("SIGKILL"), 2500);
      proc.once("exit", () => { clearTimeout(timer); resolve(); }); proc.kill("SIGTERM");
    });
    rmSync(directory, { recursive: true, force: true });
  };
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (proc.exitCode !== null || proc.signalCode !== null) throw new Error("Owned destination daemon exited");
      try { const response = await fetch(`${url}/health`); if (response.ok && (await response.json()).pid === proc.pid) return { url, close }; } catch { /* starting */ }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Owned destination daemon did not become healthy");
  } catch (error) { await close(); throw error; }
}

async function downloadTrace(page: Page) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const download = await pending, file = await download.path();
  if (!file) throw new Error("Actual downloaded trace has no file");
  expect(download.suggestedFilename()).toBe(`trace-${fidelityTraceId}.json`);
  return { file, trace: JSON.parse(readFileSync(file, "utf8")) };
}

test("bounded OTLP evidence survives actual save, cache clear, file import, reload and download with the original visible output", async ({ page, request, runPhantom }, testInfo) => {
  const destination = await independentStore(), pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  try {
    // Captured local telemetry only; no provider or registered agent is executed.
    const body = fidelityRequest() as any, spans = body.resourceSpans[0].scopeSpans[0].spans;
    spans.push({ ...structuredClone(spans[0]), spanId: "1020304050607081", parentSpanId: fidelitySpanId, name: "Local captured answer",
      startTimeUnixNano: "1770000000000000011", endTimeUnixNano: "1770000000000123446",
      attributes: [{ key: "gen_ai.operation.name", value: { stringValue: "chat" } },
        { key: "gen_ai.input.messages", value: { stringValue: JSON.stringify([{ role: "user", content: "Inspect checkout A-42" }]) } },
        { key: "gen_ai.output.messages", value: { stringValue: JSON.stringify([{ role: "assistant", content: fidelityOutput }]) } }],
    });
    expect((await request.post(`${runPhantom.url}/v1/traces`, { data: body })).status()).toBe(200);
    const sourceResponse = await request.get(`${runPhantom.url}/api/runs/${fidelityTraceId}/export`);
    expect(sourceResponse.status()).toBe(200); const original = await sourceResponse.json();
    expect(original.format).toBe("runphantom-trace/v2"); expect(original.spans).toHaveLength(2);
    const sourceSpan = original.spans.find((span: any) => span.id === fidelitySpanId), envelope = JSON.parse(sourceSpan.otlp_evidence);
    expect(sourceSpan.output_payload).toBe(fidelityOutput);
    expect(envelope).toMatchObject({ startTimeUnixNano: "1770000000000000001", endTimeUnixNano: "1770000000000123456",
      resource: { schemaUrl: "https://schemas.example/resource/1", droppedAttributesCount: 0 },
      scope: { schemaUrl: "https://schemas.example/scope/1", droppedAttributesCount: 2 },
      capture: { droppedEvents: 0, droppedLinks: 0, redactedValues: 0 } });
    expect(envelope.events[0].attributes[0].value).toEqual({ intValue: "9007199254740993" });
    expect(envelope.events[1].droppedAttributesCount).toBeNull(); expect(envelope.links[0].flags).toBe(0);

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${runPhantom.url}/runs/${fidelityTraceId}`);
    const output = page.getByText(fidelityOutput, { exact: true }).first();
    await expect(output).toBeVisible(); await output.scrollIntoViewIfNeeded();
    expect((await downloadTrace(page)).trace).toEqual(original);
    await page.screenshot({ path: testInfo.outputPath("fidelity-source.png") });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
    await page.goto(`${runPhantom.url}/saved/${fidelityTraceId}`);
    await expect(output).toBeVisible();
    await expect.poll(async () => {
      const response = await request.get(`${runPhantom.url}/api/saved-runs/cache/${fidelityTraceId}`);
      return response.status() === 200 ? (await response.json()).spans.find((span: any) => span.id === fidelitySpanId)?.otlp_evidence : null;
    }).toBe(sourceSpan.otlp_evidence);
    expect((await request.post(`${runPhantom.url}/api/clear`)).status()).toBe(200);
    await page.goto(`${runPhantom.url}/saved/${fidelityTraceId}`);
    await expect(output).toBeVisible();
    const cached = await downloadTrace(page);
    expect(cached.trace).toMatchObject({ format: "runphantom-trace/v2", exportSource: "saved-cache" });
    expect(cached.trace.exportNotice).toContain("may be compacted");
    expect(cached.trace.spans.find((span: any) => span.id === fidelitySpanId).otlp_evidence).toBe(sourceSpan.otlp_evidence);
    expect(cached.trace.spans.find((span: any) => span.id === fidelitySpanId).output_payload).toBe(fidelityOutput);
    await output.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath("fidelity-saved-cache.png") });

    expect((await request.get(`${destination.url}/api/runs/${fidelityTraceId}/export`)).status()).toBe(404);
    await page.goto(`${destination.url}/search`);
    await page.getByLabel("Import trace file", { exact: true }).setInputFiles(cached.file);
    await expect(page).toHaveURL(new RegExp(`/search/${fidelityTraceId}$`));
    await expect(output).toBeVisible(); await page.reload(); await expect(output).toBeVisible();
    const restored = await downloadTrace(page);
    expect(restored.trace.format).toBe("runphantom-trace/v2");
    const restoredSpan = restored.trace.spans.find((span: any) => span.id === fidelitySpanId);
    expect(restoredSpan.otlp_evidence).toBe(sourceSpan.otlp_evidence); expect(restoredSpan.output_payload).toBe(fidelityOutput);
    expect(restored.trace.spans.map((span: any) => span.otlp_evidence)).toEqual(original.spans.map((span: any) => span.otlp_evidence));
    const restoredResponse = await request.get(`${destination.url}/api/runs/${fidelityTraceId}/export`);
    expect(restoredResponse.status()).toBe(200); expect(await restoredResponse.json()).toEqual(restored.trace);
    expect(await (await request.get(`${runPhantom.url}/api/runs/${fidelityTraceId}/export`)).json()).toEqual(cached.trace);
    await expect(page.getByText("1 run loaded", { exact: true })).toBeVisible();
    await output.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath("fidelity-imported.png") });

    const rejected = structuredClone(restored.trace), invalidEvidence = JSON.parse(rejected.spans[0].otlp_evidence);
    invalidEvidence.startTimeUnixNano = 1770000000000000000;
    rejected.spans[0].otlp_evidence = JSON.stringify(invalidEvidence);
    await page.goto(`${destination.url}/search`);
    const refusal = page.waitForResponse(response => response.url() === `${destination.url}/api/import-run` && response.request().method() === "POST");
    await page.getByLabel("Import trace file", { exact: true }).setInputFiles({ name: "invalid-evidence-v2.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(rejected)) });
    expect((await refusal).status()).toBe(400);
    await expect(page.getByRole("alert").filter({ hasText: "Import failed" })).toBeVisible();
    expect(await (await request.get(`${destination.url}/api/runs/${fidelityTraceId}/export`)).json()).toEqual(restored.trace);
    expect(pageErrors).toEqual([]);
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    await testInfo.attach("actual-portable-evidence.json", { contentType: "application/json", body: Buffer.from(JSON.stringify({ fixture: "local captured telemetry; no provider execution", original, cached: cached.trace, restored: restored.trace,
      envelopeDigests: { original: digest(sourceSpan.otlp_evidence), restored: digest(restoredSpan.otlp_evidence) }, pageErrors }, null, 2)) });
  } finally { await destination.close(); }
});
