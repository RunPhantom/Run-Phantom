export type LocalRuntime = "source" | "binary";

export interface LocalService {
  port: number;
  /** OTLP/HTTP traces endpoint on this machine, e.g. http://127.0.0.1:5947/v1/traces */
  endpoint: string;
  /** "binary" for an installed `runphantom`, "source" for a checkout started with Bun. */
  runtime: LocalRuntime;
}

export const DEFAULT_LOCAL_PORT = 5947;
export const ENDPOINT_VARIABLE = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT";
export const EXAMPLE_MODEL = "gpt-5-nano";
export const EXAMPLE_PROMPT = "Where is order A1002?";

export type ConnectTabId = "typescript" | "python" | "opentelemetry" | "curl" | "coding-agents";

export const CONNECT_TABS: readonly { id: ConnectTabId; label: string }[] = [
  { id: "typescript", label: "TypeScript / Node" },
  { id: "python", label: "Python" },
  { id: "opentelemetry", label: "OpenTelemetry" },
  { id: "curl", label: "curl" },
  { id: "coding-agents", label: "Coding agents" },
];

export function isConnectTab(value: string | null): value is ConnectTabId {
  return CONNECT_TABS.some(tab => tab.id === value);
}

export function endpointForPort(port: number): string {
  return `http://127.0.0.1:${port}/v1/traces`;
}

/**
 * The CLI command for this install. A source checkout links `runphantom-dev` into its own
 * node_modules, so `bun x runphantom-dev` only resolves inside the Run Phantom folder.
 * The CLI finds the local service by RUNPHANTOM_PORT; without it, a non-default port is
 * missed and the CLI starts a second service on 5947.
 */
export function cliCommand(service: Pick<LocalService, "port" | "runtime">, args: string): string {
  const program = service.runtime === "binary" ? "runphantom" : "bun x runphantom-dev";
  const port = service.port === DEFAULT_LOCAL_PORT ? "" : `RUNPHANTOM_PORT=${service.port} `;
  return `${port}${program} ${args}`;
}

/** Breaks a long one-line command before its flags so it reads without scrolling; still pastes as one command. */
export function wrapCommand(command: string, width = 76): string {
  if (command.length <= width) return command;
  const flags = command.indexOf(" --");
  if (flags < 0) return command;
  return `${command.slice(0, flags)} \\\n  ${command.slice(flags + 1)}`;
}

export function envSnippet(endpoint: string): string {
  return `${ENDPOINT_VARIABLE}=${endpoint}`;
}

export function exampleCommand(endpoint: string): string {
  return [
    "cd examples/tool-agent",
    `${ENDPOINT_VARIABLE}=${endpoint} \\`,
    `  bun agent.ts --provider openai --model ${EXAMPLE_MODEL} --prompt "${EXAMPLE_PROMPT}"`,
  ].join("\n");
}

export function openTelemetryEnv(endpoint: string): string {
  return [
    `export ${ENDPOINT_VARIABLE}=${endpoint}`,
    "export OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf",
    "export OTEL_SERVICE_NAME=my-agent",
    "export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true",
  ].join("\n");
}

export function typescriptSnippet(endpoint: string): string {
  return `// runphantom.ts — no dependencies. Node 20+ or Bun.
const ENDPOINT = process.env.${ENDPOINT_VARIABLE} ?? "${endpoint}";

const hex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, "0")).join("");
const value = (v: string | number) => (typeof v === "number" ? { intValue: String(v) } : { stringValue: v });

export async function sendSpan(
  name: string,
  attributes: Record<string, string | number>,
  startedAt: number,
  endedAt = Date.now(),
) {
  const span = {
    traceId: hex(16), spanId: hex(8), name, kind: 1, status: { code: 1 },
    startTimeUnixNano: \`\${startedAt}000000\`,
    endTimeUnixNano: \`\${endedAt}000000\`,
    attributes: Object.entries(attributes).map(([key, v]) => ({ key, value: value(v) })),
  };
  const resource = { attributes: [{ key: "service.name", value: value("my-agent") }] };
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resourceSpans: [{ resource, scopeSpans: [{ spans: [span] }] }] }),
  });
  if (!response.ok) throw new Error(\`Run Phantom answered \${response.status}\`);
}

// Wrap one model call:
const startedAt = Date.now();
const question = "Where is order A1002?";
const answer = "It ships tomorrow."; // your model's reply
await sendSpan("chat ${EXAMPLE_MODEL}", {
  "gen_ai.operation.name": "chat",
  "gen_ai.request.model": "${EXAMPLE_MODEL}",
  "gen_ai.input.messages": JSON.stringify([{ role: "user", parts: [{ type: "text", content: question }] }]),
  "gen_ai.output.messages": JSON.stringify([{ role: "assistant", parts: [{ type: "text", content: answer }] }]),
}, startedAt);
`;
}

