import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createSocket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExampleTrace } from "../examples/shared/runphantom";
import { spanErrorReason } from "../app/src/utils/helpers";
import type { Span } from "../app/src/utils/types";

// A provider rejection as the OpenAI SDK reports it; the examples copy it into
// both the span status message and the object-shaped output.
const REASON = "401 Incorrect API key provided: sk-bad. You can find your API key at https://platform.openai.com/account/api-keys.";

const directory = mkdtempSync(path.join(tmpdir(), "rp-llm-error-"));
let daemon: ChildProcess | undefined;
let url: string;

beforeAll(async () => {
  const socket = createSocket();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("RUNPHANTOM_") && key !== "OPENAI_API_KEY" && key !== "ANTHROPIC_API_KEY"));
  daemon = spawn(process.execPath, ["src/index.ts", "serve"], {
    cwd: path.resolve(import.meta.dir, ".."), stdio: "ignore",
    env: { ...env, HOME: directory, USERPROFILE: directory, RUNPHANTOM_DB_PATH: path.join(directory, "runs.db"), RUNPHANTOM_PORT: String(port),
      RUNPHANTOM_BIND_HOST: "127.0.0.1", RUNPHANTOM_SECRET_STORE_PATH: path.join(directory, "secrets.json"), RUNPHANTOM_CLAUDE_CLI_CHAT: "0" },
  });
  url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 400; attempt++) {
    if (daemon.exitCode !== null) throw new Error(`Fixture daemon exited: ${daemon.exitCode}`);
    try { if ((await fetch(`${url}/health`)).ok) return; } catch { /* process starting */ }
    await Bun.sleep(25);
  }
  throw new Error("Fixture daemon failed to start");
}, 30_000);

afterAll(async () => {
  if (daemon && daemon.exitCode === null) {
    const proc = daemon;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => proc.kill("SIGKILL"), 2000);
      proc.once("exit", () => { clearTimeout(timer); resolve(); });
      proc.kill("SIGTERM");
    });
  }
  rmSync(directory, { recursive: true, force: true });
});

async function llmSpan(runId: string): Promise<Span> {
  const response = await fetch(`${url}/api/runs/detail/${runId}`);
  expect(response.status).toBe(200);
  const detail = await response.json() as { spans: Span[] };
  const span = detail.spans.find(item => item.span_type === "LLM_GENERATION");
  if (!span) throw new Error(`No LLM span in ${JSON.stringify(detail.spans.map(item => item.span_type))}`);
  return span;
}

describe("failed LLM calls keep their reason from OTLP ingest to the run view", () => {
  test("the shipped examples' provider error reaches the LLM Error banner and the errors tooltip", async () => {
    const messages = [{ role: "user", content: "Say hello" }];
    const trace = new ExampleTrace("openai-chat", messages);
    // Mirrors the catch block of examples/openai-chat/server.ts.
    trace.addLlm({
      name: "openai.chat.completions",
      provider: "openai",
      model: "gpt-4o-mini",
      input: messages,
      output: { error: REASON },
      startedAtMs: Date.now() - 50,
      error: REASON,
    });
    const previous = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `${url}/v1/traces`;
    try { await trace.finish({ error: REASON }, REASON); }
    finally {
      if (previous === undefined) delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
      else process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = previous;
    }

    const span = await llmSpan(trace.traceId);
    expect(span.status).toBe("ERROR");
    expect(JSON.parse(span.attributes ?? "{}")["otel.status.message"]).toBe(REASON);
    // ChatFlow renders the LLM Error banner only for an ERROR span with an output payload.
    expect(span.output_payload).not.toBeNull();
    expect(JSON.parse(span.output_payload ?? "null")).toEqual({ error: REASON });
    expect(spanErrorReason(span)).toContain(REASON);
  });

  test("a failed LLM call with no output messages shows its status message in the errors tooltip", async () => {
    const traceId = "c0ffee00000000000000000000000d01";
    const response = await fetch(`${url}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{
        traceId, spanId: "c0ffee0000000d01", name: "chat gpt-4o-mini",
        startTimeUnixNano: "1000000", endTimeUnixNano: "2000000",
        attributes: [
          { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
          { key: "gen_ai.request.model", value: { stringValue: "gpt-4o-mini" } },
          { key: "gen_ai.input.messages", value: { stringValue: JSON.stringify([{ role: "user", parts: [{ type: "text", content: "Say hello" }] }]) } },
        ],
        status: { code: 2, message: REASON },
      }] }] }] }),
    });
    expect(response.status).toBe(200);

    const span = await llmSpan(traceId);
    expect(span.status).toBe("ERROR");
    expect(span.output_payload).toBeNull();
    expect(spanErrorReason(span)).toBe(REASON);
  });
});
