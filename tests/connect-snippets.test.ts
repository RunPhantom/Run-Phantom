import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseOtlpRequest } from "../src/parse";
import {
  cliCommand, codingAgentGuides, curlSnippet, endpointForPort, envSnippet, exampleCommand, isConnectTab, openTelemetryEnv,
  pythonSnippet, setupCommand, typescriptSnippet, wrapCommand,
} from "../app/src/components/connect/connect-snippets";
import { TEST_RUN_NAME, buildTestTrace, sendTestTrace } from "../app/src/components/connect/test-span";
import { readLocalService } from "../app/src/shell/otlp";

const posix = process.platform !== "win32";
let server: ReturnType<typeof Bun.serve>;
let received: { contentType: string | null; body: unknown }[] = [];
let workdir: string;

beforeAll(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "rp-connect-snippets-"));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/traces" || request.method !== "POST") return new Response("no", { status: 404 });
      received.push({ contentType: request.headers.get("content-type"), body: await request.json() });
      return Response.json({ ok: true });
    },
  });
});

afterAll(async () => {
  await server.stop(true);
  rmSync(workdir, { recursive: true, force: true });
});

function endpoint() { return endpointForPort(server.port!); }

/** Async: the capture server shares this event loop, so a blocking spawn would never be answered. */
async function run(command: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(command, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { status, stderr };
}

/** The daemon's own parser: what it accepts is what the snippet must produce. */
function lastParsed() {
  const last = received.at(-1);
  expect(last?.contentType).toContain("application/json");
  const spans = parseOtlpRequest(last!.body);
  expect(spans.length).toBeGreaterThan(0);
  for (const span of spans) {
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.endTimeMs).toBeGreaterThanOrEqual(span.startTimeMs);
    expect(Math.abs(span.startTimeMs - Date.now())).toBeLessThan(60_000);
  }
  return spans;
}

describe("connect commands", () => {
  test("a source checkout uses the linked dev CLI and names a non-default port", () => {
    expect(cliCommand({ port: 5947, runtime: "source" }, "setup --global")).toBe("bun x runphantom-dev setup --global");
    expect(cliCommand({ port: 6540, runtime: "source" }, "setup --global")).toBe("RUNPHANTOM_PORT=6540 bun x runphantom-dev setup --global");
    expect(cliCommand({ port: 5947, runtime: "binary" }, "setup --global")).toBe("runphantom setup --global");
    expect(setupCommand({ port: 6540, runtime: "binary" })).toBe("RUNPHANTOM_PORT=6540 runphantom setup --global");
  });

  test("an unknown port stays a visible placeholder instead of falling back to 5947", () => {
    expect(cliCommand({ port: null, runtime: "source" }, "setup --global")).toBe("RUNPHANTOM_PORT=<port> bun x runphantom-dev setup --global");
    const codex = codingAgentGuides({ port: null, runtime: "binary" })[1].command.replace(/ \\\n\s+/g, " ").replace(/&&\n/g, "&& ");
    expect(codex).toContain("RUNPHANTOM_PORT=<port> runphantom hooks install codex");
    expect(codex).toEndWith("--port <port>");
  });

  test("coding-agent commands match the CLI's accepted flags", () => {
    const [claude, codex, cursor] = codingAgentGuides({ port: 6540, runtime: "source" });
    const flat = (command: string) => command.replace(/ \\\n\s+/g, " ").replace(/&&\n/g, "&& ");
    expect(flat(claude.command)).toBe("RUNPHANTOM_PORT=6540 bun x runphantom-dev hooks install claude --global --cwd /path/to/your/project");
    expect(flat(codex.command)).toBe("mkdir -p -m 700 ~/.runphantom && chmod 700 ~/.runphantom && RUNPHANTOM_PORT=6540 bun x runphantom-dev hooks install codex --local --cwd /path/to/your/project --full --consent-full --port 6540");
    expect(flat(cursor.command)).toBe("RUNPHANTOM_PORT=6540 bun x runphantom-dev hooks install cursor --local --cwd /path/to/your/project");
    expect(flat(codingAgentGuides({ port: 5947, runtime: "binary" })[1].command)).toBe("mkdir -p -m 700 ~/.runphantom && chmod 700 ~/.runphantom && runphantom hooks install codex --local --cwd /path/to/your/project --full --consent-full");
    expect(flat(claude.fullCapture!)).toContain("--local --cwd /path/to/your/project --full --consent-full");
  });

  test.skipIf(!posix)("every multi-line coding-agent command parses as one shell command", async () => {
    for (const guide of codingAgentGuides({ port: 6540, runtime: "binary" })) {
      for (const command of [guide.command, guide.fullCapture].filter((value): value is string => !!value)) {
        expect((await run(["sh", "-n", "-c", command])).status).toBe(0);
      }
    }
  });

  test("long commands break before their flags and stay one shell command", () => {
    expect(wrapCommand("short --flag")).toBe("short --flag");
    const long = `program ${"x".repeat(80)} --one --two`;
    expect(wrapCommand(long)).toBe(`program ${"x".repeat(80)} \\\n  --one --two`);
    expect(wrapCommand("y".repeat(90))).toBe("y".repeat(90));
  });

  test("environment snippets name the real endpoint and an HTTP protocol", () => {
    expect(envSnippet("http://127.0.0.1:6540/v1/traces")).toBe("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:6540/v1/traces");
    const env = openTelemetryEnv("http://127.0.0.1:6540/v1/traces");
    expect(env).toContain("export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:6540/v1/traces");
    expect(env).toContain("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf");
    expect(exampleCommand("http://127.0.0.1:6540/v1/traces")).toContain("--provider openai --model gpt-5-nano");
  });

  test("only known tabs are accepted from the URL", () => {
    expect(isConnectTab("curl")).toBe(true);
    expect(isConnectTab("coding-agents")).toBe(true);
    expect(isConnectTab("rust")).toBe(false);
    expect(isConnectTab(null)).toBe(false);
  });
});