export function pythonSnippet(endpoint: string): string {
  return `# runphantom.py — standard library only. Python 3.8+.
import json, os, secrets, time, urllib.request

ENDPOINT = os.environ.get("${ENDPOINT_VARIABLE}", "${endpoint}")

def value(v):
    return {"intValue": str(v)} if isinstance(v, int) else {"stringValue": str(v)}

def send_span(name, attributes, started_ns, ended_ns=None):
    span = {
        "traceId": secrets.token_hex(16), "spanId": secrets.token_hex(8),
        "name": name, "kind": 1, "status": {"code": 1},
        "startTimeUnixNano": str(started_ns),
        "endTimeUnixNano": str(ended_ns or time.time_ns()),
        "attributes": [{"key": k, "value": value(v)} for k, v in attributes.items()],
    }
    resource = {"attributes": [{"key": "service.name", "value": value("my-agent")}]}
    body = {"resourceSpans": [{"resource": resource, "scopeSpans": [{"spans": [span]}]}]}
    request = urllib.request.Request(
        ENDPOINT, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}
    )
    urllib.request.urlopen(request, timeout=5).read()

# Wrap one model call:
started = time.time_ns()
question = "Where is order A1002?"
answer = "It ships tomorrow."  # your model's reply
send_span("chat ${EXAMPLE_MODEL}", {
    "gen_ai.operation.name": "chat",
    "gen_ai.request.model": "${EXAMPLE_MODEL}",
    "gen_ai.input.messages": json.dumps([{"role": "user", "parts": [{"type": "text", "content": question}]}]),
    "gen_ai.output.messages": json.dumps([{"role": "assistant", "parts": [{"type": "text", "content": answer}]}]),
}, started)
`;
}

/** POSIX shell; `openssl` and `date +%s` exist on macOS and Linux. */
export function curlSnippet(endpoint: string): string {
  const span = `{"traceId":"'"$(openssl rand -hex 16)"'","spanId":"'"$(openssl rand -hex 8)"'","name":"Hello from curl","kind":1,`
    + `"startTimeUnixNano":"'"$(date +%s)"'000000000","endTimeUnixNano":"'"$(date +%s)"'500000000","status":{"code":1}}`;
  const body = `{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"curl"}}]},"scopeSpans":[{"spans":[${span}]}]}]}`;
  return [
    `curl -sS -X POST ${endpoint} \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '${body}'`,
  ].join("\n");
}

export interface CodingAgentGuide {
  id: "claude-code" | "codex" | "cursor";
  name: string;
  command: string;
  then: string;
  fullCapture?: string;
}

const PROJECT = "/path/to/your/project";

export function codingAgentGuides(service: Pick<LocalService, "port" | "runtime">): CodingAgentGuide[] {
  return [
    {
      id: "claude-code",
      name: "Claude Code",
      command: wrapCommand(cliCommand(service, `hooks install claude --global --cwd ${PROJECT}`)),
      then: "Start a new Claude Code session in that project. Each session appears here as a run.",
      fullCapture: wrapCommand(cliCommand(service, `hooks install claude --local --cwd ${PROJECT} --full --consent-full`)),
    },
    {
      id: "codex",
      name: "Codex",
      command: wrapCommand(`chmod 700 ~/.runphantom && ${cliCommand(service, `hooks install codex --local --cwd ${PROJECT} --full --consent-full${service.port === DEFAULT_LOCAL_PORT ? "" : ` --port ${service.port}`}`)}`),
      then: "Codex capture needs Run Phantom's state folder to be private, hence the chmod. Then open Codex in that project, run /hooks and trust the new hooks. Capture is per project and includes message content.",
    },
    {
      id: "cursor",
      name: "Cursor",
      command: wrapCommand(cliCommand(service, `hooks install cursor --local --cwd ${PROJECT}`)),
      then: "Reopen the project in Cursor. Sessions, prompts and tool calls appear here as runs.",
      fullCapture: wrapCommand(cliCommand(service, `hooks install cursor --local --cwd ${PROJECT} --full --consent-full`)),
    },
  ];
}

export function setupCommand(service: Pick<LocalService, "port" | "runtime">): string {
  return cliCommand(service, "setup --global");
}
