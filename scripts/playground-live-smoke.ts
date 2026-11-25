/**
 * Live Playground smoke test against the real OpenAI, Anthropic and Google Gemini APIs.
 * It spends real money (well under one cent per run) and is never run by CI.
 *
 * Usage:
 *   RUNPHANTOM_PLAYGROUND_LIVE=1 OPENAI_API_KEY=… ANTHROPIC_API_KEY=… GEMINI_API_KEY=… bun scripts/playground-live-smoke.ts
 *
 * By default it starts a private in-process daemon on a temporary database. Set
 * RUNPHANTOM_PLAYGROUND_LIVE_URL=http://127.0.0.1:<port> to drive an already-running daemon instead
 * (that daemon must have the keys configured). Key values are never printed.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import type http from "node:http";
import { PLAYGROUND_DEFAULT_MODEL } from "../src/playground/protocol";

if (process.env.RUNPHANTOM_PLAYGROUND_LIVE !== "1") {
  console.error("Refusing to call paid provider APIs. Set RUNPHANTOM_PLAYGROUND_LIVE=1 to run the live Playground smoke test.");
  process.exit(2);
}

const TARGETS = [
  { provider: "openai", model: process.env.RUNPHANTOM_PLAYGROUND_LIVE_OPENAI_MODEL ?? PLAYGROUND_DEFAULT_MODEL.openai },
  { provider: "anthropic", model: process.env.RUNPHANTOM_PLAYGROUND_LIVE_ANTHROPIC_MODEL ?? PLAYGROUND_DEFAULT_MODEL.anthropic },
  { provider: "gemini", model: process.env.RUNPHANTOM_PLAYGROUND_LIVE_GEMINI_MODEL ?? PLAYGROUND_DEFAULT_MODEL.gemini },
] as const;

const WEATHER_TOOL = {
  name: "get_weather",
  description: "Returns the current weather for a city.",
  parameters: { type: "object", properties: { city: { type: "string", description: "City name" } }, required: ["city"], additionalProperties: false },
};

type Result = {
  index: number; provider: string; model: string; status: string; runId: string | null; spanId: string | null;
  output: { text: string; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown>; signature?: string }> };
  finishReason: string | null; responseModel: string | null; usage: Record<string, number | null>; latencyMs: number | null;
  timeToFirstTokenMs: number | null; warnings: string[]; error: { kind: string; message: string; providerMessage: string | null; httpStatus: number | null } | null;
};

let base = process.env.RUNPHANTOM_PLAYGROUND_LIVE_URL?.replace(/\/+$/, "") ?? "";
let server: http.Server | null = null;
let directory: string | null = null;
let failures = 0;

async function post(body: unknown): Promise<{ comparisonId: string; results: Result[] }> {
  const response = await fetch(`${base}/api/playground/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Playground returned HTTP ${response.status}: ${await response.text()}`);
  return response.json() as Promise<{ comparisonId: string; results: Result[] }>;
}

function summary(result: Result): Record<string, unknown> {
  return {
    target: `${result.provider}/${result.model}`, status: result.status, finishReason: result.finishReason, responseModel: result.responseModel,
    text: result.output.text.length > 160 ? `${result.output.text.slice(0, 160)}…` : result.output.text,
    toolCalls: result.output.toolCalls.map(call => ({ name: call.name, arguments: call.arguments, signature: call.signature ? "(present)" : undefined })),
    usage: result.usage, latencyMs: result.latencyMs, timeToFirstTokenMs: result.timeToFirstTokenMs, warnings: result.warnings, runId: result.runId,
    error: result.error,
  };
}

async function recorded(result: Result): Promise<Record<string, unknown>> {
  if (!result.runId) return { recorded: false };
  const detail = await (await fetch(`${base}/api/runs/detail/${result.runId}`)).json() as { run: { name: string; event_name: string }; spans: Array<Record<string, unknown>> };
  const llm = detail.spans.find(span => span.span_type === "LLM_GENERATION");
  return { recorded: true, runName: detail.run?.name, eventName: detail.run?.event_name, errorSpans: detail.spans.filter(span => span.status === "ERROR").length, spans: detail.spans.length, llmSpan: llm && { model: llm.model, provider: llm.provider, status: llm.status, input_tokens: llm.input_tokens, output_tokens: llm.output_tokens } };
}

async function main(): Promise<void> {
  if (!base) {
    directory = mkdtempSync(path.join(realpathSync(tmpdir()), "runphantom-playground-live-"));
    process.env.RUNPHANTOM_DB_PATH = path.join(directory, "traces.db");
    process.env.RUNPHANTOM_SECRET_STORE_PATH = path.join(directory, "secrets.json");
    process.env.RUNPHANTOM_CLAUDE_CLI_CHAT = "0";
    const { createServer } = await import("../src/server");
    ({ server } = await createServer(0));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  const models = await (await fetch(`${base}/api/playground/models`)).json() as { providers: Array<{ id: string; configured: boolean }> };
  console.log("Key status:", Object.fromEntries(models.providers.map(item => [item.id, item.configured ? "configured" : "missing"])));

  for (const target of TARGETS) {
    console.log(`\n=== ${target.provider}/${target.model}: tool-call round ===`);
    const firstTurn = {
      system: "You are a weather assistant. Always call get_weather before answering a weather question.",
      messages: [{ role: "user", content: "What is the weather in Paris right now? Answer in one sentence." }],
      tools: [WEATHER_TOOL], params: { maxOutputTokens: 1024, ...(target.provider === "openai" ? { reasoningEffort: "minimal" } : {}) },
      targets: [target],
    };
    const first = (await post(firstTurn)).results[0];
    console.log("Turn 1:", JSON.stringify(summary(first), null, 2));
    console.log("Turn 1 trace:", JSON.stringify(await recorded(first)));
    const call = first.output.toolCalls[0];
    if (first.status !== "ok" || !call) { failures++; continue; }
    const second = (await post({
      ...firstTurn,
      messages: [...firstTurn.messages, { role: "assistant", content: first.output.text, toolCalls: [call] }, { role: "tool", toolCallId: call.id, content: JSON.stringify({ city: "Paris", condition: "light rain", temperature_c: 11 }) }],
    })).results[0];
    console.log("Turn 2:", JSON.stringify(summary(second), null, 2));
    console.log("Turn 2 trace:", JSON.stringify(await recorded(second)));
    if (second.status !== "ok" || !second.output.text) failures++;
  }

  console.log("\n=== Side-by-side comparison (streamed) ===");
  const response = await fetch(`${base}/api/playground/runs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targets: TARGETS, stream: true, system: "Reply in at most eight words.", messages: [{ role: "user", content: "Name one benefit of tracing AI agents." }], params: { maxOutputTokens: 512, temperature: 0.2 } }),
  });
  const deltas = new Map<number, number>();
  for (const block of (await response.text()).trim().split("\n\n")) {
    const event = block.match(/^event: (.+)$/m)?.[1];
    const data = JSON.parse(block.match(/^data: (.+)$/m)?.[1] ?? "null");
    if (event === "delta") deltas.set(data.index, (deltas.get(data.index) ?? 0) + 1);
    if (event === "result") {
      console.log(JSON.stringify({ ...summary(data as Result), deltaEvents: deltas.get(data.index) ?? 0 }));
      if (data.status !== "ok") failures++;
    }
    if (event === "done") console.log("done", JSON.stringify(data));
  }
}

try {
  await main();
} finally {
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  if (directory) rmSync(directory, { recursive: true, force: true });
}
console.log(`\n${failures === 0 ? "All live checks passed." : `${failures} live check(s) did not succeed.`}`);
process.exit(failures === 0 ? 0 : 1);