describe("snippets run as written", () => {
  test.skipIf(!posix)("curl", async () => {
    received = [];
    const result = await run(["sh", "-c", curlSnippet(endpoint())]);
    expect(result.status).toBe(0);
    const [span] = lastParsed();
    expect(span.name).toBe("Hello from curl");
  });

  test("TypeScript", async () => {
    received = [];
    const file = path.join(workdir, "runphantom.ts");
    writeFileSync(file, typescriptSnippet("http://127.0.0.1:1/unused"));
    const result = await run([process.execPath, file], { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint() });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const [span] = lastParsed();
    expect(span.name).toBe("chat gpt-5-nano");
    expect(span.attributes["gen_ai.request.model"]).toBe("gpt-5-nano");
  });

  test.skipIf(!posix)("Python", async () => {
    received = [];
    const file = path.join(workdir, "runphantom.py");
    writeFileSync(file, pythonSnippet(endpoint()));
    const result = await run(["python3", file]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const [span] = lastParsed();
    expect(span.name).toBe("chat gpt-5-nano");
  });
});

describe("browser test span", () => {
  test("is a two-step trace with no model call, posted to the OTLP route", async () => {
    received = [];
    const trace = buildTestTrace();
    await sendTestTrace(trace, (input, init) => fetch(new URL(String(input), `http://127.0.0.1:${server.port}`), init));
    const spans = lastParsed();
    expect(spans.map(span => span.name).sort()).toEqual(["Connection test", "ping"]);
    expect(spans.every(span => span.traceId === trace.traceId)).toBe(true);
    expect(spans.find(span => span.name === TEST_RUN_NAME)?.parentSpanId).toBeUndefined();
    expect(spans.some(span => span.model || span.inputTokens || span.outputTokens)).toBe(false);
  });

  test("reports the service's refusal instead of claiming success", async () => {
    const refusing = (async () => Response.json({ error: "forbidden" }, { status: 403 })) as unknown as typeof fetch;
    const failure = await sendTestTrace(buildTestTrace(), refusing).then(() => null, (error: unknown) => error);
    expect((failure as Error).message).toBe("forbidden");
  });
});

describe("local service", () => {
  const fake = (body: unknown) => (async () => Response.json(body)) as unknown as typeof fetch;
  test("reads port and runtime from /health", async () => {
    expect(await readLocalService(fake({ ok: true, service: "runphantom", port: 6540, runtime: "binary" })))
      .toEqual({ port: 6540, endpoint: "http://127.0.0.1:6540/v1/traces", runtime: "binary" });
    expect((await readLocalService(fake({ ok: true, service: "runphantom", port: 5947 }))).runtime).toBe("source");
  });
});
