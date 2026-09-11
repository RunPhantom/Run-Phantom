import type { APIRequestContext } from "@playwright/test";
import { expect } from "./fixtures";

export const EVALUATION_INPUT = "Describe the result of this checkout.";
export const EVALUATION_RUNS = {
  baseline: "0000000000000000000000000000e001",
  rejected: "0000000000000000000000000000e002",
  repaired: "0000000000000000000000000000e003",
  missing: "0000000000000000000000000000e004",
  ambiguous: "0000000000000000000000000000e005",
  mismatch: "0000000000000000000000000000e006",
} as const;

type Attribute = { key: string; value: { stringValue: string } | { intValue: string } | { doubleValue: number } };
const text = (key: string, value: string): Attribute => ({ key, value: { stringValue: value } });
const integer = (key: string, value: number): Attribute => ({ key, value: { intValue: String(value) } });
const number = (key: string, value: number): Attribute => ({ key, value: { doubleValue: value } });

function traceFixture(kind: keyof typeof EVALUATION_RUNS) {
  const traceId = EVALUATION_RUNS[kind];
  const suffix = traceId.slice(-8);
  const rootId = `${suffix}00000001`;
  const base = 1_780_000_000_000;
  const input = kind === "mismatch" ? "Describe a different customer refund." : EVALUATION_INPUT;
  const output = kind === "rejected" ? '{"status":"declined"}' : '{"status":"paid"}';
  const start = (offset: number) => String(BigInt(base + offset) * 1_000_000n);
  const meta = [text("ai.telemetry.metadata.runphantom.eventName", `Evaluation ${kind}`)];
  const span = (slot: number, name: string, attributes: Attribute[], begin: number, end: number, parentSpanId?: string) => ({
    traceId, spanId: `${suffix}${slot.toString(16).padStart(8, "0")}`, parentSpanId,
    name, kind: 1, startTimeUnixNano: start(begin), endTimeUnixNano: start(end),
    status: { code: 1 }, attributes: [...meta, ...attributes],
  });
  const usage = kind === "missing" ? [] : [
    integer("gen_ai.usage.input_tokens", kind === "repaired" ? 60 : 80),
    integer("gen_ai.usage.output_tokens", kind === "repaired" ? 15 : 20),
    number("gen_ai.usage.cost", kind === "repaired" ? 0.0007 : 0.001),
  ];
  const generation = (slot: number, response: string, begin: number, end: number) => span(slot, "model.generate", [
    text("ai.operationId", "ai.generateText"),
    text("ai.prompt", JSON.stringify({ messages: [{ role: "user", content: input }] })),
    text("ai.response.text", response),
    text("gen_ai.request.model", "requested-model"),
    text("gen_ai.response.model", "captured-response-model"),
    text("gen_ai.provider.name", "openai"),
    ...usage,
  ], begin, end, rootId);
  const spans = [
    span(1, `Evaluation ${kind}`, [
      text("runphantom.span.kind", "agent_root"), text("runphantom.input", input),
      ...(kind === "ambiguous" ? [] : [text("runphantom.output", output)]),
    ], 0, 1000),
    span(2, "validate_cart", [text("ai.operationId", "ai.toolCall"), text("ai.toolCall.name", "validate_cart")], 10, 30, rootId),
    span(3, "submit_order", [text("ai.operationId", "ai.toolCall"), text("ai.toolCall.name", "submit_order")], 40, 80, rootId),
    generation(4, kind === "ambiguous" ? "First parallel response" : output, 100, 800),
    ...(kind === "ambiguous" ? [generation(5, "Second parallel response", 120, 850)] : []),
  ];
  return { resourceSpans: [{ scopeSpans: [{ spans }] }] };
}

export async function seedEvaluationRuns(request: APIRequestContext, daemon: string): Promise<void> {
  for (const kind of Object.keys(EVALUATION_RUNS) as Array<keyof typeof EVALUATION_RUNS>) {
    const response = await request.post(`${daemon}/v1/traces`, { data: traceFixture(kind) });
    expect(response.ok(), `Ingest synthetic ${kind} trace`).toBe(true);
  }
}
