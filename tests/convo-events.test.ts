import { describe, expect, test } from "bun:test";
import { buildConvoEvents } from "../app/src/components/convo-events";

const span = (o: Partial<Record<string, unknown>>) => ({
  id: String(o.id), parent_id: null, name: String(o.name ?? o.id),
  span_type: o.span_type, status: "OK",
  input_payload: o.input_payload ?? null, output_payload: o.output_payload ?? null,
  start_time_ms: o.start_time_ms as number, end_time_ms: (o.start_time_ms as number) + 10,
  duration_ms: 10, tokens: { in: 0, out: 0 },
}) as never;

const run = { id: "r1", name: "agent", started_at: 1000, last_updated_at: 9000, finished: 1 } as never;

describe("conversation stream for a multi-step agent turn", () => {
  // llm -> tool -> llm -> tool -> llm, i.e. the ordinary shape this product exists
  // to debug. The user's message lives on the first call; the answer on the last.
  const spans = [
    span({ id: "llm1", span_type: "LLM", start_time_ms: 1000,
      input_payload: JSON.stringify([{ role: "user", content: "Why is checkout failing?" }]),
      output_payload: "I'll look at the logs." }),
    span({ id: "tool1", span_type: "TOOL_CALL", start_time_ms: 1100 }),
    span({ id: "llm2", span_type: "LLM", start_time_ms: 1200,
      input_payload: JSON.stringify([{ role: "user", content: "continue" }]),
      output_payload: "Checking the payment service next." }),
    span({ id: "tool2", span_type: "TOOL_CALL", start_time_ms: 1300 }),
    span({ id: "llm3", span_type: "LLM", start_time_ms: 1400,
      input_payload: JSON.stringify([{ role: "user", content: "continue" }]),
      output_payload: "Checkout fails because the Stripe webhook secret rotated." }),
  ];

  const events = buildConvoEvents([{ run, spans }]);
  const userMsg = events.find((e) => e.type === "user_msg");
  const llmOut = events.find((e) => e.type === "llm_out");

  test("shows the human's message, not a later continuation stub", () => {
    expect(userMsg && "content" in userMsg ? userMsg.content : null).toBe("Why is checkout failing?");
  });

  test("shows the final answer, not the model's opening tool-call decision", () => {
    expect(llmOut && "content" in llmOut ? llmOut.content : null)
      .toBe("Checkout fails because the Stripe webhook secret rotated.");
  });

  test("a single-step turn is unchanged", () => {
    const one = buildConvoEvents([{ run, spans: [spans[0]] }]);
    const u = one.find((e) => e.type === "user_msg");
    const o = one.find((e) => e.type === "llm_out");
    expect(u && "content" in u ? u.content : null).toBe("Why is checkout failing?");
    expect(o && "content" in o ? o.content : null).toBe("I'll look at the logs.");
  });

  test("falls back to TRACE spans when there is no LLM span", () => {
    const traceOnly = [
      span({ id: "t1", span_type: "TRACE", start_time_ms: 1000, input_payload: "hello", output_payload: "first" }),
      span({ id: "t2", span_type: "TRACE", start_time_ms: 2000, output_payload: "final" }),
    ];
    const ev = buildConvoEvents([{ run, spans: traceOnly }]);
    const o = ev.find((e) => e.type === "llm_out");
    expect(o && "content" in o ? o.content : null).toBe("final");
  });
});
