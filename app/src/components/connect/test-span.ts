export const TEST_RUN_NAME = "Connection test";
export const TEST_SERVICE_NAME = "Run Phantom connection test";

function hex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}

const nanos = (ms: number) => `${Math.round(ms)}000000`;
const text = (key: string, value: string) => ({ key, value: { stringValue: value } });

export interface TestTrace {
  traceId: string;
  body: unknown;
}

/**
 * Two spans, an agent and one tool call, so the run shows a timeline and a step drawer.
 * No model call: a test run must not add tokens or cost to the workspace totals.
 */
export function buildTestTrace(now = Date.now(), ids: { traceId: string; rootId: string; toolId: string } = { traceId: hex(16), rootId: hex(8), toolId: hex(8) }): TestTrace {
  const start = now - 180;
  const toolStart = start + 40;
  const toolEnd = toolStart + 90;
  const sentAt = new Date(now).toISOString();
  const root = {
    traceId: ids.traceId,
    spanId: ids.rootId,
    name: TEST_RUN_NAME,
    kind: 1,
    startTimeUnixNano: nanos(start),
    endTimeUnixNano: nanos(now),
    status: { code: 1 },
    attributes: [
      text("gen_ai.operation.name", "invoke_agent"),
      text("gen_ai.agent.name", "connection-test"),
      text("runphantom.event.name", TEST_RUN_NAME),
      text("input.value", "Check that this browser can reach the local service."),
      text("output.value", `Received at ${sentAt}.`),
    ],
  };
  const tool = {
    traceId: ids.traceId,
    spanId: ids.toolId,
    parentSpanId: ids.rootId,
    name: "execute_tool ping",
    kind: 1,
    startTimeUnixNano: nanos(toolStart),
    endTimeUnixNano: nanos(toolEnd),
    status: { code: 1 },
    attributes: [
      text("gen_ai.operation.name", "execute_tool"),
      text("gen_ai.tool.name", "ping"),
      text("gen_ai.tool.call.arguments", JSON.stringify({ target: "local service" })),
      text("gen_ai.tool.call.result", JSON.stringify({ ok: true })),
    ],
  };
  return {
    traceId: ids.traceId,
    body: {
      resourceSpans: [{
        resource: { attributes: [text("service.name", TEST_SERVICE_NAME)] },
        scopeSpans: [{ scope: { name: "runphantom.connect" }, spans: [root, tool] }],
      }],
    },
  };
}

/** Posts through the same OTLP/HTTP route an agent uses, so success proves the ingest path, not a side door. */
export async function sendTestTrace(trace: TestTrace, fetcher: typeof fetch = fetch): Promise<void> {
  const response = await fetcher("/v1/traces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(trace.body),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new Error(typeof body?.error === "string" ? body.error : `The local service answered ${response.status}.`);
  }
}
