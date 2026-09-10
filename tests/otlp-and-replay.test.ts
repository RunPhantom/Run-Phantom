import { describe, expect, test } from "bun:test";
import { getReplayTrace, setReplayTrace } from "../src/replay-map";
import { parseOtlpRequest } from "../src/parse";

describe("OTLP parsing", () => {
  test("prefers Run Phantom root-span payloads over fallback conventions", () => {
    const [span] = parseOtlpRequest({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            traceId: "00112233445566778899aabbccddeeff",
            spanId: "0011223344556677",
            name: "runphantom.agent",
            startTimeUnixNano: "1000000",
            endTimeUnixNano: "2000000",
            attributes: [
              { key: "runphantom.span.kind", value: { stringValue: "agent_root" } },
              { key: "runphantom.input", value: { stringValue: '{"prompt":"preferred"}' } },
              { key: "runphantom.output", value: { stringValue: '{"answer":"preferred"}' } },
              { key: "traceloop.entity.input", value: { stringValue: '{"prompt":"fallback"}' } },
              { key: "traceloop.entity.output", value: { stringValue: '{"answer":"fallback"}' } },
            ],
          }],
        }],
      }],
    });

    expect(span).toMatchObject({
      spanType: "AGENT_ROOT",
      inputPayload: '{"prompt":"preferred"}',
      outputPayload: '{"answer":"preferred"}',
    });
  });

  test("normalizes ids, infers tool spans, and extracts replay stitching keys", () => {
    const traceBytes = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const spanBytes = Buffer.from("1122334455667788", "hex");

    const spans = parseOtlpRequest({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: traceBytes.toString("base64"),
                  spanId: spanBytes.toString("base64"),
                  parentSpanId: "0011223344556677",
                  name: "ai.toolCall",
                  startTimeUnixNano: "1000000000",
                  endTimeUnixNano: "2400000000",
                  status: { code: 0 },
                  attributes: [
                    { key: "ai.operationId", value: { stringValue: "ai.toolCall" } },
                    { key: "ai.toolCall.name", value: { stringValue: "search_web" } },
                    { key: "tool.input", value: { stringValue: "{\"query\":\"run phantom\"}" } },
                    { key: "tool.output", value: { stringValue: "{\"ok\":true}" } },
                    { key: "ai.model.id", value: { stringValue: "gpt-5.4" } },
                    { key: "ai.model.provider", value: { stringValue: "openai" } },
                    { key: "traceloop.association.properties.replayRunId", value: { stringValue: "replay-42" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      traceId: "00112233445566778899aabbccddeeff",
      spanId: "1122334455667788",
      parentSpanId: "0011223344556677",
      name: "search_web",
      spanType: "TOOL_CALL",
      status: "OK",
      inputPayload: "{\"query\":\"run phantom\"}",
      outputPayload: "{\"ok\":true}",
      model: "gpt-5.4",
      provider: "openai",
      replayRunId: "replay-42",
    });
    expect(spans[0].durationMs).toBe(1400);
    expect(spans[0].normalized).toBeDefined();
  });

  test("keeps opaque ids unchanged when they are not hex or base64", () => {
    const spans = parseOtlpRequest({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "trace-opaque",
                  spanId: "span-opaque",
                  name: "internal-op",
                  startTimeUnixNano: "0",
                  endTimeUnixNano: "0",
                  status: { code: 2, message: "boom" },
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(spans[0]?.traceId).toBe("trace-opaque");
    expect(spans[0]?.spanId).toBe("span-opaque");
    expect(spans[0]?.status).toBe("ERROR");
    expect(spans[0]?.attributes["otel.status.message"]).toBe("boom");
  });
});

describe("replay trace mapping", () => {
  test("stores and returns the latest trace id for a replay run", () => {
    const replayRunId = `replay-${Date.now()}`;
    setReplayTrace(replayRunId, "trace-old");
    setReplayTrace(replayRunId, "trace-new");
    expect(getReplayTrace(replayRunId)).toBe("trace-new");
  });
});
